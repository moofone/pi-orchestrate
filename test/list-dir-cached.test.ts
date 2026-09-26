import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listDirCached } from "../src/lib/pr-await-core.ts";

test("listDirCached sees adds, removes and renames immediately", () => {
	const dir = mkdtempSync(join(tmpdir(), "list-dir-cached-"));
	try {
		assert.deepEqual(listDirCached(dir), []);
		for (let i = 0; i < 50; i++) {
			writeFileSync(join(dir, `f${i}`), "x");
			assert.ok(listDirCached(dir).includes(`f${i}`), `add f${i}`);
		}
		renameSync(join(dir, "f0"), join(dir, "g0"));
		const names = listDirCached(dir);
		assert.ok(names.includes("g0") && !names.includes("f0"));
		rmSync(join(dir, "g0"));
		assert.ok(!listDirCached(dir).includes("g0"));
		// Callers may mutate the result without poisoning the cache.
		listDirCached(dir).length = 0;
		assert.equal(listDirCached(dir).length, 49);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("listDirCached throws for a missing dir like readdirSync", () => {
	assert.throws(() => listDirCached(join(tmpdir(), "definitely-missing-list-dir-cached")));
});
