/**
 * Task writer lanes and the plan architect (live-runtime port of #29).
 *
 * A plan Task names its writer with `- Lane:`; code routes by it instead of
 * sending every Task to tdd-worker. A Lane that contradicts the Task's Files
 * is corrected. Rust Features are planned by rust-architect.
 *
 * Run: node --experimental-strip-types --test test/task-lanes.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as orch from "../src/orchestrate.ts";
import { isWriterRole } from "../src/lib/git-workflow-guard.ts";

function paths() {
  return {
    repo: "icemining",
    gitRoot: "/Users/greg/Dev/git/icemining",
    repoDir: "/Users/greg/orchestrator/icemining",
    featureDir: "/tmp/orch-lanes",
    planFile: "/tmp/orch-lanes/plan.md",
    statusFile: "/tmp/orch-lanes/status.md",
    handoffsDir: "/tmp/orch-lanes/handoffs",
    archiveDir: "/tmp/orch-lanes/archive",
  };
}

function task(lane: string | undefined, files: string[] | undefined): string {
  return [
    "### Task 1 — t",
    "- Status: pending",
    "- Complexity: simple",
    ...(lane === undefined ? [] : [`- Lane: ${lane}`]),
    ...(files === undefined ? [] : [`- Files: ${JSON.stringify(files)}`]),
    "- Implement: do it",
  ].join("\n");
}

function launch(body: string): Record<string, unknown> {
  return orch.workerLaunchParams(
    paths() as never,
    { id: "1", title: "t", status: "pending", complexity: "simple" } as never,
    "/tmp/wt",
    `# Feature: t\n\n${body}\n`,
  );
}

test("taskLane: a declared Lane that fits its Files is used as-is", () => {
  assert.equal(orch.taskLane(task("rust-tdd-worker", ["crates/a/src/lib.rs"])), "rust-tdd-worker");
  assert.equal(orch.taskLane(task("rust-worker", ["Cargo.toml", "crates/a/Cargo.toml"])), "rust-worker");
  assert.equal(orch.taskLane(task("dev-worker", ["docs/a.md"])), "dev-worker");
  assert.equal(orch.taskLane(task("tdd-worker", ["src/a.ts"])), "tdd-worker");
  assert.equal(orch.taskLane(task("cuda-dev", ["kernels/a.cu", "kernels/a.cuh"])), "cuda-dev");
  assert.equal(orch.taskLane(task("`rust-worker`", ["src/a.rs"])), "rust-worker", "backtick-fenced Lane");
});

test("taskLane: a Lane contradicting single-language Files is corrected, keeping TDD vs non-TDD", () => {
  assert.equal(orch.taskLane(task("rust-tdd-worker", ["web/packed-history.ts"])), "tdd-worker", "TS Task on a Rust lane");
  assert.equal(orch.taskLane(task("rust-worker", ["web/a.ts"])), "dev-worker");
  assert.equal(orch.taskLane(task("tdd-worker", ["src/a.rs"])), "rust-tdd-worker");
  assert.equal(orch.taskLane(task("dev-worker", ["src/a.rs"])), "rust-worker");
  assert.equal(orch.taskLane(task("tdd-worker", ["k/a.cu"])), "cuda-dev");
});

test("taskLane: no or unknown Lane is inferred from Files; nothing declared keeps tdd-worker", () => {
  assert.equal(orch.taskLane(task(undefined, ["src/a.rs", "tests/b.rs"])), "rust-tdd-worker");
  assert.equal(orch.taskLane(task("worker", ["src/a.rs"])), "rust-tdd-worker", "unknown Lane name");
  assert.equal(orch.taskLane(task(undefined, ["src/a.ts"])), "tdd-worker");
  assert.equal(orch.taskLane(task(undefined, undefined)), "tdd-worker");
  assert.equal(orch.taskLane(task("rust-tdd-worker", undefined)), "rust-tdd-worker", "no Files: trust the Lane");
  assert.equal(orch.taskLane(task("rust-worker", ["../escape.rs"])), "rust-worker", "invalid Files: trust the Lane");
});

test("taskLane: mixed-language Files trust the declared Lane", () => {
  assert.equal(orch.taskLane(task("rust-worker", ["src/a.rs", "web/a.ts"])), "rust-worker");
  assert.equal(orch.taskLane(task(undefined, ["src/a.rs", "web/a.ts"])), "tdd-worker");
});

test("workerLaunchParams routes by Lane; only tdd-worker is model-pinned", () => {
  const rust = launch(task("rust-tdd-worker", ["crates/a/src/lib.rs"]));
  assert.equal(rust.agent, "rust-tdd-worker");
  assert.equal(rust.model, undefined, "non-tdd lanes run on their own agent settings");
  assert.match(String((rust.acceptance as { reason?: string }).reason), /^rust-tdd-worker implements/);

  const ts = launch(task(undefined, ["src/a.ts"]));
  assert.equal(ts.agent, "tdd-worker");
  assert.equal(typeof ts.model, "string", "tdd-worker keeps its pinned model");
});

test("applySpawnPolicy: lane writers get writer caps but no model pin", () => {
  const params: Record<string, unknown> = { agent: "rust-worker", task: "x", timeoutMs: 999_999_999 };
  const policy = orch.applySpawnPolicy(params);
  assert.notEqual(policy.action, "reject");
  assert.equal(params.model, undefined);
  assert.deepEqual(params.tools, [...orch.WRITER_TOOLS]);
  assert.equal((params.intercomBridge as { mode?: string } | undefined)?.mode, "off");
  assert.equal(params.context, "fresh");
  assert.ok((params.timeoutMs as number) < 999_999_999, "timeout clamped");

  assert.equal(orch.applySpawnPolicy({ agent: "dev-worker", model: "cursor/grok-4.7:medium" }).action, "reject");
  const over = { agent: "cuda-dev", concurrency: 99 };
  assert.equal(orch.applySpawnPolicy(over).action, "pin");
  assert.ok(over.concurrency < 99);
});

test("architectAgentFor: a Cargo repo is planned by rust-architect", () => {
  const rust = mkdtempSync(join(tmpdir(), "orch-arch-rust-"));
  writeFileSync(join(rust, "Cargo.toml"), "[workspace]\n");
  const ts = mkdtempSync(join(tmpdir(), "orch-arch-ts-"));
  writeFileSync(join(ts, "package.json"), "{}\n");
  assert.equal(orch.architectAgentFor(rust), "rust-architect");
  assert.equal(orch.architectAgentFor(ts), "planner");
  assert.equal(orch.architectAgentFor(""), "planner");
});

test("plannerLaunchParams: rust-architect launches unpinned with the lane rules", () => {
  const params = orch.plannerLaunchParams(paths() as never, "bound objective", "", "rust-architect");
  assert.equal(params.agent, "rust-architect");
  assert.equal(params.model, undefined);
  assert.equal(params.context, "fresh");
  assert.equal((params.turnBudget as { maxTurns: number }).maxTurns, 160);
  const body = String(params.task);
  assert.match(body, /^You are `rust-architect`/);
  assert.match(body, /Do not launch subagents/);
  assert.match(body, /bound objective/);
  assert.match(body, /- Lane:/);

  const planner = orch.plannerLaunchParams(paths() as never, "bound objective");
  assert.equal(planner.agent, "planner");
  assert.equal(typeof planner.model, "string", "planner keeps its pin");
  assert.match(String(planner.task), /- Lane: tdd-worker/);
});

test("git-workflow-guard: every Task lane is a writer; the architect is not", () => {
  for (const lane of orch.TASK_LANES) {
    assert.equal(isWriterRole({ PI_SUBAGENT_CHILD_AGENT: lane }), true, lane);
  }
  assert.equal(isWriterRole({ PI_SUBAGENT_CHILD_AGENT: "rust-architect" }), false);
});
