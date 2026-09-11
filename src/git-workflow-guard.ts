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
	mutationTargetDirs,
	durableExecutionReservation,
	verifiedDurableExecutionReservation,
	durableExecutionWorkspaceFence,
	isWriterRole,
	viewRepeatKey,
} from "./lib/git-workflow-guard.ts";
import { stateDir } from "./lib/pr-await-core.ts";
import { createReviewStore } from "./lib/pr-review-store.ts";

export {
	classifyForRole,
	classifyGitWorkflowCommand,
	classifyViewRepeat,
	extractPrNumber,
	isWorktreeMutation,
	mutationTargetDirs,
	durableExecutionReservation,
	verifiedDurableExecutionReservation,
	durableExecutionWorkspaceFence,
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

		let writerReserved = false;
		let executionRole: "worker" | "parent" | undefined;
		try {
			const fallback =
				(typeof (event as { cwd?: string }).cwd === "string" && (event as { cwd?: string }).cwd) ||
				process.cwd();
			// Caller identity is established independently of the mutation predicate;
			// targeting a reserved path is never worker proof.
			const targets = mutationTargetDirs(command, fallback);
			// Labels select the writer policy only. They never authorize a durable
			// execution workspace; every target must carry the exact runtime-bound
			// attempt/session/run evidence.
			const verified = targets.map(dir => verifiedDurableExecutionReservation(dir));
			const executionWorker = verified.length > 0 && verified.every(Boolean) && new Set(verified.map(item => item?.attemptId)).size === 1 ? verified[0] : undefined;
			const reserved = targets.some(dir => durableExecutionReservation(dir) || durableExecutionWorkspaceFence(dir));
			if (executionWorker) executionRole = "worker";
			else if (reserved || verified.some(Boolean)) executionRole = "parent";
			const store = createReviewStore(stateDir());
			writerReserved = !executionWorker && targets.some((dir) => Boolean(store.writerForWorktree(dir)));
		} catch {
			writerReserved = false;
		}
		// A writer label without exact execution proof is treated as an
		// untrusted caller for reserved workspaces. Keep label-based publication
		// restrictions for ordinary/unreserved writer sessions.
		const reservedWithoutExecutionProof = writer && executionRole === "parent";
		const first = classifyForRole(command, { writer: reservedWithoutExecutionProof ? false : writer, writerReserved: writerReserved || executionRole === "parent", ...(executionRole ? { executionRole } : {}) });
		if (first.block) return first;

		const key = viewRepeatKey(command);
		if (!key) return;
		const n = (viewCounts.get(key) ?? 0) + 1;
		viewCounts.set(key, n);
		const repeated = classifyViewRepeat(n, command);
		if (repeated.block) return repeated;
	});
}
