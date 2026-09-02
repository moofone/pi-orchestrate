/**
 * The durable owner of the Feature PR phase.
 *
 * Every test here runs with **no in-memory latch at all** — that is the point.
 * The stall these fix (qa/fable_01.md F1/RC1) is precisely the case where the
 * session that ran `git pr-await` is gone: a reload mints a new session id,
 * latch adoption refuses the hand-over, and the PR is orphaned with findings
 * outstanding. Reconcile has to work from `status.md` and the waiter's files
 * alone.
 *
 * Run: node --experimental-strip-types --test test/pr-reconcile.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	listFeaturePrOwners,
	undeliveredWaiterVerdicts,
	type FeaturePrOwner,
} from "../src/lib/pr-await-core.ts";
import { reconcileFeaturePrs, type ReconcileDeps } from "../src/lib/pr-reconcile.ts";

const ACTIONABLE_BODY = [
	"status=reviewer_verdict",
	"next=read_comments_and_fix",
	"round=3",
	"brief_finding src/pay.rs:88 credit_share overflows",
].join("\n");

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), "pr-reconcile-"));
}

/** A live `/orchestrate` Feature on disk, exactly as the orchestrator writes it. */
function writeFeature(
	root: string,
	opts: {
		repo?: string;
		name?: string;
		pr?: string;
		phase?: string;
		worktree?: string | null;
		archived?: boolean;
	} = {},
): string {
	const repo = opts.repo ?? "icemining";
	const name = opts.name ?? "feat-x";
	const dir = opts.archived
		? join(root, repo, "archive", name)
		: join(root, repo, name);
	mkdirSync(dir, { recursive: true });
	const lines = [
		"# Status",
		"",
		`repo: ${repo}`,
		`name: ${name}`,
		`phase: ${opts.phase ?? "pr"}`,
		`pr: ${opts.pr ?? "2232"}`,
		"pr_round: 0",
	];
	if (opts.worktree !== null) {
		lines.push(`worktree: ${opts.worktree ?? join(root, "wt", name)}`);
	}
	writeFileSync(join(dir, "status.md"), `${lines.join("\n")}\n`);
	return dir;
}

function owner(dir: string, pr = "2232", repo = "icemining"): FeaturePrOwner {
	return {
		dir,
		statusFile: join(dir, "status.md"),
		repo,
		name: "feat-x",
		pr,
		worktree: join(dir, "wt"),
		phase: "pr",
	};
}

/** Deps that record every call and do nothing real. */
function deps(over: Partial<ReconcileDeps> = {}): {
	deps: ReconcileDeps;
	dispatched: { owner: FeaturePrOwner; verdict: { next: string; output: string } }[];
	waiters: FeaturePrOwner[];
	statuses: { owner: FeaturePrOwner; patch: Record<string, unknown> }[];
} {
	const dispatched: { owner: FeaturePrOwner; verdict: { next: string; output: string } }[] = [];
	const waiters: FeaturePrOwner[] = [];
	const statuses: { owner: FeaturePrOwner; patch: Record<string, unknown> }[] = [];
	const base: ReconcileDeps = {
		listFeatures: () => [],
		prState: async () => "open",
		undeliveredVerdicts: () => [],
		dispatch: (o, v) => {
			dispatched.push({ owner: o, verdict: v });
		},
		driverRunning: () => true,
		ensureWaiter: (o) => {
			waiters.push(o);
		},
		writeStatus: (o, patch) => {
			statuses.push({ owner: o, patch: patch as Record<string, unknown> });
		},
	};
	return { deps: { ...base, ...over }, dispatched, waiters, statuses };
}

// ---------------------------------------------------------------------------
// 1. An undelivered verdict is dispatched with no latch in the picture.
// ---------------------------------------------------------------------------

test("an undelivered verdict on disk dispatches a fixer with no session latch", async () => {
	const dir = "/tmp/feat-a";
	const h = deps({
		listFeatures: () => [owner(dir)],
		undeliveredVerdicts: () => [
			{
				path: "/state/manual-icemining-2232.json",
				next: "read_comments_and_fix",
				verdict: ACTIONABLE_BODY,
				round: "3",
			},
		],
	});
	const result = await reconcileFeaturePrs(h.deps);
	assert.equal(h.dispatched.length, 1, "the verdict must reach the dispatcher");
	assert.equal(h.dispatched[0].verdict.next, "read_comments_and_fix");
	assert.match(
		h.dispatched[0].verdict.output,
		/credit_share overflows/,
		"the writer needs the findings, not just the verdict name",
	);
	assert.equal(result.dispatched, 1);
	assert.equal(h.waiters.length, 0, "a dispatch in flight must not also start a waiter");
});

test("a refused verdict is left on disk and retried on the next pass", async () => {
	const dir = "/tmp/feat-b";
	let calls = 0;
	const verdicts = () => [
		{ path: "/state/manual-icemining-2232.json", next: "read_comments_and_fix", verdict: "x" },
	];
	const h = deps({
		listFeatures: () => [owner(dir)],
		undeliveredVerdicts: verdicts,
		dispatch: () => {
			calls += 1;
			return "refuse";
		},
	});
	const first = await reconcileFeaturePrs(h.deps);
	assert.equal(first.refused, 1);
	assert.equal(first.dispatched, 0, "a refusal is not a delivery");
	// The file is untouched, so the next pass sees it again. That retry is what
	// drains the verdict once the writer holding the Feature is done.
	const second = await reconcileFeaturePrs(h.deps);
	assert.equal(second.refused, 1);
	assert.equal(calls, 2, "a refused verdict must be re-offered");
});

// ---------------------------------------------------------------------------
// 2. A merged PR closes its Feature without any latch witnessing the merge.
// ---------------------------------------------------------------------------

test("a merged PR closes the Feature with no latch involved", async () => {
	const dir = "/tmp/feat-c";
	const h = deps({
		listFeatures: () => [owner(dir)],
		prState: async () => "merged",
		driverRunning: () => false,
	});
	const result = await reconcileFeaturePrs(h.deps);
	assert.equal(h.dispatched.length, 1);
	assert.equal(h.dispatched[0].verdict.next, "done");
	assert.equal(result.finished, 1);
	assert.equal(h.waiters.length, 0, "a merged PR must never get a waiter");
});

test("a closed-unmerged PR asks for confirmation, not an archive", async () => {
	const h = deps({
		listFeatures: () => [owner("/tmp/feat-d")],
		prState: async () => "closed",
		driverRunning: () => false,
	});
	await reconcileFeaturePrs(h.deps);
	assert.equal(h.dispatched[0].verdict.next, "stop");
});

test("an unknown PR state never closes a live Feature", async () => {
	// A rate-limited or offline `gh pr view` used to be the only thing standing
	// between a live Feature and being marked done.
	const h = deps({
		listFeatures: () => [owner("/tmp/feat-e")],
		prState: async () => "unknown",
		driverRunning: () => false,
	});
	const result = await reconcileFeaturePrs(h.deps);
	assert.equal(result.finished, 0, "unknown is not merged");
	assert.equal(h.dispatched.length, 0, "nothing is dispatched on an unknown state");
	assert.equal(
		h.waiters.length,
		0,
		"and no waiter is started either — the PR may already be gone",
	);
});

// ---------------------------------------------------------------------------
// 3. Exactly one waiter.
// ---------------------------------------------------------------------------

test("an open PR with no live waiter gets exactly one", async () => {
	const h = deps({
		listFeatures: () => [owner("/tmp/feat-f")],
		prState: async () => "open",
		driverRunning: () => false,
	});
	const result = await reconcileFeaturePrs(h.deps);
	assert.equal(h.waiters.length, 1);
	assert.equal(result.waitersStarted, 1);
});

test("an open PR whose waiter is alive gets no second one", async () => {
	// Three uncoordinated spawners put 25 daemons on one PR and rate-limited
	// GitHub (F3). The reconciler is the single spawner now, so it has to be
	// the strictest about this.
	const h = deps({
		listFeatures: () => [owner("/tmp/feat-g")],
		prState: async () => "open",
		driverRunning: () => true,
	});
	await reconcileFeaturePrs(h.deps);
	assert.equal(h.waiters.length, 0);
});

test("the head reported by GitHub is persisted for the next pass", async () => {
	const h = deps({
		listFeatures: () => [owner("/tmp/feat-h")],
		prState: async () => ({ state: "open" as const, head: "d5ec214" }),
		driverRunning: () => true,
	});
	await reconcileFeaturePrs(h.deps);
	assert.equal(h.statuses.length, 1);
	assert.equal(h.statuses[0].patch.prHead, "d5ec214");
});

// ---------------------------------------------------------------------------
// Robustness: one bad Feature must not stop the rest.
// ---------------------------------------------------------------------------

test("a Feature that throws is reported and the pass continues", async () => {
	const bad = owner("/tmp/feat-bad");
	const good = owner("/tmp/feat-good");
	const errors: unknown[] = [];
	const h = deps({
		listFeatures: () => [bad, good],
		prState: async (o) => {
			if (o.dir === bad.dir) throw new Error("gh exploded");
			return "merged";
		},
		onError: (_o, e) => errors.push(e),
	});
	const result = await reconcileFeaturePrs(h.deps);
	assert.equal(errors.length, 1, "the failure is reported, not swallowed silently");
	assert.equal(result.seen, 2);
	assert.equal(result.finished, 1, "the healthy Feature was still reconciled");
});

test("a listing that throws yields an empty pass instead of taking the session down", async () => {
	const h = deps({
		listFeatures: () => {
			throw new Error("orchestrator root unreadable");
		},
	});
	const result = await reconcileFeaturePrs(h.deps);
	assert.equal(result.seen, 0);
});

// ---------------------------------------------------------------------------
// The production walk: which Features are listed, and which are not.
// ---------------------------------------------------------------------------

test("listFeaturePrOwners returns only live phase:pr Features with a PR number", () => {
	const root = tmpRoot();
	try {
		writeFeature(root, { name: "in-pr", pr: "2232" });
		writeFeature(root, { name: "implementing", pr: "2233", phase: "implementing" });
		writeFeature(root, { name: "planning", pr: "2234", phase: "planning" });
		writeFeature(root, { name: "no-pr", pr: "none" });
		writeFeature(root, { name: "archived-pr", pr: "2235", archived: true });
		const found = listFeaturePrOwners({ root }).map((o) => o.name).sort();
		assert.deepEqual(found, ["in-pr"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listFeaturePrOwners reads the PR number out of a URL", () => {
	const root = tmpRoot();
	try {
		writeFeature(root, {
			name: "url-pr",
			pr: "https://github.com/moofone/icemining/pull/2131",
		});
		const found = listFeaturePrOwners({ root });
		assert.equal(found.length, 1);
		assert.equal(found[0].pr, "2131");
		assert.equal(found[0].repo, "icemining");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listFeaturePrOwners can be asked for other phases", () => {
	const root = tmpRoot();
	try {
		writeFeature(root, { name: "in-pr", pr: "1" });
		writeFeature(root, { name: "impl", pr: "2", phase: "implementing" });
		const found = listFeaturePrOwners({ root, phases: ["pr", "implementing"] })
			.map((o) => o.name)
			.sort();
		assert.deepEqual(found, ["impl", "in-pr"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// The production verdict scan.
// ---------------------------------------------------------------------------

test("undeliveredWaiterVerdicts finds a verdict under either waiter name", () => {
	const dir = tmpRoot();
	try {
		writeFileSync(
			join(dir, "manual-icemining-2232.json"),
			JSON.stringify({
				pr: "2232",
				lastNext: "read_comments_and_fix",
				verdict: ACTIONABLE_BODY,
				verdictDelivered: false,
			}),
		);
		const found = undeliveredWaiterVerdicts("2232", dir);
		assert.equal(found.length, 1);
		assert.equal(found[0].next, "read_comments_and_fix");
		assert.equal(found[0].round, "3", "the round comes from the verdict body");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a delivered verdict is not offered again", () => {
	const dir = tmpRoot();
	try {
		writeFileSync(
			join(dir, "manual-2232.json"),
			JSON.stringify({
				pr: "2232",
				lastNext: "read_comments_and_fix",
				verdictDelivered: true,
			}),
		);
		assert.deepEqual(undeliveredWaiterVerdicts("2232", dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a non-actionable verdict is not a fixer job", () => {
	const dir = tmpRoot();
	try {
		for (const next of ["yield", "poll_again", "done", "git_pr_land"]) {
			writeFileSync(
				join(dir, `manual-${next}-1.json`),
				JSON.stringify({ pr: "1", lastNext: next, verdictDelivered: false }),
			);
		}
		assert.deepEqual(undeliveredWaiterVerdicts("1", dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a latch sidecar is never read as a waiter verdict", () => {
	const dir = tmpRoot();
	try {
		// ghl-monitor respawns drivers from these; the reconciler must not treat
		// the extension's private copy as the waiter's answer (F3, F20).
		writeFileSync(
			join(dir, "pi-abc.latch.json"),
			JSON.stringify({
				pr: "2232",
				lastNext: "read_comments_and_fix",
				verdictDelivered: false,
			}),
		);
		assert.deepEqual(undeliveredWaiterVerdicts("2232", dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a session state file for a different PR is not offered", () => {
	const dir = tmpRoot();
	try {
		writeFileSync(
			join(dir, "pi-session-1.json"),
			JSON.stringify({
				pr: "9999",
				lastNext: "read_comments_and_fix",
				verdictDelivered: false,
			}),
		);
		assert.deepEqual(undeliveredWaiterVerdicts("2232", dir), []);
		assert.equal(undeliveredWaiterVerdicts("9999", dir).length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a session state file that names no PR is skipped rather than guessed at", () => {
	const dir = tmpRoot();
	try {
		writeFileSync(
			join(dir, "pi-session-2.json"),
			JSON.stringify({ lastNext: "read_comments_and_fix", verdictDelivered: false }),
		);
		assert.deepEqual(undeliveredWaiterVerdicts("2232", dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// End to end over real files: the F1 scenario, with no latch anywhere.
// ---------------------------------------------------------------------------

test("F1: a killed session leaves a verdict that the next reconcile dispatches", async () => {
	const root = tmpRoot();
	const state = tmpRoot();
	try {
		const dir = writeFeature(root, { name: "per-coin", pr: "2232" });
		writeFileSync(
			join(state, "manual-icemining-2232.json"),
			JSON.stringify({
				pr: "2232",
				lastNext: "read_comments_and_fix",
				verdict: ACTIONABLE_BODY,
				verdictDelivered: false,
			}),
		);
		const h = deps({
			listFeatures: () => listFeaturePrOwners({ root }),
			undeliveredVerdicts: (o) => undeliveredWaiterVerdicts(o.pr, state),
			prState: async () => "open",
			driverRunning: () => false,
		});
		const result = await reconcileFeaturePrs(h.deps);
		assert.equal(result.seen, 1);
		assert.equal(result.dispatched, 1, "the orphaned verdict must be picked up from disk");
		assert.equal(h.dispatched[0].owner.dir, dir);
		assert.equal(h.dispatched[0].verdict.next, "read_comments_and_fix");
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
});

test("F8: a merged PR closes its Feature even though every waiter is dead", async () => {
	const root = tmpRoot();
	const state = tmpRoot();
	try {
		writeFeature(root, { name: "fail-closed-ban-issuer", pr: "2191" });
		const h = deps({
			listFeatures: () => listFeaturePrOwners({ root }),
			undeliveredVerdicts: (o) => undeliveredWaiterVerdicts(o.pr, state),
			prState: async () => "merged",
			driverRunning: () => false,
		});
		const result = await reconcileFeaturePrs(h.deps);
		assert.equal(result.finished, 1);
		assert.equal(h.dispatched[0].verdict.next, "done");
		assert.equal(h.waiters.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
});
