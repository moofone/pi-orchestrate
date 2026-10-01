/**
 * Session side of the PR fix executor (spec GHL_PR_FIX_EXECUTOR.md §3.2/3.3):
 * one decision point (`executorOwnsVerdict`), notify-once outcomes, and the
 * GHL_FIX_HOST=1 inert switch.
 *
 * Run: node --experimental-strip-types --test test/fix-executor.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "ghl-fixexec-state-"));
process.env.GHL_LATCH_STATE_DIR = STATE;
process.env.GHL_ORCH_ROOT = mkdtempSync(join(tmpdir(), "ghl-fixexec-orch-"));

const fx = await import("../src/lib/fix-executor.ts");
const core = await import("../src/lib/pr-await-core.ts");
const orch = await import("../src/orchestrate.ts");
const { default: guardExtension } = await import("../src/git-workflow-guard.ts");
const { default: latchExtension } = await import("../src/pr-await-latch.ts");

test("executorOwnsVerdict: only fixOwner=executor with read_comments_and_fix", () => {
	assert.equal(fx.executorOwnsVerdict({ fixOwner: "executor", lastNext: "read_comments_and_fix" }), true);
	assert.equal(fx.executorOwnsVerdict({ fixOwner: "executor", lastNext: "yield" }), false);
	assert.equal(fx.executorOwnsVerdict({ lastNext: "read_comments_and_fix" }), false);
	assert.equal(fx.executorOwnsVerdict({ fixOwner: "other", lastNext: "read_comments_and_fix" }), false);
	assert.equal(fx.executorOwnsVerdict(undefined), false);
});

test("outcomeNotice: key is pr+round+state; pushed=info with short sha, failed/stopped=error with reason", () => {
	assert.equal(fx.outcomeNotice({ pr: "7" }), undefined);
	const pushed = fx.outcomeNotice({
		pr: "7",
		fixOutcome: { state: "pushed", head: "a".repeat(40), newHead: "b1c2d3e4f5a6".padEnd(40, "0"), round: 2 },
	});
	assert.equal(pushed?.key, "7:2:pushed");
	assert.equal(pushed?.level, "info");
	assert.match(pushed?.text ?? "", /b1c2d3e/);
	assert.doesNotMatch(pushed?.text ?? "", /b1c2d3e4f/);
	const failed = fx.outcomeNotice({ pr: "7", fixOutcome: { state: "failed", reason: "no-commit", round: 2 } });
	assert.equal(failed?.key, "7:2:failed");
	assert.equal(failed?.level, "error");
	assert.match(failed?.text ?? "", /no-commit/);
	const stopped = fx.outcomeNotice({ pr: "7", fixOutcome: { state: "stopped", reason: "round-cap", round: 5 } });
	assert.equal(stopped?.level, "error");
	assert.notEqual(stopped?.key, failed?.key);
});

test("readWaiterVerdict carries the executor fields; undeliveredWaiterVerdicts skips executor-owned", () => {
	const dir = mkdtempSync(join(tmpdir(), "ghl-fixexec-undel-"));
	const owned = core.waiterStatePath("repo", "801", dir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		owned,
		JSON.stringify({ pr: "801", lastNext: "read_comments_and_fix", verdict: "v", verdictDelivered: false, fixOwner: "executor", fixDispatch: { pid: 1, startedAt: 1, head: "h", round: 1 } }),
	);
	const v = core.readWaiterVerdict(owned);
	assert.equal(v?.fixOwner, "executor");
	assert.equal(core.executorOwnsPr("801", { slug: "o/repo" }, dir), true);
	assert.deepEqual(core.undeliveredWaiterVerdicts("801", dir), []);

	const plain = core.waiterStatePath("repo", "802", dir);
	writeFileSync(plain, JSON.stringify({ pr: "802", lastNext: "read_comments_and_fix", verdict: "v", verdictDelivered: false }));
	assert.equal(core.executorOwnsPr("802", { slug: "o/repo" }, dir), false);
	assert.equal(core.undeliveredWaiterVerdicts("802", dir).length, 1, "off path: no fixOwner behaves as today");
});

test("executorOwnsPr is scoped by repo + PR: same number in another repo is not owned", () => {
	const dir = mkdtempSync(join(tmpdir(), "ghl-fixexec-scope-"));
	writeFileSync(
		core.waiterPaths("repoa", "810", dir).manual[0]!,
		JSON.stringify({ pr: "810", lastNext: "read_comments_and_fix", verdict: "v", verdictDelivered: false, fixOwner: "executor", fixOutcome: { state: "failed", reason: "x", round: 1 } }),
	);
	writeFileSync(
		core.waiterPaths("repob", "810", dir).manual[0]!,
		JSON.stringify({ pr: "810", lastNext: "read_comments_and_fix", verdict: "v", verdictDelivered: false }),
	);
	assert.equal(core.executorOwnsPr("810", { slug: "o/repoa" }, dir), true);
	assert.equal(core.executorOwnsPr("810", { slug: "o/repob" }, dir), false);
	assert.equal(core.executorOwnsPr("810", { cwd: "/w/repob" }, dir), false);
});

test("Feature dispatch: same PR number owned by another repo's executor still dispatches", async () => {
	const pr = "811";
	writeFileSync(
		core.waiterPaths("repoa", pr, STATE).manual[0]!,
		JSON.stringify({ pr, lastNext: "read_comments_and_fix", verdict: "v", verdictDelivered: false, fixOwner: "executor" }),
	);
	const dir = mkdtempSync(join(tmpdir(), "orch-fixexec-scope-"));
	const paths = {
		repo: "repob", gitRoot: dir, repoDir: dir, featureDir: dir,
		planFile: join(dir, "plan.md"), statusFile: join(dir, "status.md"),
		handoffsDir: join(dir, "handoffs"), archiveDir: join(dir, "archive"),
	};
	writeFileSync(paths.planFile, "# Feature: t\n");
	writeFileSync(paths.statusFile, ["# Status", "", "pause: off", "phase: pr", `pr: ${pr}`, "pr_round: 0", ""].join("\n"));
	const execs: string[] = [];
	const pi = {
		events: { on: () => () => {}, emit: () => {} },
		exec: async (cmd: string, args: string[]) => (execs.push([cmd, ...args].join(" ")), { code: 0, stdout: "", stderr: "" }),
		sendUserMessage: () => {},
	};
	const ctx = { cwd: dir, hasUI: false, ui: { notify() {}, setStatus() {}, setWidget() {} } };
	let threw = false;
	try {
		await (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
			pi, ctx, paths, pr, dir, { next: "read_comments_and_fix", output: "next=read_comments_and_fix\nfinding" },
		);
	} catch {
		threw = true;
	}
	assert.ok(threw || execs.length > 0, "repob's verdict must get past the executor gate (not the idle short-circuit)");
});

test("executorLostNotice: dead pid, or no dispatch after 60s; none while alive/early/outcome/off", () => {
	const base = { pr: "9", slug: "o/r", lastNext: "read_comments_and_fix", fixOwner: "executor" };
	const dead = { now: 1_000_000, pidAlive: () => false };
	const alive = { now: 1_000_000, pidAlive: () => true };
	const n = fx.executorLostNotice({ ...base, fixDispatch: { pid: 5, round: 2 } }, dead);
	assert.equal(n?.level, "error");
	assert.equal(n?.key, "9:2:executor-lost");
	assert.match(n?.text ?? "", /executor-lost/);
	assert.equal(fx.executorLostNotice({ ...base, fixDispatch: { pid: 5, round: 2 } }, alive), undefined);
	// no dispatch: grace 60s from the verdict write
	assert.equal(fx.executorLostNotice(base, { ...alive, verdictAtMs: 1_000_000 - 59_000 }), undefined);
	assert.equal(fx.executorLostNotice(base, { ...alive, verdictAtMs: 1_000_000 - 60_000 })?.level, "error");
	assert.equal(fx.executorLostNotice(base, alive), undefined, "unknown verdict time: no guess");
	// outcome present, off path, foreign owner
	assert.equal(fx.executorLostNotice({ ...base, fixDispatch: { pid: 5 }, fixOutcome: { state: "failed" } }, dead), undefined);
	assert.equal(fx.executorLostNotice({ ...base, fixOwner: undefined, fixDispatch: { pid: 5 } }, dead), undefined);
	assert.equal(fx.executorLostNotice({ ...base, lastNext: "yield", fixDispatch: { pid: 5 } }, dead), undefined);
});

test("outcomeNotice: stopped is an error-level notice with reason", () => {
	const n = fx.outcomeNotice({ pr: "7", slug: "o/r", fixOutcome: { state: "stopped", reason: "disagreement", round: 3 } });
	assert.equal(n?.level, "error");
	assert.equal(n?.key, "7:3:stopped");
	assert.match(n?.text ?? "", /stopped.*disagreement/);
});

test("Feature dispatch: executor-owned read_comments_and_fix spawns no writer", async () => {
	const pr = "803";
	writeFileSync(
		core.waiterStatePath("repo", pr, STATE),
		JSON.stringify({ pr, lastNext: "read_comments_and_fix", verdict: "v", verdictDelivered: false, fixOwner: "executor" }),
	);
	const dir = mkdtempSync(join(tmpdir(), "orch-fixexec-"));
	const paths = {
		repo: "repo", gitRoot: dir, repoDir: dir, featureDir: dir,
		planFile: join(dir, "plan.md"), statusFile: join(dir, "status.md"),
		handoffsDir: join(dir, "handoffs"), archiveDir: join(dir, "archive"),
	};
	writeFileSync(paths.planFile, "# Feature: t\n");
	writeFileSync(paths.statusFile, ["# Status", "", "pause: off", "phase: pr", `pr: ${pr}`, "pr_round: 0", ""].join("\n"));
	const execs: string[] = [];
	const sent: string[] = [];
	const pi = {
		events: { on: () => () => {}, emit: () => {} },
		exec: async (cmd: string, args: string[]) => (execs.push([cmd, ...args].join(" ")), { code: 0, stdout: "", stderr: "" }),
		sendUserMessage: (t: string) => sent.push(t),
	};
	const notifies: string[] = [];
	const ctx = { cwd: dir, hasUI: false, ui: { notify: (m: string) => notifies.push(m), setStatus() {}, setWidget() {} } };
	const action = await (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
		pi, ctx, paths, pr, dir, { next: "read_comments_and_fix", output: "next=read_comments_and_fix\nfinding" },
	);
	assert.equal(action, "idle");
	assert.deepEqual(execs, []);
	assert.deepEqual(sent, []);
});

function fakePi() {
	const events: string[] = [];
	const commands: string[] = [];
	return {
		events, commands,
		pi: {
			on: (e: string) => events.push(e),
			registerCommand: (n: string) => commands.push(n),
			registerEntryRenderer: () => events.push("renderer"),
			registerMarkdownTransformer: () => events.push("md"),
			registerTool: () => events.push("tool"),
			exec: async () => { throw new Error("gh/git must not run in a fix host"); },
			events: { on: () => () => {}, emit: () => {} },
			sendUserMessage: () => { throw new Error("no wake"); },
		} as never,
	};
}

test("GHL_FIX_HOST=1: latch and orchestrate extensions register nothing", () => {
	const prior = process.env.GHL_FIX_HOST;
	process.env.GHL_FIX_HOST = "1";
	try {
		const a = fakePi();
		latchExtension(a.pi);
		assert.deepEqual([a.events, a.commands], [[], []], "latch must be inert");
		const b = fakePi();
		orch.default(b.pi);
		assert.deepEqual([b.events, b.commands], [[], []], "orchestrate must be inert");
		// Registries stay empty: no dispatcher / latch arm in this process.
		core.armObservedLatch({}, { pr: "1", cwd: "/x" });
	} finally {
		if (prior === undefined) delete process.env.GHL_FIX_HOST; else process.env.GHL_FIX_HOST = prior;
	}
});

test("GHL_FIX_HOST unset: latch still registers its handlers (off path unchanged)", () => {
	const prior = process.env.GHL_FIX_HOST;
	delete process.env.GHL_FIX_HOST;
	try {
		const a = fakePi();
		latchExtension(a.pi);
		assert.ok(a.events.includes("session_start"));
		assert.ok(a.commands.includes("pr-latch"));
	} finally {
		if (prior !== undefined) process.env.GHL_FIX_HOST = prior;
	}
});

test("GHL_FIX_HOST=1: guard still blocks push/pr-await for the fixer child", async () => {
	const prior = { host: process.env.GHL_FIX_HOST, agent: process.env.PI_SUBAGENT_CHILD_AGENT };
	process.env.GHL_FIX_HOST = "1";
	process.env.PI_SUBAGENT_CHILD_AGENT = "fixer";
	try {
		let handler: ((e: unknown) => Promise<{ block?: boolean } | undefined>) | undefined;
		guardExtension({ on(n: string, fn: never) { if (n === "tool_call") handler = fn; } } as never);
		assert.ok(handler, "guard must stay registered");
		for (const command of ["git push origin HEAD", "git pr-await 12"]) {
			const r = await handler!({ toolName: "bash", input: { command }, cwd: tmpdir() });
			assert.equal(r?.block, true, `${command} must stay blocked`);
		}
	} finally {
		if (prior.host === undefined) delete process.env.GHL_FIX_HOST; else process.env.GHL_FIX_HOST = prior.host;
		if (prior.agent === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT; else process.env.PI_SUBAGENT_CHILD_AGENT = prior.agent;
	}
});
