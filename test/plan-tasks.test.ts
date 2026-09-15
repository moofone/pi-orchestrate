/**
 * Plan/Task parsers, extracted from orchestrate.ts into `src/lib/plan-tasks.ts`.
 *
 * These pin the two seams the extraction must not change: `### Task N:` colon
 * headings are real Tasks while a numbered list under `## Tasks` is not, and a
 * Task's `- Command:` is a gate only when it is entirely one fenced span —
 * prose (including the literal `pending`) never reaches the host shell.
 *
 * Run: node --experimental-strip-types --test test/plan-tasks.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findTaskFileOverlaps,
  isApproved,
  parseTasks,
  taskGateCommand,
  taskPlanMetrics,
} from "../src/lib/plan-tasks.ts";

test("plan-tasks: colon headings parse and a numbered list under ## Tasks is rejected", () => {
  const colonPlan = [
    "# Feature: Listing factory seams",
    "",
    "## Tasks",
    "",
    "### Task 1: Required manifest rule_set",
    "",
    "- Status: pending",
    "- Complexity: simple",
    "",
    "### Task 2: Package-sourced definitions",
    "",
    "- Status: pending",
    "- Complexity: simple",
    "",
    "## Design Decisions",
    "| Decision | Choice | Rationale |",
    "",
  ].join("\n");

  const tasks = parseTasks(colonPlan);
  assert.equal(
    tasks.length,
    2,
    "### Task N: title is a real Task heading; approve must not report No Tasks found",
  );
  assert.equal(tasks[0]?.id, "1");
  assert.equal(tasks[0]?.title, "Required manifest rule_set");
  assert.equal(tasks[0]?.status, "pending");
  assert.equal(tasks[0]?.complexity, "simple");
  assert.equal(tasks[1]?.id, "2");
  assert.equal(tasks[1]?.title, "Package-sourced definitions");

  const numberedList = [
    "## Tasks",
    "1. Required manifest rule_set",
    "2. Package-sourced definitions",
  ].join("\n");
  assert.deepEqual(
    parseTasks(numberedList),
    [],
    "a numbered list is not a Task heading; only `### Task N` counts",
  );
});

test("plan-tasks: taskGateCommand refuses prose including pending", () => {
  assert.equal(
    taskGateCommand("- Command: `rtk cargo test -p crate --lib the_test`"),
    "rtk cargo test -p crate --lib the_test",
    "one fenced span is the host gate",
  );
  assert.equal(
    taskGateCommand("- Command: pending"),
    "",
    "the pending token is not a command",
  );
  assert.equal(
    taskGateCommand("- Command: Run the suite, then check the output"),
    "",
    "an unfenced sentence is never a command",
  );
  assert.equal(
    taskGateCommand("- Command: `a` and `b`"),
    "",
    "two fenced spans are prose, not one command",
  );
});

test("plan-tasks: isApproved only matches Status that begins with approved", () => {
  assert.equal(
    isApproved("> Status: APPROVED"),
    true,
    "bare APPROVED is approved",
  );
  assert.equal(
    isApproved("> Status: APPROVED — extra reviewer note"),
    true,
    "APPROVED with a suffix stays approved",
  );
  assert.equal(
    isApproved("> Status: DRAFT — feature not approved"),
    false,
    "mid-line approved must not count as approved",
  );
  assert.equal(
    isApproved("> Status: not approved"),
    false,
    "a Status that merely contains approved is not approved",
  );
});

const FANOUT_PLAN = [
  "# Feature: Fanout sizing",
  "",
  "### Task 1 — Parser seam",
  "",
  "- Status: pending",
  "- Complexity: simple",
  "- Read: [`src/a.ts::parse`, `test/a.test.ts::basic`]",
  '- Files: ["src/a.ts", "test/a.test.ts"]',
  "- Depends on: []",
  "- Implement: move the parser",
  "",
  "### Task 2 — Overlay seam",
  "",
  "- Status: pending",
  "- Complexity: simple",
  "- Read: [`src/b.ts::render`]",
  '- Files: ["src/b.ts", "src/a.ts"]',
  '- Depends on: ["1"]',
  "- Implement: move the overlay",
  "",
  "### Task 3 — Docs only",
  "",
  "- Status: pending",
  "- Complexity: simple",
  "- Read: [`README.md`]",
  '- Files: ["README.md"]',
  "- Depends on: []",
  "- Implement: note the seams",
  "",
  "## Design Decisions",
  "| Decision | Choice | Rationale |",
  "",
].join("\n");

test("plan-tasks: taskPlanMetrics sizes contracts and reads Files/Depends on", () => {
  const metrics = taskPlanMetrics(FANOUT_PLAN);
  assert.equal(metrics.length, 3, "one row per Task");
  assert.deepEqual(metrics[0]?.files, ["src/a.ts", "test/a.test.ts"]);
  assert.deepEqual(metrics[0]?.dependsOn, []);
  assert.equal(metrics[0]?.readSymbols, 2, "two backtick spans in Read");
  assert.equal(metrics[1]?.readSymbols, 1);
  assert.ok((metrics[0]?.sectionLines ?? 0) > 5, "contract lines are counted");
});

test("plan-tasks: findTaskFileOverlaps reports pairs and declared edges", () => {
  const overlaps = findTaskFileOverlaps(FANOUT_PLAN);
  assert.equal(overlaps.length, 1, "only Tasks 1+2 share a file");
  assert.deepEqual(overlaps[0], {
    a: "1",
    b: "2",
    files: ["src/a.ts"],
    declared: true,
  });
});

test("plan-tasks: undeclared overlap is flagged and prose Files reads as []", () => {
  const plan = FANOUT_PLAN.replace('- Depends on: ["1"]', "- Depends on: []");
  const overlaps = findTaskFileOverlaps(plan);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0]?.declared, false, "missing edge is visible to the reviewer");
  const prose = FANOUT_PLAN.replace(
    '- Files: ["README.md"]',
    "- Files: the docs and whatever else looks relevant",
  );
  assert.deepEqual(
    taskPlanMetrics(prose)[2]?.files,
    [],
    "prose Files never counts as a scope",
  );
});
