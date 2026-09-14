/**
 * Shared-tree writer tests: disjoint write-sets let fixers and tdd-workers
 * share one worktree (up to 4 fixers, up to 8 workers).
 *
 * Run: node --experimental-strip-types --test test/shared-tree.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as orch from "../src/orchestrate.ts";
import {
  readWriterSlots,
  sweepWriterSlots,
  updateWriterSlots,
  withWriterLockAsync,
} from "../src/lib/write-sets.ts";

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const ORCH_SRC = join(dirname(fileURLToPath(import.meta.url)), "../src/orchestrate.ts");

function makeFakePi(exec?: (cmd: string, args: string[]) => Promise<unknown>) {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const sentUserMessages: { text: string }[] = [];
  return {
    events: {
      on(name: string, fn: (data: unknown) => void) {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(fn);
        return () => handlers.get(name)?.delete(fn);
      },
      emit(name: string, data: unknown) {
        for (const fn of [...(handlers.get(name) ?? [])]) fn(data);
      },
    },
    exec: exec ?? (async () => ({ code: 0, stdout: "", stderr: "" })),
    sendUserMessage(text: string) {
      sentUserMessages.push({ text: String(text ?? "") });
    },
    sentUserMessages,
  };
}

function featurePaths(dir: string) {
  return {
    repo: "icemining",
    gitRoot: dir,
    repoDir: dir,
    featureDir: dir,
    planFile: join(dir, "plan.md"),
    statusFile: join(dir, "status.md"),
    handoffsDir: join(dir, "handoffs"),
    archiveDir: join(dir, "archive"),
  };
}

function prFixture(prRound: number) {
  const dir = mkdtempSync(join(tmpdir(), "orch-shared-"));
  const paths = featurePaths(dir);
  writeFileSync(paths.planFile, "# Feature: t\n");
  writeFileSync(
    paths.statusFile,
    [
      "# Status",
      "",
      "pause: off",
      `worktree: ${dir}`,
      "phase: pr",
      "pr: 99",
      `pr_round: ${prRound}`,
      "worker_run_id: none",
      "worker_run_dir: none",
      "",
    ].join("\n"),
  );
  return { dir, paths };
}

function orchestrateChild(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script, ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`orchestrate child exited ${code}: ${stderr}`));
    });
  });
}

/** Settle every spawn RPC, collecting each spawn's params. */
function autoSettleAllSpawns(pi: ReturnType<typeof makeFakePi>) {
  const spawns: Record<string, unknown>[] = [];
  let count = 0;
  (pi as never as { events: { on: Function; emit: Function } }).events.on(
    RPC_REQUEST_EVENT,
    (req: { requestId?: string; method?: string; params?: Record<string, unknown> }) => {
      if (req?.method && req.method !== "spawn") return;
      count += 1;
      spawns.push(req?.params ?? {});
      const requestId = req?.requestId ?? "";
      const id = `run-multi-${count}`;
      const bus = (pi as never as { events: { emit: Function } }).events;
      queueMicrotask(() => {
        bus.emit(`${RPC_REPLY_PREFIX}${requestId}`, {
          success: true,
          data: { details: { runId: id } },
        });
        bus.emit(ASYNC_COMPLETE_EVENT, { runId: id, success: true });
      });
    },
  );
  return {
    get count() {
      return count;
    },
    spawns,
  };
}

const TWO_PATH_VERDICT = [
  "status=reviewer_verdict",
  "next=read_comments_and_fix",
  "round=3",
  "brief_finding path=src/pay.ts line=10 sev=P1 title=overflow",
  "brief_finding path=src/fee.ts line=4 sev=P2 title=rounding",
].join("\n");

test("shared-tree: planFixLanes groups findings by path with disjoint sets", () => {
  const { paths } = prFixture(0);
  const lanes = orch.planFixLanes(paths as never, "99", 1, TWO_PATH_VERDICT, false);
  assert.equal(lanes.length, 2);
  const sets = lanes.map((lane) => lane.writeSet);
  assert.deepEqual(sets.sort(), [["src/fee.ts"], ["src/pay.ts"]]);
  assert.notEqual(lanes[0]!.handoff, lanes[1]!.handoff);
  for (const lane of lanes) {
    assert.match(lane.findingsText, /brief_finding/);
  }
});

test("shared-tree: planFixLanes packs many paths into at most 4 lanes", () => {
  const { paths } = prFixture(0);
  const verdict = [
    "status=reviewer_verdict",
    "next=read_comments_and_fix",
    ...Array.from({ length: 7 }, (_, i) => `brief_finding path=src/f${i}.ts sev=P2 title=x${i}`),
  ].join("\n");
  const lanes = orch.planFixLanes(paths as never, "99", 1, verdict, false);
  assert.ok(lanes.length <= 4, `7 paths must pack into at most 4 lanes, got ${lanes.length}`);
  assert.deepEqual(lanes.flatMap((lane) => lane.writeSet).sort(), [
    "src/f0.ts",
    "src/f1.ts",
    "src/f2.ts",
    "src/f3.ts",
    "src/f4.ts",
    "src/f5.ts",
    "src/f6.ts",
  ]);
});

test("shared-tree: planFixLanes keeps conflicts and finding-free verdicts solo", () => {
  const { paths } = prFixture(0);
  const conflict = orch.planFixLanes(paths as never, "99", 1, "merge mess", true);
  assert.equal(conflict.length, 1);
  assert.deepEqual(conflict[0]!.writeSet, []);
  const empty = orch.planFixLanes(paths as never, "99", 1, "next=read_comments_and_fix\n", false);
  assert.equal(empty.length, 1);
});

test("shared-tree: malformed finding paths are routed to the unscoped lane", () => {
  const { paths } = prFixture(0);
  const verdict = [
    "next=read_comments_and_fix",
    "brief_finding path=../../other.ts sev=P1 title=escape",
    "brief_finding path=src/owned.ts sev=P1 title=valid",
  ].join("\n");
  const lanes = orch.planFixLanes(paths as never, "99", 1, verdict, false);
  const unscoped = lanes.find((lane) => lane.key === "unscoped");
  assert.ok(unscoped, "invalid reviewer paths must not create a scoped lane");
  assert.deepEqual(unscoped!.writeSet, []);
  assert.match(unscoped!.findingsText, /path=\.\.\/\.\.\/other\.ts/);
  assert.deepEqual(lanes.filter((lane) => lane.writeSet.length).flatMap((lane) => lane.writeSet), ["src/owned.ts"]);
});

test("shared-tree: wave F11 blocks dirt outside the wave scope", () => {
  const tasks = [
    { id: "1", title: "a", status: "pending" },
    { id: "2", title: "b", status: "pending" },
  ] as never;
  const dirtyOutside = orch.firstWaveTaskBlockedByDirtyTree(
    tasks,
    " M src/a.ts\n M src/b.ts\n M sibling.ts",
    ["src/a.ts", "src/b.ts"],
  );
  assert.match(dirtyOutside ?? "", /sibling\.ts/);
  assert.equal(
    orch.firstWaveTaskBlockedByDirtyTree(tasks, " M src/a.ts\n M src/b.ts", ["src/a.ts", "src/b.ts"]),
    undefined,
  );
  const source = readFileSync(ORCH_SRC, "utf8");
  const start = source.indexOf("async function runTaskBatch");
  const end = source.indexOf("\nasync function runChainTaskOnce", start);
  assert.match(source.slice(start, end), /firstWaveTaskBlockedByDirtyTree/);
});

test("shared-tree: wave dirt backstop blocks a Task before resume can reach QA", () => {
  const source = readFileSync(ORCH_SRC, "utf8");
  const start = source.indexOf("async function runTaskBatch");
  const end = source.indexOf("\nasync function runChainTaskOnce", start);
  const batch = source.slice(start, end);
  const settled = batch.indexOf("const results = await Promise.all");
  assert.ok(settled >= 0, "the wave must settle all lanes together");
  const backstop = batch.slice(settled);
  const afterWave = backstop.indexOf("const afterWave = await porcelainStatus");
  assert.ok(afterWave >= 0, "the wave must inspect dirt after all lanes settle");
  assert.match(backstop, /unassigned paths remain dirty after the Task wave/);
  const blocked = backstop.indexOf('setTaskStatusInPlan(freshPlan, blockedItem.task.id, "blocked")');
  assert.ok(blocked > afterWave, "out-of-union dirt must block a held in-progress Task");
  const done = backstop.indexOf('setTaskStatusInPlan(nextPlan, item.task.id, "done")');
  assert.ok(done > afterWave, "wave Tasks may be marked done only after the dirt backstop passes");
  assert.ok(backstop.indexOf("return false") > blocked, "the dirt failure must stop resume");
  const once = source.slice(
    source.indexOf("async function runChainTaskOnce"),
    source.indexOf("\nasync function runFeatureChain"),
  );
  const held = once.indexOf("if (wave) {");
  const taskDone = once.indexOf('setTaskStatusInPlan(freshPlan, task.id, "done")');
  assert.ok(held >= 0 && held < taskDone, "wave settlement must hold done until runTaskBatch validates the union");
  const chain = source.slice(source.indexOf("async function runFeatureChain"));
  const blockedGuard = chain.indexOf('t.status === "blocked"');
  const qa = chain.indexOf("needsFeatureQa(status)");
  assert.ok(blockedGuard >= 0 && blockedGuard < qa, "resume checks blocked Tasks before QA");
});

test("shared-tree: a successful paused wave lane is done before the paused return", () => {
  const source = readFileSync(ORCH_SRC, "utf8");
  const batchStart = source.indexOf("async function runTaskBatch");
  const batchEnd = source.indexOf("\nasync function runChainTaskOnce", batchStart);
  const batch = source.slice(batchStart, batchEnd);
  const planDone = batch.indexOf('setTaskStatusInPlan(nextPlan, item.task.id, "done")');
  const pausedResult = batch.indexOf('result === "paused"');
  const pausedPhase = batch.indexOf('phase: "paused"', pausedResult);
  assert.ok(planDone >= 0 && pausedResult >= 0 && planDone < pausedPhase,
    "a paused successful lane must be recorded done before the wave returns paused");
  assert.ok(batch.slice(pausedPhase).includes('nextAction: "/orchestrate resume"'));

  const onceStart = source.indexOf("async function runChainTaskOnce");
  const onceEnd = source.indexOf("\nasync function runFeatureChain", onceStart);
  const once = source.slice(onceStart, onceEnd);
  assert.match(once, /return wave \? "paused" : false/,
    "wave pause must be distinct from a failed boolean result");
  const chain = source.slice(source.indexOf("async function runFeatureChain"));
  assert.ok(chain.indexOf('t.status === "blocked"') >= 0,
    "resume must retain the blocked-task guard for genuine failures");
});

test("shared-tree: selectTaskBatch takes disjoint scoped Tasks, skips the rest", () => {
  const plan = [
    "# Feature: t",
    "",
    "### Task 1 — a",
    "- Status: pending",
    "- Files: src/a.ts",
    "",
    "### Task 2 — b",
    "- Status: pending",
    "- Files: src/b.ts",
    "",
    "### Task 3 — overlap",
    "- Status: pending",
    "- Files: src/a.ts",
    "",
    "### Task 4 — unscoped",
    "- Status: pending",
    "",
    "### Task 5 — done",
    "- Status: done",
    "- Files: src/c.ts",
    "",
  ].join("\n");
  const tasks = [
    { id: "1", title: "a", status: "pending" },
    { id: "2", title: "b", status: "pending" },
    { id: "3", title: "overlap", status: "pending" },
    { id: "4", title: "unscoped", status: "pending" },
    { id: "5", title: "done", status: "done" },
  ];
  const batch = orch.selectTaskBatch(plan, tasks, []);
  assert.ok(batch, "two disjoint scoped Tasks must batch");
  assert.deepEqual(batch!.map((item) => item.task.id), ["1", "2"]);
});

test("shared-tree: selectTaskBatch returns null below two qualifiers", () => {
  const plan = "### Task 1 — a\n- Status: pending\n- Files: src/a.ts\n";
  const tasks = [{ id: "1", title: "a", status: "pending" }];
  assert.equal(orch.selectTaskBatch(plan, tasks, []), null);
});

test("shared-tree: serial admitted-solo keeps the F11 dirty-tree guard", () => {
  const source = readFileSync(ORCH_SRC, "utf8");
  const once = source.slice(
    source.indexOf("async function runChainTaskOnce"),
    source.indexOf("\nasync function runFeatureChain"),
  );
  assert.match(once, /const wave = opts\.batch\?\.wave === true/);
  assert.match(
    once,
    /const dirtyFirst = wave\s*\?\s*undefined\s*:\s*firstTaskBlockedByDirtyTree/,
    "only a genuine wave may skip the pre-existing dirty-tree stop",
  );
  const serial = source.slice(source.indexOf("const serialWriteSet"));
  assert.match(serial, /provisionalId: serialProvisionalId, wave: false/);
});

test("shared-tree: an empty admission blocks instead of reporting a successful wave", () => {
  const source = readFileSync(ORCH_SRC, "utf8");
  const start = source.indexOf("async function runTaskBatch");
  const end = source.indexOf("\nasync function runChainTaskOnce", start);
  const batch = source.slice(start, end);
  const empty = batch.indexOf("if (admitted.length === 0)");
  const spawn = batch.indexOf("Promise.all", empty);
  assert.ok(empty >= 0, "runTaskBatch must handle no authoritative admissions");
  assert.ok(spawn > empty, "the empty-admission branch must precede spawning");
  assert.match(batch.slice(empty, spawn), /phase: "blocked"/);
  assert.match(batch.slice(empty, spawn), /return false/);
});

test("shared-tree: swapped slot survives sweep before its snapshot appears", () => {
  const { paths } = prFixture(0);
  const provisionalId = "writer-pending";
  const runId = `writer-no-snapshot-${process.pid}-${Date.now()}`;
  updateWriterSlots(paths.handoffsDir, () => true, () => ({
    slots: [{
      runId: provisionalId,
      runDir: "",
      agent: "fixer",
      writeSet: ["src/a.ts"],
      claimedAt: Date.now(),
    }],
    result: undefined,
  }));
  orch.swapWriterSlot(paths as never, provisionalId, runId);
  assert.deepEqual(readWriterSlots(paths.handoffsDir).map((slot) => slot.runId), [runId]);
  const swept = sweepWriterSlots(paths.handoffsDir, orch.writerSlotIsLive);
  assert.deepEqual(swept.slots.map((slot) => slot.runId), [runId]);
  assert.equal(swept.swept, false, "a newly swapped slot must not be swept before status.json appears");
});

test("shared-tree: task settlement releases both provisional and settled slot ids", () => {
  const source = readFileSync(ORCH_SRC, "utf8");
  const start = source.indexOf("async function runChainTaskOnce");
  const end = source.indexOf("\nasync function runFeatureChain", start);
  const once = source.slice(start, end);
  const cleanup = once.slice(once.lastIndexOf("} finally"));
  assert.match(cleanup, /opts\.batch\.provisionalId/);
  assert.match(cleanup, /settledId/);
  assert.match(cleanup, /for \(const runId of releaseIds\)/);
});

test("shared-tree: updatePlanFile keeps concurrent Task settlements", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-planrace-"));
  const paths = featurePaths(dir);
  writeFileSync(
    paths.planFile,
    "### Task 1 — a\n- Status: pending\n\n### Task 2 — b\n- Status: pending\n",
  );
  await Promise.all([
    orch.updatePlanFile(paths as never, (plan: string) =>
      (orch as never as { setTaskStatusInPlan: Function }).setTaskStatusInPlan(plan, "1", "done"),
    ),
    orch.updatePlanFile(paths as never, (plan: string) =>
      (orch as never as { setTaskStatusInPlan: Function }).setTaskStatusInPlan(plan, "2", "done"),
    ),
  ]);
  const text = readFileSync(paths.planFile, "utf8");
  assert.match(text, /Task 1[\s\S]*- Status: done/);
  assert.match(text, /Task 2[\s\S]*- Status: done/);
});

test("shared-tree: live writer sweep awaits a queued sidecar transaction", async () => {
  const { dir, paths } = prFixture(0);
  const ready = join(dir, "writer-lock-ready");
  const holder = withWriterLockAsync(paths.handoffsDir, async () => {
    writeFileSync(ready, "held");
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(existsSync(ready), true, "the async sidecar holder must acquire first");
  const pi = makeFakePi();
  const ctx = { ui: { notify: () => {} }, isIdle: () => true } as never;
  const dispatch = (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
    pi,
    ctx,
    paths,
    "99",
    dir,
    { next: "yield", output: "" },
  );
  await assert.doesNotReject(async () => dispatch);
  await holder;
});

test("shared-tree: updatePlanFile serializes contending processes under the sidecar lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-plan-cross-process-"));
  const ready = join(dir, "ready");
  writeFileSync(
    join(dir, "plan.md"),
    "### Task 1 — a\n- Status: pending\n\n### Task 2 — b\n- Status: pending\n",
  );
  const source = pathToFileURL(ORCH_SRC).href;
  const script = `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { withWriterLockAsync } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/lib/write-sets.ts")).href)};
    import { updatePlanFile } from ${JSON.stringify(source)};
    const [dir, id, ready] = process.argv.slice(1);
    const paths = { planFile: join(dir, 'plan.md'), handoffsDir: dir };
    const mutate = (plan) => {
      if (id === '1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      return plan.replace(new RegExp('(### Task ' + id + '[^\\\\n]*\\\\n- Status: )pending'), '$1done');
    };
    if (id === '1') {
      await withWriterLockAsync(dir, async () => {
        writeFileSync(ready, 'held');
        await updatePlanFile(paths, mutate);
      });
    } else {
      await updatePlanFile(paths, mutate);
    }
  `;
  const first = orchestrateChild(script, [dir, "1", ready]);
  for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(ready), true, "the first process must hold the sidecar lock");
  const second = orchestrateChild(script, [dir, "2", ""]);
  await Promise.all([first, second]);
  const text = readFileSync(join(dir, "plan.md"), "utf8");
  assert.match(text, /Task 1[\s\S]*- Status: done/);
  assert.match(text, /Task 2[\s\S]*- Status: done/);
});

test("shared-tree: terminal snapshot does not release an unreleased writer slot", () => {
  const { paths } = prFixture(0);
  const runDir = mkdtempSync(join(tmpdir(), "orch-terminal-writer-"));
  writeFileSync(
    join(runDir, "status.json"),
    JSON.stringify({
      state: "complete",
      startedAt: Date.now(),
      endedAt: Date.now(),
      pid: process.pid,
      steps: [{ status: "complete" }],
    }),
  );
  updateWriterSlots(paths.handoffsDir, () => true, () => ({
    slots: [{
      runId: "writer-terminal",
      runDir,
      agent: "fixer",
      writeSet: ["src/a.ts"],
      claimedAt: Date.now(),
    }],
    result: undefined,
  }));
  const swept = sweepWriterSlots(paths.handoffsDir, orch.writerSlotIsLive);
  assert.deepEqual(swept.slots.map((slot) => slot.runId), ["writer-terminal"]);
  assert.equal(swept.swept, false, "only explicit release may free a terminal writer slot");
});

test("shared-tree: throwing fixer spawn or gate returns failure and releases its slot", async () => {
  const { dir, paths } = prFixture(0);
  const pi = makeFakePi();
  const ctx = { ui: { notify: () => {} }, isIdle: () => true } as never;
  const lane = {
    key: "src/pay.ts",
    writeSet: ["src/pay.ts"],
    findingsText: "brief_finding path=src/pay.ts sev=P1 title=overflow",
    handoff: join(paths.handoffsDir, "lane.md"),
  };
  const cases = [
    {
      label: "spawn",
      runChildInPhase: async () => { throw new Error("test spawn failure"); },
      ensureWriterCommit: async () => { throw new Error("test gate failure"); },
      reason: "test spawn failure",
    },
    {
      label: "gate",
      runChildInPhase: async () => ({ ok: true as const }),
      ensureWriterCommit: async () => { throw new Error("test gate failure"); },
      reason: "test gate failure",
    },
  ];
  for (const [index, failure] of cases.entries()) {
    const provisionalId = `lane-${failure.label}-pending`;
    updateWriterSlots(paths.handoffsDir, () => true, () => ({
      slots: [{
        runId: provisionalId,
        runDir: "",
        agent: "fixer",
        writeSet: lane.writeSet,
        claimedAt: Date.now(),
      }],
      result: undefined,
    }));
    let settled: Awaited<ReturnType<typeof orch.runFixLane>> | undefined;
    await assert.doesNotReject(async () => {
      settled = await orch.runFixLane(
        pi as never,
        ctx,
        paths as never,
        "99",
        dir,
        { next: "read_comments_and_fix", output: lane.findingsText, round: "3" },
        index + 1,
        lane,
        provisionalId,
        failure,
      );
    });
    assert.ok(settled, `${failure.label} lane must return a result`);
    assert.equal(settled.outcome.ok, false, `${failure.label} failure must be recorded as failed`);
    assert.match(settled.outcome.reason ?? "", new RegExp(failure.reason));
    assert.deepEqual(readWriterSlots(paths.handoffsDir), [], `${failure.label} failure must release its slot`);
  }
});

test("shared-tree: one verdict with two paths dispatches two fixers, one pr-await", async () => {
  const { dir, paths } = prFixture(0);
  const execs: string[] = [];
  const pi = makeFakePi(async (cmd, args) => {
    execs.push([cmd, ...(args ?? [])].join(" "));
    return { code: 0, stdout: "", stderr: "" };
  });
  const seen = autoSettleAllSpawns(pi);
  const ctx = { ui: { notify: () => {} }, isIdle: () => true } as never;
  const action = await (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
    pi,
    ctx,
    paths,
    "99",
    dir,
    { done: false, next: "read_comments_and_fix", output: TWO_PATH_VERDICT, round: "3" },
  );
  assert.equal(action, "spawn_writer");
  assert.equal(seen.count, 2, "two disjoint finding-paths must dispatch two fixers");
  const sets = seen.spawns.map((params: Record<string, unknown>) => params.writeSet ?? []);
  assert.deepEqual(sets.sort(), [["src/fee.ts"], ["src/pay.ts"]]);
  assert.equal(
    execs.filter((e) => e.startsWith("git pr-await")).length,
    1,
    "the round still ends with exactly one code-run pr-await",
  );
  assert.match(readFileSync(paths.statusFile, "utf8"), /^worker_run_id: none$/m);
});
