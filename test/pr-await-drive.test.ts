/**
 * Latch helpers. The waiter is ghl-pr-await, not this module.
 *
 * Run: npm test  (or: node --experimental-strip-types --test test/pr-await-drive.test.ts)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";


import {
	ensureDriver,
	isReferenceCheckout,
	parseField,
	printedLandCommand,
	referenceCheckoutFor,
	resolveQueryCwd,
} from "../src/lib/pr-await-core.ts";
import { awaitBin } from "../src/lib/pr-await-drive.ts";

const REF = join(homedir(), "Dev", "git", "icemining");
const GONE = join(homedir(), "Dev", "git", "ice-wt", "does-not-exist-wt-dir");

test("ensureDriver is idempotent while already running", () => {
	const spawns: string[][] = [];
	const first = ensureDriver({
		pr: "1",
		stateFile: "/tmp/x.json",
		spawn: (argv) => {
			spawns.push(argv);
			return { pid: 9 };
		},
		running: false,
	});
	const second = ensureDriver({
		pr: "1",
		stateFile: "/tmp/x.json",
		spawn: (argv) => {
			spawns.push(argv);
			return { pid: 10 };
		},
		running: true,
	});
	assert.equal(first.action, "spawned");
	assert.equal(second.action, "already");
	assert.equal(spawns.length, 1);
	assert.ok(spawns[0].includes("--daemon"));
	assert.ok(spawns[0].includes("--state"));
});

test("parseField still rejects longer keys", () => {
	assert.equal(parseField("subnext=wrong\nnext=right", "next"), "right");
});

test("printedLandCommand reads resume= ghl-pr-land", () => {
	assert.deepEqual(printedLandCommand("resume=ghl-pr-land --continue 9"), [
		"pr-land",
		"--continue",
		"9",
	]);
});

test("icemining itself is a reference checkout; ice-wt is not", () => {
	assert.equal(isReferenceCheckout(REF), true);
	assert.equal(isReferenceCheckout(join(homedir(), "Dev", "git", "ice-wt", "feat")), false);
});

test("referenceCheckoutFor maps ice-wt / devops-wt / <name>-wt onto the reference checkout", () => {
	assert.equal(referenceCheckoutFor(join(homedir(), "Dev", "git", "ice-wt", "feat-foo")), REF);
	assert.equal(
		referenceCheckoutFor(join(homedir(), "Dev", "git", "devops-wt", "feat-bar")),
		join(homedir(), "Dev", "git", "icemining-devops"),
	);
	assert.equal(
		referenceCheckoutFor(join(homedir(), "Dev", "git", "deribit_bot_v2-wt", "feat-baz")),
		join(homedir(), "Dev", "git", "deribit_bot_v2"),
	);
	assert.equal(referenceCheckoutFor(REF), REF);
	assert.equal(referenceCheckoutFor("/tmp/not-a-repo"), undefined);
});

test("resolveQueryCwd falls back when the worktree is gone", () => {
	assert.equal(existsSync(GONE), false);
	assert.equal(resolveQueryCwd(GONE), REF);
	assert.equal(resolveQueryCwd(REF), REF);
});

test("drive trampoline targets ghl-pr-await, not a node waiter", () => {
	const bin = awaitBin();
	assert.match(bin, /ghl-pr-await$/);
});
