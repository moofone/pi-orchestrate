/**
 * Feature lifecycle gates, extracted verbatim from orchestrate.ts.
 *
 * The plan-reviewer seam decides who may act: no writer spawn while
 * plan-reviewer is live (`writerBlockedByPlanReview`), no approve until the
 * review is done (`approveBlockedByPlanReview`), no implementation at all
 * before both (`needsPlanReview`), and the QA pass counter that gates the
 * PR (`qaPassState` / `needsFeatureQa`). `planReviewReconcile` settles a
 * `plan_review: running` whose session may be gone (F14).
 *
 * Move discipline: bodies are byte-equal to their orchestrate originals.
 * The invariants live in test/orchestrate.test.ts (gate, T3 clamp,
 * P3 F12/F14) and test/lifecycle.test.ts; this module never imports
 * orchestrate.ts.
 */

import { statusField } from "./feature-state.ts";
import { parseTasks } from "./plan-tasks.ts";

/**
 * QA → fix → QA → fix → PR. Cap 1 meant the remediation Tasks QA itself asked
 * for were implemented and then never looked at again; the second pass is what
 * checks QA's own fixes (F12). `MAX_QA_PASS_CAP` is the ceiling.
 */
export const DEFAULT_QA_PASS_CAP = 2;

export const MAX_QA_PASS_CAP = 2;

export function clampedQaPassCap(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_QA_PASS_CAP;
  return Math.min(MAX_QA_PASS_CAP, Math.floor(raw));
}

export function qaPassState(status: string): { pass: number; cap: number } {
  const pass = Number.parseInt(statusField(status, "qa_pass") || "0", 10);
  const rawCap = Number.parseInt(
    statusField(status, "qa_pass_cap") || String(DEFAULT_QA_PASS_CAP),
    10,
  );
  return {
    pass: Number.isFinite(pass) && pass > 0 ? pass : 0,
    cap: clampedQaPassCap(Number.isFinite(rawCap) ? rawCap : DEFAULT_QA_PASS_CAP),
  };
}

export function needsFeatureQa(status: string): boolean {
  const { pass, cap } = qaPassState(status);
  return pass < cap;
}

export type PlanReviewState = "none" | "running" | "done" | "failed";

/** Durable plan-reviewer gate. Missing field on old status.md is `none`. */
export function planReviewState(status: string): PlanReviewState {
  const raw = statusField(status, "plan_review").toLowerCase();
  if (raw === "running" || raw === "in_progress") return "running";
  if (raw === "done" || raw === "complete" || raw === "completed") return "done";
  if (raw === "failed" || raw === "error") return "failed";
  return "none";
}

/**
 * True when implementation must not start yet: plan-reviewer has not finished,
 * and this Feature has not already passed that gate (a Task is in flight / done,
 * or the chain is already implementing).
 */
export function needsPlanReview(plan: string, status: string): boolean {
  if (planReviewState(status) === "done") return false;
  const tasks = parseTasks(plan);
  if (tasks.some((t) => t.status !== "pending")) return false;
  const phase = statusField(status, "phase").toLowerCase();
  if (phase === "implementing" || phase === "feature-qa" || phase === "pr") {
    return false;
  }
  return true;
}

/** Hard overlap guard: a writer must not spawn while plan-reviewer is live. */
export function writerBlockedByPlanReview(status: string): string | undefined {
  if (planReviewState(status) === "running") {
    return "plan-reviewer still running; refusing writer";
  }
  return undefined;
}

/** Approve hands the Feature to writers, so it waits for the review verdict. */
export function approveBlockedByPlanReview(status: string): string | undefined {
  if (planReviewState(status) === "done") return undefined;
  return "plan review not done; refusing approve";
}

export type PlanReviewReconcile = "keep" | "wait" | "done" | "failed";

/**
 * What to do with a `plan_review: running` whose session may be gone (F14).
 *
 * Tasks got orphan recovery; the reviewer did not, so a plan-reviewer that
 * died with its session left the field at `running` forever — and
 * `writerBlockedByPlanReview` then refused every approve and resume, while
 * `draftApproveCards` hid the card. The Feature could not be reached at all.
 *
 * No run artifact at all is `failed`, not `wait`: this is only consulted under
 * the chain lock, so a genuinely live review is one this process is running
 * and would have recorded. A missing record means nobody is home.
 *
 * The snapshot is read structurally — only `terminal` and `ok` matter — so the
 * caller can hand over its richer run record without this module importing it.
 */
export function planReviewReconcile<S extends { terminal: boolean; ok: boolean } | undefined>(
  state: PlanReviewState,
  snapshot: S,
): PlanReviewReconcile {
  if (state !== "running") return "keep";
  if (!snapshot) return "failed";
  if (!snapshot.terminal) return "wait";
  return snapshot.ok ? "done" : "failed";
}
