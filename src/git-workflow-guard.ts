/**
 * Mechanical git-workflow guard. Skills are progressive-disclosure and models
 * ignore them under /goal (GLM-5.3-flash burned 624M tokens polling PR #2166).
 *
 * Blocks wait/worktree/land bash that is not the rust binaries
 * (ghl-wt / ghl-pr-await / ghl-pr-land / ghl-wt-rm, via `git wt` aliases).
 * Does not touch status/diff/log/add/commit/push/fetch-alone.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	classifyForRole,
	classifyViewRepeat,
	isWriterRole,
	viewRepeatKey,
} from "./lib/git-workflow-guard.ts";

export {
	classifyForRole,
	classifyGitWorkflowCommand,
	classifyViewRepeat,
	extractPrNumber,
	isWriterRole,
	viewRepeatKey,
	VIEW_REPEAT_LIMIT,
	WRITER_AGENTS,
} from "./lib/git-workflow-guard.ts";

export default function (pi: ExtensionAPI) {
	const viewCounts = new Map<string, number>();
	// The role is fixed for the life of the process: pi-subagents sets it in
	// the child's env at spawn.
	const writer = isWriterRole();

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		const command = (event.input as { command?: string } | undefined)?.command;
		if (!command) return;

		const first = classifyForRole(command, { writer });
		if (first.block) return first;

		const key = viewRepeatKey(command);
		if (!key) return;
		const n = (viewCounts.get(key) ?? 0) + 1;
		viewCounts.set(key, n);
		const repeated = classifyViewRepeat(n, command);
		if (repeated.block) return repeated;
	});
}
