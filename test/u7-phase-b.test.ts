import assert from "node:assert/strict";
import { test } from "node:test";
import { structuredInterpretationValue } from "../src/lib/execution-interpreter.ts";
import { classifyForRole, executionWriterReservation } from "../src/lib/git-workflow-guard.ts";

test("U7 interpreter accepts the exact structured-only single-run envelope", () => {
  const value = structuredInterpretationValue({
    runId: "run-1",
    sessionId: "session-1",
    success: true,
    state: "complete",
    results: [{ runId: "run-1", status: "complete", structuredOutput: { manifest: { id: "m" }, unresolvedDecisions: [] } }],
  }, "run-1");
  assert.deepEqual(value, { manifest: { id: "m" }, unresolvedDecisions: [] });
  assert.equal(structuredInterpretationValue({ runId: "other", results: [{ runId: "other", structuredOutput: { manifest: {} } }] }, "run-1"), undefined);
});

test("configured execution workers are recognized by a durable reservation, not agent name", () => {
  const reservation = executionWriterReservation({
    cwd: "/wt/worker",
    reservations: [{ attemptId: "a1", workspacePath: "/wt/worker", workspaceId: "w1", slots: 1 }],
    attemptId: "a1",
  });
  assert.equal(reservation?.role, "worker");
  assert.equal(classifyForRole("git push", { writer: false, executionRole: reservation?.role }).block, true);
  assert.equal(classifyForRole("git commit -m x", { writer: false, executionRole: reservation?.role }).block, false);
  assert.equal(classifyForRole("git commit -m x", { writer: false, executionRole: "parent", writerReserved: true }).block, true);
});
