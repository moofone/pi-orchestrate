/**
 * Run: npm test  (or: node --experimental-strip-types --test test/worktree-helper.test.ts)
 *
 * Round-2 P1: the e2e harness and crash owner invoked a hardcoded
 * machine-local ghl-wt path, making the U8 overlap/composition/crash
 * coverage workstation-only. Provisioning must resolve the configured
 * git wt helper (explicit env override, then PATH) and fail with an
 * actionable error when it is missing — never skip silently and never
 * fall back to raw git worktree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKTREE_HELPER_ENV, resolveWorktreeHelper } from "./fixtures/execution/e2e/worktree-helper.ts";

function fakeHelper(dir: string): string {
	const path = join(dir, "ghl-wt");
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, 0o755);
	return path;
}

test("resolves the helper pinned by PI_GIT_WORKFLOW_WT_BIN", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "wt-helper-")));
	try {
		const helper = fakeHelper(root);
		assert.equal(resolveWorktreeHelper({ env: { [WORKTREE_HELPER_ENV]: helper }, path: "" }), helper);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolves an executable ghl-wt from PATH without a configured override", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "wt-helper-path-")));
	try {
		const helper = fakeHelper(root);
		assert.equal(resolveWorktreeHelper({ env: {}, path: root }), helper);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a non-executable PATH entry is skipped, not selected", () => {
	const dead = realpathSync(mkdtempSync(join(tmpdir(), "wt-helper-dead-")));
	const live = realpathSync(mkdtempSync(join(tmpdir(), "wt-helper-live-")));
	try {
		const unusable = join(dead, "ghl-wt");
		writeFileSync(unusable, "#!/bin/sh\nexit 0\n");
		chmodSync(unusable, 0o644);
		const helper = fakeHelper(live);
		assert.equal(resolveWorktreeHelper({ env: {}, path: `${dead}:${live}` }), helper);
	} finally {
		rmSync(dead, { recursive: true, force: true });
		rmSync(live, { recursive: true, force: true });
	}
});

test("a missing helper is an actionable failure, not a silent skip or raw-git fallback", () => {
	assert.throws(
		() => resolveWorktreeHelper({ env: {}, path: "" }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /ghl-wt/);
			assert.match(error.message, new RegExp(WORKTREE_HELPER_ENV));
			assert.match(error.message, /Raw git worktree is not a permitted fallback/);
			return true;
		},
	);
});

test("a configured-but-missing helper names the bad setting", () => {
	assert.throws(
		() => resolveWorktreeHelper({ env: { [WORKTREE_HELPER_ENV]: "/nonexistent/wt-helper" }, path: "/bin" }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /PI_GIT_WORKFLOW_WT_BIN=\/nonexistent\/wt-helper is missing or not executable/);
			return true;
		},
	);
});
