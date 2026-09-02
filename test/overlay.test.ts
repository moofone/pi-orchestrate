/**
 * Overlay mapper tests for lib/overlay.ts.
 *
 * Run: node --experimental-strip-types --test test/overlay.test.ts
 *
 * The deterministic rpiv-todo mapper is extracted verbatim from
 * orchestrate.ts; these tests pin the moved body at its new import path
 * (`../src/lib/overlay.ts`). Behavior contracts stay owned by
 * test/orchestrate.test.ts (overlay region) — the sink binding remains
 * there because it needs the extension API.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { overlayTodosFromFeature } from "../src/lib/overlay.ts";

test("overlay: Task N keeps plan id and blocked maps to pending", () => {
  const plan = [
    "### Task 1 — one",
    "- Status: done",
    "### Task 2 — two",
    "- Status: blocked",
    "### Task 3 — three",
    "- Status: pending",
  ].join("\n");
  const todos = overlayTodosFromFeature(
    plan,
    ["phase: implementing", "plan_review: done", "qa_pass_cap: 0"].join("\n"),
  );
  assert.deepEqual(
    todos.map((t) => [t.id, t.subject, t.status, t.metadata?.kind]),
    [
      [1001, "Planner", "completed", "planner"],
      [1002, "Plan reviewer", "completed", "plan-reviewer"],
      [1003, "Approve", "completed", "approve"],
      [1, "Task 1 — one", "completed", "task"],
      [2, "Task 2 — two", "pending", "task"],
      [3, "Task 3 — three", "pending", "task"],
    ],
  );
  assert.deepEqual(todos[1]?.blockedBy, [1001], "reviewer waits on the planner");
  assert.deepEqual(todos[2]?.blockedBy, [1002], "Approve waits on the reviewer");
  assert.deepEqual(todos[3]?.blockedBy, [1003], "Task 1 waits on Approve");
  assert.deepEqual(todos[4]?.blockedBy, [1], "Task N waits on Task N-1");
});

test("overlay: plan-reviewer in_progress never shares the board with a Task", () => {
  const plan = [
    "# Feature: compact",
    "> Name: pearl-compact-share-wire",
    "### Task 1 — Compact codec",
    "- Status: pending",
  ].join("\n");
  const todos = overlayTodosFromFeature(
    plan,
    ["phase: reviewing", "plan_review: running", "qa_pass_cap: 1"].join("\n"),
  );
  assert.deepEqual(
    todos.map((t) => [t.metadata?.kind, t.status]),
    [
      ["planner", "completed"],
      ["plan-reviewer", "in_progress"],
      ["approve", "pending"],
    ],
  );
  assert.equal(
    todos.find((t) => t.metadata?.kind === "plan-reviewer")?.activeForm,
    "reviewing Feature plan",
  );
  assert.equal(
    todos.filter((t) => t.status === "in_progress").length,
    1,
    "exactly one in_progress while reviewing: writers are blocked, Tasks stay pending",
  );
});
