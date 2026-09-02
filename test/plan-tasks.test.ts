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

import { parseTasks, taskGateCommand } from "../src/lib/plan-tasks.ts";

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
