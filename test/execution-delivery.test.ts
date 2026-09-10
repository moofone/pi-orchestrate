import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionDelivery, createControllerDeliveryAdapter } from "../src/lib/execution-delivery.ts";
import { createExecutionStore } from "../src/lib/execution-store.ts";
import { digest, receiptDigest, deliveryFenced, type HandoffAcknowledgement, type HandoffRequest, type ResultReceipt } from "../src/lib/execution-contract.ts";
import { prKeyId } from "../src/lib/pr-review-identity.ts";
import type { ObligationView, ReviewController } from "../src/lib/pr-review-controller.ts";
import { fakeManifest, fakeAuthorization, fakeAttempt, fakeCheck, fakeWorkspace, FakeCheckExecutor, FakeWorkspaceAdapter, FakeDeliveryAdapter } from "./fixtures/execution/fakes.ts";

function fixture({ pr = false, count = 2, combined = true, shared = false } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "execution-delivery-")));
	const manifest = fakeManifest(count); manifest.repo = { commonDir: root, id: digest(root) };
	const group = manifest.deliveryGroups[0]!;
	if (pr) { group.policy = "pr"; group.completion = "merged"; }
	if (combined) group.checks = [fakeCheck()];
	if (shared) { manifest.features.push({ id: "feature-b", title: "B", scope: "feature-a" }); group.featureIds.push("feature-b"); manifest.tasks[1]!.featureId = "feature-b"; group.ownerId = "approved-shared-owner"; }
	const store = createExecutionStore({ stateRoot: root, repo: manifest.repo });
	const owner = store.acquire({ pid: process.pid, processStart: "fixture", sessionFile: join(root, "session"), instanceId: "instance" });
	store.markReconciled(owner);
	store.transact(owner, state => {
		state.capacity = count; state.manifests.push(manifest);
		state.authorizations.push({ ...fakeAuthorization(manifest), publication: pr }); state.activeRevisions[manifest.id] = 1;
		manifest.tasks.forEach((task, index) => {
			const attempt = fakeAttempt(manifest, index);
			attempt.run = { runId: `run-${index}`, artifactDir: join(root, `run-${index}`), ownerSessionFile: attempt.ownerSessionFile };
			attempt.terminal = { kind: "terminal", run: attempt.run, outcome: "succeeded", evidenceDigest: `terminal-${index}`, observedAt: 2 };
			attempt.phase = "succeeded";
			const body: Omit<ResultReceipt, "digest"> = { schemaVersion: 1, attemptId: attempt.id, taskId: task.id, taskDigest: attempt.taskDigest, repoId: manifest.repo.id, baseCommit: manifest.baseCommit, prerequisiteDigests: [], output: { kind: "commits", from: manifest.baseCommit, to: `commit-${index}`, commits: [`commit-${index}`], paths: [`src/${index}.ts`] }, checks: [], validatedAt: 3 };
			const receipt = { ...body, digest: receiptDigest(body) }; attempt.resultDigest = receipt.digest;
			state.attempts.push(attempt); state.results.push(receipt);
			state.tasks.push({ taskId: task.id, manifestId: manifest.id, phase: "succeeded", intent: "none", attemptIds: [attempt.id], resultDigest: receipt.digest });
		});
	});
	const workspace = new FakeWorkspaceAdapter(), checks = new FakeCheckExecutor(), delivery = new FakeDeliveryAdapter();
	const target = fakeWorkspace(manifest, "delivery-workspace");
	workspace.inspections.set(target.id, { kind: "inspected", workspace: target, head: manifest.baseCommit, clean: true, appliedDigests: [] });
	workspace.compose = async request => {
		workspace.compositions.push(structuredClone(request));
		workspace.inspections.set(target.id, { kind: "inspected", workspace: target, head: "combined-head", clean: true, appliedDigests: request.intent.inputDigests });
		return { kind: "prepared", workspace: target, head: "combined-head" };
	};
	checks.execute = async (check, context) => {
		checks.calls.push({ check, context });
		return { checkId: check.id, invocationId: context.invocationId, startedAt: context.startedAt, finishedAt: context.startedAt + 1, exitCode: 0, reportPath: "report.json", reportDigest: "fresh-report", executedTests: ["test-a"], skippedTests: [], status: "passed" };
	};
	const options = { store, owner, workspace, checks, delivery, now: () => 10, resolvePr: async () => ({ kind: "authorized" as const, pr: { repo: "github.com/acme/repo", number: 42 }, generation: "gen-1" }) };
	return { ...options, options, manifest, group, target, api: createExecutionDelivery(options) };
}
const ack = (request: HandoffRequest): HandoffAcknowledgement => ({ requestId: request.id, controllerId: "controller", obligationId: "obligation", generation: request.generation, acceptedAt: 20 });

test("execution-delivery composes successful workers, gates the combined HEAD, and is idempotent", async () => {
	const f = fixture();
	const first = await f.api.integrate(f.manifest.id, f.group.id, f.target);
	assert.equal(first.kind, "ready"); assert.equal(f.workspace.compositions.length, 1); assert.equal(f.checks.calls.length, 1);
	assert.equal(f.store.read().reservations.length, 0);
	const again = await createExecutionDelivery(f.options).integrate(f.manifest.id, f.group.id, f.target);
	assert.deepEqual(again, first); assert.equal(f.workspace.compositions.length, 1); assert.equal(f.checks.calls.length, 1);
	assert.equal(f.checks.calls[0]!.context.workspace.id, f.target.id);
});

test("execution-delivery worker success does not hide failed combined checks; evidence and writer retained", async () => {
	const f = fixture(); const execute = f.checks.execute.bind(f.checks);
	f.checks.execute = async (...args) => ({ ...await execute(...args), exitCode: 1, status: "failed" });
	const result = await f.api.integrate(f.manifest.id, f.group.id, f.target);
	assert.equal(result.kind, "remediation-required");
	if (result.kind !== "remediation-required") return;
	assert.equal(result.checks[0]!.status, "failed"); assert.deepEqual(result.taskIds, f.group.requiredTaskIds);
	const state = f.store.read(); assert.ok(state.tasks.every(t => t.phase === "succeeded"));
	assert.equal(state.deliveries[0]!.phase, "blocked"); assert.equal(state.integrationReceipts.length, 0); assert.equal(state.reservations.length, 1);
	assert.match(state.integrations[0]!.reason!, /Combined gate failed/);
	await assert.rejects(f.api.handoff(f.manifest.id, f.group.id), /validated combined receipt/);
});

test("execution-delivery conflicts propose targeted remediation without cleanup or delivery", async () => {
	const f = fixture();
	f.workspace.compose = async request => { f.workspace.compositions.push(request); return { kind: "conflict", reason: "src/shared.ts conflict" }; };
	const result = await f.api.integrate(f.manifest.id, f.group.id, f.target);
	assert.equal(result.kind, "remediation-required"); assert.equal(f.checks.calls.length, 0);
	assert.match(f.store.read().integrations[0]!.reason!, /src\/shared.ts conflict/);
	const retry = await f.api.integrate(f.manifest.id, f.group.id, f.target);
	assert.equal(retry.kind, "remediation-required"); assert.equal(f.workspace.compositions.length, 1);
	assert.equal(f.store.read().reservations.length, 1);
});

test("execution-delivery crash after Git mutation before receipt recovers exact ancestry, never replays", async () => {
	const f = fixture(); const compose = f.workspace.compose.bind(f.workspace);
	f.workspace.compose = async request => { await compose(request); throw new Error("process lost after Git commit"); };
	assert.equal((await f.api.integrate(f.manifest.id, f.group.id, f.target)).kind, "remediation-required");
	assert.equal(f.store.read().integrationReceipts.length, 0);
	f.store.relinquish(f.owner);
	const owner = f.store.acquire({ ...f.owner, instanceId: "reloaded" }); f.store.markReconciled(owner);
	const recovered = await createExecutionDelivery({ ...f.options, owner }).integrate(f.manifest.id, f.group.id, f.target);
	assert.equal(recovered.kind, "ready"); assert.equal(f.workspace.compositions.length, 1); assert.equal(f.store.read().integrationReceipts.length, 1);
});

test("execution-delivery unknown ancestry and in-progress Git remain reserved", async () => {
	const f = fixture();
	f.workspace.compose = async () => { throw new Error("lost"); };
	await f.api.integrate(f.manifest.id, f.group.id, f.target);
	f.workspace.inspections.set(f.target.id, { kind: "inspected", workspace: f.target, head: "unrelated-head", clean: true, appliedDigests: [] });
	assert.equal((await f.api.integrate(f.manifest.id, f.group.id, f.target)).kind, "remediation-required");
	f.workspace.inspections.set(f.target.id, { kind: "inspected", workspace: f.target, head: "unrelated-head", clean: true, appliedDigests: [], inProgress: "merge" });
	assert.equal((await f.api.integrate(f.manifest.id, f.group.id, f.target)).kind, "remediation-required");
	assert.equal(f.store.read().reservations.length, 1);
});

test("execution-delivery refuses missing worker receipts and missing combined check evidence", async () => {
	const f = fixture();
	f.store.transact(f.owner, state => { delete state.tasks[0]!.resultDigest; });
	assert.equal((await f.api.integrate(f.manifest.id, f.group.id, f.target)).kind, "remediation-required"); assert.equal(f.workspace.compositions.length, 0);
	const g = fixture(); g.checks.execute = async (check, context) => ({ checkId: check.id, invocationId: context.invocationId, startedAt: context.startedAt, finishedAt: context.startedAt, exitCode: 0, status: "passed", executedTests: [], skippedTests: [] });
	assert.equal((await g.api.integrate(g.manifest.id, g.group.id, g.target)).kind, "remediation-required"); assert.equal(g.store.read().integrationReceipts.length, 0);
});

test("execution-delivery persists handoff-pending BEFORE external call; shared features map to one PR and duplicate handoff observes", async () => {
	const f = fixture({ pr: true, shared: true }); await f.api.integrate(f.manifest.id, f.group.id, f.target);
	f.delivery.handoff = async request => {
		assert.equal(f.store.read().deliveries[0]!.phase, "handoff-pending");
		assert.deepEqual(f.store.read().deliveries[0]!.handoff, request);
		assert.equal(request.ownerId, "approved-shared-owner"); f.delivery.handoffs.push(request);
		const outcome = { kind: "accepted" as const, acknowledgement: ack(request) }; f.delivery.observations.set(request.id, outcome); return outcome;
	};
	const results = await Promise.all([f.api.handoff(f.manifest.id, f.group.id), createExecutionDelivery(f.options).handoff(f.manifest.id, f.group.id)]);
	assert.ok(results.every(d => d.phase === "controller-owned")); assert.equal(f.delivery.handoffs.length, 1);
	assert.equal(f.store.read().deliveries.length, 1);
	assert.equal((await f.api.integrate(f.manifest.id, f.group.id, f.target)).kind, "fenced");
	assert.throws(() => f.store.transact(f.owner, state => { state.attempts[0]!.reason = "scheduler trying to write"; }), /Attempt mutation after delivery handoff/);
});

test("execution-delivery lost acknowledgement keeps fence; exact reconciliation restores controller ownership, not local writes", async () => {
	const f = fixture({ pr: true }); await f.api.integrate(f.manifest.id, f.group.id, f.target);
	f.delivery.handoff = async request => { f.delivery.handoffs.push(request); f.delivery.observations.set(request.id, { kind: "accepted", acknowledgement: ack(request) }); throw new Error("local acknowledgement lost"); };
	const pending = await f.api.handoff(f.manifest.id, f.group.id);
	assert.equal(pending.phase, "handoff-pending"); assert.ok(deliveryFenced(pending));
	assert.equal((await f.api.integrate(f.manifest.id, f.group.id, f.target)).kind, "fenced");
	assert.equal((await createExecutionDelivery(f.options).handoff(f.manifest.id, f.group.id)).phase, "controller-owned"); assert.equal(f.delivery.handoffs.length, 1);
});

test("execution-delivery unknown and wrong-generation acknowledgements never release mutation fence", async () => {
	const f = fixture({ pr: true }); await f.api.integrate(f.manifest.id, f.group.id, f.target);
	const d = await f.api.handoff(f.manifest.id, f.group.id); assert.equal(d.phase, "handoff-pending");
	f.delivery.observations.set(d.handoff!.id, { kind: "accepted", acknowledgement: { ...ack(d.handoff!), generation: "wrong" } });
	assert.equal((await f.api.observe(f.group.id)).phase, "handoff-pending");
	assert.throws(() => f.store.transact(f.owner, state => { state.deliveries[0]!.phase = "ready"; }), /fence removed/);
	f.delivery.observations.set(d.handoff!.id, { kind: "not-transferred", reason: "Definitive exact-request controller proof" });
	assert.equal((await f.api.observe(f.group.id)).phase, "ready");
});

test("execution-delivery distinguishes acknowledged, verified merged, and closed-unmerged", async () => {
	for (const terminal of ["merged", "closed-unmerged"] as const) {
		const f = fixture({ pr: true }); await f.api.integrate(f.manifest.id, f.group.id, f.target);
		f.delivery.handoff = async request => ({ kind: "accepted", acknowledgement: ack(request) });
		const d = await f.api.handoff(f.manifest.id, f.group.id); assert.equal(d.phase, "controller-owned"); assert.equal(d.mergeEvidence, undefined);
		f.delivery.observations.set(d.handoff!.id, terminal === "merged" ? { kind: "merged", acknowledgement: ack(d.handoff!), commit: "merge-commit", url: "https://github.com/acme/repo/pull/42", observedAt: 30 } : { kind: "closed-unmerged", acknowledgement: ack(d.handoff!) });
		const observed = await f.api.observe(f.group.id); assert.equal(observed.phase, terminal); assert.equal(!!observed.mergeEvidence, terminal === "merged");
		assert.deepEqual(await f.api.observe(f.group.id), observed);
	}
});

test("execution-delivery requires explicit authorized PR port, never invents a PR", async () => {
	const f = fixture({ pr: true }); await f.api.integrate(f.manifest.id, f.group.id, f.target);
	await assert.rejects(createExecutionDelivery({ ...f.options, resolvePr: undefined }).handoff(f.manifest.id, f.group.id), /PR discovery port required/);
	assert.equal(f.delivery.handoffs.length, 0);
});

test("controller adapter reconciles persistence before lost reply and verifies exact obligation identities", async () => {
	const f = fixture({ pr: true }); await f.api.integrate(f.manifest.id, f.group.id, f.target);
	let view: ObligationView | undefined, calls = 0;
	const controller: Pick<ReviewController, "handoff" | "status"> = {
		status: () => view ? [view] : [],
		handoff(request) {
			calls++; view = { pr: prKeyId(request.pr), owner: request.owner, worktree: request.worktree, head: request.head!, state: "waiting_review", pendingCount: 0 };
			throw new Error("controller persisted; transport lost");
		},
	};
	const adapter = createControllerDeliveryAdapter({ controller, controllerId: "existing-controller", prKey: () => ({ host: "github.com", owner: "acme", repo: "repo", number: "42" }), acknowledged: request => f.store.read().deliveries.find(d => d.handoff?.id === request.id)?.acknowledgement, verifyMerge: async () => ({ commit: "merge", url: "https://github.com/acme/repo/pull/42", observedAt: 30 }), now: () => 20 });
	const api = createExecutionDelivery({ ...f.options, delivery: adapter });
	assert.equal((await api.handoff(f.manifest.id, f.group.id)).phase, "controller-owned"); assert.equal(calls, 1);
	view!.head = "controller-fixer-head"; view!.state = "merged";
	assert.equal((await api.observe(f.group.id)).phase, "merged"); assert.equal(calls, 1);
	const request = f.store.read().deliveries[0]!.handoff!;
	for (const mismatch of [ { ...request, ownerId: "wrong" }, { ...request, generation: "wrong" }, { ...request, pr: { ...request.pr, number: 43 } }, { ...request, workspace: { ...request.workspace, path: "/wrong" } } ]) assert.equal((await adapter.observe(mismatch)).kind, "unknown");
});

test("controller adapter missing or changed pending obligation is unknown, not non-transfer; ack is not merge", async () => {
	const f = fixture({ pr: true }); await f.api.integrate(f.manifest.id, f.group.id, f.target); await f.api.handoff(f.manifest.id, f.group.id);
	const request = f.store.read().deliveries[0]!.handoff!;
	let view: ObligationView | undefined;
	const adapter = createControllerDeliveryAdapter({ controller: { status: () => view ? [view] : [], handoff: () => ({ ok: false, state: "recovery_required" }) }, controllerId: "existing", prKey: () => ({ host: "github.com", owner: "acme", repo: "repo", number: "42" }), acknowledged: () => undefined, verifyMerge: async () => undefined, now: () => 20 });
	assert.equal((await adapter.observe(request)).kind, "unknown");
	view = { pr: "github.com/acme/repo#42", owner: { kind: "feature", id: request.ownerId, generation: request.generation }, worktree: request.workspace.path, head: "unproven-new-head", state: "merged", pendingCount: 0 };
	// Use the existing controller's canonical PR spelling.
	view.pr = prKeyId({ host: "github.com", owner: "acme", repo: "repo", number: "42" });
	assert.equal((await adapter.observe(request)).kind, "unknown");
	view.head = request.head; assert.equal((await adapter.observe(request)).kind, "accepted");
});


test("execution-delivery rejects cross-group controller workspace reuse by either ID or canonical path", async () => {
	const f = fixture({ pr: true }); await f.api.integrate(f.manifest.id, f.group.id, f.target);
	await f.api.handoff(f.manifest.id, f.group.id); // Unknown acknowledgement: still exclusively controller-transfer fenced.
	const other = fakeManifest(); other.id = "manifest-b"; other.repo = f.manifest.repo;
	other.tasks[0]!.id = "other-task"; other.tasks[0]!.deliveryGroupId = "delivery-b";
	other.deliveryGroups[0]!.id = "delivery-b"; other.deliveryGroups[0]!.requiredTaskIds = ["other-task"];
	f.store.transact(f.owner, state => { state.manifests.push(other); state.authorizations.push(fakeAuthorization(other)); state.activeRevisions[other.id] = 1; });
	for (const target of [{ ...f.target, id: "alias-id" }, { ...f.target, path: "/different-path" }]) {
		assert.equal((await f.api.integrate(other.id, "delivery-b", target)).kind, "fenced");
	}
	assert.equal(f.workspace.compositions.length, 1);
});

test("execution-delivery concurrent identical integrations have exactly one Git writer", async () => {
	const f = fixture();
	const results = await Promise.all([f.api.integrate(f.manifest.id, f.group.id, f.target), createExecutionDelivery(f.options).integrate(f.manifest.id, f.group.id, f.target)]);
	assert.deepEqual(results[0], results[1]); assert.equal(f.workspace.compositions.length, 1); assert.equal(f.store.read().integrationReceipts.length, 1);
});

test("execution-delivery positive test count without required report is remediation, never readiness", async () => {
	const f = fixture(); const execute = f.checks.execute.bind(f.checks);
	f.checks.execute = async (...args) => { const evidence = await execute(...args); delete evidence.reportDigest; return evidence; };
	assert.equal((await f.api.integrate(f.manifest.id, f.group.id, f.target)).kind, "remediation-required");
	assert.equal(f.store.read().integrationReceipts.length, 0);
});
