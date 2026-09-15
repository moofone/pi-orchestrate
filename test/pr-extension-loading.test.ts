import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = require("jiti");
function bus() {
  const emitter = new EventEmitter();
  return {
    emit: (name: string, data: unknown) => { emitter.emit(name, data); },
    on: (name: string, fn: (data: any) => void) => {
      emitter.on(name, fn);
      return () => { emitter.off(name, fn); };
    },
  };
}

test("Pi isolated extension loads share latch arm and terminal delivery through the runtime bus", async () => {
  // These are the production loader's options, not native ESM's shared cache.
  const orch = await createJiti(import.meta.url, { moduleCache: false }).import("../src/lib/pr-await-core.ts");
  const latch = await createJiti(import.meta.url, { moduleCache: false }).import("../src/lib/pr-await-core.ts");
  assert.notEqual(orch, latch);
  const events = bus();
  const otherRuntime = bus();
  let arms = 0;
  let wakes = 0;
  const offArm = latch.registerLatchArm(() => { arms++; }, events);
  const offTerminal = latch.registerLatchTerminal(() => { wakes++; return true; }, events);
  try {
    orch.armObservedLatch({}, { pr: "2277", cwd: "/tmp" }, events);
    assert.equal(arms, 1, "the handshake must reach the separately loaded latch");
    assert.equal(orch.notifyLatchTerminal({ pr: "2277", state: "merged" }, events), true);
    assert.equal(wakes, 1);
    orch.armObservedLatch({}, { pr: "2277", cwd: "/tmp" }, otherRuntime);
    assert.equal(arms, 1, "another runtime must not hijack this session's latch");
  } finally {
    offArm?.();
    offTerminal?.();
  }
});

test("isolated production factories carry yield through two review-fix rounds without a parent turn", async () => {
  const orch = await createJiti(import.meta.url, { moduleCache: false }).import("../src/orchestrate.ts");
  const latch = await createJiti(import.meta.url, { moduleCache: false }).import("../src/pr-await-latch.ts");
  const root = mkdtempSync(join(tmpdir(), "pr-full-lifecycle-"));
  const oldRoot = process.env.GHL_ORCH_ROOT;
  const oldState = process.env.GHL_LATCH_STATE_DIR;
  process.env.GHL_ORCH_ROOT = root;
  process.env.GHL_LATCH_STATE_DIR = join(root, "waiter");
  const dir = join(root, "repo", "feature");
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(root, "waiter"));
  const paths = { repo: "repo", gitRoot: dir, repoDir: join(root, "repo"), featureDir: dir,
    planFile: join(dir, "plan.md"), statusFile: join(dir, "status.md"), handoffsDir: join(dir, "handoffs"), archiveDir: join(root, "repo", "archive") };
  mkdirSync(paths.handoffsDir);
  writeFileSync(paths.planFile, "# Feature: test\n");
  writeFileSync(paths.statusFile, "phase: implementing\npause: off\nparent_session_id: loader-test\n");
  const events = bus();
  const latchHandlers = new Map<string, any>();
  const orchHandlers = new Map<string, any>();
  let head = 0;
  let waits = 0;
  let parentTurns = 0;
  const runs: string[] = [];
  const pi = {
    events, on: (name: string, fn: any) => { orchHandlers.set(name, fn); },
    registerCommand() {}, registerEntryRenderer() {}, registerMarkdownTransformer() {},
    sendUserMessage() { parentTurns++; },
    exec: async (cmd: string, args: string[]) => {
      let stdout = "";
      if (cmd === "gh") stdout = JSON.stringify({ state: "OPEN", headRefOid: `H${head}` });
      else if (args[0] === "pr-await") { waits++; stdout = "next=yield\npr=2277\nurl=https://github.com/test/repo/pull/2277"; }
      else if (args[0] === "rev-parse") stdout = args[1] === "--abbrev-ref" ? "feat/test" : `H${head}`;
      return { code: 0, stdout, stderr: "" };
    },
  };
  const ctx = { cwd: dir, isIdle: () => true, sessionManager: { getSessionId: () => "loader-test", getSessionFile: () => undefined } };
  const owner = { dir, statusFile: paths.statusFile, repo: "repo", name: "feature", pr: "2277", worktree: dir };
  events.on("subagents:rpc:v1:request", (request) => {
    assert.equal(request.method, "spawn");
    assert.equal(request.params.agent, "fixer");
    const runId = `loader-fixer-${runs.length + 1}`;
    runs.push(runId);
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true, data: { details: { runId } } });
  });
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(condition(), "lifecycle failed to advance within 3 seconds");
  };
  try {
    orch.default(pi);
    latch.default({ ...pi, on: (name: string, fn: any) => { latchHandlers.set(name, fn); } }, {
      driverRunning: () => true, featureOwnedPr: () => owner,
      watchMs: 600_000, chromeMs: 0, watchStateDir: true,
      // No dispatch hook: exercise the real extension-to-extension route.
    });
    await orch.drivePrAwait(pi, ctx, paths, "2277", dir);
    await until(() => existsSync(join(root, "waiter", "pi-loader-test.latch.json")));
    for (const round of [1, 2]) {
      // Production fs.watch path, not a fast GitHub polling timer.
      writeFileSync(join(root, "waiter", "manual-repo-2277.json"), JSON.stringify({
        pr: "2277", lastNext: "read_comments_and_fix", round: String(round), verdictDelivered: false,
        verdict: `head=H${head}\nbrief_finding round-${round} requires a fix`,
      }));
      await until(() => runs.length === round);
      await until(() => readFileSync(paths.statusFile, "utf8").includes(`worker_run_id: ${runs[round - 1]}`));
      head++;
      events.emit("subagent:async-complete", { runId: runs[round - 1], success: true, state: "completed" });
      await until(() => waits === round + 1);
    }
    assert.equal(runs.length, 2);
    assert.equal(waits, 3, "initial wait plus one wait after each fixer");
    assert.equal(parentTurns, 0, "code owns both fix rounds");
  } finally {
    await latchHandlers.get("session_shutdown")?.({}, ctx);
    await orchHandlers.get("session_shutdown")?.({}, ctx);
    if (oldRoot === undefined) delete process.env.GHL_ORCH_ROOT; else process.env.GHL_ORCH_ROOT = oldRoot;
    if (oldState === undefined) delete process.env.GHL_LATCH_STATE_DIR; else process.env.GHL_LATCH_STATE_DIR = oldState;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a separately loaded latch dispatches through the registered orchestrator's held chain lock", async () => {
  const orch = await createJiti(import.meta.url, { moduleCache: false }).import("../src/orchestrate.ts");
  const latchCore = await createJiti(import.meta.url, { moduleCache: false }).import("../src/lib/pr-await-core.ts");
  const events = bus();
  const dir = mkdtempSync(join(tmpdir(), "pr-loader-lock-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "status.md"), "phase: pr\npr: 2277\nworker_run_id: none\n");
  let effects = 0;
  const pi = {
    events, on() {}, registerCommand() {}, registerEntryRenderer() {}, registerMarkdownTransformer() {},
    exec: async () => { effects++; throw new Error("must not execute while locked"); },
  };
  orch.default(pi);
  try {
    await orch.withChainLock(dir, async () => {
      const action = await latchCore.requestFeaturePrDispatch(events, {}, {
        dir, statusFile: join(dir, "status.md"), repo: "test", name: "test", pr: "2277", worktree: dir,
      }, { next: "read_comments_and_fix", output: "head=abc\nbrief_finding existing failure" });
      assert.equal(action, "refuse", "the latch must use the live orchestrator, not a newly imported copy");
      assert.equal(effects, 0);
    });
    await assert.rejects(latchCore.requestFeaturePrDispatch(bus(), {}, {}, {}), /not registered/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opening the first PR arms the recovery timer even without a latch plugin", async (t) => {
  const orch = await createJiti(import.meta.url, { moduleCache: false }).import("../src/orchestrate.ts");
  const root = mkdtempSync(join(tmpdir(), "pr-first-wait-"));
  const oldRoot = process.env.GHL_ORCH_ROOT;
  process.env.GHL_ORCH_ROOT = root;
  const dir = join(root, "repo", "feature");
  mkdirSync(dir, { recursive: true });
  const paths = { repo: "repo", gitRoot: dir, repoDir: join(root, "repo"), featureDir: dir,
    planFile: join(dir, "plan.md"), statusFile: join(dir, "status.md"), handoffsDir: join(dir, "handoffs"), archiveDir: join(root, "repo", "archive") };
  writeFileSync(paths.planFile, "# Feature: first PR\n");
  writeFileSync(paths.statusFile, "phase: implementing\npause: off\n");
  const intervals: number[] = [];
  t.mock.method(globalThis, "setInterval", (_fn: unknown, ms: number) => {
    intervals.push(ms);
    return { unref() {} };
  });
  try {
    await orch.drivePrAwait({ events: bus(), exec: async () => ({ code: 0, stdout: "next=yield\npr=2277", stderr: "" }) }, {}, paths, "2277", dir);
    assert.deepEqual(intervals, [orch.RECONCILE_INTERVAL_MS], "a PR created after command entry still needs recovery when its latch is missing");
  } finally {
    if (oldRoot === undefined) delete process.env.GHL_ORCH_ROOT;
    else process.env.GHL_ORCH_ROOT = oldRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
