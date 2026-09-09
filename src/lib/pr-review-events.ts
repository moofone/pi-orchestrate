/**
 * Versioned, validated pi.events contracts for the PR review controller.
 *
 * Process-local transport only — not durable storage and not a cross-process
 * lock. A missing handler is a hard failure: never fall back to a solo writer.
 */
import { PR_REVIEW_PROTOCOL_VERSION, type PrKey } from "./pr-review-identity.ts";
import type { ReviewOwner } from "./pr-review-store.ts";

export const PR_REVIEW_LAUNCH_EVENT = "pi.pr-review.launch";
export const PR_REVIEW_QUERY_EVENT = "pi.pr-review.query";
export const PR_REVIEW_PUBLISH_EVENT = "pi.pr-review.publish";
export const PR_REVIEW_PROTOCOL = PR_REVIEW_PROTOCOL_VERSION;

export type PrLifecycleBus = {
	emit: (event: string, data: unknown) => void;
	on: (event: string, handler: (data: any) => void) => () => void;
};

export type LaunchIntent = {
	v: typeof PR_REVIEW_PROTOCOL_VERSION;
	idempotencyKey: string;
	pr: PrKey;
	owner: ReviewOwner;
	worktree: string;
	expectedHead: string;
	verdictIds: string[];
	next: string;
	body: string;
	validation: "commit-only";
	publication: "controller";
};

export type LaunchResult = {
	runId: string;
	recovered: boolean;
	/** Adapter already ran publish + re-await (Feature dispatch). */
	completeRound?: boolean;
};

export type RunSnapshot = {
	runId: string;
	status: "running" | "exited" | "unknown";
	head?: string;
	ok?: boolean;
	stopped?: boolean;
	handoffWritten?: boolean;
	exitCode?: number;
	/** Checkout this run mutates. queryRun must rev-parse here, not the live latch cwd. */
	worktree?: string;
};

export type PublishRequest = {
	v: typeof PR_REVIEW_PROTOCOL_VERSION;
	pr: PrKey;
	worktree: string;
	expectedHead: string;
	localHead: string;
	remoteHead?: string;
};

export type PublishResult = {
	ok: boolean;
	remoteHead?: string;
	already?: boolean;
	reason?: string;
};

export type OwnerLookup =
	| { status: "feature"; owner: ReviewOwner; worktree?: string }
	| { status: "session"; owner: ReviewOwner; worktree?: string }
	| { status: "observer" }
	| { status: "unavailable"; reason: string };

type LaunchRequest = {
	intent: LaunchIntent;
	resolve: (result: LaunchResult) => void;
	reject: (error: unknown) => void;
	claimed: boolean;
};

export function requestReviewLaunch(events: PrLifecycleBus, intent: LaunchIntent): Promise<LaunchResult> {
	return new Promise((resolve, reject) => {
		const request: LaunchRequest = { intent, resolve, reject, claimed: false };
		events.emit(PR_REVIEW_LAUNCH_EVENT, request);
		if (!request.claimed) {
			reject(new Error("pr-review launch handler is not registered in this runtime"));
		}
	});
}

export function registerReviewLaunch(
	fn: (intent: LaunchIntent) => Promise<LaunchResult> | LaunchResult,
	events: PrLifecycleBus,
): () => void {
	return events.on(PR_REVIEW_LAUNCH_EVENT, (request: LaunchRequest) => {
		if (request.claimed) return;
		if (!request?.intent || request.intent.v !== PR_REVIEW_PROTOCOL_VERSION) {
			request.reject(new Error("invalid pr-review launch request"));
			return;
		}
		request.claimed = true;
		try {
			Promise.resolve(fn(request.intent)).then(request.resolve, request.reject);
		} catch (error) {
			request.reject(error);
		}
	});
}
