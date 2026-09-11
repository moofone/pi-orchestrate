/**
 * Run: npm test  (or: node --experimental-strip-types --test test/execution-projection.test.ts)
 *
 * Round-2 P1 (codex): executionOverlayTodos marked a `closed-unmerged`
 * delivery `completed`. A closed-unmerged delivery is terminal WITHOUT merge
 * evidence, so the user-facing overlay reported merge-dependent work as done.
 * The overlay contract is that merge-dependent work completes only after a
 * verified merge; `local` + `ready` (locally validated completion) keeps its
 * established completed semantics.
 *
 * Round-3 P2 (codex): the feature row completed on task phases alone, so a
 * feature showed `completed` while its delivery was missing, blocked (checks
 * failed), pending, in-flight, controller-owned, or closed-unmerged. Feature
 * completion must use the SAME policy-specific predicate as the delivery rows:
 * every applicable group completes (all of them, shared groups included) AND
 * all tasks succeeded.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyCoordinatorState, type CoordinatorState, type DeliveryRecord, type DeliveryGroup } from "../src/lib/execution-contract.ts";
import { admitFakeManifest, fakeManifest } from "./fixtures/execution/fakes.ts";
import { executionOverlayTodos } from "../src/lib/execution-projection.ts";
import { overlayWidgetLines, type OverlayTodo } from "../src/lib/overlay.ts";

function overlayState(deliveryPhase: DeliveryRecord["phase"] | "none", policy: DeliveryGroup["policy"], completion: DeliveryGroup["completion"]): CoordinatorState {
	const manifest = fakeManifest();
	manifest.deliveryGroups[0]!.policy = policy;
	manifest.deliveryGroups[0]!.completion = completion;
	const state = emptyCoordinatorState(manifest.repo);
	admitFakeManifest(state, manifest);
	state.capacity = 1;
	if (deliveryPhase !== "none") state.deliveries.push({ groupId: manifest.deliveryGroups[0]!.id, phase: deliveryPhase });
	return state;
}

function deliveryTodo(state: CoordinatorState): OverlayTodo {
	const todo = executionOverlayTodos(state).find(item => item.metadata?.kind === "execution-delivery");
	assert.ok(todo, "projection must include the delivery row");
	return todo!;
}

function featureTodo(state: CoordinatorState, manifestId: string): OverlayTodo {
	const todo = executionOverlayTodos(state).find(item => item.metadata?.kind === "execution-feature" && item.metadata?.taskId === manifestId);
	assert.ok(todo, `projection must include the feature row for ${manifestId}`);
	return todo!;
}

function succeedTasks(state: CoordinatorState, manifestId: string): void {
	for (const record of state.tasks) if (record.manifestId === manifestId) record.phase = "succeeded";
}

/** Two-feature, two-task manifest: feature-a/task-1 under one group, feature-b/task-2 under another. */
function twoGroupManifest(): ReturnType<typeof fakeManifest> {
	const manifest = fakeManifest(2);
	const [task1, task2] = manifest.tasks;
	manifest.features.push({ id: "feature-b", title: "Feature B", scope: "feature-b" });
	task2!.featureId = "feature-b";
	task1!.deliveryGroupId = "delivery-a";
	task2!.deliveryGroupId = "delivery-b";
	manifest.deliveryGroups[0]!.requiredTaskIds = [task1!.id];
	manifest.deliveryGroups.push({ id: "delivery-b", featureIds: ["feature-b"], requiredTaskIds: [task2!.id], checks: [], policy: "pr", completion: "merged", ownerId: "feature-b" });
	return manifest;
}

function admitted(manifest: ReturnType<typeof fakeManifest>): CoordinatorState {
	const state = emptyCoordinatorState(manifest.repo);
	admitFakeManifest(state, manifest);
	state.capacity = Math.max(1, manifest.tasks.length);
	return state;
}

test("execution-overlay: a verified merged delivery completes", () => {
	const todo = deliveryTodo(overlayState("merged", "pr", "merged"));
	assert.equal(todo.status, "completed");
	assert.match(overlayWidgetLines([todo]).join("\n"), /✓/, "a merged delivery is done in the widget");
});

test("execution-overlay: closed-unmerged is never completed — merge-dependent work completes only after merge", () => {
	for (const [policy, completion] of [["pr", "merged"], ["local", "merged"], ["pr", "validated"], ["local", "validated"]] as const) {
		const todo = deliveryTodo(overlayState("closed-unmerged", policy, completion));
		assert.notEqual(todo.status, "completed", `closed-unmerged must not project completed (policy=${policy} completion=${completion})`);
		assert.equal(todo.status, "pending", "a terminal closed-unmerged delivery stays visibly unsuccessful (pending)");
		assert.match(todo.subject, /closed-unmerged/, "the row still names the terminal phase");
		assert.doesNotMatch(overlayWidgetLines([todo]).join("\n"), /✓/, "the widget must not tick a closed-unmerged delivery");
	}
});

test("execution-overlay: local validated completion still completes without a merge", () => {
	const todo = deliveryTodo(overlayState("ready", "local", "validated"));
	assert.equal(todo.status, "completed", "the established local + ready semantics are preserved");
});

test("execution-overlay: in-flight delivery phases stay in_progress", () => {
	for (const phase of ["integrating", "handoff-pending", "controller-owned"] as const) {
		const todo = deliveryTodo(overlayState(phase, "pr", "merged"));
		assert.equal(todo.status, "in_progress", `phase=${phase} is not finished`);
	}
});

test("execution-overlay: a delivery with no record yet stays pending", () => {
	const todo = deliveryTodo(overlayState("none", "pr", "merged"));
	assert.equal(todo.status, "pending");
});

test("execution-overlay: feature row completes when tasks succeed AND the policy-specific group completes", () => {
	const localReady = overlayState("ready", "local", "validated");
	succeedTasks(localReady, "manifest-a");
	assert.equal(featureTodo(localReady, "manifest-a").status, "completed", "local validated + ready keeps its established completion");

	const prMerged = overlayState("merged", "pr", "merged");
	succeedTasks(prMerged, "manifest-a");
	assert.equal(featureTodo(prMerged, "manifest-a").status, "completed", "a verified merge completes the merge-dependent feature");
});

test("execution-overlay: feature row never completes from task phases alone", () => {
	const cases: readonly (readonly [DeliveryRecord["phase"] | "none", DeliveryGroup["policy"], DeliveryGroup["completion"], string])[] = [
		["none", "pr", "merged", "missing delivery record"],
		["pending", "pr", "merged", "pending delivery"],
		["integrating", "pr", "merged", "integration in flight"],
		["blocked", "pr", "merged", "integration blocked"],
		["handoff-pending", "pr", "merged", "handoff pending"],
		["controller-owned", "pr", "merged", "controller-owned delivery"],
		["closed-unmerged", "pr", "merged", "closed-unmerged is terminal without merge"],
		["none", "local", "validated", "missing local delivery record"],
		["pending", "local", "validated", "pending local delivery"],
		["blocked", "local", "validated", "blocked local delivery"],
	];
	for (const [phase, policy, completion, label] of cases) {
		const state = overlayState(phase, policy, completion);
		succeedTasks(state, "manifest-a");
		assert.notEqual(featureTodo(state, "manifest-a").status, "completed", `all tasks succeeded but ${label} must keep the feature open`);
	}
});

test("execution-overlay: failed integration checks keep the feature open", () => {
	const state = overlayState("blocked", "pr", "merged");
	state.deliveries[0]!.reason = JSON.stringify({ checkId: "check-a", status: "failed", exitCode: 1 });
	succeedTasks(state, "manifest-a");
	assert.notEqual(featureTodo(state, "manifest-a").status, "completed", "a check-failed delivery cannot complete the feature");
});

test("execution-overlay: mixed groups — every applicable group must complete before the feature does", () => {
	const manifest = twoGroupManifest();
	const state = admitted(manifest);
	state.deliveries.push({ groupId: "delivery-a", phase: "ready" }, { groupId: "delivery-b", phase: "integrating" });
	succeedTasks(state, "manifest-a");
	assert.notEqual(featureTodo(state, "manifest-a").status, "completed", "one in-flight group keeps the whole feature open");

	state.deliveries.find(item => item.groupId === "delivery-b")!.phase = "merged";
	assert.equal(featureTodo(state, "manifest-a").status, "completed", "once every group completes, the feature completes");
});

test("execution-overlay: a shared group gates every feature it covers", () => {
	const manifest = fakeManifest(2);
	manifest.features.push({ id: "feature-b", title: "Feature B", scope: "feature-b" });
	manifest.tasks[1]!.featureId = "feature-b";
	manifest.deliveryGroups[0] = { id: "delivery-shared", featureIds: ["feature-a", "feature-b"], requiredTaskIds: manifest.tasks.map(t => t.id), checks: [], policy: "pr", completion: "merged", ownerId: "feature-a" };
	for (const task of manifest.tasks) task.deliveryGroupId = "delivery-shared";
	const state = admitted(manifest);
	state.deliveries.push({ groupId: "delivery-shared", phase: "closed-unmerged" });
	succeedTasks(state, "manifest-a");
	assert.notEqual(featureTodo(state, "manifest-a").status, "completed", "a shared closed-unmerged group cannot complete the feature");

	state.deliveries[0]!.phase = "merged";
	assert.equal(featureTodo(state, "manifest-a").status, "completed", "the shared merged group completes the feature");
});

test("execution-overlay: an unrelated manifest's unfinished group does not block a completed feature", () => {
	const other = fakeManifest();
	other.id = "manifest-b";
	other.deliveryGroups[0] = { ...other.deliveryGroups[0]!, id: "delivery-b" };
	for (const task of other.tasks) task.deliveryGroupId = "delivery-b";
	const state = admitted(fakeManifest());
	admitFakeManifest(state, other);
	succeedTasks(state, "manifest-a");
	succeedTasks(state, "manifest-b");
	state.deliveries.push({ groupId: "delivery-a", phase: "merged" }, { groupId: "delivery-b", phase: "blocked" });
	assert.equal(featureTodo(state, "manifest-a").status, "completed", "manifest-b's blocked group is unrelated to manifest-a");
	assert.notEqual(featureTodo(state, "manifest-b").status, "completed", "manifest-b's own blocked group keeps it open");
});
