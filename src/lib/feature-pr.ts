/**
 * Feature-PR policy table for /orchestrate.
 *
 * The pure decisions behind a Feature-owned PR verdict: what a judgment
 * `next=` means (`classifyFeaturePrNext`) and what a finished fixer round
 * means for the branch (`fixerSettleAction`). Moved verbatim from
 * orchestrate.ts — the dispatch, branch-head reads and latch wiring stay
 * there because they need the extension API and git.
 *
 * Run: node --experimental-strip-types --test test/feature-pr.test.ts
 */

import { MECHANICAL } from "./pr-await-core.ts";

/** What a finished fixer round means for the Feature PR. */
export type FixerSettle = "await" | "push_then_await" | "pause" | "fail" | "disagree";

/**
 * What the branch says the fixer did. `unknown` means git could not answer and
 * is never evidence of inaction — see `worktreeFingerprint` for the same rule
 * on the Task path.
 */
export type FixerPushState = "pushed" | "committed" | "none" | "unknown";

export function fixerPushState(heads: {
  remoteBefore: string;
  remoteAfter: string;
  localAfter: string;
}): FixerPushState {
  if (!heads.remoteBefore || !heads.remoteAfter || !heads.localAfter) return "unknown";
  if (heads.remoteAfter !== heads.remoteBefore) return "pushed";
  if (heads.localAfter !== heads.remoteAfter) return "committed";
  return "none";
}

/**
 * What a finished fixer round means.
 *
 * The branch is the evidence, not the child's own report: a fixer that pushed
 * and then hit its turn budget is `ok: false` with a handoff, and the old table
 * told the user it "answered without a push" — which was false and stopped the
 * loop on a PR that had just moved (F5). `push` absent or `unknown` falls back
 * to that table, because an unreadable head must not invent a verdict.
 */
export function fixerSettleAction(input: {
  ok: boolean;
  stopped?: boolean;
  handoffWritten: boolean;
  push?: FixerPushState;
}): FixerSettle {
  // A stop is the user's decision; the branch does not overrule it.
  if (input.stopped) return "pause";
  if (input.push === "pushed") return "await";
  if (input.push === "committed") return "push_then_await";
  if (input.push === "none") return input.handoffWritten ? "disagree" : "fail";
  if (input.ok) return "await";
  if (input.handoffWritten) return "disagree";
  return "fail";
}

/** What code does about a judgment `next=` on a Feature-owned PR. */
export type FeaturePrAction =
  /** `yield` / `poll_again` / no verdict — the waiter owns the rest, 0 tokens. */
  | "idle"
  /** Dispatch one `fixer` to fix current-head findings. */
  | "spawn_writer"
  /** No writer: run `git pr-await` once more. */
  | "reawait"
  /** Tell the user; nothing is dispatched. */
  | "notify"
  /** The waiter lands the PR. */
  | "land"
  | "archive"
  | "confirm"
  /** The loop is over: code says so on the PR and stops. */
  | "disagree"
  /** A writer already holds this Feature; a second one would race it. */
  | "refuse";

/**
 * Fix-writers one Feature PR may spend before code stops arguing.
 *
 * PR 275 consumed seven fixers and PR 2178 consumed seven; nothing implemented
 * the spec's "until the orchestrator disagrees with the reviewers" (F6), so the
 * loop only ever ended when the bots gave up or something else broke.
 */
export const FIX_ROUND_CAP = 6;

/**
 * Fix-spawns already spent on this PR. `pr_round: none` counts as zero.
 *
 * Exported only because orchestrate.ts's remaining call sites (the pr-await
 * label and the fixer contract) still consume it; it is not re-exported from
 * the orchestrate barrel.
 */
export function fixSpawnCount(value: number | string | undefined): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The one place a waiter verdict becomes an action.
 *
 * Pure, so the table is testable without a PR, a worktree, or a spawn. The
 * quiet verdicts are answered before anything else: a held lock must not turn
 * `next=yield` — which the model is never supposed to see — into a notice.
 */
export function classifyFeaturePrNext(
  next: string,
  state: {
    /** status.md `pr_round`: fix-writers already spawned for this PR. */
    prRound?: number | string;
    /** A Feature chain is in flight (`withChainLock`). */
    chainLocked?: boolean;
    /** The recorded `worker_run_id` snapshot is not terminal yet. */
    workerLive?: boolean;
    /** The same `brief_finding` set already came back on an earlier head. */
    findingsRepeated?: boolean;
  } = {},
): FeaturePrAction {
  const verdict = String(next ?? "").trim().toLowerCase();
  if (!verdict || verdict === "yield" || verdict === "poll_again") return "idle";
  if (verdict === "done") return "archive";
  if (verdict === "stop") return "confirm";
  if (MECHANICAL.has(verdict)) return "land";
  if (verdict === "read_comments_and_fix") {
    // One writer per Feature. A second fixer pushing onto the same branch is
    // how two children clobber each other's commits. This outranks the
    // termination rules below: a held Feature queues the verdict for retry,
    // and spending it on a disagreement would throw the round away.
    if (state.chainLocked || state.workerLive) return "refuse";
    // The loop ends at merge or at disagreement, and nothing else (F6).
    if (state.findingsRepeated) return "disagree";
    if (fixSpawnCount(state.prRound) >= FIX_ROUND_CAP) return "disagree";
    return "spawn_writer";
  }
  if (verdict === "investigate_dead_reviewers") return "reawait";
  // `fix_command_or_environment` and anything the waiter grows later: report it
  // rather than guess at a writer contract for it.
  return "notify";
}
