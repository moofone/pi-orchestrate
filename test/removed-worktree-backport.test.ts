import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { referenceCheckoutFor, resolveQueryCwd, spawnCwdFor } from "../src/lib/pr-await-core.ts";

test("current worktree layout resolves removed, nested and container paths without crossing repos", () => {
	const root = mkdtempSync(join(tmpdir(), "latch-layout-"));
	const ref = join(root, "project");
	mkdirSync(join(ref, ".git"), { recursive: true });
	try {
		for (const suffix of ["", "gone", "feature/nested/gone"]) {
			const cwd = join(root, "wt", "project", suffix);
			assert.equal(referenceCheckoutFor(cwd), ref, cwd);
			assert.equal(resolveQueryCwd(cwd), ref, cwd);
			assert.equal(spawnCwdFor({ pr: "552", cwd }), ref, cwd);
		}
		assert.equal(referenceCheckoutFor(join(root, "wt", "different", "gone")), undefined);
		assert.equal(referenceCheckoutFor(join(root, "wt")), undefined);
		assert.equal(referenceCheckoutFor(join(root, "unrelated", "project", "gone")), undefined);
		const live = join(root, "wt", "project", "live");
		mkdirSync(live, { recursive: true });
		writeFileSync(join(live, ".git"), "gitdir: fixture");
		assert.equal(referenceCheckoutFor(live), live, "live worktrees retain precedence");
		assert.equal(spawnCwdFor({ pr: "552", cwd: join(root, "wt", "project", "gone"), slug: "wrong/repo" }), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
