import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExecutionScheduler } from "../src/lib/execution-scheduler.ts";
import { createExecutionStore, createCoordinatorOwner } from "../src/lib/execution-store.ts";
import { digest, receiptDigest, type ExecutionManifest, type LaunchRequest, type LaunchOutcome, type ResultReceipt, type TaskAttempt } from "../src/lib/execution-contract.ts";
import { fakeManifest, fakeAuthorization, FakeAttemptRuntime, FakeWorkspaceAdapter, FakeCheckExecutor, FakeDeliveryAdapter } from "./fixtures/execution/fakes.ts";

function barrier<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function until(predicate: () => boolean) { for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail("condition did not settle"); }
function appendIntentFromProcess(h: ReturnType<typeof harness>, intent: { id: string; authorizationId: string; kind: "pause" | "resume"; targetId: string }): void {
	const storeModule = resolve(process.cwd(), "src/lib/execution-store.ts");
	const contractModule = resolve(process.cwd(), "src/lib/execution-contract.ts");
	const script = `
		const { createExecutionStore } = await import(${JSON.stringify(storeModule)});
		const { digest } = await import(${JSON.stringify(contractModule)});
		const root = process.argv[1], commonDir = process.argv[2], sessionFile = process.argv[3], body = JSON.parse(process.argv[4]);
		const store = createExecutionStore({ stateRoot: root, repo: { commonDir, id: digest(commonDir) } });
		store.appendIntent({ ...body, sessionFile });
	`;
	execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, h.options.store.dir.replace(/\/execution\/[^/]+$/, ""), h.manifest.repo.commonDir, h.options.owner.sessionFile, JSON.stringify(intent)], { stdio: "pipe" });
}
class Runtime extends FakeAttemptRuntime {
	gates = new Map<string, ReturnType<typeof barrier<LaunchOutcome>>>();
	intervals = new Map<string, { start: number; end?: number }>();
	async launch(request: LaunchRequest): Promise<LaunchOutcome> {
		this.launches.push(structuredClone(request)); this.intervals.set(request.attempt.id, { start: performance.now() });
		const gate = barrier<LaunchOutcome>(); this.gates.set(request.attempt.id, gate); return gate.promise;
	}
	running(id: string) {
		const request = this.launches.find(r => r.attempt.id === id)!;
		const outcome = { kind: "known-running" as const, run: { runId: `run-${id}`, artifactDir: `/artifacts/${id}`, ownerSessionFile: request.attempt.ownerSessionFile } };
		this.observations.set(id, outcome); this.gates.get(id)!.resolve(outcome);
	}
	finish(id: string, outcome: "succeeded" | "stopped" | "failed" = "succeeded") {
		const observation = this.observations.get(id)!; assert.equal(observation.kind, "known-running"); if (observation.kind !== "known-running") return;
		this.intervals.get(id)!.end = performance.now();
		this.observations.set(id, { kind: "known-terminal", evidence: { kind: "terminal", run: observation.run, outcome, evidenceDigest: digest([id, outcome]), observedAt: Date.now() } }); this.emit({ attemptId: id });
	}
}
function harness(count = 1, setup?: (m: ExecutionManifest) => void, rechecks = 0) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "execution-scheduler-"))); const session = join(root, "session.jsonl"); writeFileSync(session, "");
	const manifest = fakeManifest(count); manifest.repo = { commonDir: root, id: digest(root) }; setup?.(manifest);
	const store = createExecutionStore({ stateRoot: root, repo: manifest.repo });
	const runtime = new Runtime(), workspaces = new FakeWorkspaceAdapter();
	workspaces.prepare = async request => { workspaces.preparations.push(request); return { kind: "prepared", workspace: request.workspace, head: request.workspace.baseCommit }; };
	const options = {
		store, owner: createCoordinatorOwner(session, "test"), runtime, workspaces, checks: new FakeCheckExecutor(), delivery: new FakeDeliveryAdapter(), maxCapacityRechecks: rechecks, recheckDelayMs: 5,
		workspace: ({ attemptId, manifest, prerequisites }: { attemptId: string; manifest: ExecutionManifest; prerequisites: ResultReceipt[] }) => ({ id: attemptId, path: join(root, attemptId), branch: attemptId, repoId: manifest.repo.id, baseCommit: manifest.baseCommit, prerequisiteDigests: prerequisites.map(r => r.digest) }),
		createReceipt: async ({ attempt }: { attempt: TaskAttempt }): Promise<ResultReceipt> => {
			const body: Omit<ResultReceipt, "digest"> = { schemaVersion: 1, attemptId: attempt.id, taskId: attempt.taskId, taskDigest: attempt.taskDigest, repoId: manifest.repo.id, baseCommit: attempt.baseCommit, prerequisiteDigests: attempt.prerequisiteDigests, output: { kind: "artifact", path: join(root, `${attempt.id}.result`), digest: digest(attempt.id) }, checks: [], validatedAt: Date.now() };
			return { ...body, digest: receiptDigest(body) };
		},
	};
	const scheduler = new ExecutionScheduler(options);
	return { scheduler, options, runtime, workspaces, store, manifest };
}
function group(m: ExecutionManifest) { m.constraints.parallelGroups = [{ id: "five", taskIds: m.tasks.slice(0, 5).map(t => t.id), simultaneous: 5, provenance: { field: "parallel", origin: "explicit" } }]; }
async function begin(h: ReturnType<typeof harness>, capacity = h.manifest.constraints.capacity) { await h.scheduler.start(); h.scheduler.authorizeCapacity(capacity); h.scheduler.admit(h.manifest, fakeAuthorization(h.manifest)); await h.scheduler.reconcile(); }

test("five simultaneous launches overlap Feature B at six slots; reconcile triggers do not duplicate", async () => {
	const h = harness(6, m => { group(m); m.features.push({ id: "b", title: "B", scope: "b" }); m.deliveryGroups[0]!.featureIds.push("b"); m.tasks[5]!.featureId = "b"; });
	await begin(h); await Promise.all(Array.from({ length: 12 }, () => h.scheduler.reconcile())); await until(() => h.runtime.launches.length === 6);
	assert.equal(h.store.read().reservations.length, 6); assert.equal(new Set(h.workspaces.preparations.map(p => p.workspace.path)).size, 6);
	for (const id of h.runtime.gates.keys()) h.runtime.running(id);
	await until(() => h.store.read().attempts.every(a => a.phase === "running"));
	const intervals = [...h.runtime.intervals.values()]; assert.equal(intervals.length, 6); assert.ok(intervals.every(i => i.end === undefined));
	const lastStart = Math.max(...intervals.map(i => i.start)); const first = h.runtime.launches[0]!.attempt.id; h.runtime.finish(first);
	await until(() => h.store.read().results.length === 1); assert.ok(h.runtime.intervals.get(first)!.end! >= lastStart);
	await h.scheduler.shutdown();
});

test("dependent consumes only prerequisites before unrelated siblings finish", async () => {
	const h = harness(6, m => { group(m); m.tasks[5]!.dependencies = m.tasks.slice(0, 2).map(t => t.id); }); await begin(h);
	await until(() => h.runtime.launches.length === 5); for (const id of h.runtime.gates.keys()) h.runtime.running(id);
	await until(() => h.store.read().attempts.every(a => a.phase === "running"));
	for (const request of h.runtime.launches.slice(0, 2)) h.runtime.finish(request.attempt.id);
	await until(() => h.runtime.launches.length === 6);
	const dependent = h.runtime.launches[5]!.attempt; assert.equal(dependent.prerequisiteDigests.length, 2);
	assert.equal(h.store.read().attempts.filter(a => a.phase === "running").length, 3);
	assert.deepEqual(h.workspaces.preparations.at(-1)!.prerequisites.map(r => r.taskId), h.manifest.tasks[5]!.dependencies);
	await h.scheduler.shutdown();
});

test("admit a new feature while running and target pause without affecting other feature", async () => {
	const h = harness(); await begin(h, 2); await until(() => h.runtime.launches.length === 1); h.runtime.running(h.runtime.launches[0]!.attempt.id);
	const next = fakeManifest(); next.id = "manifest-b"; next.repo = h.manifest.repo; next.tasks[0]!.id = "task-b"; next.tasks[0]!.featureId = "b"; next.tasks[0]!.deliveryGroupId = "delivery-b"; next.features[0]!.id = "b"; next.deliveryGroups[0] = { ...next.deliveryGroups[0]!, id: "delivery-b", featureIds: ["b"], requiredTaskIds: ["task-b"] };
	await h.scheduler.control({ targetId: "feature-a", action: "pause" }); h.scheduler.admit(next, fakeAuthorization(next)); await until(() => h.runtime.launches.length === 2);
	assert.equal(h.store.read().tasks[0]!.intent, "pause"); assert.equal(h.runtime.controls.length, 0); await h.scheduler.shutdown();
});

test("partial explicit group capacity loss retains accepted and unknown, never serializes fifth", async () => {
	const h = harness(5, group); await begin(h); await until(() => h.runtime.launches.length === 5);
	const ids = h.runtime.launches.map(r => r.attempt.id); ids.slice(0, 3).forEach(id => h.runtime.running(id));
	h.runtime.gates.get(ids[3]!)!.resolve({ kind: "unknown", reason: "lost acknowledgement" });
	const fifth = h.runtime.launches[4]!.attempt;
	h.runtime.gates.get(fifth.id)!.resolve({ kind: "capacity-deferred", reason: "external occupancy changed", evidence: { kind: "not-started", launchDigest: fifth.launchDigest, reason: "rejected" } });
	await until(() => h.store.read().reservations.length === 4); assert.equal(h.store.read().parallelLaunchSets[0]!.instruction, "unmet");
	h.runtime.finish(ids[0]!); await until(() => h.store.read().results.length === 1);
	await h.scheduler.reconcile(); assert.equal(h.runtime.launches.length, 5); assert.equal(h.store.read().reservations.length, 3);
	await assert.rejects(h.scheduler.control({ targetId: fifth.taskId, action: "retry" }), /approved manifest revision/);
	await h.scheduler.shutdown();
});

test("immediate pause stop acknowledgement holds reservation until terminal evidence", async () => {
	const h = harness(); await begin(h); await until(() => h.runtime.launches.length === 1); const id = h.runtime.launches[0]!.attempt.id; h.runtime.running(id);
	await until(() => h.store.read().attempts[0]!.phase === "running"); await h.scheduler.control({ targetId: "feature-a", action: "pause", immediate: true });
	assert.equal(h.store.read().attempts[0]!.phase, "stopping"); assert.equal(h.store.read().reservations.length, 1); assert.equal(h.runtime.controls.length, 1);
	h.runtime.finish(id, "stopped"); await until(() => h.store.read().reservations.length === 0); assert.equal(h.store.read().results.length, 0); await h.scheduler.shutdown();
});

test("clean same-PID restart fences late acknowledgement and preserves unknown reservation", async () => {
	const h = harness(); await begin(h); await until(() => h.runtime.launches.length === 1); const id = h.runtime.launches[0]!.attempt.id;
	await h.scheduler.shutdown(); const next = new ExecutionScheduler({ ...h.options, owner: { ...h.options.owner, instanceId: "reload" } }); await next.start();
	assert.equal(h.store.read().attempts[0]!.phase, "recovery-needed"); assert.equal(h.store.read().reservations.length, 1);
	h.runtime.running(id); await new Promise(r => setTimeout(r, 20)); assert.equal(h.store.read().attempts[0]!.run, undefined);
	await next.reconcile(); assert.equal(h.store.read().attempts[0]!.phase, "running"); assert.equal(h.runtime.launches.length, 1); await next.shutdown();
});

test("revision preserves immutable running contract but old receipt cannot unblock changed dependency", async () => {
	const h = harness(2, m => { m.tasks[1]!.dependencies = [m.tasks[0]!.id]; }); await begin(h); await until(() => h.runtime.launches.length === 1);
	const id = h.runtime.launches[0]!.attempt.id; h.runtime.running(id); await until(() => h.store.read().attempts[0]!.phase === "running");
	const revised = structuredClone(h.manifest); revised.revision++; revised.tasks[0]!.text = "Changed approved contract";
	h.scheduler.revise(revised, fakeAuthorization(revised)); h.runtime.finish(id); await until(() => h.runtime.launches.length === 2);
	assert.equal(h.runtime.launches[1]!.attempt.taskId, revised.tasks[0]!.id); assert.equal(h.runtime.launches[1]!.attempt.manifestRevision, 2);
	assert.equal(h.store.read().results.length, 1); assert.equal(h.store.read().tasks[1]!.phase, "dependency-blocked"); await h.scheduler.shutdown();
});

test("capacity starts zero, reduction cannot evict workers, budget rejection never busy retries", async () => {
	const h = harness(); await h.scheduler.start(); h.scheduler.admit(h.manifest, fakeAuthorization(h.manifest)); await h.scheduler.reconcile(); assert.equal(h.runtime.launches.length, 0); assert.equal(h.store.read().capacity, 0);
	h.scheduler.authorizeCapacity(1); await until(() => h.runtime.launches.length === 1); assert.throws(() => h.scheduler.authorizeCapacity(0), /capacity exceeded/);
	const a = h.runtime.launches[0]!.attempt; h.runtime.gates.get(a.id)!.resolve({ kind: "rejected-before-start", category: "budget", reason: "budget exhausted", evidence: { kind: "not-started", launchDigest: a.launchDigest, reason: "budget" } });
	await until(() => h.store.read().attempts[0]!.phase === "failed"); for (let i = 0; i < 5; i++) await h.scheduler.reconcile(); assert.equal(h.runtime.launches.length, 1); assert.equal(h.store.read().reservations.length, 0); await h.scheduler.shutdown();
});

test("receipt validation failure remains reserved and does not busy retry", async () => {
	const h = harness(); let calls = 0; h.options.createReceipt = async () => { calls++; throw new Error("scope verification failed"); };
	await begin(h); await until(() => h.runtime.launches.length === 1); const id = h.runtime.launches[0]!.attempt.id; h.runtime.running(id); await until(() => h.store.read().attempts[0]!.phase === "running"); h.runtime.finish(id);
	await until(() => h.store.read().attempts[0]!.phase === "recovery-needed"); await h.scheduler.reconcile(); assert.equal(calls, 1); assert.equal(h.store.read().reservations.length, 1); assert.equal(h.store.read().results.length, 0); await h.scheduler.shutdown();
});


test("unknown, stale and mismatched intents cannot block a later authorized intent or grant capacity", async () => {
	const h = harness(); await h.scheduler.start(); h.scheduler.admit(h.manifest, fakeAuthorization(h.manifest));
	const revised = structuredClone(h.manifest); revised.revision++; h.scheduler.revise(revised, fakeAuthorization(revised)); await h.scheduler.reconcile();
	const sessionFile = h.options.owner.sessionFile;
	const intents = [
		{ id: "unknown", authorizationId: "not-an-approval", targetId: "feature-a" },
		{ id: "stale", authorizationId: fakeAuthorization(h.manifest).id, targetId: "feature-a" },
		{ id: "mismatch", authorizationId: fakeAuthorization(revised).id, targetId: "other-feature" },
		{ id: "valid", authorizationId: fakeAuthorization(revised).id, targetId: "feature-a" },
	];
	for (const intent of intents) h.store.appendIntent({ ...intent, sessionFile, kind: "pause" });
	await h.scheduler.reconcile(); assert.ok(h.store.read().intents.every(i => i.consumedAt !== undefined));
	assert.equal(h.store.read().tasks[0]!.intent, "pause"); assert.equal(h.store.read().capacity, 0); assert.match(h.scheduler.progress().error!, /mismatch.*Mismatched intent target/);
	await h.scheduler.shutdown();
});

test("stable-directory wake consumes repeated cross-process intents after startup events drain", async () => {
	const h = harness(); await begin(h); await until(() => h.runtime.launches.length === 1);
	const attempt = h.runtime.launches[0]!.attempt; h.runtime.running(attempt.id); await until(() => h.store.read().attempts[0]!.phase === "running");
	await h.scheduler.control({ targetId: attempt.taskId, action: "pause" }); await until(() => h.store.read().tasks[0]!.intent === "pause");
	// Let acquisition/recovery/admission and their atomic renames settle before
	// submitting from another Node process. This specifically exercises a watcher
	// that remains attached to the stable directory, not the replaced inode.
	await new Promise(resolve => setTimeout(resolve, 100));
	appendIntentFromProcess(h, { id: "stale-before-valid", authorizationId: "missing-authorization", kind: "resume", targetId: attempt.taskId });
	await until(() => h.store.read().intents.some(i => i.id === "stale-before-valid" && i.consumedAt !== undefined));
	appendIntentFromProcess(h, { id: "valid-after-stale", authorizationId: fakeAuthorization(h.manifest).id, kind: "resume", targetId: attempt.taskId });
	await until(() => h.store.read().intents.some(i => i.id === "valid-after-stale" && i.consumedAt !== undefined && h.store.read().tasks[0]!.intent === "none"));
	assert.equal(h.store.read().tasks[0]!.intent, "none");
	await h.scheduler.shutdown();
});

test("shutdown closes the durable watcher before relinquishing and cannot consume later writes", async () => {
	const h = harness(); await h.scheduler.start();
	assert.ok((h.scheduler as unknown as { stateWatcher?: unknown }).stateWatcher);
	await h.scheduler.shutdown();
	assert.equal((h.scheduler as unknown as { stateWatcher?: unknown }).stateWatcher, undefined);
	appendIntentFromProcess(h, { id: "after-shutdown", authorizationId: "missing-authorization", kind: "resume", targetId: "task-1" });
	await new Promise(resolve => setTimeout(resolve, 50));
	assert.equal(h.store.read().intents.find(i => i.id === "after-shutdown")?.consumedAt, undefined);
});

test("cross-session admission requires the full persisted approval and rejects changed contract", async () => {
	const h = harness(); await h.scheduler.start(); const owner = h.store.read().owner!;
	h.store.transact(owner, state => { state.manifests.push(h.manifest); state.authorizations.push(fakeAuthorization(h.manifest)); });
	const altered = structuredClone(h.manifest); altered.tasks[0]!.text = "unapproved content";
	h.store.appendIntent({ id: "tampered", sessionFile: owner.sessionFile, authorizationId: fakeAuthorization(h.manifest).id, kind: "admit", targetId: h.manifest.id, manifest: altered });
	h.store.appendIntent({ id: "authorized", sessionFile: owner.sessionFile, authorizationId: fakeAuthorization(h.manifest).id, kind: "admit", targetId: h.manifest.id, manifest: h.manifest });
	await h.scheduler.reconcile(); assert.equal(h.store.read().activeRevisions[h.manifest.id], 1); assert.equal(h.store.read().tasks.length, 1); assert.equal(h.store.read().capacity, 0); assert.equal(h.runtime.launches.length, 0);
	assert.match(h.scheduler.progress().error!, /tampered.*Mismatched intent manifest/);
	h.scheduler.authorizeCapacity(1); await until(() => h.runtime.launches.length === 1); await h.scheduler.shutdown();
});

test("ordinary capacity deferral performs only the configured bounded local rechecks", async () => {
	const h = harness(1, undefined, 2);
	h.runtime.launch = async request => { h.runtime.launches.push(request); return { kind: "capacity-deferred", reason: "full", evidence: { kind: "not-started", launchDigest: request.attempt.launchDigest, reason: "full" } }; };
	await begin(h); await until(() => h.runtime.launches.length === 3); await new Promise(r => setTimeout(r, 40));
	await h.scheduler.reconcile(); assert.equal(h.runtime.launches.length, 3); assert.equal(h.store.read().reservations.length, 0); await h.scheduler.shutdown();
});

test("controller-owned or unknown-transfer workspace is fenced across delivery groups by ID or path", async () => {
	for (const phase of ["handoff-pending", "controller-owned"] as const) for (const match of ["id", "path"] as const) {
		const h = harness(); await begin(h); await until(() => h.runtime.launches.length === 1); const id = h.runtime.launches[0]!.attempt.id; h.runtime.running(id);
		await until(() => h.store.read().attempts[0]!.phase === "running"); h.runtime.finish(id); await until(() => h.store.read().results.length === 1);
		const owner = h.store.read().owner!, workspace = h.store.read().attempts[0]!.workspace;
		h.store.transact(owner, state => {
			const integration = { id: "integration", deliveryGroupId: "delivery-a", workspace, inputDigests: [state.results[0]!.digest], createdAt: 1, beforeCommit: h.manifest.baseCommit, afterCommit: "integrated", phase: "complete" as const };
			state.integrations.push(integration);
			const body = { schemaVersion: 1 as const, intentId: integration.id, deliveryGroupId: "delivery-a", inputDigests: integration.inputDigests, beforeCommit: integration.beforeCommit, afterCommit: integration.afterCommit, checks: [], validatedAt: Date.now() };
			const receipt = { ...body, digest: receiptDigest(body) }; state.integrationReceipts.push(receipt);
			state.deliveries[0] = { groupId: "delivery-a", phase, integrationDigest: receipt.digest, handoff: { id: "handoff", deliveryGroupId: "delivery-a", ownerId: "feature-a", generation: "1", pr: { repo: "fixture", number: 1 }, workspace, head: "integrated", integrationDigest: receipt.digest }, ...(phase === "controller-owned" ? { acknowledgement: { requestId: "handoff", controllerId: "controller", obligationId: "obligation", generation: "1", acceptedAt: 1 } } : {}) };
		});
		const next = fakeManifest(); next.id = "other-manifest"; next.repo = h.manifest.repo; next.tasks[0]!.id = "other-task"; next.tasks[0]!.deliveryGroupId = "other-delivery"; next.deliveryGroups[0]!.id = "other-delivery"; next.deliveryGroups[0]!.requiredTaskIds = ["other-task"];
		const allocate = h.options.workspace;
		h.options.workspace = input => ({ ...allocate(input), [match]: workspace[match] });
		h.scheduler.admit(next, fakeAuthorization(next)); await h.scheduler.reconcile();
		assert.equal(h.runtime.launches.length, 1); assert.equal(h.store.read().reservations.length, 0); assert.match(h.store.read().tasks[1]!.reason!, /controller-owned delivery/);
		await h.scheduler.shutdown();
	}
});


test("failed task blocks only its dependents and targeted retry preserves completed siblings", async () => {
	const h = harness(3, m => { m.tasks[2]!.dependencies = [m.tasks[0]!.id]; }); await begin(h, 2);
	await until(() => h.runtime.launches.length === 2); const [failed, sibling] = h.runtime.launches.map(r => r.attempt.id);
	h.runtime.running(failed!); h.runtime.running(sibling!); await until(() => h.store.read().attempts.every(a => a.phase === "running"));
	h.runtime.finish(failed!, "stopped"); h.runtime.finish(sibling!); await until(() => h.store.read().results.length === 1 && h.store.read().reservations.length === 0);
	assert.equal(h.store.read().tasks[2]!.phase, "dependency-blocked");
	await h.scheduler.control({ targetId: h.manifest.tasks[0]!.id, action: "retry" }); await until(() => h.runtime.launches.length === 3);
	assert.equal(h.runtime.launches[2]!.task.id, h.manifest.tasks[0]!.id); assert.equal(h.store.read().tasks[1]!.phase, "succeeded"); assert.equal(h.store.read().results.length, 1); await h.scheduler.shutdown();
});

test("immediate pause during lost launch acknowledgement stops only after the run is known", async () => {
	const h = harness(); await begin(h); await until(() => h.runtime.launches.length === 1); const id = h.runtime.launches[0]!.attempt.id;
	await h.scheduler.control({ targetId: h.manifest.tasks[0]!.id, action: "pause", immediate: true }); assert.equal(h.runtime.controls.length, 0);
	h.runtime.running(id); await until(() => h.store.read().attempts[0]!.phase === "stopping"); assert.equal(h.runtime.controls.length, 1); assert.equal(h.store.read().reservations.length, 1); await h.scheduler.shutdown();
});


test("slow injected delivery orchestration does not hold the repository admission loop", async () => {
	const h = harness(); const gate = barrier<void>(); let deliveries = 0;
	h.scheduler = new ExecutionScheduler({ ...h.options, reconcileDelivery: async () => { deliveries++; await gate.promise; } });
	await begin(h); await until(() => h.runtime.launches.length === 1); assert.equal(deliveries, 1);
	await h.scheduler.shutdown(); gate.resolve();
});


test("terminal observation settles pending launch once and fences late acknowledgement", async () => {
	const h = harness(); const receipt = h.options.createReceipt; const gate = barrier<void>(); let calls = 0;
	h.options.createReceipt = async input => { calls++; await gate.promise; return receipt(input); };
	await begin(h); await until(() => h.runtime.launches.length === 1); const a = h.runtime.launches[0]!.attempt;
	h.runtime.observations.set(a.id, { kind: "known-terminal", evidence: { kind: "terminal", run: { runId: "early", artifactDir: "/early", ownerSessionFile: a.ownerSessionFile }, outcome: "succeeded", evidenceDigest: digest(a.id), observedAt: Date.now() } });
	await h.scheduler.reconcile(); await until(() => calls === 1);
	for (let n = 0; n < 5; n++) await h.scheduler.reconcile(); assert.equal(calls, 1);
	gate.resolve(); await until(() => h.store.read().results.length === 1);
	h.runtime.gates.get(a.id)!.resolve({ kind: "unknown", reason: "late acknowledgement" });
	await new Promise(r => setTimeout(r, 20)); await h.scheduler.reconcile();
	assert.equal(h.store.read().attempts[0]!.phase, "succeeded"); assert.equal(h.store.read().reservations.length, 0); assert.equal(h.runtime.launches.length, 1); assert.equal(calls, 1); await h.scheduler.shutdown();
});

test("recovery dispatches persisted immediate stop once after unknown launch", async () => {
	const h = harness(); await begin(h); await until(() => h.runtime.launches.length === 1); const a = h.runtime.launches[0]!.attempt;
	h.runtime.gates.get(a.id)!.resolve({ kind: "unknown", reason: "lost" }); await until(() => h.store.read().attempts[0]!.phase === "recovery-needed");
	await h.scheduler.control({ targetId: a.taskId, action: "pause", immediate: true }); h.runtime.running(a.id);
	await h.scheduler.reconcile(); await until(() => h.runtime.controls.length === 1);
	for (let n = 0; n < 5; n++) await h.scheduler.reconcile();
	assert.equal(h.runtime.controls.length, 1); assert.equal(h.store.read().reservations.length, 1);
	h.runtime.finish(a.id, "stopped"); await until(() => h.store.read().reservations.length === 0); assert.equal(h.store.read().tasks[0]!.intent, "pause"); await h.scheduler.shutdown();
});

for (const outcome of ["stopped", "failed"] as const) for (const intent of ["none", "pause", "cancel"] as const) test(`superseded ${outcome} attempt reevaluates replacement preserving ${intent}`, async () => {
	const h = harness(); await begin(h); await until(() => h.runtime.launches.length === 1); const a = h.runtime.launches[0]!.attempt; h.runtime.running(a.id); await until(() => h.store.read().attempts[0]!.phase === "running");
	const revised = structuredClone(h.manifest); revised.revision++; revised.tasks[0]!.text += " changed"; h.scheduler.revise(revised, fakeAuthorization(revised));
	if (intent !== "none") await h.scheduler.control({ targetId: a.taskId, action: intent });
	h.runtime.finish(a.id, outcome); await until(() => h.store.read().attempts[0]!.phase === "failed"); await h.scheduler.reconcile();
	if (intent === "none") { await until(() => h.runtime.launches.length === 2); assert.equal(h.runtime.launches[1]!.attempt.manifestRevision, 2); }
	else { assert.equal(h.runtime.launches.length, 1); assert.equal(h.store.read().tasks[0]!.intent, intent); }
	await h.scheduler.shutdown();
});

test("pending stop does not block authorized unrelated admission and stale stop ack is fenced", async () => {
	const h = harness(); await begin(h, 2); await until(() => h.runtime.launches.length === 1); const a = h.runtime.launches[0]!.attempt; h.runtime.running(a.id); await until(() => h.store.read().attempts[0]!.phase === "running");
	const gate = barrier<{ kind: "unsupported"; reason: string }>(); h.runtime.control = async (run, action, sessionFile) => { h.runtime.controls.push({ runId: run.runId, action, sessionFile }); return gate.promise; };
	const next = fakeManifest(); next.id = "manifest-b"; next.repo = h.manifest.repo; next.tasks[0]!.id = "task-b"; next.tasks[0]!.deliveryGroupId = "delivery-b"; next.deliveryGroups[0]!.id = "delivery-b"; next.deliveryGroups[0]!.requiredTaskIds = ["task-b"];
	const owner = h.store.read().owner!; h.store.transact(owner, s => { s.manifests.push(next); s.authorizations.push(fakeAuthorization(next)); });
	h.store.appendIntent({ id: "pause", sessionFile: owner.sessionFile, authorizationId: fakeAuthorization(h.manifest).id, kind: "pause", targetId: a.taskId, immediate: true });
	h.store.appendIntent({ id: "admit-b", sessionFile: owner.sessionFile, authorizationId: fakeAuthorization(next).id, kind: "admit", targetId: next.id, manifest: next });
	void h.scheduler.reconcile(); await until(() => h.runtime.launches.length === 2);
	assert.ok(h.store.read().intents.every(i => i.consumedAt !== undefined)); assert.equal(h.store.read().reservations.length, 2);
	await h.scheduler.shutdown(); const replacement = new ExecutionScheduler({ ...h.options, owner: { ...h.options.owner, instanceId: "replacement" } });
	h.runtime.control = async run => ({ kind: "acknowledged", run }); await replacement.start(); const before = h.store.read(); gate.resolve({ kind: "unsupported", reason: "stale failure" });
	await new Promise(r => setTimeout(r, 20)); assert.deepEqual(h.store.read(), before); await replacement.shutdown();
});

for (const reject of [false, true]) test(`stop failure is surfaced without releasing capacity (reject=${reject})`, async () => {
	const h = harness(); await begin(h); await until(() => h.runtime.launches.length === 1); const a = h.runtime.launches[0]!.attempt; h.runtime.running(a.id); await until(() => h.store.read().attempts[0]!.phase === "running");
	h.runtime.control = async (run, action, sessionFile) => { h.runtime.controls.push({ runId: run.runId, action, sessionFile }); if (reject) throw new Error("stop lost"); return { kind: "unknown", reason: "stop lost" }; };
	await h.scheduler.control({ targetId: a.taskId, action: "pause", immediate: true }); await until(() => !!h.scheduler.progress().error?.includes("stop lost"));
	await h.scheduler.reconcile(); assert.equal(h.runtime.controls.length, 1); assert.match(h.store.read().attempts[0]!.reason!, /stop lost/); assert.equal(h.store.read().reservations.length, 1); await h.scheduler.shutdown();
});


test("ordinary same-revision terminal failure requires explicit retry", async () => {
	const h = harness(); await begin(h); await until(() => h.runtime.launches.length === 1); const a = h.runtime.launches[0]!.attempt;
	h.runtime.running(a.id); await until(() => h.store.read().attempts[0]!.phase === "running"); h.runtime.finish(a.id, "failed");
	await until(() => h.store.read().attempts[0]!.phase === "failed"); await h.scheduler.reconcile();
	assert.equal(h.store.read().tasks[0]!.phase, "failed"); assert.equal(h.runtime.launches.length, 1); assert.equal(h.store.read().reservations.length, 0); await h.scheduler.shutdown();
});


test("first pool and admission validate atomically; failed admission never changes capacity", async () => {
 const h = harness(); await h.scheduler.start();
 const before = h.store.read();
 const wrong = { ...h.manifest, repo: { ...h.manifest.repo, id: digest("foreign") } };
 assert.throws(() => h.scheduler.admit(wrong, fakeAuthorization(wrong), { initializeCapacity: true }), /Foreign|repository/);
 assert.deepEqual(h.store.read(), before);
 h.scheduler.admit(h.manifest, fakeAuthorization(h.manifest), { initializeCapacity: true });
 assert.equal(h.store.read().capacity, 1);
 await h.scheduler.shutdown();
});

test("independent one-slot admission preserves six occupied repository slots; explicit reduction is atomic", async () => {
 const h = harness(6); await begin(h); await until(() => h.runtime.launches.length === 6);
 const next = fakeManifest(); next.id = "independent"; next.repo = h.manifest.repo;
 next.tasks[0]!.id = "independent-task"; next.tasks[0]!.featureId = "independent-feature"; next.tasks[0]!.deliveryGroupId = "independent-group";
 next.features[0]!.id = "independent-feature";
 next.deliveryGroups[0] = { ...next.deliveryGroups[0]!, id: "independent-group", featureIds: ["independent-feature"], requiredTaskIds: ["independent-task"] };
 h.scheduler.admit(next, fakeAuthorization(next)); await h.scheduler.reconcile();
 assert.equal(h.store.read().capacity, 6); assert.equal(h.store.read().reservations.length, 6);
 assert.equal(h.runtime.launches.length, 6);
 const before = h.store.read(); assert.throws(() => h.scheduler.authorizeCapacity(1), /capacity/i);
 assert.deepEqual(h.store.read(), before);
 await h.scheduler.shutdown();
});
