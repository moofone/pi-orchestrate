/**
 * Run: npm test  (or: node --experimental-strip-types --test test/git-workflow-guard.test.ts)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	classifyGitWorkflowCommand,
	classifyViewRepeat,
	extractPrNumber,
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
