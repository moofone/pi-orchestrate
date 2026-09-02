/**
 * Feature-PR policy table tests for lib/feature-pr.ts.
 *
 * Run: node --experimental-strip-types --test test/feature-pr.test.ts
 *
 * The pure verdict→action classifier and the fixer-settle table are extracted
 * verbatim from orchestrate.ts; these tests pin the moved bodies at their new
 * import path (`../src/lib/feature-pr.ts`). Behavior contracts stay owned by
 * test/orchestrate.test.ts (D1 classify, P2 F5 settle) — the dispatch and
 * latch paths remain there because they need the extension API.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyFeaturePrNext, fixerSettleAction } from "../src/lib/feature-pr.ts";

test("feature-pr: classifyFeaturePrNext routes judgments and rejects a second writer", () => {
  // Current-head findings are fixed by a writer, not by the parent session.
  assert.equal(classifyFeaturePrNext("read_comments_and_fix", { prRound: 0 }), "spawn_writer");

  // Quiet verdicts stay idle even when a chain lock is held: the model is
  // never supposed to see `next=yield`, so it must not become refuse or notify.
  for (const quiet of ["yield", "poll_again", ""]) {
    assert.equal(
      classifyFeaturePrNext(quiet, { chainLocked: true }),
      "idle",
      `next=${quiet || "(none)"} must stay at 0 tokens even with a held lock`,
    );
  }

  // Past the cap code stops arguing and says so on the PR.
  assert.equal(classifyFeaturePrNext("read_comments_and_fix", { prRound: 99 }), "disagree");

  // One writer per Feature: a live worker refuses a second fixer.
  assert.equal(classifyFeaturePrNext("read_comments_and_fix", { workerLive: true }), "refuse");
});

test("feature-pr: fixerSettleAction treats a stop as pause and an unknown head as not inaction", () => {
  // A stop is the user's decision; the branch does not overrule it.
  assert.equal(
    fixerSettleAction({ ok: true, stopped: true, handoffWritten: true, push: "pushed" }),
    "pause",
    "stop overrides branch evidence",
  );

  // `push` absent falls back to the child's report: ok with no handoff means
  // the work landed and the loop may continue.
  assert.equal(fixerSettleAction({ ok: true, handoffWritten: false }), "await");

  // `unknown` means git could not answer — never evidence of inaction, so an
  // ok round with an unreadable head is still an await.
  assert.equal(
    fixerSettleAction({ ok: true, handoffWritten: true, push: "unknown" }),
    "await",
    "an unknown head must not invent a verdict",
  );
});
