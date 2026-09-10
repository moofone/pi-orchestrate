import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

export const EXECUTION_SCHEMA_VERSION = 1 as const;
export type Digest = string;
export type Id = string;
export type RepoIdentity = { commonDir: string; id: Id };
export type SourceAnchor = { path: string; startLine: number; endLine: number };
export type Provenance = { field: string; origin: "explicit" | "inferred"; anchor?: SourceAnchor; reason?: string };
export type SourceSnapshot = { path: string; bytes: string; digest: Digest };
export type ExecutionProfile = {
	agent?: string; model?: string; thinking?: string; tools?: string[];
	context?: "fresh" | "fork"; supervisor?: boolean; intercom?: boolean;
	maxTurns?: number; timeoutMs?: number;
};
export type CheckSpec = {
	id: Id; cwd: string; argv: string[]; runner: "node" | "vitest" | "cargo" | "command";
	expectedEvidence: { reportPath?: string; requiredTests: string[]; rationale?: string };
};
export type CheckEvidence = {
	checkId: Id; invocationId: Id; startedAt: number; finishedAt: number; exitCode: number;
	reportPath?: string; reportDigest?: Digest; executedTests: string[]; skippedTests: string[];
	status: "passed" | "failed" | "unknown"; reason?: string;
};
export type FeatureGroup = { id: Id; title: string; scope: string };
export type DeliveryGroup = {
	id: Id; featureIds: Id[]; requiredTaskIds: Id[]; checks: CheckSpec[];
	policy: "local" | "pr"; completion: "validated" | "merged"; ownerId: Id;
};
export type TaskSpec = {
	id: Id; featureId: Id; deliveryGroupId: Id; parentTaskId?: Id; text: string;
	mode: "read-only" | "mutation"; dependencies: Id[]; scope: string[];
	profile: ExecutionProfile; checks: CheckSpec[]; provenance: Provenance[];
};
export type ExecutionConstraints = {
	capacity: number; parallelGroups: { id: Id; taskIds: Id[]; simultaneous: number; provenance: Provenance }[];
	provenance: Provenance[];
};
export type ExecutionManifest = {
	schemaVersion: typeof EXECUTION_SCHEMA_VERSION; id: Id; revision: number;
	source: SourceSnapshot; repo: RepoIdentity; baseCommit: string; scope: string;
	preset: "plan-driven" | "legacy"; features: FeatureGroup[]; deliveryGroups: DeliveryGroup[];
	tasks: TaskSpec[]; constraints: ExecutionConstraints; provenance: Provenance[];
};
/** Authorization is supplied by the caller, never inferred from plan text. */
export type ExecutionAuthorization = {
	id: Id; manifestId: Id; revision: number; sourceDigest: Digest; manifestDigest: Digest;
	repoId: Id; baseCommit: string; scope: string; capacity: number; publication: boolean;
	approvedBy: string; approvedAt: number;
};
export type RevisionDecision = { kind: "in-scope" } | { kind: "approval-required"; reasons: string[] };
/** Adapter supplies a canonical, caller-owned path, including symlink resolution. */
export type WorkspaceRef = { id: Id; path: string; branch: string; repoId: Id; baseCommit: string; prerequisiteDigests: Digest[] };
export type RunRef = { runId: Id; artifactDir: string; ownerSessionFile: string; operationId?: Id };
export type AttemptPhase = "pending" | "dependency-blocked" | "ready" | "preparing" | "launching" | "running" | "stopping" | "validating" | "succeeded" | "failed" | "recovery-needed";
export type ControlIntent = "none" | "pause" | "stop" | "cancel";
export type TerminalEvidence = { kind: "terminal"; run: RunRef; outcome: "succeeded" | "failed" | "stopped"; evidenceDigest: Digest; observedAt: number };
export type NonStartEvidence = { kind: "not-started"; launchDigest: Digest; reason: string };
export type TaskAttempt = {
	schemaVersion: typeof EXECUTION_SCHEMA_VERSION; id: Id; taskId: Id; manifestId: Id;
	manifestRevision: number; taskDigest: Digest; ownerSessionFile: string; launchDigest: Digest;
	operationId?: Id; run?: RunRef; workspace: WorkspaceRef; baseCommit: string;
	prerequisiteDigests: Digest[]; phase: AttemptPhase; intent: ControlIntent;
	createdAt: number; updatedAt: number; reason?: string; terminal?: TerminalEvidence;
	nonStart?: NonStartEvidence; resultDigest?: Digest;
};
export type ResultReceipt = {
	schemaVersion: typeof EXECUTION_SCHEMA_VERSION; digest: Digest; attemptId: Id; taskId: Id;
	taskDigest: Digest; repoId: Id; baseCommit: string; prerequisiteDigests: Digest[];
	output: { kind: "commits"; from: string; to: string; commits: string[]; paths: string[] } |
		{ kind: "artifact"; path: string; digest: Digest };
	checks: CheckEvidence[]; validatedAt: number;
};
export type IntegrationIntent = {
	id: Id; deliveryGroupId: Id; workspace: WorkspaceRef; inputDigests: Digest[]; createdAt: number;
	beforeCommit: string; phase: "planned" | "composing" | "validating" | "complete" | "recovery-needed";
	afterCommit?: string; reason?: string;
};
export type HandoffRequest = {
	id: Id; deliveryGroupId: Id; ownerId: Id; generation: string;
	pr: { repo: string; number: number }; workspace: WorkspaceRef; head: string; integrationDigest: Digest;
};
export type HandoffAcknowledgement = { requestId: Id; controllerId: Id; obligationId: Id; generation: string; acceptedAt: number };
export type IntegrationReceipt = {
	schemaVersion: typeof EXECUTION_SCHEMA_VERSION; digest: Digest; intentId: Id; deliveryGroupId: Id;
	inputDigests: Digest[]; beforeCommit: string; afterCommit: string; checks: CheckEvidence[];
	validatedAt: number; acknowledgement?: HandoffAcknowledgement;
};
export type DeliveryRecord = {
	groupId: Id; phase: "pending" | "integrating" | "blocked" | "ready" | "handoff-pending" | "controller-owned" | "merged" | "closed-unmerged";
	integrationDigest?: Digest; handoff?: HandoffRequest; acknowledgement?: HandoffAcknowledgement;
	mergeEvidence?: { commit: string; url: string; observedAt: number };
	/** Definitive controller lookup, not a timeout or missing reply. */
	nonTransfer?: { requestId: Id; reason: string; observedAt: number }; reason?: string;
};
export type CoordinatorOwner = { pid: number; processStart: string; sessionFile: string; instanceId: Id; epoch: number };
export type ResourceReservation = { id: Id; attemptId?: Id; integrationId?: Id; workspaceId: Id; workspacePath: string; slots: number; parallelGroupId?: Id };
export type ParallelLaunchSet = { id: Id; groupId: Id; attemptIds: Id[]; instruction: "reserved" | "met" | "unmet"; reason?: string };
export type TaskRecord = { taskId: Id; manifestId: Id; phase: AttemptPhase; intent: ControlIntent; attemptIds: Id[]; resultDigest?: Digest; reason?: string };
export type CoordinatorIntent = { id: Id; sessionFile: string; authorizationId: Id; kind: "admit" | "revision" | "pause" | "resume" | "retry" | "cancel"; targetId: Id; manifest?: ExecutionManifest; immediate?: boolean; consumedAt?: number };
export type CoordinatorState = {
	schemaVersion: typeof EXECUTION_SCHEMA_VERSION; repo: RepoIdentity; sequence: number; epoch: number;
	/** Caller-authorized repository pool ceiling, never the sum of feature requests. */
	capacity: number;
	owner?: CoordinatorOwner; reconciledEpoch?: number; manifests: ExecutionManifest[];
	authorizations: ExecutionAuthorization[]; activeRevisions: Record<Id, number>;
	tasks: TaskRecord[]; attempts: TaskAttempt[]; results: ResultReceipt[];
	integrations: IntegrationIntent[]; integrationReceipts: IntegrationReceipt[]; deliveries: DeliveryRecord[];
	reservations: ResourceReservation[]; parallelLaunchSets: ParallelLaunchSet[]; intents: CoordinatorIntent[];
};

export type RuntimeCapabilities = {
	available: boolean; capacity: number; remainingBudget?: number; durableOperationLookup: boolean;
	controls: ("stop" | "pause" | "resume")[]; profiles: (keyof ExecutionProfile)[];
	callerTools?: string[]; callerAgents?: string[]; reason?: string;
};
export type LaunchRequest = { attempt: TaskAttempt; task: TaskSpec; profile: ExecutionProfile; authorization: ExecutionAuthorization };
export type LaunchOutcome = { kind: "known-running"; run: RunRef } | { kind: "known-terminal"; evidence: TerminalEvidence } |
	{ kind: "rejected-before-start"; reason: string; category: "policy" | "budget" | "capability"; evidence: NonStartEvidence } |
	{ kind: "capacity-deferred"; reason: string; retryAfterMs?: number; evidence: NonStartEvidence } | { kind: "unknown"; reason: string };
export type Observation = { kind: "known-running"; run: RunRef } | { kind: "known-terminal"; evidence: TerminalEvidence } | { kind: "unknown"; reason: string };
export type ControlOutcome = { kind: "acknowledged"; run: RunRef } | { kind: "unsupported" | "forbidden" | "unknown"; reason: string };
export interface AttemptRuntime {
	probe(): Promise<RuntimeCapabilities>;
	launch(request: LaunchRequest): Promise<LaunchOutcome>;
	observe(attempt: TaskAttempt): Promise<Observation>;
	control(run: RunRef, action: "stop" | "pause" | "resume", sessionFile: string): Promise<ControlOutcome>;
	/** Wakeups only. Subscribe before launch; consumers reconcile exact evidence. */
	subscribe(listener: (event: { runId?: Id; operationId?: Id; attemptId?: Id }) => void): () => void;
	lookupOperation?(operationId: Id, sessionFile: string): Promise<LaunchOutcome>;
}
export type WorkspaceOutcome = { kind: "prepared"; workspace: WorkspaceRef; head: string } | { kind: "conflict" | "unknown" | "refused"; reason: string };
export type WorkspaceInspection = { kind: "inspected"; workspace: WorkspaceRef; head: string; clean: boolean; inProgress?: string; appliedDigests: Digest[] } | { kind: "unknown"; reason: string };
export interface WorkspaceAdapter {
	prepare(request: { attemptId: Id; workspace: WorkspaceRef; prerequisites: ResultReceipt[] }): Promise<WorkspaceOutcome>;
	inspect(workspace: WorkspaceRef): Promise<WorkspaceInspection>;
	/** Caller persists the intent and writer reservation before calling compose. */
	compose(request: { intent: IntegrationIntent; receipts: ResultReceipt[] }): Promise<WorkspaceOutcome>;
}
export interface CheckExecutor {
	execute(check: CheckSpec, context: { workspace: WorkspaceRef; invocationId: Id; startedAt: number }): Promise<CheckEvidence>;
	validateEvidence(check: CheckSpec, evidence: CheckEvidence, context: { invocationId: Id; notBefore: number }): { valid: boolean; reasons: string[] };
}
export type DeliveryObservation = { kind: "accepted"; acknowledgement: HandoffAcknowledgement } |
	{ kind: "merged"; acknowledgement: HandoffAcknowledgement; commit: string; url: string; observedAt: number } |
	{ kind: "closed-unmerged"; acknowledgement: HandoffAcknowledgement } | { kind: "not-transferred"; reason: string } | { kind: "unknown"; reason: string };
export interface DeliveryAdapter {
	handoff(request: HandoffRequest): Promise<DeliveryObservation>;
	observe(request: HandoffRequest): Promise<DeliveryObservation>;
}

/** Canonical JSON rejects values that would disappear or change under persistence. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	throw new Error("Not canonical JSON data");
}
export function digest(value: unknown): Digest { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
export function sourceDigest(bytes: string): Digest { return createHash("sha256").update(bytes).digest("hex"); }
/** A persisted/importer-assigned logical key, not mutable task text or revision, determines identity. */
export function stableTaskId(manifestId: Id, logicalKey: string): Id { return `task-${digest([manifestId, logicalKey])}`; }
export function newAttemptId(): Id { return randomUUID(); }
export function taskRevisionDigest(task: TaskSpec): Digest { return digest(task); }
export function receiptDigest(receipt: Omit<ResultReceipt, "digest"> | Omit<IntegrationReceipt, "digest">): Digest { return digest(receipt); }
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown): asserts value is Record<string, unknown> { requireThat(value !== null && typeof value === "object" && !Array.isArray(value), "Expected object"); }
function text(value: unknown): asserts value is string { requireThat(typeof value === "string" && value.length > 0 && !value.includes("\0"), "Expected nonempty string"); }
function integer(value: unknown, min = 0): asserts value is number { requireThat(Number.isSafeInteger(value) && (value as number) >= min, "Expected integer"); }
function strings(value: unknown): asserts value is string[] { requireThat(Array.isArray(value), "Expected string array"); value.forEach(text); }
function unique(ids: string[], label: string): void { requireThat(new Set(ids).size === ids.length, `Duplicate ${label}`); }
function version(value: Record<string, unknown>): void { requireThat(value.schemaVersion === EXECUTION_SCHEMA_VERSION, "Unsupported execution schema version"); }
function repo(value: unknown): asserts value is RepoIdentity { object(value); text(value.commonDir); text(value.id); requireThat(isAbsolute(value.commonDir) && value.id === digest(value.commonDir), "Invalid repository identity"); }
export function validateCheckSpec(value: unknown): asserts value is CheckSpec {
	object(value); text(value.id); text(value.cwd); strings(value.argv); requireThat(value.argv.length > 0, "Empty check argv");
	requireThat(["node", "vitest", "cargo", "command"].includes(value.runner as string), "Invalid check runner");
	object(value.expectedEvidence); strings(value.expectedEvidence.requiredTests); unique(value.expectedEvidence.requiredTests, "required tests");
	if (value.runner === "command") text(value.expectedEvidence.rationale);
	else text(value.expectedEvidence.reportPath);
}
export function validateCheckEvidence(value: unknown): asserts value is CheckEvidence {
	object(value); text(value.checkId); text(value.invocationId); integer(value.startedAt); integer(value.finishedAt, value.startedAt);
	requireThat(Number.isSafeInteger(value.exitCode), "Invalid check exit code"); strings(value.executedTests); strings(value.skippedTests);
	unique(value.executedTests, "executed test"); unique(value.skippedTests, "skipped test");
	requireThat(["passed", "failed", "unknown"].includes(value.status as string), "Invalid check status");
	if (value.reportPath !== undefined) text(value.reportPath);
	if (value.reportDigest !== undefined) text(value.reportDigest);
}
function validateRequiredChecks(specs: CheckSpec[], checks: CheckEvidence[], notBefore: number): void {
	checks.forEach(validateCheckEvidence); unique(checks.map(c => c.checkId), "check evidence");
	for (const spec of specs) {
		const evidence = checks.find(c => c.checkId === spec.id);
		requireThat(evidence && evidence.status === "passed" && evidence.exitCode === 0 && evidence.startedAt >= notBefore, "Missing/failed/stale required check");
		if (spec.runner !== "command") requireThat(evidence.reportPath && evidence.reportDigest && evidence.executedTests.length > 0 && spec.expectedEvidence.requiredTests.every(t => evidence.executedTests.includes(t)), "Missing executed tests/report evidence");
	}
}
function validateRun(value: unknown): asserts value is RunRef {
	object(value); text(value.runId); text(value.artifactDir); text(value.ownerSessionFile);
	requireThat(isAbsolute(value.artifactDir) && isAbsolute(value.ownerSessionFile), "Invalid runtime paths");
	if (value.operationId !== undefined) text(value.operationId);
}
function validateWorkspace(value: unknown): asserts value is WorkspaceRef {
	object(value); text(value.id); text(value.path); text(value.branch); text(value.repoId); text(value.baseCommit); strings(value.prerequisiteDigests);
	requireThat(isAbsolute(value.path) && resolve(value.path) === value.path, "Invalid workspace path"); unique(value.prerequisiteDigests, "prerequisite digest");
}
function validateProfile(value: unknown): void {
	object(value);
	for (const key of Object.keys(value)) requireThat(["agent", "model", "thinking", "tools", "context", "supervisor", "intercom", "maxTurns", "timeoutMs"].includes(key), "Unknown profile field");
	for (const key of ["agent", "model", "thinking"]) if (value[key] !== undefined) text(value[key]);
	if (value.tools !== undefined) strings(value.tools);
	if (value.context !== undefined) requireThat(["fresh", "fork"].includes(value.context as string), "Invalid context");
	for (const key of ["supervisor", "intercom"]) if (value[key] !== undefined) requireThat(typeof value[key] === "boolean", "Invalid profile flag");
	for (const key of ["maxTurns", "timeoutMs"]) if (value[key] !== undefined) integer(value[key], 1);
}
function provenance(value: unknown): void {
	requireThat(Array.isArray(value), "Expected provenance array");
	for (const item of value) {
		object(item); text(item.field); requireThat(item.origin === "explicit" || item.origin === "inferred", "Invalid provenance");
		if (item.origin === "inferred") text(item.reason);
		if (item.anchor !== undefined) { object(item.anchor); text(item.anchor.path); integer(item.anchor.startLine, 1); integer(item.anchor.endLine, item.anchor.startLine); }
	}
}
export function validateManifest(value: unknown): asserts value is ExecutionManifest {
	object(value); version(value); text(value.id); integer(value.revision, 1); repo(value.repo); text(value.baseCommit); text(value.scope);
	object(value.source); text(value.source.path); requireThat(isAbsolute(value.source.path), "Source path must be canonical absolute path");
	requireThat(typeof value.source.bytes === "string" && value.source.digest === sourceDigest(value.source.bytes), "Source digest mismatch");
	requireThat(value.preset === "plan-driven" || value.preset === "legacy", "Invalid preset"); provenance(value.provenance);
	for (const key of ["features", "deliveryGroups", "tasks"]) requireThat(Array.isArray(value[key]), `Expected ${key}`);
	const features = value.features as FeatureGroup[], deliveries = value.deliveryGroups as DeliveryGroup[], tasks = value.tasks as TaskSpec[];
	for (const feature of features) { object(feature); text(feature.id); text(feature.title); text(feature.scope); }
	unique(features.map(f => f.id), "feature ID"); unique(deliveries.map(d => d.id), "delivery ID"); unique(tasks.map(t => t.id), "task ID");
	for (const delivery of deliveries) {
		object(delivery); text(delivery.id); text(delivery.ownerId); strings(delivery.featureIds); strings(delivery.requiredTaskIds);
		unique(delivery.featureIds, "delivery feature"); unique(delivery.requiredTaskIds, "delivery task");
		requireThat(delivery.featureIds.length > 0 && delivery.featureIds.every(id => features.some(f => f.id === id)), "Missing delivery feature");
		requireThat(delivery.policy === "local" || delivery.policy === "pr", "Invalid delivery policy");
		requireThat(delivery.completion === "validated" || (delivery.completion === "merged" && delivery.policy === "pr"), "Invalid completion policy");
		requireThat(Array.isArray(delivery.checks), "Expected checks"); delivery.checks.forEach(validateCheckSpec); unique(delivery.checks.map(c => c.id), "check ID");
	}
	for (const task of tasks) {
		object(task); text(task.id); text(task.text); text(task.featureId); text(task.deliveryGroupId); strings(task.dependencies); strings(task.scope);
		unique(task.dependencies, "dependency"); requireThat(task.mode === "mutation" || task.mode === "read-only", "Invalid task mode");
		requireThat(features.some(f => f.id === task.featureId), "Missing task feature");
		requireThat(deliveries.some(d => d.id === task.deliveryGroupId && d.featureIds.includes(task.featureId)), "Inconsistent task delivery");
		requireThat(task.dependencies.every(id => tasks.some(t => t.id === id)), "Missing dependency");
		if (task.parentTaskId !== undefined) requireThat(task.parentTaskId !== task.id && tasks.some(t => t.id === task.parentTaskId && t.featureId === task.featureId), "Missing/invalid parent task");
		validateProfile(task.profile); provenance(task.provenance); requireThat(Array.isArray(task.checks), "Expected checks"); task.checks.forEach(validateCheckSpec); unique(task.checks.map(c => c.id), "check ID");
	}
	for (const delivery of deliveries) requireThat(delivery.requiredTaskIds.every(id => tasks.some(t => t.id === id && t.deliveryGroupId === delivery.id)), "Missing/inconsistent required task");
	const visited = new Set<Id>(), active = new Set<Id>();
	function visit(id: Id): void { requireThat(!active.has(id), "Dependency cycle"); if (visited.has(id)) return; active.add(id); tasks.find(t => t.id === id)!.dependencies.forEach(visit); active.delete(id); visited.add(id); }
	tasks.forEach(t => visit(t.id));
	object(value.constraints); integer(value.constraints.capacity, 1); provenance(value.constraints.provenance); requireThat(Array.isArray(value.constraints.parallelGroups), "Expected parallel groups");
	const grouped = new Set<Id>();
	for (const group of value.constraints.parallelGroups) {
		object(group); text(group.id); strings(group.taskIds); unique(group.taskIds, "parallel member"); integer(group.simultaneous, 1); provenance([group.provenance]);
		requireThat(group.simultaneous === group.taskIds.length, "Parallel count must match group membership");
		for (const id of group.taskIds) { requireThat(tasks.some(t => t.id === id) && !grouped.has(id), "Missing/duplicate parallel task"); grouped.add(id); }
		const members = group.taskIds;
		const reachesMember = (id: Id): boolean => tasks.find(t => t.id === id)!.dependencies.some(dep => members.includes(dep) || reachesMember(dep));
		requireThat(!members.some(reachesMember), "Parallel members cannot depend on each other");
	}
	unique(value.constraints.parallelGroups.map(g => g.id), "parallel group ID");
	canonicalJson(value);
}
export function validateAuthorization(manifest: ExecutionManifest, authorization: ExecutionAuthorization): void {
	validateManifest(manifest); text(authorization.id); text(authorization.approvedBy); integer(authorization.approvedAt); integer(authorization.capacity, 1);
	requireThat(authorization.manifestId === manifest.id && authorization.revision === manifest.revision && authorization.sourceDigest === manifest.source.digest && authorization.manifestDigest === digest(manifest), "Approval does not bind manifest revision/source");
	requireThat(authorization.repoId === manifest.repo.id && authorization.baseCommit === manifest.baseCommit && authorization.scope === manifest.scope, "Authorization boundary mismatch");
	requireThat(manifest.constraints.capacity <= authorization.capacity && manifest.constraints.parallelGroups.every(g => g.simultaneous <= authorization.capacity && g.simultaneous <= manifest.constraints.capacity), "Explicit concurrency exceeds authorized capacity");
	requireThat(authorization.publication === true || !manifest.deliveryGroups.some(d => d.policy === "pr"), "Publication not authorized");
}
/** Conservative mechanical boundary: uncertain additions require caller approval. */
export function assessRevision(previous: ExecutionManifest, next: ExecutionManifest, inScopeTaskIds: readonly Id[] = []): RevisionDecision {
	validateManifest(previous); validateManifest(next);
	requireThat(next.id === previous.id && next.revision === previous.revision + 1, "Invalid revision identity/order");
	const reasons: string[] = [];
	for (const key of ["repo", "baseCommit", "scope", "features", "deliveryGroups", "constraints", "preset", "provenance"] as const) if (digest(previous[key]) !== digest(next[key])) reasons.push(`Changed ${key}`);
	for (const task of previous.tasks) {
		const replacement = next.tasks.find(t => t.id === task.id);
		if (!replacement || taskRevisionDigest(task) !== taskRevisionDigest(replacement)) reasons.push(`Changed existing task ${task.id}`);
	}
	for (const task of next.tasks) if (!previous.tasks.some(t => t.id === task.id) && !inScopeTaskIds.includes(task.id)) reasons.push(`Unproven scope for ${task.id}`);
	return reasons.length ? { kind: "approval-required", reasons } : { kind: "in-scope" };
}
export const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptPhase, readonly AttemptPhase[]>> = {
	pending: ["dependency-blocked", "ready"], "dependency-blocked": ["ready", "failed"], ready: ["preparing", "dependency-blocked"],
	preparing: ["launching", "failed", "recovery-needed"], launching: ["running", "validating", "failed", "recovery-needed", "ready"],
	running: ["stopping", "validating", "failed", "recovery-needed"], stopping: ["validating", "failed", "recovery-needed"],
	validating: ["succeeded", "failed", "recovery-needed"], succeeded: [], failed: [],
	"recovery-needed": ["running", "stopping", "validating", "failed", "ready"],
};
export function occupiesCapacity(attempt: TaskAttempt): boolean { return ["preparing", "launching", "running", "stopping", "validating", "recovery-needed"].includes(attempt.phase); }
export function canReleaseAttempt(attempt: TaskAttempt): boolean {
	return !occupiesCapacity(attempt) && !!(attempt.terminal || attempt.nonStart);
}
export function transitionAttempt(attempt: TaskAttempt, phase: AttemptPhase, evidence: { at: number; terminal?: TerminalEvidence; nonStart?: NonStartEvidence; resultDigest?: Digest; reason?: string }): TaskAttempt {
	requireThat(attempt.phase === phase || ATTEMPT_TRANSITIONS[attempt.phase].includes(phase), `Illegal attempt transition ${attempt.phase} -> ${phase}`);
	integer(evidence.at, attempt.updatedAt);
	const next = { ...attempt, ...evidence, phase, updatedAt: evidence.at }; delete (next as Partial<typeof next>).at;
	if (next.run) { validateRun(next.run); requireThat(next.run.ownerSessionFile === next.ownerSessionFile, "Runtime owner mismatch"); }
	if (next.terminal) {
		validateRun(next.terminal.run); text(next.terminal.evidenceDigest); integer(next.terminal.observedAt);
		requireThat(next.terminal.kind === "terminal" && ["succeeded", "failed", "stopped"].includes(next.terminal.outcome), "Invalid terminal evidence");
		requireThat(next.run && digest(next.run) === digest(next.terminal.run) && next.ownerSessionFile === next.terminal.run.ownerSessionFile, "Terminal run mismatch");
	}
	if (next.nonStart) { text(next.nonStart.reason); requireThat(next.nonStart.kind === "not-started" && !next.run && !next.terminal && next.nonStart.launchDigest === next.launchDigest, "Nonstart evidence mismatch"); }
	if (["running", "stopping"].includes(phase)) requireThat(next.run && !next.nonStart, "Active run reference required");
	if (["validating", "succeeded"].includes(phase)) requireThat(next.terminal?.outcome === "succeeded", "Success requires terminal evidence");
	if (phase === "succeeded") text(next.resultDigest);
	if (phase === "ready" && ["launching", "recovery-needed"].includes(attempt.phase)) requireThat(next.nonStart, "Unknown launch cannot be retried");
	if (phase === "failed" && occupiesCapacity(attempt)) requireThat(next.terminal || next.nonStart, "Failure cannot release an unknown writer");
	return next;
}
export function deliveryFenced(delivery: DeliveryRecord): boolean { return ["handoff-pending", "controller-owned", "merged", "closed-unmerged"].includes(delivery.phase); }
export function emptyCoordinatorState(identity: RepoIdentity): CoordinatorState {
	return { schemaVersion: EXECUTION_SCHEMA_VERSION, repo: identity, sequence: 0, epoch: 0, capacity: 0, manifests: [], authorizations: [], activeRevisions: {}, tasks: [], attempts: [], results: [], integrations: [], integrationReceipts: [], deliveries: [], reservations: [], parallelLaunchSets: [], intents: [] };
}

export function validateCoordinatorState(value: unknown): asserts value is CoordinatorState {
	object(value); version(value); repo(value.repo); integer(value.sequence); integer(value.epoch); integer(value.capacity);
	for (const key of ["manifests", "authorizations", "tasks", "attempts", "results", "integrations", "integrationReceipts", "deliveries", "reservations", "parallelLaunchSets", "intents"]) requireThat(Array.isArray(value[key]), `Expected ${key}`);
	const state = value as unknown as CoordinatorState;
	state.manifests.forEach(validateManifest); unique(state.manifests.map(m => `${m.id}:${m.revision}`), "manifest revision");
	for (const m of state.manifests) requireThat(m.repo.id === state.repo.id, "Foreign manifest repository");
	unique(state.authorizations.map(a => a.id), "authorization ID");
	for (const auth of state.authorizations) {
		const manifest = state.manifests.find(m => m.id === auth.manifestId && m.revision === auth.revision); requireThat(manifest, "Missing authorized manifest"); validateAuthorization(manifest, auth);
	}
	const taskOwners = new Map<Id, Id>();
	for (const manifest of state.manifests) for (const task of manifest.tasks) { requireThat(!taskOwners.has(task.id) || taskOwners.get(task.id) === manifest.id, "Task ID shared across manifests"); taskOwners.set(task.id, manifest.id); }
	object(state.activeRevisions);
	for (const [id, revision] of Object.entries(state.activeRevisions)) {
		const manifest = state.manifests.find(m => m.id === id && m.revision === revision); requireThat(manifest, "Missing active manifest");
		const auth = state.authorizations.find(a => a.manifestId === id && a.revision === revision); requireThat(auth, "Missing active authorization"); validateAuthorization(manifest, auth);
	}
	if (state.owner) { integer(state.owner.pid, 1); text(state.owner.processStart); text(state.owner.instanceId); text(state.owner.sessionFile); requireThat(isAbsolute(state.owner.sessionFile) && state.owner.epoch === state.epoch, "Invalid lease owner"); }
	if (state.reconciledEpoch !== undefined) integer(state.reconciledEpoch);
	unique(state.attempts.map(a => a.id), "attempt ID"); unique(state.tasks.map(t => t.taskId), "task record");
	for (const attempt of state.attempts) {
		object(attempt); version(attempt); text(attempt.id); text(attempt.launchDigest); text(attempt.ownerSessionFile); integer(attempt.createdAt); integer(attempt.updatedAt, attempt.createdAt);
		requireThat(isAbsolute(attempt.ownerSessionFile) && Object.hasOwn(ATTEMPT_TRANSITIONS, attempt.phase), "Invalid attempt identity/phase");
		requireThat(["none", "pause", "stop", "cancel"].includes(attempt.intent), "Invalid control intent");
		validateWorkspace(attempt.workspace); strings(attempt.prerequisiteDigests); unique(attempt.prerequisiteDigests, "attempt prerequisite");
		const manifest = state.manifests.find(m => m.id === attempt.manifestId && m.revision === attempt.manifestRevision);
		const task = manifest?.tasks.find(t => t.id === attempt.taskId); requireThat(task && taskRevisionDigest(task) === attempt.taskDigest, "Missing/changed attempt contract");
		requireThat(attempt.baseCommit === manifest!.baseCommit && attempt.workspace.repoId === state.repo.id && isAbsolute(attempt.workspace.path), "Invalid attempt workspace/base");
		requireThat(attempt.workspace.baseCommit === attempt.baseCommit && digest(attempt.workspace.prerequisiteDigests) === digest(attempt.prerequisiteDigests), "Workspace prerequisite mismatch");
		for (const d of attempt.prerequisiteDigests) requireThat(state.results.some(r => r.digest === d), "Missing prerequisite receipt");
		const ancestors = new Set<Id>();
		const includeDependencies = (id: Id): void => { if (ancestors.has(id)) return; ancestors.add(id); manifest!.tasks.find(t => t.id === id)!.dependencies.forEach(includeDependencies); };
		task.dependencies.forEach(includeDependencies);
		const inputs = attempt.prerequisiteDigests.map(d => state.results.find(r => r.digest === d)!);
		requireThat(inputs.every(r => r.repoId === manifest!.repo.id && r.baseCommit === attempt.baseCommit), "Prerequisite receipt base/repository mismatch");
		requireThat(inputs.every(r => ancestors.has(r.taskId) && r.taskDigest === taskRevisionDigest(manifest!.tasks.find(t => t.id === r.taskId)!)), "Unrelated/stale prerequisite receipt");
		if (!["pending", "dependency-blocked", "ready"].includes(attempt.phase)) requireThat(task.dependencies.every(id => inputs.some(r => r.taskId === id)), "Missing required prerequisite result");
		transitionAttempt(attempt, attempt.phase, { at: attempt.updatedAt });
		if (occupiesCapacity(attempt)) requireThat(state.reservations.some(r => r.attemptId === attempt.id), "Unreserved active attempt");
	}
	unique(state.attempts.filter(occupiesCapacity).map(a => a.taskId), "active task writer");
	for (const task of state.tasks) {
		requireThat(state.manifests.some(m => m.id === task.manifestId && m.tasks.some(t => t.id === task.taskId)), "Missing task specification");
		requireThat(Object.hasOwn(ATTEMPT_TRANSITIONS, task.phase) && ["none", "pause", "stop", "cancel"].includes(task.intent), "Invalid task state");
		strings(task.attemptIds); unique(task.attemptIds, "task attempt"); requireThat(task.attemptIds.every(id => state.attempts.some(a => a.id === id && a.taskId === task.taskId)), "Missing task attempt");
		if (task.resultDigest) requireThat(state.results.some(r => r.digest === task.resultDigest && r.taskId === task.taskId), "Missing task result");
	}
	for (const receipt of [...state.results, ...state.integrationReceipts]) {
		object(receipt); version(receipt); const { digest: recorded, ...body } = receipt; requireThat(recorded === receiptDigest(body), "Receipt digest mismatch");
		requireThat(Array.isArray(receipt.checks) && receipt.checks.every(c => c.status === "passed" && c.exitCode === 0), "Receipt contains unvalidated checks"); integer(receipt.validatedAt);
	}
	unique(state.results.map(r => r.digest), "result receipt"); unique(state.integrationReceipts.map(r => r.digest), "integration receipt");
	for (const result of state.results) {
		const attempt = state.attempts.find(a => a.id === result.attemptId); requireThat(attempt && attempt.terminal?.outcome === "succeeded" && attempt.taskId === result.taskId && attempt.taskDigest === result.taskDigest && attempt.baseCommit === result.baseCommit && result.repoId === state.repo.id, "Result producer mismatch");
		requireThat(digest(attempt.prerequisiteDigests) === digest(result.prerequisiteDigests), "Result prerequisites mismatch");
		const spec = state.manifests.find(m => m.id === attempt.manifestId && m.revision === attempt.manifestRevision)!.tasks.find(t => t.id === attempt.taskId)!;
		validateRequiredChecks(spec.checks, result.checks, attempt.createdAt);
		if (result.output.kind === "artifact") { text(result.output.path); text(result.output.digest); requireThat(isAbsolute(result.output.path), "Invalid artifact path"); }
		else { requireThat(result.output.kind === "commits", "Invalid result output"); text(result.output.from); text(result.output.to); strings(result.output.commits); strings(result.output.paths); }
	}
	for (const a of state.attempts) if (a.phase === "succeeded") requireThat(state.results.some(r => r.digest === a.resultDigest && r.attemptId === a.id), "Success missing receipt");
	unique(state.reservations.map(r => r.id), "reservation ID"); unique(state.reservations.map(r => r.workspaceId), "workspace writer"); unique(state.reservations.map(r => r.workspacePath), "workspace path writer");
	for (const r of state.reservations) {
		text(r.id); text(r.workspaceId); requireThat(isAbsolute(r.workspacePath), "Invalid reserved path"); integer(r.slots);
		requireThat(!!r.attemptId !== !!r.integrationId, "Reservation must identify one writer");
		if (r.attemptId) { const a = state.attempts.find(a => a.id === r.attemptId); requireThat(a && a.workspace.id === r.workspaceId && a.workspace.path === r.workspacePath && r.slots === 1, "Invalid attempt reservation"); }
		if (r.integrationId) requireThat(state.integrations.some(i => i.id === r.integrationId && i.workspace.id === r.workspaceId && i.workspace.path === r.workspacePath), "Missing integration writer");
	}
	requireThat(state.reservations.reduce((sum, r) => sum + r.slots, 0) <= state.capacity, "Repository capacity exceeded");
	unique(state.reservations.filter(r => r.attemptId).map(r => r.attemptId!), "attempt reservation");
	unique(state.reservations.filter(r => r.integrationId).map(r => r.integrationId!), "integration reservation");
	unique(state.integrations.map(i => i.id), "integration intent");
	for (const i of state.integrations) {
		text(i.id); text(i.beforeCommit); integer(i.createdAt); validateWorkspace(i.workspace); strings(i.inputDigests); unique(i.inputDigests, "integration input");
		requireThat(i.workspace.repoId === state.repo.id, "Foreign integration workspace");
		requireThat(["planned", "composing", "validating", "complete", "recovery-needed"].includes(i.phase), "Invalid integration phase");
		requireThat(state.manifests.some(m => m.deliveryGroups.some(d => d.id === i.deliveryGroupId)), "Missing integration delivery");
		requireThat(i.inputDigests.every(d => state.results.some(r => r.digest === d)), "Missing integration input");
		if (i.phase !== "complete") requireThat(state.reservations.some(r => r.integrationId === i.id), "Unreserved integration writer");
	}
	for (const r of state.integrationReceipts) {
		requireThat(state.integrations.some(i => i.id === r.intentId && i.deliveryGroupId === r.deliveryGroupId && digest(i.inputDigests) === digest(r.inputDigests) && i.beforeCommit === r.beforeCommit && i.afterCommit === r.afterCommit), "Integration receipt mismatch");
		text(r.beforeCommit); text(r.afterCommit);
	}
	for (const i of state.integrations.filter(i => i.phase === "complete")) requireThat(state.integrationReceipts.some(r => r.intentId === i.id), "Completed integration missing receipt");
	unique(state.deliveries.map(d => d.groupId), "delivery record");
	unique(state.parallelLaunchSets.map(s => s.id), "parallel launch set");
	for (const set of state.parallelLaunchSets) {
		text(set.id); text(set.groupId); strings(set.attemptIds); unique(set.attemptIds, "launch set attempt");
		requireThat(["reserved", "met", "unmet"].includes(set.instruction), "Invalid parallel instruction state");
		requireThat(state.manifests.some(m => m.constraints.parallelGroups.some(g => g.id === set.groupId)), "Missing parallel group");
		requireThat(set.attemptIds.every(id => state.attempts.some(a => a.id === id)), "Missing launch set attempt");
	}
	unique(state.intents.map(i => i.id), "intent ID");
	for (const intent of state.intents) {
		text(intent.id); text(intent.sessionFile); text(intent.authorizationId); text(intent.targetId);
		requireThat(isAbsolute(intent.sessionFile) && ["admit", "revision", "pause", "resume", "retry", "cancel"].includes(intent.kind), "Invalid coordinator intent");
		if (intent.manifest) validateManifest(intent.manifest);
		if (intent.immediate !== undefined) requireThat(typeof intent.immediate === "boolean", "Invalid immediate intent");
		if (intent.consumedAt !== undefined) integer(intent.consumedAt);
	}
	for (const d of state.deliveries) {
		requireThat(state.manifests.some(m => m.deliveryGroups.some(g => g.id === d.groupId)), "Missing delivery group");
		requireThat(["pending", "integrating", "blocked", "ready", "handoff-pending", "controller-owned", "merged", "closed-unmerged"].includes(d.phase), "Invalid delivery phase");
		if (["ready", "handoff-pending", "controller-owned", "merged", "closed-unmerged"].includes(d.phase)) {
			const receipt = state.integrationReceipts.find(r => r.digest === d.integrationDigest && r.deliveryGroupId === d.groupId); requireThat(receipt, "Delivery missing validated integration");
			const groups = state.manifests.filter(m => state.activeRevisions[m.id] === m.revision).flatMap(manifest => manifest.deliveryGroups.map(group => ({ manifest, group }))).filter(({ group }) => group.id === d.groupId);
			requireThat(groups.length > 0, "Delivery has no active group");
			for (const { manifest, group } of groups) {
				requireThat(group.requiredTaskIds.every(id => receipt.inputDigests.some(input => state.results.some(r => r.digest === input && r.taskId === id && r.repoId === manifest.repo.id && r.baseCommit === manifest.baseCommit && r.taskDigest === taskRevisionDigest(manifest.tasks.find(t => t.id === id)!)))), "Delivery missing required result or contains stale result");
				validateRequiredChecks(group.checks, receipt.checks, state.integrations.find(i => i.id === receipt.intentId)!.createdAt);
			}
		}
		if (deliveryFenced(d)) requireThat(d.handoff && d.handoff.deliveryGroupId === d.groupId && d.handoff.integrationDigest === d.integrationDigest, "Missing handoff intent");
		if (["controller-owned", "merged", "closed-unmerged"].includes(d.phase)) requireThat(d.acknowledgement?.requestId === d.handoff?.id && d.acknowledgement, "Missing ownership acknowledgement");
		if (d.phase === "merged") { requireThat(d.mergeEvidence, "Missing verified merge evidence"); text(d.mergeEvidence.commit); text(d.mergeEvidence.url); }
	}
	canonicalJson(state);
}

/** Validate persisted history as well as the candidate; callbacks cannot erase fences. */
export function validateStateChange(previous: CoordinatorState, next: CoordinatorState): void {
	validateCoordinatorState(next); requireThat(digest(previous.repo) === digest(next.repo), "Repository identity changed");
	for (const key of ["manifests", "authorizations", "results", "integrationReceipts"] as const) for (const record of previous[key]) requireThat(next[key].some(candidate => digest(candidate) === digest(record)), `Immutable ${key} changed`);
	for (const old of previous.attempts) {
		const candidate = next.attempts.find(a => a.id === old.id); requireThat(candidate, "Attempt history removed");
		for (const key of ["id", "taskId", "manifestId", "manifestRevision", "taskDigest", "ownerSessionFile", "launchDigest", "workspace", "baseCommit", "prerequisiteDigests", "createdAt"] as const) requireThat(digest(old[key]) === digest(candidate[key]), `Attempt contract changed: ${key}`);
		for (const key of ["run", "operationId", "terminal", "nonStart", "resultDigest"] as const) if (old[key] !== undefined) requireThat(candidate[key] !== undefined && digest(old[key]) === digest(candidate[key]), `Attempt evidence changed: ${key}`);
		transitionAttempt({ ...old, ...(candidate.run ? { run: candidate.run } : {}) }, candidate.phase, { at: candidate.updatedAt, ...(candidate.terminal ? { terminal: candidate.terminal } : {}), ...(candidate.nonStart ? { nonStart: candidate.nonStart } : {}), ...(candidate.resultDigest ? { resultDigest: candidate.resultDigest } : {}) });
	}
	for (const r of previous.reservations) {
		const retained = next.reservations.find(n => n.id === r.id);
		if (retained) requireThat(digest(retained) === digest(r), "Reservation changed");
		else if (r.attemptId) requireThat(canReleaseAttempt(next.attempts.find(a => a.id === r.attemptId)!), "Unknown writer reservation cannot be released");
		else requireThat(next.integrations.some(i => i.id === r.integrationId && i.phase === "complete") && next.integrationReceipts.some(i => i.intentId === r.integrationId), "Unknown integration reservation cannot be released");
	}
	for (const old of previous.integrations) {
		const current = next.integrations.find(i => i.id === old.id); requireThat(current, "Integration history removed");
		for (const key of ["id", "deliveryGroupId", "workspace", "inputDigests", "beforeCommit", "createdAt"] as const) requireThat(digest(old[key]) === digest(current[key]), `Integration intent changed: ${key}`);
		if (old.afterCommit) requireThat(current.afterCommit === old.afterCommit, "Integration commit changed");
		if (old.phase === "complete") requireThat(current.phase === "complete", "Completed integration reopened");
	}
	for (const old of previous.deliveries.filter(deliveryFenced)) {
		const current = next.deliveries.find(d => d.groupId === old.groupId);
		const confirmedNonTransfer = old.phase === "handoff-pending" && current?.phase === "ready" && current.nonTransfer?.requestId === old.handoff?.id;
		requireThat(current && (deliveryFenced(current) || confirmedNonTransfer), "Delivery ownership fence removed");
		if (confirmedNonTransfer) { text(current.nonTransfer!.reason); integer(current.nonTransfer!.observedAt); }
		requireThat(digest(current.handoff) === digest(old.handoff) && current.integrationDigest === old.integrationDigest, "Controller-owned delivery mutated");
		if (old.acknowledgement) requireThat(current.acknowledgement && digest(old.acknowledgement) === digest(current.acknowledgement) && current.phase !== "handoff-pending", "Controller ownership lost");
		if (["merged", "closed-unmerged"].includes(old.phase)) requireThat(digest(current) === digest(old), "Terminal delivery changed");
		const belongs = (a: TaskAttempt) => next.manifests.find(m => m.id === a.manifestId && m.revision === a.manifestRevision)?.tasks.find(t => t.id === a.taskId)?.deliveryGroupId === old.groupId;
		for (const a of next.attempts.filter(belongs)) requireThat(previous.attempts.some(p => p.id === a.id && digest(p) === digest(a)), "Attempt mutation after delivery handoff");
		for (const i of next.integrations.filter(i => i.deliveryGroupId === old.groupId)) requireThat(previous.integrations.some(p => p.id === i.id && digest(p) === digest(i)), "Integration mutation after delivery handoff");
	}
}
