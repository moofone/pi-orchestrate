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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
	isAcceptedFeaturePrAction,
	isDriverRunning,
	readPid,
	waiterFilesOwnedBy,
	waiterLogSaysTerminal,
	waiterManualFiles,
	waiterManualFilesOwnedBy,
	waiterPidFilesOwnedBy,
	waiterPaths,
	waiterPidFiles,
	waiterStatePath,
	spendWaiterVerdict,
	undeliveredWaiterVerdicts,
	repoKey,
	seedWaiterState,
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

test("waiterFilesOwnedBy does not claim another repo's same-number files", () => {
	const dir = tmpStateDir();
	const ice = join(homedir(), "Dev", "git", "ice-wt", "feat-a");
	const devops = join(homedir(), "Dev", "git", "devops-wt", "feat-b");
	try {
		writeFileSync(join(dir, "manual-9963.json"), JSON.stringify({ pr: "9963", cwd: ice }));
		writeFileSync(
			join(dir, "manual-icemining-devops-9963.json"),
			JSON.stringify({ pr: "9963", cwd: devops }),
		);
		writeFileSync(join(dir, "drive-icemining-devops-9963.pid"), "1");
		writeFileSync(join(dir, "drive-icemining-9963.pid"), "2");
		const owner = { cwd: ice };
		assert.deepEqual(
			waiterManualFilesOwnedBy("9963", dir, owner).map((p) => basename(p)).sort(),
			["manual-9963.json"],
		);
		assert.deepEqual(
			waiterPidFilesOwnedBy("9963", dir, owner).map((p) => basename(p)),
			["drive-icemining-9963.pid"],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("waiterFilesOwnedBy does not claim an ambiguous legacy drive file", () => {
	const dir = tmpStateDir();
	const ice = join(homedir(), "Dev", "git", "ice-wt", "feat-legacy-unowned");
	try {
		writeFileSync(join(dir, "drive-9964.log"), "next=stop\n");
		writeFileSync(join(dir, "drive-9964.pid"), "4242");
		const owner = { cwd: ice };
		assert.deepEqual(
			waiterPidFilesOwnedBy("9964", dir, owner).map((p) => basename(p)),
			[],
			"legacy drive-9964.pid has no repo identity",
		);
		assert.deepEqual(
			waiterFilesOwnedBy("9964", "drive", "log", dir, owner).map((p) => basename(p)),
			[],
			"legacy drive-9964.log has no repo identity",
		);
		assert.equal(
			waiterLogSaysTerminal("9964", dir, owner),
			false,
			"a leftover drive-9964.log must not close this latch",
		);
		assert.equal(
			waiterLogSaysTerminal("9964", dir),
			true,
			"unscoped callers still scan every spelling",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("repoKey distinguishes repositories in the current worktree layout", () => {
	const root = join(homedir(), "Dev/git");
	assert.equal(repoKey(join(root, "wt/pi-appserver/integrate")), "pi-appserver");
	assert.equal(repoKey(join(root, "wt/pi-gpt-pro/fix")), "pi-gpt-pro");
	assert.equal(repoKey(join(root, "wt/pi-appserver/nested/branch")), "pi-appserver");
	assert.equal(repoKey(join(root, "wt")), undefined, "shared worktree root has no repo identity");
	assert.equal(repoKey(join(root, "pi-appserver-wt/integrate")), "pi-appserver");
	assert.equal(repoKey(join(root, "ice-wt/feature")), "icemining");
});

test("waiterStatePath never borrows another repository's same-number state", () => {
	const dir = tmpStateDir();
	try {
		const foreign = join(dir, "manual-pi-gpt-pro-11.json");
		writeFileSync(foreign, JSON.stringify({ pr: "11", cwd: join(homedir(), "Dev/git/wt/pi-gpt-pro/fix") }));
		assert.equal(waiterStatePath("pi-appserver", "11", dir), join(dir, "manual-pi-appserver-11.json"));
		assert.equal(waiterStatePath(undefined, "11", dir), join(dir, "manual-11.json"), "unknown repo cannot claim a qualified file");
		const legacy = join(dir, "manual-11.json");
		writeFileSync(legacy, JSON.stringify({ pr: "11", cwd: join(homedir(), "Dev/git/wt/pi-appserver/integrate") }));
		assert.equal(waiterStatePath("pi-appserver", "11", dir), legacy, "identity-proven legacy state is reusable");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("old wt-qualified state remains readable only with positive repository evidence", () => {
	const dir = tmpStateDir();
	try {
		const cwd = join(homedir(), "Dev/git/wt/pi-appserver/integrate");
		const owner = { cwd, slug: "moofone/pi-appserver" };
		const path = join(dir, "manual-wt-11.json");
		writeFileSync(path, JSON.stringify({ pr: "11", cwd, lastNext: "fix_command_or_environment", verdict: "owned", verdictDelivered: false }));
		assert.deepEqual(waiterManualFilesOwnedBy("11", dir, owner), [path]);
		assert.equal(waiterStatePath("pi-appserver", "11", dir), path, "keep an existing waiter's real state path without migration");
		assert.equal(undeliveredWaiterVerdicts("11", dir, owner)[0]?.verdict, "owned");
		assert.equal(seedWaiterState(path, { pr: "11", cwd }), true);
		spendWaiterVerdict("moofone/pi-appserver", "11", dir);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).verdictDelivered, true);
		writeFileSync(path, JSON.stringify({ pr: "11", cwd: join(homedir(), "Dev/git/wt/pi-gpt-pro/fix"), verdict: "foreign" }));
		assert.deepEqual(waiterManualFilesOwnedBy("11", dir, owner), []);
		writeFileSync(path, JSON.stringify({ pr: "11", verdict: "ambiguous" }));
		assert.deepEqual(waiterManualFilesOwnedBy("11", dir, owner), []);
		writeFileSync(join(dir, "drive-wt-11.pid"), String(process.pid));
		assert.equal(isDriverRunning("11", dir, () => true, owner), false, "a shared-root PID never proves repository identity");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("unknown-layout bootstrap refuses foreign legacy state instead of spawning into it", () => {
	const dir = tmpStateDir();
	try {
		const path = join(dir, "manual-11.json");
		const raw = JSON.stringify({ pr: "11", cwd: join(homedir(), "Dev/git/wt/pi-gpt-pro/fix"), verdict: "foreign finding" });
		writeFileSync(path, raw);
		assert.equal(seedWaiterState(path, { pr: "11", cwd: "/tmp/unknown-checkout" }), false);
		assert.equal(readFileSync(path, "utf8"), raw);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("accepting one repository's verdict leaves another repository's verdict unspent", () => {
	const dir = tmpStateDir();
	try {
		const ours = join(dir, "manual-pi-appserver-11.json");
		const foreign = join(dir, "manual-pi-gpt-pro-11.json");
		const raw = JSON.stringify({ pr: "11", lastNext: "read_comments_and_fix", verdictDelivered: false });
		writeFileSync(ours, raw);
		writeFileSync(foreign, raw);
		spendWaiterVerdict("pi-appserver", "11", dir);
		assert.equal(readFileSync(foreign, "utf8"), raw, "foreign verdict must survive byte-for-byte");
		assert.equal(JSON.parse(readFileSync(ours, "utf8")).verdictDelivered, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Feature verdict recovery is repository-scoped including legacy session files", () => {
	const dir = tmpStateDir();
	const cwd = join(homedir(), "Dev/git/wt/pi-appserver/integrate");
	try {
		const raw = { pr: "11", lastNext: "read_comments_and_fix", verdict: "head=abcdef1", verdictDelivered: false };
		writeFileSync(join(dir, "manual-pi-appserver-11.json"), JSON.stringify(raw));
		writeFileSync(join(dir, "manual-pi-gpt-pro-11.json"), JSON.stringify(raw));
		writeFileSync(join(dir, "pi-foreign.json"), JSON.stringify({ ...raw, cwd: join(homedir(), "Dev/git/wt/pi-gpt-pro/fix") }));
		writeFileSync(join(dir, "pi-owned.json"), JSON.stringify({ ...raw, cwd }));
		writeFileSync(join(dir, "pi-unknown.json"), JSON.stringify(raw));
		assert.deepEqual(undeliveredWaiterVerdicts("11", dir, { cwd }).map((v) => basename(v.path)).sort(),
			["manual-pi-appserver-11.json", "pi-owned.json"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("waiter health cannot be satisfied by another repository's same-number PID", () => {
	const dir = tmpStateDir();
	try {
		writeFileSync(join(dir, "drive-pi-gpt-pro-11.pid"), "4242");
		const owner = { slug: "moofone/pi-appserver" };
		assert.equal(isDriverRunning("11", dir, () => true, owner), false);
		writeFileSync(join(dir, "drive-pi-appserver-11.pid"), "4243");
		assert.equal(isDriverRunning("11", dir, (pid) => pid === 4243, owner), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ownership rejects unproven legacy state and a qualified file with foreign contents", () => {
	const dir = tmpStateDir();
	try {
		writeFileSync(join(dir, "manual-11.json"), JSON.stringify({ pr: "11" }));
		writeFileSync(join(dir, "manual-pi-appserver-11.json"), JSON.stringify({ pr: "11", cwd: join(homedir(), "Dev/git/wt/pi-gpt-pro/fix") }));
		assert.deepEqual(waiterManualFilesOwnedBy("11", dir, { slug: "moofone/pi-appserver" }), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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
