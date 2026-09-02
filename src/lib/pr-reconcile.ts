/**
 * The durable owner of the Feature PR phase.
 *
 * Once a Feature PR is open, everything that keeps it moving used to live in
 * one pi session's memory: the latch armed by whoever ran `git pr-await`, plus
 * a 15s timer inside that process. A reload minted a new session id, adoption
 * refused the hand-over (correctly — see `adoptableLatch`), and the PR was
 * orphaned with review findings outstanding and nothing on disk or on a timer
 * to notice. `/orchestrate resume` could not help either: the handshake always
 * prints `next=yield`, so it re-armed the latch and returned (qa/fable_01.md
 * F1, RC1).
 *
 * This module is the answer. It is keyed on `status.md`, which outlives every
 * session, and it asks three questions of each live Feature in `phase: pr`:
 *
 *   1. Has the PR finished?    merged/closed → the Feature is closed in code.
 *   2. Is a verdict waiting?   undelivered ACTIONABLE → dispatch a fixer.
 *   3. Is anyone waiting on it? no live waiter → start exactly one.
 *
 * Every dependency is injected. Nothing here imports `orchestrate.ts` (the
 * latch already reaches it lazily, and a second static edge would pull the
 * orchestrator into every session at load time), nothing here reads the live
 * `~/orchestrator` unless a caller passes that walk in, and nothing here talks
 * to GitHub directly. That keeps the decisions testable without a PR, a
 * worktree, or a spawn.
 */
import {
	ACCEPTED_FEATURE_PR_ACTIONS,
	isAcceptedFeaturePrAction,
	type FeaturePrOwner,
	type UndeliveredVerdict,
} from "./pr-await-core.ts";

export type PrLiveState = "open" | "merged" | "closed" | "unknown";

export type ReconcileVerdict = {
	next: string;
	output: string;
	round?: string;
};

export type ReconcileStatusPatch = {
	phase?: string;
	nextAction?: string;
	prHead?: string;
	pendingVerdict?: string;
	verdictFingerprint?: string;
};

export interface ReconcileDeps {
	/** Live Features in `phase: pr` that record a PR number. */
	listFeatures: () => FeaturePrOwner[];
	/** GitHub's answer for one PR. `unknown` must never close a Feature. */
	prState: (owner: FeaturePrOwner) => Promise<PrLiveState | { state: PrLiveState; head?: string }>;
	/** Undelivered ACTIONABLE verdicts on disk for this PR. */
	undeliveredVerdicts: (owner: FeaturePrOwner) => UndeliveredVerdict[];
	/** Hand one verdict to the dispatcher. Returns the action it took. */
	dispatch: (
		owner: FeaturePrOwner,
		verdict: ReconcileVerdict,
	) => Promise<string | void> | string | void;
	/** Is a waiter alive for this PR, under any name spelling? */
	driverRunning: (owner: FeaturePrOwner) => boolean;
	/** Start the one waiter this PR is allowed. */
	ensureWaiter: (owner: FeaturePrOwner) => void;
	/** Persist reconcile results against the Feature's own status.md. */
	writeStatus?: (owner: FeaturePrOwner, patch: ReconcileStatusPatch) => void;
	/** Reported, never thrown: a reconcile pass must not take a session down. */
	onError?: (owner: FeaturePrOwner, error: unknown) => void;
}

export interface ReconcileResult {
	/** Features examined. */
	seen: number;
	/** Verdicts handed to the dispatcher. */
	dispatched: number;
	/** Features closed because GitHub says the PR is merged or closed. */
	finished: number;
	/** Waiters started, at most one per Feature. */
	waitersStarted: number;
	/** Verdicts the dispatcher refused; they stay on disk for the next pass. */
	refused: number;
}

function normalizeState(
	answer: PrLiveState | { state: PrLiveState; head?: string },
): { state: PrLiveState; head?: string } {
	return typeof answer === "string" ? { state: answer } : answer;
}

/**
 * One reconcile pass over every live Feature PR.
 *
 * Deliberately sequential. A pass fans out to `gh` and to a dispatcher that
 * may spawn a writer; running them concurrently would reintroduce exactly the
 * duplicate-waiter storm this exists to end.
 */
export async function reconcileFeaturePrs(deps: ReconcileDeps): Promise<ReconcileResult> {
	const result: ReconcileResult = {
		seen: 0,
		dispatched: 0,
		finished: 0,
		waitersStarted: 0,
		refused: 0,
	};

	let owners: FeaturePrOwner[];
	try {
		owners = deps.listFeatures() ?? [];
	} catch {
		return result;
	}

	for (const owner of owners) {
		result.seen += 1;
		try {
			await reconcileOne(owner, deps, result);
		} catch (error) {
			// One unreadable Feature must not stop the others.
			deps.onError?.(owner, error);
		}
	}
	return result;
}

async function reconcileOne(
	owner: FeaturePrOwner,
	deps: ReconcileDeps,
	result: ReconcileResult,
): Promise<void> {
	const { state, head } = normalizeState(await deps.prState(owner));

	if (head) deps.writeStatus?.(owner, { prHead: head });

	// 1. Terminal PR. This is the branch that closes a Feature nobody was
	// watching: four Features sat in `phase: pr` for days after their PRs
	// merged, and every pi session in that repo was told to stay idle because
	// of them (F8).
	//
	// `unknown` is not terminal. A failed `gh pr view` — rate limit, network,
	// an expired token — must never archive a live Feature.
	if (state === "merged" || state === "closed") {
		const action = await deps.dispatch(owner, {
			next: state === "merged" ? "done" : "stop",
			output: "",
		});
		if (isAcceptedFeaturePrAction(action)) result.finished += 1;
		return;
	}

	// 2. A verdict waiting on disk. Only the first is dispatched: a fixer takes
	// the Feature lock, so a second would be refused anyway, and the next pass
	// picks up whatever is left.
	const pending = deps.undeliveredVerdicts(owner);
	if (pending.length > 0) {
		const verdict = pending[0]!;
		const action = await deps.dispatch(owner, {
			next: verdict.next,
			output: verdict.verdict ?? "",
			round: verdict.round,
		});
		if (isAcceptedFeaturePrAction(action)) {
			result.dispatched += 1;
		} else {
			// Refused: a writer already holds this Feature. The verdict stays
			// undelivered on disk and the next pass tries again — that retry is
			// the whole point of not marking it spent (F4).
			result.refused += 1;
			deps.writeStatus?.(owner, {
				nextAction: `verdict ${verdict.next} queued — a writer holds this Feature`,
			});
		}
		// A dispatch may have opened a writer and re-awaited; deciding about a
		// waiter in the same pass would race it.
		return;
	}

	// 3. Still open with nothing waiting on it. Exactly one waiter, and only
	// when none is alive under either name spelling (F2, F3).
	if (state === "open" && !deps.driverRunning(owner)) {
		deps.ensureWaiter(owner);
		result.waitersStarted += 1;
	}
}

export { ACCEPTED_FEATURE_PR_ACTIONS };
