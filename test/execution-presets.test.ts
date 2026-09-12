import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { compileLegacyPreset, legacyLaunchProfile, legacyProfileDefaults } from "../src/lib/execution-presets.ts";
import { importPlanSource } from "../src/lib/plan-import.ts";
import { fakeManifest } from "./fixtures/execution/fakes.ts";
import { sourceDigest } from "../src/lib/execution-contract.ts";

test("execution-presets: legacy review, sequential TDD, QA and merged delivery gates", async () => {
	const base = fakeManifest(), source = await importPlanSource(resolve("test/fixtures/execution/import/legacy.md"));
	const result = compileLegacyPreset({ ...base, source }, { profiles: { "task-1": { agent: "custom", model: "custom/model", context: "fork", supervisor: true } } });
	assert.equal(result.preset, "legacy"); assert.equal(result.tasks.length, 4);
	assert.deepEqual(result.tasks.map(t => t.profile.agent), ["plan-reviewer", "custom", "tdd-worker", "feature-qa"]);
	assert.deepEqual(result.tasks[1]!.profile, { agent: "custom", model: "custom/model", context: "fork", supervisor: true });
	for (let i = 1; i < result.tasks.length; i++) assert.deepEqual(result.tasks[i]!.dependencies, [result.tasks[i - 1]!.id]);
	assert.match(result.tasks[1]!.text, /red test/); assert.match(result.tasks[1]!.text, /Build the index/);
	assert.equal(result.deliveryGroups[0]!.completion, "merged"); assert.equal(result.constraints.capacity, 1);
	assert.equal(result.tasks[2]!.profile.model, undefined, "resolution must happen before fallback model is sent");
});

test("execution-presets: fallback precedence never overwrites explicit or agent settings", () => {
	assert.deepEqual(legacyLaunchProfile("worker", { context: "fork" }), { context: "fork" });
	const profile = legacyLaunchProfile("worker", { context: "fork", model: "explicit" }, { model: "agent", tools: ["read"], supervisor: true });
	assert.equal(profile.model, "explicit"); assert.equal(profile.context, "fork");
	assert.equal(profile.tools, undefined); assert.equal(profile.supervisor, undefined);
	assert.equal(profile.thinking, "medium"); assert.equal(legacyProfileDefaults("feature-qa").model, "xai/grok-4.6");
});

test("execution-presets: no legacy task cap and no shell conversion of Markdown gates", async () => {
	const base = fakeManifest(), source = await importPlanSource(resolve("test/fixtures/execution/import/legacy.md"));
	source.bytes = Array.from({ length: 15 }, (_, i) => `### Task ${i + 1} — item\n- Command: \`echo $(evil)\``).join("\n"); source.digest = sourceDigest(source.bytes);
	assert.throws(() => compileLegacyPreset({ ...base, source }, { policy: "local" }), /caller-normalized checks/);
	const checks = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`task-${i + 1}`, [{ id: `check-${i}`, cwd: ".", argv: ["node", "--test"], runner: "node" as const, expectedEvidence: { reportPath: `report-${i}.json`, requiredTests: [] } }]]));
	const result = compileLegacyPreset({ ...base, source }, { policy: "local", checks });
	assert.equal(result.tasks.length, 17); assert.equal(result.tasks[1]!.checks.length, 1);
	assert.equal(result.deliveryGroups[0]!.completion, "validated");
});
