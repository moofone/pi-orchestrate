/**
 * Writer pin (xai/grok-4.6 medium) and planner status.md ownership.
 *
 * The live tdd-worker modelScope is `xai/grok-4.6*`. Luna/GLM pins fail the
 * spawn before a Task runs and leave the Feature blocked. The planner was
 * told to overwrite status.md and wrote markdown list items (`- phase:`),
 * which made readPhase undefined and every later move refuse as a new Feature.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import * as orch from "../src/orchestrate.ts";

const WRITER_PIN = "xai/grok-4.6:medium";

function paths() {
	return {
		repo: "math-site",
		gitRoot: "/tmp/math-site",
		repoDir: "/tmp/orch/math-site",
		featureDir: "/tmp/orch/math-site/feat",
		planFile: "/tmp/orch/math-site/feat/plan.md",
		statusFile: "/tmp/orch/math-site/feat/status.md",
		handoffsDir: "/tmp/orch/math-site/feat/handoffs",
		archiveDir: "/tmp/orch/math-site/feat/archive",
	};
}

test("tdd-worker allow-list is native grok-4.6, not Luna or GLM", () => {
	assert.equal(orch.isAllowedWriterModel("xai/grok-4.6"), true);
	assert.equal(orch.isAllowedWriterModel("xai/grok-4.6:medium"), true);
	assert.equal(orch.isAllowedWriterModel("xai/grok-4.6:high"), true);
	assert.equal(orch.isAllowedWriterModel("openai-codex/gpt-5.6-luna"), false);
	assert.equal(orch.isAllowedWriterModel("openai-codex/gpt-5.6-luna:xhigh"), false);
	assert.equal(orch.isAllowedWriterModel("zai/glm-5.3-flash"), false);
	assert.equal(orch.isAllowedWriterModel("zai/glm-5.3-flash:medium"), false);
	assert.equal(orch.isAllowedWriterModel("cursor/grok-4.6:medium"), false);
});

test("applySpawnPolicy pins tdd-worker onto xai/grok-4.6:medium", () => {
	const glm = { agent: "tdd-worker", model: "zai/glm-5.3-flash:medium" };
	const g = orch.applySpawnPolicy(glm);
	assert.equal(g.action, "pin");
	assert.equal(glm.model, WRITER_PIN);

	const luna = { agent: "tdd-worker", model: "openai-codex/gpt-5.6-luna:xhigh" };
	const l = orch.applySpawnPolicy(luna);
	assert.equal(l.action, "pin");
	assert.equal(luna.model, WRITER_PIN);

	const already = { agent: "tdd-worker", model: WRITER_PIN };
	assert.equal(orch.applySpawnPolicy(already).action, "allow");
	assert.equal(already.model, WRITER_PIN);
});

test("planner is not told to overwrite status.md as markdown list fields", () => {
	const params = orch.plannerLaunchParams(paths(), "bound objective") as {
		task: string;
	};
	const task = params.task;
	assert.doesNotMatch(
		task,
		/Also overwrite /,
		"overwrite instruction is what produced `- phase: planning`",
	);
	assert.match(
		task,
		/Do \*\*not\*\* overwrite .*status\.md|never markdown list items/i,
	);
	assert.match(task, /host owns `phase`/);
});
