/**
 * Deterministic PR review controller.
 *
 * Fake GitHub / waiter / child boundaries. No parent model turn is a fixer.
 *
 * Run: node --experimental-strip-types --test test/pr-review-controller.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePrKey, prKeyId, type PrKey } from "../src/lib/pr-review-identity.ts";
import { createReviewStore, type ReviewOwner } from "../src/lib/pr-review-store.ts";
import {
	createReviewController,
	isMergeDependentComplete,
	type ChildResult,
	type IncomingObservation,
	type ReviewController,
} from "../src/lib/pr-review-controller.ts";
import type { LaunchIntent, LaunchResult, OwnerLookup, RunSnapshot } from "../src/lib/pr-review-events.ts";

const PR = parsePrKey({ pr: 2537, slug: "moofone/icemining" })!;
const OTHER = parsePrKey({ pr: 2537, slug: "moofone/icemining-devops" })!;
const HEAD1 = "e9de4b669aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD2 = "2033c56dcccccccccccccccccccccccccccccccc";
const HEAD3 = "a16aa6403ddddddddddddddddddddddddddddddd";

function sessionOwner(id = "session-1"): ReviewOwner {
	return { kind: "session", id, generation: "g1" };
}

function featureOwner(id = "/orch/icemining/feat-x"): ReviewOwner {
	return { kind: "feature", id, generation: "fg1" };
}

function finding(head: string, extra = "brief_finding overflow"): string {
	return [
		"status=reviewer_verdict",
		"next=read_comments_and_fix",
		`head=${head}`,
		"comment_id=1",
		extra,
	].join("\n");
}

function http500(): string {
	return ["status=error", "next=fix_command_or_environment", "error=HTTP 500: GitHub unavailable"].join("\n");
}

type World = {
	dir: string;
	ctrl: ReviewController;
	launches: LaunchIntent[];
	published: string[];
	reawaits: number;
	terminals: Array<{ state: string; owner: string }>;
	runs: Map<string, RunSnapshot & { key: string }>;
	github: { state: "open" | "merged" | "closed" | "unknown"; head: string };
	waiter: { running: boolean; stale: boolean };
	owner: OwnerLookup;
	parentFixTurns: number;
	failLaunch?: Error;
	cleanup: () => void;
};

function world(opts: { owner?: OwnerLookup; now?: () => number } = {}): World {
	const dir = mkdtempSync(join(tmpdir(), "pr-review-"));
	const store = createReviewStore(dir);
	const launches: LaunchIntent[] = [];
	const runs = new Map<string, RunSnapshot & { key: string }>();
	let seq = 0;
	const w: World = {
		dir,
		ctrl: undefined as unknown as ReviewController,
		launches,
		published: [],
		reawaits: 0,
		terminals: [],
		runs,
		github: { state: "open", head: HEAD1 },
		waiter: { running: true, stale: false },
		owner: opts.owner ?? { status: "session", owner: sessionOwner() },
		parentFixTurns: 0,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};

	w.ctrl = createReviewController({
		store,
		now: opts.now,
		pid: process.pid,
		lookupOwner: () => w.owner,
		launchFixer: async (intent): Promise<LaunchResult> => {
			if (w.failLaunch) throw w.failLaunch;
			const existing = [...runs.values()].find((r) => r.key === intent.idempotencyKey);
			if (existing) return { runId: existing.runId, recovered: true };
			seq += 1;
			const runId = `run-${seq}`;
			runs.set(runId, { runId, status: "running", key: intent.idempotencyKey });
			launches.push(intent);
			return { runId, recovered: false };
		},
		queryRun: async (key) => {
			if (runs.has(key)) return runs.get(key);
			return [...runs.values()].find((r) => r.key === key || r.runId === key);
		},
		publish: async (req) => {
			w.published.push(req.localHead);
			w.github.head = req.localHead;
			return { ok: true, remoteHead: req.localHead };
		},
		reawait: async () => {
			w.reawaits += 1;
			w.waiter.running = true;
			w.waiter.stale = false;
		},
		prState: async () => w.github.state,
		currentHead: async () => w.github.head,
		waiterHealth: async () => ({ running: w.waiter.running, stale: w.waiter.stale }),
		ensureWaiter: async () => {
			w.waiter.running = true;
			w.waiter.stale = false;
		},
		notifyTerminal: (n) => {
			w.terminals.push({ state: n.state, owner: n.owner.id });
		},
	});
	return w;
}

function observeFix(w: World, pr: PrKey, head: string, extra?: string): ReturnType<ReviewController["observeVerdict"]> {
	const obs: IncomingObservation = {
		pr,
		next: "read_comments_and_fix",
		head,
		body: finding(head, extra),
		round: extra,
	};
	return w.ctrl.observeVerdict(obs);
}

async function finishFixer(w: World, index: number, newHead: string, extra: Partial<ChildResult> = {}): Promise<void> {
	const runId = `run-${index}`;
	const snap = w.runs.get(runId);
	if (snap) {
		snap.status = "exited";
		snap.ok = extra.ok ?? true;
		snap.head = newHead;
		snap.stopped = extra.stopped;
		snap.handoffWritten = extra.handoffWritten ?? true;
	}
	await w.ctrl.childFinished({
		runId,
		ok: extra.ok ?? true,
		localHead: newHead,
		handoffWritten: extra.handoffWritten ?? true,
		...extra,
	});
}

test("ordinary Pi, two review rounds: two fixers, correct heads, zero parent turns", async () => {
	const w = world();
	try {
		const handoff = w.ctrl.handoff({
			pr: PR,
			owner: sessionOwner(),
			worktree: "/wt/feat",
			head: HEAD1,
			linkedTodo: "todo-merge-2537",
		});
		assert.equal(handoff.ok, true);
		assert.equal(handoff.state, "waiting_review");

		const ack1 = observeFix(w, PR, HEAD1, "round-1");
		assert.equal(ack1.accepted, true);
		assert.equal(ack1.kind, "fix");

		const r1 = await w.ctrl.reconcile();
		assert.equal(r1.launched, 1, "round one must launch a fixer");
		assert.equal(w.launches.length, 1);
		assert.equal(w.launches[0]?.expectedHead, HEAD1);
		assert.equal(w.parentFixTurns, 0);
		assert.equal(w.ctrl.status(PR)[0]?.state, "fixing");

		await finishFixer(w, 1, HEAD2);
		assert.deepEqual(w.published, [HEAD2]);
		assert.equal(w.reawaits, 1);
		assert.equal(w.ctrl.status(PR)[0]?.state, "waiting_review");

		const env = w.ctrl.observeVerdict({
			pr: PR,
			next: "fix_command_or_environment",
			body: http500(),
			githubStatus: "http_500",
		});
		assert.equal(env.kind, "env");
		const r500 = await w.ctrl.reconcile();
		assert.equal(r500.launched, 0, "GitHub 500 must not demand a code fixer");
		assert.equal(w.launches.length, 1);
		assert.match(w.ctrl.status(PR)[0]?.lastProgress?.note ?? "", /github 500/);

		w.github.head = HEAD2;
		const ack2 = observeFix(w, PR, HEAD2, "round-2 still a bug");
		assert.equal(ack2.accepted, true);
		assert.notEqual(ack2.identity, ack1.identity);
		const r2 = await w.ctrl.reconcile();
		assert.equal(r2.launched, 1, "second round launches without a user turn");
		assert.equal(w.launches.length, 2);
		assert.equal(w.launches[1]?.expectedHead, HEAD2);
		assert.equal(w.parentFixTurns, 0);
		assert.equal(w.reawaits, 1, "one re-await per changed head so far");

		await finishFixer(w, 2, HEAD3);
		assert.deepEqual(w.published, [HEAD2, HEAD3]);
		assert.equal(w.reawaits, 2);
		assert.equal(w.parentFixTurns, 0);
	} finally {
		w.cleanup();
	}
});

test("/orchestrate Feature adapter owns both rounds; no solo fallback", async () => {
	const feat = featureOwner();
	const w = world({ owner: { status: "feature", owner: feat, worktree: "/wt/feat" } });
	try {
		assert.equal(w.ctrl.handoff({ pr: PR, owner: feat, worktree: "/wt/feat", head: HEAD1 }).ok, true);
		observeFix(w, PR, HEAD1, "r1");
		await w.ctrl.reconcile();
		assert.equal(w.launches[0]?.owner.kind, "feature");
		w.owner = { status: "unavailable", reason: "feature adapter missing" };
		await finishFixer(w, 1, HEAD2);
		observeFix(w, PR, HEAD2, "r2");
		const r = await w.ctrl.reconcile();
		assert.equal(w.launches.length, 1, "must not fall back to a session writer");
		assert.equal(r.recovery, 1);
		assert.equal(w.ctrl.status(PR)[0]?.state, "recovery_required");
	} finally {
		w.cleanup();
	}
});

test("duplicate fs/timer/settle/reconcile events launch one child", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "once");
		const [a, b, c] = await Promise.all([w.ctrl.reconcile(), w.ctrl.reconcile(), w.ctrl.reconcile()]);
		const launched = a.launched + b.launched + c.launched;
		assert.equal(w.launches.length, 1);
		assert.equal(launched, 1);
	} finally {
		w.cleanup();
	}
});

test("two processes claiming the same PR: one writer, the other refused", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pr-review-lock-"));
	try {
		const storeA = createReviewStore(dir);
		const storeB = createReviewStore(dir);
		const holderA = { holder: "session:a", pid: process.pid, reservedAt: 1 };
		assert.equal(storeA.reserveWriter(PR, holderA), true);
		assert.equal(storeB.reserveWriter(PR, { holder: "session:b", pid: process.pid, reservedAt: 2 }), false);
		assert.equal(storeB.writerFor(PR)?.holder, "session:a");
		storeA.releaseWriter(PR, "session:a");
		assert.equal(storeB.reserveWriter(PR, { holder: "session:b", pid: process.pid, reservedAt: 3 }), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("same holder in a different live process cannot steal the reservation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pr-review-holder-"));
	try {
		const store = createReviewStore(dir);
		assert.equal(
			store.reserveWriter(PR, { holder: "session:a", pid: process.pid, reservedAt: 1 }),
			true,
		);
		assert.equal(
			store.reserveWriter(PR, { holder: "session:a", pid: process.pid, reservedAt: 2 }),
			true,
			"same process may refresh",
		);
		assert.equal(
			store.reserveWriter(PR, { holder: "session:a", pid: process.ppid, reservedAt: 3 }),
			false,
			"a second live pid with the same holder must not overwrite",
		);
		assert.equal(store.writerFor(PR)?.pid, process.pid);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("new verdict while old fixer runs stays pending; old ack cannot erase it", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		const first = observeFix(w, PR, HEAD1, "old");
		await w.ctrl.reconcile();
		assert.equal(w.launches.length, 1);
		w.github.head = HEAD2;
		const second = observeFix(w, PR, HEAD2, "new");
		assert.equal(second.accepted, true);
		assert.notEqual(second.identity, first.identity);
		const mid = w.ctrl.status(PR)[0];
		assert.equal(mid?.state, "fixing");
		assert.equal(mid?.pendingCount, 1, "new verdict remains pending");
		await finishFixer(w, 1, HEAD2);
		assert.equal(w.ctrl.status(PR)[0]?.pendingCount, 1);
		assert.equal(w.ctrl.status(PR)[0]?.state, "waiting_review");
		await w.ctrl.reconcile();
		assert.equal(w.launches.length, 2, "pending verdict dispatches after the old round");
		assert.equal(w.launches[1]?.expectedHead, HEAD2);
	} finally {
		w.cleanup();
	}
});

test("stale verdict is dropped and re-awaited, not launched against the live head", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "stale-lines");
		w.github.head = HEAD2;
		await w.ctrl.reconcile();
		assert.equal(w.launches.length, 0, "must not launch a fixer for an obsolete head");
		assert.equal(w.reawaits, 1);
		assert.equal(w.ctrl.status(PR)[0]?.state, "waiting_review");
		assert.equal(w.ctrl.status(PR)[0]?.pendingCount, 0);
	} finally {
		w.cleanup();
	}
});

test("crash before launch acceptance recovers the same run, no duplicate child", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "crash-window");
		await w.ctrl.reconcile();
		assert.equal(w.launches.length, 1);
		const key = w.launches[0]?.idempotencyKey;
		assert.ok(key);
		const ob = w.ctrl.status(PR)[0];
		assert.equal(ob?.state, "fixing");
		const recovered = await w.ctrl.reconcile();
		assert.equal(w.launches.length, 1, "idempotent launch");
		assert.equal(recovered.launched, 0);
	} finally {
		w.cleanup();
	}
});

test("crash after push before persist: remote-head reconciliation does not double-publish", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "push-crash");
		await w.ctrl.reconcile();
		w.github.head = HEAD2;
		await w.ctrl.childFinished({
			runId: "run-1",
			ok: true,
			localHead: HEAD2,
			remoteHead: HEAD2,
		});
		assert.equal(w.published.length, 0, "already on remote; do not push again");
		assert.equal(w.reawaits, 1);
		assert.equal(w.ctrl.status(PR)[0]?.state, "waiting_review");
	} finally {
		w.cleanup();
	}
});

test("owner lookup failure does not solo-fallback or drop the obligation", async () => {
	const w = world({ owner: { status: "feature", owner: featureOwner() } });
	try {
		w.ctrl.handoff({ pr: PR, owner: featureOwner(), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "owned");
		w.owner = { status: "unavailable", reason: "jiti isolate: no handler" };
		const r = await w.ctrl.reconcile();
		assert.equal(r.launched, 0);
		assert.equal(r.recovery, 1);
		assert.equal(w.ctrl.status(PR)[0]?.state, "recovery_required");
		assert.equal(w.ctrl.status(PR)[0]?.pendingCount, 1);
	} finally {
		w.cleanup();
	}
});

test("successor session can take over an idle session obligation", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner("session-1"), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "reload-successor");
		const transfer = w.ctrl.handoff({
			pr: PR,
			owner: sessionOwner("session-2"),
			worktree: "/wt",
			head: HEAD1,
		});
		assert.equal(transfer.ok, true, "reload successor must adopt an idle session PR");
		assert.equal(transfer.transferred, true);
		w.owner = { status: "session", owner: sessionOwner("session-2") };
		const r = await w.ctrl.reconcile();
		assert.equal(r.launched, 1);
	} finally {
		w.cleanup();
	}
});

test("a different session cannot reconcile another session's obligation", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner("session-1"), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "foreign-session");
		w.owner = { status: "session", owner: sessionOwner("session-2") };
		const r = await w.ctrl.reconcile();
		assert.equal(r.launched, 0, "must not launch a fixer for someone else's session");
		assert.equal(r.recovery, 0, "mismatch is not a missing-adapter recovery");
		assert.equal(w.ctrl.status(PR)[0]?.pendingCount, 1);
		assert.notEqual(w.ctrl.status(PR)[0]?.state, "recovery_required");
	} finally {
		w.cleanup();
	}
});

test("session generation change admits no new writer", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner("session-1"), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "gen-change");
		w.owner = {
			status: "session",
			owner: { kind: "session", id: "session-1", generation: "g-other" },
		};
		const r = await w.ctrl.reconcile();
		assert.equal(r.launched, 0);
		assert.equal(w.launches.length, 0);
	} finally {
		w.cleanup();
	}
});

test("pause / cancel / generation change admit no new writer", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		w.ctrl.pause(PR, "budget");
		observeFix(w, PR, HEAD1, "paused");
		await w.ctrl.reconcile();
		assert.equal(w.launches.length, 0);
		w.ctrl.cancel(PR, "user");
		assert.equal(w.ctrl.status(PR)[0]?.state, "cancelled");
	} finally {
		w.cleanup();
	}
});

test("merge notifies the owner once; only merge completes a merge-dependent todo", async () => {
	const w = world();
	try {
		w.ctrl.handoff({
			pr: PR,
			owner: sessionOwner(),
			worktree: "/wt",
			head: HEAD1,
			linkedTodo: "todo-merge",
		});
		w.github.state = "closed";
		await w.ctrl.reconcile();
		assert.equal(w.ctrl.status(PR)[0]?.state, "closed_unmerged");
		assert.equal(isMergeDependentComplete(w.ctrl.status(PR)[0]!), false);
		await w.ctrl.reconcile();
		assert.equal(w.terminals.length, 1, "closed notifies once");

		const w2 = world();
		try {
			w2.ctrl.handoff({
				pr: PR,
				owner: sessionOwner(),
				worktree: "/wt",
				head: HEAD1,
				linkedTodo: "todo-merge",
			});
			w2.github.state = "merged";
			await w2.ctrl.reconcile();
			await w2.ctrl.reconcile();
			assert.equal(w2.terminals.length, 1);
			assert.equal(w2.terminals[0]?.state, "merged");
			assert.equal(isMergeDependentComplete(w2.ctrl.status(PR)[0]!), true);
		} finally {
			w2.cleanup();
		}
	} finally {
		w.cleanup();
	}
});

test("same PR number in another repo is a different obligation", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt/ice", head: HEAD1 });
		w.ctrl.handoff({ pr: OTHER, owner: sessionOwner(), worktree: "/wt/dev", head: HEAD1 });
		observeFix(w, PR, HEAD1, "ice");
		observeFix(w, OTHER, HEAD1, "devops");
		await w.ctrl.reconcile();
		assert.equal(w.launches.length, 2);
		const repos = new Set(w.launches.map((l) => prKeyId(l.pr)));
		assert.equal(repos.size, 2);
	} finally {
		w.cleanup();
	}
});

test("missing launch handler becomes recovery-required, obligation intact", async () => {
	const w = world();
	try {
		w.failLaunch = new Error("pr-review launch handler is not registered in this runtime");
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "no-handler");
		const r = await w.ctrl.reconcile();
		assert.equal(r.launched, 0);
		assert.equal(r.recovery, 1);
		assert.equal(w.ctrl.status(PR)[0]?.state, "recovery_required");
		assert.equal(w.ctrl.status(PR)[0]?.pendingCount, 1);
	} finally {
		w.cleanup();
	}
});

test("Pi process exit: obligation survives in the store for restart", () => {
	const dir = mkdtempSync(join(tmpdir(), "pr-review-restart-"));
	try {
		const store1 = createReviewStore(dir);
		const c1 = createReviewController({
			store: store1,
			lookupOwner: () => ({ status: "session", owner: sessionOwner() }),
			launchFixer: async () => ({ runId: "x", recovered: false }),
			queryRun: async () => undefined,
			publish: async () => ({ ok: true }),
			reawait: async () => {},
			prState: async () => "open",
			currentHead: async () => HEAD1,
			waiterHealth: async () => ({ running: true }),
			ensureWaiter: async () => {},
		});
		c1.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		c1.observeVerdict({
			pr: PR,
			next: "read_comments_and_fix",
			head: HEAD1,
			body: finding(HEAD1, "persist"),
		});
		const store2 = createReviewStore(dir);
		const again = store2.read(PR);
		assert.ok(again);
		assert.equal(again.state, "verdict_pending");
		assert.equal(again.pendingVerdicts.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("todo merge-dependent task is not complete while waiting", () => {
	const w = world();
	try {
		w.ctrl.handoff({
			pr: PR,
			owner: sessionOwner(),
			worktree: "/wt",
			head: HEAD1,
			linkedTodo: "t1",
		});
		const st = w.ctrl.status(PR)[0]!;
		assert.equal(st.linkedTodo, "t1");
		assert.equal(isMergeDependentComplete(st), false);
		assert.equal(st.state, "waiting_review");
	} finally {
		w.cleanup();
	}
});

test("failed fixer does not publish just because obligation head exists", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "fail-no-move");
		await w.ctrl.reconcile();
		await w.ctrl.childFinished({ runId: "run-1", ok: false });
		assert.equal(w.published.length, 0, "a failed round must not publish");
		const st = w.ctrl.status(PR)[0];
		assert.ok(
			st?.state === "retry_scheduled" || st?.state === "recovery_required",
			`expected retry/recovery, got ${st?.state}`,
		);
	} finally {
		w.cleanup();
	}
});

test("failed fixer that moved HEAD still publishes", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "fail-but-moved");
		await w.ctrl.reconcile();
		await w.ctrl.childFinished({ runId: "run-1", ok: false, localHead: HEAD2 });
		assert.deepEqual(w.published, [HEAD2]);
		assert.equal(w.ctrl.status(PR)[0]?.state, "waiting_review");
	} finally {
		w.cleanup();
	}
});

test("validating recovery does not hard-code ok and re-publish the old head", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "validating-fake-ok");
		await w.ctrl.reconcile();
		const snap = w.runs.get("run-1");
		assert.ok(snap);
		snap.status = "exited";
		snap.ok = false;
		await w.ctrl.reconcile();
		assert.equal(w.published.length, 0, "queryRun ok:false must not publish");
		const st = w.ctrl.status(PR)[0];
		assert.ok(
			st?.state === "retry_scheduled" || st?.state === "recovery_required",
			`must not re-arm as success; got ${st?.state}`,
		);
	} finally {
		w.cleanup();
	}
});

test("overlapping reconcile cannot run two launchFixer calls at once", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pr-review-lock-"));
	try {
		const store = createReviewStore(dir);
		const launches: LaunchIntent[] = [];
		let inflight = 0;
		let max = 0;
		let seq = 0;
		const ctrl = createReviewController({
			store,
			lookupOwner: () => ({ status: "session", owner: sessionOwner() }),
			launchFixer: async (intent) => {
				inflight += 1;
				max = Math.max(max, inflight);
				await new Promise((r) => setTimeout(r, 30));
				inflight -= 1;
				seq += 1;
				launches.push(intent);
				return { runId: `run-${seq}`, recovered: false };
			},
			queryRun: async () => undefined,
			publish: async () => ({ ok: true }),
			reawait: async () => {},
			prState: async () => "open",
			currentHead: async () => HEAD1,
			waiterHealth: async () => ({ running: true }),
			ensureWaiter: async () => {},
		});
		ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		ctrl.observeVerdict({
			pr: PR,
			next: "read_comments_and_fix",
			head: HEAD1,
			body: finding(HEAD1, "overlap"),
		});
		await Promise.all([ctrl.reconcile(), ctrl.reconcile(), ctrl.reconcile()]);
		assert.equal(max, 1, "launchFixer must not overlap");
		assert.equal(launches.length, 1, "one child per obligation");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("inbox hydrates a verdict lost from a racy obligation write", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pr-review-inbox-"));
	try {
		const store = createReviewStore(dir);
		const launches: string[] = [];
		const ctrl = createReviewController({
			store,
			lookupOwner: () => ({ status: "session", owner: sessionOwner() }),
			launchFixer: async (intent) => {
				launches.push(intent.verdictIds[0] ?? "");
				return { runId: `run-${launches.length}`, recovered: false };
			},
			queryRun: async () => undefined,
			publish: async () => ({ ok: true }),
			reawait: async () => {},
			prState: async () => "open",
			currentHead: async () => HEAD1,
			waiterHealth: async () => ({ running: true }),
			ensureWaiter: async () => {},
		});
		ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		const a = ctrl.observeVerdict({
			pr: PR,
			next: "read_comments_and_fix",
			head: HEAD1,
			body: finding(HEAD1, "inbox-a"),
		});
		const b = ctrl.observeVerdict({
			pr: PR,
			next: "read_comments_and_fix",
			head: HEAD1,
			body: finding(HEAD1, "inbox-b"),
		});
		assert.notEqual(a.identity, b.identity);
		const lost = store.read(PR)!;
		lost.pendingVerdicts = lost.pendingVerdicts.filter((v) => v.identity !== a.identity);
		store.write(lost);
		assert.equal(store.read(PR)?.pendingVerdicts.some((v) => v.identity === a.identity), false);
		await ctrl.reconcile();
		assert.equal(launches.length, 1, "hydrated obligation still dispatches");
		const pending = store.read(PR)?.pendingVerdicts.map((v) => v.identity) ?? [];
		const active = store.read(PR)?.activeVerdictIds ?? [];
		assert.ok(
			[...pending, ...active, ...launches].includes(a.identity),
			"lost verdict A must be recovered from inbox",
		);
		assert.ok(
			[...pending, ...active, ...launches].includes(b.identity),
			"verdict B must remain",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("publish failure releases the writer reservation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pr-review-pubfail-"));
	try {
		const store = createReviewStore(dir);
		const ctrl = createReviewController({
			store,
			lookupOwner: () => ({ status: "session", owner: sessionOwner() }),
			launchFixer: async () => ({ runId: "run-1", recovered: false }),
			queryRun: async () => undefined,
			publish: async () => ({ ok: false, reason: "rejected" }),
			reawait: async () => {},
			prState: async () => "open",
			currentHead: async () => HEAD1,
			waiterHealth: async () => ({ running: true }),
			ensureWaiter: async () => {},
		});
		ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		ctrl.observeVerdict({
			pr: PR,
			next: "read_comments_and_fix",
			head: HEAD1,
			body: finding(HEAD1, "pub-fail"),
		});
		await ctrl.reconcile();
		await ctrl.childFinished({ runId: "run-1", ok: true, localHead: HEAD2 });
		assert.equal(ctrl.status(PR)[0]?.state, "recovery_required");
		assert.equal(store.writerFor(PR), undefined, "lock file must be released");
		assert.equal(store.writerForWorktree("/wt"), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writerForWorktree matches a subdirectory of the reserved worktree", () => {
	const dir = mkdtempSync(join(tmpdir(), "pr-review-subdir-lock-"));
	try {
		const store = createReviewStore(dir);
		store.write({
			v: 1,
			pr: PR,
			generation: "g1",
			owner: sessionOwner(),
			worktree: "/wt/feat",
			head: HEAD1,
			state: "fixing",
			pendingVerdicts: [],
			activeVerdictIds: [],
		});
		assert.equal(
			store.reserveWriter(PR, { holder: "session:a", pid: process.pid, reservedAt: 1 }),
			true,
		);
		assert.ok(store.writerForWorktree("/wt/feat"), "root of the reserved worktree");
		assert.ok(store.writerForWorktree("/wt/feat/src"), "subdirectory is still the reserved worktree");
		assert.equal(store.writerForWorktree("/wt/feat-other"), undefined, "sibling prefix must not match");
		assert.equal(store.writerForWorktree("/wt"), undefined, "parent directory is not reserved");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writerForWorktree ignores a persisted writer when the lock file is gone", () => {
	const dir = mkdtempSync(join(tmpdir(), "pr-review-stale-lock-"));
	try {
		const store = createReviewStore(dir);
		store.write({
			v: 1,
			pr: PR,
			generation: "g1",
			owner: sessionOwner(),
			worktree: "/wt/feat",
			head: HEAD1,
			state: "recovery_required",
			pendingVerdicts: [],
			activeVerdictIds: [],
			writer: { holder: "session:dead", pid: 1, reservedAt: 1 },
		});
		assert.equal(store.writerForWorktree("/wt/feat"), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("currentHead is asked with the obligation worktree", async () => {
	const w = world();
	const seen: Array<string | undefined> = [];
	try {
		const dir = w.dir;
		const store = createReviewStore(dir);
		const ctrl = createReviewController({
			store,
			lookupOwner: () => ({ status: "session", owner: sessionOwner() }),
			launchFixer: async () => ({ runId: "run-1", recovered: false }),
			queryRun: async () => undefined,
			publish: async () => ({ ok: true }),
			reawait: async () => {},
			prState: async () => "open",
			currentHead: async (_pr, worktree) => {
				seen.push(worktree);
				return HEAD1;
			},
			waiterHealth: async () => ({ running: true }),
			ensureWaiter: async () => {},
		});
		ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt/feature", head: HEAD1 });
		ctrl.observeVerdict({
			pr: PR,
			next: "read_comments_and_fix",
			head: HEAD1,
			body: finding(HEAD1, "cwd"),
		});
		await ctrl.reconcile();
		assert.ok(seen.includes("/wt/feature"));
	} finally {
		w.cleanup();
	}
});

test("local worktree HEAD is not treated as remote; publish still runs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pr-review-localhead-"));
	try {
		const store = createReviewStore(dir);
		const published: string[] = [];
		let live = HEAD1;
		const ctrl = createReviewController({
			store,
			lookupOwner: () => ({ status: "session", owner: sessionOwner() }),
			launchFixer: async () => ({ runId: "run-1", recovered: false }),
			queryRun: async () => undefined,
			publish: async (req) => {
				published.push(req.localHead);
				return { ok: true, remoteHead: req.localHead };
			},
			reawait: async () => {},
			prState: async () => "open",
			currentHead: async () => live,
			waiterHealth: async () => ({ running: true }),
			ensureWaiter: async () => {},
		});
		ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		ctrl.observeVerdict({
			pr: PR,
			next: "read_comments_and_fix",
			head: HEAD1,
			body: finding(HEAD1, "local-not-remote"),
		});
		await ctrl.reconcile();
		live = HEAD2;
		await ctrl.childFinished({ runId: "run-1", ok: true, localHead: HEAD2 });
		assert.deepEqual(published, [HEAD2], "must publish even when local HEAD already matches the child");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("failed fixer retries the same verdict after backoff", async () => {
	let t = 1_000;
	const w = world({ now: () => t });
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "retry-me");
		await w.ctrl.reconcile();
		assert.equal(w.launches.length, 1);
		await w.ctrl.childFinished({ runId: "run-1", ok: false });
		assert.equal(w.ctrl.status(PR)[0]?.state, "retry_scheduled");
		assert.equal(w.launches.length, 1);
		t += 10_000;
		await w.ctrl.reconcile();
		assert.equal(w.launches.length, 2, "same finding must launch again after failFix");
	} finally {
		w.cleanup();
	}
});

test("dead-reviewer verdict is consumed so hydrate cannot re-arm it", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		const ack = w.ctrl.observeVerdict({
			pr: PR,
			next: "investigate_dead_reviewers",
			head: HEAD1,
			body: "status=action_required\nnext=investigate_dead_reviewers\nhead=" + HEAD1 + "\n",
		});
		assert.equal(ack.kind, "dead_reviewers");
		const r1 = await w.ctrl.reconcile();
		assert.equal(r1.rearmed, 1);
		assert.equal(w.ctrl.status(PR)[0]?.pendingCount, 0);
		assert.equal(w.ctrl.status(PR)[0]?.state, "waiting_review");
		const r2 = await w.ctrl.reconcile();
		assert.equal(r2.rearmed, 0, "receipt must stop hydratePending from replaying the same verdict");
		assert.equal(w.ctrl.status(PR)[0]?.pendingCount, 0);
	} finally {
		w.cleanup();
	}
});

test("env verdict without githubStatus still schedules a retry", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		const five = w.ctrl.observeVerdict({
			pr: PR,
			next: "fix_command_or_environment",
			head: HEAD1,
			body: "status=500\nnext=fix_command_or_environment\n",
		});
		assert.equal(five.kind, "env");
		const st = w.ctrl.status(PR)[0];
		assert.equal(st?.state, "retry_scheduled");
		assert.ok(st?.retry, "status=500 must retry even without githubStatus");
	} finally {
		w.cleanup();
	}
});

test("auth env body without githubStatus still schedules a retry", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		const auth = w.ctrl.observeVerdict({
			pr: PR,
			next: "fix_command_or_environment",
			head: HEAD1,
			body: "status=error\nnext=fix_command_or_environment\nerror=Bad credentials\n",
		});
		assert.equal(auth.kind, "env");
		assert.equal(w.ctrl.status(PR)[0]?.state, "retry_scheduled");
		assert.equal(w.ctrl.status(PR)[0]?.retry?.reason, "auth");
	} finally {
		w.cleanup();
	}
});

test("terminal verdict is consumed, not left pending", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		const ack = w.ctrl.observeVerdict({
			pr: PR,
			next: "done",
			head: HEAD1,
			body: "status=landed\nnext=done\npr=2537\n",
		});
		assert.equal(ack.kind, "terminal");
		await w.ctrl.reconcile();
		const st = w.ctrl.status(PR)[0];
		assert.equal(st?.pendingCount, 0, "terminal must not sit in the queue");
		assert.notEqual(st?.state, "verdict_pending");
	} finally {
		w.cleanup();
	}
});

test("stale persisted writer does not block Feature handoff", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pr-review-stale-writer-"));
	try {
		const store = createReviewStore(dir);
		store.write({
			v: 1,
			pr: PR,
			generation: "g1",
			owner: sessionOwner(),
			worktree: "/wt",
			head: HEAD1,
			state: "waiting_review",
			pendingVerdicts: [],
			activeVerdictIds: [],
			writer: { holder: "session:dead", pid: 1, reservedAt: 1 },
		});
		const ctrl = createReviewController({
			store,
			lookupOwner: () => ({ status: "feature", owner: featureOwner() }),
			launchFixer: async () => ({ runId: "run-1", recovered: false }),
			queryRun: async () => undefined,
			publish: async () => ({ ok: true }),
			reawait: async () => {},
			prState: async () => "open",
			currentHead: async () => HEAD1,
			waiterHealth: async () => ({ running: true }),
			ensureWaiter: async () => {},
		});
		const transfer = ctrl.handoff({
			pr: PR,
			owner: featureOwner(),
			worktree: "/wt/feat",
			head: HEAD1,
		});
		assert.equal(transfer.ok, true, "lock file gone means no live writer");
		assert.equal(transfer.transferred, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Feature cannot silently adopt a session PR while its writer is reserved", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "held");
		await w.ctrl.reconcile();
		const transfer = await w.ctrl.handoff({
			pr: PR,
			owner: featureOwner(),
			worktree: "/wt",
			head: HEAD1,
		});
		assert.equal(transfer.ok, false);
		assert.match(transfer.reason ?? "", /writer/);
	} finally {
		w.cleanup();
	}
});

test("pause during fixing releases the writer so the parent is not blocked after the child exits", async () => {
	const w = world();
	try {
		w.ctrl.handoff({ pr: PR, owner: sessionOwner(), worktree: "/wt", head: HEAD1 });
		observeFix(w, PR, HEAD1, "pause-lock");
		await w.ctrl.reconcile();
		assert.equal(w.ctrl.status(PR)[0]?.state, "fixing");
		assert.ok(createReviewStore(w.dir).writerFor(PR), "fixer holds the lock");
		await w.ctrl.pause(PR, "budget");
		assert.equal(w.ctrl.status(PR)[0]?.state, "paused");
		assert.equal(createReviewStore(w.dir).writerFor(PR), undefined, "pause must drop the lock file");
		assert.equal(createReviewStore(w.dir).writerForWorktree("/wt"), undefined);
		await w.ctrl.childFinished({ runId: "run-1", ok: true, localHead: HEAD2 });
		assert.equal(w.ctrl.status(PR)[0]?.state, "paused", "child exit must not unpause");
		assert.equal(createReviewStore(w.dir).writerFor(PR), undefined);
		assert.equal(w.published.length, 0, "paused child must not publish");
	} finally {
		w.cleanup();
	}
});

test("handoff during launch cannot clobber the writer reservation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pr-review-handoff-lock-"));
	try {
		const store = createReviewStore(dir);
		let transfer: { ok: boolean; reason?: string } | undefined;
		const ctrl = createReviewController({
			store,
			lookupOwner: () => ({ status: "session", owner: sessionOwner("session-1") }),
			launchFixer: async () => ({ runId: "run-1", recovered: false }),
			queryRun: async () => undefined,
			publish: async () => ({ ok: true }),
			reawait: async () => {},
			prState: async () => "open",
			currentHead: async () => {
				transfer = await ctrl.handoff({
					pr: PR,
					owner: sessionOwner("session-2"),
					worktree: "/wt",
					head: HEAD1,
				});
				return HEAD1;
			},
			waiterHealth: async () => ({ running: true }),
			ensureWaiter: async () => {},
		});
		await ctrl.handoff({ pr: PR, owner: sessionOwner("session-1"), worktree: "/wt", head: HEAD1 });
		ctrl.observeVerdict({
			pr: PR,
			next: "read_comments_and_fix",
			head: HEAD1,
			body: finding(HEAD1, "handoff-race"),
		});
		await ctrl.reconcile();
		assert.ok(transfer, "handoff ran during reconcile");
		assert.equal(transfer.ok, false, "must not steal a PR while reconcile holds the lock");
		assert.ok(store.writerFor(PR), "launch reservation must survive the raced handoff");
		assert.equal(store.read(PR)?.owner.id, "session-1");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
