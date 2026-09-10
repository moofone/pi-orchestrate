import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	canonicalJson, digest, emptyCoordinatorState, validateCoordinatorState, validateStateChange, workspaceExcludedByDelivery,
	type CoordinatorIntent, type CoordinatorOwner, type CoordinatorState, type RepoIdentity,
} from "./execution-contract.ts";

import type { WorkspaceJournal } from "./task-workspaces.ts";

export function canonicalRepoIdentity(cwd: string, git: (cwd: string) => string = path => execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: path, encoding: "utf8" }).trim()): RepoIdentity {
	const commonDir = realpathSync(resolve(cwd, git(cwd)));
	return { commonDir, id: digest(commonDir) };
}
/** Session files need to exist: do not invent an alias for runtime ownership. */
export function createCoordinatorOwner(sessionFile: string, processStart: string, pid = process.pid): Omit<CoordinatorOwner, "epoch"> {
	if (!processStart) throw new Error("Process start identity required");
	return { pid, processStart, sessionFile: realpathSync(sessionFile), instanceId: randomUUID() };
}
export type OwnerLiveness = "alive" | "dead" | "unknown";
export function probeOwnerProcess(owner: Pick<CoordinatorOwner, "pid" | "processStart">): OwnerLiveness {
	try { process.kill(owner.pid, 0); return "alive"; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}
export class ExecutionStoreError extends Error {
	readonly kind: "contention" | "recovery-needed" | "stale-owner" | "lease-held";
	readonly path: string;
	readonly owner?: unknown;
	constructor(kind: ExecutionStoreError["kind"], path: string, message: string, owner?: unknown) {
		super(message); this.name = "ExecutionStoreError"; this.kind = kind; this.path = path; this.owner = owner;
	}
}
export type ExecutionStoreOptions = {
	stateRoot: string; repo: RepoIdentity;
	probeOwner?: (owner: CoordinatorOwner) => OwnerLiveness;
	/** Diagnostic identity only; labels never prove that a live PID died. */
	processStart?: string;
	/** Failure injection; called after durable temp write, before atomic replacement. */
	beforeReplace?: (temporaryPath: string, destinationPath: string) => void;
};
export type ExecutionStore = {
	dir: string; statePath: string; lockPath: string;
	read(): CoordinatorState;
	acquire(owner: Omit<CoordinatorOwner, "epoch">): CoordinatorOwner;
	relinquish(owner: CoordinatorOwner): void;
	/** Synchronous, short data-only transaction; never perform Git/RPC work here. */
	transact(owner: CoordinatorOwner, update: (draft: CoordinatorState) => void): CoordinatorState;
	/** Admission must remain stopped until the new epoch has reconciled recorded work. */
	markReconciled(owner: CoordinatorOwner): CoordinatorState;
	appendIntent(intent: CoordinatorIntent): CoordinatorState;
	readWorkspaceJournal(workspaceId: string): WorkspaceJournal | undefined;
	/** Data-only CAS under the lease transaction lock; owner and writer rechecked at commit. */
	writeWorkspaceJournal(owner: CoordinatorOwner, journal: WorkspaceJournal, expected: WorkspaceJournal | undefined, writer: { attemptId: string } | { integrationId: string }): void;
};
function sameOwner(a: CoordinatorOwner | undefined, b: CoordinatorOwner): boolean {
	return !!a && canonicalJson(a) === canonicalJson(b);
}
function syncDirectory(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
/**
 * Single atomic state document: fsync(temp), rename, fsync(directory). Leftover
 * temp files are never promoted. The short wx lock is never stolen, including
 * on PID death: incomplete/abandoned locks require operator inspection. This
 * avoids racing stale-lock removers and preserves unknown writer reservations.
 * Acquisition is one bounded attempt; the caller can recheck on an event/timer.
 */
export function createExecutionStore(options: ExecutionStoreOptions): ExecutionStore {
	if (realpathSync(options.repo.commonDir) !== options.repo.commonDir || digest(options.repo.commonDir) !== options.repo.id) throw new Error("Canonical Git common-directory identity required");
	const dir = join(options.stateRoot, "execution", options.repo.id);
	mkdirSync(dir, { recursive: true });
	const statePath = join(dir, "coordinator.json"), lockPath = join(dir, "transaction.lock");
	const probe = options.probeOwner ?? probeOwnerProcess;
	function read(): CoordinatorState {
		if (!existsSync(statePath)) return emptyCoordinatorState(options.repo);
		try {
			const state: unknown = JSON.parse(readFileSync(statePath, "utf8")); validateCoordinatorState(state);
			if (digest(state.repo) !== digest(options.repo)) throw new Error("Repository identity mismatch");
			return state;
		} catch (error) { throw new ExecutionStoreError("recovery-needed", statePath, `Refusing unreadable/incompatible execution state: ${String(error)}`); }
	}
	function write(state: CoordinatorState): void {
		validateCoordinatorState(state);
		const temporaryPath = join(dir, `.coordinator-${randomUUID()}.tmp`);
		const fd = openSync(temporaryPath, "wx", 0o600);
		try { writeFileSync(fd, canonicalJson(state) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
		options.beforeReplace?.(temporaryPath, statePath);
		renameSync(temporaryPath, statePath); syncDirectory(dirname(statePath));
	}
	function locked<T>(owner: unknown, action: () => T): T {
		let fd: number;
		try { fd = openSync(lockPath, "wx", 0o600); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let recorded: unknown;
			try { recorded = JSON.parse(readFileSync(lockPath, "utf8")); } catch { throw new ExecutionStoreError("recovery-needed", lockPath, "Incomplete transaction lock; inspect manually, no state changed"); }
			const lockOwner = (recorded as { owner?: CoordinatorOwner })?.owner;
			const live = lockOwner && Number.isSafeInteger(lockOwner.pid) ? probe(lockOwner) : "unknown";
			throw new ExecutionStoreError(live === "alive" ? "contention" : "recovery-needed", lockPath, "Transaction lock held or abandoned; no automatic lock removal", recorded);
		}
		let metadataWritten = false;
		try {
			writeFileSync(fd, canonicalJson({ owner, token: randomUUID() })); fsyncSync(fd); metadataWritten = true;
			return action();
		} finally {
			closeSync(fd);
			// Only this exclusive creator removes this lock. A failed metadata write
			// remains fenced for inspection rather than assuming nothing happened.
			if (metadataWritten) { unlinkSync(lockPath); syncDirectory(dir); }
		}
	}
	function assertOwner(state: CoordinatorState, owner: CoordinatorOwner): void {
		if (!sameOwner(state.owner, owner) || state.epoch !== owner.epoch) throw new ExecutionStoreError("stale-owner", statePath, "Coordinator instance/epoch is no longer owner", state.owner);
	}
	function acquire(owner: Omit<CoordinatorOwner, "epoch">): CoordinatorOwner {
		return locked(owner, () => {
			const state = read();
			if (state.owner && state.owner.instanceId === owner.instanceId) {
				const existing = { ...owner, epoch: state.owner.epoch }; assertOwner(state, existing); return existing;
			}
			if (state.owner && probe(state.owner) !== "dead") throw new ExecutionStoreError("lease-held", statePath, "Live/unknown coordinator lease cannot be reclaimed", state.owner);
			state.epoch++; state.sequence++; state.owner = { ...owner, epoch: state.epoch }; delete state.reconciledEpoch;
			write(state); return state.owner;
		});
	}
	function transact(owner: CoordinatorOwner, update: (draft: CoordinatorState) => void): CoordinatorState {
		return locked(owner, () => {
			const previous = read(); assertOwner(previous, owner); const next = structuredClone(previous);
			const returned: unknown = update(next);
			if (returned && typeof (returned as Promise<unknown>).then === "function") throw new Error("Async execution transaction forbidden");
			if (!sameOwner(next.owner, owner) || next.epoch !== previous.epoch || next.sequence !== previous.sequence) throw new Error("Transaction cannot change lease/sequence");
			validateStateChange(previous, next);
			if (previous.reconciledEpoch !== owner.epoch && (next.reservations.some(r => !previous.reservations.some(old => old.id === r.id)) || next.attempts.some(a => !previous.attempts.some(old => old.id === a.id) || (["preparing", "launching"].includes(a.phase) && previous.attempts.find(old => old.id === a.id)?.phase !== a.phase)) || next.integrations.some(i => !previous.integrations.some(old => old.id === i.id)))) throw new Error("Reconcile epoch before admission");
			next.sequence++; write(next); return next;
		});
	}
	function relinquish(owner: CoordinatorOwner): void {
		locked(owner, () => {
			const state = read(); assertOwner(state, owner); state.epoch++; state.sequence++; state.lastOwner = structuredClone(owner); delete state.owner; delete state.reconciledEpoch; write(state);
		});
	}
	function appendIntent(intent: CoordinatorIntent): CoordinatorState {
		// Intents are data only, not authority. The owner validates authorization
		// and revision before consumption; another session cannot mutate the pool.
		return locked({ pid: process.pid, processStart: "intent-writer", sessionFile: intent.sessionFile, instanceId: intent.id }, () => {
			const state = read(); const existing = state.intents.find(i => i.id === intent.id);
			if (existing) { if (digest(existing) !== digest(intent)) throw new Error("Intent identity reused"); return state; }
			if (!intent.id || !intent.authorizationId || realpathSync(intent.sessionFile) !== intent.sessionFile || intent.consumedAt !== undefined) throw new Error("Invalid intent");
			state.intents.push(intent); state.sequence++; write(state); return state;
		});
	}
	function journalPath(id: string): string {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error("Unsafe journal identity");
		return join(dir, "journals", `${id}.json`);
	}
	function readWorkspaceJournal(id: string): WorkspaceJournal | undefined {
		const path = journalPath(id);
		return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as WorkspaceJournal : undefined;
	}
	function writeWorkspaceJournal(owner: CoordinatorOwner, journal: WorkspaceJournal, expected: WorkspaceJournal | undefined, writer: { attemptId: string } | { integrationId: string }): void {
		locked(owner, () => {
			const state = read(); assertOwner(state, owner);
			const workspace = journal.workspace;
			const reserved = state.reservations.some(r => r.workspaceId === workspace.id && r.workspacePath === workspace.path && ("attemptId" in writer ? r.attemptId === writer.attemptId : r.integrationId === writer.integrationId));
			const recorded = "attemptId" in writer ? state.attempts.find(a => a.id === writer.attemptId)?.workspace : state.integrations.find(i => i.id === writer.integrationId)?.workspace;
			if (!reserved || !recorded || digest(recorded) !== digest(workspace) || workspaceExcludedByDelivery(state, workspace)) throw new Error("Missing exclusive workspace reservation");
			const current = readWorkspaceJournal(workspace.id);
			if (current === undefined ? expected !== undefined : expected === undefined || digest(current) !== digest(expected)) throw new Error("Workspace journal compare-and-swap failed");
			const path = journalPath(workspace.id), directory = dirname(path);
			mkdirSync(directory, { recursive: true }); syncDirectory(dir);
			const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, "wx", 0o600);
			try { writeFileSync(fd, canonicalJson(journal) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
			options.beforeReplace?.(temporary, path);
			renameSync(temporary, path); syncDirectory(directory);
		});
	}

	return { dir, statePath, lockPath, read, acquire, relinquish, transact, appendIntent, readWorkspaceJournal, writeWorkspaceJournal,
		markReconciled: owner => transact(owner, draft => { draft.reconciledEpoch = owner.epoch; }),
	};
}
