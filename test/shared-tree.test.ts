/**
 * Shared-tree writer tests: disjoint write-sets let fixers and tdd-workers
 * share one worktree (up to 4 fixers, up to 8 workers).
 *
 * Run: node --experimental-strip-types --test test/shared-tree.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as orch from "../src/orchestrate.ts";

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

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
  assert.ok(
    execs.some((e) => e.startsWith("git pr-await")),
    "the round still ends with exactly one code-run pr-await",
  );
  assert.match(readFileSync(paths.statusFile, "utf8"), /^worker_run_id: none$/m);
});
