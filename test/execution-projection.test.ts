/**
 * Run: npm test  (or: node --experimental-strip-types --test test/execution-projection.test.ts)
 *
 * Round-2 P1 (codex): executionOverlayTodos marked a `closed-unmerged`
 * delivery `completed`. A closed-unmerged delivery is terminal WITHOUT merge
 * evidence, so the user-facing overlay reported merge-dependent work as done.
 * The overlay contract is that merge-dependent work completes only after a
 * verified merge; `local` + `ready` (locally validated completion) keeps its
 * established completed semantics.
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
