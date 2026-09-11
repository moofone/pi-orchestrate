import {
	digest, sourceDigest, stableTaskId, taskRevisionDigest,
	type AttemptRuntime, type CheckExecutor, type CheckSpec, type CoordinatorState,
	type DeliveryAdapter, type DeliveryObservation, type ExecutionAuthorization, type ExecutionManifest,
	type LaunchOutcome, type LaunchRequest, type Observation, type ResourceReservation, type TaskAttempt,
	type WorkspaceAdapter, type WorkspaceOutcome, type WorkspaceRef,
} from "../../../src/lib/execution-contract.ts";

/** Deterministic defaults; lanes inject outcomes rather than infer success from text. */
export function fakeManifest(taskCount = 1): ExecutionManifest {
	const id = "manifest-a", commonDir = "/fixture/repo/.git";
	const taskIds = Array.from({ length: taskCount }, (_, i) => stableTaskId(id, `task-${i + 1}`));
	return {
		schemaVersion: 1, id, revision: 1, source: { path: "/fixture/plan.md", bytes: "Plan\n", digest: sourceDigest("Plan\n") },
		repo: { commonDir, id: digest(commonDir) }, baseCommit: "a".repeat(40), scope: "feature-a", preset: "plan-driven",
		features: [{ id: "feature-a", title: "Feature A", scope: "feature-a" }],
		deliveryGroups: [{ id: "delivery-a", featureIds: ["feature-a"], requiredTaskIds: taskIds, checks: [], policy: "local", completion: "validated", ownerId: "feature-a" }],
		tasks: taskIds.map(id => ({ id, featureId: "feature-a", deliveryGroupId: "delivery-a", text: `Implement ${id}`, mode: "mutation", dependencies: [], scope: ["src/"], profile: {}, checks: [], provenance: [] })),
		constraints: { capacity: Math.max(1, taskCount), parallelGroups: [], provenance: [] }, provenance: [],
	};
}
export function fakeAuthorization(manifest = fakeManifest()): ExecutionAuthorization {
	return { id: `approval-${manifest.id}-${manifest.revision}`, manifestId: manifest.id, revision: manifest.revision, sourceDigest: manifest.source.digest, manifestDigest: digest(manifest), repoId: manifest.repo.id, baseCommit: manifest.baseCommit, scope: manifest.scope, capacity: manifest.constraints.capacity, publication: false, approvedBy: "/fixture/session.jsonl", approvedAt: 1 };
}
export function fakeWorkspace(manifest = fakeManifest(), id = "workspace-a"): WorkspaceRef {
	return { id, path: `/fixture/${id}`, branch: id, repoId: manifest.repo.id, baseCommit: manifest.baseCommit, prerequisiteDigests: [] };
}
export function fakeAttempt(manifest = fakeManifest(), index = 0): TaskAttempt {
	const task = manifest.tasks[index]!;
	return { schemaVersion: 1, id: `attempt-${index + 1}`, taskId: task.id, manifestId: manifest.id, manifestRevision: manifest.revision, taskDigest: taskRevisionDigest(task), ownerSessionFile: "/fixture/session.jsonl", launchDigest: digest([task.id, "launch"]), workspace: fakeWorkspace(manifest, `workspace-${index + 1}`), baseCommit: manifest.baseCommit, prerequisiteDigests: [], phase: "preparing", intent: "none", createdAt: 1, updatedAt: 1 };
}
export function fakeReservation(attempt: TaskAttempt): ResourceReservation {
	return { id: `reservation-${attempt.id}`, attemptId: attempt.id, workspaceId: attempt.workspace.id, workspacePath: attempt.workspace.path, slots: 1 };
}
export function admitFakeManifest(state: CoordinatorState, manifest: ExecutionManifest): void {
	state.manifests.push(manifest); state.authorizations.push(fakeAuthorization(manifest)); state.activeRevisions[manifest.id] = manifest.revision;
	state.tasks.push(...manifest.tasks.map(t => ({ taskId: t.id, manifestId: manifest.id, phase: "ready" as const, intent: "none" as const, attemptIds: [] })));
}
export function fakeCheck(): CheckSpec { return { id: "check-a", cwd: ".", argv: ["node", "--test"], runner: "node", expectedEvidence: { reportPath: "report.json", requiredTests: ["test-a"] } }; }
export class FakeAttemptRuntime implements AttemptRuntime {
	launches: LaunchRequest[] = [];
	controls: { runId: string; action: string; sessionFile: string }[] = [];
	observations = new Map<string, Observation>();
	launchOutcomes: LaunchOutcome[] = [];
	capabilities: Awaited<ReturnType<AttemptRuntime["probe"]>> = { available: true, capacity: 6, durableOperationLookup: false, controls: ["stop"], profiles: ["agent", "model", "tools", "context", "supervisor", "intercom", "thinking", "maxTurns", "timeoutMs"] };
	listeners = new Set<Parameters<AttemptRuntime["subscribe"]>[0]>();
	beforeLaunchReply?: (request: LaunchRequest) => void;
	async probe() { return structuredClone(this.capabilities); }
	async launch(request: LaunchRequest): Promise<LaunchOutcome> {
		this.launches.push(structuredClone(request)); this.beforeLaunchReply?.(request);
		return this.launchOutcomes.shift() ?? { kind: "unknown", reason: "No fake launch outcome configured" };
	}
	async observe(attempt: TaskAttempt): Promise<Observation> { return this.observations.get(attempt.id) ?? { kind: "unknown", reason: "No fake observation configured" }; }
	async control(run: Parameters<AttemptRuntime["control"]>[0], action: Parameters<AttemptRuntime["control"]>[1], sessionFile: string): ReturnType<AttemptRuntime["control"]> {
		this.controls.push({ runId: run.runId, action, sessionFile });
		return sessionFile === run.ownerSessionFile ? { kind: "acknowledged", run } : { kind: "forbidden", reason: "Foreign runtime session" };
	}
	subscribe(listener: Parameters<AttemptRuntime["subscribe"]>[0]) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	emit(event: Parameters<Parameters<AttemptRuntime["subscribe"]>[0]>[0]) { for (const listener of this.listeners) listener(event); }
}
export class FakeWorkspaceAdapter implements WorkspaceAdapter {
	preparations: Parameters<WorkspaceAdapter["prepare"]>[0][] = [];
	compositions: Parameters<WorkspaceAdapter["compose"]>[0][] = [];
	outcomes: WorkspaceOutcome[] = [];
	inspections = new Map<string, Awaited<ReturnType<WorkspaceAdapter["inspect"]>>>();
	async prepare(request: Parameters<WorkspaceAdapter["prepare"]>[0]): Promise<WorkspaceOutcome> { this.preparations.push(structuredClone(request)); return this.outcomes.shift() ?? { kind: "unknown", reason: "No fake preparation configured" }; }
	async compose(request: Parameters<WorkspaceAdapter["compose"]>[0]): Promise<WorkspaceOutcome> { this.compositions.push(structuredClone(request)); return this.outcomes.shift() ?? { kind: "unknown", reason: "No fake composition configured" }; }
	async inspect(workspace: WorkspaceRef): ReturnType<WorkspaceAdapter["inspect"]> { return this.inspections.get(workspace.id) ?? { kind: "unknown", reason: "No fake inspection configured" }; }
}
export class FakeCheckExecutor implements CheckExecutor {
	calls: { check: CheckSpec; context: Parameters<CheckExecutor["execute"]>[1] }[] = [];
	evidence: Awaited<ReturnType<CheckExecutor["execute"]>>[] = [];
	async execute(check: CheckSpec, context: Parameters<CheckExecutor["execute"]>[1]): ReturnType<CheckExecutor["execute"]> {
		this.calls.push(structuredClone({ check, context }));
		return this.evidence.shift() ?? { checkId: check.id, invocationId: context.invocationId, startedAt: context.startedAt, finishedAt: context.startedAt, exitCode: 1, executedTests: [], skippedTests: [], status: "unknown", reason: "No fake evidence configured" };
	}
	validateEvidence(check: CheckSpec, evidence: Parameters<CheckExecutor["validateEvidence"]>[1], context: Parameters<CheckExecutor["validateEvidence"]>[2]) {
		const valid = evidence.checkId === check.id && evidence.invocationId === context.invocationId && evidence.startedAt >= context.notBefore && evidence.status === "passed" && evidence.exitCode === 0 && (check.runner === "command" || (evidence.executedTests.length > 0 && check.expectedEvidence.requiredTests.every(t => evidence.executedTests.includes(t))));
		return { valid, reasons: valid ? [] : ["Fake evidence rejected"] };
	}
}
export class FakeDeliveryAdapter implements DeliveryAdapter {
	handoffs: Parameters<DeliveryAdapter["handoff"]>[0][] = [];
	outcomes: DeliveryObservation[] = [];
	observations = new Map<string, DeliveryObservation>();
	async handoff(request: Parameters<DeliveryAdapter["handoff"]>[0]): Promise<DeliveryObservation> { this.handoffs.push(structuredClone(request)); return this.outcomes.shift() ?? { kind: "unknown", reason: "No fake handoff configured" }; }
	async observe(request: Parameters<DeliveryAdapter["observe"]>[0]): Promise<DeliveryObservation> { return this.observations.get(request.id) ?? { kind: "unknown", reason: "No fake delivery observation configured" }; }
}
