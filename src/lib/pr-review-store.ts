/**
 * Durable PR-review storage.
 *
 * Waiter writes observations (copied into inbox/). Controller writes
 * obligations, launch journal, writer reservations, and consumption receipts.
 * Atomic rename for records; exclusive-create (wx) for locks and receipts.
 *
 * Cross-language note: the waiter still flock()s its own `manual-*.json`.
 * This store never rewrites those files. Receipts live here so a re-await
 * cannot erase consumption.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	PR_REVIEW_PROTOCOL_VERSION,
	prKeyFileToken,
	prKeyId,
	type PrKey,
} from "./pr-review-identity.ts";

export type ReviewOwnerKind = "feature" | "session" | "observer";

export type ReviewOwner = {
	kind: ReviewOwnerKind;
	id: string;
	generation: string;
};

export type ReviewState =
	| "waiting_review"
	| "verdict_pending"
	| "launching"
	| "fixing"
	| "validating"
	| "publishing"
	| "retry_scheduled"
	| "recovery_required"
	| "paused"
	| "merged"
	| "closed_unmerged"
	| "cancelled";

export type VerdictRecord = {
	identity: string;
	next: string;
	head: string;
	body: string;
	round?: string;
	observedAt: number;
	kind: "fix" | "env" | "dead_reviewers" | "terminal" | "other";
};

export type WriterReservation = {
	holder: string;
	pid?: number;
	reservedAt: number;
	runId?: string;
};

export type LaunchJournal = {
	idempotencyKey: string;
	intentAt: number;
	runId?: string;
	acceptedAt?: number;
};

export type Obligation = {
	v: typeof PR_REVIEW_PROTOCOL_VERSION;
	pr: PrKey;
	generation: string;
	owner: ReviewOwner;
	worktree: string;
	head: string;
	state: ReviewState;
	pendingVerdicts: VerdictRecord[];
	activeVerdictIds: string[];
	writer?: WriterReservation;
	launch?: LaunchJournal;
	lastProgress?: { at: number; note: string };
	retry?: { deadline: number; count: number; reason: string };
	failureReason?: string;
	linkedTodo?: string;
	terminalNotified?: boolean;
};

export type ConsumptionReceipt = {
	v: typeof PR_REVIEW_PROTOCOL_VERSION;
	identity: string;
	pr: string;
	ownerGeneration: string;
	consumedAt: number;
	reason: string;
};

export type ReviewStore = {
	dir: string;
	read(pr: PrKey): Obligation | undefined;
	write(ob: Obligation): void;
	list(): Obligation[];
	putInbox(verdict: VerdictRecord, pr: PrKey): void;
	readInbox(identity: string): VerdictRecord | undefined;
	putReceipt(receipt: ConsumptionReceipt): boolean;
	hasReceipt(identity: string): boolean;
	reserveWriter(pr: PrKey, reservation: WriterReservation): boolean;
	releaseWriter(pr: PrKey, holder: string): void;
	writerFor(pr: PrKey): WriterReservation | undefined;
	writerForWorktree(worktree: string): { pr: PrKey; reservation: WriterReservation } | undefined;
};

export function reviewStoreDir(stateDir: string): string {
	return join(stateDir, "review");
}

export function createReviewStore(stateDir: string): ReviewStore {
	const dir = reviewStoreDir(stateDir);
	mkdirSync(join(dir, "inbox"), { recursive: true });
	mkdirSync(join(dir, "receipts"), { recursive: true });
	mkdirSync(join(dir, "locks"), { recursive: true });

	function obligationPath(pr: PrKey): string {
		return join(dir, `${prKeyFileToken(pr)}.json`);
	}

	function lockPath(pr: PrKey): string {
		return join(dir, "locks", `${prKeyFileToken(pr)}.writer`);
	}

	function parseObligation(raw: string): Obligation | undefined {
		try {
			const v = JSON.parse(raw) as Obligation;
			if (!v || v.v !== PR_REVIEW_PROTOCOL_VERSION) return undefined;
			if (!v.pr || !v.owner || !v.state) return undefined;
			if (!Array.isArray(v.pendingVerdicts)) v.pendingVerdicts = [];
			if (!Array.isArray(v.activeVerdictIds)) v.activeVerdictIds = [];
			return v;
		} catch {
			return undefined;
		}
	}

	function readReservation(pr: PrKey): WriterReservation | undefined {
		try {
			const v = JSON.parse(readFileSync(lockPath(pr), "utf8")) as WriterReservation;
			if (!v || typeof v.holder !== "string") return undefined;
			return v;
		} catch {
			return undefined;
		}
	}

	function pidLive(pid: number | undefined): boolean {
		if (pid == null || !Number.isFinite(pid) || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	const store: ReviewStore = {
		dir,
		read(pr) {
			try {
				return parseObligation(readFileSync(obligationPath(pr), "utf8"));
			} catch {
				return undefined;
			}
		},
		write(ob) {
			atomicWriteJson(obligationPath(ob.pr), ob);
		},
		list() {
			const out: Obligation[] = [];
			let names: string[] = [];
			try {
				names = readdirSync(dir);
			} catch {
				return out;
			}
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				try {
					const parsed = parseObligation(readFileSync(join(dir, name), "utf8"));
					if (parsed) out.push(parsed);
				} catch {
					/* skip */
				}
			}
			return out;
		},
		putInbox(verdict, pr) {
			atomicWriteJson(join(dir, "inbox", `${verdict.identity}.json`), { ...verdict, pr: prKeyId(pr) });
		},
		readInbox(identity) {
			try {
				const v = JSON.parse(readFileSync(join(dir, "inbox", `${identity}.json`), "utf8")) as VerdictRecord;
				if (!v || typeof v.identity !== "string") return undefined;
				return v;
			} catch {
				return undefined;
			}
		},
		putReceipt(receipt) {
			const path = join(dir, "receipts", `${receipt.identity}.json`);
			if (existsSync(path)) return false;
			try {
				writeFileSync(path, `${JSON.stringify(receipt)}\n`, { flag: "wx" });
				return true;
			} catch {
				return false;
			}
		},
		hasReceipt(identity) {
			return existsSync(join(dir, "receipts", `${identity}.json`));
		},
		reserveWriter(pr, reservation) {
			const path = lockPath(pr);
			const existing = readReservation(pr);
			if (existing) {
				if (existing.holder === reservation.holder) {
					atomicWriteJson(path, reservation);
					return true;
				}
				if (existing.pid != null && !pidLive(existing.pid)) {
					try {
						rmSync(path, { force: true });
					} catch {
						return false;
					}
				} else {
					return false;
				}
			}
			try {
				writeFileSync(path, `${JSON.stringify(reservation)}\n`, { flag: "wx" });
				return true;
			} catch {
				const raced = readReservation(pr);
				return raced?.holder === reservation.holder;
			}
		},
		releaseWriter(pr, holder) {
			const existing = readReservation(pr);
			if (!existing) return;
			if (existing.holder !== holder) return;
			try {
				rmSync(lockPath(pr), { force: true });
			} catch {
				/* best-effort */
			}
		},
		writerFor(pr) {
			return readReservation(pr);
		},
		writerForWorktree(worktree) {
			const target = worktree.replace(/\/+$/, "");
			if (!target) return undefined;
			for (const ob of store.list()) {
				if (ob.worktree.replace(/\/+$/, "") !== target) continue;
				const reservation = readReservation(ob.pr) ?? ob.writer;
				if (reservation) return { pr: ob.pr, reservation };
			}
			return undefined;
		},
	};
	return store;
}

export function atomicWriteJson(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 0)}\n`);
	renameSync(tmp, path);
}

export function emptyObligation(input: {
	pr: PrKey;
	owner: ReviewOwner;
	worktree: string;
	head?: string;
	linkedTodo?: string;
}): Obligation {
	return {
		v: PR_REVIEW_PROTOCOL_VERSION,
		pr: input.pr,
		generation: input.owner.generation,
		owner: input.owner,
		worktree: input.worktree,
		head: input.head ?? "",
		state: "waiting_review",
		pendingVerdicts: [],
		activeVerdictIds: [],
		linkedTodo: input.linkedTodo,
	};
}
