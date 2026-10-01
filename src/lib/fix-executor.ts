/**
 * Session-side contract for the detached PR fix executor (`ghl-pr-fix`).
 *
 * When the waiter writes `fixOwner: "executor"` in the same write as a
 * `read_comments_and_fix` verdict, a Rust process owns the fix. A session must
 * not dispatch a fixer, wake a model, or inject anything for that verdict; it
 * only reports the executor's outcome once. This module is the ONE decision
 * point for that rule — every dispatch/wake site asks `executorOwnsVerdict`.
 *
 * Pure: no fs, no env reads beyond `fixHostActive`.
 */

export type FixDispatch = { pid?: number; startedAt?: string | number; head?: string; round?: string | number };

export type FixOutcome = {
	state: "pushed" | "failed" | "stopped";
	reason?: string;
	head?: string;
	newHead?: string;
	round?: string | number;
	runId?: string;
	finishedAt?: string | number;
};

/** The latch fields the executor contract adds. Structural: LatchState and WaiterVerdict both fit. */
export type FixExecutorFields = {
	pr?: string;
	slug?: string;
	lastNext?: string;
	fixOwner?: string;
	fixDispatch?: FixDispatch;
	fixOutcome?: FixOutcome;
	fixConfigError?: string;
};

export type OutcomeNotice = { key: string; level: "info" | "error"; text: string };

/** Chrome text while the executor owns the verdict. */
export const FIXING_EXECUTOR_TEXT = "fixing (executor)";

/** True in the headless fixer host process (`ghl-pr-fix` sets GHL_FIX_HOST=1). */
export function fixHostActive(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.GHL_FIX_HOST === "1";
}

/** The executor owns this verdict: no session may dispatch a fixer or wake a model. */
export function executorOwnsVerdict(latch: FixExecutorFields | undefined): boolean {
	return latch?.fixOwner === "executor" && latch.lastNext === "read_comments_and_fix";
}

/** Validate untrusted JSON into the executor fields (unknown shapes are dropped). */
export function parseFixFields(raw: Record<string, unknown>): Pick<
	FixExecutorFields,
	"fixOwner" | "fixDispatch" | "fixOutcome" | "fixConfigError"
> {
	const out: ReturnType<typeof parseFixFields> = {};
	if (typeof raw.fixOwner === "string") out.fixOwner = raw.fixOwner;
	if (typeof raw.fixConfigError === "string" && raw.fixConfigError) out.fixConfigError = raw.fixConfigError;
	const d = raw.fixDispatch;
	if (d && typeof d === "object") out.fixDispatch = d as FixDispatch;
	const o = raw.fixOutcome as Record<string, unknown> | undefined;
	if (o && typeof o === "object" && (o.state === "pushed" || o.state === "failed" || o.state === "stopped")) {
		out.fixOutcome = o as FixOutcome;
	}
	return out;
}

function label(latch: FixExecutorFields): string {
	return latch.slug ? `${latch.slug}#${latch.pr}` : `PR #${latch.pr}`;
}

/**
 * One notification per (pr, round, state). `undefined` when there is no
 * outcome. Never a model wake: the caller routes this to `uiNotify` only.
 */
export function outcomeNotice(latch: FixExecutorFields | undefined): OutcomeNotice | undefined {
	const o = latch?.fixOutcome;
	if (!latch || !o || !latch.pr) return undefined;
	const key = `${latch.pr}:${o.round ?? "?"}:${o.state}`;
	const round = o.round !== undefined ? ` round ${o.round}` : "";
	if (o.state === "pushed") {
		const sha = o.newHead ? ` → ${String(o.newHead).slice(0, 7)}` : "";
		return { key, level: "info", text: `pr-latch: ${label(latch)} fix executor pushed${round}${sha}` };
	}
	const reason = o.reason ? `: ${o.reason}` : "";
	return { key, level: "error", text: `pr-latch: ${label(latch)} fix executor ${o.state}${round}${reason}` };
}
