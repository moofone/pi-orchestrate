/**
 * Run: npm test  (or: node --experimental-strip-types --test test/git-workflow-guard.test.ts)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	classifyForRole,
	classifyGitWorkflowCommand,
	classifyViewRepeat,
	extractPrNumber,
	isWriterRole,
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
