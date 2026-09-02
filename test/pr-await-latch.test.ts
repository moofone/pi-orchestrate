/**
 * Stop-hook latch — sensor only during wait. Never in-process wait.
 * A live parent is woken once on merge/close, or on an undelivered
 * ACTIONABLE waiter verdict, so deferred work continues. Reload of a
 * terminal latch is notify-only; an undelivered ACTIONABLE still wakes.
 *
 * Run: npm test  (or: node --experimental-strip-types --test test/pr-await-latch.test.ts)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Set the driver probe before importing pr-await-latch: DRIVE_BIN is captured at
// module evaluation, and a regression must never launch the real waiter.
const DRIVER_PROBE_DIR = mkdtempSync(join(tmpdir(), "ghl-spawn-driver-test-"));
const DRIVER_MARKER = join(DRIVER_PROBE_DIR, "spawned");
const DRIVER_STUB = join(DRIVER_PROBE_DIR, "ghl-await-drive");
writeFileSync(
	DRIVER_STUB,
	`#!/bin/sh
printf '%s\\n' "$PWD" > "$GHL_TEST_SPAWN_MARKER"
`,
);
chmodSync(DRIVER_STUB, 0o755);
process.env.GHL_TEST_SPAWN_MARKER = DRIVER_MARKER;
process.env.GHL_AWAIT_DRIVE_BIN = DRIVER_STUB;
process.env.GHL_PR_AWAIT_BIN = DRIVER_STUB;

const REAL_OUTPUT = [
	"status=reviewer_active",
	"next=poll_again",
	"pr=2142",
	"head=47e2b0ad8afaaf5e3a0a29c689fe2b26e0b36016",
	"cursor=v1:2142:47e2b0ad8afaaf5e3a0a29c689fe2b26e0b36016",
	"",
].join("\n");

const REPO = join(homedir(), "Dev", "git", "icemining");
// Isolate from the real latch dir. Adoption scans this directory, and the live
// ~/.local/state/ghl-await holds real orphaned latches that would be adopted.
// One directory PER HARNESS: a settled handoff can still persist after a test
// has cleaned up, and a leaked latch is exactly what the next test's adoption
// path would find. Shared state made unrelated tests fail each other.
process.env.GHL_LATCH_STATE_DIR ??= mkdtempSync(join(tmpdir(), "ghl-await-test-"));
// Feature-ownership lookup defaults to ~/orchestrator, where real Features claim
// real PR numbers — #2142 among them. Redirect it before any harness exists, or
// a live Feature decides whether these tests see a wake.
process.env.GHL_ORCH_ROOT = mkdtempSync(join(tmpdir(), "ghl-orch-test-"));

const {
	default: latch,
	ACTIONABLE,
	defaultSpawnDriver,
	parseAwaitCall,
	parseField,
	trailingCd,
} = await import("../src/pr-await-latch.ts");
const {
	actionableFingerprint,
	armObservedLatch,
	formatWaitElapsed,
	formatWaitLine,
	originSlug,
	osc8Link,
	prLinkLabel,
	prUrl,
	isExtensionOwnedStateFile,
	readLiveRound,
	repoKey,
	seedWaiterState,
	spawnCwdFor,
	waiterStatePath,
	waitProgressSequence,
} = await import("../src/lib/pr-await-core.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The waiter's `--state` file for a PR in a harness directory.
 *
 * These tests used to name `pi-<id>.json`, because that is the file the
 * extension handed the waiter as `--state` while also seeding it with the
 * session's own latch. One file, two writers, and a waiter rewrite read back as
 * a session latch (F20). The waiter now gets a file of its own, so the tests
 * name the waiter's file — which is also what a real `ghl-pr-await` writes.
 */
function waiterState(dir: string, pr = "2142", repo = "icemining"): string {
	return waiterStatePath(repo, pr, dir);
}

let sessionSeq = 0;

type ExecFn = (cmd: string, args: string[], opts: any) => any;

type FeatureDispatch = { owner: any; verdict: { pr: string; next: string; output: string } };

function harness(
	execImpl: ExecFn,
	cwd = REPO,
	extraHooks: {
		watchMs?: number;
		chromeMs?: number;
		featureOwnedPr?: any;
		onFeatureActionable?: any;
		/** Present-and-undefined selects the production pid probe. */
		driverRunning?: any;
	} = {},
) {
	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const calls: string[] = [];
	const wakes: string[] = [];
	const wakeModes: Array<string | undefined> = [];
	const spawns: string[][] = [];
	const dispatches: FeatureDispatch[] = [];
	const running = new Set<string>();
	const sessionId = `TEST-${process.pid}-${++sessionSeq}`;
	const dir = mkdtempSync(join(tmpdir(), "ghl-await-h-"));
	process.env.GHL_LATCH_STATE_DIR = dir;
	// This harness owns the Feature root too: the default lookup must find only
	// Features a test wrote, and never a real one.
	process.env.GHL_ORCH_ROOT = dir;

	const pi = {
		on: (event: string, fn: any) => {
			handlers[event] = fn;
		},
		registerCommand: (name: string, opts: any) => {
			commands[name] = opts.handler;
		},
		exec: async (cmd: string, args: string[], opts: any) => {
			calls.push(`${[cmd, ...args].join(" ")} @${opts.cwd}`);
			return execImpl(cmd, args, opts);
		},
		sendUserMessage: async (text: string, options?: { deliverAs?: string }) => {
			wakes.push(text);
			wakeModes.push(options?.deliverAs);
		},
	};
	latch(pi as any, {
		spawnDriver: (argv) => {
			spawns.push(argv);
			const stateFile = argv[argv.indexOf("--state") + 1];
			try {
				const s = JSON.parse(readFileSync(stateFile, "utf8"));
				if (s?.pr) running.add(String(s.pr));
			} catch {
				running.add("unknown");
			}
			return { pid: 4242 };
		},
		driverRunning: "driverRunning" in extraHooks
			? extraHooks.driverRunning
			: (pr) => running.has(pr),
		watchMs: extraHooks.watchMs ?? 0,
		chromeMs: extraHooks.chromeMs ?? 0,
		featureOwnedPr: extraHooks.featureOwnedPr,
		// Captured, not executed: a real dispatch would spawn a writer child.
		onFeatureActionable:
			extraHooks.onFeatureActionable ??
			((_ctx: unknown, owner: any, verdict: FeatureDispatch["verdict"]) => {
				dispatches.push({ owner, verdict });
			}),
	});

	let idle = true;
	const notifies: string[] = [];
	const widgets: unknown[] = [];
	const titles: string[] = [];
	const ctx = {
		cwd,
		isIdle: () => idle,
		ui: {
			setStatus() {},
			setTitle(t?: string) {
				titles.push(t ?? "");
			},
			setWidget(_key: string, content: unknown) {
				widgets.push(content);
			},
			notify: (m: string) => notifies.push(m),
		},
		sessionManager: { getSessionId: () => sessionId },
	};

	return {
		dir,
		calls,
		wakes,
		wakeModes,
		spawns,
		dispatches,
		notifies,
		widgets,
		titles,
		commands,
		ctx,
		sessionId,
		running,
		setIdle: (v: boolean) => {
			idle = v;
		},
		start: (event: Record<string, unknown> = {}) => handlers.session_start(event, ctx),
		shutdown: () => handlers.session_shutdown({}, ctx),
		settle: () => handlers.agent_settled({}, ctx),
		input: (text: string, source = "interactive") =>
			handlers.input?.({ text, source }, ctx),
		bash: async (command: string, output: string) => {
			await handlers.tool_execution_start({ toolName: "bash", toolCallId: "tc", args: { command } });
			await handlers.tool_execution_end({ toolCallId: "tc", result: { output }, isError: false });
		},
		cleanup: () => {
			handlers.session_shutdown?.({}, ctx);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });
const OPEN = ok('{"state":"OPEN","mergedAt":null}');
const MERGED = ok('{"state":"MERGED","mergedAt":"2026-08-24T21:44:34Z"}');
const CLOSED = ok('{"state":"CLOSED","mergedAt":null}');

test("parseField: reads every field off the real multi-line output", () => {
	assert.equal(parseField(REAL_OUTPUT, "status"), "reviewer_active");
	assert.equal(parseField(REAL_OUTPUT, "next"), "poll_again");
	assert.equal(parseField(REAL_OUTPUT, "pr"), "2142");
	assert.equal(parseField(REAL_OUTPUT, "head"), "47e2b0ad8afaaf5e3a0a29c689fe2b26e0b36016");
	assert.equal(parseField(REAL_OUTPUT, "cursor"), "v1:2142:47e2b0ad8afaaf5e3a0a29c689fe2b26e0b36016");
});

test("parseField: does not match a longer key ending in the field name", () => {
	assert.equal(parseField("subnext=wrong", "next"), undefined);
	assert.equal(parseField("prev_cursor=wrong", "cursor"), undefined);
	assert.equal(parseField("subnext=wrong\nnext=right", "next"), "right");
});

test("parseAwaitCall: a flag's numeric VALUE is never mistaken for the PR", () => {
	assert.equal(parseAwaitCall("git pr-await --bot 12345 2142")?.pr, "2142");
	assert.equal(parseAwaitCall("git pr-await --timeout-secs 0 2142")?.pr, "2142");
});

test("parseAwaitCall: stops at a shell separator", () => {
	assert.equal(parseAwaitCall("git pr-await 2142 && echo 999")?.pr, "2142");
});

test("trailingCd: takes the cd into the repo", () => {
	assert.equal(trailingCd(`cd ${REPO} && git pr-await 1`), REPO);
});

test("trailingCd: rejects paths outside the dev tree", () => {
	assert.equal(trailingCd("cd /tmp && git pr-await 1"), undefined);
});

test("git pr-land --continue does not retarget the latch onto another PR", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.bash(
		`cd ${REPO} && git pr-land --continue 10`,
		"status=land_failed\nnext=git_pr_land_continue\npr=10\n",
	);
	await h.settle();
	await sleep(80);
	const state = JSON.parse(readFileSync(waiterState(h.dir), "utf8"));
	assert.equal(state.pr, "2142", "pr-land 10 must not steal a latch that was on 2142");
	h.cleanup();
});

test("discover ignores the reference checkout", async () => {
	const h = harness((cmd, args) => {
		if (cmd === "git" && args[0] === "worktree") return ok(`worktree ${REPO}\nHEAD a\n`);
		if (cmd === "git" && args[0] === "rev-parse") return ok("experimental/stratum-hotswap\n");
		if (cmd === "gh" && args[1] === "list") return ok('[{"number":10}]');
		if (cmd === "gh" && args[1] === "view") return OPEN;
		return ok("[]");
	}, REPO);
	await h.start();
	await h.settle();
	await sleep(80);
	assert.equal(h.spawns.length, 0, "must not latch icemining#10 from the reference checkout");
	h.cleanup();
});

test("settle hands off to a detached driver — zero parent wakes, zero in-process pr-await", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.settle();
	await sleep(80);

	assert.equal(h.wakes.length, 0, "must not sendUserMessage into the parent session");
	assert.equal(
		h.calls.filter((c) => c.includes("pr-await")).length,
		0,
		"the extension must not run pr-await itself",
	);
	assert.equal(h.spawns.length, 1);
	assert.ok(h.spawns[0].includes("--state"));
	assert.ok(h.spawns[0].includes("--daemon"));
	assert.ok(
		h.notifies.some((n) => /handed off \S*#2142/.test(n)),
		`expected a repo-qualified handoff toast; got ${h.notifies.join(" | ")}`,
	);
	const handoff = h.notifies.find((n) => /handed off/.test(n)) ?? "";
	assert.match(
		handoff,
		/\x1b\]8;;https:\/\/github.com\/moofone\/icemining\/pull\/2142/,
		`handoff toast must OSC-8 link the PR like wait chrome; got ${JSON.stringify(handoff)}`,
	);
	assert.ok(existsSync(waiterState(h.dir)));
	h.cleanup();
});

test("two settles do not spawn two drivers", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.settle();
	await sleep(40);
	await h.settle();
	await sleep(40);
	assert.equal(h.spawns.length, 1);
	assert.equal(h.wakes.length, 0);
	const already = h.notifies.find((n) => /waiter already running/.test(n)) ?? "";
	assert.match(
		already,
		/\x1b\]8;;https:\/\/github.com\/moofone\/icemining\/pull\/2142/,
		`already-running toast must OSC-8 link the PR; got ${JSON.stringify(already)}`,
	);
	h.cleanup();
});

test("session_shutdown does not prevent a later driver and does not wake", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.settle();
	await sleep(40);
	assert.equal(h.spawns.length, 1);
	await h.shutdown();
	assert.equal(h.wakes.length, 0);
	assert.equal(h.spawns.length, 1, "shutdown must not spawn or respawn");
	h.cleanup();
});

test("session_start after a dead driver respawns detached, without waiting for settle", async () => {
	const first = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	await first.start();
	await first.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await first.settle();
	await sleep(40);
	await first.shutdown();

	const second = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	(second.ctx.sessionManager as any).getSessionId = () => first.sessionId;
	// Same session id AND the same state dir: this is one session reopening its
	// own latch, not a new session finding someone else's.
	process.env.GHL_LATCH_STATE_DIR = first.dir;
	// Pretend the previous driver died with the host.
	await second.start();
	await sleep(80);

	assert.equal(second.wakes.length, 0);
	assert.ok(second.spawns.length >= 1, "must ensure the driver on session_start");
	assert.equal(
		second.calls.filter((c) => c.includes("pr-await")).length,
		0,
		"reload must not run an in-process wait",
	);
	first.cleanup();
	second.cleanup();
});

test("merged PR whose worktree is already gone is not handed off as a stall", async () => {
	const GONE = join(homedir(), "Dev", "git", "ice-wt", "__gone_after_land__");
	const REF = join(homedir(), "Dev", "git", "icemining");
	const h = harness((cmd, _args, opts) => {
		if (opts.cwd === GONE || !existsSync(opts.cwd)) {
			return { stdout: "", stderr: `ENOENT: ${opts.cwd}`, code: 1, killed: false };
		}
		if (cmd === "gh") return MERGED;
		return ok("[]");
	}, REF);
	await h.start();
	// The extension's own latch file. It used to be legitimate to write this
	// through the waiter's `--state` path, because they were the same file;
	// session_start now reads the latch only from the file the extension owns.
	writeFileSync(
		join(h.dir, `pi-${h.sessionId}.latch.json`),
		JSON.stringify({ pr: "2142", cwd: GONE, lastNext: "done" }),
	);
	// Reload the in-memory latch from the file as session_start does.
	await h.start();
	await sleep(80);
	assert.equal(h.spawns.length, 0, "must not spawn a driver for a merged PR");
	assert.equal(h.wakes.length, 0);
	assert.ok(
		h.notifies.some((n) => /merged/i.test(n)),
		`expected a merged notification; got ${h.notifies.join(" | ")}`,
	);
	h.cleanup();
});

test("closed-unmerged wakes the live parent so the session continues", async () => {
	const h = harness((cmd) => (cmd === "gh" ? CLOSED : ok(REAL_OUTPUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.settle();
	await sleep(80);
	assert.equal(h.spawns.length, 0);
	assert.equal(h.wakes.length, 1);
	assert.match(h.wakes[0], /#2142 closed without merging/);
	assert.match(h.wakes[0], /Do not wait for another user message/);
	assert.equal(h.wakeModes[0], undefined, "idle parent starts a turn immediately");
	assert.ok(h.notifies.some((n) => /closed without merging/.test(n)));
	h.cleanup();
});

test("settle on an already-merged PR wakes the live parent to continue", async () => {
	const h = harness((cmd) => (cmd === "gh" ? MERGED : ok(REAL_OUTPUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.settle();
	await sleep(80);
	assert.equal(h.spawns.length, 0);
	assert.equal(h.wakes.length, 1);
	assert.match(h.wakes[0], /#2142 merged/);
	assert.match(h.wakes[0], /Continue the work you deferred/);
	assert.ok(h.notifies.some((n) => /merged/i.test(n)));
	h.cleanup();
});

test("merge after handoff wakes the live parent so deferred work continues", async () => {
	let view = OPEN;
	const h = harness(
		(cmd) => (cmd === "gh" ? view : ok(REAL_OUTPUT)),
		REPO,
		{ watchMs: 20 },
	);
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.settle();
	await sleep(40);
	assert.equal(h.wakes.length, 0, "must not wake while the PR is still open");
	assert.equal(h.spawns.length, 1);
	view = MERGED;
	await sleep(80);
	assert.equal(h.wakes.length, 1, "live parent must continue after merge");
	assert.match(h.wakes[0], /#2142 merged/);
	assert.match(h.wakes[0], /Do not wait for another user message/);
	assert.ok(
		h.notifies.some((n) => /#2142(?:\x1b\]8;;\x07)? merged/.test(n)),
		`merge toast must keep the PR label (OSC-8 close may sit before 'merged'); got ${h.notifies.join(" | ")}`,
	);
	h.cleanup();
});

test("merge during a later parent turn queues followUp instead of interrupting", async () => {
	let view = OPEN;
	const h = harness(
		(cmd) => (cmd === "gh" ? view : ok(REAL_OUTPUT)),
		REPO,
		{ watchMs: 20 },
	);
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.settle();
	await sleep(40);
	assert.equal(h.wakes.length, 0);
	h.setIdle(false);
	view = MERGED;
	await sleep(80);
	assert.equal(h.wakes.length, 1);
	assert.equal(h.wakeModes[0], "followUp");
	assert.match(h.wakes[0], /#2142 merged/);
	h.cleanup();
});

test("next=yield arms the latch and never wakes the parent", async () => {
	const YIELD_OUT = ["status=handed_off", "next=yield", "pr=2142", "instruction=stop_talking", ""].join("\n");
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(YIELD_OUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, YIELD_OUT);
	await h.settle();
	await sleep(80);
	assert.equal(h.wakes.length, 0);
	assert.equal(h.spawns.length, 1);
	h.cleanup();
});

test("armObservedLatch (pi.exec path) watches and wakes on merge without a bash tool event", async () => {
	let view = OPEN;
	const h = harness(
		(cmd) => (cmd === "gh" ? view : ok("[]")),
		REPO,
		{ watchMs: 20 },
	);
	try {
		await h.start();
		armObservedLatch(h.ctx, { pr: "2142", cwd: REPO, lastNext: "yield" });
		await sleep(40);
		assert.equal(h.wakes.length, 0, "must not wake while the PR is still open");
		assert.equal(h.spawns.length, 1, "code-armed latch must still ensure a waiter");
		view = MERGED;
		await sleep(80);
		assert.equal(h.wakes.length, 1, "live parent must continue after merge");
		assert.match(h.wakes[0], /#2142 merged/);
		assert.match(h.wakes[0], /Continue the work you deferred/);
	} finally {
		h.cleanup();
	}
});

test("arms from a gh pr create URL when pr-await was never run", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok("[]")));
	await h.start();
	await h.bash(`cd ${REPO} && gh pr create --fill`, "https://github.com/moofone/icemining/pull/2150\n");
	await h.settle();
	await sleep(80);
	assert.equal(h.spawns.length, 1);
	// Seeded for the waiter at spawn, under the PR the URL named.
	assert.ok(existsSync(waiterState(h.dir, "2150")));
	h.cleanup();
});

test("cold discovery does not latch a PR this session never awaited", async () => {
	const WT = join(homedir(), "Dev", "git", "deribit_bot_v2-wt");
	const MAIN = join(homedir(), "Dev", "git", "deribit_bot_v2");
	const h = harness((cmd, args, opts) => {
		if (cmd === "git" && args[0] === "rev-parse") return ok(opts.cwd === WT ? "feat/bot\n" : "main\n");
		if (cmd === "gh" && args[1] === "list") return ok(opts.cwd === WT ? '[{"number":77}]' : "[]");
		if (cmd === "gh" && args[1] === "view") return OPEN;
		return ok("[]");
	}, MAIN);
	await h.start();
	// Working in a worktree is not waiting on its PR. Guessing here is how one
	// session latched another session's branch.
	await h.bash(`cd ${WT} && cargo test`, "ok");
	await h.settle();
	await sleep(120);
	assert.equal(h.spawns.length, 0, "must not discover a PR this session never awaited");
	assert.equal(h.wakes.length, 0);
	h.cleanup();
});

// ---------------------------------------------------------------------------
// Provenance. A latch this session established by running `git pr-await` (or
// `gh pr create`) is the ONLY kind that may claim the session deferred work on
// it. Scavenging a PR off disk or off someone else's worktree and then telling
// the model to "continue the work you deferred" is how the Mac-Studio chat got
// ordered to resume icemining-devops#475.
// ---------------------------------------------------------------------------

test("a worktree this session never touched is never latched", async () => {
	// The directory must really exist: the old scan ranked `git worktree list`
	// entries by mtime, so a live sibling worktree was the top candidate for any
	// session that merely settled in the repo.
	const OTHER = join(homedir(), "Dev", "git", "ice-wt", "__someone_elses_branch__");
	mkdirSync(OTHER, { recursive: true });
	const h = harness((cmd, args, opts) => {
		if (cmd === "git" && args[0] === "worktree")
			return ok(`worktree ${REPO}\nHEAD a\n\nworktree ${OTHER}\nHEAD b\n`);
		if (cmd === "git" && args[0] === "rev-parse") return ok(opts.cwd === OTHER ? "feat/theirs\n" : "main\n");
		if (cmd === "gh" && args[1] === "list") return ok(opts.cwd === OTHER ? '[{"number":2161}]' : "[]");
		if (cmd === "gh" && args[1] === "view") return OPEN;
		return ok("[]");
	}, REPO);
	try {
		await h.start();
		await h.settle();
		await sleep(120);
		assert.equal(h.spawns.length, 0, "must not adopt another worktree's PR off `git worktree list`");
		assert.equal(h.wakes.length, 0);
		assert.equal(
			h.notifies.filter((n) => /2161/.test(n)).length,
			0,
			`must not even mention a PR it never touched; got ${h.notifies.join(" | ")}`,
		);
	} finally {
		h.cleanup();
		rmSync(OTHER, { recursive: true, force: true });
	}
});

test("a merge notice names the repo, so a bare number cannot resolve elsewhere", async () => {
	const h = harness((cmd) => (cmd === "gh" ? MERGED : ok(REAL_OUTPUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.settle();
	await sleep(80);
	assert.equal(h.wakes.length, 1);
	assert.match(h.wakes[0], /icemining#2142/, `wake must be repo-qualified; got ${h.wakes[0]}`);
	assert.ok(
		h.notifies.some((n) => /icemining#2142/.test(n)),
		`toast must be repo-qualified; got ${h.notifies.join(" | ")}`,
	);
	h.cleanup();
});

test("repoKey separates a repo from its worktrees and from a sibling repo", () => {
	assert.equal(repoKey(join(homedir(), "Dev", "git", "icemining")), "icemining");
	assert.equal(repoKey(join(homedir(), "Dev", "git", "ice-wt", "feat-x")), "icemining");
	assert.equal(repoKey(join(homedir(), "Dev", "git", "icemining-devops")), "icemining-devops");
	assert.equal(repoKey(join(homedir(), "Dev", "git", "devops-wt", "feat-y")), "icemining-devops");
	assert.notEqual(
		repoKey(join(homedir(), "Dev", "git", "icemining-devops")),
		repoKey(join(homedir(), "Dev", "git", "icemining")),
	);
	assert.equal(repoKey("/tmp/nope"), undefined);
});

test("a clean branch with no open PR stays completely silent", async () => {
	const h = harness((cmd, args) => {
		if (cmd === "git" && args[0] === "worktree") return ok(`worktree ${REPO}\nHEAD a\n`);
		if (cmd === "git" && args[0] === "rev-parse") return ok("main\n");
		return ok("[]");
	});
	await h.start();
	await h.settle();
	await sleep(80);
	assert.equal(h.spawns.length, 0);
	assert.equal(h.wakes.length, 0);
	h.cleanup();
});

test("/pr-latch off disables the sensor without waking", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.commands["pr-latch"]("off", h.ctx);
	await h.settle();
	await sleep(40);
	assert.equal(h.spawns.length, 0);
	assert.equal(h.wakes.length, 0);
	h.cleanup();
});

test("ACTIONABLE is the judgment set the waiter records and the latch delivers", () => {
	assert.equal(ACTIONABLE.has("read_comments_and_fix"), true);
	assert.equal(ACTIONABLE.has("investigate_dead_reviewers"), true);
	assert.equal(ACTIONABLE.has("fix_command_or_environment"), true);
	assert.equal(ACTIONABLE.has("poll_again"), false);
	assert.equal(ACTIONABLE.has("yield"), false);
	assert.equal(ACTIONABLE.has("git_pr_land"), false);
});

// ---------------------------------------------------------------------------
// Reload adoption. A pi reload mints a NEW session id, so `pi-<id>.json` does
// not exist and the latch was silently dropped: no handoff, no watch, no wake.
// That is how shared-lmdb#18 merged 19s before a reload and never resumed.
// ---------------------------------------------------------------------------

test("reload under a NEW session id adopts an orphaned live latch and wakes", async () => {
	const WT = join(homedir(), "Dev", "git", "ice-wt", "__adopt_me__");
	const h = harness((cmd) => (cmd === "gh" ? MERGED : ok("[]")), WT);
	// A real reload leaves the dead session's OWN latch behind: `pi-<id>.latch.json`
	// carrying its pid. That file is what makes this session a successor, so it is
	// what the wake is licensed by. (It used to be sourced from `manual-9931.json`
	// — the waiter's bookkeeping, which names no session at all. That is the exact
	// route by which an unrelated `manual-2162.json` woke a fresh session.)
	const orphan = join(h.dir, "pi-DEAD-RELOAD.latch.json");
	writeFileSync(orphan, JSON.stringify({ pr: "9931", cwd: WT, origin: "observed", pid: 999999 }));
	try {
		// Brand-new session id, same worktree: what a reload in that Feature produces.
		await h.start({ reason: "reload" });
		await sleep(120);
		assert.equal(h.wakes.length, 1, `adopted latch must wake the reloaded parent; wakes=${h.wakes.length}`);
		assert.match(h.wakes[0], /#9931 merged/);
		// Inherited, not observed: the wake may not assert this session deferred it.
		assert.match(h.wakes[0], /inherited/i);
		assert.doesNotMatch(
			h.wakes[0],
			/the work you deferred/i,
			`an inherited latch must not claim this session deferred the work; got ${h.wakes[0]}`,
		);
	} finally {
		h.cleanup();
		rmSync(orphan, { force: true });
	}
});

test("a fresh session in the reference checkout does not inherit a worktree latch", async () => {
	// Live: this git-workflow chat (cwd ~/Dev/git/icemining) was injected
	//   pr-latch: moofone/icemining#2150 merged. Continue the work you deferred.
	// The session never ran pr-await 2150. Same-repo adoption from ice-wt was enough.
	const WT = join(homedir(), "Dev", "git", "ice-wt", "__not_this_chat__");
	const h = harness((cmd) => (cmd === "gh" ? MERGED : ok("[]")), REPO);
	writeFileSync(
		join(h.dir, "pi-DEAD-2150.latch.json"),
		JSON.stringify({ pr: "2150", cwd: WT, origin: "observed", pid: 999999 }),
	);
	try {
		await h.start({ reason: "startup" });
		await sleep(120);
		assert.equal(h.wakes.length, 0, `reference checkout must not inherit ice-wt PRs; got ${h.wakes.join(" | ")}`);
		assert.equal(
			h.notifies.filter((n) => /2150/.test(n)).length,
			0,
			`must not adopt; got ${h.notifies.join(" | ")}`,
		);
	} finally {
		h.cleanup();
	}
});

test("a later user prompt cancels the deferred-work wake", async () => {
	let view = OPEN;
	const h = harness(
		(cmd) => (cmd === "gh" ? view : ok(REAL_OUTPUT)),
		REPO,
		{ watchMs: 20 },
	);
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.settle();
	await sleep(40);
	assert.equal(h.wakes.length, 0);
	await h.input("check git-workflow, tdd-worker should not open PRs");
	view = MERGED;
	await sleep(80);
	assert.equal(
		h.wakes.length,
		0,
		`moved-on session must not be told it deferred this merge; got ${h.wakes.join(" | ")}`,
	);
	assert.ok(
		h.notifies.some((n) => /2142/.test(n) && /merged/.test(n)),
		`toast still reports the merge; got ${h.notifies.join(" | ")}`,
	);
	h.cleanup();
});

test("a latch from another repository is never adopted", async () => {
	// The live failure: an icemining chat adopted the icemining-devops#475 latch
	// and was told to continue work it had never started.
	const DEVOPS_WT = join(homedir(), "Dev", "git", "devops-wt", "feat-pearl-hosts");
	const h = harness((cmd) => (cmd === "gh" ? MERGED : ok("[]")), REPO);
	const orphan = join(h.dir, "manual-475.json");
	writeFileSync(orphan, JSON.stringify({ pr: "475", cwd: DEVOPS_WT }));
	try {
		await h.start();
		await sleep(120);
		assert.equal(h.wakes.length, 0, `cross-repo latch must not wake; got ${h.wakes.join(" | ")}`);
		assert.equal(
			h.notifies.filter((n) => /475/.test(n)).length,
			0,
			`cross-repo latch must not be adopted at all; got ${h.notifies.join(" | ")}`,
		);
	} finally {
		h.cleanup();
		rmSync(orphan, { force: true });
	}
});

test("a latch owned by a LIVE session is not stolen", async () => {
	// Six sessions all holding pr:2161 with the same worktree cwd came from here.
	const WT = join(homedir(), "Dev", "git", "ice-wt", "__owned_by_live__");
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok("[]")), REPO);
	const owned = join(h.dir, "pi-LIVE-OWNER.latch.json");
	// pid 1 is always alive and is never this process.
	writeFileSync(owned, JSON.stringify({ pr: "2161", cwd: WT, origin: "observed", pid: 1 }));
	try {
		await h.start();
		await sleep(120);
		assert.equal(h.spawns.length, 0, "must not take over a live session's PR");
		assert.equal(
			h.notifies.filter((n) => /2161/.test(n)).length,
			0,
			`live-owned latch must not be adopted; got ${h.notifies.join(" | ")}`,
		);
	} finally {
		h.cleanup();
		rmSync(owned, { force: true });
	}
});

test("a session-owned latch with no recorded owner is not adopted", async () => {
	// Every `pi-<id>.latch.json` written before ownership was recorded looks like
	// this. Liveness of its session cannot be established, so successorship
	// cannot be claimed — and ~60 such files (all pr:2161) are sitting in the real
	// state dir right now.
	const WT = join(homedir(), "Dev", "git", "ice-wt", "__legacy_no_owner__");
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok("[]")), REPO);
	const legacy = join(h.dir, "pi-01a03f95-caaf-7737.latch.json");
	writeFileSync(legacy, JSON.stringify({ pr: "2161", cwd: WT }));
	try {
		await h.start();
		await sleep(120);
		assert.equal(h.spawns.length, 0, "an ownerless session latch must not be adopted");
		assert.equal(h.wakes.length, 0);
	} finally {
		h.cleanup();
	}
});

test("a manual latch for a PR a live session already owns is not adopted", async () => {
	// The waiter writes `manual-<pr>.json` for every wait, so the PR another
	// session is actively driving is also reachable by that name. Without this,
	// blocking the direct steal just reroutes it: `pr-latch: #2161 already
	// driving (detached)` fired in a session doing unrelated devops work.
	const WT = join(homedir(), "Dev", "git", "ice-wt", "__live_elsewhere__");
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok("[]")), REPO);
	writeFileSync(join(h.dir, "manual-2161.json"), JSON.stringify({ pr: "2161", cwd: WT }));
	writeFileSync(
		join(h.dir, "pi-LIVE.latch.json"),
		JSON.stringify({ pr: "2161", cwd: WT, origin: "observed", pid: 1 }),
	);
	try {
		await h.start();
		await sleep(120);
		assert.equal(h.spawns.length, 0, "a PR with a live owner must not be re-adopted by another route");
		assert.equal(
			h.notifies.filter((n) => /2161/.test(n)).length,
			0,
			`got ${h.notifies.join(" | ")}`,
		);
	} finally {
		h.cleanup();
	}
});

test("a waiter-written manual latch is still adoptable", async () => {
	// `manual-<pr>.json` has no owning pi session by construction, so the pid rule
	// must not lock out the case adoption exists for — but only in this worktree.
	const WT = join(homedir(), "Dev", "git", "ice-wt", "__manual_ok__");
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok("[]")), WT);
	writeFileSync(join(h.dir, "manual-9950.json"), JSON.stringify({ pr: "9950", cwd: WT }));
	try {
		await h.start({ reason: "reload" });
		await sleep(120);
		assert.equal(h.spawns.length, 1, "a manual latch must still be re-armed after a reload");
	} finally {
		h.cleanup();
	}
});

test("an inherited latch is not re-adopted onward by a third session", async () => {
	const WT = join(homedir(), "Dev", "git", "ice-wt", "__no_chain__");
	const h = harness((cmd) => (cmd === "gh" ? MERGED : ok("[]")), REPO);
	const second = join(h.dir, "pi-DEAD-ADOPTER.latch.json");
	writeFileSync(second, JSON.stringify({ pr: "9940", cwd: WT, origin: "adopted" }));
	try {
		await h.start();
		await sleep(120);
		assert.equal(h.wakes.length, 0, "provenance must not launder through a chain of adoptions");
	} finally {
		h.cleanup();
		rmSync(second, { force: true });
	}
});

test("an adopted still-open latch is re-armed with a driver instead of dropped", async () => {
	const WT = join(homedir(), "Dev", "git", "ice-wt", "__adopt_open__");
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok("[]")), WT);
	const orphan = join(h.dir, "manual-9933.json");
	writeFileSync(orphan, JSON.stringify({ pr: "9933", cwd: WT }));
	try {
		await h.start({ reason: "reload" });
		await sleep(120);
		assert.equal(h.spawns.length, 1, "reload must re-ensure the waiter for an adopted open PR");
		assert.equal(h.wakes.length, 0, "an open PR must not wake the parent");
	} finally {
		h.cleanup();
		rmSync(orphan, { force: true });
	}
});

test("adopted terminal latch wakes exactly once even with the watch armed", async () => {
	const WT = join(homedir(), "Dev", "git", "ice-wt", "__adopt_once__");
	const h = harness((cmd) => (cmd === "gh" ? MERGED : ok("[]")), WT, { watchMs: 20 });
	const orphan = join(h.dir, "pi-DEAD-ONCE.latch.json");
	writeFileSync(orphan, JSON.stringify({ pr: "9932", cwd: WT, origin: "observed", pid: 999999 }));
	try {
		await h.start({ reason: "reload" });
		await sleep(200);
		assert.equal(h.wakes.length, 1, `expected exactly one wake, got ${h.wakes.length}`);
	} finally {
		h.cleanup();
		rmSync(orphan, { force: true });
	}
});

test("a waiter overwriting the shared state path cannot retarget the latch", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)), REPO);
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		await h.settle();
		await sleep(40);
		// A Rust waiter driving a DIFFERENT PR writes its verdict into the path
		// the extension used to share with it. This is the real pi-01a03ef0.json
		// shape: PR #11's verdict sitting where #18's latch belonged.
		writeFileSync(
			waiterState(h.dir),
			JSON.stringify({ pr: "11", cwd: REPO, verdict: "status=action_required", verdictDelivered: false }),
		);
		await h.start();
		await sleep(80);
		await h.commands["pr-latch"]("", h.ctx);
		const line = h.notifies.at(-1) ?? "";
		assert.match(line, /PR #2142/, `latch was clobbered by the waiter: ${line}`);
	} finally {
		h.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Regressions from the 2026-08-26 field reports. Each of these fired at a real
// user in a real session; the state files are quoted in the comments.
// ---------------------------------------------------------------------------

test("a manual latch for an already-merged PR never wakes a fresh session", async () => {
	// Live: a brand-new session in ~/Dev/git/icemining was woken with
	//   pr-latch: icemining#2162 merged ... inherited from an earlier session
	// #2162 ("Phase 2 Discord PKCE-S256") had merged at 18:11Z and no session
	// here ever waited on it. It was reachable only because the waiter leaves
	//   manual-2162.json = {"pr":"2162","cwd":".../feat-discord-pkce-s256-hop"}
	// lying around for 24h, and every 2163 latch had been filtered out as owned
	// by a live session. Adoption exists to keep waiting on an OPEN pr; a manual
	// file carries no session identity, so a merge that predates this session is
	// history, not deferred work.
	const WT = join(homedir(), "Dev", "git", "ice-wt", "feat-discord-pkce-s256-hop");
	const h = harness((cmd) => (cmd === "gh" ? MERGED : ok("[]")), REPO);
	writeFileSync(join(h.dir, "manual-2162.json"), JSON.stringify({ pr: "2162", cwd: WT }));
	try {
		await h.start();
		await sleep(120);
		assert.equal(
			h.wakes.length,
			0,
			`a merged manual latch must not wake anyone; got ${h.wakes.join(" | ")}`,
		);
	} finally {
		h.cleanup();
	}
});

test("a session whose repo cannot be determined adopts nothing", async () => {
	// Live: a coins-minimal session driving PR #13 was woken with
	//   pr-latch: PR #478 merged. Continue the work you deferred until this merge.
	// #478 is icemining-devops. `adoptableLatch` is passed `repo: repoKey(ctx.cwd)`
	// and the guard is `if (opts.repo && ...)`, so an undetermined repo disabled
	// the cross-repo check entirely instead of refusing. The bare `PR #478` label
	// is the tell: prLabel had no repo either, and #478 means different pull
	// requests in different repos.
	const DEVOPS_WT = join(homedir(), "Dev", "git", "devops-wt", "feat-pearl-hosts");
	const h = harness((cmd) => (cmd === "gh" ? MERGED : ok("[]")), "/tmp");
	writeFileSync(join(h.dir, "manual-478.json"), JSON.stringify({ pr: "478", cwd: DEVOPS_WT }));
	try {
		await h.start();
		await sleep(120);
		assert.equal(h.wakes.length, 0, `got ${h.wakes.join(" | ")}`);
		assert.equal(
			h.notifies.filter((n) => /478/.test(n)).length,
			0,
			`a repo-less session must adopt nothing; got ${h.notifies.join(" | ")}`,
		);
	} finally {
		h.cleanup();
	}
});

test("an ownerless session latch still protects its PR from the manual route", async () => {
	// The asymmetry that let #13's session be woken about someone else's PR: a
	// pid-less `pi-<id>.latch.json` is (correctly) refused as an adoption source,
	// but `ownedByLive` only counts owners that record a pid — so the same file
	// failed to protect its own PR, which stayed reachable via manual-<pr>.json.
	// Real file, verbatim:
	//   pi-01a03ef0-....latch.json = {"pr":"13","cwd":".../coins-minimal-wt/dial-backoff"}
	// Refusing to adopt is always the safe direction: the waiter keeps running.
	const WT = join(homedir(), "Dev", "git", "ice-wt", "__ownerless_protects__");
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok("[]")), REPO);
	writeFileSync(join(h.dir, "manual-2161.json"), JSON.stringify({ pr: "2161", cwd: WT }));
	writeFileSync(join(h.dir, "pi-NO-OWNER.latch.json"), JSON.stringify({ pr: "2161", cwd: WT }));
	try {
		await h.start();
		await sleep(120);
		assert.equal(h.spawns.length, 0, "a PR an unproven-dead session holds must not be re-adopted");
		assert.equal(
			h.notifies.filter((n) => /2161/.test(n)).length,
			0,
			`got ${h.notifies.join(" | ")}`,
		);
	} finally {
		h.cleanup();
	}
});

test("spawnCwdFor refuses a cwd that is not a git checkout", () => {
	assert.equal(spawnCwdFor({ cwd: homedir() }), undefined, "HOME is not a git checkout");
	// Live: the #2163 waiter died looping on
	//   error=cannot resolve owner/repo from origin remote
	// `resolve_repo()` runs `git config --get remote.origin.url` in the daemon's
	// cwd. defaultSpawnDriver fell back to `process.cwd()` whenever the latch
	// could not be read — and it read the waiter-owned state file, which the
	// waiter rewrites wholesale, so a torn read was reachable. A daemon spawned
	// outside a checkout cannot ever succeed; not spawning beats error-looping.
	assert.equal(spawnCwdFor(undefined), undefined, "no latch means no defensible cwd");
	assert.equal(
		spawnCwdFor({ pr: "2163", cwd: "/tmp" }),
		undefined,
		"a non-checkout cwd must not be spawned into",
	);
	assert.equal(
		spawnCwdFor({ pr: "2163", cwd: join(homedir(), "Dev", "git", "__gone__", "nope") }),
		undefined,
		"a deleted worktree with no resolvable reference checkout must not be spawned into",
	);
	// A deleted worktree whose reference checkout exists falls back to it.
	assert.equal(
		spawnCwdFor({ pr: "2163", cwd: join(homedir(), "Dev", "git", "ice-wt", "__deleted__") }),
		REPO,
		"a removed worktree must fall back to its reference checkout",
	);
	assert.equal(spawnCwdFor({ pr: "2163", cwd: REPO }), REPO);
});

test("defaultSpawnDriver never falls back to HOME or process.cwd()", async () => {
	const homeResult = defaultSpawnDriver(join(DRIVER_PROBE_DIR, "home-state.json"), {
		pr: "2163",
		cwd: homedir(),
	});
	const tmpResult = defaultSpawnDriver(join(DRIVER_PROBE_DIR, "tmp-state.json"), {
		pr: "2164",
		cwd: "/tmp",
	});

	assert.equal(homeResult.pid, undefined, "HOME latch must not spawn a waiter");
	assert.equal(tmpResult.pid, undefined, "non-checkout latch must not spawn a waiter");
	await sleep(80);
	assert.equal(
		existsSync(DRIVER_MARKER),
		false,
		"non-checkout latches must not run the driver stub",
	);
	rmSync(DRIVER_PROBE_DIR, { recursive: true, force: true });
});

test("a manual latch still wakes about a merge it actually witnesses", async () => {
	// The other half of the #2162 rule. Suppressing the *already-merged* wake must
	// not suppress a real one: if the PR is open when adopted, this session took
	// over the wait, and the merge that follows is genuinely its outcome.
	const WT = join(homedir(), "Dev", "git", "ice-wt", "__manual_witness__");
	let merged = false;
	const h = harness(
		(cmd, args) => {
			if (cmd !== "gh") return ok("[]");
			if (args[1] === "view") return merged ? MERGED : OPEN;
			return ok("[]");
		},
		WT,
		{ watchMs: 20 },
	);
	writeFileSync(join(h.dir, "manual-9955.json"), JSON.stringify({ pr: "9955", cwd: WT }));
	try {
		await h.start({ reason: "reload" });
		await sleep(80);
		assert.equal(h.wakes.length, 0, "still open — nothing to announce yet");
		assert.equal(h.spawns.length, 1, "an adopted open PR must get its waiter back");
		merged = true;
		await sleep(200);
		assert.equal(h.wakes.length, 1, `a witnessed merge must wake; got ${h.wakes.join(" | ")}`);
		assert.match(h.wakes[0], /icemining#9955 merged/);
	} finally {
		h.cleanup();
	}
});

test("no wake is ever labelled with a bare, repo-less PR number", async () => {
	// `pr-latch: PR #478 merged` is unactionable: #478 is icemining-devops there
	// and a different pull request in icemining. Every wake must name the repo.
	const WT = join(homedir(), "Dev", "git", "ice-wt", "__labelled__");
	const h = harness((cmd) => (cmd === "gh" ? MERGED : ok("[]")), WT);
	writeFileSync(
		join(h.dir, "pi-DEAD-LABEL.latch.json"),
		JSON.stringify({ pr: "478", cwd: WT, origin: "observed", pid: 999999 }),
	);
	try {
		await h.start({ reason: "reload" });
		await sleep(120);
		assert.equal(h.wakes.length, 1);
		assert.doesNotMatch(h.wakes[0], /(?:^|\s)PR #478\b/, `bare label: ${h.wakes[0]}`);
		assert.match(h.wakes[0], /icemining#478/);
	} finally {
		h.cleanup();
	}
});

test("a terminal manual latch is retired so later sessions stop re-adopting it", async () => {
	// manual-2162.json survived its own PR's merge and stayed adoptable for the
	// full 24h window, so every subsequent session in the repo picked it up again.
	const WT = join(homedir(), "Dev", "git", "ice-wt", "__retire__");
	const h = harness((cmd) => (cmd === "gh" ? MERGED : ok("[]")), WT);
	const spent = join(h.dir, "manual-9960.json");
	writeFileSync(spent, JSON.stringify({ pr: "9960", cwd: WT }));
	try {
		await h.start({ reason: "reload" });
		await sleep(120);
		assert.equal(h.wakes.length, 0);
		assert.equal(existsSync(spent), false, "a merged manual latch must not survive to be re-adopted");
	} finally {
		h.cleanup();
	}
});

test("an OPEN manual latch is never retired", async () => {
	const WT = join(homedir(), "Dev", "git", "ice-wt", "__keep__");
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok("[]")), REPO);
	const live = join(h.dir, "manual-9961.json");
	writeFileSync(live, JSON.stringify({ pr: "9961", cwd: WT }));
	try {
		await h.start();
		await sleep(120);
		assert.equal(existsSync(live), true, "an open PR's latch must survive");
	} finally {
		h.cleanup();
	}
});

// ---------------------------------------------------------------------------
// ACTIONABLE delivery. The waiter writes next=read_comments_and_fix with
// verdictDelivered=false; Grok/Claude inject that on Stop. Pi has no Stop
// hook, so the latch must wake the live parent or review fixes never start.
// icemining#2163 sat in this state for hours.
// ---------------------------------------------------------------------------

const ACTIONABLE_VERDICT = [
	"status=action_required",
	"next=read_comments_and_fix",
	"pr=2142",
	"comment bot=grok path=a.ts line=1 body=fix",
].join("\n");

/** Write a verdict the way the waiter does: into the waiter's own state file. */
function writeActionable(dir: string, _sessionId: string, extra: Record<string, unknown> = {}) {
	const path = waiterState(dir);
	const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	writeFileSync(
		path,
		JSON.stringify({
			...existing,
			pr: existing.pr ?? "2142",
			lastNext: "read_comments_and_fix",
			verdict: ACTIONABLE_VERDICT,
			verdictDelivered: false,
			...extra,
		}),
	);
}

test("handoff persist does not wipe a waiter ACTIONABLE verdict", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.settle();
	await sleep(40);
	writeActionable(h.dir, h.sessionId);
	await h.settle();
	await sleep(40);
	const state = JSON.parse(readFileSync(waiterState(h.dir), "utf8"));
	assert.equal(state.lastNext, "read_comments_and_fix", "persist must not clobber the waiter verdict");
	assert.equal(state.verdictDelivered, true, "the delivered wake must mark the verdict spent");
	h.cleanup();
});

test("undelivered ACTIONABLE on settle wakes the live parent once", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	writeActionable(h.dir, h.sessionId);
	await h.settle();
	await sleep(80);
	assert.equal(h.wakes.length, 1, `expected one ACTIONABLE wake, got ${h.wakes.length}`);
	assert.match(h.wakes[0], /next=read_comments_and_fix/);
	assert.match(h.wakes[0], /Fix current-head findings/);
	assert.match(h.wakes[0], /Do not wait for another user message/);
	assert.match(h.wakes[0], /comment bot=grok/);
	const state = JSON.parse(readFileSync(waiterState(h.dir), "utf8"));
	assert.equal(state.verdictDelivered, true);
	h.cleanup();
});

test("poll_again and yield do not wake", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.settle();
	await sleep(40);
	assert.equal(h.wakes.length, 0);
	h.cleanup();
});

test("already-delivered ACTIONABLE does not wake", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	writeActionable(h.dir, h.sessionId, { verdictDelivered: true });
	await h.settle();
	await sleep(80);
	assert.equal(h.wakes.length, 0, "spent verdict must not buy another turn");
	h.cleanup();
});

test("same ACTIONABLE verdict does not wake twice", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)), REPO, { watchMs: 20 });
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	writeActionable(h.dir, h.sessionId);
	await h.settle();
	await sleep(80);
	assert.equal(h.wakes.length, 1);
	writeActionable(h.dir, h.sessionId, { verdictDelivered: false });
	await sleep(80);
	assert.equal(h.wakes.length, 1, "same fingerprint must not re-wake even if delivered was reset");
	h.cleanup();
});

test("actionableFingerprint distinguishes later rounds of the same next=", () => {
	const first = actionableFingerprint({
		next: "read_comments_and_fix",
		verdict: ACTIONABLE_VERDICT,
		round: "1",
	});
	const same = actionableFingerprint({
		next: "read_comments_and_fix",
		verdict: ACTIONABLE_VERDICT,
		round: "1",
	});
	const laterRound = actionableFingerprint({
		next: "read_comments_and_fix",
		verdict: ACTIONABLE_VERDICT,
		round: "2",
	});
	const laterBody = actionableFingerprint({
		next: "read_comments_and_fix",
		verdict: `${ACTIONABLE_VERDICT}\nsecond finding`,
		round: "1",
	});
	assert.equal(first, same);
	assert.notEqual(first, laterRound, "a new review round must not look like the first");
	assert.notEqual(first, laterBody, "new findings must not look like the first");
});

test("same-session reload wakes on undelivered ACTIONABLE", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.settle();
	await sleep(40);
	assert.equal(h.wakes.length, 0);
	writeActionable(h.dir, h.sessionId);
	await h.start();
	await sleep(80);
	assert.equal(h.wakes.length, 1, "/rreload must deliver the waiting fix verdict");
	assert.match(h.wakes[0], /next=read_comments_and_fix/);
	h.cleanup();
});

test("watch delivers ACTIONABLE written after handoff", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)), REPO, { watchMs: 20 });
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	await h.settle();
	await sleep(40);
	assert.equal(h.wakes.length, 0, "must not wake while the waiter is still polling");
	writeActionable(h.dir, h.sessionId);
	await sleep(80);
	assert.equal(h.wakes.length, 1, "watch must inject the waiter verdict");
	assert.match(h.wakes[0], /next=read_comments_and_fix/);
	h.cleanup();
});

test("merged PR wins over a leftover ACTIONABLE verdict", async () => {
	const h = harness((cmd) => (cmd === "gh" ? MERGED : ok(REAL_OUTPUT)));
	await h.start();
	await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
	writeActionable(h.dir, h.sessionId);
	await h.settle();
	await sleep(80);
	assert.equal(h.wakes.length, 1);
	assert.match(h.wakes[0], /#2142 merged/);
	assert.doesNotMatch(h.wakes[0], /read_comments_and_fix/);
	h.cleanup();
});

// ---------------------------------------------------------------------------
// Feature-owned ACTIONABLE. A PR that a live `/orchestrate` Feature claims is
// fixed by a writer that code dispatches. Waking the session that happens to
// hold the latch would make it the fixer — the parent orchestrator if it ran
// `git pr-await`, and an unrelated chat if the latch was adopted. Solo latches
// still wake: that is the only route a plain session has.
// ---------------------------------------------------------------------------

/** A live `/orchestrate` Feature whose status.md claims `pr`. */
function writeFeatureStatus(
	root: string,
	opts: { repo?: string; name?: string; pr: string; worktree?: string | null },
): string {
	const repo = opts.repo ?? "icemining";
	const name = opts.name ?? "feat-x";
	const dir = join(root, repo, name);
	mkdirSync(dir, { recursive: true });
	const lines = ["# Status", "", `repo: ${repo}`, "phase: pr", `pr: ${opts.pr}`, "pr_round: 0"];
	if (opts.worktree !== null) {
		lines.push(`worktree: ${opts.worktree ?? join(homedir(), "Dev", "git", "ice-wt", name)}`);
	}
	writeFileSync(join(dir, "status.md"), `${lines.join("\n")}\n`);
	return dir;
}

test("a Feature-owned merge dispatches next=done and still wakes the parent", async () => {
	let view = OPEN;
	const h = harness(
		(cmd) => (cmd === "gh" ? view : ok(REAL_OUTPUT)),
		REPO,
		{ watchMs: 20 },
	);
	writeFeatureStatus(h.dir, { pr: "2142" });
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		await h.settle();
		await sleep(40);
		assert.equal(h.wakes.length, 0, "must not wake while open");
		assert.equal(h.dispatches.length, 0);
		view = MERGED;
		await sleep(80);
		assert.equal(h.wakes.length, 1, "merge still wakes; the no-wake exception is ACTIONABLE only");
		assert.match(h.wakes[0], /#2142 merged/);
		assert.equal(h.dispatches.length, 1, "status.md must be updated in code so yield does not stick");
		assert.equal(h.dispatches[0].verdict.next, "done");
		assert.equal(h.dispatches[0].owner.pr, "2142");
	} finally {
		h.cleanup();
	}
});

test("a Feature-owned ACTIONABLE is dispatched by code, never woken into this session", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	const featureDir = writeFeatureStatus(h.dir, { pr: "2142" });
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		writeActionable(h.dir, h.sessionId);
		await h.settle();
		await sleep(80);
		assert.equal(
			h.wakes.length,
			0,
			`a Feature PR must not ask this session to implement; got ${h.wakes.join(" | ")}`,
		);
		assert.equal(h.dispatches.length, 1, "the verdict must be dispatched exactly once");
		assert.equal(h.dispatches[0].owner.dir, featureDir);
		assert.equal(h.dispatches[0].owner.pr, "2142");
		assert.equal(h.dispatches[0].verdict.next, "read_comments_and_fix");
		assert.match(
			h.dispatches[0].verdict.output,
			/comment bot=grok/,
			"the writer needs the waiter's findings, not just the verdict name",
		);
		assert.ok(
			h.notifies.some((n) => /read_comments_and_fix/.test(n)),
			`a toast may still say what happened; got ${h.notifies.join(" | ")}`,
		);
		const state = JSON.parse(readFileSync(waiterState(h.dir), "utf8"));
		assert.equal(state.verdictDelivered, true, "the verdict is spent even though no turn was bought");
		assert.equal(
			h.calls.filter((c) => c.includes("pr-await")).length,
			0,
			"the latch must not re-await; the dispatcher does that after the writer",
		);
	} finally {
		h.cleanup();
	}
});

test("a verdict written only under the repo-qualified waiter name is still dispatched", async () => {
	// The 2026-09-01 ghl-pr-await writes `manual-icemining-2142.json`. Nothing
	// writes the legacy `manual-2142.json`, and the session's own `pi-<id>.json`
	// carries no verdict — so the old single-spelling read saw nothing and the
	// Feature sat on `next=yield` with a fixer owed (F2).
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	const featureDir = writeFeatureStatus(h.dir, { pr: "2142" });
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		writeFileSync(
			join(h.dir, "manual-icemining-2142.json"),
			JSON.stringify({
				pr: "2142",
				lastNext: "read_comments_and_fix",
				verdict: ACTIONABLE_VERDICT,
				verdictDelivered: false,
			}),
		);
		assert.equal(existsSync(join(h.dir, "manual-2142.json")), false, "legacy name must be absent");
		await h.settle();
		await sleep(80);
		assert.equal(h.wakes.length, 0, `got ${h.wakes.join(" | ")}`);
		assert.equal(h.dispatches.length, 1, "the repo-qualified verdict must reach the dispatcher");
		assert.equal(h.dispatches[0].owner.dir, featureDir);
		assert.equal(h.dispatches[0].verdict.next, "read_comments_and_fix");
		const spent = JSON.parse(readFileSync(join(h.dir, "manual-icemining-2142.json"), "utf8"));
		assert.equal(spent.verdictDelivered, true, "an accepted dispatch spends the verdict");
	} finally {
		h.cleanup();
	}
});

test("a refused Feature dispatch leaves the verdict on disk for a later retry", async () => {
	// F4: the verdict used to be marked delivered before dispatch, and dispatch
	// returns `refuse` whenever a fixer already holds the chain lock. The waiter
	// never re-emits, so the finding was lost. A refusal must change nothing.
	const WT = join(homedir(), "Dev", "git", "ice-wt", "feat-refused");
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)), REPO, {
		featureOwnedPr: (pr: string) => ({
			dir: "/tmp/feat-refused",
			statusFile: "/tmp/feat-refused/status.md",
			repo: "icemining",
			name: "feat-refused",
			pr,
			worktree: WT,
		}),
		onFeatureActionable: () => "refuse",
	});
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		// Both waiter spellings: which one the installed binary wrote is not
		// knowable from here, and a refusal must leave every one of them intact.
		for (const name of ["manual-icemining-2142.json", "manual-2142.json"]) {
			writeFileSync(
				join(h.dir, name),
				JSON.stringify({
					pr: "2142",
					lastNext: "read_comments_and_fix",
					verdict: ACTIONABLE_VERDICT,
					verdictDelivered: false,
				}),
			);
		}
		await h.settle();
		await sleep(80);
		for (const name of ["manual-icemining-2142.json", "manual-2142.json"]) {
			const state = JSON.parse(readFileSync(join(h.dir, name), "utf8"));
			assert.equal(
				state.verdictDelivered,
				false,
				`${name} must stay undelivered so the verdict can be retried`,
			);
		}
		assert.equal(h.wakes.length, 0, "a refusal must not turn the parent into the fixer");
	} finally {
		h.cleanup();
	}
});

test("an accepted Feature dispatch spends the verdict so it is not dispatched twice", async () => {
	const WT = join(homedir(), "Dev", "git", "ice-wt", "feat-accepted");
	let calls = 0;
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)), REPO, {
		watchMs: 20,
		featureOwnedPr: (pr: string) => ({
			dir: "/tmp/feat-accepted",
			statusFile: "/tmp/feat-accepted/status.md",
			repo: "icemining",
			name: "feat-accepted",
			pr,
			worktree: WT,
		}),
		onFeatureActionable: () => {
			calls += 1;
			return "spawn_writer";
		},
	});
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		writeActionable(h.dir, h.sessionId);
		await h.settle();
		await sleep(120);
		assert.equal(calls, 1, `an accepted verdict dispatches once; got ${calls}`);
		const state = JSON.parse(readFileSync(waiterState(h.dir), "utf8"));
		assert.equal(state.verdictDelivered, true);
	} finally {
		h.cleanup();
	}
});

test("a Feature-owned PR does not get a second waiter on settle", async () => {
	// Three spawners raced here (F3): the handshake, this settle, and ghl-monitor.
	// The reconciler owns Feature waiters now, so settle must not fork one.
	const WT = join(homedir(), "Dev", "git", "ice-wt", "feat-owned");
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)), REPO, {
		featureOwnedPr: (pr: string) => ({
			dir: "/tmp/feat-owned",
			statusFile: "/tmp/feat-owned/status.md",
			repo: "icemining",
			name: "feat-owned",
			pr,
			worktree: WT,
		}),
	});
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		await h.settle();
		await sleep(60);
		assert.equal(
			h.spawns.length,
			0,
			`a Feature waiter is the reconciler's job; got ${JSON.stringify(h.spawns)}`,
		);
		// The session still watches and still drains a pending verdict.
		assert.ok(
			h.notifies.some((n) => /2142/.test(n)),
			`the session must still report the PR; got ${h.notifies.join(" | ")}`,
		);
	} finally {
		h.cleanup();
	}
});

test("a solo PR still gets its waiter ensured on settle", async () => {
	// The no-spawn rule above is scoped to Feature-owned PRs. A plain session has
	// no reconciler behind it, so removing its waiter would strand the PR.
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		await h.settle();
		await sleep(60);
		assert.equal(h.spawns.length, 1, "solo latches still ensure a detached waiter");
		assert.ok(h.spawns[0].includes("--daemon"));
	} finally {
		h.cleanup();
	}
});

test("a live waiter under the repo-qualified pid stops a duplicate spawn", async () => {
	// `isDriverRunning` defaults to the real pid probe here, so this is the
	// production path: a pid file only the new binary writes must be believed.
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)), REPO, {
		driverRunning: undefined,
	});
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		writeFileSync(join(h.dir, "drive-icemining-2142.pid"), String(process.pid));
		await h.settle();
		await sleep(60);
		assert.equal(
			h.spawns.length,
			0,
			`a live repo-qualified waiter must suppress the spawn; got ${JSON.stringify(h.spawns)}`,
		);
	} finally {
		h.cleanup();
	}
});

test("the featureOwnedPr hook decides ownership, so no test walks the orchestrator", async () => {
	const WT = join(homedir(), "Dev", "git", "ice-wt", "feat-hooked");
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)), REPO, {
		featureOwnedPr: (pr: string) => ({
			dir: "/tmp/feat-hooked",
			statusFile: "/tmp/feat-hooked/status.md",
			repo: "icemining",
			name: "feat-hooked",
			pr,
			worktree: WT,
		}),
	});
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		writeActionable(h.dir, h.sessionId);
		await h.settle();
		await sleep(80);
		assert.equal(h.wakes.length, 0, `got ${h.wakes.join(" | ")}`);
		assert.equal(h.dispatches.length, 1);
		assert.equal(h.dispatches[0].owner.name, "feat-hooked");
		assert.equal(h.dispatches[0].owner.worktree, WT);
	} finally {
		h.cleanup();
	}
});

test("a Feature with no worktree recorded is reported, not handed to the parent", async () => {
	// The Feature owns the PR, so waking is still forbidden — but there is nowhere
	// to run a writer, and launching one with an empty cwd is worse than saying so.
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	writeFeatureStatus(h.dir, { pr: "2142", worktree: null });
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		writeActionable(h.dir, h.sessionId);
		await h.settle();
		await sleep(80);
		assert.equal(h.wakes.length, 0, `got ${h.wakes.join(" | ")}`);
		assert.equal(h.dispatches.length, 0, "a writer must not launch without a worktree");
		assert.ok(
			h.notifies.some((n) => /worktree/i.test(n)),
			`the stall must be visible; got ${h.notifies.join(" | ")}`,
		);
	} finally {
		h.cleanup();
	}
});

test("a Feature in another repo, or on another PR, does not swallow the solo wake", async () => {
	// Ownership is `pr:` AND `repo:`. Anything looser would mute the wake a plain
	// session depends on, using a Feature that has nothing to do with this PR.
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	writeFeatureStatus(h.dir, { repo: "icemining-devops", name: "feat-devops", pr: "2142" });
	writeFeatureStatus(h.dir, { repo: "icemining", name: "feat-other", pr: "9999" });
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		writeActionable(h.dir, h.sessionId);
		await h.settle();
		await sleep(80);
		assert.equal(h.dispatches.length, 0, "neither Feature owns icemining#2142");
		assert.equal(h.wakes.length, 1, `the solo wake must survive; got ${h.wakes.join(" | ")}`);
		assert.match(h.wakes[0], /Fix current-head findings/);
		assert.match(h.wakes[0], /Do not wait for another user message/);
	} finally {
		h.cleanup();
	}
});

test("an already-delivered ACTIONABLE dispatches nothing for a Feature PR either", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	writeFeatureStatus(h.dir, { pr: "2142" });
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		writeActionable(h.dir, h.sessionId, { verdictDelivered: true });
		await h.settle();
		await sleep(80);
		assert.equal(h.wakes.length, 0);
		assert.equal(h.dispatches.length, 0, "a spent verdict must not buy a second writer");
	} finally {
		h.cleanup();
	}
});

test("a later Feature ACTIONABLE with a new round dispatches a second fixer", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)), REPO, { watchMs: 20 });
	writeFeatureStatus(h.dir, { pr: "2142" });
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		writeActionable(h.dir, h.sessionId, { round: "1" });
		await h.settle();
		await sleep(80);
		assert.equal(h.wakes.length, 0);
		assert.equal(h.dispatches.length, 1, "first round dispatches once");
		writeActionable(h.dir, h.sessionId, {
			verdictDelivered: false,
			round: "2",
			verdict: `${ACTIONABLE_VERDICT}\nsecond-round finding`,
		});
		await sleep(80);
		assert.equal(h.wakes.length, 0, "the parent stays idle on later rounds too");
		assert.equal(
			h.dispatches.length,
			2,
			"a new review round must dispatch another fixer, not stop after one",
		);
		assert.equal(h.dispatches[1].verdict.next, "read_comments_and_fix");
		assert.match(h.dispatches[1].verdict.output, /second-round finding/);
	} finally {
		h.cleanup();
	}
});

test("a merged Feature PR still announces the merge and dispatches next=done, not a fix", async () => {
	const h = harness((cmd) => (cmd === "gh" ? MERGED : ok(REAL_OUTPUT)));
	writeFeatureStatus(h.dir, { pr: "2142" });
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		writeActionable(h.dir, h.sessionId);
		await h.settle();
		await sleep(80);
		assert.equal(h.wakes.length, 1);
		assert.match(h.wakes[0], /#2142 merged/);
		assert.doesNotMatch(h.wakes[0], /read_comments_and_fix/);
		assert.equal(h.dispatches.length, 1, "merge must land the Feature so yield does not stick");
		assert.equal(h.dispatches[0].verdict.next, "done", "a merged PR has no findings left to fix");
	} finally {
		h.cleanup();
	}
});

test("wait elapsed compact form", () => {
	const t0 = 1_000_000;
	assert.equal(formatWaitElapsed(t0, t0 + 4_000), "4s");
	assert.equal(formatWaitElapsed(t0, t0 + 180_000), "3m");
	assert.equal(formatWaitElapsed(t0, t0 + 3_600_000), "1h");
	assert.equal(formatWaitElapsed(t0, t0 + 3_900_000), "1h 5m");
});

test("wait chrome includes review round when known", () => {
	assert.equal(
		formatWaitLine({ label: "moofone/icemining#2178", elapsed: "2m" }),
		"waiting moofone/icemining#2178 · 2m",
	);
	assert.equal(
		formatWaitLine({ label: "moofone/icemining#2178", elapsed: "2m", round: "3" }),
		"waiting moofone/icemining#2178 · r3 · 2m",
	);
	assert.equal(
		formatWaitLine({
			label: "moofone/icemining#2178",
			elapsed: "2m",
			round: "3",
			roundTotal: "3",
		}),
		"waiting moofone/icemining#2178 · r3/3 · 2m",
	);
	assert.equal(
		formatWaitLine({
			label: "moofone/icemining#2178",
			elapsed: "2m",
			round: "2",
			roundTotal: "5",
		}),
		"waiting moofone/icemining#2178 · r2/5 · 2m",
	);
	const url = "https://github.com/moofone/icemining-devops/pull/485";
	const linked = formatWaitLine({
		label: "icemining-devops#485",
		elapsed: "11m",
		round: "3",
		url,
	});
	assert.equal(linked, `waiting ${osc8Link(url, "icemining-devops#485")} · r3 · 11m`);
	assert.match(linked, /\x1b\]8;;https:\/\/github.com\/moofone\/icemining-devops\/pull\/485/);
	assert.equal(prUrl({ pr: "485", slug: "moofone/icemining-devops" }), url);
	assert.equal(prUrl({ pr: "485", url }), url);
	assert.equal(prLinkLabel({ pr: "485", slug: "moofone/icemining-devops" }), osc8Link(url, "moofone/icemining-devops#485"));
	assert.equal(prLinkLabel({ pr: "485" }), "PR #485", "no slug/url/cwd → plain label, no OSC 8");

	const git = mkdtempSync(join(tmpdir(), "ghl-origin-"));
	mkdirSync(join(git, ".git"));
	writeFileSync(
		join(git, ".git", "config"),
		`[remote "origin"]\n\turl = git@github.com:moofone/icemining-devops.git\n`,
	);
	assert.equal(originSlug(git), "moofone/icemining-devops");
	assert.equal(prUrl({ pr: "485", cwd: git }), url);
	rmSync(git, { recursive: true, force: true });
});

test("wait chrome is a Loader factory, not a frozen braille string", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)), REPO, { watchMs: 20 });
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		await h.settle();
		await sleep(40);
		const last = h.widgets.at(-1);
		assert.equal(
			typeof last,
			"function",
			"widget must be a TUI factory so pi's Loader can tick at 80ms",
		);
		assert.equal(Array.isArray(last), false, "a frozen string array cannot animate");
	} finally {
		h.cleanup();
	}
});

test("iTerm wait progress is a one-shot OSC, not a timer", () => {
	assert.equal(waitProgressSequence(true, "xterm-256color"), "\x1b]9;4;3\x07");
	assert.equal(waitProgressSequence(false, "xterm-256color"), "\x1b]9;4;0\x07");
	assert.match(waitProgressSequence(true, "tmux-256color"), /Ptmux/);
});

const YIELD_OUTPUT = ["status=handed_off", "next=yield", "pr=2142", ""].join("\n");

test("readLiveRound ignores verdict-embedded round from the previous cycle", () => {
	const dir = mkdtempSync(join(tmpdir(), "ghl-live-round-"));
	const path = join(dir, "state.json");
	writeFileSync(
		path,
		JSON.stringify({
			pr: "485",
			lastNext: "read_comments_and_fix",
			verdict: "next=read_comments_and_fix\nround=3\nround_total=3",
			verdictDelivered: true,
		}),
	);
	assert.equal(
		readLiveRound(path)?.round,
		undefined,
		"top-level round is absent: chrome must not parse the old verdict",
	);
	writeFileSync(
		path,
		JSON.stringify({
			pr: "485",
			lastNext: "read_comments_and_fix",
			verdict: "round=3\nround_total=3",
			round: "1",
			roundTotal: "3",
		}),
	);
	assert.deepEqual(readLiveRound(path), { round: "1", roundTotal: "3" });
	rmSync(dir, { recursive: true, force: true });
});

test("yield handoff drops the previous cycle's r3 so chrome is not stuck", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(YIELD_OUTPUT)), REPO, {
		watchMs: 20,
		chromeMs: 20,
	});
	try {
		await h.start();
		writeFileSync(
			waiterState(h.dir),
			JSON.stringify({
				pr: "2142",
				cwd: REPO,
				lastNext: "read_comments_and_fix",
				verdict: "round=3\nround_total=3",
				round: "3",
				roundTotal: "3",
			}),
		);
		writeFileSync(
			join(h.dir, "manual-2142.json"),
			JSON.stringify({
				pr: "2142",
				lastNext: "read_comments_and_fix",
				verdict: "round=3\nround_total=3",
				round: "3",
				roundTotal: "3",
			}),
		);
		await h.bash(`cd ${REPO} && git pr-await 2142`, YIELD_OUTPUT);
		await h.settle();
		await sleep(50);
		const shown = h.titles.filter(Boolean).join(" | ");
		assert.doesNotMatch(
			shown,
			/\br3\b/,
			`stale r3 must not survive a new wait: ${shown}`,
		);
	} finally {
		h.cleanup();
	}
});

test("wait chrome picks up live round= from the waiter JSON", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(YIELD_OUTPUT)), REPO, {
		watchMs: 20,
		chromeMs: 20,
	});
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, YIELD_OUTPUT);
		await h.settle();
		// The waiter's file is seeded at spawn, inside the settle handoff, which
		// is not awaited: give it the tick it needs before reading it back.
		await sleep(50);
		const statePath = waiterState(h.dir);
		const cur = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		writeFileSync(statePath, JSON.stringify({ ...cur, round: "1", roundTotal: "3" }));
		await sleep(50);
		const shown = h.titles.filter(Boolean).join(" | ");
		assert.match(shown, /r1\/3/, `chrome must show live progress: ${shown}`);
	} finally {
		h.cleanup();
	}
});

/* ---------------------------------------------------------------- *
 * Phase 5 — file ownership (F20).
 *
 * One writer per file. `pi-<id>.latch.json` is the extension's; `manual-*.json`
 * and `drive-*` are the waiter's. They used to share `pi-<id>.json`: TS seeded
 * it with the session latch and handed the same path to `ghl-pr-await` as
 * `--state`, which rewrote it wholesale. A waiter rewrite then read back as an
 * ownerless session latch, which is how a PR #11 verdict overwrote a #18 latch
 * and how sessions adopted PRs they had never heard of.
 * ---------------------------------------------------------------- */

test("P5 F20: the file name says who writes it", () => {
	assert.equal(isExtensionOwnedStateFile("/s/pi-abc.latch.json"), true);
	assert.equal(isExtensionOwnedStateFile("pi-abc.latch.json"), true);
	assert.equal(isExtensionOwnedStateFile("/s/pi-abc.json"), false, "the shared file was never ours");
	assert.equal(isExtensionOwnedStateFile("/s/manual-icemining-2142.json"), false);
	assert.equal(isExtensionOwnedStateFile("/s/drive-2142.pid"), false);
});

test("P5 F20: the waiter is handed a file of its own, and this session writes only its latch", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		await h.settle();
		await sleep(80);

		const state = h.spawns[0]?.[h.spawns[0].indexOf("--state") + 1] ?? "";
		assert.match(
			state,
			/\/manual-[^/]*2142\.json$/,
			`--state must be a waiter file, got ${state}`,
		);

		// The shared file is gone entirely — not merely unused.
		assert.equal(
			existsSync(join(h.dir, `pi-${h.sessionId}.json`)),
			false,
			"nothing writes pi-<id>.json any more",
		);
		assert.ok(existsSync(join(h.dir, `pi-${h.sessionId}.latch.json`)));
	} finally {
		h.cleanup();
	}
});

test("P5 F20: the waiter's seed carries {pr, cwd} and none of the session's identity", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		await h.settle();
		await sleep(80);
		const seed = JSON.parse(readFileSync(waiterState(h.dir), "utf8"));
		assert.deepEqual(
			Object.keys(seed).sort(),
			["cwd", "pr"],
			`the seed is the bootstrap ghl-pr-await writes for itself, nothing more: ${JSON.stringify(seed)}`,
		);
		// The latch keeps every one of those fields — in its own file.
		const own = JSON.parse(readFileSync(join(h.dir, `pi-${h.sessionId}.latch.json`), "utf8"));
		assert.equal(own.pid, process.pid);
		assert.equal(own.sessionId, h.sessionId);
		assert.equal(own.origin, "observed");
	} finally {
		h.cleanup();
	}
});

test("P5 F20: seeding never overwrites a waiter file that already holds this PR's verdict", () => {
	const dir = mkdtempSync(join(tmpdir(), "ghl-seed-"));
	try {
		const path = waiterStatePath("icemining", "2142", dir);
		writeFileSync(
			path,
			JSON.stringify({
				pr: "2142",
				cwd: REPO,
				lastNext: "read_comments_and_fix",
				verdictDelivered: false,
			}),
		);
		seedWaiterState(path, { pr: "2142", cwd: REPO });
		const after = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(
			after.lastNext,
			"read_comments_and_fix",
			"re-seeding over an undelivered verdict is how a finding vanished (F4)",
		);

		// A file naming a different PR is stale bookkeeping, not a verdict.
		seedWaiterState(path, { pr: "2199", cwd: REPO });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { pr: "2199", cwd: REPO });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("P5 F20: a waiter rewrite is not a latch, even after a reload under the same id", async () => {
	const h = harness((cmd) => (cmd === "gh" ? OPEN : ok(REAL_OUTPUT)));
	try {
		await h.start();
		await h.bash(`cd ${REPO} && git pr-await 2142`, REAL_OUTPUT);
		await h.settle();
		await sleep(80);
		// The waiter owns this file and rewrites it wholesale. Before F20 the
		// extension read it back on the next session_start, so whatever the
		// waiter last wrote became the session's latch.
		writeFileSync(
			waiterState(h.dir),
			JSON.stringify({ pr: "18", cwd: REPO, lastNext: "read_comments_and_fix" }),
		);
		await h.start();
		await sleep(80);
		const own = JSON.parse(readFileSync(join(h.dir, `pi-${h.sessionId}.latch.json`), "utf8"));
		assert.equal(own.pr, "2142", "the latch is this session's record, not the waiter's");
	} finally {
		h.cleanup();
	}
});

test("P5 F20: nothing in the extension writes a waiter pid file", async () => {
	const core: Record<string, unknown> = await import("../src/lib/pr-await-core.ts");
	for (const name of ["writePid", "clearPid"]) {
		assert.equal(
			name in core,
			false,
			`${name} wrote drive-<pr>.pid, which is the waiter's to write`,
		);
	}
});
