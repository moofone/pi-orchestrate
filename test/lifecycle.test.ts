/**
 * Lifecycle gate tests for lib/lifecycle.ts.
 *
 * Run: node --experimental-strip-types --test test/lifecycle.test.ts
 *
 * The plan-reviewer / QA-pass gates are extracted verbatim from
 * orchestrate.ts; these tests pin the moved bodies at their new import
 * path (`../src/lib/lifecycle.ts`). Behavior contracts stay owned by
 * test/orchestrate.test.ts (gate, T3 clamp, P3 F12/F14).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  approveBlockedByPlanReview,
  clampedQaPassCap,
  needsPlanReview,
  writerBlockedByPlanReview,
} from "../src/lib/lifecycle.ts";

test("lifecycle: needsPlanReview is true until plan-reviewer is done and false once a Task has started", () => {
  const plan = "### Task 1 — one\n- Status: pending\n";
  assert.equal(
    needsPlanReview(plan, "phase: planning\nplan_review: none\n"),
    true,
    "plan-reviewer has not run: implementation must not start",
  );
  assert.equal(
    needsPlanReview(plan, "phase: planning\nplan_review: done\n"),
    false,
    "a done review already cleared the gate",
  );
  assert.equal(
    needsPlanReview("### Task 1 — one\n- Status: in_progress\n", "plan_review: none\n"),
    false,
    "a Task in flight means the gate already passed",
  );
});

test("lifecycle: approveBlockedByPlanReview refuses running/failed/none and allows done", () => {
  for (const state of ["running", "in_progress", "failed", "none"]) {
    assert.equal(
      typeof approveBlockedByPlanReview(`plan_review: ${state}\n`),
      "string",
      `plan_review: ${state} must refuse approve`,
    );
  }
  assert.equal(
    approveBlockedByPlanReview("plan_review: done\n"),
    undefined,
    "plan_review: done lets approve through",
  );
});

test("lifecycle: writerBlockedByPlanReview refuses only running and clampedQaPassCap lives here", () => {
  for (const state of ["running", "in_progress"]) {
    assert.equal(
      typeof writerBlockedByPlanReview(`plan_review: ${state}\n`),
      "string",
      `plan_review: ${state} must block a writer spawn`,
    );
  }
  for (const state of ["none", "done", "failed"]) {
    assert.equal(
      writerBlockedByPlanReview(`plan_review: ${state}\n`),
      undefined,
      `plan_review: ${state} must not block a writer spawn`,
    );
  }
  assert.equal(clampedQaPassCap(9), 2, "MAX_QA_PASS_CAP still bounds it");
  assert.equal(clampedQaPassCap(0), 0, "an explicit 0 opts out of QA entirely");
  assert.equal(clampedQaPassCap(Number.NaN), 2, "garbage falls back to the default cap");
});
