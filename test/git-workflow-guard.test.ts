/**
 * Run: npm test  (or: node --experimental-strip-types --test test/git-workflow-guard.test.ts)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import guardExtension from "../src/git-workflow-guard.ts";
import { EXECUTION_IDENTITY_BINDING_NAMESPACE, PI_SUBAGENT_EXTENSION_BINDINGS_ENV } from "../src/lib/execution-identity.ts";

import {
	classifyForRole,
	classifyGitWorkflowCommand,
	classifyViewRepeat,
	extractPrNumber,
	isWorktreeMutation,
	isWriterRole,
	mutationTargetDirs,
	viewRepeatKey,
	VIEW_REPEAT_LIMIT,
} from "../src/lib/git-workflow-guard.ts";

function blocked(cmd: string): string {
	const v = classifyGitWorkflowCommand(cmd);
	assert.equal(v.block, true, `expected block: ${cmd}`);
	return v.block ? v.reason : "";
}

function allowed(cmd: string): void {
	const v = classifyGitWorkflowCommand(cmd);
	assert.equal(v.block, false, `expected allow: ${cmd} got ${v.block ? v.reason : ""}`);
}

test("allows rust git-workflow aliases and binaries", () => {
	allowed("git wt fix-proxy-window-entry");
	allowed("git wt-rm fix-proxy-window-entry");
	allowed("git pr-await 2166");
	allowed("git pr-land 2166");
	allowed("ghl-wt fix-proxy-window-entry");
	allowed("ghl-wt-rm fix-proxy-window-entry");
	allowed("ghl-pr-await 2166");
	allowed("ghl-pr-land 2166");
	allowed('cd /Users/greg/Dev/git/ice-wt/fix-proxy-window-entry && git pr-await 2166');
});

test("allows ordinary git and a single gh pr view", () => {
	allowed("git status");
	allowed("git diff");
	allowed("git log -1");
	allowed("git add -A && git commit -q -m 'msg'");
	allowed("git push -u origin HEAD");
	allowed("git fetch -q origin main");
	allowed("gh pr create --title x --body y");
	allowed("gh pr list");
	allowed("gh pr view 2166 --json state,mergedAt");
	allowed("git worktree list");
});

test("blocks the Aug 27 Flash poll (fetch + gh pr view)", () => {
	const cmd = `cd /Users/greg/Dev/git/icemining && git fetch -q origin main 2>/dev/null
echo "2166: $(gh pr view 2166 --json state,mergedAt --jq '{state,mergedAt}' 2>/dev/null)"
`;
	const reason = blocked(cmd);
	assert.match(reason, /git pr-await 2166/);
	assert.match(reason, /wait\/poll/);
});

test("blocks sleep/for drain-poll of gh pr view", () => {
	const cmd = `cd /Users/greg/Dev/git/icemining && git fetch -q origin main 2>/dev/null
for i in 1 2 3; do sleep 150; S=$(gh pr view 2166 --json state,mergedAt --jq '{state,mergedAt}' 2>/dev/null); echo "$S"; done
`;
	assert.match(blocked(cmd), /git pr-await 2166/);
	assert.match(blocked("while true; do gh pr view 2166; sleep 30; done"), /git pr-await 2166/);
	assert.match(blocked("sleep 150; gh pr checks 2166"), /git pr-await 2166/);
});

test("blocks raw worktree add/remove, gh pr merge, retired pr-poll", () => {
	assert.match(blocked("git worktree add ../ice-wt/foo -b foo"), /git wt/);
	assert.match(blocked("git worktree remove /Users/greg/Dev/git/ice-wt/foo"), /git wt-rm/);
	assert.match(blocked("git worktree prune"), /git wt-rm/);
	assert.match(blocked("gh pr merge 2166 --admin"), /git pr-await 2166/);
	assert.match(blocked("git pr-poll 2166"), /retired/);
	assert.match(blocked("ghl-pr-poll 2166"), /retired/);
});

/* ---------------------------------------------------------------- *
 * Round-1 P1 — the lexer treated $(…) and backticks as opaque token
 * text, so gitInvocations()/hasGhSequence() never saw the workflow
 * command inside a substitution: $(git worktree add …), `gh pr merge
 * …` and equivalents executed without a guard verdict. Substitutions
 * and bare subshells must be parsed, and unparseable ones containing
 * a workflow executable must fail closed.
 * ---------------------------------------------------------------- */

test("blocks workflow commands hidden inside shell substitutions", () => {
	assert.match(blocked("echo $(git worktree add ../ice-wt/sub -b sub)"), /git wt/);
	assert.match(blocked("$(gh pr merge 2166 --admin)"), /git pr-await 2166/);
	assert.match(blocked("`git worktree prune`"), /git wt-rm/);
	assert.match(blocked("echo `gh pr merge 2166 --squash`"), /git pr-await 2166/);
	assert.match(blocked("diff <(git worktree list) <(git worktree prune)"), /git wt-rm/);
	assert.match(blocked("(git worktree add ../ice-wt/sub -b sub)"), /git wt/);
	assert.match(blocked("echo $(outer $(git pr-poll 2166))"), /retired/);
	assert.match(blocked('git commit -m "$(git worktree prune)"'), /git wt-rm/);
	assert.match(blocked('echo "$(git worktree prune; echo done)"'), /git wt-rm/);
});

test("unparseable substitutions carrying a workflow executable fail closed", () => {
	assert.match(blocked('$(git status "unterminated)'), /Unsupported shell syntax/);
	assert.match(blocked("echo $(git status"), /Unsupported shell syntax/);
	assert.match(blocked("echo `git status"), /Unsupported shell syntax/);
});

test("ordinary git with benign substitutions stays allowed", () => {
	allowed('git commit -m "rev $(git rev-parse --short HEAD)"');
	allowed('git commit -m "built $(date +%Y-%m-%d)"');
	allowed("BRANCH=$(git rev-parse --abbrev-ref HEAD); git status");
});

test("writer restrictions see workflow commands hidden inside substitutions", () => {
	for (const command of [
		"$(git push origin HEAD)",
		"echo `git push --force origin main`",
		'git commit -m "$(git pr-await 2210)"',
		"run <(git wt feat/x)",
	]) {
		const verdict = classifyForRole(command, { writer: true });
		assert.equal(verdict.block, true, `a writer child must not run: ${command}`);
		assert.match(
			String((verdict as { reason?: string }).reason ?? ""),
			/writer child/,
			`the block must come from the writer path, not an unparsed allow: ${command}`,
		);
	}
	assert.equal(classifyForRole('git commit -m "built $(date)"', { writer: true }).block, false);
});

/* ---------------------------------------------------------------- *
 * Round-2 P1 (codex) — `git worktree` parses its own options before
 * the subcommand (`git worktree -q add`, `git worktree --force
 * remove`), so the action is not always args[0]. The general
 * classifier, the writer guard, and the reserved-parent fence all
 * allowed a raw worktree create/remove that led with an option.
 * ---------------------------------------------------------------- */

test("blocks worktree mutations whose action follows pre-subcommand options", () => {
	assert.match(blocked("git worktree -q add ../ice-wt/sub -b sub"), /git wt/);
	assert.match(blocked("git worktree --force remove /Users/greg/Dev/git/ice-wt/foo"), /git wt-rm/);
	assert.match(blocked("git worktree -v --force prune"), /git wt-rm/);
	assert.match(blocked("git worktree --path-format absolute add ../ice-wt/sub -b sub"), /git wt/);
	assert.match(blocked("git worktree --path-format=relative prune"), /git wt-rm/);
	// the plain forms stay blocked
	assert.match(blocked("git worktree add ../ice-wt/sub -b sub"), /git wt/);
	assert.match(blocked("git worktree prune"), /git wt-rm/);
	// read-only worktree invocations with pre-subcommand options stay allowed
	allowed("git worktree -q list");
	allowed("git worktree -v --path-format absolute list");
});

test("writer and reserved-parent guards parse worktree actions that follow options", () => {
	for (const command of [
		"git worktree -q add ../later -b later",
		"git worktree --force remove ../later",
		"echo $(git worktree -q add ../later -b later)",
	]) {
		const verdict = classifyForRole(command, { writer: true });
		assert.equal(verdict.block, true, `a writer child must not run: ${command}`);
		assert.match(
			String((verdict as { reason?: string }).reason ?? ""),
			/never creates or removes a worktree/,
			`the block must come from the writer path: ${command}`,
		);
	}
	assert.equal(
		classifyForRole("git worktree -v list", { writer: true }).block,
		false,
		"read-only worktree listing stays allowed for a writer",
	);
	for (const command of ["git worktree -q add ../later -b later", "git worktree --force remove ../later"]) {
		assert.equal(
			classifyForRole(command, { writer: false, writerReserved: true }).block,
			true,
			`a reserved parent must not run: ${command}`,
		);
		assert.equal(
			classifyForRole(command, { writer: false, executionRole: "parent" }).block,
			true,
			`an execution-reserved parent must not run: ${command}`,
		);
	}
	assert.equal(
		classifyForRole("git worktree -q list", { writer: false, writerReserved: true }).block,
		false,
		"read-only worktree listing stays allowed for a reserved parent",
	);
});

test("blocks a prohibited worktree operation after a read-only worktree segment", () => {
	const command = "git worktree list && git worktree add ../ice-wt/later -b later";
	assert.match(blocked(command), /git wt/);
	assert.equal(classifyForRole(command, { writer: false }).block, true);
});

/* ---------------------------------------------------------------- *
 * Round-2 P1 (grok) — hasGhSequence required the exact token `gh`
 * (unlike gitCommandToken, which accepts a path ending in /git), and the
 * ghl-* checks compared whole tokens, so `/usr/bin/gh pr merge`, a quoted
 * `/usr/bin/ghl-pr-land`, or `$(/opt/ghl/bin/ghl-pr-await …)` executed
 * with no guard verdict — bypassing the writer publication fence, the
 * reserved-parent lifecycle fence, and the general merge/poll blocks.
 * Workflow executables must match by basename, exactly like git.
 * ---------------------------------------------------------------- */

test("blocks gh and ghl binaries at absolute or quoted paths (general classifier)", () => {
	assert.match(blocked("/usr/bin/gh pr merge 2166 --admin"), /git pr-await 2166/);
	assert.match(blocked('"/usr/bin/gh" pr merge 2166 --admin'), /git pr-await 2166/);
	assert.match(blocked("echo $(/opt/homebrew/bin/gh pr merge 2166)"), /git pr-await 2166/);
	assert.match(blocked("/usr/local/bin/ghl-pr-poll 2166"), /retired/);
	assert.match(blocked("echo `'/usr/local/bin/ghl-pr-poll' 2166`"), /retired/);
	// unparseable commands carrying a path'd workflow binary still fail closed
	assert.match(blocked("echo $(/usr/bin/gh pr merge 2166"), /Unsupported shell syntax/);
	assert.match(blocked("echo '/usr/local/bin/ghl-pr-poll 2166"), /Unsupported shell syntax/);
	// legitimate read-only path'd controls stay allowed
	allowed("/usr/bin/gh pr view 2166 --json state");
	allowed("/usr/bin/gh pr list");
	allowed("/usr/local/bin/ghl-pr-await 2166");
	allowed("/usr/local/bin/ghl-pr-land 2166");
});

test("writer and reserved-parent guards catch gh/ghl binaries at absolute or quoted paths", () => {
	for (const command of [
		"/usr/bin/gh pr merge 2210 --squash",
		"/usr/bin/gh pr create --title x --body y",
		"/usr/bin/gh pr comment 2210 --body 'no'",
		'"/opt/gh/bin/gh" pr merge 2210',
		"/opt/ghl/bin/ghl-pr-await 2210",
		"/opt/ghl/bin/ghl-pr-land 2210",
		"/opt/ghl/bin/ghl-wt feat/x",
		"/opt/ghl/bin/ghl-wt-rm feat/x",
		"echo $(/opt/ghl/bin/ghl-pr-land 2210)",
		"echo `/usr/bin/gh pr merge 2210`",
	]) {
		const verdict = classifyForRole(command, { writer: true });
		assert.equal(verdict.block, true, `a writer child must not run: ${command}`);
		assert.match(
			String((verdict as { reason?: string }).reason ?? ""),
			/writer child/,
			`the block must come from the writer path, not an unparsed allow: ${command}`,
		);
	}
	// a writer still may read the PR through an absolute binary
	assert.equal(classifyForRole("/usr/bin/gh pr view 2210", { writer: true }).block, false);
	for (const command of [
		"/usr/bin/ghl-pr-land 2210",
		"/usr/bin/ghl-pr-await 2210",
		"/opt/ghl/bin/ghl-wt feat/x",
		"/usr/bin/gh pr merge 2210",
		"echo $(/opt/ghl/bin/ghl-pr-land 2210)",
	]) {
		for (const opts of [{ writer: false, writerReserved: true }, { writer: false, executionRole: "parent" as const }]) {
			assert.equal(classifyForRole(command, opts).block, true, `a reserved parent must not run: ${command}`);
		}
	}
	// read-only path'd controls stay allowed for a reserved parent too
	assert.equal(classifyForRole("/usr/bin/gh pr view 2210", { writer: false, writerReserved: true }).block, false);
	assert.equal(classifyForRole("/usr/bin/gh pr view 2210", { writer: false, executionRole: "parent" }).block, false);
});

/* ---------------------------------------------------------------- *
 * Round-2 P1 (codex) — parseGitInvocation consumed the `-c` value and
 * classified the NEXT token as the git verb, so an inline alias config
 * (`git -c alias.x='!gh pr merge 1' x`) executed blocked lifecycle
 * mutations while every classifier returned unblocked. An inline
 * alias.* definition can install an executable shell alias, so every
 * spelling the parser recognises fails closed. Ordinary non-alias
 * configuration and the installed trusted workflow aliases stay
 * allowed.
 * ---------------------------------------------------------------- */

test("blocks inline git config alias definitions in every parsed option spelling", () => {
	// split `-c <value>`: the value was skipped, the alias name became the verb
	assert.match(blocked("git -c alias.x='!gh pr merge 1' x"), /alias/);
	assert.match(blocked("git -c alias.x='!git worktree add ../ice-wt/sub -b sub' x"), /alias/);
	// attached `-c<value>`
	assert.match(blocked("git -calias.x='!gh pr merge 1' x"), /alias/);
	// long equal and split `--config-env` spellings set config from a value/env too
	assert.match(blocked("git --config-env=alias.x=EV x"), /alias/);
	assert.match(blocked("git --config-env alias.x=EV x"), /alias/);
	assert.match(blocked("git --config=alias.x='!gh pr merge 1' x"), /alias/);
	// git config section/variable names are case-insensitive
	assert.match(blocked("git -c ALIAS.X='!gh pr merge 1' x"), /alias/);
	// a bare alias key with no '=' still defines the alias
	assert.match(blocked("git -c alias.x x"), /alias/);
	// quotes decode in the lexer, so a quoted value is still the config value
	assert.match(blocked('git -c "alias.x=!gh pr merge 1" x'), /alias/);
	// hidden inside a substitution the invocation is classified the same way
	assert.match(blocked("echo $(git -c alias.x='!git pr-land 1' x)"), /alias/);
});

test("inline alias rejection holds for writers and the reserved parent", () => {
	for (const command of [
		"git -c alias.x='!git push --force origin main' x",
		"git -calias.x='!gh pr merge 1' x",
		"git --config-env=alias.x=EV x",
	]) {
		assert.equal(classifyForRole(command, { writer: true }).block, true, `a writer child must not run: ${command}`);
		for (const opts of [{ writer: false, writerReserved: true }, { writer: false, executionRole: "parent" as const }]) {
			assert.equal(classifyForRole(command, opts).block, true, `a reserved parent must not run: ${command}`);
		}
	}
});

test("ordinary inline git config and installed workflow aliases stay allowed", () => {
	allowed("git -c core.pager=cat status");
	allowed("git -c advice.detachedHead=false commit -m x");
	allowed("git -c color.ui=always diff");
	allowed("git -c core.pager=cat pr-await 13");
	allowed("git pr-await 13");
});

test("extractPrNumber", () => {
	assert.equal(extractPrNumber("gh pr view 2166 --json state"), "2166");
	assert.equal(extractPrNumber("git pr-await 479"), "479");
	assert.equal(extractPrNumber("git status"), undefined);
});

test("repeat lone gh pr view after VIEW_REPEAT_LIMIT", () => {
	const cmd = "gh pr view 2166 --json state,mergedAt";
	assert.equal(viewRepeatKey(cmd), "view:2166");
	assert.equal(classifyViewRepeat(VIEW_REPEAT_LIMIT, cmd).block, false);
	const third = classifyViewRepeat(VIEW_REPEAT_LIMIT + 1, cmd);
	assert.equal(third.block, true);
	if (third.block) assert.match(third.reason, /git pr-await 2166/);
	assert.equal(viewRepeatKey("git fetch; gh pr view 2166"), undefined);
});

/* ---------------------------------------------------------------- *
 * P2 F7 — a writer child is not the solo session
 *
 * The fixer was handed the solo git-workflow skill, whose `next=` table tells
 * it to run `git pr-await` once after a push. The guard allowlisted exactly
 * that, so an obedient fixer forked a second waiter with its own state file
 * from inside a child session. Nothing in the child role stopped it.
 * ---------------------------------------------------------------- */

test("writer restrictions parse git global options on every command segment", () => {
  for (const command of [
    "git -C /reserved push",
    "git --no-pager -C /reserved pr-await 1",
    "git --git-dir=/reserved/.git wt branch",
    "git status && git -C /reserved push",
  ]) {
    const verdict = classifyForRole(command, { writer: true });
    assert.equal(verdict.block, true, `global options/segments must not bypass writer guard: ${command}`);
  }
  assert.equal(isWorktreeMutation("git --no-pager -C /reserved add ."), true);
  assert.ok(mutationTargetDirs("git --no-pager -C /reserved commit -m x", "/elsewhere").includes("/reserved"));
  assert.equal(classifyGitWorkflowCommand("git --no-pager pr-await 1").block, false);
  assert.match(blocked("git --no-pager pr-poll 1"), /git pr-await 1/);
});

test("P2 F7: a writer child may not wait, land, worktree, push, or touch the PR", () => {
  const blocked = [
    "git pr-await 2210",
    "ghl-pr-await 2210",
    "git pr-land 2210",
    "ghl-pr-land 2210",
    "git wt feat/x",
    "ghl-wt feat/x",
    "git wt-rm feat/x",
    "gh pr create --title x --body y",
    "gh pr merge 2210 --squash",
    "gh pr comment 2210 --body 'I disagree'",
    "git push",
    "git push -u origin HEAD",
    "git push --force-with-lease origin feat/x",
  ];
  for (const command of blocked) {
    const verdict = classifyForRole(command, { writer: true });
    assert.equal(verdict.block, true, `a writer child must not run: ${command}`);
    assert.match(
      String((verdict as { reason: string }).reason),
      /\S/,
      "a block must say why, so the child stops instead of retrying",
    );
  }
});

test("P2 F7: a writer child still commits, reads, and runs its own gate", () => {
  const allowed = [
    "git status --porcelain",
    "git add -A",
    "git commit -m 'Task 3 — bound the fix loop'",
    "git diff HEAD",
    "git log --oneline -5",
    "git fetch origin",
    "cargo test -p stratum-backend",
    "npm test",
  ];
  for (const command of allowed) {
    assert.equal(
      classifyForRole(command, { writer: true }).block,
      false,
      `a writer child must still be able to run: ${command}`,
    );
  }
});

test("P2 F7: the solo session keeps the rust entrypoints the skill herds it toward", () => {
  for (const command of ["git pr-await 2210", "git wt feat/x", "git pr-land 2210", "git push"]) {
    assert.equal(
      classifyForRole(command, { writer: false }).block,
      false,
      `the solo session owns ${command}`,
    );
  }
  // The solo rules still apply on top of the role.
  assert.equal(classifyForRole("git pr-poll 2210", { writer: false }).block, true);
  assert.equal(classifyForRole("gh pr merge 2210", { writer: false }).block, true);
});

test("P2 F7: the writer role is read from the env pi-subagents already sets", () => {
  assert.equal(isWriterRole({}), false, "a plain session is not a writer");
  assert.equal(isWriterRole({ PI_SUBAGENT_CHILD_AGENT: "fixer" }), true);
  assert.equal(isWriterRole({ PI_SUBAGENT_CHILD_AGENT: "tdd-worker" }), true);
  assert.equal(isWriterRole({ PI_SUBAGENT_CHILD_AGENT: "feature-qa" }), true);
  assert.equal(
    isWriterRole({ PI_SUBAGENT_CHILD_AGENT: "planner" }),
    false,
    "a planner writes no code and needs no push",
  );
  assert.equal(
    isWriterRole({ ORCHESTRATE_ROLE: "writer" }),
    true,
    "an explicit spawn env is honoured too",
  );
});

test("parent mutation is blocked while a fixer holds the worktree", () => {
  assert.equal(classifyForRole("git push", { writer: false, writerReserved: true }).block, true);
  assert.equal(classifyForRole("git commit -m fix", { writer: false, writerReserved: true }).block, true);
  assert.equal(classifyForRole("git status", { writer: false, writerReserved: true }).block, false);
  assert.equal(classifyForRole("git push", { writer: false, writerReserved: false }).block, false);
});

test("mutationTargetDirs sees cd and git -C, not only the event cwd", () => {
  assert.deepEqual(mutationTargetDirs("cd /wt/feat && git commit -m x", "/elsewhere"), [
    "/wt/feat",
    "/elsewhere",
  ]);
  assert.deepEqual(mutationTargetDirs("git -C /wt/feat commit -m x", "/elsewhere"), [
    "/wt/feat",
    "/elsewhere",
  ]);
  assert.deepEqual(mutationTargetDirs("cd /wt/feat/src && git commit -m x", "/elsewhere"), [
    "/wt/feat/src",
    "/elsewhere",
  ]);
});

test("mutationTargetDirs resolves relative cd and git -C against the event cwd", () => {
  const tmpRoot = realpathSync("/tmp");
  assert.ok(
    mutationTargetDirs("git -C ../feature commit -m x", join(tmpRoot, "elsewhere")).includes(
      join(tmpRoot, "feature"),
    ),
  );
  assert.ok(
    mutationTargetDirs("cd ../feature && git commit -m x", join(tmpRoot, "elsewhere")).includes(
      join(tmpRoot, "feature"),
    ),
  );
  assert.ok(
    mutationTargetDirs("git -C './src' commit -m x", "/wt/feat").includes("/wt/feat/src"),
  );
});

test("isWorktreeMutation covers rm/mv/clean/switch, not only commit/push", () => {
  assert.equal(isWorktreeMutation("git rm src/a.ts"), true);
  assert.equal(isWorktreeMutation("git mv a.ts b.ts"), true);
  assert.equal(isWorktreeMutation("git clean -fd"), true);
  assert.equal(isWorktreeMutation("git switch feat/x"), true);
  assert.equal(isWorktreeMutation("git status"), false);
  assert.equal(isWorktreeMutation("git log -1"), false);
});

test("isWorktreeMutation sees verbs after git -C and --work-tree", () => {
  assert.equal(isWorktreeMutation("git -C /wt/feat add ."), true);
  assert.equal(
    isWorktreeMutation("git --git-dir=/wt/feat/.git --work-tree=/wt/feat commit -m x"),
    true,
  );
  assert.equal(isWorktreeMutation("git -C /wt/feat status"), false);
});

test("isWorktreeMutation sees a mutating git after a harmless one in the same shell", () => {
  assert.equal(isWorktreeMutation("git status && git push"), true);
  assert.equal(isWorktreeMutation("git status; git push origin HEAD"), true);
  assert.equal(isWorktreeMutation("git log -1 || git commit -m x"), true);
  assert.equal(isWorktreeMutation("git status && git log -1"), false);
  assert.equal(
    classifyForRole("git status && git push", { writer: false, writerReserved: true }).block,
    true,
    "a reserved worktree must still block a later push in the compound command",
  );
});

test("mutationTargetDirs realpaths a symlink into the reserved worktree", () => {
	const root = mkdtempSync(join(tmpdir(), "guard-link-"));
	try {
		const reserved = join(root, "feat");
		mkdirSync(reserved);
		const link = join(root, "link");
		symlinkSync(reserved, link);
		const dirs = mutationTargetDirs(`git -C ${link} commit -m x`, "/elsewhere");
		assert.ok(
			dirs.includes(realpathSync(reserved)),
			`symlink target must canonicalize; got ${dirs.join(" | ")}`,
		);
		assert.equal(dirs.includes(link), false, "lexical symlink path must not be the reservation key");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("registered guard keeps a parent and forged attempt identity out of a reserved workspace", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "guard-registration-home-")));
  const workspace = join(home, "reserved"); mkdirSync(workspace, { recursive: true });
  const ownerSession = join(home, "owner.jsonl");
  writeFileSync(ownerSession, JSON.stringify({ type: "session", id: "owner-header-1" }) + "\n");
  const stateDir = join(home, "orchestrator", "plan-driven-v1", "execution", "repo"); mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "coordinator.json"), JSON.stringify({
    reservations: [{ attemptId: "attempt-1", workspacePath: workspace, workspaceId: "workspace-1" }],
    attempts: [{ id: "attempt-1", ownerSessionFile: ownerSession, workspace: { id: "workspace-1", path: workspace }, run: { runId: "run-1", ownerSessionFile: ownerSession } }],
    deliveries: [],
  }));
  const priorHome = process.env.HOME, priorStateRoot = process.env.PI_EXECUTION_STATE_ROOT, priorAttempt = process.env.PI_EXECUTION_ATTEMPT_ID, priorRun = process.env.PI_SUBAGENT_RUN_ID, priorParent = process.env.PI_SUBAGENT_PARENT_SESSION, priorAgent = process.env.PI_SUBAGENT_CHILD_AGENT, priorRole = process.env.ORCHESTRATE_ROLE, priorBindings = process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV];
  process.env.HOME = home; process.env.PI_EXECUTION_STATE_ROOT = join(home, "orchestrator", "plan-driven-v1", "execution"); delete process.env.PI_EXECUTION_ATTEMPT_ID; delete process.env.PI_SUBAGENT_RUN_ID; delete process.env.PI_SUBAGENT_PARENT_SESSION; delete process.env.PI_SUBAGENT_CHILD_AGENT; delete process.env.ORCHESTRATE_ROLE;
  try {
    let handler: ((event: any) => Promise<any>) | undefined;
    guardExtension({ on(name: string, fn: any) { if (name === "tool_call") handler = fn; } } as unknown as ExtensionAPI);
    assert.ok(handler);
    const parent = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git commit -m parent" } });
    assert.equal(parent?.block ?? false, true, "reserved workspace is not proof that the caller is its worker");
    process.env.PI_EXECUTION_ATTEMPT_ID = "attempt-1";
    const forged = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git commit -m forged" } });
    assert.equal(forged?.block ?? false, true, "matching attempt ID without runtime/session binding is forged");
    process.env.PI_SUBAGENT_RUN_ID = "run-1"; process.env.PI_SUBAGENT_PARENT_SESSION = join(home, "foreign-owner.jsonl");
    const foreign = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git commit -m foreign" } });
    assert.equal(foreign?.block ?? false, true, "matching attempt/run IDs from a foreign session are not worker proof");
    process.env.PI_SUBAGENT_PARENT_SESSION = join(home, "owner.jsonl");
    const mixed = await handler!({ toolName: "bash", cwd: workspace, input: { command: `cd ${workspace} && git commit -m own && cd ${home} && git push` } });
    assert.equal(mixed?.block ?? false, true, "every mutation target must be independently authorized");
    // Establish the real supported binding: runtime run id + parent session
    // header id + namespaced extension binding, all matching the persisted
    // attempt. Labels alone never prove a worker.
    process.env.PI_SUBAGENT_CHILD_AGENT = "tdd-worker";
    process.env.PI_SUBAGENT_RUN_ID = "run-1";
    process.env.PI_SUBAGENT_PARENT_SESSION = "owner-header-1";
    process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV] = JSON.stringify({ [EXECUTION_IDENTITY_BINDING_NAMESPACE]: { attemptId: "attempt-1", workspaceId: "workspace-1", workspacePath: workspace, ownerSessionId: "owner-header-1" } });
    const own = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git commit -m own" } });
    assert.equal(own?.block ?? false, false, "a verified worker may mutate its own reserved workspace");
    for (const [command, why] of [
      ["gh pr create --title x --body y", /never speaks on the PR/],
      ["git wt branch", /never creates or removes a worktree/],
      ["git pr-await 1", /never waits on the review/],
      ["git pr-land 1", /never lands the PR/],
      ["git push", /writer child commits; code pushes/],
      ["git worktree list && git worktree add ../later -b later", /never creates or removes a worktree/],
    ] as const) {
      const worker = await handler!({ toolName: "bash", cwd: workspace, input: { command } });
      assert.equal(worker?.block ?? false, true, `verified execution worker must be blocked from ${command}`);
      assert.match(String((worker as { reason?: string }).reason ?? ""), why, `the block must come from the worker path: ${command}`);
    }
    // A forged binding (right shape, wrong owner session) is rejected: the
    // caller loses the worker role and falls back to the reserved-parent path.
    process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV] = JSON.stringify({ [EXECUTION_IDENTITY_BINDING_NAMESPACE]: { attemptId: "attempt-1", workspaceId: "workspace-1", workspacePath: workspace, ownerSessionId: "forged-header" } });
    const forgedBinding = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git commit -m forged-binding" } });
    assert.equal(forgedBinding?.block ?? false, true, "a forged owner-session binding is not worker proof");
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorStateRoot === undefined) delete process.env.PI_EXECUTION_STATE_ROOT; else process.env.PI_EXECUTION_STATE_ROOT = priorStateRoot;
    if (priorAttempt === undefined) delete process.env.PI_EXECUTION_ATTEMPT_ID; else process.env.PI_EXECUTION_ATTEMPT_ID = priorAttempt;
    if (priorRun === undefined) delete process.env.PI_SUBAGENT_RUN_ID; else process.env.PI_SUBAGENT_RUN_ID = priorRun;
    if (priorParent === undefined) delete process.env.PI_SUBAGENT_PARENT_SESSION; else process.env.PI_SUBAGENT_PARENT_SESSION = priorParent;
    if (priorAgent === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT; else process.env.PI_SUBAGENT_CHILD_AGENT = priorAgent;
    if (priorRole === undefined) delete process.env.ORCHESTRATE_ROLE; else process.env.ORCHESTRATE_ROLE = priorRole;
    if (priorBindings === undefined) delete process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV]; else process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV] = priorBindings;
  }
});

test("registered guard denies push for a writer label without execution proof and on failed lookups", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "guard-writer-reserved-home-")));
  const workspace = join(home, "reserved"); mkdirSync(workspace, { recursive: true });
  const ownerSession = join(home, "owner.jsonl");
  writeFileSync(ownerSession, JSON.stringify({ type: "session", id: "owner-header-1" }) + "\n");
  const executionRoot = join(home, "orchestrator", "plan-driven-v1", "execution");
  const stateDir = join(executionRoot, "repo"); mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "coordinator.json"), JSON.stringify({
    reservations: [{ attemptId: "attempt-1", workspacePath: workspace, workspaceId: "workspace-1" }],
    attempts: [{ id: "attempt-1", ownerSessionFile: ownerSession, workspace: { id: "workspace-1", path: workspace }, run: { runId: "run-1", ownerSessionFile: ownerSession } }],
    deliveries: [],
  }));
  const previous = {
    HOME: process.env.HOME,
    STATE: process.env.PI_EXECUTION_STATE_ROOT,
    AGENT: process.env.PI_SUBAGENT_CHILD_AGENT,
    RUN: process.env.PI_SUBAGENT_RUN_ID,
    PARENT: process.env.PI_SUBAGENT_PARENT_SESSION,
    BINDINGS: process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV],
    ROLE: process.env.ORCHESTRATE_ROLE,
  };
  process.env.HOME = home; process.env.PI_EXECUTION_STATE_ROOT = executionRoot;
  process.env.PI_SUBAGENT_CHILD_AGENT = "tdd-worker";
  delete process.env.PI_SUBAGENT_RUN_ID; delete process.env.PI_SUBAGENT_PARENT_SESSION;
  delete process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV]; delete process.env.ORCHESTRATE_ROLE;
  try {
    let handler: ((event: any) => Promise<any>) | undefined;
    guardExtension({ on(name: string, fn: any) { if (name === "tool_call") handler = fn; } } as unknown as ExtensionAPI);
    assert.ok(handler);
    // Writer label, reserved workspace, no runtime-bound execution proof: the
    // hook falls back to the reserved-parent role, and that fence must keep
    // denying publication (push) exactly as it denies commits.
    const push = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git push origin HEAD" } });
    assert.equal(push?.block ?? false, true, "an unverified writer must not publish from a reserved workspace");
    const commit = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git commit -m x" } });
    assert.equal(commit?.block ?? false, true, "commits stay fenced for an unverified reserved caller");
    const view = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git status" } });
    assert.equal(view?.block ?? false, false, "read-only commands still pass");
    // A failed identity lookup fails closed to the same publication fence.
    const unreadable = join(home, "state-root-file");
    writeFileSync(unreadable, "{}");
    process.env.PI_EXECUTION_STATE_ROOT = unreadable;
    const failedPush = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git push origin HEAD" } });
    assert.equal(failedPush?.block ?? false, true, "a failed reservation lookup must not open the publication path");
    const failedCommit = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git commit -m x" } });
    assert.equal(failedCommit?.block ?? false, true);
    const failedView = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git status" } });
    assert.equal(failedView?.block ?? false, false);
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
    if (previous.STATE === undefined) delete process.env.PI_EXECUTION_STATE_ROOT; else process.env.PI_EXECUTION_STATE_ROOT = previous.STATE;
    if (previous.AGENT === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT; else process.env.PI_SUBAGENT_CHILD_AGENT = previous.AGENT;
    if (previous.RUN === undefined) delete process.env.PI_SUBAGENT_RUN_ID; else process.env.PI_SUBAGENT_RUN_ID = previous.RUN;
    if (previous.PARENT === undefined) delete process.env.PI_SUBAGENT_PARENT_SESSION; else process.env.PI_SUBAGENT_PARENT_SESSION = previous.PARENT;
    if (previous.BINDINGS === undefined) delete process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV]; else process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV] = previous.BINDINGS;
    if (previous.ROLE === undefined) delete process.env.ORCHESTRATE_ROLE; else process.env.ORCHESTRATE_ROLE = previous.ROLE;
  }
});

test("registered guard accepts only runtime-bound attempt, run, and session-header identity", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "guard-runtime-binding-home-")));
  const workspace = join(home, "reserved"); mkdirSync(workspace, { recursive: true });
  const ownerSession = join(home, "owner.jsonl");
  writeFileSync(ownerSession, JSON.stringify({ type: "session", id: "owner-header" }) + "\n");
  const executionRoot = join(home, "orchestrator", "plan-driven-v1", "execution");
  const stateDir = join(executionRoot, "repo"); mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "coordinator.json"), JSON.stringify({
    reservations: [{ attemptId: "attempt-1", workspacePath: workspace, workspaceId: "workspace-1" }],
    attempts: [{ id: "attempt-1", ownerSessionFile: ownerSession, workspace: { id: "workspace-1", path: workspace }, run: { runId: "runtime-run-1", ownerSessionFile: ownerSession } }],
    deliveries: [],
  }));
  const previous = {
    HOME: process.env.HOME,
    PI_EXECUTION_STATE_ROOT: process.env.PI_EXECUTION_STATE_ROOT,
    PI_SUBAGENT_EXTENSION_BINDINGS: process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV],
    PI_SUBAGENT_RUN_ID: process.env.PI_SUBAGENT_RUN_ID,
    PI_SUBAGENT_PARENT_SESSION: process.env.PI_SUBAGENT_PARENT_SESSION,
    PI_SUBAGENT_CHILD_AGENT: process.env.PI_SUBAGENT_CHILD_AGENT,
    ORCHESTRATE_ROLE: process.env.ORCHESTRATE_ROLE,
  };
  process.env.HOME = home; process.env.PI_EXECUTION_STATE_ROOT = executionRoot;
  process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV] = JSON.stringify({ [EXECUTION_IDENTITY_BINDING_NAMESPACE]: { attemptId: "attempt-1", workspaceId: "workspace-1", workspacePath: workspace, ownerSessionId: "owner-header" } });
  process.env.PI_SUBAGENT_RUN_ID = "runtime-run-1"; process.env.PI_SUBAGENT_PARENT_SESSION = "owner-header";
  process.env.PI_SUBAGENT_CHILD_AGENT = "tdd-worker"; delete process.env.ORCHESTRATE_ROLE;
  try {
    let handler: ((event: any) => Promise<any>) | undefined;
    guardExtension({ on(name: string, fn: any) { if (name === "tool_call") handler = fn; } } as unknown as ExtensionAPI);
    assert.ok(handler);
    const own = await handler!({ toolName: "bash", cwd: workspace, input: { command: `git -C ${workspace} commit -m own` } });
    assert.equal(own?.block ?? false, false, "the actual runtime identity may mutate its assigned workspace");
    delete process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV];
    const missingBinding = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git commit -m missing" } });
    assert.equal(missingBinding?.block ?? false, true);
    process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV] = JSON.stringify({ [EXECUTION_IDENTITY_BINDING_NAMESPACE]: { attemptId: "attempt-1", workspaceId: "workspace-1", workspacePath: workspace, ownerSessionId: "owner-header" } });
    process.env.PI_SUBAGENT_RUN_ID = "runtime-foreign";
    const foreignRun = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git commit -m foreign" } });
    assert.equal(foreignRun?.block ?? false, true, "a spoofed runtime run id is not worker proof");
    delete process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV]; process.env.PI_SUBAGENT_RUN_ID = "runtime-run-1";
    const labelOnly = await handler!({ toolName: "bash", cwd: home, input: { command: `git -C ${join(home, "foreign")} commit -m label` } });
    assert.equal(labelOnly?.block ?? false, false, "an unreserved target is not an execution ownership claim");
    const reservedLabelOnly = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git commit -m label" } });
    assert.equal(reservedLabelOnly?.block ?? false, true, "writer labels cannot authorize a reserved target");
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
    if (previous.PI_EXECUTION_STATE_ROOT === undefined) delete process.env.PI_EXECUTION_STATE_ROOT; else process.env.PI_EXECUTION_STATE_ROOT = previous.PI_EXECUTION_STATE_ROOT;
    for (const [key, value] of [[PI_SUBAGENT_EXTENSION_BINDINGS_ENV, previous.PI_SUBAGENT_EXTENSION_BINDINGS], ["PI_SUBAGENT_RUN_ID", previous.PI_SUBAGENT_RUN_ID], ["PI_SUBAGENT_PARENT_SESSION", previous.PI_SUBAGENT_PARENT_SESSION], ["PI_SUBAGENT_CHILD_AGENT", previous.PI_SUBAGENT_CHILD_AGENT], ["ORCHESTRATE_ROLE", previous.ORCHESTRATE_ROLE]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- *
 * Round-2 P1 (grok) — the registered guard fail-opens when identity
 * or reservation lookup throws: the catch reset only writerReserved,
 * so executionRole stayed unset (or stayed "worker" from a partial
 * assignment) and classifyForRole fell back to ordinary git rules —
 * a git commit inside a reserved worker workspace was allowed
 * exactly when the fence was unverifiable. Lookup failure must fail
 * closed as a reserved parent.
 * ---------------------------------------------------------------- */

test("registered guard fails closed when identity or reservation lookup throws", async () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "guard-lookup-home-")));
	const workspace = join(home, "reserved"); mkdirSync(workspace, { recursive: true });
	const ownerSession = join(home, "owner.jsonl");
	writeFileSync(ownerSession, JSON.stringify({ type: "session", id: "owner-header-1" }) + "\n");
	const executionRoot = join(home, "orchestrator", "plan-driven-v1", "execution");
	const stateDir = join(executionRoot, "repo"); mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, "coordinator.json"), JSON.stringify({
		reservations: [{ attemptId: "attempt-1", workspacePath: workspace, workspaceId: "workspace-1" }],
		attempts: [{ id: "attempt-1", ownerSessionFile: ownerSession, workspace: { id: "workspace-1", path: workspace }, run: { runId: "run-1", ownerSessionFile: ownerSession } }],
		deliveries: [],
	}));
	// Regular files where directory creation/reads must happen: mkdirSync in
	// createReviewStore and readdirSync over PI_EXECUTION_STATE_ROOT both throw.
	const latchStateFile = join(home, "latch-state-file"); writeFileSync(latchStateFile, "not a directory\n");
	const executionStateFile = join(home, "execution-state-file"); writeFileSync(executionStateFile, "not a directory\n");
	const previous: Record<string, string | undefined> = {
		HOME: process.env.HOME,
		PI_EXECUTION_STATE_ROOT: process.env.PI_EXECUTION_STATE_ROOT,
		GHL_LATCH_STATE_DIR: process.env.GHL_LATCH_STATE_DIR,
		PI_SUBAGENT_RUN_ID: process.env.PI_SUBAGENT_RUN_ID,
		PI_SUBAGENT_PARENT_SESSION: process.env.PI_SUBAGENT_PARENT_SESSION,
		PI_SUBAGENT_CHILD_AGENT: process.env.PI_SUBAGENT_CHILD_AGENT,
		ORCHESTRATE_ROLE: process.env.ORCHESTRATE_ROLE,
		[PI_SUBAGENT_EXTENSION_BINDINGS_ENV]: process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV],
	};
	try {
		let handler: ((event: any) => Promise<any>) | undefined;
		guardExtension({ on(name: string, fn: any) { if (name === "tool_call") handler = fn; } } as unknown as ExtensionAPI);
		assert.ok(handler);
		process.env.HOME = home;
		process.env.PI_EXECUTION_STATE_ROOT = executionRoot;
		delete process.env.GHL_LATCH_STATE_DIR;
		process.env.PI_SUBAGENT_CHILD_AGENT = "tdd-worker";
		process.env.PI_SUBAGENT_RUN_ID = "run-1";
		process.env.PI_SUBAGENT_PARENT_SESSION = "owner-header-1";
		delete process.env.ORCHESTRATE_ROLE;
		process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV] = JSON.stringify({ [EXECUTION_IDENTITY_BINDING_NAMESPACE]: { attemptId: "attempt-1", workspaceId: "workspace-1", workspacePath: workspace, ownerSessionId: "owner-header-1" } });
		// Positive control: with healthy lookups a verified worker may commit in
		// its own reserved workspace, and read-only commands always stay allowed.
		const own = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git commit -m own" } });
		assert.equal(own?.block ?? false, false, "control: a verified worker may commit when lookups succeed");
		// Break createReviewStore: GHL_LATCH_STATE_DIR is a regular file, so the
		// store's mkdirSync throws after executionRole was already resolved.
		process.env.GHL_LATCH_STATE_DIR = latchStateFile;
		const storeFailure = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git commit -m store-failed" } });
		assert.equal(storeFailure?.block ?? false, true, "a review-store failure must fail closed instead of allowing the commit");
		const storeRead = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git status" } });
		assert.equal(storeRead?.block ?? false, false, "read-only commands stay allowed when the store lookup fails closed");
		// Break the durable-state scan itself: a non-directory
		// PI_EXECUTION_STATE_ROOT makes readdirSync throw before any role resolves.
		delete process.env.GHL_LATCH_STATE_DIR;
		process.env.PI_EXECUTION_STATE_ROOT = executionStateFile;
		const scanFailure = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git commit -m scan-failed" } });
		assert.equal(scanFailure?.block ?? false, true, "a durable-state scan failure must fail closed instead of allowing the commit");
		const scanRead = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git log -1" } });
		assert.equal(scanRead?.block ?? false, false, "read-only commands stay allowed when the scan fails closed");
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
	}
});

/* ---------------------------------------------------------------- *
 * Round-2 P1 (grok) — inside double quotes a backtick was appended to
 * the current token instead of lexed, but bash still executes it as
 * command substitution: echo "`git worktree add …`" ran a raw worktree
 * add (and the `gh pr merge` / ghl-pr-land spellings ran lifecycle
 * mutations) while gitInvocations/hasGhSequence never saw a git/gh
 * token, so classifyGitWorkflowCommand fell through to allow. Backticks
 * inside double quotes must be lexed recursively exactly like $(...),
 * and an unterminated backtick must fail closed. Classify-only; these
 * commands are never executed.
 * ---------------------------------------------------------------- */

test("blocks backtick substitutions hidden inside double quotes", () => {
	assert.match(blocked('echo "`git worktree add ../ice-wt/sub -b sub`"'), /git wt/);
	assert.match(blocked('echo "`gh pr merge 13 --admin`"'), /git pr-await 13/);
	assert.match(blocked('echo "`git status'), /Unsupported shell syntax/);
	// the writer guard sees the nested push behind the quotes
	const writer = classifyForRole('git commit -m "`git push --force origin main`"', { writer: true });
	assert.equal(writer.block, true, "a writer child must not run a double-quoted backtick push");
	assert.match(String((writer as { reason?: string }).reason ?? ""), /writer child/);
	// the reserved-parent fence sees a lifecycle binary behind the quotes
	const reserved = classifyForRole('echo "`/opt/ghl/bin/ghl-pr-land 13`"', { writer: false, writerReserved: true });
	assert.equal(reserved.block, true, "a reserved parent must not land through double-quoted backticks");
	assert.match(String((reserved as { reason?: string }).reason ?? ""), /must not mutate/);
	// benign double-quoted substitutions stay allowed
	allowed('echo "`date`"');
	allowed('git commit -m "rev `git rev-parse --short HEAD`"');
});

/* ---------------------------------------------------------------- *
 * Round-2 P1 (codex) — isWorktreeMutation/isLifecycleMutation return
 * false when the lexer cannot parse the command, so the reserved-parent
 * fence was skipped and an unparseable mutation (valid shell syntax
 * this lexer does not model — here a heredoc whose body opens a quote,
 * hiding the git token behind an unanchored quote character) fell
 * through to classifyGitWorkflowCommand, which only fails closed on
 * text it recognises as a workflow executable. An unparseable command
 * must be rejected whenever a reserved workspace is involved;
 * parseable read-only commands stay allowed. Classify-only; never run.
 * ---------------------------------------------------------------- */

test("unparseable commands are rejected for a reserved parent (classifyForRole)", () => {
	const unparseable = "cd /reserved && 'git' commit -m ok <<EOF\n\"unterminated\nEOF";
	assert.equal(
		classifyGitWorkflowCommand(unparseable).block,
		false,
		"precondition: the general classifier alone lets this unparseable mutation through",
	);
	for (const opts of [{ writer: false, writerReserved: true }, { writer: false, executionRole: "parent" as const }]) {
		const verdict = classifyForRole(unparseable, opts);
		assert.equal(verdict.block, true, "an unparseable command must fail closed against a reserved workspace");
		assert.match(String((verdict as { reason?: string }).reason ?? ""), /Unsupported shell syntax/);
	}
	// parseable read-only commands stay allowed for a reserved parent
	assert.equal(classifyForRole("git status", { writer: false, writerReserved: true }).block, false);
	assert.equal(classifyForRole("git log -1", { writer: false, executionRole: "parent" }).block, false);
});

test("registered guard rejects an unparseable command in a reserved workspace", async () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "guard-unparseable-home-")));
	const workspace = join(home, "reserved"); mkdirSync(workspace, { recursive: true });
	const ownerSession = join(home, "owner.jsonl");
	writeFileSync(ownerSession, JSON.stringify({ type: "session", id: "owner-header-1" }) + "\n");
	const executionRoot = join(home, "orchestrator", "plan-driven-v1", "execution");
	const registeredStateDir = join(executionRoot, "repo"); mkdirSync(registeredStateDir, { recursive: true });
	writeFileSync(join(registeredStateDir, "coordinator.json"), JSON.stringify({
		reservations: [{ attemptId: "attempt-1", workspacePath: workspace, workspaceId: "workspace-1" }],
		attempts: [{ id: "attempt-1", ownerSessionFile: ownerSession, workspace: { id: "workspace-1", path: workspace }, run: { runId: "run-1", ownerSessionFile: ownerSession } }],
		deliveries: [],
	}));
	const previous: Record<string, string | undefined> = {
		HOME: process.env.HOME,
		PI_EXECUTION_STATE_ROOT: process.env.PI_EXECUTION_STATE_ROOT,
		PI_SUBAGENT_RUN_ID: process.env.PI_SUBAGENT_RUN_ID,
		PI_SUBAGENT_PARENT_SESSION: process.env.PI_SUBAGENT_PARENT_SESSION,
		PI_SUBAGENT_CHILD_AGENT: process.env.PI_SUBAGENT_CHILD_AGENT,
		ORCHESTRATE_ROLE: process.env.ORCHESTRATE_ROLE,
		[PI_SUBAGENT_EXTENSION_BINDINGS_ENV]: process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV],
	};
	try {
		let handler: ((event: any) => Promise<any>) | undefined;
		guardExtension({ on(name: string, fn: any) { if (name === "tool_call") handler = fn; } } as unknown as ExtensionAPI);
		assert.ok(handler);
		process.env.HOME = home;
		process.env.PI_EXECUTION_STATE_ROOT = executionRoot;
		delete process.env.PI_SUBAGENT_RUN_ID; delete process.env.PI_SUBAGENT_PARENT_SESSION;
		delete process.env.PI_SUBAGENT_CHILD_AGENT;
		delete process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV]; delete process.env.ORCHESTRATE_ROLE;
		// controls: the plain mutation is fenced by role, read-only stays allowed
		const plain = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git commit -m ok" } });
		assert.equal(plain?.block ?? false, true, "control: a reserved parent may not commit in the workspace");
		const read = await handler!({ toolName: "bash", cwd: workspace, input: { command: "git status" } });
		assert.equal(read?.block ?? false, false, "control: parseable read-only commands stay allowed");
		// the unparseable spelling (lexer fails on the heredoc body quote; the
		// workflow-executable regex misses the quoted 'git') must fail closed.
		const unparseable = "'git' commit -m ok <<EOF\n\"unterminated\nEOF";
		const fenced = await handler!({ toolName: "bash", cwd: workspace, input: { command: unparseable } });
		assert.equal(fenced?.block ?? false, true, "an unparseable command in a reserved workspace fails closed");
		assert.match(String((fenced as { reason?: string }).reason ?? ""), /Unsupported shell syntax/);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
	}
});

test("mutationTargetDirs includes --work-tree and --git-dir", () => {
  assert.ok(
    mutationTargetDirs(
      "git --work-tree=/wt/feat commit -m x",
      "/elsewhere",
    ).includes("/wt/feat"),
  );
  assert.ok(
    mutationTargetDirs(
      "git --git-dir=/wt/feat/.git add .",
      "/elsewhere",
    ).some((d) => d === "/wt/feat" || d.startsWith("/wt/feat/")),
  );
});
