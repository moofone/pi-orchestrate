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

test("blocks a prohibited worktree operation after a read-only worktree segment", () => {
	const command = "git worktree list && git worktree add ../ice-wt/later -b later";
	assert.match(blocked(command), /git wt/);
	assert.equal(classifyForRole(command, { writer: false }).block, true);
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
