/**
 * Classify bash commands against git-workflow (wt / pr-await / pr-land / wt-rm).
 *
 * Prompt skills are not a guard: GLM-5.3-flash read nothing and polled
 * `git fetch` + `gh pr view` 1,127 times (624M tokens). This is the mechanical
 * allowlist for wait/worktree/land. Ordinary git (status/diff/log/add/commit/
 * push/fetch-alone) is untouched.
 */
export type GuardVerdict = { block: false } | { block: true; reason: string };

const RUST = {
	wt: "git wt <branch>",
	await: "git pr-await <PR>",
	land: "git pr-land <PR>",
	rm: "git wt-rm <branch>",
} as const;

const PR_NUM = String.raw`(?:#)?(\d+)`;

export function extractPrNumber(command: string): string | undefined {
	const patterns = [
		new RegExp(String.raw`\bgh\s+pr\s+(?:view|checks|status|watch|merge)\s+${PR_NUM}`),
		new RegExp(String.raw`\bgit\s+pr-(?:await|land|poll)\s+${PR_NUM}`),
		new RegExp(String.raw`\bghl-pr-(?:await|land|poll)\s+${PR_NUM}`),
	];
	for (const re of patterns) {
		const m = command.match(re);
		if (m?.[1]) return m[1];
	}
	return undefined;
}

function awaitHint(command: string): string {
	const pr = extractPrNumber(command);
	return pr ? `${RUST.await.replace("<PR>", pr)}` : RUST.await;
}

function stripComments(command: string): string {
	return command.replace(/(^|\n)[ \t]*#.*/g, "$1");
}

export function classifyGitWorkflowCommand(command: string): GuardVerdict {
	const text = stripComments(command);

	// Allowed rust entrypoints (git aliases → ghl-*). Do not inspect further:
	// `git pr-await 2166` is the thing we are herding the model toward.
	if (
		/\bgit\s+wt\b/.test(text) ||
		/\bgit\s+wt-rm\b/.test(text) ||
		/\bgit\s+pr-await\b/.test(text) ||
		/\bgit\s+pr-land\b/.test(text) ||
		/\bghl-wt(?:-rm)?\b/.test(text) ||
		/\bghl-pr-await\b/.test(text) ||
		/\bghl-pr-land\b/.test(text)
	) {
		return { block: false };
	}

	if (/\bgit\s+pr-poll\b|\bghl-pr-poll\b/.test(text)) {
		return {
			block: true,
			reason: `git pr-poll is retired. Use ${awaitHint(text)} once, then stop. The latch wakes this session.`,
		};
	}

	if (/\bgit\s+worktree\s+(add|remove|prune|move)\b/.test(text)) {
		const add = /\bworktree\s+add\b/.test(text);
		return {
			block: true,
			reason: add
				? `raw git worktree add is blocked. Use ${RUST.wt} (ghl-wt).`
				: `raw git worktree remove/prune is blocked. Use ${RUST.rm} (ghl-wt-rm).`,
		};
	}

	if (/\bgh\s+pr\s+merge\b/.test(text)) {
		return {
			block: true,
			reason: `gh pr merge is blocked (including --admin). The waiter lands. Use ${awaitHint(text)} once, then stop.`,
		};
	}

	const hasView =
		/\bgh\s+pr\s+(?:view|checks|status)\b/.test(text) ||
		/\bgh\s+run\s+watch\b/.test(text);
	const hasFetch = /\bgit\s+fetch\b/.test(text);
	const hasSleep = /\bsleep\s+\d/.test(text) || /\btimeout\s+\d/.test(text);
	const hasLoop =
		/\bfor\s+\w+\s+in\b/.test(text) ||
		/\bwhile\s+/.test(text) ||
		/\buntil\s+/.test(text);

	if (hasView && (hasFetch || hasSleep || hasLoop)) {
		return {
			block: true,
			reason:
				`PR wait/poll via bash is blocked (git fetch + gh pr view, sleep loops, for/while). ` +
				`Use ${awaitHint(text)} once → next=yield → stop talking. Do not drain-poll.`,
		};
	}

	return { block: false };
}

/* ------------------------------------------------------------------ *
 * Writer children
 *
 * `/orchestrate` children write code and commit it. Everything else on the
 * Feature — the worktree, the push, the PR, the wait, the land, the review
 * comment — belongs to code in the parent, so that "exactly one waiter per PR"
 * and "one push per round" are structural facts rather than prompt requests.
 *
 * The fixer used to be handed the solo git-workflow skill, whose `next=` table
 * says "fix …, one push, then `git pr-await` once". The allowlist above let
 * that through, and an obedient fixer forked a second waiter with its own
 * state file from inside a child session (F7).
 * ------------------------------------------------------------------ */

/** Children that write code. `planner` and `plan-reviewer` are not writers. */
export const WRITER_AGENTS = new Set(["tdd-worker", "fixer", "feature-qa"]);

/**
 * Whether this process is a writer child.
 *
 * `PI_SUBAGENT_CHILD_AGENT` is set by pi-subagents on every child it spawns
 * (`runs/shared/pi-args.ts`), so the role is already on the wire and needs no
 * cooperation from the spawn site. `ORCHESTRATE_ROLE=writer` is honoured as an
 * explicit override.
 */
export function isWriterRole(env: Record<string, string | undefined> = process.env): boolean {
	if (env.ORCHESTRATE_ROLE === "writer") return true;
	return WRITER_AGENTS.has(String(env.PI_SUBAGENT_CHILD_AGENT ?? "").trim());
}

const WRITER_BLOCKS: { re: RegExp; reason: string }[] = [
	{
		re: /\bgit\s+pr-await\b|\bghl-pr-await\b/,
		reason:
			"a writer child never waits on the review. Settle with your handoff; code runs git pr-await once, from the parent.",
	},
	{
		re: /\bgit\s+pr-land\b|\bghl-pr-land\b|\bgh\s+pr\s+merge\b/,
		reason: "a writer child never lands the PR. Code lands it when the waiter says so.",
	},
	{
		re: /\bgit\s+wt(?:-rm)?\b|\bghl-wt(?:-rm)?\b|\bgit\s+worktree\s+(?:add|remove|prune|move)\b/,
		reason:
			"a writer child never creates or removes a worktree. You were given one; work in it.",
	},
	{
		re: /\bgh\s+pr\s+(?:create|comment|edit|close|reopen|ready)\b/,
		reason:
			"a writer child never speaks on the PR. Put it in your handoff; code opens the PR and posts on it.",
	},
	{
		re: /\bgit\s+push\b/,
		reason:
			"a writer child commits; code pushes. Commit your work and settle — the push is one per round, from the parent.",
	},
];

/**
 * The guard for one command, given the role of the session running it.
 *
 * Writer blocks are checked first: the solo allowlist deliberately waves
 * `git pr-await` through, and for a child that is exactly the wrong answer.
 */
export function classifyForRole(command: string, opts: { writer: boolean }): GuardVerdict {
	if (opts.writer) {
		const text = stripComments(command);
		for (const rule of WRITER_BLOCKS) {
			if (rule.re.test(text)) return { block: true, reason: rule.reason };
		}
	}
	return classifyGitWorkflowCommand(command);
}

/** Session-scoped repeat key for a lone `gh pr view/checks` (no fetch/sleep/loop). */
export function viewRepeatKey(command: string): string | undefined {
	const text = stripComments(command);
	if (classifyGitWorkflowCommand(text).block) return undefined;
	if (!/\bgh\s+pr\s+(?:view|checks|status)\b/.test(text)) return undefined;
	if (/\bgh\s+pr\s+create\b/.test(text)) return undefined;
	const pr = extractPrNumber(text) ?? "unknown";
	return `view:${pr}`;
}

export const VIEW_REPEAT_LIMIT = 2;

export function classifyViewRepeat(countAfterThis: number, command: string): GuardVerdict {
	if (countAfterThis <= VIEW_REPEAT_LIMIT) return { block: false };
	return {
		block: true,
		reason:
			`gh pr view/checks repeated ${countAfterThis} times this session. ` +
			`Use ${awaitHint(command)} once, then stop. One view is enough for next=done.`,
	};
}
