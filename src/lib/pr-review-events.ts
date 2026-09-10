/**
 * Versioned, validated pi.events contracts for the PR review controller.
 *
 * Process-local transport only — not durable storage and not a cross-process
 * lock. A missing handler is a hard failure: never fall back to a solo writer.
 */
import { PR_REVIEW_PROTOCOL_VERSION, type PrKey } from "./pr-review-identity.ts";
import type { ReviewOwner } from "./pr-review-store.ts";
import type { DeliveryGroup, ExecutionManifest, IntegrationReceipt, RepoIdentity, WorkspaceRef } from "./execution-contract.ts";
import type { ReviewController } from "./pr-review-controller.ts";

export const PR_REVIEW_LAUNCH_EVENT = "pi.pr-review.launch";
export const PR_REVIEW_QUERY_EVENT = "pi.pr-review.query";
export const PR_REVIEW_PUBLISH_EVENT = "pi.pr-review.publish";
export const PR_REVIEW_PROTOCOL = PR_REVIEW_PROTOCOL_VERSION;
export const PR_REVIEW_RECONCILED_EVENT = "pi.pr-review.reconciled";
/** Process-local request used by plan-driven execution to reuse the one durable
 * PR controller owned by pr-await-latch. A missing listener is represented as
 * undefined; execution still remains local-only unless a PR delivery asks for
 * the binding, at which point the delivery reports the missing adapter. */
export const EXECUTION_CONTROLLER_BINDING_EVENT = "pi.execution.controller.binding";
export type ExecutionPrResolver = (request: {
	manifest: ExecutionManifest; group: DeliveryGroup; receipt: IntegrationReceipt; workspace: WorkspaceRef;
}) => Promise<{ kind: "authorized"; pr: { repo: string; number: number }; generation: string; ownerId?: string } | { kind: "refused" | "unknown"; reason: string }>;
export type ExecutionControllerBinding = {
	controller: Pick<ReviewController, "handoff" | "status">;
	controllerId: string;
	resolvePr: ExecutionPrResolver;
	verifyMerge: (request: { pr: { repo: string; number: number }; workspace: WorkspaceRef; head: string }) => Promise<{ commit: string; url: string; observedAt: number } | undefined>;
};
export type ExecutionControllerBindingRequest = {
	repo: RepoIdentity;
	repoName?: string;
	sessionFile: string;
	claimed: boolean;
	resolve: (binding: ExecutionControllerBinding) => void;
};
export function requestExecutionController(events: PrLifecycleBus, request: Omit<ExecutionControllerBindingRequest, "claimed" | "resolve">): Promise<ExecutionControllerBinding | undefined> {
	let binding: ExecutionControllerBinding | undefined;
	const payload: ExecutionControllerBindingRequest = { ...request, claimed: false, resolve: value => { binding = value; } };
	events.emit(EXECUTION_CONTROLLER_BINDING_EVENT, payload);
	return Promise.resolve(payload.claimed ? binding : undefined);
}

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
