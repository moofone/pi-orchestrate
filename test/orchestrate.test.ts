/**
 * QA regression tests for orchestrate.ts.
 *
 * Run: npm test  (or: node --experimental-strip-types --test test/orchestrate.test.ts)
 *
 * Kept in test/ rather than beside orchestrate.ts so the package entry
 * remains the extension. Source lives in src/.
 *
 * Each test states a required behaviour as a positive assertion. They were
 * written red — against the code as found — so a pass proves the gap closed
 * rather than proving the test was shaped around the implementation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as orch from "../src/orchestrate.ts";
import { registerLatchArm } from "../src/lib/pr-await-core.ts";

const ORCH_SRC = join(dirname(fileURLToPath(import.meta.url)), "../src/orchestrate.ts");

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

/**
 * Minimal ExtensionAPI stand-in: an event bus, a scriptable `exec`, and a
 * record of every parent turn the extension tried to send.
 *
 * `sentUserMessages` is what proves the parent was left idle: a Feature review
 * verdict that reaches the session as a message is a request for the parent to
 * implement, whatever the message says.
 */
function makeFakePi(exec?: (cmd: string, args: string[]) => Promise<unknown>) {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const sentUserMessages: { text: string; options?: unknown }[] = [];
  return {
    events: {
      on(name: string, fn: (data: unknown) => void) {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(fn);
        return () => handlers.get(name)?.delete(fn);
      },
      emit(name: string, data: unknown) {
        for (const fn of [...(handlers.get(name) ?? [])]) fn(data);
      },
    },
    exec: exec ?? (async () => ({ code: 0, stdout: "", stderr: "" })),
    sendUserMessage(text: string, options?: unknown) {
      sentUserMessages.push({ text: String(text ?? ""), options });
    },
    sentUserMessages,
  } as never;
}

/** Every parent turn the extension sent through the fake `pi`. */
function parentTurns(pi: ReturnType<typeof makeFakePi>): { text: string }[] {
  return (pi as never as { sentUserMessages: { text: string }[] }).sentUserMessages;
}

function makeFakeCtx() {
  const notices: string[] = [];
  return {
    ctx: { ui: { notify: (m: string) => void notices.push(m) }, isIdle: () => true } as never,
    notices,
  };
}

/** Capture the requestId of the spawn RPC so the reply can be timed by hand. */
function captureSpawn(pi: ReturnType<typeof makeFakePi>) {
  const seen: { requestId: string; params: Record<string, unknown> } = {
    requestId: "",
    params: {},
  };
  (pi as never as { events: { on: Function } }).events.on(
    RPC_REQUEST_EVENT,
    (req: { requestId?: string; params?: Record<string, unknown> }) => {
      if (!seen.requestId) {
        seen.requestId = req?.requestId ?? "";
        seen.params = req?.params ?? {};
      }
    },
  );
  return seen;
}

/** Fail fast instead of waiting out the 4h watchdog when a promise stalls. */
function withDeadline<T>(p: Promise<T>, ms = 500): Promise<T | { reason: string }> {
  return Promise.race([
    p,
    new Promise<{ reason: string }>((r) => {
      const t = setTimeout(() => r({ reason: "TEST_TIMEOUT" }), ms);
      t.unref?.();
    }),
  ]);
}

/* ---------------------------------------------------------------- *
 * H1 — a stop must be recognised however pi-subagents reports it
 * ---------------------------------------------------------------- */

test("H1: isStoppedCompletion accepts every shape pi-subagents uses for a stop", () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).isStoppedCompletion,
    "function",
    "isStoppedCompletion must be exported so stop-detection is testable",
  );
  const isStopped = (orch as never as { isStoppedCompletion: (n: unknown) => boolean })
    .isStoppedCompletion;

  // notify.ts:265-270 derives "stopped" from any of these four signals.
  assert.equal(isStopped({ stopped: true }), true, "top-level stopped flag");
  assert.equal(isStopped({ state: "stopped" }), true, "state === 'stopped'");
  assert.equal(isStopped({ results: [{ stopped: true }] }), true, "child stopped flag");
  assert.equal(isStopped({ results: [{ status: "stopped" }] }), true, "child status");

  // A plain failure is not a stop: it must still block the Task.
  assert.equal(isStopped({ success: false, state: "failed" }), false, "plain failure");
  assert.equal(isStopped({ success: true }), false, "success");
  assert.equal(isStopped({ timedOut: true }), false, "a timeout is not a user stop");
  assert.equal(isStopped(undefined), false, "missing payload");
});

test("H1: runChild reports stopped when the completion only carries state:'stopped'", async () => {
  const pi = makeFakePi();
  const spawn = captureSpawn(pi);
  const p = (orch as never as { runChild: Function }).runChild(pi, { timeoutMs: 60_000 });

  pi.events.emit(`${RPC_REPLY_PREFIX}${spawn.requestId}`, {
    success: true,
    data: { details: { runId: "run-h1" } },
  });
  pi.events.emit(ASYNC_COMPLETE_EVENT, {
    runId: "run-h1",
    success: false,
    state: "stopped",
  });

  const outcome = (await withDeadline(p)) as { stopped?: boolean; ok?: boolean; reason?: string };
  assert.notEqual(outcome.reason, "TEST_TIMEOUT", "runChild never settled");
  assert.equal(outcome.ok, false, "a stopped child did not pass");
  assert.equal(
    outcome.stopped,
    true,
    "state:'stopped' must set outcome.stopped, else the chain marks the Task blocked and resume refuses forever",
  );
});

/* ---------------------------------------------------------------- *
 * M2 — a completion that beats the spawn reply must not be dropped
 * ---------------------------------------------------------------- */

test("M2: runChild settles when the completion arrives before the spawn reply", async () => {
  const pi = makeFakePi();
  const spawn = captureSpawn(pi);
  const p = (orch as never as { runChild: Function }).runChild(pi, { timeoutMs: 60_000 });

  // The child finishes first; the reply that names its runId lands after.
  pi.events.emit(ASYNC_COMPLETE_EVENT, { runId: "run-m2", success: true });
  pi.events.emit(`${RPC_REPLY_PREFIX}${spawn.requestId}`, {
    success: true,
    data: { details: { runId: "run-m2" } },
  });

  const outcome = (await withDeadline(p)) as { ok?: boolean; reason?: string };
  assert.notEqual(
    outcome.reason,
    "TEST_TIMEOUT",
    "an early completion was dropped; the chain would stall until the 4h05m watchdog",
  );
  assert.equal(outcome.ok, true, "the child succeeded");
});

test("M2: an unrelated early completion is still ignored", async () => {
  const pi = makeFakePi();
  const spawn = captureSpawn(pi);
  const p = (orch as never as { runChild: Function }).runChild(pi, { timeoutMs: 60_000 });

  pi.events.emit(ASYNC_COMPLETE_EVENT, { runId: "somebody-elses-run", success: true });
  pi.events.emit(`${RPC_REPLY_PREFIX}${spawn.requestId}`, {
    success: true,
    data: { details: { runId: "run-mine" } },
  });

  const outcome = (await withDeadline(p, 200)) as { reason?: string };
  assert.equal(
    outcome.reason,
    "TEST_TIMEOUT",
    "buffering must match on runId, not settle on the first event seen",
  );
});

/* ---------------------------------------------------------------- *
 * H2 — the chain lock must be taken before any state is mutated
 * ---------------------------------------------------------------- */

test("H2: withChainLock refuses a second entrant without running its body", async () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).withChainLock,
    "function",
    "withChainLock must be exported so the guard is testable",
  );
  const withChainLock = (
    orch as never as {
      withChainLock: (k: string, fn: () => Promise<unknown>) => Promise<boolean>;
    }
  ).withChainLock;

  let ran = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });

  const first = withChainLock("/feature/a", async () => {
    ran += 1;
    await held;
  });
  const second = await withChainLock("/feature/a", async () => {
    ran += 1;
  });

  assert.equal(second, false, "the second entrant must be refused");
  assert.equal(ran, 1, "the refused entrant must not run its body — no plan.md mutation");

  release();
  assert.equal(await first, true, "the first entrant ran to completion");

  const third = await withChainLock("/feature/a", async () => {
    ran += 1;
  });
  assert.equal(third, true, "the lock is released once the chain ends");
  assert.equal(ran, 2);
});

test("H2: withChainLock releases the lock when the body throws", async () => {
  const withChainLock = (
    orch as never as {
      withChainLock: (k: string, fn: () => Promise<unknown>) => Promise<boolean>;
    }
  ).withChainLock;

  await assert.rejects(
    withChainLock("/feature/b", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  let ran = 0;
  const after = await withChainLock("/feature/b", async () => {
    ran += 1;
  });
  assert.equal(after, true, "a thrown chain must not wedge the Feature permanently");
  assert.equal(ran, 1);
});

/* ---------------------------------------------------------------- *
 * L1/L2 — gate extraction
 * ---------------------------------------------------------------- */

test("L1: an env-prefixed command is still a runnable gate", () => {
  assert.equal(
    orch.taskGateCommand("- Command: `RUST_MIN_STACK=16M cargo test -p auth --lib nick`"),
    "RUST_MIN_STACK=16M cargo test -p auth --lib nick",
    "VAR=value prefixes are ordinary in this repo and must not downgrade the gate",
  );
  assert.equal(
    orch.taskGateCommand("- Command: `A=1 B=2 rtk cargo test -p x`"),
    "A=1 B=2 rtk cargo test -p x",
    "multiple env assignments",
  );
});

test("L1: plain commands and paths keep working", () => {
  assert.equal(
    orch.taskGateCommand("- Command: `rtk cargo test -p crate --lib the_test`"),
    "rtk cargo test -p crate --lib the_test",
  );
  assert.equal(
    orch.taskGateCommand("- Command: `./scripts/check.sh --all`"),
    "./scripts/check.sh --all",
  );
  const block = [
    "- Command:",
    "```",
    "cd /Users/greg/Dev/git/ice-devops-flagfix && rtk node --test scripts/check-build-release-on-ops-contract.test.mjs",
    "```",
  ].join("\n");
  assert.match(
    orch.taskGateCommand(block),
    /^cd \/Users\/greg\/Dev\/git\/ice-devops-flagfix && rtk node --test /,
    "a following fenced Command is the host gate, not a findings report",
  );
});

test("L2: prose is still refused — loosening L1 must not admit sentences", () => {
  // These are the real planner outputs the gate filter exists to reject.
  assert.equal(orch.taskGateCommand("- Command: red public curls first. Then: `curl -s x`"), "");
  assert.equal(orch.taskGateCommand("- Command: `standalone gtest PearlGpuHotPath.* …`"), "");
  assert.equal(orch.taskGateCommand("- Command: `(none)`"), "");
  assert.equal(orch.taskGateCommand("- Command: pending"), "");
  assert.equal(orch.taskGateCommand("- Command: `a` and `b`"), "");
  assert.equal(orch.taskGateCommand("- Command: `**bold** thing`"), "");
  assert.equal(
    orch.taskGateCommand("- Command: Run the suite, then check the output"),
    "",
    "an unfenced sentence is never a command",
  );
});

/* ---------------------------------------------------------------- *
 * V1 — an objective that opens with a verb word is still an objective
 * ---------------------------------------------------------------- */

function isManagement(head: string, rest: string, liveNames: string[]): boolean {
  assert.equal(
    typeof (orch as Record<string, unknown>).isManagementInvocation,
    "function",
    "isManagementInvocation must be exported so verb-vs-objective parsing is testable",
  );
  return (
    orch as never as {
      isManagementInvocation: (h: string, r: string, n: string[]) => boolean;
    }
  ).isManagementInvocation(head, rest, liveNames);
}

test("V1: a free-form objective opening with a verb plans a Feature when none are live", () => {
  // The reported bug: `/orchestrate implement <what I want>` answered
  // "Which Feature to implement? Live: (none)" instead of planning.
  assert.equal(
    isManagement("implement", "per-shard rate limiting on the submit path", []),
    false,
    "with no live Feature there is nothing to select, so the line is an objective",
  );
  assert.equal(isManagement("tdd", "a bounded retry ceiling for mark_attempt_failed", []), false);
  assert.equal(isManagement("review", "the auth middleware for stale sessions", []), false);
  assert.equal(isManagement("qa", "the payout reserve check end to end", []), false);
});

test("V1: a free-form objective is an objective even while a Feature is live", () => {
  const live = ["nickname-uniqueness"];
  assert.equal(
    isManagement("implement", "per-shard rate limiting on the submit path", live),
    false,
    "a multi-word line whose first token names no live Feature is English, not a selector",
  );
  assert.equal(isManagement("review", "the auth middleware for stale sessions", live), false);
});

test("V1: real management invocations keep working", () => {
  const live = ["nickname-uniqueness", "pending-20260823T140000Z"];

  assert.equal(isManagement("pause", "", []), true, "a bare verb is always the subcommand");
  assert.equal(isManagement("resume", "", live), true);
  assert.equal(isManagement("approve", "nickname-uniqueness", live), true, "exact name");
  assert.equal(isManagement("qa", "nick", live), true, "matchFeature's substring form");
  assert.equal(isManagement("implement", "nickname-uniqueness 3", live), true, "feature + Task");
  assert.equal(isManagement("implement", "all", live), true, "bare Task selector");
  assert.equal(isManagement("pause", "now nickname-uniqueness", live), true, "`now` modifier");
  assert.equal(isManagement("pause", "nickname-uniqueness now", live), true);
  assert.equal(
    isManagement("approve", "my-feture", live),
    true,
    "a mistyped name must still report 'No Feature matching', not silently seed a new Feature",
  );
});

test("V2: `plan <objective>` is an explicit opener and drops its own token", () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).objectiveFrom,
    "function",
    "objectiveFrom must be exported so the explicit opener is testable",
  );
  const objectiveFrom = (
    orch as never as { objectiveFrom: (h: string, r: string, raw: string) => string }
  ).objectiveFrom;

  assert.equal(
    objectiveFrom("plan", "implement per-shard rate limiting", "plan implement per-shard rate limiting"),
    "implement per-shard rate limiting",
    "`plan` is the opener, not part of the objective",
  );
  assert.equal(objectiveFrom("new", "add a health endpoint", "new add a health endpoint"), "add a health endpoint");
  assert.equal(
    objectiveFrom("implement", "per-shard rate limiting", "implement per-shard rate limiting"),
    "implement per-shard rate limiting",
    "without an explicit opener the whole line is the objective, verb word included",
  );
  assert.equal(objectiveFrom("plan", "", "plan"), "", "a bare opener carries no objective");
  assert.equal(
    isManagement("plan", "implement rate limiting", ["nickname-uniqueness"]),
    false,
    "`plan` is never a management verb, even with Features live",
  );
});

test("V1: non-verbs are never management", () => {
  assert.equal(isManagement("add", "a health endpoint", ["x"]), false);
  assert.equal(isManagement("fix", "the vardiff pin", []), false);
});

/* ---------------------------------------------------------------- *
 * V3 — /orchestrate approve <name> must never seed a new Feature
 * ---------------------------------------------------------------- */

test("V3: approve <slug> is management even when this repo has no live Features", () => {
  // The reported bug: cwd ~/Dev/git is not a repo, liveNames is empty, and
  // `/orchestrate approve pi-loopback-serve` seeded
  // ~/orchestrator/git/pending-* with objective "approve pi-loopback-serve".
  assert.equal(
    isManagement("approve", "pi-loopback-serve", []),
    true,
    "must not seed a new Feature from /orchestrate approve <name>",
  );
  assert.equal(isManagement("resume", "pi-loopback-serve", []), true);
  assert.equal(isManagement("pause", "pi-loopback-serve", []), true);
  assert.equal(isManagement("archive", "pi-loopback-serve", []), true);
  assert.equal(isManagement("pr", "pi-loopback-serve", []), true);
});

test("V3: a one-token selector is management even with nothing live", () => {
  assert.equal(
    isManagement("implement", "pi-loopback-serve", []),
    true,
    "one token is a Feature name or a typo — report 'No Feature matching', do not plan",
  );
  assert.equal(isManagement("qa", "pi-loopback-serve", []), true);
  assert.equal(isManagement("review", "pi-loopback-serve", []), true);
});

test("V3: multi-word implement with nothing live is still an objective", () => {
  assert.equal(
    isManagement("implement", "per-shard rate limiting on the submit path", []),
    false,
  );
});

test("approve typo failure vs failover binds the unique live Feature", () => {
  assert.equal(typeof orch.matchFeature, "function");
  const rows = [
    {
      name: "stratum-replica-failover-matrix",
      dir: "/tmp/stratum-replica-failover-matrix",
      live: true,
      archived: false,
      plan: "",
      status: "",
    },
    {
      name: "venue-contract-healing",
      dir: "/tmp/venue-contract-healing",
      live: true,
      archived: false,
      plan: "",
      status: "",
    },
  ];
  assert.equal(
    orch.matchFeature(rows, "stratum-replica-failure-matrix")?.name,
    "stratum-replica-failover-matrix",
  );
  assert.equal(
    orch.matchFeature(rows, "stratum-replica-failover-matrix")?.name,
    "stratum-replica-failover-matrix",
  );
  assert.equal(orch.matchFeature(rows, "no-such-feature-at-all"), undefined);
});

test("near-miss does not bind when two live Features are equally close", () => {
  const rows = [
    {
      name: "auth-session-fix",
      dir: "/tmp/auth-session-fix",
      live: true,
      archived: false,
      plan: "",
      status: "",
    },
    {
      name: "auth-session-fax",
      dir: "/tmp/auth-session-fax",
      live: true,
      archived: false,
      plan: "",
      status: "",
    },
  ];
  assert.equal(orch.matchFeature(rows, "auth-session-fox"), undefined);
});

function livePlanRow(
  name: string,
  title: string,
  extras: { dir?: string; plan?: string; status?: string } = {},
) {
  return {
    name,
    dir: extras.dir ?? `/tmp/${name}`,
    live: true,
    archived: false,
    plan:
      extras.plan ??
      `# Feature: ${title}\n\n> Status: DRAFT — awaiting approval\n> Name: ${name}\n> Branch: feat/${name}\n`,
    status: extras.status ?? `name: ${name}\nphase: planning\nplan_review: none\n`,
  };
}

test("title kebab past NAME_MAX uniquely binds the truncated Feature, not a shorter stub", () => {
  const rows = [
    livePlanRow("quiesce-identical-commits", "Quiesce identical commits"),
    livePlanRow(
      "quiesce-identical-current-state",
      "Quiesce identical current-state commits",
    ),
  ];
  assert.equal(
    orch.matchFeature(rows, "quiesce-identical-current-state-commits")?.name,
    "quiesce-identical-current-state",
    "approve <kebab-of-# Feature: title> must bind the complete plan whose Name was truncated at 36",
  );
  assert.equal(
    orch.matchFeature(rows, "quiesce-identical-commits")?.name,
    "quiesce-identical-commits",
    "the stub still exact-matches its own name",
  );
  assert.equal(
    orch.matchFeature(rows, "quiesce-identical-current-state")?.name,
    "quiesce-identical-current-state",
  );
});

test("extra hyphen suffix on a unique live name binds that Feature", () => {
  const rows = [
    livePlanRow("quiesce-identical-current-state", "Quiesce identical current-state"),
    livePlanRow("venue-contract-healing", "Venue contract healing"),
  ];
  assert.equal(
    orch.matchFeature(rows, "quiesce-identical-current-state-commits")?.name,
    "quiesce-identical-current-state",
    "folder name + extra token is the NAME_MAX truncation leftover, not a miss",
  );
});

test("V4: ~/Dev/git is not a repo named git", () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).repoNameFromGitRoot,
    "function",
    "repoNameFromGitRoot must be exported so REF_ROOT handling is testable",
  );
  const repoNameFromGitRoot = (
    orch as never as { repoNameFromGitRoot: (gitRoot: string) => string | undefined }
  ).repoNameFromGitRoot;
  const refRoot = join(homedir(), "Dev/git");
  assert.equal(
    repoNameFromGitRoot(refRoot),
    undefined,
    "the git farm root must not become orchestrator/git/",
  );
  assert.equal(repoNameFromGitRoot(join(refRoot, "host-ops")), "host-ops");
  assert.equal(repoNameFromGitRoot(join(refRoot, "icemining")), "icemining");
  assert.equal(
    repoNameFromGitRoot(join(refRoot, "ice-wt")),
    undefined,
    "a worktree farm is not a product repo",
  );
});

test("V4: featureRepoFromDir reads orchestrator/<repo>/…", () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).featureRepoFromDir,
    "function",
    "featureRepoFromDir must be exported so cross-repo approve can rebind gitRoot",
  );
  const featureRepoFromDir = (
    orch as never as { featureRepoFromDir: (dir: string) => string | undefined }
  ).featureRepoFromDir;
  assert.equal(
    featureRepoFromDir(join(homedir(), "orchestrator/host-ops/pi-loopback-serve")),
    "host-ops",
  );
  assert.equal(
    featureRepoFromDir(join(homedir(), "orchestrator/git/pending-2026-08-23T23-41-50-183Z")),
    "git",
  );
  assert.equal(featureRepoFromDir(join(homedir(), "Dev/git/host-ops")), undefined);
});

/* ---------------------------------------------------------------- *
 * L3 — pause must interrupt the PR poll
 * ---------------------------------------------------------------- */

test("L3: drivePrAwait stops polling when the Feature is paused", async () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).drivePrAwait,
    "function",
    "drivePrAwait must be exported so the pause path is testable",
  );

  const dir = mkdtempSync(join(tmpdir(), "orch-pr-"));
  const paths = {
    repo: "icemining",
    gitRoot: dir,
    repoDir: dir,
    featureDir: dir,
    planFile: join(dir, "plan.md"),
    statusFile: join(dir, "status.md"),
    handoffsDir: join(dir, "handoffs"),
    archiveDir: join(dir, "archive"),
  };
  writeFileSync(paths.planFile, "# Feature: t\n");
  writeFileSync(
    paths.statusFile,
    ["# Status", "", "pause: after-task", "pr: 123", "pr_round: none", ""].join("\n"),
  );

  let execCalls = 0;
  const pi = makeFakePi(async () => {
    execCalls += 1;
    return { code: 0, stdout: "next=poll_again cursor=abc", stderr: "" };
  });
  const { ctx } = makeFakeCtx();

  const result = (await withDeadline(
    (orch as never as { drivePrAwait: Function }).drivePrAwait(pi, ctx, paths, "123", dir),
    2000,
  )) as { paused?: boolean; done?: boolean; reason?: string };

  assert.notEqual(result.reason, "TEST_TIMEOUT", "drivePrAwait never returned");
  assert.equal(execCalls, 0, "a paused Feature must not poll at all");
  assert.equal(result.paused, true, "the outcome must say it stopped for a pause");
  assert.equal(result.done, false, "a pause is not a landed PR");
});

test("L3: poll_again hands off once — no git loop, no gh poll", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-poll-"));
  const paths = {
    repo: "icemining",
    gitRoot: dir,
    repoDir: dir,
    featureDir: dir,
    planFile: join(dir, "plan.md"),
    statusFile: join(dir, "status.md"),
    handoffsDir: join(dir, "handoffs"),
    archiveDir: join(dir, "archive"),
  };
  writeFileSync(paths.planFile, "# Feature: t\n");
  writeFileSync(paths.statusFile, ["# Status", "", "pause: off", "pr: 123", ""].join("\n"));

  const execs: string[] = [];
  const pi = makeFakePi(async (cmd, args) => {
    execs.push([cmd, ...(args ?? [])].join(" "));
    if (cmd === "git") {
      return { code: 0, stdout: "status=reviewer_active\nnext=poll_again\npr=123\n", stderr: "" };
    }
    return { code: 0, stdout: '{"state":"MERGED","mergedAt":"2026-08-25T16:20:22Z"}', stderr: "" };
  });
  const { ctx } = makeFakeCtx();
  const result = (await withDeadline(
    (orch as never as { drivePrAwait: Function }).drivePrAwait(pi, ctx, paths, "123", dir),
    2000,
  )) as { done?: boolean; silent?: boolean; reason?: string };
  assert.notEqual(result.reason, "TEST_TIMEOUT");
  assert.equal(result.done, false);
  assert.equal(result.silent, true);
  const gitCalls = execs.filter((c) => c.startsWith("git "));
  assert.equal(gitCalls.length, 1, `poll_again must not re-invoke git: ${gitCalls.length}`);
  assert.equal(execs.filter((c) => c.startsWith("gh ")).length, 0, "orchestrator must not poll gh");
});

test("L3: next=yield hands off once and does not re-invoke git pr-await", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-yield-"));
  const paths = {
    repo: "icemining",
    gitRoot: dir,
    repoDir: dir,
    featureDir: dir,
    planFile: join(dir, "plan.md"),
    statusFile: join(dir, "status.md"),
    handoffsDir: join(dir, "handoffs"),
    archiveDir: join(dir, "archive"),
  };
  writeFileSync(paths.planFile, "# Feature: t\n");
  writeFileSync(paths.statusFile, ["# Status", "", "pause: off", "pr: 123", ""].join("\n"));

  const execs: string[] = [];
  const pi = makeFakePi(async (cmd, args) => {
    execs.push([cmd, ...(args ?? [])].join(" "));
    if (cmd === "git") {
      return { code: 0, stdout: "status=handed_off\nnext=yield\npr=123\ninstruction=stop_talking\n", stderr: "" };
    }
    return { code: 0, stdout: '{"state":"MERGED","mergedAt":"2026-08-25T16:20:22Z"}', stderr: "" };
  });
  const { ctx } = makeFakeCtx();
  const result = (await withDeadline(
    (orch as never as { drivePrAwait: Function }).drivePrAwait(pi, ctx, paths, "123", dir),
    2000,
  )) as { done?: boolean; next?: string; silent?: boolean; reason?: string };
  assert.notEqual(result.reason, "TEST_TIMEOUT");
  assert.equal(result.done, false);
  assert.equal(result.next, "yield");
  assert.equal(result.silent, true, "must not hand yield to the session");
  const gitCalls = execs.filter((c) => c.startsWith("git "));
  assert.equal(gitCalls.length, 1, `re-invoking git pr-await after yield is a token/CPU loop: ${gitCalls}`);
  assert.equal(execs.filter((c) => c.startsWith("gh ")).length, 0, "Rust waiter owns merge, not gh pr view");
});

test("L3: next=yield arms an observed latch so merge can wake (pi.exec is not bash absorb)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-arm-"));
  const paths = {
    repo: "icemining",
    gitRoot: dir,
    repoDir: dir,
    featureDir: dir,
    planFile: join(dir, "plan.md"),
    statusFile: join(dir, "status.md"),
    handoffsDir: join(dir, "handoffs"),
    archiveDir: join(dir, "archive"),
  };
  writeFileSync(paths.planFile, "# Feature: t\n");
  writeFileSync(paths.statusFile, ["# Status", "", "pause: off", "pr: 2197", ""].join("\n"));

  const armed: { pr: string; cwd: string; lastNext?: string }[] = [];
  registerLatchArm((_ctx, seed) => {
    armed.push({ pr: seed.pr, cwd: seed.cwd, lastNext: seed.lastNext });
  });
  try {
    const pi = makeFakePi(async (cmd) => {
      if (cmd === "git") {
        return {
          code: 0,
          stdout:
            "status=handed_off\nnext=yield\npr=2197\nurl=https://github.com/moofone/icemining/pull/2197\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const { ctx } = makeFakeCtx();
    const result = (await withDeadline(
      (orch as never as { drivePrAwait: Function }).drivePrAwait(pi, ctx, paths, "2197", dir),
      2000,
    )) as { silent?: boolean; reason?: string };
    assert.notEqual(result.reason, "TEST_TIMEOUT");
    assert.equal(result.silent, true);
    assert.equal(armed.length, 1, "yield handshake must arm the parent latch");
    assert.equal(armed[0]?.pr, "2197");
    assert.equal(armed[0]?.cwd, dir);
    assert.equal(armed[0]?.lastNext, "yield");
  } finally {
    registerLatchArm(undefined);
  }
});

test("L3: normalizePrNumber / parseOpenedPr recover a PR the child opened but did not schema", () => {
  assert.equal(orch.normalizePrNumber("none"), "");
  assert.equal(orch.normalizePrNumber("2210"), "2210");
  assert.equal(orch.normalizePrNumber(2210), "2210");
  assert.equal(
    orch.normalizePrNumber("https://github.com/moofone/icemining/pull/2210"),
    "2210",
  );
  assert.deepEqual(
    orch.parseOpenedPr(
      "PR is up: https://github.com/moofone/icemining/pull/2210\nNext: /orchestrate resume",
    ),
    {
      pr: "2210",
      url: "https://github.com/moofone/icemining/pull/2210",
    },
  );
  assert.deepEqual(orch.parseOpenedPr('{ "opened": false, "pr": "2210" }'), {
    pr: "2210",
  });
  assert.deepEqual(
    orch.resolveOpenedPr({
      structured: { opened: false, pr: "2210" },
      summary: "ignored",
    }),
    { pr: "2210" },
  );
  assert.deepEqual(
    orch.resolveOpenedPr({
      structured: { opened: true },
      summary: "PR 2210 created. I should update status.md?",
    }),
    { pr: "2210" },
  );
  assert.equal(orch.parseOpenedPr("no pull request here"), undefined);
});

test("L3: discoverBranchPr reads gh pr view for the current branch", async () => {
  const pi = makeFakePi(async (cmd, args) => {
    if (cmd === "gh" && args?.[0] === "pr" && args?.[1] === "view") {
      return {
        code: 0,
        stdout: '{"number":2210,"url":"https://github.com/moofone/icemining/pull/2210"}',
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: "no pr" };
  });
  const found = await orch.discoverBranchPr(pi as never, "/tmp/wt");
  assert.deepEqual(found, {
    pr: "2210",
    url: "https://github.com/moofone/icemining/pull/2210",
  });

  const empty = makeFakePi(async () => ({ code: 1, stdout: "", stderr: "no pull requests found" }));
  assert.equal(await orch.discoverBranchPr(empty as never, "/tmp/wt"), undefined);
});

test("L3: landFeaturePr never parks on resume once a PR exists; pr-await is code", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  assert.equal(
    src.includes("open the Feature PR, then /orchestrate resume"),
    false,
    "a created PR must not stop and ask the user to resume",
  );
  const land = src.indexOf("async function landFeaturePr");
  const discover = src.indexOf("discoverBranchPr", land);
  const open = src.indexOf("openFeaturePr", land);
  const awaitPr = src.indexOf("drivePrAwait", land);
  assert.ok(land >= 0 && discover > land, "must look for an existing branch PR");
  assert.ok(open > discover, "open Feature PR in code only after discover misses");
  assert.ok(awaitPr > open, "drivePrAwait runs after a PR number exists");
  assert.equal(
    src.includes("featurePrOpenTask"),
    false,
    "tdd-worker must not be asked to gh pr create; that is the orchestrator's job",
  );
  assert.equal(
    typeof (orch as Record<string, unknown>).featurePrOpenTask,
    "undefined",
    "the PR-open child task is gone; code opens the PR",
  );
});

test("L3: openFeaturePr pushes then gh pr create in code, never a tdd-worker", async () => {
  assert.equal(
    typeof orch.openFeaturePr,
    "function",
    "openFeaturePr must be exported so Feature PR create is testable without a child",
  );
  const calls: { cmd: string; args: string[] }[] = [];
  const pi = makeFakePi(async (cmd, args) => {
    calls.push({ cmd, args: [...(args ?? [])] });
    if (cmd === "git" && args?.[0] === "push") {
      return { code: 0, stdout: "ok", stderr: "" };
    }
    if (cmd === "gh" && args?.[0] === "pr" && args?.[1] === "create") {
      return {
        code: 0,
        stdout: "https://github.com/moofone/icemining/pull/2210\n",
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  });
  const opened = await orch.openFeaturePr(pi as never, "/tmp/wt", {
    title: "Quiesce identical current-state",
    body: "Plan body",
  });
  assert.deepEqual(opened, {
    pr: "2210",
    url: "https://github.com/moofone/icemining/pull/2210",
  });
  const create = calls.find((c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "create");
  assert.ok(create, "must run gh pr create via pi.exec");
  assert.equal(create!.args.includes("--draft"), false, "never a draft");
  assert.equal(create!.args.includes("--title"), true);
  assert.equal(create!.args.includes("--base"), true);
  assert.ok(
    calls.some((c) => c.cmd === "git" && c.args[0] === "push"),
    "must push the branch before create",
  );
  assert.equal(
    parentTurns(pi).length,
    0,
    "opening a Feature PR must not send a parent turn",
  );
});

test("L3: openFeaturePr discovers an existing branch PR when create prints nothing", async () => {
  const pi = makeFakePi(async (cmd, args) => {
    if (cmd === "git" && args?.[0] === "push") {
      return { code: 0, stdout: "ok", stderr: "" };
    }
    if (cmd === "gh" && args?.[0] === "pr" && args?.[1] === "create") {
      return { code: 1, stdout: "", stderr: "already exists" };
    }
    if (cmd === "gh" && args?.[0] === "pr" && args?.[1] === "view") {
      return {
        code: 0,
        stdout: '{"number":2210,"url":"https://github.com/moofone/icemining/pull/2210"}',
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: "no" };
  });
  const opened = await orch.openFeaturePr(pi as never, "/tmp/wt", {
    title: "x",
    body: "x",
  });
  assert.deepEqual(opened, {
    pr: "2210",
    url: "https://github.com/moofone/icemining/pull/2210",
  });
});

test("L3: handshake timeout is 30 minutes and is not a review deadline", () => {
  assert.equal(orch.PR_AWAIT_CALL_TIMEOUT_MS, 30 * 60 * 1000);
});

test("L3: a hung handshake yields to the waiter and does not fail the Feature", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-hang-"));
  const paths = {
    repo: "icemining",
    gitRoot: dir,
    repoDir: dir,
    featureDir: dir,
    planFile: join(dir, "plan.md"),
    statusFile: join(dir, "status.md"),
    handoffsDir: join(dir, "handoffs"),
    archiveDir: join(dir, "archive"),
  };
  writeFileSync(paths.planFile, "# Feature: t\n");
  writeFileSync(paths.statusFile, ["# Status", "", "pause: off", "pr: 123", ""].join("\n"));

  const pi = makeFakePi(async () => ({
    code: 124,
    stdout: "",
    stderr: "timed out after 1800000ms",
  }));
  const { ctx, notices } = makeFakeCtx();
  const result = (await withDeadline(
    (orch as never as { drivePrAwait: Function }).drivePrAwait(pi, ctx, paths, "123", dir),
    2000,
  )) as { done?: boolean; next?: string; silent?: boolean; reason?: string };

  assert.notEqual(result.reason, "TEST_TIMEOUT");
  assert.equal(result.done, false, "timeout must not mark the Feature landed or failed");
  assert.equal(result.silent, true, "timeout must not prompt the model");
  assert.equal(result.next, "yield");
  assert.match(readFileSync(paths.statusFile, "utf8"), /ghl-pr-await owns the wait/);
  assert.equal(
    notices.some((n) => /Waiter owns the review/.test(n)),
    true,
    `timeout notify must say the waiter owns hours-long review: ${notices.join(" | ")}`,
  );
});

test("L3: a one-shot reports next=done without looping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-pr-"));
  const paths = {
    repo: "icemining",
    gitRoot: dir,
    repoDir: dir,
    featureDir: dir,
    planFile: join(dir, "plan.md"),
    statusFile: join(dir, "status.md"),
    handoffsDir: join(dir, "handoffs"),
    archiveDir: join(dir, "archive"),
  };
  writeFileSync(paths.planFile, "# Feature: t\n");
  writeFileSync(paths.statusFile, ["# Status", "", "pause: off", "pr: 123", ""].join("\n"));

  let execCalls = 0;
  const pi = makeFakePi(async () => {
    execCalls += 1;
    return { code: 0, stdout: "next=done", stderr: "" };
  });
  const { ctx } = makeFakeCtx();

  const result = (await withDeadline(
    (orch as never as { drivePrAwait: Function }).drivePrAwait(pi, ctx, paths, "123", dir),
    2000,
  )) as { done?: boolean; next?: string; paused?: boolean; reason?: string };

  assert.notEqual(result.reason, "TEST_TIMEOUT");
  assert.equal(execCalls, 1);
  assert.equal(result.done, true);
  assert.equal(result.next, "done");
  assert.notEqual(result.paused, true);
});

/* ---------------------------------------------------------------- *
 * T1 — Task headings must parse the separators planners actually write
 *
 * 2026-08-24: /orchestrate approve listing-factory-seams died with
 * "No Tasks found" because the planner wrote `### Task 1:` and parseTasks
 * only accepted an em/en dash or hyphen.
 * ---------------------------------------------------------------- */

const COLON_PLAN = `# Feature: Listing factory seams

## Tasks

### Task 1: Required manifest rule_set

- Status: pending
- Complexity: simple
- Goal: coin.toml declares rule_set
- Handoff: pending

### Task 2: Package-sourced definitions

- Status: pending
- Complexity: simple
- Goal: CoinDefinition from coins/<id>
- Handoff: pending

## Design Decisions
| Decision | Choice | Rationale |
`;

const DASH_PLAN = `### Task 1 — Prefix confirm

- Status: pending
- Complexity: critical

### Task 2 – Origin-only horizon

- Status: done
- Complexity: simple

### Task 3 - Two pages per poll

- Status: pending
`;

test("T1: parseTasks and setTaskStatusInPlan must be exported", () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).parseTasks,
    "function",
    "parseTasks must be exported so heading variants are testable",
  );
  assert.equal(
    typeof (orch as Record<string, unknown>).setTaskStatusInPlan,
    "function",
    "setTaskStatusInPlan must be exported so colon-heading status writes are testable",
  );
});

test("T1: colon headings (listing-factory-seams) are Tasks", () => {
  const parseTasks = (orch as never as { parseTasks: (p: string) => Array<{
    id: string;
    title: string;
    status: string;
    complexity?: string;
  }> }).parseTasks;

  const tasks = parseTasks(COLON_PLAN);
  assert.equal(
    tasks.length,
    2,
    "### Task N: title is a real Task heading; approve must not report No Tasks found",
  );
  assert.equal(tasks[0]?.id, "1");
  assert.equal(tasks[0]?.title, "Required manifest rule_set");
  assert.equal(tasks[0]?.status, "pending");
  assert.equal(tasks[0]?.complexity, "simple");
  assert.equal(tasks[1]?.id, "2");
  assert.equal(tasks[1]?.title, "Package-sourced definitions");
});

test("T1: em dash, en dash, and hyphen headings still parse", () => {
  const parseTasks = (orch as never as { parseTasks: (p: string) => Array<{
    id: string;
    title: string;
    status: string;
  }> }).parseTasks;
  const tasks = parseTasks(DASH_PLAN);
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0]?.title, "Prefix confirm");
  assert.equal(tasks[1]?.title, "Origin-only horizon");
  assert.equal(tasks[1]?.status, "done");
  assert.equal(tasks[2]?.title, "Two pages per poll");
});

test("T1: taskSection on a colon heading stops before the next Task and before H2", () => {
  const body = orch.taskSection(COLON_PLAN, "1");
  assert.match(body, /Required manifest rule_set/);
  assert.match(body, /coin\.toml declares rule_set/);
  assert.doesNotMatch(
    body,
    /Package-sourced definitions/,
    "Task 1's contract must not swallow Task 2 just because both use colons",
  );
  assert.doesNotMatch(body, /Design Decisions/);
  assert.match(orch.taskSection(COLON_PLAN, "2"), /Package-sourced definitions/);
  assert.doesNotMatch(orch.taskSection(COLON_PLAN, "2"), /Design Decisions/);
});

test("T1: status and handoff writes work on colon headings", () => {
  const setStatus = (
    orch as never as {
      setTaskStatusInPlan: (plan: string, id: string, status: string) => string;
    }
  ).setTaskStatusInPlan;

  const inProgress = setStatus(COLON_PLAN, "1", "in_progress");
  assert.match(
    inProgress,
    /### Task 1: Required manifest rule_set\n\n- Status: in_progress/,
  );
  assert.match(inProgress, /### Task 2: Package-sourced definitions\n\n- Status: pending/);

  const withHandoff = orch.setTaskHandoffInPlan(inProgress, "1", "done 2026-08-24");
  assert.match(withHandoff, /- Handoff: done 2026-08-24/);
  assert.match(withHandoff, /### Task 2:[\s\S]*- Handoff: pending/);
});

test("W4: reopenTasksThatNeverStarted reopens a blocked Task with no handoff", () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).reopenTasksThatNeverStarted,
    "function",
    "reopenTasksThatNeverStarted must be exported so resume cannot refuse forever",
  );
  const reopen = (
    orch as never as { reopenTasksThatNeverStarted: (plan: string, dir: string) => string }
  ).reopenTasksThatNeverStarted;
  const dir = mkdtempSync(join(tmpdir(), "orch-reopen-"));
  const plan = [
    "### Task 3 — Refuse unsigned AdminPanel",
    "- Status: blocked",
    "### Task 4 — Next",
    "- Status: pending",
  ].join("\n");
  const next = reopen(plan, dir);
  assert.match(next, /### Task 3[^]*?- Status: pending/);
  assert.match(next, /### Task 4[^]*?- Status: pending/);
});

test("W4: a blocked Task that wrote a handoff stays blocked", () => {
  const reopen = (
    orch as never as { reopenTasksThatNeverStarted: (plan: string, dir: string) => string }
  ).reopenTasksThatNeverStarted;
  const dir = mkdtempSync(join(tmpdir(), "orch-reopen-handoff-"));
  writeFileSync(join(dir, "task-3.md"), "real failure report\n");
  const plan = [
    "### Task 3 — Refuse unsigned AdminPanel",
    "- Status: blocked",
  ].join("\n");
  const next = reopen(plan, dir);
  assert.match(next, /- Status: blocked/);
  assert.doesNotMatch(next, /- Status: pending/);
});

test("T1: mixed dash then colon in one plan both parse", () => {
  const parseTasks = (orch as never as { parseTasks: (p: string) => Array<{
    id: string;
    title: string;
  }> }).parseTasks;
  const mixed = `### Task 1 — Dash first

- Status: pending

### Task 2: Colon second

- Status: pending
`;
  const tasks = parseTasks(mixed);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]?.title, "Dash first");
  assert.equal(tasks[1]?.title, "Colon second");
  assert.match(orch.taskSection(mixed, "1"), /Dash first/);
  assert.doesNotMatch(orch.taskSection(mixed, "1"), /Colon second/);
});

/* ---------------------------------------------------------------- *
 * W1 — orchestration writers must not inherit Cursor Grok / Composer
 * ---------------------------------------------------------------- */

test("W1: isAllowedWriterModel allows GLM flash, cursor grok, Luna, and Anthropic Opus writers", () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).isAllowedWriterModel,
    "function",
    "isAllowedWriterModel must be exported so the Cursor Grok refuse-path is testable",
  );
  const allowed = (orch as never as { isAllowedWriterModel: (m: string) => boolean })
    .isAllowedWriterModel;

  assert.equal(allowed("zai/glm-5.3-flash"), true);
  assert.equal(allowed("zai/glm-5.3-flash:medium"), true);
  assert.equal(allowed("zai/glm-5.3-flash:high"), true);
  assert.equal(allowed("cursor/grok-4.6"), true);
  assert.equal(allowed("cursor/grok-4.6:medium"), true);
  assert.equal(allowed("cursor/gpt-5.6-luna"), true);
  assert.equal(allowed("cursor/gpt-5.6-luna:xhigh"), true);
  assert.equal(allowed("anthropic/claude-opus-5:medium"), true);
  assert.equal(allowed("cursor/claude-opus-5"), false);
  assert.equal(allowed("cursor/claude-opus-5:high"), false);
  assert.equal(allowed("anthropic/claude-sonnet-5"), false);
  assert.equal(allowed("anthropic/claude-sonnet-5:high"), false);

  assert.equal(allowed("grok-4.6"), false, "bare grok-4.6 inherits Cursor billing");
  assert.equal(allowed("cursor/composer-2.5-fast"), false);
  assert.equal(allowed("cursor/composer-2.5-fast:high"), false);
  assert.equal(allowed("xai/grok-4.6:high"), false, "planner model is not a writer");
  assert.equal(allowed("grok-build/grok-4.6:high"), false, "retired grok-build planner id is not a writer");
  assert.equal(allowed("inherit"), false);
  assert.equal(allowed(""), false);
});

test("W1: writerSpawnRejection names the refuse for tdd-worker on cursor/grok", () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).writerSpawnRejection,
    "function",
    "writerSpawnRejection must be exported",
  );
  const reject = (
    orch as never as { writerSpawnRejection: (p: Record<string, unknown>) => string | undefined }
  ).writerSpawnRejection;

  assert.equal(
    reject({ agent: "tdd-worker", model: "zai/glm-5.3-flash:medium" }),
    undefined,
  );
  assert.equal(
    reject({ agent: "tdd-worker", model: "cursor/grok-4.6:medium" }),
    undefined,
  );
  assert.equal(
    reject({ agent: "tdd-worker", model: "cursor/gpt-5.6-luna:xhigh" }),
    undefined,
  );
  assert.equal(
    reject({ agent: "tdd-worker", model: "anthropic/claude-opus-5:medium" }),
    undefined,
  );
  assert.equal(
    reject({ agent: "planner", model: "xai/grok-4.6:high" }),
    undefined,
    "planner is not a writer; this guard does not apply",
  );
  // Pinning replaced hard-refuse for known writers: applySpawnPolicy rewrites
  // composer/inherit onto GLM. writerSpawnRejection stays the allow-list check.
  const composer = reject({ agent: "tdd-worker", model: "cursor/composer-2.5-fast:high" });
  assert.equal(typeof composer, "string");
  assert.match(String(composer), /composer/i);
  assert.match(String(composer), /glm-5\.3-flash/);
  assert.equal(typeof reject({ agent: "tdd-worker" }), "string", "missing model is inherit");
  assert.equal(typeof reject({ agent: "feature-qa", model: "grok-4.6" }), "string");
  assert.equal(
    reject({ agent: "feature-qa", model: "xai/grok-4.6:high" }),
    undefined,
    "QA on native xai grok-4.6 high is the configured reviewer",
  );
  assert.equal(typeof reject({ agent: "qa-opus", model: "cursor/composer-2.5-fast" }), "string");
});

test("W1: runChild pins a tdd-worker on composer onto GLM before spawn", async () => {
  const pi = makeFakePi();
  const spawn = captureSpawn(pi);
  const p = (orch as never as { runChild: Function }).runChild(pi, {
    agent: "tdd-worker",
    model: "cursor/composer-2.5-fast:high",
    timeoutMs: 60_000,
  });
  pi.events.emit(`${RPC_REPLY_PREFIX}${spawn.requestId}`, {
    success: true,
    data: { details: { runId: "run-pin" } },
  });
  pi.events.emit(ASYNC_COMPLETE_EVENT, { runId: "run-pin", success: true });
  const outcome = (await withDeadline(p)) as { ok?: boolean; reason?: string };
  assert.notEqual(outcome.reason, "TEST_TIMEOUT", "pinned spawn must go out");
  assert.equal(outcome.ok, true);
  assert.equal(spawn.params.model, "zai/glm-5.3-flash:medium");
  assert.doesNotMatch(String(spawn.params.model), /composer/);
  assert.equal(spawn.params.context, "fresh");
  assert.equal((spawn.params.turnBudget as { maxTurns: number }).maxTurns, 220);
});

const PARKED_EXCLUSION =
  "Requested subagent model 'zai/glm-5.3-flash:medium' is excluded and cannot be replaced by a fallback (reason: Subagent produced no output (possible model cold-start or empty response).; expires: 2026-08-27T22:39:42.777Z).";

test("W3: isExcludedModelFailure matches the pi-subagents parking throw", () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).isExcludedModelFailure,
    "function",
    "isExcludedModelFailure must be exported so the simple-writer parking path is testable",
  );
  const isExcl = (orch as never as { isExcludedModelFailure: (r?: string) => boolean })
    .isExcludedModelFailure;
  assert.equal(isExcl(PARKED_EXCLUSION), true);
  assert.equal(isExcl("timed out"), false);
  assert.equal(isExcl("spawn reply carried no runId"), false);
  assert.equal(isExcl(undefined), false);
});

test("W3: excluded GLM tdd-worker retries onto cursor grok", async () => {
  const pi = makeFakePi();
  const spawns: { requestId: string; params: Record<string, unknown> }[] = [];
  (pi as never as { events: { on: Function } }).events.on(
    RPC_REQUEST_EVENT,
    (req: { requestId?: string; method?: string; params?: Record<string, unknown> }) => {
      if (req?.method && req.method !== "spawn") return;
      const requestId = req?.requestId ?? "";
      const params = req?.params ?? {};
      spawns.push({ requestId, params });
      queueMicrotask(() => {
        if (spawns.length === 1) {
          pi.events.emit(`${RPC_REPLY_PREFIX}${requestId}`, {
            success: false,
            error: { message: PARKED_EXCLUSION },
          });
          return;
        }
        pi.events.emit(`${RPC_REPLY_PREFIX}${requestId}`, {
          success: true,
          data: { details: { runId: "run-excl-retry" } },
        });
        pi.events.emit(ASYNC_COMPLETE_EVENT, { runId: "run-excl-retry", success: true });
      });
    },
  );

  const p = (orch as never as { runChild: Function }).runChild(pi, {
    agent: "tdd-worker",
    model: "zai/glm-5.3-flash:medium",
    timeoutMs: 60_000,
  });
  const outcome = (await withDeadline(p, 2000)) as { ok?: boolean; reason?: string };
  assert.notEqual(outcome.reason, "TEST_TIMEOUT", "exclusion retry never settled");
  assert.equal(outcome.ok, true);
  assert.equal(spawns.length, 2, "simple GLM exclusion retries onto the critical writer");
  assert.equal(spawns[0]?.params.model, "zai/glm-5.3-flash:medium");
  assert.equal(spawns[1]?.params.model, "cursor/grok-4.6:medium");
});

test("W3: a non-exclusion spawn failure does not retry", async () => {
  const pi = makeFakePi();
  const spawns: string[] = [];
  (pi as never as { events: { on: Function } }).events.on(
    RPC_REQUEST_EVENT,
    (req: { requestId?: string; method?: string }) => {
      if (req?.method && req.method !== "spawn") return;
      const requestId = req?.requestId ?? "";
      spawns.push(requestId);
      queueMicrotask(() => {
        pi.events.emit(`${RPC_REPLY_PREFIX}${requestId}`, {
          success: false,
          error: { message: "spawn reply carried no runId" },
        });
      });
    },
  );

  const p = (orch as never as { runChild: Function }).runChild(pi, {
    agent: "tdd-worker",
    model: "zai/glm-5.3-flash:medium",
    timeoutMs: 60_000,
  });
  const outcome = (await withDeadline(p, 2000)) as { ok?: boolean; reason?: string };
  assert.notEqual(outcome.reason, "TEST_TIMEOUT");
  assert.equal(outcome.ok, false);
  assert.equal(spawns.length, 1, "other spawn failures must not fan out onto grok");
});

test("W3: an excluded critical grok writer does not retry (no loop)", async () => {
  const pi = makeFakePi();
  const spawns: string[] = [];
  (pi as never as { events: { on: Function } }).events.on(
    RPC_REQUEST_EVENT,
    (req: { requestId?: string; method?: string }) => {
      if (req?.method && req.method !== "spawn") return;
      const requestId = req?.requestId ?? "";
      spawns.push(requestId);
      queueMicrotask(() => {
        pi.events.emit(`${RPC_REPLY_PREFIX}${requestId}`, {
          success: false,
          error: { message: PARKED_EXCLUSION },
        });
      });
    },
  );

  const p = (orch as never as { runChild: Function }).runChild(pi, {
    agent: "tdd-worker",
    model: "cursor/grok-4.6:medium",
    timeoutMs: 60_000,
  });
  const outcome = (await withDeadline(p, 2000)) as { ok?: boolean; reason?: string };
  assert.notEqual(outcome.reason, "TEST_TIMEOUT");
  assert.equal(outcome.ok, false);
  assert.equal(spawns.length, 1, "retrying critical onto critical would loop");
});

/* ---------------------------------------------------------------- *
 * W2 — deterministic pins + fail-closed billing models
 * ---------------------------------------------------------------- */

test("W2: isAllowedPlannerModel accepts native xai grok-4.6 high only", () => {
  const allowed = (orch as never as { isAllowedPlannerModel: (m: string) => boolean })
    .isAllowedPlannerModel;
  assert.equal(allowed("xai/grok-4.6:high"), true);
  assert.equal(allowed("xai/grok-4.6"), false, "thinking high is required");
  assert.equal(allowed("xai/grok-4.6:xhigh"), false);
  assert.equal(allowed("grok-build/grok-4.6:high"), false, "grok-build is unregistered");
  assert.equal(allowed("cursor/grok-4.6:high"), false);
  assert.equal(allowed("inherit"), false);
});

test("W2: applySpawnPolicy pins writers and planner; rejects other cursor billing", () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).applySpawnPolicy,
    "function",
    "applySpawnPolicy must be exported",
  );
  const apply = (
    orch as never as {
      applySpawnPolicy: (p: Record<string, unknown>) => { action: string; reason?: string };
    }
  ).applySpawnPolicy;

  const writer = { agent: "tdd-worker", model: "cursor/composer-2.5-fast:high", timeoutMs: 4 * 60 * 60 * 1000 };
  const w = apply(writer);
  assert.equal(w.action, "pin");
  assert.equal(writer.model, "zai/glm-5.3-flash:medium");
  assert.equal(writer.context, "fresh");
  assert.ok((writer.timeoutMs as number) <= 90 * 60 * 1000, "4h writer timeout must clamp");
  assert.equal((writer.turnBudget as { maxTurns: number }).maxTurns, 220);

  const already = { agent: "tdd-worker", model: "zai/glm-5.3-flash:medium" };
  assert.equal(apply(already).action, "allow");
  assert.equal(already.model, "zai/glm-5.3-flash:medium", "do not demote an allowed writer");
  assert.equal((already.turnBudget as { maxTurns: number }).maxTurns, 220);

  const critical = { agent: "tdd-worker", model: "cursor/grok-4.6:medium" };
  assert.equal(apply(critical).action, "allow");
  assert.equal(critical.model, "cursor/grok-4.6:medium", "do not demote the critical writer");

  const anthropicQa = { agent: "feature-qa", model: "anthropic/claude-opus-5:high" };
  assert.equal(apply(anthropicQa).action, "pin");
  assert.equal(anthropicQa.model, "xai/grok-4.6:high", "retired Opus QA pins onto native grok");

  const planner = { agent: "planner", model: "cursor/grok-4.6:xhigh" };
  assert.equal(apply(planner).action, "pin");
  assert.equal(planner.model, "xai/grok-4.6:high");

  const inheritPlanner = { agent: "planner" };
  assert.equal(apply(inheritPlanner).action, "pin");
  assert.equal(inheritPlanner.model, "xai/grok-4.6:high");

  const demote = { agent: "planner", model: "grok-build/grok-4.6:xhigh" };
  assert.equal(apply(demote).action, "pin");
  assert.equal(demote.model, "xai/grok-4.6:high");

  const alreadyPlanner = {
    agent: "planner",
    model: "xai/grok-4.6:high",
    timeoutMs: 60_000,
    turnBudget: { maxTurns: 80, graceTurns: 15 },
  };
  assert.equal(apply(alreadyPlanner).action, "allow");
  assert.equal(alreadyPlanner.model, "xai/grok-4.6:high");

  const scout = { agent: "worker", model: "cursor/composer-2.5-fast:high" };
  const s = apply(scout);
  assert.equal(s.action, "reject");
  assert.match(String(s.reason), /composer|cursor/i);
  assert.equal(scout.model, "cursor/composer-2.5-fast:high", "reject must not rewrite unknown agents");

  const manage = { action: "status", id: "run-1" };
  assert.equal(apply(manage).action, "allow");

  const grokXhigh = { agent: "worker", model: "xai/grok-4.6:xhigh" };
  assert.equal(apply(grokXhigh).action, "pin");
  assert.equal(grokXhigh.model, "xai/grok-4.6:high");
});

test("W2: applySpawnPolicy pins every parallel writer task", () => {
  const apply = (
    orch as never as { applySpawnPolicy: (p: Record<string, unknown>) => { action: string } }
  ).applySpawnPolicy;
  const params = {
    agent: "tdd-worker",
    parallel: [
      { agent: "tdd-worker", model: "grok-4.6" },
      { agent: "tdd-worker", model: "cursor/composer-2.5-fast:high" },
    ],
    concurrency: 7,
  };
  apply(params);
  for (const task of params.parallel) {
    assert.equal(task.model, "zai/glm-5.3-flash:medium");
  }
  assert.ok((params.concurrency as number) <= 2, "writer fanout must not keep concurrency 7");
});

test("W2: subagentToolGuard blocks unknown cursor billing and mutates writer input", () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).subagentToolGuard,
    "function",
    "subagentToolGuard must be exported so the parent-model spawn path is testable",
  );
  const guard = (
    orch as never as {
      subagentToolGuard: (event: {
        toolName?: string;
        input?: Record<string, unknown>;
      }) => { block: true; reason: string } | undefined;
    }
  ).subagentToolGuard;

  assert.equal(guard({ toolName: "bash", input: { command: "ls" } }), undefined);

  const writerInput = { agent: "tdd-worker", model: "inherit", task: "do the thing" };
  const blockedWriter = guard({ toolName: "subagent", input: writerInput });
  assert.equal(blockedWriter?.block, true, "parent must not spawn tdd-worker; the extension launches it");
  assert.match(String(blockedWriter?.reason), /tdd-worker/);

  const blocked = guard({
    toolName: "subagent",
    input: { agent: "worker", model: "cursor/grok-4.6", task: "burn" },
  });
  assert.equal(blocked?.block, true);
  assert.match(String(blocked?.reason), /cursor\/grok-4\.6/i);

  assert.equal(guard({ toolName: "subagent", input: { action: "status" } }), undefined);
});

test("W2: rpcCall does not emit a rejected unknown-agent cursor spawn", async () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).rpcCall,
    "function",
    "rpcCall must be exported so the reject-before-emit path is testable",
  );
  const pi = makeFakePi();
  const spawn = captureSpawn(pi);
  const rpcCall = (orch as never as { rpcCall: Function }).rpcCall;
  const reply = await rpcCall(pi, "spawn", {
    agent: "worker",
    model: "cursor/grok-4.6:high",
    task: "no",
  });
  assert.equal(reply.success, false);
  assert.match(String(reply.error?.message), /cursor\/grok-4\.6/i);
  assert.equal(spawn.requestId, "", "rejected RPC spawn must not hit the bus");
});

/* ---------------------------------------------------------------- *
 * L4 — harness fail + landed work auto-advances (default on)
 * ---------------------------------------------------------------- */

test("L4: parseFlag accepts ordinary true/false spellings and falls back", () => {
  assert.equal(orch.parseFlag("true", false), true);
  assert.equal(orch.parseFlag("YES", false), true);
  assert.equal(orch.parseFlag("on", false), true);
  assert.equal(orch.parseFlag("1", false), true);
  assert.equal(orch.parseFlag("false", true), false);
  assert.equal(orch.parseFlag("NO", true), false);
  assert.equal(orch.parseFlag("off", true), false);
  assert.equal(orch.parseFlag("0", true), false);
  assert.equal(orch.parseFlag("", true), true, "empty inherits fallback");
  assert.equal(orch.parseFlag("maybe", true), true, "unknown inherits fallback");
});

test("L4: sidecarAutoAdvanceOnLanded defaults true and honors the boolean", () => {
  assert.equal(orch.sidecarAutoAdvanceOnLanded(""), true, "missing sidecar is on");
  assert.equal(orch.sidecarAutoAdvanceOnLanded("{}"), true);
  assert.equal(orch.sidecarAutoAdvanceOnLanded('{"autoAdvanceOnLanded":true}'), true);
  assert.equal(orch.sidecarAutoAdvanceOnLanded('{"autoAdvanceOnLanded":false}'), false);
  assert.equal(orch.sidecarAutoAdvanceOnLanded('{"autoAdvanceOnLanded":"off"}'), false);
  assert.equal(orch.sidecarAutoAdvanceOnLanded("not-json"), true, "malformed keeps default");
});

test("L4: autoAdvanceOnLanded lets status.md override the sidecar", () => {
  assert.equal(orch.autoAdvanceOnLanded("", true), true);
  assert.equal(orch.autoAdvanceOnLanded("", false), false);
  assert.equal(orch.autoAdvanceOnLanded("auto_advance_on_landed: false\n", true), false);
  assert.equal(orch.autoAdvanceOnLanded("auto_advance_on_landed: on\n", false), true);
});

test("L4: worktreeChanged requires two distinct readable fingerprints", () => {
  assert.equal(orch.worktreeChanged("abc\n", "def\n"), true);
  assert.equal(orch.worktreeChanged("abc\n", "abc\n"), false, "unchanged is not a land");
  assert.equal(orch.worktreeChanged("", "def\n"), false, "unreadable before is inconclusive");
  assert.equal(orch.worktreeChanged("abc\n", ""), false, "unreadable after is inconclusive");
  assert.equal(orch.worktreeChanged("", ""), false);
});

test("L4: settleTaskOutcome continues to the next Task on success even if the worktree did not change", () => {
  assert.equal(typeof orch.settleTaskOutcome, "function", "settleTaskOutcome must be exported");
  const settle = orch.settleTaskOutcome;
  assert.equal(settle({ ok: true, landed: true, autoAdvance: true }).action, "done_continue");
  assert.equal(
    settle({ ok: true, landed: false, autoAdvance: true }).action,
    "done_continue",
    "host-only Features (edits outside ice-wt) must still advance to the next Task",
  );
  assert.equal(settle({ ok: true, landed: false, autoAdvance: false }).action, "done_continue");
  assert.equal(settle({ ok: false, stopped: true, landed: false, autoAdvance: true }).action, "pending_pause");
  assert.equal(settle({ ok: false, landed: true, autoAdvance: true }).action, "done_continue");
  assert.equal(settle({ ok: false, landed: true, autoAdvance: false }).action, "blocked");
  assert.equal(settle({ ok: false, landed: false, autoAdvance: true }).action, "blocked");
});

test("L4: settleTaskOutcome never says to leave the Feature", () => {
  const settle = orch.settleTaskOutcome;
  for (const input of [
    { ok: true, landed: true, autoAdvance: true },
    { ok: true, landed: false, autoAdvance: true },
    { ok: false, landed: true, autoAdvance: true },
    { ok: false, landed: false, autoAdvance: true },
    { ok: false, stopped: true, landed: false, autoAdvance: true },
  ]) {
    assert.notEqual(settle(input).action, "qa");
    assert.notEqual(settle(input).action, "pr");
    assert.notEqual(settle(input).action, "next_feature");
  }
});

/* ---------------------------------------------------------------- *
 * L5 — approve is a TUI card, not a markdown fence
 * ---------------------------------------------------------------- */

test("L5: stripApproveFences removes the fenced approve block Pi would print as backticks", () => {
  const src = [
    "Plan is ready.",
    "",
    "Approve with:",
    "",
    "```",
    "  /orchestrate approve auth-reject-analytics",
    "```",
    "",
    "Do not implement.",
    "",
  ].join("\n");
  const out = orch.stripApproveFences(src);
  assert.deepEqual(out.names, ["auth-reject-analytics"]);
  assert.doesNotMatch(out.markdown, /```/);
  assert.doesNotMatch(out.markdown, /Approve with:/i);
  assert.match(out.markdown, /Plan is ready/);
  assert.match(out.markdown, /Do not implement/);
});

test("L5: stripApproveFences leaves other fences and inline backticks alone", () => {
  const src = "Use `- Command: \\`rtk cargo test\\`` and keep this:\n```\nrtk cargo test\n```\n";
  const out = orch.stripApproveFences(src);
  assert.deepEqual(out.names, []);
  assert.match(out.markdown, /```/);
  assert.match(out.markdown, /rtk cargo test/);
});

test("L5: draftApproveCards keeps named drafts and drops pending/approved/archived", () => {
  const draft = {
    archived: false,
    dir: "/tmp/feat-a",
    name: "auth-reject-analytics",
    plan: "# Feature: Auth Reject Analytics\n\n> Status: DRAFT — awaiting approval\n> Name: auth-reject-analytics\n> Branch: feat/auth-reject-analytics\n",
    status: "name: auth-reject-analytics\nbranch: feat/auth-reject-analytics\nplan_review: done\n",
  };
  const pending = {
    ...draft,
    dir: "/tmp/pending",
    name: "pending",
    plan: "# Feature: (planning)\n\n> Status: DRAFT\n> Name: pending\n",
    status: "name: pending\n",
  };
  const approved = {
    ...draft,
    dir: "/tmp/feat-b",
    name: "already-approved",
    plan: "# Feature: Done\n\n> Status: APPROVED\n> Name: already-approved\n",
    status: "name: already-approved\n",
  };
  const archived = { ...draft, archived: true, dir: "/tmp/old" };
  const cards = orch.draftApproveCards([draft, pending, approved, archived]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.name, "auth-reject-analytics");
  assert.equal(cards[0]?.command, "/orchestrate approve auth-reject-analytics");
});

test("L5: draftApproveCards names a titled draft whose Name header is still pending", () => {
  const titled = {
    archived: false,
    dir: "/tmp/pending-2026-08-31T01-02-02-303Z",
    name: "pending",
    plan: [
      "# Feature: Block Chance Honesty",
      "",
      "> Status: DRAFT — awaiting approval",
      "> Name: pending",
      "> Branch: pending",
    ].join("\n"),
    status: "name: pending\nbranch: pending\nplan_review: done\n",
  };
  const stub = {
    ...titled,
    dir: "/tmp/pending-2026-08-22T19-35-24-298Z",
    plan: "# Feature: (planning)\n\n> Status: DRAFT\n> Name: pending\n",
  };
  const cards = orch.draftApproveCards([titled, stub]);
  assert.equal(cards.length, 1, "a real # Feature: title must produce an approve card even while Name is pending");
  assert.equal(cards[0]?.name, "block-chance-honesty");
  assert.equal(cards[0]?.command, "/orchestrate approve block-chance-honesty");
  assert.equal(cards[0]?.branch, "feat/block-chance-honesty");
});

test("L5: draftApproveCards withholds the card until plan-reviewer is done", () => {
  const draft = {
    archived: false,
    dir: "/tmp/feat-a",
    name: "auth-reject-analytics",
    plan: "# Feature: Auth Reject Analytics\n\n> Status: DRAFT — awaiting approval\n> Name: auth-reject-analytics\n> Branch: feat/auth-reject-analytics\n",
    status: "name: auth-reject-analytics\nbranch: feat/auth-reject-analytics\nplan_review: running\n",
  };
  assert.deepEqual(orch.draftApproveCards([draft]), []);
  assert.deepEqual(
    orch.draftApproveCards([{ ...draft, status: "name: auth-reject-analytics\nplan_review: none\n" }]),
    [],
  );
  const ready = orch.draftApproveCards([
    { ...draft, status: "name: auth-reject-analytics\nplan_review: done\n" },
  ]);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]?.name, "auth-reject-analytics");
});

test("L5: ensureFeatureNamed promotes pending-* to the title slug so approve has a name", () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).ensureFeatureNamed,
    "function",
    "ensureFeatureNamed must be exported so title-to-name promotion is testable",
  );
  const repoDir = mkdtempSync(join(tmpdir(), "orch-name-"));
  const pendingDir = join(repoDir, "pending-2026-08-31T01-02-02-303Z");
  mkdirSync(join(pendingDir, "handoffs"), { recursive: true });
  const plan = [
    "# Feature: Block Chance Honesty",
    "",
    "> Status: DRAFT — awaiting approval",
    "> Name: pending",
    "> Branch: pending",
    "> Repo: icemining",
  ].join("\n");
  writeFileSync(join(pendingDir, "plan.md"), plan);
  writeFileSync(
    join(pendingDir, "status.md"),
    [
      "# Status",
      "name: pending",
      "branch: pending",
      "worktree: none",
      "phase: planning",
      "next_action: wait for /orchestrate approve",
    ].join("\n"),
  );
  const paths = {
    repo: "test-orch-name",
    gitRoot: join(repoDir, "git"),
    repoDir,
    featureDir: pendingDir,
    planFile: join(pendingDir, "plan.md"),
    statusFile: join(pendingDir, "status.md"),
    handoffsDir: join(pendingDir, "handoffs"),
    archiveDir: join(repoDir, "archive"),
  };
  const named = (orch as never as { ensureFeatureNamed: Function }).ensureFeatureNamed(
    paths,
    plan,
  );
  assert.equal(named.assigned, true);
  assert.equal(named.name, "block-chance-honesty");
  assert.equal(named.branch, "feat/block-chance-honesty");
  const dest = join(repoDir, "block-chance-honesty");
  assert.equal(existsSync(dest), true, "pending-* must be renamed to the title slug");
  assert.match(
    readFileSync(join(dest, "status.md"), "utf8"),
    /next_action: wait for \/orchestrate approve block-chance-honesty/,
  );
});

test("L5: renderApproveEntry draws a bordered card whose lines include the approve command", () => {
  const theme = {
    fg: (_c: string, t: string) => t,
    bg: (_c: string, t: string) => t,
    bold: (t: string) => t,
  };
  const card = orch.renderApproveEntry(
    {
      data: {
        name: "auth-reject-analytics",
        command: "/orchestrate approve auth-reject-analytics",
        title: "Auth Reject Analytics",
        branch: "feat/auth-reject-analytics",
      },
    },
    { expanded: false },
    theme,
  );
  const lines = card.render(80).join("\n");
  assert.match(lines, /┌/);
  assert.match(lines, /└/);
  assert.match(lines, /Approve/);
  assert.match(lines, /Auth Reject Analytics/);
  assert.match(lines, /\/orchestrate approve auth-reject-analytics/);
  assert.doesNotMatch(lines, /```/);
});

function waitingApproveRow(name: string) {
  return {
    name,
    dir: `/tmp/${name}`,
    live: true,
    archived: false,
    plan: `# Feature: ${name}\n\n> Status: DRAFT — awaiting approval\n> Name: ${name}\n> Branch: feat/${name}\n`,
    status: `name: ${name}\nbranch: feat/${name}\nplan_review: done\n`,
  };
}

function busyLiveRow(name: string) {
  return {
    name,
    dir: `/tmp/${name}`,
    live: true,
    archived: false,
    plan: `# Feature: ${name}\n\n> Status: APPROVED\n> Name: ${name}\n\n### Task 1 — go\n- Status: in_progress\n`,
    status: `name: ${name}\nphase: implementing\nplan_review: done\n`,
  };
}

test("L5: bare approve picks the unique Feature waiting for approve among many live", () => {
  assert.equal(typeof orch.defaultFeature, "function");
  const rows = [
    busyLiveRow("close-control-plane-toctou"),
    busyLiveRow("late-cycle-holdout-land"),
    waitingApproveRow("await-driver-sticky-cwd"),
    busyLiveRow("workers-coin-network-toggle"),
  ];
  assert.equal(
    orch.defaultFeature(rows)?.name,
    undefined,
    "without a verb, many live Features stay ambiguous",
  );
  assert.equal(
    orch.defaultFeature(rows, "approve")?.name,
    "await-driver-sticky-cwd",
    "/orchestrate approve with no name must bind the unique waiting draft, not dump every live Feature",
  );
});

test("L5: bare approve stays silent when zero or two Features are waiting", () => {
  const noneWaiting = [busyLiveRow("a"), busyLiveRow("b")];
  assert.equal(orch.defaultFeature(noneWaiting, "approve"), undefined);
  const twoWaiting = [
    waitingApproveRow("await-driver-sticky-cwd"),
    waitingApproveRow("seatbelt-tool-isolation"),
    busyLiveRow("busy"),
  ];
  assert.equal(orch.defaultFeature(twoWaiting, "approve"), undefined);
});

test("L5: missing Feature instructions always use the specific dynamic name, never <name>", () => {
  assert.equal(typeof orch.missingFeatureMessage, "function");
  const rows = [
    busyLiveRow("close-control-plane-toctou"),
    waitingApproveRow("await-driver-sticky-cwd"),
    waitingApproveRow("seatbelt-tool-isolation"),
  ];
  const msg = orch.missingFeatureMessage("approve", "", rows);
  assert.match(msg, /Which Feature to approve\?/);
  assert.match(msg, /\/orchestrate approve await-driver-sticky-cwd/);
  assert.match(msg, /\/orchestrate approve seatbelt-tool-isolation/);
  assert.doesNotMatch(msg, /<name>/);
  assert.doesNotMatch(
    msg,
    /close-control-plane-toctou/,
    "busy live Features are not candidates for approve",
  );
  const none = orch.missingFeatureMessage("approve", "", [busyLiveRow("busy")]);
  assert.match(none, /No Feature to approve/);
  assert.doesNotMatch(none, /<name>/);
  const missed = orch.missingFeatureMessage("approve", "no-such", rows);
  assert.match(missed, /No Feature matching "no-such"/);
  assert.match(missed, /\/orchestrate approve await-driver-sticky-cwd/);
  assert.doesNotMatch(missed, /<name>/);
});

test("L5: unmatched approve must not say Live: (none) when live Features exist", () => {
  const drafts = [
    livePlanRow("quiesce-identical-commits", "Quiesce identical commits"),
    livePlanRow(
      "quiesce-identical-current-state",
      "Quiesce identical current-state commits",
    ),
  ];
  const msg = orch.missingFeatureMessage(
    "approve",
    "quiesce-identical-current-state-commits",
    drafts,
  );
  assert.match(msg, /No Feature matching "quiesce-identical-current-state-commits"/);
  assert.doesNotMatch(
    msg,
    /Live: \(none\)/,
    "plan_review:none drafts are live; 'Live: (none)' hid the complete plan",
  );
  assert.match(msg, /Waiting for approve: \(none\)/);
});

/* ------------------------------------------------------------------ *
 * R: orphan-run recovery
 *
 * The chain is an in-process loop. When the pi session that owns it exits
 * while a tdd-worker is still running, the child keeps going in its own
 * process and finishes — but nobody is listening, so plan.md keeps saying
 * `in_progress` and status.md keeps a worker_run_id that will never settle.
 * The next `/orchestrate resume` then re-runs a Task whose work already
 * landed, changes nothing, and trips the unchanged-worktree guard into
 * `blocked` — after which resume refuses forever.
 *
 * Recovery reads the run's own status.json, which pi-subagents writes to
 * disk, and decides from that plus git evidence.
 * ------------------------------------------------------------------ */

function writeRunStatus(dir: string, status: Record<string, unknown>): string {
  const runDir = join(dir, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "status.json"), JSON.stringify(status));
  return runDir;
}

test("R1: asyncRunDir names the pi-subagents run directory for a runId", () => {
  const dir = orch.asyncRunDir("6cbcaaf5-83f0-46b5-b7b4-f89347763413");
  assert.match(dir, /async-subagent-runs[/\\]6cbcaaf5-83f0-46b5-b7b4-f89347763413$/);
  assert.ok(dir.startsWith(tmpdir()), `expected a tmpdir path, got ${dir}`);
});

test("R2: readRunSnapshot reads a completed run off disk as terminal and ok", () => {
  const runDir = writeRunStatus(mkdtempSync(join(tmpdir(), "orch-snap-")), {
    state: "complete",
    startedAt: 1000,
    endedAt: 2000,
    pid: 999999,
    steps: [{ status: "complete" }],
  });
  const snap = orch.readRunSnapshot(runDir);
  assert.ok(snap, "a run with a status.json must produce a snapshot");
  assert.equal(snap.terminal, true);
  assert.equal(snap.ok, true);
  assert.equal(snap.stopped, false);
  assert.equal(snap.startedAtMs, 1000);
});

test("R2: readRunSnapshot reports a stopped run as terminal, not ok, stopped", () => {
  const runDir = writeRunStatus(mkdtempSync(join(tmpdir(), "orch-snap-")), {
    state: "stopped",
    startedAt: 1000,
    endedAt: 2000,
    steps: [{ status: "stopped" }],
  });
  const snap = orch.readRunSnapshot(runDir);
  assert.equal(snap.terminal, true);
  assert.equal(snap.ok, false);
  assert.equal(snap.stopped, true);
});

test("R2: a running run whose process is gone is terminal, not ok", () => {
  const runDir = writeRunStatus(mkdtempSync(join(tmpdir(), "orch-snap-")), {
    state: "running",
    startedAt: 1000,
    pid: 4242,
    steps: [{ status: "running" }],
  });
  const snap = orch.readRunSnapshot(runDir, () => false);
  assert.equal(snap.terminal, true, "a dead runner process ends the run");
  assert.equal(snap.ok, false);
});

test("R2: a running run whose process is alive is not terminal", () => {
  const runDir = writeRunStatus(mkdtempSync(join(tmpdir(), "orch-snap-")), {
    state: "running",
    startedAt: 1000,
    pid: process.pid,
    steps: [{ status: "running" }],
  });
  const snap = orch.readRunSnapshot(runDir, () => true);
  assert.equal(snap.terminal, false);
});

test("R2: readRunSnapshot returns undefined when the run dir has no status.json", () => {
  assert.equal(orch.readRunSnapshot(mkdtempSync(join(tmpdir(), "orch-snap-"))), undefined);
});

test("R3: orphanDecision continues a Task whose orphaned run finished and landed work", () => {
  const snap = { state: "complete", terminal: true, ok: true, stopped: false, startedAtMs: 1 };
  assert.equal(orch.orphanDecision(snap, true, true), "done");
});

test("R3: orphanDecision blocks a finished orphan that changed nothing", () => {
  const snap = { state: "complete", terminal: true, ok: true, stopped: false, startedAtMs: 1 };
  assert.equal(orch.orphanDecision(snap, false, true), "blocked");
});

test("R3: orphanDecision waits for an orphan that is still running elsewhere", () => {
  const snap = { state: "running", terminal: false, ok: false, stopped: false, startedAtMs: 1 };
  assert.equal(orch.orphanDecision(snap, false, true), "wait");
});

test("R3: orphanDecision re-runs a stopped orphan instead of blocking it", () => {
  const snap = { state: "stopped", terminal: true, ok: false, stopped: true, startedAtMs: 1 };
  assert.equal(orch.orphanDecision(snap, true, true), "rerun");
});

test("R3: orphanDecision honors autoAdvanceOnLanded for a failed orphan", () => {
  const snap = { state: "failed", terminal: true, ok: false, stopped: false, startedAtMs: 1 };
  assert.equal(orch.orphanDecision(snap, true, true), "done");
  assert.equal(orch.orphanDecision(snap, true, false), "blocked");
  assert.equal(orch.orphanDecision(snap, false, true), "blocked");
});

test("R3: an unknown run is decided on git evidence alone", () => {
  assert.equal(orch.orphanDecision(undefined, true, true), "done");
  assert.equal(orch.orphanDecision(undefined, false, true), "rerun");
});

test("R4: fingerprintTag is one status.md-safe line and survives a round trip", () => {
  const tag = orch.fingerprintTag("abc123\n M file.rs\n?? other.rs");
  assert.ok(tag.length > 0);
  assert.doesNotMatch(tag, /\s/, "a multi-line fingerprint must collapse to one token");
  assert.equal(tag, orch.fingerprintTag("abc123\n M file.rs\n?? other.rs"));
  assert.notEqual(tag, orch.fingerprintTag("abc123\n"));
  assert.equal(orch.fingerprintTag(""), "");
});

test("R5: landedByEvidence prefers the recorded base fingerprint", () => {
  const base = orch.fingerprintTag("head-a\n");
  const same = orch.fingerprintTag("head-a\n");
  const moved = orch.fingerprintTag("head-b\n");
  assert.equal(orch.landedByEvidence({ baseTag: base, nowTag: moved }), true);
  assert.equal(orch.landedByEvidence({ baseTag: base, nowTag: same }), false);
});

test("R5: with no recorded base, a handoff written after the run started is the evidence", () => {
  assert.equal(
    orch.landedByEvidence({ baseTag: "", nowTag: "x", handoffMtimeMs: 200, runStartedAtMs: 100 }),
    true,
  );
  assert.equal(
    orch.landedByEvidence({ baseTag: "", nowTag: "x", handoffMtimeMs: 50, runStartedAtMs: 100 }),
    false,
    "a handoff older than the run is a leftover from a previous attempt",
  );
  assert.equal(orch.landedByEvidence({ baseTag: "", nowTag: "x" }), false);
});

/**
 * R6 is the bug as it actually happened on auth-reject-analytics: the pi
 * session exited at 19:42Z while Task 5's worker was mid-flight; the worker
 * finished at 19:36:59Z into a dead listener; plan.md kept saying
 * `in_progress` and the branch kept the commit. The next resume re-ran a
 * finished Task, changed nothing, and blocked the Feature.
 */
function orphanFixture(taskStatus: string, runStatus: Record<string, unknown> | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "orch-orphan-"));
  const paths = {
    repo: "icemining",
    gitRoot: dir,
    repoDir: dir,
    featureDir: dir,
    planFile: join(dir, "plan.md"),
    statusFile: join(dir, "status.md"),
    handoffsDir: join(dir, "handoffs"),
    archiveDir: join(dir, "archive"),
  };
  writeFileSync(
    paths.planFile,
    [
      "# Feature: Auth Reject Analytics",
      "",
      "## Tasks",
      "",
      "### Task 5 — Ledger and TM note",
      "",
      `- Status: ${taskStatus}`,
      "- Handoff: pending",
      "",
    ].join("\n"),
  );
  const runDir = join(dir, "run");
  if (runStatus) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "status.json"), JSON.stringify(runStatus));
  }
  writeFileSync(
    paths.statusFile,
    [
      "# Status",
      "",
      "name: auth-reject-analytics",
      "phase: implementing",
      "active_task: 5",
      "worker_run_id: 6cbcaaf5-83f0-46b5-b7b4-f89347763413",
      `worker_run_dir: ${runDir}`,
      `task_base: ${orch.fingerprintTag("before-head\n")}`,
      "pause: off",
      "",
    ].join("\n"),
  );
  return { dir, paths };
}

/** git answers with a HEAD that moved, i.e. the orphaned worker committed. */
function movedHeadPi() {
  return makeFakePi(async (_cmd: string, args: string[]) => ({
    code: 0,
    stdout: args[0] === "rev-parse" ? "after-head" : "",
    stderr: "",
  }));
}

test("R6: an orphaned Task whose worker finished is recorded done, not re-run", async () => {
  const { paths } = orphanFixture("in_progress", {
    state: "complete",
    startedAt: 1,
    endedAt: 2,
    steps: [{ status: "complete" }],
  });
  const { ctx, notices } = makeFakeCtx();
  const proceed = await orch.reconcileOrphanTask(
    movedHeadPi(),
    ctx,
    paths as never,
    "auth-reject-analytics",
    "/tmp/wt",
  );
  assert.equal(proceed, true, "the chain must carry on to the next Task");
  const plan = readFileSync(paths.planFile, "utf8");
  assert.match(plan, /- Status: done/);
  assert.match(plan, /- Handoff: .*task-5\.md/);
  const status = readFileSync(paths.statusFile, "utf8");
  assert.match(status, /^active_task: none$/m);
  assert.match(status, /^worker_run_id: none$/m);
  assert.match(status, /^task_base: none$/m);
  assert.match(notices.join("\n"), /recovered/i);
});

test("R6: an orphaned Task that produced nothing is re-run, not blocked", async () => {
  const { paths } = orphanFixture("in_progress", {
    state: "complete",
    startedAt: 1,
    endedAt: 2,
    steps: [{ status: "complete" }],
  });
  const { ctx } = makeFakeCtx();
  // Same fingerprint as the recorded base: the worker changed nothing.
  const stillPi = makeFakePi(async (_cmd: string, args: string[]) => ({
    code: 0,
    stdout: args[0] === "rev-parse" ? "before-head" : "",
    stderr: "",
  }));
  const proceed = await orch.reconcileOrphanTask(
    stillPi,
    ctx,
    paths as never,
    "auth-reject-analytics",
    "/tmp/wt",
  );
  assert.equal(proceed, false, "a completed run that changed nothing blocks");
  assert.match(readFileSync(paths.planFile, "utf8"), /- Status: blocked/);
});

test("R6: a Task with no in-flight record leaves the plan alone", async () => {
  const { paths } = orphanFixture("pending", undefined);
  const { ctx } = makeFakeCtx();
  const proceed = await orch.reconcileOrphanTask(
    movedHeadPi(),
    ctx,
    paths as never,
    "auth-reject-analytics",
    "/tmp/wt",
  );
  assert.equal(proceed, true);
  assert.match(readFileSync(paths.planFile, "utf8"), /- Status: pending/);
});

test("R6: a live orphan run is waited on, never started a second time", async () => {
  const { paths } = orphanFixture("in_progress", {
    state: "running",
    startedAt: 1,
    pid: process.pid,
    steps: [{ status: "running" }],
  });
  // `pause` short-circuits the poll loop so the test does not sleep.
  writeFileSync(
    paths.statusFile,
    readFileSync(paths.statusFile, "utf8").replace("pause: off", "pause: after-task"),
  );
  const { ctx, notices } = makeFakeCtx();
  const proceed = await orch.reconcileOrphanTask(
    movedHeadPi(),
    ctx,
    paths as never,
    "auth-reject-analytics",
    "/tmp/wt",
  );
  assert.equal(proceed, false, "one writer per worktree: do not spawn over a live worker");
  assert.match(readFileSync(paths.planFile, "utf8"), /- Status: in_progress/);
  assert.match(notices.join("\n"), /still (running|being written)/i);
});

/* ------------------------------------------------------------------ *
 * Q: the QA pass must be launchable
 *
 * `settings.json` scopes feature-qa / qa-opus / plan-reviewer to
 * `xai/grok-4.6`, and the extension's own contract text says the same.
 * Launching QA on a cursor-billed id is refused by modelScope before the
 * child starts, so every QA pass fails, no PR is ever opened, and the
 * Feature parks at `feature-qa failed — /orchestrate resume`.
 * ------------------------------------------------------------------ */

test("Q1: feature-qa launches on the native xai grok-4.6 id modelScope allows", () => {
  const params = orch.qaLaunchParams(
    {
      planFile: "/tmp/f/plan.md",
      handoffsDir: "/tmp/f/handoffs",
    } as never,
    "auth-reject-analytics",
    "/tmp/wt",
    "feature-qa",
    "high",
  );
  assert.equal(params.agent, "feature-qa");
  assert.equal(params.model, "xai/grok-4.6:high");
  assert.equal(params.cwd, "/tmp/wt");
  assert.equal(
    (params.turnBudget as { maxTurns: number }).maxTurns,
    60,
    "QA is not a 220-turn writer",
  );
});

test("Q1: qa-opus launches on the same native grok id at high", () => {
  const params = orch.qaLaunchParams(
    { planFile: "/tmp/f/plan.md", handoffsDir: "/tmp/f/handoffs" } as never,
    "auth-reject-analytics",
    "/tmp/wt",
    "qa-opus",
  );
  assert.equal(params.model, "xai/grok-4.6:high");
});

test("Q2: applySpawnPolicy pins a QA agent off a cursor-billed id onto native grok", () => {
  const apply = (
    orch as never as {
      applySpawnPolicy: (p: Record<string, unknown>) => { action: string; reason?: string };
    }
  ).applySpawnPolicy;
  const qa = { agent: "feature-qa", model: "cursor/claude-opus-5:high" };
  const decision = apply(qa);
  assert.equal(decision.action, "pin");
  assert.equal(qa.model, "xai/grok-4.6:high", "cursor billing is out of QA scope");

  const reviewer = { agent: "plan-reviewer", model: "cursor/claude-opus-5:xhigh" };
  assert.equal(apply(reviewer).action, "pin");
  assert.equal(reviewer.model, "xai/grok-4.6:high");

  const alreadyXhigh = { agent: "qa-opus", model: "xai/grok-4.6:xhigh" };
  assert.equal(apply(alreadyXhigh).action, "pin");
  assert.equal(alreadyXhigh.model, "xai/grok-4.6:high", "xhigh is capped even on the allowed QA id");

  const alreadyHigh = { agent: "feature-qa", model: "xai/grok-4.6:high" };
  assert.equal(apply(alreadyHigh).action, "allow");
  assert.equal(alreadyHigh.model, "xai/grok-4.6:high");

  const cursorGrok = { agent: "feature-qa", model: "cursor/grok-4.6:high" };
  assert.equal(apply(cursorGrok).action, "pin");
  assert.equal(cursorGrok.model, "xai/grok-4.6:high", "cursor-billed grok is not the QA id");

  // tdd-worker keeps GLM: modelScope allows it for that agent.
  const worker = { agent: "tdd-worker", model: "zai/glm-5.3-flash:medium" };
  assert.equal(apply(worker).action, "allow");
  assert.equal(worker.model, "zai/glm-5.3-flash:medium");

  const retiredOpus = { agent: "tdd-worker", model: "cursor/claude-opus-5:high" };
  assert.equal(apply(retiredOpus).action, "pin");
  assert.equal(retiredOpus.model, "zai/glm-5.3-flash:medium", "retired cursor Opus pins onto GLM");
});

/**
 * Q3: one place to change the reviewer model.
 *
 * The QA model must be editable in `orchestrate.json` alone — not in
 * runFeatureQa, not in the spawn policy, not in each agent file.
 */
test("Q3: qaModelBase comes from the orchestrate.json sidecar", () => {
  assert.equal(orch.qaModelBase('{"qaModel":"anthropic/claude-sonnet-9"}'), "anthropic/claude-sonnet-9");
  assert.equal(
    orch.qaModelBase('{"qaModel":"openai/gpt-6:xhigh"}'),
    "openai/gpt-6",
    "a thinking suffix in config is not part of the base id",
  );
  assert.equal(orch.qaModelBase("{}"), "xai/grok-4.6", "missing key keeps the default");
  assert.equal(orch.qaModelBase("not json"), "xai/grok-4.6");
});

test("Q3: the configured model drives launch, scope check, and pin alike", () => {
  const cfg = '{"qaModel":"openai/gpt-6"}';
  assert.equal(orch.qaModelFor("feature-qa", "high", cfg), "openai/gpt-6:high");
  assert.equal(orch.qaModelFor("qa-opus", undefined, cfg), "openai/gpt-6:high");
  assert.equal(orch.isAllowedQaModel("openai/gpt-6:high", cfg), true);
  assert.equal(orch.isAllowedQaModel("anthropic/claude-opus-5:high", cfg), false);
});

test("Q3: a config-level thinking suffix is the default level for that agent", () => {
  assert.equal(orch.qaModelFor("feature-qa", undefined, '{"qaModel":"openai/gpt-6:low"}'), "openai/gpt-6:low");
  assert.equal(
    orch.qaModelFor("feature-qa", "medium", '{"qaModel":"openai/gpt-6:low"}'),
    "openai/gpt-6:medium",
    "an explicit caller level still wins",
  );
  assert.equal(
    orch.qaModelFor("feature-qa", "xhigh", '{"qaModel":"openai/gpt-6:low"}'),
    "openai/gpt-6:high",
    "xhigh is capped to high",
  );
  assert.equal(
    orch.qaModelFor("qa-opus", undefined, '{"qaModel":"openai/gpt-6:xhigh"}'),
    "openai/gpt-6:high",
    "a config-level xhigh suffix is also capped",
  );
});

/* ---------------------------------------------------------------- *
 * L4 — parent prompts must not teach the retired Node poller
 *
 * 2026-08-27: Claude followed FORBIDDEN / resumePrompt / "drives the poll"
 * and looped git pr-await 91 times. The waiter is ghl-pr-await; yield stops.
 * ---------------------------------------------------------------- */

const GIT_WORKFLOW_SKILL = "/Users/greg/.grok/skills/git-workflow/SKILL.md";

const STALE_POLLER = [
  /\bpr-poll\b/,
  /NEVER stop/,
  /until `next=done`/,
  /drives the poll/,
  /--cursor/,
  /poll budget exhausted/,
  /the driver owns the wait/,
  /the driver waits/,
  /pr-await poll/,
];

function promptContractPaths() {
  return {
    repo: "icemining",
    gitRoot: "/Users/greg/Dev/git/icemining",
    repoDir: "/Users/greg/orchestrator/icemining",
    featureDir: "/tmp/orch-contract",
    planFile: "/tmp/orch-contract/plan.md",
    statusFile: "/tmp/orch-contract/status.md",
    handoffsDir: "/tmp/orch-contract/handoffs",
    archiveDir: "/tmp/orch-contract/archive",
  };
}

function assertNoStalePoller(label: string, text: string) {
  for (const re of STALE_POLLER) {
    assert.equal(re.test(text), false, `${label} must not match ${re}: taught the retired poller`);
  }
}

test("L4: orchestrate.ts source does not teach the retired poller", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  assertNoStalePoller("orchestrate.ts", src);
  assert.equal(
    /prHandoffPrompt/.test(src),
    false,
    "the parent-as-fixer prompt is retired: a Feature verdict is dispatched to a writer in code",
  );
});

test("L4: FORBIDDEN / gitWorkflowBlock / resume / pr-open cite the skill and never make the parent the fixer", () => {
  const paths = promptContractPaths();
  const wt = "/Users/greg/Dev/git/ice-wt/feat-x";
  assert.equal(typeof orch.FORBIDDEN, "string", "FORBIDDEN must be exported");
  assert.equal(typeof orch.gitWorkflowBlock, "function", "gitWorkflowBlock must be exported");
  assert.equal(
    (orch as Record<string, unknown>).resumePrompt,
    undefined,
    "resumePrompt sent a parent turn on resume; it must be gone",
  );
  assert.equal(
    (orch as Record<string, unknown>).featurePrOpenTask,
    undefined,
    "PR-open child is gone; tdd-worker never opens a PR",
  );
  assert.equal(
    (orch as Record<string, unknown>).prHandoffPrompt,
    undefined,
    "prHandoffPrompt asked the parent to fix current-head findings; it must be gone",
  );

  const forbidden = orch.FORBIDDEN as string;
  const block = (orch.gitWorkflowBlock as Function)(paths, wt) as string;

  for (const [label, text] of [
    ["FORBIDDEN", forbidden],
    ["gitWorkflowBlock", block],
  ] as const) {
    assertNoStalePoller(label, text);
  }

  assert.match(block, /tdd-worker and fixer must NOT `git wt`/);
  assert.match(block, /must NOT `git pr-await`/);
  assert.match(block, /gh pr create/);
  assert.match(
    block,
    /not a tdd-worker|never a tdd-worker|tdd-worker never/i,
    "the Feature PR is opened by code, not by tdd-worker",
  );
  assert.equal(block.includes(GIT_WORKFLOW_SKILL), true, "gitWorkflowBlock must cite the canonical skill path");
  assert.match(forbidden, /next=yield/);
  assert.match(
    forbidden,
    /Do NOT implement product code in this parent session/,
    "the parent is still not a writer",
  );

  // The Feature-PR paragraph describes a dispatcher, not a `next=` table for
  // this session to work through itself.
  assert.match(block, /read_comments_and_fix/, "the block still names the verdict it dispatches");
  assert.match(block, /dispatch/i, "the Feature-PR paragraph must say code dispatches the verdict");
  assert.match(block, /stays idle/i, "and that the parent session stays idle");
  assert.match(
    block,
    /another fixer|keeps doing that|Never stop while review data/i,
    "gitWorkflowBlock must say later review rounds still get a fixer",
  );
  for (const re of [
    /fix current-head findings/i,
    /follow the skill `next=` table/i,
    /Then follow the skill/i,
  ]) {
    assert.equal(
      re.test(block),
      false,
      `gitWorkflowBlock must not make the parent the fixer (matched ${re})`,
    );
  }
});

/**
 * Read one `## <heading>` section out of the canonical skill.
 *
 * The skill is what a model follows when the extension is not driving it, so
 * its claims are part of this contract: a sentence there that contradicts the
 * dispatcher is an instruction to break it.
 */
function skillSection(heading: string): string {
  const src = readFileSync(GIT_WORKFLOW_SKILL, "utf8");
  const start = src.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `${GIT_WORKFLOW_SKILL} must have a "## ${heading}" section`);
  const rest = src.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

test("L4: the skill's /orchestrate section hands a Feature review fix to a writer, not to the parent", () => {
  const section = skillSection("`/orchestrate`");

  assert.match(section, /read_comments_and_fix/, "the section names the verdict it is about");
  assert.match(
    section,
    /dispatch/i,
    "a Feature-owned verdict is dispatched by the extension, the same way a Task is",
  );
  assert.match(section, /fixer/, "and the thing it is dispatched to is a writer");
  assert.match(section, /stays? idle/i, "the parent session stays idle through a review fix");
  assert.match(
    section,
    /after (that|the) writer settles/i,
    "the re-await happens after the writer settles",
  );
  assert.match(
    section,
    /code runs `git pr-await` once/i,
    "and it is code that runs it, not the parent and not the writer",
  );
  assert.match(
    section,
    /no `pr-await`|not `git pr-await`|never `git pr-await`/i,
    "a Task/fix worker still must not wait on the review itself",
  );
  assert.match(
    section,
    /another fixer|keeps doing that|Never stop while review data/i,
    "a later read_comments_and_fix still gets a fixer; one round is not the end",
  );

  for (const re of [/fix current-head findings/i, /follow the `next=` table/i]) {
    assert.equal(
      re.test(section),
      false,
      `the /orchestrate section must not make the parent the fixer (matched ${re})`,
    );
  }
});

test("L4: the skill still leaves a solo session its own latch, verdict, and fix", () => {
  const src = readFileSync(GIT_WORKFLOW_SKILL, "utf8");

  assert.match(
    src,
    /`git pr-await <PR>` \*\*once\*\*/,
    "a solo session still opens exactly one wait",
  );
  assert.match(
    src,
    /`read_comments_and_fix` \| fix current-head findings[^|]*`git pr-await` once/,
    "the solo `next=` table still tells that session to fix, push, and re-await",
  );

  const harness = skillSection("Harness");
  assert.match(harness, /wake the live parent/, "the solo latch still wakes its own session");
  assert.match(
    harness,
    /undelivered ACTIONABLE/,
    "including on an undelivered ACTIONABLE verdict, not only on merge/close",
  );
  assert.match(
    harness,
    /\/orchestrate/,
    "the Feature exception belongs where the latch's wake is described",
  );
  assert.match(
    harness,
    /dispatch/i,
    "a Feature-owned verdict is dispatched to a writer instead of waking the parent",
  );
});

test("L4: parentGitWorkflowAppend forces a skill read and keeps a Feature parent idle", () => {
  assert.equal(typeof orch.parentGitWorkflowAppend, "function");
  assert.equal(orch.parentGitWorkflowAppend({}), undefined, "unrelated sessions stay unprompted");
  const idle = orch.parentGitWorkflowAppend({ featureLive: true }) as string;
  assert.match(idle, /git-workflow\/SKILL\.md/);
  assert.match(idle, /not optional progressive disclosure/);
  assert.match(idle, /Do NOT implement product code/);
  assert.match(idle, /Stay idle/);
  assert.match(idle, /keeps dispatching while review data still says read_comments_and_fix/);
  const wake = orch.parentGitWorkflowAppend({ latchWake: true }) as string;
  assert.match(wake, /git-workflow\/SKILL\.md/);
  assert.doesNotMatch(wake, /Stay idle/, "a solo latch wake still gets to fix");
});

test("L4: orchestrate.ts registers resources_discover and before_agent_start for git-workflow", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  assert.match(src, /resources_discover/);
  assert.match(src, /before_agent_start/);
  assert.match(src, /parentGitWorkflowAppend/);
  assert.match(src, /skillPaths: \[dirname\(GIT_WORKFLOW_SKILL\)\]/);
});

/* ---------------------------------------------------------------- *
 * D1 — Feature-PR review-fix dispatch primitives
 *
 * A judgment `next=` on a Feature-owned PR must be dispatched by code, the
 * same way a Task is. These are the pure pieces that decision is built from:
 * which live Feature owns a PR number, what each `next=` means, and the
 * tdd-worker contract that carries the waiter verdict to a writer which
 * never waits on the review itself.
 * ---------------------------------------------------------------- */

function seedFeatureStatus(
  root: string,
  repo: string,
  name: string,
  fields: Record<string, string>,
): string {
  const dir = join(root, repo, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "status.md"),
    ["# Status", "", ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), ""].join("\n"),
  );
  return dir;
}

test("D1: findFeatureOwningPr binds a PR number to the live Feature that owns it", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-owner-"));
  const worktree = join(homedir(), "Dev/git/ice-wt/feat-x");
  const owned = seedFeatureStatus(root, "icemining", "feat-x", {
    repo: "icemining",
    pr: "99",
    worktree,
    phase: "pr",
  });
  seedFeatureStatus(root, "icemining", "feat-quiet", { repo: "icemining", pr: "none" });
  seedFeatureStatus(root, "icemining-devops", "feat-deploy", {
    repo: "icemining-devops",
    pr: "99",
  });
  seedFeatureStatus(root, "icemining", join("archive", "20260101T000000Z-feat-old"), {
    repo: "icemining",
    pr: "98",
  });
  seedFeatureStatus(root, "icemining", "current", { repo: "icemining", pr: "97" });

  const found = orch.findFeatureOwningPr("99", { repo: "icemining", root });
  assert.equal(found?.dir, owned, "`pr: 99` + `repo: icemining` must resolve to that Feature dir");
  assert.equal(found?.name, "feat-x");
  assert.equal(found?.repo, "icemining");
  assert.equal(found?.worktree, worktree, "the owner must carry the worktree a fixer writes in");
  assert.equal(found?.statusFile, join(owned, "status.md"));

  assert.equal(
    orch.findFeatureOwningPr("99", { repo: "icemining-devops", root })?.name,
    "feat-deploy",
    "the same number in another repo is a different pull request",
  );
  assert.equal(
    orch.findFeatureOwningPr("99", { repo: "coins-minimal", root }),
    undefined,
    "a repo with no Feature on this PR owns nothing",
  );
  assert.equal(
    orch.findFeatureOwningPr("98", { repo: "icemining", root }),
    undefined,
    "an archived Feature is history, not a live owner",
  );
  assert.equal(
    orch.findFeatureOwningPr("97", { repo: "icemining", root }),
    undefined,
    "`current/` is a legacy pointer, not a Feature",
  );
  assert.equal(
    orch.findFeatureOwningPr("none", { repo: "icemining", root }),
    undefined,
    "`pr: none` is not a PR number",
  );
  assert.equal(orch.findFeatureOwningPr("77", { repo: "icemining", root }), undefined);
});

test("D1: findFeatureOwningPr recovers ownership from branch when pr: none (no parent fixer)", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-owner-branch-"));
  const worktree = join(homedir(), "Dev/git/ice-wt/feat-coins-chart-y-zoom");
  const owned = seedFeatureStatus(root, "icemining", "coins-chart-y-zoom", {
    repo: "icemining",
    branch: "feat/coins-chart-y-zoom",
    worktree,
    phase: "pr",
    pr: "none",
  });
  seedFeatureStatus(root, "icemining", "other-draft", {
    repo: "icemining",
    branch: "feat/other",
    phase: "planning",
    pr: "none",
  });

  assert.equal(
    orch.findFeatureOwningPr("2209", { repo: "icemining", root })?.dir,
    undefined,
    "without head, pr: none is not an owner",
  );
  const found = orch.findFeatureOwningPr("2209", {
    repo: "icemining",
    root,
    head: "feat/coins-chart-y-zoom",
  });
  assert.equal(found?.dir, owned);
  assert.equal(found?.name, "coins-chart-y-zoom");
  assert.equal(found?.pr, "2209", "recovered owner carries the real PR number");
  assert.equal(found?.worktree, worktree);

  assert.equal(
    orch.findFeatureOwningPr("2209", {
      repo: "icemining",
      root,
      head: "origin/feat/coins-chart-y-zoom",
    })?.name,
    "coins-chart-y-zoom",
  );

  const numbered = seedFeatureStatus(root, "icemining", "explicit", {
    repo: "icemining",
    pr: "2209",
    branch: "feat/unrelated",
    phase: "pr",
  });
  assert.equal(
    orch.findFeatureOwningPr("2209", {
      repo: "icemining",
      root,
      head: "feat/coins-chart-y-zoom",
    })?.dir,
    numbered,
    "an explicit pr: number wins over branch recovery",
  );
});

test("D1: classifyFeaturePrNext routes every judgment next= without asking the parent to fix", () => {
  const classify = orch.classifyFeaturePrNext;

  assert.equal(
    classify("read_comments_and_fix", { prRound: 0 }),
    "spawn_writer",
    "current-head findings are fixed by a writer, not by the parent session",
  );
  for (const quiet of ["yield", "poll_again", ""]) {
    assert.equal(
      classify(quiet, { prRound: 0 }),
      "idle",
      `next=${quiet || "(none)"} must stay at 0 tokens`,
    );
  }
  assert.equal(classify("investigate_dead_reviewers", { prRound: 0 }), "reawait");
  assert.equal(classify("fix_command_or_environment", { prRound: 0 }), "notify");
  assert.equal(classify("git_pr_land", { prRound: 0 }), "land");
  assert.equal(classify("git_pr_land_continue", { prRound: 0 }), "land");
  assert.equal(classify("done", { prRound: 0 }), "archive");
  assert.equal(classify("stop", { prRound: 0 }), "confirm");

  assert.equal(
    classify("read_comments_and_fix", { prRound: 99 }),
    "spawn_writer",
    "no fixer-round cap — keep spawning until the waiter lands or the user merges",
  );
  assert.equal(
    classify("read_comments_and_fix", { prRound: 0, chainLocked: true }),
    "refuse",
    "one writer per Feature: an in-flight chain refuses a second fixer",
  );
  assert.equal(
    classify("read_comments_and_fix", { prRound: 0, workerLive: true }),
    "refuse",
    "a non-terminal worker snapshot refuses a second fixer",
  );
  assert.equal(
    classify("yield", { prRound: 0, chainLocked: true }),
    "idle",
    "a held lock must not turn a silent yield into a refusal notice",
  );
});

test("D1: dispatch next=done lands a Feature still stuck on yield", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-done-"));
  const paths = {
    repo: "icemining",
    gitRoot: dir,
    repoDir: dir,
    featureDir: dir,
    planFile: join(dir, "plan.md"),
    statusFile: join(dir, "status.md"),
    handoffsDir: join(dir, "handoffs"),
    archiveDir: join(dir, "archive"),
  };
  writeFileSync(paths.planFile, "# Feature: t\n");
  writeFileSync(
    paths.statusFile,
    [
      "# Status",
      "",
      "pause: off",
      "phase: pr",
      "pr: 2197",
      "pr_round: 0",
      "next_action: pr-await next=yield — fixer round 0 — ghl-pr-await owns the wait (0 tokens)",
      "",
    ].join("\n"),
  );
  const pi = makeFakePi();
  const { ctx } = makeFakeCtx();
  const action = (await withDeadline(
    (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
      pi,
      ctx,
      paths,
      "2197",
      dir,
      { next: "done", output: "status=landed\nnext=done\n" },
    ),
    2000,
  )) as string | { reason?: string };
  assert.notEqual((action as { reason?: string })?.reason, "TEST_TIMEOUT");
  assert.equal(action, "archive");
  const status = readFileSync(paths.statusFile, "utf8");
  assert.match(status, /phase: done/);
  assert.match(status, /next_action: landed/);
  assert.doesNotMatch(status, /next=yield/);
});

test("D1: reviewFixLaunchParams is a fixer contract that carries the verdict and never waits", () => {
  const paths = promptContractPaths();
  const worktree = "/Users/greg/Dev/git/ice-wt/feat-x";
  const params = orch.reviewFixLaunchParams(paths, "99", worktree, {
    next: "read_comments_and_fix",
    output: [
      "next=read_comments_and_fix",
      "round=3",
      "reviewer said: credit_share overflows on an attacker-sized difficulty",
    ].join("\n"),
    round: "3",
  }) as Record<string, unknown>;

  assert.equal(params.agent, "fixer", "review-fix is fixer, not tdd-worker");
  assert.equal(params.cwd, worktree, "the fixer writes in the Feature worktree only");
  assert.equal(params.context, "fresh");
  assert.equal(params.model, "cursor/grok-4.6:medium", "review-fix is the critical writer");
  assert.equal(
    String(params.output).startsWith(paths.handoffsDir),
    true,
    "the fix handoff belongs under the Feature handoffs dir",
  );
  assert.equal(
    orch.isAllowedWriterModel(String(params.model)),
    true,
    `review-fix must launch on an allowed writer model: ${String(params.model)}`,
  );

  const task = String(params.task);
  assert.match(task, /Do NOT open a PR/);
  assert.match(task, /do NOT `git wt`/);
  assert.match(task, /do NOT `git pr-await`/);
  assert.match(
    task,
    /credit_share overflows on an attacker-sized difficulty/,
    "the waiter verdict body must reach the writer",
  );
  assert.match(task, /👀/, "the writer must be told not to push over a current-head 👀");
  assert.match(task, /current head/i);
  assert.match(task, /\b99\b/, "the contract must name the PR under review");
  assert.match(task, /Review-fix round 1/, "fixer round is visible on the child");
  assert.match(task, /fixer round 1 latch/, "the post-settle await is labeled with the same round");
  assert.match(task, /git-workflow\/SKILL\.md/, "the fixer is told to read git-workflow, not skip it");
  assert.equal(params.skill, "git-workflow", "foreground spawn skill override");
  assert.deepEqual(params.skills, ["git-workflow"], "async spawn skills override (fixer.md inheritSkills: false)");
  assert.deepEqual(params.reads, [GIT_WORKFLOW_SKILL], "reads prefixes the task so SKILL.md is actually opened");
  assertNoStalePoller("reviewFixLaunchParams", task);
});

test("D1: a fixer that writes a handoff and changes nothing is disagreement, not a failed round", () => {
  assert.equal(typeof orch.fixerSettleAction, "function");
  const settle = orch.fixerSettleAction as (i: {
    ok: boolean;
    stopped?: boolean;
    handoffWritten: boolean;
  }) => string;
  assert.equal(settle({ ok: true, handoffWritten: true }), "await");
  assert.equal(settle({ ok: false, stopped: true, handoffWritten: false }), "pause");
  assert.equal(
    settle({ ok: false, handoffWritten: true }),
    "disagree",
    "acceptance failed because no files changed — the finding was already answered",
  );
  assert.equal(settle({ ok: false, handoffWritten: false }), "fail");
});

/* ---------------------------------------------------------------- *
 * D2 — a Feature review verdict is dispatched, not handed to the parent
 *
 * `read_comments_and_fix` used to arrive as a parent turn telling this
 * session to fix current-head findings and then run `git pr-await` itself —
 * the one thing FORBIDDEN says the parent must never do. It is now the same
 * machine as a Task: code spawns one `tdd-worker`, and code runs the single
 * `git pr-await` after that writer settles.
 * ---------------------------------------------------------------- */

function featurePaths(dir: string) {
  return {
    repo: "icemining",
    gitRoot: dir,
    repoDir: dir,
    featureDir: dir,
    planFile: join(dir, "plan.md"),
    statusFile: join(dir, "status.md"),
    handoffsDir: join(dir, "handoffs"),
    archiveDir: join(dir, "archive"),
  };
}

/** Answer the spawn RPC and settle the child, the way pi-subagents would. */
function autoSettleSpawn(
  pi: ReturnType<typeof makeFakePi>,
  runId: string,
  completion: Record<string, unknown> = { success: true },
) {
  const bus = (pi as never as { events: { on: Function; emit: Function } }).events;
  const seen: { params: Record<string, unknown>; count: number } = { params: {}, count: 0 };
  bus.on(
    RPC_REQUEST_EVENT,
    (req: { requestId?: string; method?: string; params?: Record<string, unknown> }) => {
      if (req?.method && req.method !== "spawn") return;
      seen.count += 1;
      if (seen.count === 1) seen.params = req?.params ?? {};
      const requestId = req?.requestId ?? "";
      const id = seen.count === 1 ? runId : `${runId}-${seen.count}`;
      queueMicrotask(() => {
        bus.emit(`${RPC_REPLY_PREFIX}${requestId}`, {
          success: true,
          data: { details: { runId: id } },
        });
        bus.emit(ASYNC_COMPLETE_EVENT, { runId: id, ...completion });
      });
    },
  );
  return seen;
}

const FIX_VERDICT = [
  "status=reviewer_verdict",
  "next=read_comments_and_fix",
  "round=3",
  "reviewer said: credit_share overflows on an attacker-sized difficulty",
].join("\n");

// ---------------------------------------------------------------------------
// F4: a verdict is spent only when dispatch accepts it.
//
// The verdict used to be marked delivered before the dispatch ran, and dispatch
// legitimately returns `refuse` while a fixer holds the chain lock for 30-60
// minutes. The verdict was consumed and never retried, and the waiter does not
// re-emit it — so the Feature stalled with findings outstanding.
// ---------------------------------------------------------------------------

test("F4: a refused read_comments_and_fix records pending_verdict instead of vanishing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-refuse-"));
  const paths = featurePaths(dir);
  writeFileSync(paths.planFile, "# Feature: t\n");
  writeFileSync(
    paths.statusFile,
    [
      "# Status",
      "",
      "pause: off",
      `worktree: ${dir}`,
      "phase: pr",
      "pr: 99",
      "pr_round: 0",
      // A live writer this Feature already owns: exactly the window in which a
      // late verdict used to be swallowed.
      "worker_run_id: run-live",
      `worker_run_dir: ${dir}/live-run`,
      "",
    ].join("\n"),
  );
  mkdirSync(join(dir, "live-run"), { recursive: true });
  writeFileSync(
    join(dir, "live-run", "status.json"),
    JSON.stringify({ state: "running", pid: process.pid, startedAt: Date.now() }),
  );

  const pi = makeFakePi(async () => ({ code: 0, stdout: "", stderr: "" }));
  const spawn = autoSettleSpawn(pi, "run-should-not-happen");
  const { ctx, notices } = makeFakeCtx();

  const action = await withDeadline(
    (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
      pi,
      ctx,
      paths,
      "99",
      dir,
      { done: false, next: "read_comments_and_fix", output: FIX_VERDICT, round: "3" },
    ),
    4000,
  );

  assert.equal(action, "refuse", "a live writer must refuse a second fixer");
  assert.equal(spawn.count, 0, "no second writer on the same branch");

  const status = readFileSync(paths.statusFile, "utf8");
  const pending = status.match(/^pending_verdict:\s*(.+)$/m)?.[1]?.trim() ?? "";
  assert.ok(
    pending && pending !== "none",
    `a refused verdict must be recorded so it can be drained; status was:\n${status}`,
  );
  assert.ok(
    notices.some((n) => /99/.test(n)),
    `the refusal is reported; got ${notices.join(" | ")}`,
  );

  // Refusing twice must not append a second record or spam a second toast.
  const before = notices.length;
  await withDeadline(
    (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
      pi,
      ctx,
      paths,
      "99",
      dir,
      { done: false, next: "read_comments_and_fix", output: FIX_VERDICT, round: "3" },
    ),
    4000,
  );
  const again = readFileSync(paths.statusFile, "utf8");
  assert.equal(
    again.match(/^pending_verdict:/gm)?.length,
    1,
    "pending_verdict is one field, not an append log",
  );
  assert.equal(
    again.match(/^pending_verdict:\s*(.+)$/m)?.[1]?.trim(),
    pending,
    "the same verdict keeps the same fingerprint",
  );
  assert.equal(notices.length, before, "an unchanged refusal must not toast again");
  rmSync(dir, { recursive: true, force: true });
});

test("F4: an accepted verdict marks the waiter file spent before the fixer finishes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-accept-"));
  const stateDir = mkdtempSync(join(tmpdir(), "orch-accept-state-"));
  const prevStateDir = process.env.GHL_LATCH_STATE_DIR;
  process.env.GHL_LATCH_STATE_DIR = stateDir;
  const paths = featurePaths(dir);
  writeFileSync(paths.planFile, "# Feature: t\n");
  writeFileSync(
    paths.statusFile,
    [
      "# Status",
      "",
      "pause: off",
      `worktree: ${dir}`,
      "phase: pr",
      "pr: 99",
      "pr_round: 0",
      "worker_run_id: none",
      "worker_run_dir: none",
      "",
    ].join("\n"),
  );
  // Both spellings on disk, both undelivered.
  const manualNew = join(stateDir, "manual-icemining-99.json");
  const manualOld = join(stateDir, "manual-99.json");
  for (const path of [manualNew, manualOld]) {
    writeFileSync(
      path,
      JSON.stringify({ pr: "99", lastNext: "read_comments_and_fix", verdictDelivered: false }),
    );
  }

  const pi = makeFakePi(async () => ({
    code: 0,
    stdout: "status=handed_off\nnext=yield\n",
    stderr: "",
  }));
  autoSettleSpawn(pi, "run-accept-1");
  const { ctx } = makeFakeCtx();

  try {
    const action = await withDeadline(
      (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
        pi,
        ctx,
        paths,
        "99",
        dir,
        { done: false, next: "read_comments_and_fix", output: FIX_VERDICT, round: "3" },
      ),
      8000,
    );
    assert.equal(action, "spawn_writer");
    for (const path of [manualNew, manualOld]) {
      const spent = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(
        spent.verdictDelivered,
        true,
        `${path} must be spent once the action was accepted, so the 15s watch does not re-dispatch it`,
      );
    }
    const status = readFileSync(paths.statusFile, "utf8");
    const pending = status.match(/^pending_verdict:\s*(.+)$/m)?.[1]?.trim();
    assert.ok(
      !pending || pending === "none",
      `an accepted verdict leaves nothing pending; got ${pending}`,
    );
  } finally {
    if (prevStateDir === undefined) delete process.env.GHL_LATCH_STATE_DIR;
    else process.env.GHL_LATCH_STATE_DIR = prevStateDir;
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("D2: a Feature read_comments_and_fix spawns one fixer and never asks the parent to fix", async () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).dispatchFeaturePrVerdict,
    "function",
    "dispatchFeaturePrVerdict must be exported so the Feature verdict path is testable",
  );

  const dir = mkdtempSync(join(tmpdir(), "orch-fix-"));
  const paths = featurePaths(dir);
  writeFileSync(paths.planFile, "# Feature: t\n");
  writeFileSync(
    paths.statusFile,
    [
      "# Status",
      "",
      "pause: off",
      `worktree: ${dir}`,
      "phase: pr",
      "pr: 99",
      "pr_round: 0",
      "worker_run_id: none",
      "worker_run_dir: none",
      "",
    ].join("\n"),
  );

  const execs: string[] = [];
  const pi = makeFakePi(async (cmd, args) => {
    execs.push([cmd, ...(args ?? [])].join(" "));
    // The re-await after a push: the waiter takes the review back over, and
    // reports its own review round, which is not the fix-spawn count.
    return { code: 0, stdout: "status=handed_off\nnext=yield\nround=7\n", stderr: "" };
  });
  const spawn = autoSettleSpawn(pi, "run-fix-1");
  const { ctx, notices } = makeFakeCtx();

  const action = (await withDeadline(
    (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
      pi,
      ctx,
      paths,
      "99",
      dir,
      {
        done: false,
        next: "read_comments_and_fix",
        output: FIX_VERDICT,
        round: "3",
      },
    ),
    4000,
  )) as string | { reason?: string };

  assert.notEqual(
    (action as { reason?: string })?.reason,
    "TEST_TIMEOUT",
    "dispatchFeaturePrVerdict never settled",
  );
  assert.equal(action, "spawn_writer", "a current-head finding dispatches a writer");

  // 1. The parent was never asked to implement anything.
  const turns = parentTurns(pi);
  assert.equal(
    turns.length,
    0,
    `the parent must stay idle; it was sent: ${turns.map((t) => t.text.slice(0, 80)).join(" | ")}`,
  );
  for (const turn of turns) {
    assert.doesNotMatch(turn.text, /fix current-head findings/i);
    assert.doesNotMatch(turn.text, /You are the parent orchestrator/);
  }
  assert.equal(
    notices.some((n) => /99/.test(n)),
    true,
    `a toast about PR 99 is fine and expected: ${notices.join(" | ")}`,
  );

  // 2. One fixer carrying the Task forbids and the waiter verdict.
  assert.equal(spawn.count, 1, "exactly one fix writer per verdict");
  assert.equal(spawn.params.agent, "fixer");
  assert.equal(spawn.params.cwd, dir, "the fixer writes in the Feature worktree");
  const task = String(spawn.params.task);
  assert.match(task, /do NOT `git pr-await`/, "the child must never wait on the review");
  assert.match(task, /Do NOT open a PR/);
  assert.match(task, /credit_share overflows on an attacker-sized difficulty/);

  // 3. Code — not the child — ran exactly one git pr-await after it settled.
  assert.deepEqual(
    execs,
    ["git pr-await 99"],
    `code runs one git pr-await after the writer settles: ${execs.join(" | ")}`,
  );

  // 4. pr_round is the fix-spawn count, and the waiter's round=7 did not eat it.
  const status = readFileSync(paths.statusFile, "utf8");
  assert.match(status, /^pr_round: 1$/m, `pr_round must count fix spawns: ${status}`);
});

test("D2: drivePrAwait reports the waiter round without overwriting the fix-spawn count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-round-"));
  const paths = featurePaths(dir);
  writeFileSync(paths.planFile, "# Feature: t\n");
  writeFileSync(
    paths.statusFile,
    ["# Status", "", "pause: off", "pr: 99", "pr_round: 1", ""].join("\n"),
  );

  const pi = makeFakePi(async () => ({
    code: 0,
    stdout: "status=handed_off\nnext=yield\nround=7\n",
    stderr: "",
  }));
  const { ctx, notices } = makeFakeCtx();

  const result = (await withDeadline(
    (orch as never as { drivePrAwait: Function }).drivePrAwait(pi, ctx, paths, "99", dir),
    2000,
  )) as { silent?: boolean; round?: string; reason?: string };

  assert.notEqual(result.reason, "TEST_TIMEOUT");
  assert.equal(result.silent, true);
  assert.match(
    readFileSync(paths.statusFile, "utf8"),
    /^pr_round: 1$/m,
    "the waiter's review round must not clobber the fix-spawn count",
  );
  assert.equal(
    notices.some((n) => /round 7/.test(n)),
    true,
    `the waiter round is still worth a toast: ${notices.join(" | ")}`,
  );
  assert.equal(parentTurns(pi).length, 0, "a yield is 0 tokens");
});

test("D2: a follow-up read_comments_and_fix after a fixer still spawns the next fixer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-fix-loop-"));
  const paths = featurePaths(dir);
  writeFileSync(paths.planFile, "# Feature: t\n");
  writeFileSync(
    paths.statusFile,
    [
      "# Status",
      "",
      "pause: off",
      `worktree: ${dir}`,
      "phase: pr",
      "pr: 99",
      "pr_round: 0",
      "worker_run_id: none",
      "worker_run_dir: none",
      "",
    ].join("\n"),
  );

  const execs: string[] = [];
  let awaits = 0;
  const pi = makeFakePi(async (cmd, args) => {
    execs.push([cmd, ...(args ?? [])].join(" "));
    if (cmd === "git" && args?.[0] === "pr-await") {
      awaits += 1;
      if (awaits === 1) {
        return {
          code: 0,
          stdout: [
            "status=reviewer_verdict",
            "next=read_comments_and_fix",
            "round=4",
            "reviewer said: second-round finding still open",
          ].join("\n"),
          stderr: "",
        };
      }
    }
    return { code: 0, stdout: "status=handed_off\nnext=yield\nround=8\n", stderr: "" };
  });
  const spawn = autoSettleSpawn(pi, "run-fix-loop");
  const { ctx } = makeFakeCtx();

  const action = (await withDeadline(
    (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
      pi,
      ctx,
      paths,
      "99",
      dir,
      { done: false, next: "read_comments_and_fix", output: FIX_VERDICT, round: "3" },
    ),
    6000,
  )) as string | { reason?: string };

  assert.notEqual((action as { reason?: string })?.reason, "TEST_TIMEOUT");
  assert.equal(action, "spawn_writer");
  assert.equal(spawn.count, 2, "the second current-head verdict must spawn a second fixer");
  assert.deepEqual(execs, ["git pr-await 99", "git pr-await 99"]);
  assert.match(readFileSync(paths.statusFile, "utf8"), /^pr_round: 2$/m);
  assert.equal(parentTurns(pi).length, 0, "the parent stays idle across both rounds");
  assert.match(
    String(spawn.params.task),
    /credit_share overflows/,
    "first spawn still carries the original verdict",
  );
});

/* ---------------------------------------------------------------- *
 * D3 — the other verdicts, one writer, and the twenty-fixer bound
 *
 * `read_comments_and_fix` is the only verdict that earns a writer. A dead
 * reviewer is a re-await, an environment problem is a report, a Feature that
 * already has a writer refuses a second one, and a PR that has spent its
 * twenty fixers is landed rather than parked on a question for the user.
 * ---------------------------------------------------------------- */

/** A Feature at `phase: pr` on PR 99 with `pr_round` fix-writers spent. */
function prFeatureFixture(prRound: number, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "orch-verdict-"));
  const paths = featurePaths(dir);
  writeFileSync(paths.planFile, "# Feature: t\n");
  writeFileSync(
    paths.statusFile,
    [
      "# Status",
      "",
      "pause: off",
      `worktree: ${dir}`,
      "phase: pr",
      "pr: 99",
      `pr_round: ${prRound}`,
      "worker_run_id: none",
      "worker_run_dir: none",
      ...extra,
      "",
    ].join("\n"),
  );
  return { dir, paths };
}

/** Record every `pi.exec` argv so a writer-free verdict can be proven quiet. */
function execRecorder(stdout = "", code = 0) {
  const execs: string[] = [];
  const pi = makeFakePi(async (cmd, args) => {
    execs.push([cmd, ...(args ?? [])].join(" "));
    return { code, stdout, stderr: "" };
  });
  return { pi, execs };
}

function dispatchVerdict(
  pi: ReturnType<typeof makeFakePi>,
  ctx: unknown,
  paths: ReturnType<typeof featurePaths>,
  dir: string,
  next: string,
  output = `status=reviewer_verdict\nnext=${next}\nround=4\n`,
): Promise<unknown> {
  return withDeadline(
    (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
      pi,
      ctx,
      paths,
      "99",
      dir,
      { done: false, next, output, round: "4" },
    ),
    4000,
  );
}

test("D3: investigate_dead_reviewers re-awaits in code and never spawns a writer", async () => {
  const { dir, paths } = prFeatureFixture(0);
  const { pi, execs } = execRecorder("status=handed_off\nnext=yield\nround=5\n");
  const spawn = autoSettleSpawn(pi, "run-dead-1");
  const { ctx, notices } = makeFakeCtx();

  const action = await dispatchVerdict(pi, ctx, paths, dir, "investigate_dead_reviewers");

  assert.equal(action, "reawait", "a dead reviewer is answered by asking the waiter again");
  assert.equal(spawn.count, 0, "a dead reviewer is not a code finding — no tdd-worker");
  assert.deepEqual(
    execs,
    ["git pr-await 99"],
    `exactly one re-await, run by code: ${execs.join(" | ")}`,
  );
  assert.equal(
    notices.some((n) => /99/.test(n)),
    true,
    `the user is told what happened: ${notices.join(" | ")}`,
  );
  assert.equal(parentTurns(pi).length, 0, "the parent is not woken to investigate");
});

test("D3: a re-await that returns read_comments_and_fix still spawns a fixer", async () => {
  const { dir, paths } = prFeatureFixture(0);
  const execs: string[] = [];
  let awaits = 0;
  const pi = makeFakePi(async (cmd, args) => {
    execs.push([cmd, ...(args ?? [])].join(" "));
    if (cmd === "git" && args?.[0] === "pr-await") {
      awaits += 1;
      if (awaits === 1) {
        return { code: 0, stdout: FIX_VERDICT, stderr: "" };
      }
    }
    return { code: 0, stdout: "status=handed_off\nnext=yield\nround=6\n", stderr: "" };
  });
  const spawn = autoSettleSpawn(pi, "run-dead-then-fix");
  const { ctx } = makeFakeCtx();

  const action = await withDeadline(
    (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
      pi,
      ctx,
      paths,
      "99",
      dir,
      {
        done: false,
        next: "investigate_dead_reviewers",
        output: "next=investigate_dead_reviewers\nround=4\n",
        round: "4",
      },
    ),
    6000,
  );

  assert.notEqual((action as { reason?: string })?.reason, "TEST_TIMEOUT");
  assert.equal(action, "reawait");
  assert.equal(spawn.count, 1, "the follow-up current-head verdict must still get a fixer");
  assert.deepEqual(execs, ["git pr-await 99", "git pr-await 99"]);
  assert.equal(parentTurns(pi).length, 0);
});

test("D3: fix_command_or_environment reports and dispatches nothing", async () => {
  const { dir, paths } = prFeatureFixture(0);
  const { pi, execs } = execRecorder();
  const spawn = autoSettleSpawn(pi, "run-env-1");
  const { ctx, notices } = makeFakeCtx();

  const action = await dispatchVerdict(pi, ctx, paths, dir, "fix_command_or_environment");

  assert.equal(action, "notify", "an environment failure has no writer contract");
  assert.equal(spawn.count, 0, "never a tdd-worker for a broken command or environment");
  assert.deepEqual(execs, [], `nothing is run for an environment verdict: ${execs.join(" | ")}`);
  assert.equal(
    notices.some((n) => /99/.test(n)),
    true,
    `the user is told the verdict: ${notices.join(" | ")}`,
  );
  assert.equal(parentTurns(pi).length, 0, "the parent is not asked to fix the environment");
});

test("D3: a Feature that already has a chain in flight refuses a second fixer", async () => {
  const { dir, paths } = prFeatureFixture(0);
  const { pi, execs } = execRecorder();
  const spawn = autoSettleSpawn(pi, "run-refuse-1");
  const { ctx, notices } = makeFakeCtx();

  let release = () => {};
  const held = (orch as never as { withChainLock: Function }).withChainLock(
    paths.featureDir,
    () => new Promise<void>((r) => (release = r)),
  ) as Promise<boolean>;

  const action = await dispatchVerdict(pi, ctx, paths, dir, "read_comments_and_fix");
  release();
  await held;

  assert.equal(action, "refuse", "one writer per worktree");
  assert.equal(spawn.count, 0, "a second fixer would push over the first one's commits");
  assert.deepEqual(execs, [], `a refused verdict runs nothing: ${execs.join(" | ")}`);
  assert.equal(
    notices.some((n) => /99/.test(n)),
    true,
    `the refusal is visible: ${notices.join(" | ")}`,
  );
  assert.equal(parentTurns(pi).length, 0, "a refusal does not wake the parent to implement");
});

test("D3: a live worker_run_id snapshot refuses a second fixer after a session death", async () => {
  const { dir, paths } = prFeatureFixture(0);
  const runDir = writeRunStatus(dir, {
    state: "running",
    startedAt: Date.now(),
    pid: process.pid,
    steps: [{ status: "running" }],
  });
  writeFileSync(
    paths.statusFile,
    readFileSync(paths.statusFile, "utf8")
      .replace(/^worker_run_id: none$/m, "worker_run_id: run-live-1")
      .replace(/^worker_run_dir: none$/m, `worker_run_dir: ${runDir}`),
  );

  const { pi, execs } = execRecorder();
  const spawn = autoSettleSpawn(pi, "run-refuse-2");
  const { ctx, notices } = makeFakeCtx();

  const action = await dispatchVerdict(pi, ctx, paths, dir, "read_comments_and_fix");

  assert.equal(action, "refuse", "a non-terminal writer snapshot still owns this Feature");
  assert.equal(spawn.count, 0, "no second writer while the recorded run is alive");
  assert.deepEqual(execs, [], `a refused verdict runs nothing: ${execs.join(" | ")}`);
  assert.equal(
    notices.some((n) => /99/.test(n)),
    true,
    `the refusal is visible: ${notices.join(" | ")}`,
  );
  assert.equal(parentTurns(pi).length, 0, "a refusal does not wake the parent to implement");
});

test("D3: a completed worker_run_id is swept and the next fixer may spawn", async () => {
  const { dir, paths } = prFeatureFixture(0);
  const runDir = writeRunStatus(dir, {
    state: "complete",
    startedAt: 1,
    endedAt: 2,
    pid: 999999,
    steps: [{ status: "complete" }],
  });
  writeFileSync(
    paths.statusFile,
    readFileSync(paths.statusFile, "utf8")
      .replace(/^worker_run_id: none$/m, "worker_run_id: run-dead-1")
      .replace(/^worker_run_dir: none$/m, `worker_run_dir: ${runDir}`),
  );

  const { pi, execs } = execRecorder("status=handed_off\nnext=yield\nround=1\n");
  const spawn = autoSettleSpawn(pi, "run-sweep-1");
  const { ctx } = makeFakeCtx();

  const action = await dispatchVerdict(pi, ctx, paths, dir, "read_comments_and_fix", FIX_VERDICT);

  assert.equal(action, "spawn_writer", "a finished writer must not block the next round");
  assert.equal(spawn.count, 1);
  assert.match(readFileSync(paths.statusFile, "utf8"), /^worker_run_id: none$/m);
  assert.deepEqual(execs, ["git pr-await 99"]);
  assert.equal(parentTurns(pi).length, 0);
});

test("D3: a high fixer round still spawns and never lands from read_comments_and_fix", async () => {
  const { dir, paths } = prFeatureFixture(5);
  const { pi, execs } = execRecorder("status=handed_off\nnext=yield\nround=21\n");
  const spawn = autoSettleSpawn(pi, "run-nocap-1");
  const { ctx } = makeFakeCtx();

  const action = await dispatchVerdict(pi, ctx, paths, dir, "read_comments_and_fix", FIX_VERDICT);
  assert.equal(action, "spawn_writer", "no round cap on fixers");
  assert.equal(spawn.count, 1);
  assert.match(readFileSync(paths.statusFile, "utf8"), /^pr_round: 6$/m);
  assert.deepEqual(execs, ["git pr-await 99"]);
  for (const argv of execs) assert.doesNotMatch(argv, /gh pr merge|git pr-land/);
  assert.equal(parentTurns(pi).length, 0);
});

test("D3: a land that failed because the PR is already merged is done, not a retry", async () => {
  const { dir, paths } = prFeatureFixture(0);
  const { pi, execs } = execRecorder(
    "error: branch moved after merge — refusing to delete feat/x\n",
    1,
  );
  const spawn = autoSettleSpawn(pi, "run-cap-3");
  const { ctx } = makeFakeCtx();

  const action = await dispatchVerdict(pi, ctx, paths, dir, "git_pr_land", FIX_VERDICT);

  assert.equal(action, "land");
  assert.equal(spawn.count, 0);
  assert.deepEqual(execs, ["git pr-land 99"], `one land attempt only: ${execs.join(" | ")}`);
  assert.match(
    readFileSync(paths.statusFile, "utf8"),
    /^phase: done$/m,
    "an already-merged PR is landed, not a retry loop",
  );
  assert.equal(parentTurns(pi).length, 0);
});

test("D3: yield and poll_again cost nothing — no writer, no exec, no parent turn", async () => {
  for (const quiet of ["yield", "poll_again"]) {
    const { dir, paths } = prFeatureFixture(0);
    const { pi, execs } = execRecorder();
    const spawn = autoSettleSpawn(pi, `run-quiet-${quiet}`);
    const { ctx } = makeFakeCtx();

    const action = await dispatchVerdict(pi, ctx, paths, dir, quiet);

    assert.equal(action, "idle", `next=${quiet} is the waiter's business`);
    assert.equal(spawn.count, 0, `next=${quiet} must not spawn a writer`);
    assert.deepEqual(execs, [], `next=${quiet} must not run anything`);
    assert.equal(parentTurns(pi).length, 0, `next=${quiet} must cost 0 tokens`);
  }
});

/* ---------------------------------------------------------------- *
 * T — parent stays idle; budgets are ceilings; farm matches repo
 *
 * The leftover sendTurn(planner/resume/review) path is how a parent model
 * turn still starts. Resume with a live worker must not be one of those.
 * Parent-tool tdd-worker/QA/planner spawns are blocked; extension rpcCall
 * still pins and launches. Turn budgets min() rather than overwrite.
 * ---------------------------------------------------------------- */

test("T1: orchestrate.ts does not sendTurn planner, review, or resume prompts", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  for (const name of [
    "sendTurn",
    "plannerPrompt",
    "resumePrompt",
    "reviewPrompt",
    "prPrompt",
    "todoSyncBlock",
    "nameAfterPlanBlock",
    "prHandoffPrompt",
  ]) {
    assert.equal(
      new RegExp(`\\bfunction\\s+${name}\\b`).test(src),
      false,
      `${name} must not exist — parent-prompt path is gone`,
    );
    assert.equal(
      new RegExp(`\\b${name}\\s*\\(`).test(src),
      false,
      `${name}(...) must not be called`,
    );
  }
  assert.equal(
    /You are the parent orchestrator/.test(src),
    false,
    "no parent-orchestrator prompt text",
  );
});

test("T1: subagentToolGuard blocks every orchestrate child on the parent tool path", () => {
  const guard = (
    orch as never as {
      subagentToolGuard: (event: {
        toolName?: string;
        input?: Record<string, unknown>;
      }) => { block: true; reason: string } | undefined;
    }
  ).subagentToolGuard;
  for (const agent of ["tdd-worker", "fixer", "feature-qa", "qa-opus", "plan-reviewer", "planner"]) {
    const blocked = guard({ toolName: "subagent", input: { agent, model: "xai/grok-4.6:high" } });
    assert.equal(blocked?.block, true, `parent must not spawn ${agent}`);
  }
  assert.equal(
    guard({ toolName: "subagent", input: { action: "status", id: "run-1" } }),
    undefined,
    "management RPCs stay allowed",
  );
});

test("T1: applySpawnPolicy still pins writers for the extension rpcCall path", () => {
  const apply = (
    orch as never as {
      applySpawnPolicy: (p: Record<string, unknown>) => { action: string };
    }
  ).applySpawnPolicy;
  const writer = { agent: "tdd-worker", model: "cursor/gpt-5.6-luna:xhigh" };
  assert.equal(apply(writer).action, "allow");
  const planner = { agent: "planner", model: "xai/grok-4.6:high" };
  assert.notEqual(apply(planner).action, "reject");
});

test("T2: pinWriterCaps is a ceiling — a smaller requested budget survives", () => {
  const apply = (
    orch as never as {
      applySpawnPolicy: (p: Record<string, unknown>) => { action: string };
    }
  ).applySpawnPolicy;
  const open = {
    agent: "tdd-worker",
    model: "cursor/gpt-5.6-luna:xhigh",
    turnBudget: { maxTurns: 15, graceTurns: 5 },
  };
  apply(open);
  assert.equal(
    (open.turnBudget as { maxTurns: number }).maxTurns,
    15,
    "PR-open must not be raised to 220 turns",
  );

  const qa = {
    agent: "feature-qa",
    model: "xai/grok-4.6:high",
    turnBudget: { maxTurns: 400, graceTurns: 50 },
  };
  apply(qa);
  assert.equal(
    (qa.turnBudget as { maxTurns: number }).maxTurns,
    60,
    "QA above 60 is clamped",
  );

  const planner = {
    agent: "planner",
    model: "xai/grok-4.6:high",
    turnBudget: { maxTurns: 1000, graceTurns: 100 },
  };
  apply(planner);
  assert.equal(
    (planner.turnBudget as { maxTurns: number }).maxTurns,
    80,
    "planner above 80 is clamped",
  );
});

test("T2: plannerLaunchParams is a planner child, not a parent prompt", () => {
  assert.equal(typeof orch.plannerLaunchParams, "function", "plannerLaunchParams must be exported");
  const params = (orch.plannerLaunchParams as Function)(
    promptContractPaths(),
    "bound objective",
  ) as Record<string, unknown>;
  assert.equal(params.agent, "planner");
  assert.equal(params.model, "xai/grok-4.6:high");
  assert.equal(params.context, "fresh");
  const task = String(params.task);
  assert.match(task, /bound objective/);
  assert.doesNotMatch(task, /You are the parent orchestrator/);
  assert.doesNotMatch(task, /todoSyncBlock|Visible todos/);
  assert.equal((params.turnBudget as { maxTurns: number }).maxTurns, 80);
});

test("T2: planner always instructs the specific Feature name, never bare /orchestrate approve", () => {
  const params = (orch.plannerLaunchParams as Function)(
    promptContractPaths(),
    "bound objective",
  ) as Record<string, unknown>;
  const task = String(params.task);
  assert.doesNotMatch(
    task,
    /next_action: wait for \/orchestrate approve \(/,
    "status seed must not teach a nameless approve command",
  );
  assert.match(
    task,
    /\/orchestrate approve <kebab-of-# Feature: title>/,
    "planner must be told the named approve command shape",
  );
  assert.match(task, /never a bare `\/orchestrate approve`/);
});

test("T2: reviewLaunchParams is a plan-reviewer child", () => {
  assert.equal(typeof orch.reviewLaunchParams, "function", "reviewLaunchParams must be exported");
  const params = (orch.reviewLaunchParams as Function)(
    promptContractPaths(),
    "/tmp/wt",
    "feat-x",
  ) as Record<string, unknown>;
  assert.equal(params.agent, "plan-reviewer");
  assert.equal(params.model, "xai/grok-4.6:high");
  assert.equal(params.cwd, "/tmp/wt");
  assert.equal((params.turnBudget as { maxTurns: number }).maxTurns, 60);
});

test("T3: QA findings, Tasks, and qa_pass_cap are bounded", () => {
  assert.equal(orch.MAX_QA_FINDINGS, 8);
  assert.equal(orch.MAX_TASKS, 12);
  assert.equal(orch.MAX_QA_PASS_CAP, 2);
  assert.equal(typeof orch.clampedQaPassCap, "function");
  const clamp = orch.clampedQaPassCap as (n: number) => number;
  assert.equal(clamp(99), 2);
  assert.equal(clamp(1), 1);
  assert.equal(clamp(0), 0);
  assert.equal(typeof orch.taskCountError, "function");
  assert.match(String((orch.taskCountError as Function)(13)), /12/);
  assert.equal((orch.taskCountError as Function)(12), undefined);

  const dir = mkdtempSync(join(tmpdir(), "orch-qa-cap-"));
  const planFile = join(dir, "plan.md");
  writeFileSync(
    planFile,
    "# Feature: cap\n\n> Status: APPROVED\n\n## Tasks\n\n### Task 1 — already\n- Status: done\n",
  );
  const findings = Array.from({ length: 12 }, (_, i) => ({
    severity: "fix-now",
    title: `finding ${i + 1}`,
    goal: "g",
    complexity: "simple",
    redTest: "t",
    command: "true",
    implement: "i",
  }));
  const added = orch.appendQaTasks(
    { planFile, handoffsDir: join(dir, "handoffs") } as never,
    findings as never,
  );
  assert.equal(added, 8, "QA may not append more than MAX_QA_FINDINGS Tasks");
  const plan = readFileSync(planFile, "utf8");
  assert.equal([...plan.matchAll(/^### Task /gm)].length, 9, "1 existing + 8 appended");
});

test("T4: worktree farm is per-repo, not always ice-wt", () => {
  assert.equal(typeof orch.worktreeFarmFor, "function");
  const farm = orch.worktreeFarmFor as (repo: string) => string;
  const pathFor = orch.worktreePathFor as (branch: string, repo?: string) => string;
  assert.equal(farm("icemining"), join(homedir(), "Dev/git/ice-wt"));
  assert.equal(farm("icemining-devops"), join(homedir(), "Dev/git/devops-wt"));
  assert.equal(farm("other"), join(homedir(), "Dev/git/other-wt"));
  assert.equal(pathFor("feat/foo", "icemining-devops"), join(homedir(), "Dev/git/devops-wt/feat-foo"));
  assert.doesNotMatch(pathFor("feat/foo", "icemining-devops"), /ice-wt/);

  const hostFarm = join(homedir(), ".pi/agent/worktrees");
  assert.equal(
    farm("pi-extensions"),
    hostFarm,
    "host Features farm outside Pi auto-load; never ~/.pi/agent/extensions and never Dev/git",
  );
  assert.equal(
    pathFor("feat/orchestrate-qa-remediations", "pi-extensions"),
    join(hostFarm, "feat-orchestrate-qa-remediations"),
  );
  assert.doesNotMatch(pathFor("feat/x", "pi-extensions"), /\/extensions(\/|$)/);
  assert.doesNotMatch(pathFor("feat/x", "pi-extensions"), /\/Dev\/git\//);
});

test("T4: a host Feature worktree is never the live extensions checkout", () => {
  assert.equal(typeof orch.isLiveHostCheckout, "function", "isLiveHostCheckout must be exported");
  const live = orch.isLiveHostCheckout as (dir: string) => boolean;
  const ext = join(homedir(), ".pi/agent/extensions");
  assert.equal(live(ext), true, "the auto-loaded checkout is live");
  assert.equal(live(join(ext, "tests")), true);
  assert.equal(live(join(homedir(), ".pi/agent/worktrees/feat-x")), false);
  assert.equal(live(join(homedir(), "Dev/git/ice-wt/feat-x")), false);
});

test("T5: detectFeatureBase follows cwd, including host folders and a repo switch", () => {
  assert.equal(typeof orch.detectFeatureBase, "function", "detectFeatureBase must be exported");
  assert.equal(typeof orch.baseDecision, "function", "baseDecision must be exported");
  const detect = orch.detectFeatureBase as (
    cwd: string,
    gitRoot: string,
    hosts?: { id: string; gitRoot: string; label: string }[],
  ) => { id: string; gitRoot: string; label: string } | undefined;
  const decide = orch.baseDecision as Function;

  const ice = join(homedir(), "Dev/git/icemining");
  const devops = join(homedir(), "Dev/git/icemining-devops");
  const ext = join(homedir(), ".pi/agent/extensions");
  const hosts = [{ id: "pi-extensions", gitRoot: ext, label: "pi-extensions" }];

  const fromIce = detect(ice, ice, hosts);
  assert.equal(fromIce?.id, "icemining");
  assert.equal(fromIce?.gitRoot, ice);

  const fromDevops = detect(devops, devops, hosts);
  assert.equal(fromDevops?.id, "icemining-devops");

  const fromExt = detect(ext, ext, hosts);
  assert.equal(fromExt?.id, "pi-extensions", "extensions cwd is a host base, not icemining");
  assert.equal(fromExt?.gitRoot, ext);

  const fromExtSub = detect(join(ext, "tests"), join(ext, "tests"), hosts);
  assert.equal(fromExtSub?.id, "pi-extensions");

  const hostWt = join(homedir(), ".pi/agent/worktrees/feat-foo");
  const fromHostWt = detect(hostWt, hostWt, hosts);
  assert.equal(
    fromHostWt?.id,
    "pi-extensions",
    "a host lane under ~/.pi/agent/worktrees is still the host base, not an unknown cwd",
  );

  assert.equal(decide(fromIce, undefined).action, "use", "first Feature in this cwd needs no prompt");
  assert.equal(decide(fromIce, fromIce).action, "use", "same base as last needs no prompt");
  const switched = decide(fromExt, fromIce);
  assert.equal(switched.action, "confirm-switch", "cwd moved off the last Feature's repo — ask");
  assert.equal(switched.to.id, "pi-extensions");
  assert.equal(switched.from.id, "icemining");
  assert.equal(decide(undefined, fromIce).action, "select", "unknown cwd must pick a base");
});

test("T6: uiNotify swallows reload-stale ctx and rethrows other errors", () => {
  assert.equal(typeof orch.uiNotify, "function");
  assert.equal(typeof orch.isStaleCtxError, "function");
  assert.equal(
    orch.isStaleCtxError(
      new Error(
        "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx",
      ),
    ),
    true,
  );
  assert.equal(orch.isStaleCtxError(new Error("boom")), false);

  const stale = {
    ui: {
      notify: () => {
        throw new Error(
          "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.reload().",
        );
      },
    },
  };
  assert.doesNotThrow(() => (orch.uiNotify as Function)(stale, "Plan ready", "info"));

  const other = {
    ui: {
      notify: () => {
        throw new Error("disk full");
      },
    },
  };
  assert.throws(() => (orch.uiNotify as Function)(other, "x", "info"), /disk full/);
});

test("T8: taskWorkerCwd follows cd /abs && in the Task command", () => {
  assert.equal(typeof orch.taskWorkerCwd, "function");
  const cwd = orch.taskWorkerCwd as (
    body: string,
    fallback: string,
    plan?: string,
    branch?: string,
  ) => string;
  const ice = join(homedir(), "Dev/git/ice-wt/feat-x");
  const devops = join(homedir(), "Dev/git/ice-devops-flagfix");
  const body = [
    "### Task 1 — skip",
    "- Command:",
    "```",
    `cd ${devops} && rtk node --test scripts/check-build-release-on-ops-contract.test.mjs`,
    "```",
  ].join("\n");
  assert.equal(cwd(body, ice), existsSync(devops) ? devops : ice);
  assert.equal(cwd("### Task 1\n- Command: `true`\n", ice), ice);
});

test("T8: taskWorkerCwd prefers plan/Task Repo farm over the Feature ice-wt", () => {
  const cwd = orch.taskWorkerCwd as (
    body: string,
    fallback: string,
    plan?: string,
    branch?: string,
  ) => string;
  const ice = join(homedir(), "Dev/git/ice-wt/feat-pearl-p2p-reuse");
  const coins = join(homedir(), "Dev/git/coins-minimal-wt/feat-pearl-p2p-reuse");
  const plan = "> Repo: coins-minimal\n> Branch: feat/pearl-p2p-reuse\n";
  const body = "### Task 1 — p2p\n- Command: `rtk go test .`\n";
  const want = existsSync(join(coins, ".git")) ? coins : ice;
  assert.equal(cwd(body, ice, plan, "feat/pearl-p2p-reuse"), want);
  assert.equal(
    (orch.taskRepoName as (b: string, p?: string) => string)("- Repo: icemining-devops\n", plan),
    "icemining-devops",
    "Task Repo wins over plan Repo",
  );
  assert.equal((orch.planRepoName as (p: string) => string)(plan), "coins-minimal");
});

test("T7: mutation writers never get contact_supervisor or an intercom bridge", () => {
  const apply = (
    orch as never as {
      applySpawnPolicy: (p: Record<string, unknown>) => { action: string };
    }
  ).applySpawnPolicy;

  const writer = {
    agent: "tdd-worker",
    model: "cursor/gpt-5.6-luna:xhigh",
    intercomBridge: { mode: "always" },
    tools: ["read", "contact_supervisor"],
  };
  apply(writer);
  assert.equal((writer.intercomBridge as { mode: string }).mode, "off");
  assert.equal(
    (writer.tools as string[]).includes("contact_supervisor"),
    false,
    "tdd-worker must not be able to ping the parent",
  );

  const paths = promptContractPaths();
  const fix = orch.reviewFixLaunchParams(paths, "99", "/tmp/wt", {
    next: "read_comments_and_fix",
    output: "next=read_comments_and_fix",
  }) as Record<string, unknown>;
  assert.equal((fix.intercomBridge as { mode: string }).mode, "off");
  assert.equal((fix.tools as string[]).includes("contact_supervisor"), false);

  const qa = { agent: "feature-qa", model: "xai/grok-4.6:high" };
  apply(qa);
  assert.notEqual(
    (qa as { intercomBridge?: { mode: string } }).intercomBridge?.mode,
    "off",
    "QA may still contact_supervisor for need_decision",
  );
});

test("T9: workerLaunchParams is a host-gated implementer, not a findings report", () => {
  assert.equal(typeof orch.workerLaunchParams, "function", "workerLaunchParams must be exported");
  const devops = join(homedir(), "Dev/git/ice-devops-flagfix");
  const ice = join(homedir(), "Dev/git/ice-wt/feat-faster-survivor-iteration");
  const plan = [
    "> Repo: icemining",
    "> Branch: feat/faster-survivor-iteration",
    "### Task 1 — Identical-release cargo skip",
    "- Status: pending",
    "- Complexity: simple",
    "- Command:",
    "```",
    `cd ${devops} && rtk node --test scripts/check-build-release-on-ops-contract.test.mjs`,
    "```",
  ].join("\n");
  const params = (orch.workerLaunchParams as Function)(
    promptContractPaths(),
    { id: "1", title: "Identical-release cargo skip", status: "pending", complexity: "simple" },
    ice,
    plan,
  ) as Record<string, unknown>;
  assert.equal(params.agent, "tdd-worker");
  assert.equal(params.context, "fresh");
  assert.equal(params.model, "zai/glm-5.3-flash:medium", "simple Task is GLM flash medium");
  assert.equal(params.output, undefined, "findings output injected Write your findings and Luna never edited");
  assert.deepEqual(params.agentContract, { version: 1 });
  assert.equal((params.intercomBridge as { mode: string }).mode, "off");
  assert.equal(((params.tools as string[]) ?? []).includes("contact_supervisor"), false);
  const acc = params.acceptance as { level?: string; verify?: Array<{ command?: string }> };
  assert.equal(acc.level, "verified");
  assert.match(String(acc.verify?.[0]?.command), /check-build-release-on-ops-contract/);
  if (existsSync(devops)) {
    assert.equal(params.cwd, devops, "Command cd wins over Feature ice-wt");
  }
  assert.doesNotMatch(String(params.task), /Write your findings/);
  assert.doesNotMatch(String(params.task), /acceptance-report/);
});

test("T9: a Task with no Command is not asked for a checked evidence report", () => {
  const plan = [
    "> Repo: icemining",
    "### Task 1 — no gate",
    "- Status: pending",
    "- Complexity: simple",
    "- Implement: do the thing",
  ].join("\n");
  const params = (orch.workerLaunchParams as Function)(
    promptContractPaths(),
    { id: "1", title: "no gate", status: "pending", complexity: "simple" },
    "/tmp/wt",
    plan,
  ) as Record<string, unknown>;
  const acc = params.acceptance as { level?: string; reason?: string; evidence?: unknown };
  assert.equal(acc.level, "none");
  assert.equal(acc.evidence, undefined);
  assert.match(String(acc.reason), /Command gate is absent/);
});

/* ---------------------------------------------------------------- *
 * Overlay — rpiv-todo is projected from plan.md + status.md in code.
 * No parent prompt, no todoSyncBlock, no Date/random in the snapshot.
 * ---------------------------------------------------------------- */

const OVERLAY_PLAN_FIVE = [
  "### Task 1 — Above-floor resume catch-up",
  "- Status: done",
  "",
  "### Task 2 — Conflict replies request snapshot",
  "- Status: done",
  "",
  "### Task 3 — Catch-up precedes reservation",
  "- Status: done",
  "",
  "### Task 4 — Actor failover harness",
  "- Status: done",
  "",
  "### Task 5 — Drivers wait, then snapshot",
  "- Status: in_progress",
].join("\n");

const OVERLAY_STATUS_IMPL = [
  "phase: implementing",
  "active_task: 5",
  "qa_pass: 0",
  "qa_pass_cap: 1",
].join("\n");

type OverlayTodo = {
  id: number;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  blockedBy?: number[];
  metadata?: { kind: "planner" | "plan-reviewer" | "task" | "qa"; taskId?: string; qaPass?: number };
};

function overlayTodos(plan: string, status: string): OverlayTodo[] {
  return (orch as never as {
    overlayTodosFromFeature: (p: string, s: string) => OverlayTodo[];
  }).overlayTodosFromFeature(plan, status);
}

test("overlay: mapper and sink are exported (no prompt path)", () => {
  assert.equal(typeof orch.overlayTodosFromFeature, "function");
  assert.equal(typeof orch.projectOverlayTodos, "function");
  assert.equal(typeof orch.syncOverlayTodos, "function");
  assert.equal(typeof orch.setOverlayTodoSink, "function");
  const src = readFileSync(ORCH_SRC, "utf8");
  assert.equal(/\bfunction\s+todoSyncBlock\b/.test(src), false);
  assert.match(src, /syncOverlayTodos\(/);
});

test("overlay: Task N id is the plan id; done/in_progress/pending/blocked map deterministically", () => {
  const plan = [
    "### Task 1 — one",
    "- Status: done",
    "### Task 2 — two",
    "- Status: in_progress",
    "### Task 3 — three",
    "- Status: pending",
    "### Task 4 — four",
    "- Status: blocked",
  ].join("\n");
  const todos = overlayTodos(plan, "phase: implementing\nqa_pass: 0\nqa_pass_cap: 0\n");
  assert.deepEqual(
    todos.map((t) => ({ id: t.id, status: t.status, subject: t.subject, kind: t.metadata?.kind })),
    [
      { id: 1001, status: "completed", subject: "Planner", kind: "planner" },
      { id: 1002, status: "completed", subject: "Plan reviewer", kind: "plan-reviewer" },
      { id: 1, status: "completed", subject: "Task 1 — one", kind: "task" },
      { id: 2, status: "in_progress", subject: "Task 2 — two", kind: "task" },
      { id: 3, status: "pending", subject: "Task 3 — three", kind: "task" },
      { id: 4, status: "pending", subject: "Task 4 — four", kind: "task" },
    ],
  );
  const taskTodos = todos.filter((t) => t.metadata?.kind === "task");
  assert.equal(taskTodos[1]?.activeForm, "implementing Task 2");
  assert.equal(taskTodos[0]?.activeForm, undefined);
  assert.deepEqual(todos[1]?.blockedBy, [1001]);
  assert.deepEqual(taskTodos[0]?.blockedBy, [1002]);
  assert.deepEqual(taskTodos[1]?.blockedBy, [1]);
  assert.deepEqual(taskTodos[2]?.blockedBy, [2]);
  assert.equal(
    todos.filter((t) => t.status === "in_progress").length,
    1,
    "exactly one in_progress",
  );
});

test("overlay: same plan+status always yields the same snapshot (no clocks)", () => {
  const a = overlayTodos(OVERLAY_PLAN_FIVE, OVERLAY_STATUS_IMPL);
  const b = overlayTodos(OVERLAY_PLAN_FIVE, OVERLAY_STATUS_IMPL);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("overlay: live Feature Tasks plus the owed QA pass", () => {
  const todos = overlayTodos(OVERLAY_PLAN_FIVE, OVERLAY_STATUS_IMPL);
  assert.equal(todos.length, 8);
  assert.deepEqual(
    todos.map((t) => [t.id, t.status, t.metadata?.kind]),
    [
      [1001, "completed", "planner"],
      [1002, "completed", "plan-reviewer"],
      [1, "completed", "task"],
      [2, "completed", "task"],
      [3, "completed", "task"],
      [4, "completed", "task"],
      [5, "in_progress", "task"],
      [6, "pending", "qa"],
    ],
  );
  const qa = todos.find((t) => t.metadata?.kind === "qa");
  assert.equal(qa?.subject, "feature-qa");
  assert.deepEqual(qa?.blockedBy, [5]);
  assert.equal(qa?.metadata?.qaPass, 1);
});

test("overlay: QA pass is in_progress only after every Task is done", () => {
  const plan = OVERLAY_PLAN_FIVE.replace(
    "- Status: in_progress",
    "- Status: done",
  );
  const running = overlayTodos(
    plan,
    ["phase: feature-qa", "qa_pass: 0", "qa_pass_cap: 1"].join("\n"),
  );
  const qa = running.find((t) => t.metadata?.kind === "qa");
  assert.equal(qa?.id, 6);
  assert.equal(qa?.status, "in_progress");
  assert.equal(qa?.activeForm, "running feature-qa");
  assert.equal(
    running.filter((t) => t.status === "in_progress").length,
    1,
  );

  const done = overlayTodos(
    plan,
    ["phase: pr", "qa_pass: 1", "qa_pass_cap: 1"].join("\n"),
  );
  assert.equal(done.find((t) => t.metadata?.kind === "qa")?.status, "completed");
  assert.equal(done.filter((t) => t.status === "in_progress").length, 0);
});

test("overlay: QA remediation Tasks keep their plan ids; QA pass sits after max id", () => {
  const plan = [
    "### Task 1 — already",
    "- Status: done",
    "### Task 6 — QA: missing wait arm",
    "- Status: pending",
  ].join("\n");
  const todos = overlayTodos(
    plan,
    ["phase: implementing", "qa_pass: 1", "qa_pass_cap: 1"].join("\n"),
  );
  assert.deepEqual(
    todos.map((t) => [t.id, t.subject, t.status, t.metadata?.kind]),
    [
      [1001, "Planner", "completed", "planner"],
      [1002, "Plan reviewer", "completed", "plan-reviewer"],
      [1, "Task 1 — already", "completed", "task"],
      [6, "Task 6 — QA: missing wait arm", "pending", "task"],
      [7, "feature-qa", "completed", "qa"],
    ],
  );
});

test("overlay: two QA passes get stable ids maxTask+1 and maxTask+2", () => {
  const plan = ["### Task 1 — only", "- Status: done"].join("\n");
  const first = overlayTodos(
    plan,
    ["phase: feature-qa", "qa_pass: 0", "qa_pass_cap: 2"].join("\n"),
  );
  const second = overlayTodos(
    plan,
    ["phase: feature-qa", "qa_pass: 1", "qa_pass_cap: 2"].join("\n"),
  );
  const firstQa = first.filter((t) => t.metadata?.kind === "qa");
  assert.equal(firstQa[0]?.id, 2);
  assert.equal(firstQa[0]?.subject, "feature-qa 1/2");
  assert.equal(firstQa[0]?.status, "in_progress");
  assert.equal(firstQa[1]?.id, 3);
  assert.equal(firstQa[1]?.subject, "feature-qa 2/2");
  assert.equal(firstQa[1]?.status, "pending");
  assert.deepEqual(firstQa[1]?.blockedBy, [2]);

  const secondQa = second.filter((t) => t.metadata?.kind === "qa");
  assert.equal(secondQa[0]?.status, "completed");
  assert.equal(secondQa[1]?.status, "in_progress");
  assert.equal(secondQa[1]?.activeForm, "running feature-qa 2/2");
});

test("overlay: empty plan and qa_pass_cap 0 produce no rows", () => {
  assert.deepEqual(overlayTodos("", "qa_pass_cap: 0\n"), []);
});

test("overlay: planning Feature shows planner then plan-reviewer before any Task", () => {
  const todos = overlayTodos(
    "# Feature: x\n> Name: pending\n",
    "phase: planning\nplan_review: none\nqa_pass_cap: 0\n",
  );
  assert.deepEqual(
    todos.map((t) => [t.id, t.subject, t.status, t.metadata?.kind]),
    [
      [1001, "Planner", "in_progress", "planner"],
      [1002, "Plan reviewer", "pending", "plan-reviewer"],
    ],
  );
  assert.equal(todos[0]?.activeForm, "writing Feature plan");
  assert.deepEqual(todos[1]?.blockedBy, [1001]);
});

test("overlay: colon Task headings still project", () => {
  const todos = overlayTodos(
    "### Task 1: Required manifest rule_set\n- Status: pending\n",
    "qa_pass_cap: 0\n",
  );
  const task = todos.find((t) => t.metadata?.kind === "task");
  assert.equal(task?.id, 1);
  assert.equal(task?.subject, "Task 1 — Required manifest rule_set");
});

test("overlay: syncOverlayTodos publishes the snapshot to the sink, not the model", () => {
  const writes: Array<{ id: string; state: unknown }> = [];
  const sink = {
    getActiveRenderSession: () => "sess-1",
    replaceState(id: string, state: unknown) {
      writes.push({ id, state });
    },
  };
  orch.setOverlayTodoSink(sink);
  try {
    const snapshot = orch.syncOverlayTodos(OVERLAY_PLAN_FIVE, OVERLAY_STATUS_IMPL);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.id, "sess-1");
    assert.deepEqual(writes[0]?.state, snapshot);
    assert.deepEqual(snapshot, orch.projectOverlayTodos(OVERLAY_PLAN_FIVE, OVERLAY_STATUS_IMPL));
    assert.equal(snapshot.nextId, 1003);

    writes.length = 0;
    orch.setOverlayTodoSink({
      getActiveRenderSession: () => "",
      replaceState(id: string, state: unknown) {
        writes.push({ id, state });
      },
    });
    orch.syncOverlayTodos(OVERLAY_PLAN_FIVE, OVERLAY_STATUS_IMPL);
    assert.deepEqual(writes, [], "no foreground session → no publish");
  } finally {
    orch.setOverlayTodoSink(undefined);
  }
});

test("overlay: plan-reviewer in_progress never shares the board with a Task", () => {
  const plan = [
    "# Feature: compact",
    "> Name: pearl-compact-share-wire",
    "### Task 1 — Compact codec",
    "- Status: pending",
  ].join("\n");
  const todos = overlayTodos(
    plan,
    ["phase: reviewing", "plan_review: running", "qa_pass_cap: 1"].join("\n"),
  );
  assert.deepEqual(
    todos.map((t) => [t.metadata?.kind, t.status]),
    [
      ["planner", "completed"],
      ["plan-reviewer", "in_progress"],
      ["task", "pending"],
      ["qa", "pending"],
    ],
  );
  assert.equal(todos.find((t) => t.metadata?.kind === "plan-reviewer")?.activeForm, "reviewing Feature plan");
  assert.equal(
    todos.filter((t) => t.status === "in_progress").length,
    1,
    "exactly one in_progress while reviewing",
  );
});

test("gate: needsPlanReview is true until plan-reviewer is done, false once a Task has started", () => {
  const pendingPlan = "### Task 1 — one\n- Status: pending\n";
  assert.equal(orch.needsPlanReview(pendingPlan, "phase: planning\nplan_review: none\n"), true);
  assert.equal(orch.needsPlanReview(pendingPlan, "phase: reviewing\nplan_review: running\n"), true);
  assert.equal(orch.needsPlanReview(pendingPlan, "phase: reviewing\nplan_review: failed\n"), true);
  assert.equal(orch.needsPlanReview(pendingPlan, "phase: planning\nplan_review: done\n"), false);
  assert.equal(
    orch.needsPlanReview("### Task 1 — one\n- Status: in_progress\n", "phase: implementing\nplan_review: none\n"),
    false,
  );
  assert.equal(
    orch.needsPlanReview("### Task 1 — one\n- Status: pending\n", "phase: implementing\nplan_review: none\n"),
    false,
  );
});

test("pipeline: planner awaits plan-reviewer before the approve card; approve waits before tdd-worker", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  const planned = src.lastIndexOf("const planned = await runChildInPhase");
  const review = src.indexOf("reviewOk = await reviewPlan", planned);
  const card = src.indexOf("presentDraftApproveCards", review);
  assert.ok(planned >= 0, "planner launch site");
  assert.ok(review > planned, "plan-reviewer must run after planner, awaited");
  assert.ok(card > review, "approve card only after plan-reviewer settles");
  const begin = src.indexOf("async function beginImplementation");
  const wait = src.indexOf("Running plan-reviewer first", begin);
  const chain = src.indexOf("await runFeatureChain", wait);
  assert.ok(wait > begin && chain > wait, "approve/resume must wait for plan-reviewer before Tasks");
  assert.match(src, /writerBlockedByPlanReview\(statusNow\)/);
});

test("gate: writerBlockedByPlanReview is the overlap hard-stop", () => {
  assert.equal(orch.writerBlockedByPlanReview("plan_review: none\n"), undefined);
  assert.equal(orch.writerBlockedByPlanReview("plan_review: done\n"), undefined);
  assert.equal(orch.writerBlockedByPlanReview("plan_review: failed\n"), undefined);
  assert.match(
    String(orch.writerBlockedByPlanReview("plan_review: running\n")),
    /plan-reviewer still running/,
  );
  assert.match(
    String(orch.writerBlockedByPlanReview("plan_review: in_progress\n")),
    /plan-reviewer still running/,
  );
});
