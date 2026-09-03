/**
 * The naming contract between this extension and the `ghl-pr-await` binary.
 *
 * The waiter built 2026-09-01 writes `manual-<repo>-<pr>.json` and
 * `drive-<repo>-<pr>.pid`; every release before it wrote `manual-<pr>.json` and
 * `drive-<pr>.pid`. The TypeScript knew only the old spelling, so verdicts from
 * the handshake-spawned waiter were invisible and "is a waiter running?" was
 * always false — which is how one PR ended up with 25 duplicate daemons and 8
 * GitHub rate-limit errors (qa/fable_01.md F2, F3).
 *
 * These tests pin both spellings and the rule that TypeScript only ever *reads*
 * them. Run: node --experimental-strip-types --test test/waiter-contract.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
	isAcceptedFeaturePrAction,
	isDriverRunning,
	readPid,
	waiterLogSaysTerminal,
	waiterManualFiles,
	waiterPaths,
	waiterPidFiles,
} from "../src/lib/pr-await-core.ts";

function tmpStateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "waiter-contract-"));
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("waiterPaths returns the repo-qualified name first, then the legacy one", () => {
	const dir = tmpStateDir();
	try {
		const paths = waiterPaths("icemining", "2232", dir);
		assert.deepEqual(paths.manual.map((p) => basename(p)), [
			"manual-icemining-2232.json",
			"manual-2232.json",
		]);
		assert.deepEqual(paths.pid.map((p) => basename(p)), [
			"drive-icemining-2232.pid",
			"drive-2232.pid",
		]);
		assert.deepEqual(paths.log.map((p) => basename(p)), [
			"drive-icemining-2232.log",
			"drive-2232.log",
		]);
		// No third scheme is invented.
		assert.equal(paths.manual.length, 2);
		assert.equal(paths.pid.length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("waiterPaths without a repo yields the legacy spelling only", () => {
	const dir = tmpStateDir();
	try {
		const paths = waiterPaths(undefined, "2232", dir);
		assert.deepEqual(paths.manual.map((p) => basename(p)), ["manual-2232.json"]);
		assert.deepEqual(paths.pid.map((p) => basename(p)), ["drive-2232.pid"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("isDriverRunning sees a live pid written under the repo-qualified name", () => {
	const dir = tmpStateDir();
	try {
		// Only the new spelling exists — exactly the live shape that made the old
		// code spawn a second daemon on every settle.
		writeFileSync(join(dir, "drive-icemining-2232.pid"), "4242");
		assert.equal(readPid("2232", dir), 4242);
		assert.equal(
			isDriverRunning("2232", dir, (pid) => pid === 4242),
			true,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("isDriverRunning is false when the repo-qualified pid is dead", () => {
	const dir = tmpStateDir();
	try {
		writeFileSync(join(dir, "drive-icemining-2232.pid"), "4242");
		assert.equal(
			isDriverRunning("2232", dir, () => false),
			false,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a live waiter under either spelling counts as running", () => {
	const dir = tmpStateDir();
	try {
		writeFileSync(join(dir, "drive-icemining-2232.pid"), "10");
		writeFileSync(join(dir, "drive-2232.pid"), "11");
		// Legacy dead, repo-qualified alive: still running, so no second spawn.
		assert.equal(
			isDriverRunning("2232", dir, (pid) => pid === 10),
			true,
		);
		// Repo-qualified dead, legacy alive: also running.
		assert.equal(
			isDriverRunning("2232", dir, (pid) => pid === 11),
			true,
		);
		assert.equal(
			isDriverRunning("2232", dir, () => false),
			false,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a shorter PR number does not match a longer repo-qualified file", () => {
	const dir = tmpStateDir();
	try {
		// `drive-icemining-2232.pid` must not answer for PR 232: #232 and #2232
		// are different pull requests, and a false "already running" would leave
		// #232 with no waiter at all.
		writeFileSync(join(dir, "drive-icemining-2232.pid"), "10");
		assert.equal(
			isDriverRunning("232", dir, () => true),
			false,
		);
		assert.deepEqual(waiterPidFiles("232", dir), []);
		assert.deepEqual(waiterPidFiles("2232", dir).map((p) => basename(p)), [
			"drive-icemining-2232.pid",
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("waiterLogSaysTerminal reads drive-*.log because lastNext is not on the JSON", () => {
	const dir = tmpStateDir();
	try {
		// The waiter's JSON carries no verdict yet, so the drive log is the only
		// place a terminal state can show up (the #2242 shape).
		writeFileSync(join(dir, "manual-icemining-2142.json"), JSON.stringify({ pr: "2142" }));

		writeFileSync(join(dir, "drive-icemining-2142.log"), "");
		assert.equal(waiterLogSaysTerminal("2142", dir), false, "an empty log is not terminal");

		writeFileSync(
			join(dir, "drive-icemining-2142.log"),
			"status=reviewer_active\nnext=poll_again\n",
		);
		assert.equal(waiterLogSaysTerminal("2142", dir), false, "a still-waiting log is not terminal");

		const terminalLines = [
			"status=landed\n",
			"next=done\n",
			"next=stop\n",
			"pr_state=MERGED\n",
			"pr_state=CLOSED\n",
		];
		for (const line of terminalLines) {
			writeFileSync(join(dir, "drive-icemining-2142.log"), line);
			assert.equal(waiterLogSaysTerminal("2142", dir), true, `${JSON.stringify(line)} must be terminal`);
		}

		// Full lines only: a longer key or token is not the verdict.
		writeFileSync(join(dir, "drive-icemining-2142.log"), "prev_status=landed\nnext=donework\n");
		assert.equal(waiterLogSaysTerminal("2142", dir), false, "a partial line is not the verdict");

		// The legacy spelling older binaries wrote is read too.
		const legacy = tmpStateDir();
		try {
			writeFileSync(join(legacy, "drive-2142.log"), "next=stop\n");
			assert.equal(waiterLogSaysTerminal("2142", legacy), true, "legacy drive-2142.log is read");
		} finally {
			rmSync(legacy, { recursive: true, force: true });
		}

		// Another PR's landing says nothing about this one.
		assert.equal(waiterLogSaysTerminal("2232", dir), false, "#2142's log must not answer for #2232");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("discovery finds every spelling on disk without being told the repo", () => {
	const dir = tmpStateDir();
	try {
		writeFileSync(join(dir, "manual-icemining-2232.json"), "{}");
		writeFileSync(join(dir, "manual-2232.json"), "{}");
		writeFileSync(join(dir, "manual-icemining-devops-472.json"), "{}");
		const found = waiterManualFiles("2232", dir).map((p) => basename(p)).sort();
		assert.deepEqual(found, ["manual-2232.json", "manual-icemining-2232.json"]);
		// A repo name containing a hyphen still resolves.
		assert.deepEqual(waiterManualFiles("472", dir).map((p) => basename(p)), [
			"manual-icemining-devops-472.json",
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a latch sidecar is never mistaken for a waiter verdict file", () => {
	const dir = tmpStateDir();
	try {
		// `pi-<id>.latch.json` is the extension's private copy. ghl-monitor
		// respawning drivers from it is F3; it must never be read as waiter state.
		writeFileSync(join(dir, "pi-abc.latch.json"), "{}");
		writeFileSync(join(dir, "manual-2232.json"), "{}");
		const found = waiterManualFiles("2232", dir).map((p) => basename(p));
		assert.deepEqual(found, ["manual-2232.json"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reading waiter state creates nothing on disk", () => {
	const dir = tmpStateDir();
	try {
		const before = readdirSync(dir);
		waiterPaths("icemining", "2232", dir);
		waiterPidFiles("2232", dir);
		waiterManualFiles("2232", dir);
		readPid("2232", dir);
		isDriverRunning("2232", dir, () => false);
		assert.deepEqual(readdirSync(dir), before);
		assert.deepEqual(before, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a missing state directory answers 'no waiter' instead of throwing", () => {
	const dir = join(tmpdir(), `waiter-contract-absent-${process.pid}`);
	rmSync(dir, { recursive: true, force: true });
	assert.deepEqual(waiterPidFiles("2232", dir), []);
	assert.deepEqual(waiterManualFiles("2232", dir), []);
	assert.equal(readPid("2232", dir), undefined);
	assert.equal(
		isDriverRunning("2232", dir, () => true),
		false,
	);
});

test("P2 F6: a disagreement consumes the verdict — the loop must not restart it every 60s", () => {
	assert.equal(isAcceptedFeaturePrAction("disagree"), true);
	for (const refused of ["refuse", "notify", "confirm", "idle"]) {
		assert.equal(
			isAcceptedFeaturePrAction(refused),
			false,
			`${refused} did nothing with the verdict; it stays on disk for retry`,
		);
	}
});
