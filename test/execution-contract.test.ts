import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assessRevision, canonicalJson, digest, emptyCoordinatorState, sourceDigest, stableTaskId,
	transitionAttempt, validateAuthorization, validateCheckSpec, validateCoordinatorState,
	validateManifest, validateStateChange, receiptDigest, type CoordinatorState, type ResultReceipt, type IntegrationReceipt,
} from "../src/lib/execution-contract.ts";
import { admitFakeManifest, fakeAttempt, fakeAuthorization, fakeCheck, fakeManifest, fakeReservation, FakeAttemptRuntime, FakeCheckExecutor, FakeDeliveryAdapter, FakeWorkspaceAdapter } from "./fixtures/execution/fakes.ts";

function activeState(): CoordinatorState {
	const manifest = fakeManifest(2), state = emptyCoordinatorState(manifest.repo);
	admitFakeManifest(state, manifest); state.capacity = 2;
	const attempt = fakeAttempt(manifest); state.attempts.push(attempt); state.reservations.push(fakeReservation(attempt));
	return state;
}

test("execution-contract: canonical digests and logical task IDs survive revisions", () => {
	assert.equal(digest({ b: 2, a: [1] }), digest({ a: [1], b: 2 }));
	for (const value of [undefined, NaN, Infinity, new Date(), { x: undefined }]) assert.throws(() => canonicalJson(value));
	const old = fakeManifest(), next = structuredClone(old); next.revision++; next.tasks[0]!.text = "Changed text";
	assert.equal(stableTaskId(old.id, "task-1"), next.tasks[0]!.id);
	assert.notEqual(digest(old.tasks[0]), digest(next.tasks[0]));
});

test("execution-contract: duplicate IDs, missing references, cycles and group inconsistency are refused", () => {
	validateManifest(fakeManifest(15));
	for (const mutate of [
		(m: ReturnType<typeof fakeManifest>) => { m.tasks.push(m.tasks[0]!); },
		(m: ReturnType<typeof fakeManifest>) => { m.tasks[0]!.dependencies = ["missing"]; },
		(m: ReturnType<typeof fakeManifest>) => { m.tasks[0]!.dependencies = [m.tasks[1]!.id]; m.tasks[1]!.dependencies = [m.tasks[0]!.id]; },
		(m: ReturnType<typeof fakeManifest>) => { m.tasks[0]!.featureId = "missing"; },
		(m: ReturnType<typeof fakeManifest>) => { m.deliveryGroups[0]!.requiredTaskIds = ["missing"]; },
		(m: ReturnType<typeof fakeManifest>) => { m.source.bytes += "changed"; },
	]) { const m = fakeManifest(2); mutate(m); assert.throws(() => validateManifest(m)); }
	assert.throws(() => validateManifest({ ...fakeManifest(), schemaVersion: 2 }), /Unsupported/);
});

test("execution-contract: explicit parallel intent is retained and rejected, never silently clamped", () => {
	const m = fakeManifest(5);
	m.constraints.parallelGroups = [{ id: "five", taskIds: m.tasks.map(t => t.id), simultaneous: 5, provenance: { field: "parallel", origin: "explicit" } }];
	validateManifest(m);
	const auth = fakeAuthorization(m); auth.capacity = 2;
	assert.throws(() => validateAuthorization(m, auth), /concurrency/);
	assert.equal(m.constraints.parallelGroups[0]!.simultaneous, 5);
	m.tasks[1]!.dependencies = [m.tasks[0]!.id]; assert.throws(() => validateManifest(m), /Parallel members/);
});

test("execution-contract: approval binds source, revision, repo, publication and scope", () => {
	const m = fakeManifest(), auth = fakeAuthorization(m); validateAuthorization(m, auth);
	for (const changed of [{ revision: 2 }, { sourceDigest: "wrong" }, { manifestDigest: "wrong" }, { scope: "wider" }, { repoId: "other" }]) assert.throws(() => validateAuthorization(m, { ...auth, ...changed }));
	m.deliveryGroups[0]!.policy = "pr"; assert.throws(() => validateAuthorization(m, fakeAuthorization(m)), /Publication/);
});

test("execution-contract: revision additions require proven scope; changes to old contracts require approval", () => {
	const old = fakeManifest(), next = structuredClone(old); next.revision++;
	next.source.bytes += "subtask"; next.source.digest = sourceDigest(next.source.bytes);
	const subtask = { ...structuredClone(old.tasks[0]!), id: stableTaskId(old.id, "subtask"), parentTaskId: old.tasks[0]!.id };
	next.tasks.push(subtask);
	assert.equal(assessRevision(old, next).kind, "approval-required");
	assert.equal(assessRevision(old, next, [subtask.id]).kind, "in-scope");
	next.tasks[0]!.dependencies = [subtask.id]; assert.equal(assessRevision(old, next, [subtask.id]).kind, "approval-required");
});

test("execution-contract: check records require argv, runner-specific evidence and command rationale", () => {
	validateCheckSpec(fakeCheck());
	assert.throws(() => validateCheckSpec({ ...fakeCheck(), argv: "npm test && publish" }));
	assert.throws(() => validateCheckSpec({ ...fakeCheck(), argv: [] }));
	assert.throws(() => validateCheckSpec({ ...fakeCheck(), runner: "command" }));
	validateCheckSpec({ ...fakeCheck(), runner: "command", expectedEvidence: { requiredTests: [], rationale: "Compile only" } });
});

test("execution-contract: unknown outcomes retain reservations and cannot become success or retry", () => {
	const state = activeState(); validateCoordinatorState(state);
	const old = state.attempts[0]!;
	const launching = transitionAttempt(old, "launching", { at: 2 });
	state.attempts[0] = transitionAttempt(launching, "recovery-needed", { at: 3, reason: "lost acknowledgement" });
	validateCoordinatorState(state);
	for (const phase of ["ready", "failed", "succeeded"] as const) assert.throws(() => transitionAttempt(state.attempts[0]!, phase, { at: 4 }));
	const next = structuredClone(state); next.reservations = []; assert.throws(() => validateStateChange(state, next), /Unreserved|reservation/);
	assert.equal(state.reservations.length, 1);
	const rejected = structuredClone(state);
	rejected.attempts[0] = transitionAttempt(state.attempts[0]!, "ready", { at: 4, nonStart: { kind: "not-started", launchDigest: old.launchDigest, reason: "definitive runtime nonstart" } });
	rejected.reservations = []; validateStateChange(state, rejected);
});

test("execution-contract: stop acknowledgement does not release writer; terminal run identity is exact", () => {
	const a = fakeAttempt(); a.phase = "running"; a.run = { runId: "run-a", ownerSessionFile: a.ownerSessionFile, artifactDir: "/fixture/run-a" };
	const stopping = transitionAttempt(a, "stopping", { at: 2 });
	assert.throws(() => transitionAttempt(stopping, "failed", { at: 3 }));
	assert.throws(() => transitionAttempt(stopping, "failed", { at: 3, terminal: { kind: "terminal", run: { ...a.run!, runId: "other" }, outcome: "stopped", evidenceDigest: "proof", observedAt: 3 } }), /mismatch/);
	assert.equal(transitionAttempt(stopping, "failed", { at: 3, terminal: { kind: "terminal", run: a.run, outcome: "stopped", evidenceDigest: "proof", observedAt: 3 } }).phase, "failed");
});

test("execution-contract: immutable attempt contracts and append-only manifests", () => {
	const state = activeState(), changed = structuredClone(state); changed.attempts[0]!.launchDigest = "different";
	assert.throws(() => validateStateChange(state, changed), /Attempt contract/);
	const removed = structuredClone(state); removed.manifests = []; assert.throws(() => validateStateChange(state, removed));
});

test("execution-contract: one active attempt and one writer per workspace", () => {
	const state = activeState(); const other = fakeAttempt(state.manifests[0]!, 1);
	other.workspace = structuredClone(state.attempts[0]!.workspace); state.attempts.push(other); state.reservations.push(fakeReservation(other));
	assert.throws(() => validateCoordinatorState(state), /workspace writer/);
});

test("execution-contract: one repository ceiling across features, including unknown writers", () => {
	const state = activeState(); state.capacity = 1;
	const m = fakeManifest(); m.id = "manifest-b"; m.features[0]!.id = "feature-b"; m.deliveryGroups[0]!.id = "delivery-b";
	m.deliveryGroups[0]!.featureIds = ["feature-b"]; m.tasks[0]!.id = stableTaskId(m.id, "one"); m.tasks[0]!.featureId = "feature-b"; m.tasks[0]!.deliveryGroupId = "delivery-b"; m.deliveryGroups[0]!.requiredTaskIds = [m.tasks[0]!.id];
	admitFakeManifest(state, m); const b = fakeAttempt(m); b.id = "attempt-b"; b.workspace.id = "workspace-b"; b.workspace.path = "/fixture/workspace-b"; state.attempts.push(b); state.reservations.push(fakeReservation(b));
	assert.throws(() => validateCoordinatorState(state), /capacity/);
	state.capacity = 2; validateCoordinatorState(state);
	for (const capacity of [0, 1, -1, 1.5, Infinity, NaN]) assert.throws(() => validateCoordinatorState({ ...state, capacity }));
});

test("execution-contract: shared adapters are injectable, conservative, and completion events only wake observers", async () => {
	const runtime = new FakeAttemptRuntime(), m = fakeManifest(), a = fakeAttempt(m);
	let count = 0; const dispose = runtime.subscribe(() => { count++; }); runtime.beforeLaunchReply = () => runtime.emit({ attemptId: a.id });
	assert.equal((await runtime.launch({ attempt: a, task: m.tasks[0]!, profile: {}, authorization: fakeAuthorization(m) })).kind, "unknown");
	assert.equal(count, 1); dispose(); runtime.emit({ attemptId: a.id }); assert.equal(count, 1);
	assert.equal((await runtime.observe(a)).kind, "unknown");
	assert.equal((await new FakeWorkspaceAdapter().inspect(a.workspace)).kind, "unknown");
	const checks = new FakeCheckExecutor(); const evidence = await checks.execute(fakeCheck(), { workspace: a.workspace, invocationId: "i", startedAt: 1 });
	assert.equal(checks.validateEvidence(fakeCheck(), evidence, { invocationId: "i", notBefore: 1 }).valid, false);
	assert.equal(new FakeDeliveryAdapter().handoffs.length, 0);
});

function deliveredState(requiredChecks = false): CoordinatorState {
	const manifest = fakeManifest(), state = emptyCoordinatorState(manifest.repo);
	if (requiredChecks) manifest.tasks[0]!.checks = [fakeCheck()];
	admitFakeManifest(state, manifest); state.capacity = 1;
	const attempt = fakeAttempt(manifest);
	attempt.phase = "validating";
	attempt.run = { runId: "run-a", artifactDir: "/fixture/run-a", ownerSessionFile: attempt.ownerSessionFile };
	attempt.terminal = { kind: "terminal", run: attempt.run, outcome: "succeeded", evidenceDigest: "terminal-proof", observedAt: 2 };
	const resultBody: Omit<ResultReceipt, "digest"> = { schemaVersion: 1, attemptId: attempt.id, taskId: attempt.taskId, taskDigest: attempt.taskDigest, repoId: manifest.repo.id, baseCommit: manifest.baseCommit, prerequisiteDigests: [], output: { kind: "commits", from: manifest.baseCommit, to: "b".repeat(40), commits: ["b".repeat(40)], paths: ["src/a.ts"] }, checks: [], validatedAt: 3 };
	const result = { ...resultBody, digest: receiptDigest(resultBody) };
	attempt.phase = "succeeded"; attempt.resultDigest = result.digest;
	state.attempts.push(attempt); state.results.push(result);
	state.integrations.push({ id: "integration-a", deliveryGroupId: "delivery-a", workspace: { ...attempt.workspace, id: "delivery-workspace", path: "/fixture/delivery" }, inputDigests: [result.digest], beforeCommit: manifest.baseCommit, afterCommit: result.output.kind === "commits" ? result.output.to : "", createdAt: 3, phase: "complete" });
	const integrationBody: Omit<IntegrationReceipt, "digest"> = { schemaVersion: 1, intentId: "integration-a", deliveryGroupId: "delivery-a", inputDigests: [result.digest], beforeCommit: manifest.baseCommit, afterCommit: "b".repeat(40), checks: [], validatedAt: 4 };
	state.integrationReceipts.push({ ...integrationBody, digest: receiptDigest(integrationBody) });
	state.deliveries.push({ groupId: "delivery-a", phase: "ready", integrationDigest: state.integrationReceipts[0]!.digest });
	validateCoordinatorState(state); return state;
}

test("execution-contract: validated immutable receipts, not arbitrary HEAD or worker counts, gate delivery", () => {
	assert.throws(() => deliveredState(true), /required check/);
	const state = deliveredState();
	const tampered = structuredClone(state); tampered.results[0]!.validatedAt++;
	assert.throws(() => validateCoordinatorState(tampered), /digest mismatch/);
	const missing = structuredClone(state); missing.results = []; assert.throws(() => validateCoordinatorState(missing));
	const unvalidated = structuredClone(state); unvalidated.attempts[0]!.terminal = { ...unvalidated.attempts[0]!.terminal!, outcome: "failed" }; assert.throws(() => validateCoordinatorState(unvalidated), /terminal evidence/);
	const removed = structuredClone(state); removed.integrations = []; assert.throws(() => validateStateChange(state, removed));
});

test("execution-contract: pending transfer fences mutation; acknowledgement is not merge evidence", () => {
	const state = deliveredState(), delivery = state.deliveries[0]!;
	delivery.phase = "handoff-pending";
	delivery.handoff = { id: "handoff-a", deliveryGroupId: delivery.groupId, ownerId: "feature-a", generation: "generation-a", pr: { repo: "owner/repo", number: 1 }, workspace: state.integrations[0]!.workspace, head: "b".repeat(40), integrationDigest: delivery.integrationDigest! };
	validateCoordinatorState(state);
	const ready = structuredClone(state); ready.deliveries[0]!.phase = "ready";
	assert.throws(() => validateStateChange(state, ready), /fence removed/);
	ready.deliveries[0]!.nonTransfer = { requestId: "handoff-a", reason: "Controller proved no transfer", observedAt: 5 }; validateStateChange(state, ready);
	const accepted = structuredClone(state); accepted.deliveries[0]!.phase = "controller-owned";
	accepted.deliveries[0]!.acknowledgement = { requestId: "handoff-a", controllerId: "controller", obligationId: "obligation", generation: "generation-a", acceptedAt: 5 };
	validateStateChange(state, accepted);
	const mutated = structuredClone(accepted); mutated.attempts[0]!.intent = "stop";
	assert.throws(() => validateStateChange(accepted, mutated), /after delivery handoff/);
	const merged = structuredClone(accepted); merged.deliveries[0]!.phase = "merged";
	assert.throws(() => validateStateChange(accepted, merged), /merge evidence/);
	merged.deliveries[0]!.mergeEvidence = { commit: "c".repeat(40), url: "https://example.test/pr/1", observedAt: 6 }; validateStateChange(accepted, merged);
});

test("execution-contract: generated DAGs validate and adding a back edge is rejected", () => {
	for (let size = 2; size <= 20; size++) {
		const m = fakeManifest(size);
		for (let i = 1; i < size; i++) m.tasks[i]!.dependencies = [m.tasks[i - 1]!.id];
		validateManifest(m);
		m.tasks[0]!.dependencies = [m.tasks[size - 1]!.id]; assert.throws(() => validateManifest(m), /cycle/);
	}
});
