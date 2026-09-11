/**
 * Classify bash commands against git-workflow (wt / pr-await / pr-land / wt-rm).
 *
 * Prompt skills are not a guard: GLM-5.3-flash read nothing and polled
 * `git fetch` + `gh pr view` 1,127 times (624M tokens). This is the mechanical
 * allowlist for wait/worktree/land. Ordinary git (status/diff/log/add/commit/
 * push/fetch-alone) is untouched.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { canonicalizePath } from "./pr-review-store.ts";
import { readExecutionIdentityBinding } from "./execution-identity.ts";

export type GuardVerdict = { block: false } | { block: true; reason: string };
export type ExecutionGuardRole = "worker" | "parent" | "controller";
export type ExecutionReservation = { role: "worker"; attemptId: string; workspacePath: string; workspaceId?: string };
type DurableAttempt = {
  id: string;
  ownerSessionFile?: string;
  workspace?: { id?: string; path?: string };
  run?: { runId?: string; ownerSessionFile?: string; operationId?: string };
};
type DurableExecutionState = { reservations?: { attemptId?: string; workspacePath: string; workspaceId?: string; slots?: number }[]; attempts?: DurableAttempt[]; deliveries?: { phase?: string; handoff?: { workspace?: { path?: string } } }[] };

/**
 * Resolve a worker reservation from durable execution data. The reservation is
 * the proof; configured agent names and environment labels are only selectors
 * and never grant a worker role by themselves.
 */
export function executionWriterReservation(input: {
  cwd: string;
  reservations: readonly { attemptId?: string; workspacePath: string; workspaceId?: string; slots?: number }[];
  attemptId?: string;
}): ExecutionReservation | undefined {
  const cwd = canonicalizePath(resolve(input.cwd));
  for (const reservation of input.reservations) {
    if (!reservation.attemptId || (input.attemptId && reservation.attemptId !== input.attemptId)) continue;
    const workspacePath = canonicalizePath(resolve(reservation.workspacePath));
    const rel = relative(workspacePath, cwd);
    if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("../") && !rel.startsWith("..\\"))) {
      return { role: "worker", attemptId: reservation.attemptId, workspacePath, ...(reservation.workspaceId ? { workspaceId: reservation.workspaceId } : {}) };
    }
  }
  return undefined;
}

function durableExecutionStates(): DurableExecutionState[] {
  const root = process.env.PI_EXECUTION_STATE_ROOT ?? join(homedir(), "orchestrator", "plan-driven-v1", "execution");
  if (!existsSync(root)) return [];
  const states: { reservations?: { attemptId?: string; workspacePath: string; workspaceId?: string }[]; deliveries?: { phase?: string; handoff?: { workspace?: { path?: string } } }[] }[] = [];
  for (const repoId of readdirSync(root, { withFileTypes: true })) {
    if (!repoId.isDirectory()) continue;
    try { states.push(JSON.parse(readFileSync(join(root, repoId.name, "coordinator.json"), "utf8"))); } catch { /* partial or fenced record */ }
  }
  return states;
}
export function durableExecutionReservation(cwd: string, attemptId?: string): ExecutionReservation | undefined {
  for (const state of durableExecutionStates()) {
    const found = executionWriterReservation({ cwd, reservations: Array.isArray(state.reservations) ? state.reservations : [], attemptId });
    if (found) return found;
  }
  return undefined;
}
/** Runtime-bound worker proof. An attempt ID is only a selector; the child must
 * also carry the runtime run ID and its authoritative parent session linkage,
 * both matching the persisted attempt that owns the reservation. */
function sessionHeaderId(sessionFile: string): string | undefined {
  try {
    const firstLine = readFileSync(sessionFile, "utf8").split(/\r?\n/, 1)[0];
    const header = JSON.parse(firstLine ?? "") as { type?: unknown; id?: unknown };
    return header.type === "session" && typeof header.id === "string" && header.id.length > 0 ? header.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verify the caller against the supported child-runtime binding.  The
 * attempt/workspace values are selectors carried in a namespaced public
 * extension binding; the runtime-generated run id and parent session header
 * id are independently supplied by pi-subagents and must match durable
 * evidence. Legacy env selectors are deliberately ignored.
 */
export function verifiedDurableExecutionReservation(cwd: string, env: Record<string, string | undefined> = process.env): ExecutionReservation | undefined {
  const binding = readExecutionIdentityBinding(env);
  const runId = env.PI_SUBAGENT_RUN_ID?.trim();
  const parentSessionId = env.PI_SUBAGENT_PARENT_SESSION?.trim();
  if (!binding || !runId || !parentSessionId) return undefined;
  for (const state of durableExecutionStates()) {
    const attempt = state.attempts?.find(item => item.id === binding.attemptId);
    if (!attempt || !attempt.ownerSessionFile || !attempt.run || !attempt.run.ownerSessionFile
      || attempt.run.runId !== runId
      || canonicalizePath(attempt.run.ownerSessionFile) !== canonicalizePath(attempt.ownerSessionFile)
      || sessionHeaderId(attempt.ownerSessionFile) !== parentSessionId
      || binding.ownerSessionId !== parentSessionId
      || !attempt.workspace
      || attempt.workspace.id !== binding.workspaceId
      || typeof attempt.workspace.path !== "string"
      || canonicalizePath(attempt.workspace.path) !== canonicalizePath(binding.workspacePath)) continue;
    const found = executionWriterReservation({ cwd, reservations: Array.isArray(state.reservations) ? state.reservations : [], attemptId: binding.attemptId });
    if (found && found.workspaceId === binding.workspaceId && found.workspacePath === canonicalizePath(binding.workspacePath)) return found;
  }
  return undefined;
}
/** Controller-owned delivery workspaces have no worker reservation after handoff,
 * but remain a mutation fence until the controller reaches a terminal state. */
export function durableExecutionWorkspaceFence(cwd: string): boolean {
  const target = canonicalizePath(resolve(cwd));
  return durableExecutionStates().some(state => (Array.isArray(state.deliveries) ? state.deliveries : []).some(delivery =>
    ["handoff-pending", "controller-owned", "merged", "closed-unmerged"].includes(String(delivery.phase)) &&
    typeof delivery.handoff?.workspace?.path === "string" &&
    (target === canonicalizePath(resolve(delivery.handoff.workspace.path)) || target.startsWith(`${canonicalizePath(resolve(delivery.handoff.workspace.path))}/`))));
}

const RUST = {
	wt: "git wt <branch>",
	await: "git pr-await <PR>",
	land: "git pr-land <PR>",
	rm: "git wt-rm <branch>",
} as const;

const PR_NUM = String.raw`(?:#)?(\d+)`;

export function extractPrNumber(command: string): string | undefined {
	const parsed = gitInvocations(stripComments(command));
	for (const invocation of parsed?.git ?? []) {
		if (["pr-await", "pr-land", "pr-poll"].includes(invocation.verb ?? "")) {
			const match = invocation.args.find(value => /^#?\d+$/.test(value));
			if (match) return match.replace(/^#/, "");
		}
	}
	for (const segment of parsed?.segments ?? []) for (let index = 0; index < segment.length; index++) {
		if (ghlCommandToken(segment[index]!, ["ghl-pr-await", "ghl-pr-land", "ghl-pr-poll"])) {
			const match = segment.slice(index + 1).find(value => /^#?\d+$/.test(value));
			if (match) return match.replace(/^#/, "");
		}
		if (ghCommandToken(segment[index]!)) {
			for (let next = index + 1; next < segment.length - 1; next++) {
				if (["view", "checks", "status", "watch", "merge"].includes(segment[next]!) && /^#?\d+$/.test(segment[next + 1]!)) return segment[next + 1]!.replace(/^#/, "");
			}
		}
	}
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

type ShellSegment = string[];
type LexFrame = { segments: ShellSegment[]; next: number };

/** Minimal shell lexer for guard decisions. It deliberately does not execute
 * shell syntax; quotes are decoded, separators become segment boundaries, and
 * malformed quoting is reported so callers can fail closed. Command
 * substitutions - $(...), backticks, process substitution <(...)/>(...) - and
 * bare subshells are lexed recursively, so a git/gh command hidden inside one
 * stays visible to the classifier instead of dissolving into an opaque token
 * (round-1 P1: a substitution could run a worktree add or a pr merge with no
 * guard verdict). Unterminated substitutions and quoting return undefined so
 * callers fail closed. `closer` bounds a nested frame: ")" must be closed by
 * the matching paren, "`" stops exactly at the closing backtick (which must
 * therefore never be re-lexed as an opener). */
function lexShellCommands(src: string, start: number, closer: ")" | "`" | undefined, bound: number): LexFrame | undefined {
	const segments: ShellSegment[] = [];
	let segment: string[] = [], token = "", quote: "'" | '"' | undefined;
	let escaped = false, comment = false;
	const flushToken = () => { if (token) { segment.push(token); token = ""; } };
	const flushSegment = () => { flushToken(); if (segment.length) segments.push(segment); segment = []; };
	const spliceNested = (nested: LexFrame) => { flushSegment(); for (const nestedSegment of nested.segments) segments.push(nestedSegment); };
	for (let i = start; i < bound; i++) {
		const char = src[i]!;
		if (comment) { if (char === "\n") { comment = false; flushSegment(); } continue; }
		if (escaped) { token += char; escaped = false; continue; }
		if (quote) {
			if (char === quote) quote = undefined;
			else if (quote === '"' && char === "$" && src[i + 1] === "(") {
				// command substitution executes inside double quotes too
				const nested = lexShellCommands(src, i + 2, ")", src.length);
				if (!nested) return undefined;
				spliceNested(nested);
				i = nested.next - 1;
			} else token += char;
			continue;
		}
		if (char === "\\") { escaped = true; continue; }
		if (char === "'" || char === '"') { quote = char; continue; }
		if (char === "#" && !token) { comment = true; continue; }
		if (char === ")" && closer === ")") { flushSegment(); return { segments, next: i + 1 }; }
		if ((char === "$" || char === "<" || char === ">") && src[i + 1] === "(") {
			// $(...) substitution and <(...)/>(...) process substitution execute
			// their contents; keep the nested command list visible to the classifier.
			const nested = lexShellCommands(src, i + 2, ")", src.length);
			if (!nested) return undefined;
			spliceNested(nested);
			i = nested.next - 1;
			continue;
		}
		if (char === "`") {
			if (closer === "`") return undefined; // a raw backtick inside backtick content is not valid bash
			const end = src.indexOf("`", i + 1);
			if (end === -1) return undefined;
			const nested = lexShellCommands(src, i + 1, "`", end);
			if (!nested) return undefined;
			spliceNested(nested);
			i = end;
			continue;
		}
		if (char === "(" && !token) {
			// a bare subshell is a command list too
			const nested = lexShellCommands(src, i + 1, ")", src.length);
			if (!nested) return undefined;
			spliceNested(nested);
			i = nested.next - 1;
			continue;
		}
		if (char === "\n" || char === ";" || char === "|" || char === "&") {
			flushSegment();
			if ((char === "|" || char === "&") && src[i + 1] === char) i++;
			continue;
		}
		if (/\s/.test(char)) { flushToken(); continue; }
		token += char;
	}
	if (quote || escaped) return undefined;
	if (closer === ")") return undefined; // unterminated $(
	flushSegment();
	return { segments, next: bound };
}

function shellSegments(command: string): ShellSegment[] | undefined {
	return lexShellCommands(command, 0, undefined, command.length)?.segments;
}

function gitCommandToken(token: string): boolean {
	return token === "git" || token.endsWith("/git");
}

/** `gh` matches by basename too, so `/usr/bin/gh` or a quoted absolute path
 * cannot slip past hasGhSequence the way plain `gh` cannot (round-2 P1). */
function ghCommandToken(token: string): boolean {
	return token === "gh" || token.endsWith("/gh");
}

function ghlCommandToken(token: string, names: readonly string[]): boolean {
	return names.some(name => token === name || token.endsWith(`/${name}`));
}

/** ghl-* lifecycle binaries match by basename: a whole-token equality check
 * let `/usr/bin/ghl-pr-await` (and friends) bypass every guard. */
function hasGhlToken(segments: ShellSegment[], ...names: string[]): boolean {
	return segments.some(segment => segment.some(token => ghlCommandToken(token, names)));
}

const GIT_GLOBAL_VALUE_OPTIONS = new Set([
	"--exec-path", "--work-tree", "--git-dir", "--namespace", "--config-env", "--super-prefix", "--attr-source", "--list-cmds",
]);

type GitInvocation = { tokens: string[]; index: number; verb?: string; args: string[]; paths: string[] };

function parseGitInvocation(segment: ShellSegment, index: number): GitInvocation {
	const paths: string[] = [], tokens = segment.slice(index + 1);
	let i = 0;
	const valueOption = (name: string, value: string | undefined) => {
		if (value === undefined) return;
		if (name === "-C" || name === "--work-tree" || name === "--git-dir") paths.push(value);
	};
	while (i < tokens.length) {
		const current = tokens[i]!;
		if (current === "--") return { tokens: segment, index, verb: tokens[i + 1], args: tokens.slice(i + 2), paths };
		if (current.startsWith("--")) {
			const equal = current.indexOf("=");
			const name = equal === -1 ? current : current.slice(0, equal);
			if (equal !== -1) valueOption(name, current.slice(equal + 1));
			else if (GIT_GLOBAL_VALUE_OPTIONS.has(name)) valueOption(name, tokens[++i]);
			i++;
			continue;
		}
		if (current === "-C" || current === "-c") { valueOption(current, tokens[++i]); i++; continue; }
		if (current.startsWith("-C") && current.length > 2) { valueOption("-C", current.slice(2)); i++; continue; }
		if (current.startsWith("-c") && current.length > 2) { i++; continue; }
		if (current.startsWith("-")) { i++; continue; }
		return { tokens: segment, index, verb: current, args: tokens.slice(i + 1), paths };
	}
	return { tokens: segment, index, args: [], paths };
}

function gitInvocations(command: string): { segments: ShellSegment[]; git: GitInvocation[] } | undefined {
	const segments = shellSegments(command);
	if (!segments) return undefined;
	const git: GitInvocation[] = [];
	for (const segment of segments) for (let index = 0; index < segment.length; index++) {
		if (gitCommandToken(segment[index]!)) git.push(parseGitInvocation(segment, index));
	}
	return { segments, git };
}

const WORKTREE_MUTATION_ACTIONS = new Set(["add", "remove", "prune", "move"]);
/** Pre-subcommand `git worktree` options that consume a space-separated value. */
const WORKTREE_VALUE_OPTIONS = new Set(["--path-format"]);

/** `git worktree` parses its own options before the subcommand (`git worktree
 * -q add`, `git worktree --force remove`), so the action is not always
 * args[0]. Return the action: the first positional argument, skipping option
 * tokens (and the space-separated value of a known value option); everything
 * after `--` is positional. */
function worktreeAction(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") return args[i + 1];
		if (WORKTREE_VALUE_OPTIONS.has(arg)) { i++; continue; }
		if (arg.startsWith("-")) continue;
		return arg;
	}
	return undefined;
}

/** A raw `git worktree add/remove/prune/move` under any option spelling. */
function isRawWorktreeMutation(invocation: GitInvocation): boolean {
	return invocation.verb === "worktree" && WORKTREE_MUTATION_ACTIONS.has(worktreeAction(invocation.args) ?? "");
}

const GH_GLOBAL_VALUE_OPTIONS = new Set(["--repo", "--hostname", "--git-protocol", "--jq", "--template", "--limit", "--state", "--json"]);

function hasGhSequence(segments: ShellSegment[], sequence: string[]): boolean {
	return segments.some(segment => segment.some((token, index) => {
		if (!ghCommandToken(token)) return false;
		let cursor = index + 1, matched = 0;
		while (cursor < segment.length && matched < sequence.length) {
			const current = segment[cursor]!;
			if (current.startsWith("--")) {
				if (!current.includes("=") && GH_GLOBAL_VALUE_OPTIONS.has(current)) cursor++;
				cursor++;
				continue;
			}
			if (current !== sequence[matched]) return false;
			matched++; cursor++;
		}
		return matched === sequence.length;
	}));
}

export function classifyGitWorkflowCommand(command: string): GuardVerdict {
	const text = stripComments(command), parsed = gitInvocations(text);
	// A malformed shell command containing a workflow executable cannot be
	// safely classified. Blocking is safer than allowing an unparsed segment.
	// Substitution openers - $(, <(, >(, backtick, subshell ( - can directly
	// precede a workflow executable, so they count as workflow positions too.
	if (!parsed && /(?:^|[\s;&|`(<>])(?:[^\s;&|/]+\/)*(git|gh|ghl-)[^\s;&|]*/.test(text)) return { block: true, reason: "Unsupported shell syntax; split the command into a supported, bounded invocation." };
	const segments = parsed?.segments ?? [];
	const git = parsed?.git ?? [];
	const hasPrPoll = git.some(invocation => invocation.verb === "pr-poll") || hasGhlToken(segments, "ghl-pr-poll");
	if (hasPrPoll) return { block: true, reason: `git pr-poll is retired. Use ${awaitHint(text)} once, then stop. The latch wakes this session.` };
	const worktree = git.find(isRawWorktreeMutation);
	if (worktree) {
		return { block: true, reason: worktreeAction(worktree.args) === "add" ? `raw git worktree add is blocked. Use ${RUST.wt} (ghl-wt).` : `raw git worktree remove/prune is blocked. Use ${RUST.rm} (ghl-wt-rm).` };
	}
	if (hasGhSequence(segments, ["pr", "merge"])) return { block: true, reason: `gh pr merge is blocked (including --admin). The waiter lands. Use ${awaitHint(text)} once, then stop.` };
	const hasView = hasGhSequence(segments, ["pr", "view"]) || hasGhSequence(segments, ["pr", "checks"]) || hasGhSequence(segments, ["pr", "status"]) || hasGhSequence(segments, ["run", "watch"])
		|| /\bgh\s+pr\s+(?:view|checks|status)\b/.test(text) || /\bgh\s+run\s+watch\b/.test(text);
	const hasFetch = git.some(invocation => invocation.verb === "fetch") || /\bgit\s+fetch\b/.test(text);
	const hasSleep = /\bsleep\s+\d/.test(text) || /\btimeout\s+\d/.test(text);
	const hasLoop = /\bfor\s+\w+\s+in\b/.test(text) || /\bwhile\s+/.test(text) || /\buntil\s+/.test(text);
	if (hasView && (hasFetch || hasSleep || hasLoop)) return { block: true, reason: `PR wait/poll via bash is blocked (git fetch + gh pr view, sleep loops, for/while). Use ${awaitHint(text)} once → next=yield → stop talking. Do not drain-poll.` };
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

function writerBlock(command: string): GuardVerdict | undefined {
	const parsed = gitInvocations(stripComments(command)), git = parsed?.git ?? [], segments = parsed?.segments ?? [];
	if (git.some(invocation => invocation.verb === "pr-await") || hasGhlToken(segments, "ghl-pr-await")) return { block: true, reason: "a writer child never waits on the review. Settle with your handoff; code runs git pr-await once, from the parent." };
	if (git.some(invocation => invocation.verb === "pr-land") || hasGhlToken(segments, "ghl-pr-land") || hasGhSequence(segments, ["pr", "merge"])) return { block: true, reason: "a writer child never lands the PR. Code lands it when the waiter says so." };
	const rawWorktree = git.some(isRawWorktreeMutation);
	if (rawWorktree || git.some(invocation => invocation.verb === "wt" || invocation.verb === "wt-rm") || hasGhlToken(segments, "ghl-wt", "ghl-wt-rm")) return { block: true, reason: "a writer child never creates or removes a worktree. You were given one; work in it." };
	if (["create", "comment", "edit", "close", "reopen", "ready"].some(action => hasGhSequence(segments, ["pr", action]))) return { block: true, reason: "a writer child never speaks on the PR. Put it in your handoff; code opens the PR and posts on it." };
	if (git.some(invocation => invocation.verb === "push")) return { block: true, reason: "a writer child commits; code pushes. Commit your work and settle — the push is one per round, from the parent." };
	return undefined;
}

/**
 * The guard for one command, given the role of the session running it.
 *
 * Writer blocks are checked first: the solo allowlist deliberately waves
 * `git pr-await` through, and for a child that is exactly the wrong answer.
 */
const PARENT_MUTATION_VERB =
	/^(add|commit|push|checkout|restore|reset|rebase|merge|cherry-pick|rm|mv|clean|switch)$/;

function isLifecycleMutation(command: string): boolean {
	const text = stripComments(command), parsed = gitInvocations(text);
	if (parsed?.git.some(invocation => ["wt", "wt-rm", "pr-await", "pr-land"].includes(invocation.verb ?? ""))) return true;
	if (hasGhlToken(parsed?.segments ?? [], "ghl-wt", "ghl-wt-rm", "ghl-pr-await", "ghl-pr-land")) return true;
	return ["create", "merge", "close", "reopen", "ready", "edit", "comment"].some(action => hasGhSequence(parsed?.segments ?? [], ["pr", action]));
}

export function isWorktreeMutation(command: string): boolean {
	const parsed = gitInvocations(stripComments(command));
	return !!parsed?.git.some(invocation => PARENT_MUTATION_VERB.test(invocation.verb ?? ""));
}


function resolveMutationDir(dir: string, fallbackCwd?: string): string {
	const trimmed = dir.replace(/\/+$/, "").replace(/\/\.git$/, "");
	if (!trimmed) return "";
	const base = fallbackCwd?.replace(/\/+$/, "") || process.cwd();
	const lexical = resolve(trimmed.startsWith("/") ? trimmed : resolve(base, trimmed)).replace(/\/+$/, "");
	return canonicalizePath(lexical);
}

/** Worktrees a bash command would mutate: `cd DIR && git …`, `git -C DIR`, fallback cwd. */
export function mutationTargetDirs(command: string, fallbackCwd?: string): string[] {
	const parsed = gitInvocations(stripComments(command));
	const dirs: string[] = [];
	if (parsed) {
		for (const segment of parsed.segments) for (let index = 0; index < segment.length; index++) {
			if (segment[index] !== "cd") continue;
			const raw = segment[index + 1];
			if (raw && raw !== "-" && !raw.startsWith("-")) {
				const resolved = resolveMutationDir(raw, fallbackCwd);
				if (resolved) dirs.push(resolved);
			}
		}
		for (const invocation of parsed.git) for (const raw of invocation.paths) {
			const resolved = resolveMutationDir(raw, fallbackCwd);
			if (resolved) dirs.push(resolved);
		}
	}
	if (fallbackCwd) dirs.push(canonicalizePath(resolve(fallbackCwd.replace(/\/+$/, "")).replace(/\/+$/, "")));
	return [...new Set(dirs)];
}

export function classifyForRole(
	command: string,
	opts: { writer: boolean; writerReserved?: boolean; executionRole?: ExecutionGuardRole },
): GuardVerdict {
	const worker = opts.writer || opts.executionRole === "worker";
	const reservedParent = !worker && (opts.writerReserved || opts.executionRole === "parent");
	if (worker) {
		const blocked = writerBlock(command);
		if (blocked) return blocked;
	}
	if (reservedParent && (isWorktreeMutation(command) || isLifecycleMutation(command))) {
		return {
			block: true,
			reason:
				"a fixer holds this worktree; the parent must not mutate it. The controller publishes after the child settles.",
		};
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
