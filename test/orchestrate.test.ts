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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  };
  // Not `as never`: that made every `pi.events.emit(...)` in this file an
  // error, because `never` has no properties. Call sites hand it to helpers
  // typed as `Function`, so the real inferred shape is what they want.
}

/**
 * The read-only git a fix round runs to see whether the fixer pushed
 * (`branchHeads`). Returns `undefined` for anything else so a test's own exec
 * script still owns `pr-await`, `push`, `gh`, and the rest.
 *
 * Each `HEAD` read advances one step, so the default script is "the branch
 * moved" — what a fixer that did its job leaves behind.
 */
function branchHeadExec(
  steps: { remote: string; local: string }[] = [
    { remote: "H1", local: "H1" },
    { remote: "H2", local: "H2" },
  ],
) {
  let i = 0;
  const at = () => {
    const step = steps[Math.min(i, steps.length - 1)];
    if (!step) throw new Error("branchHeads fixture needs at least one step");
    return step;
  };
  return (cmd: string, args: string[]) => {
    if (cmd !== "git") return undefined;
    const a = args ?? [];
    if (a[0] === "rev-parse" && a[1] === "--abbrev-ref") {
      return { code: 0, stdout: "feat/x\n", stderr: "" };
    }
    if (a[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
    // The commit gate (F11). Clean = the writer committed, which is the
    // ordinary case; a test that wants a dirty tree answers this itself.
    if (a[0] === "status" && a.includes("--porcelain")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (a[0] === "rev-parse" && String(a[1] ?? "").startsWith("origin/")) {
      return { code: 0, stdout: `${at().remote}\n`, stderr: "" };
    }
    if (a[0] === "rev-parse" && a[1] === "HEAD") {
      const step = at();
      i += 1;
      return { code: 0, stdout: `${step.local}\n`, stderr: "" };
    }
    return undefined;
  };
}

/** The `git pr-await` calls only — the branch-head reads are not the contract. */
function prAwaitCalls(execs: string[]): string[] {
  return execs.filter((e) => e.startsWith("git pr-await"));
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

/**
 * Occupancy is process-wide, not per Feature. A fixer holding Feature A and a
 * planner starting Feature B is the state the parent session actually showed
 * (fixer + planner in Async agents). Per-dir locking lets that through.
 */
test("H2: a fixer chain in flight refuses a planner on a different Feature", async () => {
  const withChainLock = (
    orch as never as {
      withChainLock: (k: string, fn: () => Promise<unknown>) => Promise<boolean>;
    }
  ).withChainLock;

  let plannerRan = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });

  const fixer = withChainLock("/feature/pr-2242", async () => {
    await held;
  });
  const planner = await withChainLock("/feature/pending-new", async () => {
    plannerRan += 1;
  });

  assert.equal(planner, false, "one chain in the process: fixer in flight must refuse planner");
  assert.equal(plannerRan, 0, "the refused planner must not seed or spawn");

  release();
  assert.equal(await fixer, true);
  const after = await withChainLock("/feature/pending-new", async () => {
    plannerRan += 1;
  });
  assert.equal(after, true, "planner may start once the fixer chain releases");
  assert.equal(plannerRan, 1);
});

test("H2: planner spawn is inside the chain lock, not before it", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  const plan = src.indexOf('runChildInPhase(pi, ctx, "plan"');
  assert.ok(plan > 0, "planner spawn exists");
  const lock = src.lastIndexOf("withChainLock(pendingDir", plan);
  assert.ok(
    lock > 0 && lock < plan,
    "planner must hold the process chain lock before runChildInPhase; otherwise a live fixer overlaps it",
  );
  const name = src.indexOf("ensureFeatureNamed(feat, readText(feat.planFile))", plan);
  assert.ok(name > plan, "naming still happens after the planner child exits");
});

test("H2: a busy process, not only this Feature dir, refuses a fixer", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  const call = src.slice(src.indexOf("const action = classifyFeaturePrNext("));
  const chainLocked = call.slice(0, call.indexOf(");"));
  assert.match(
    chainLocked,
    /RUNNING_CHAINS\.size\s*>\s*0/,
    "fixer classify must see any in-flight chain, not only RUNNING_CHAINS.has(this Feature)",
  );
  assert.equal(
    /RUNNING_CHAINS\.has\(paths\.featureDir\)/.test(chainLocked),
    false,
    "has(this Feature) is how a planner on another dir plus a fixer on this PR overlap",
  );
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
  const pi = makeFakePi(async () => ({
    code: 0,
    stdout: "status=handed_off\nnext=yield\npr=2197\nurl=https://github.com/moofone/icemining/pull/2197\n",
    stderr: "",
  }));
  const unregister = registerLatchArm((_ctx, seed) => {
    armed.push({ pr: seed.pr, cwd: seed.cwd, lastNext: seed.lastNext });
  }, pi.events);
  try {
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
    unregister();
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
  const landFn = src.slice(land, src.indexOf("\nasync function", land + 1));
  assert.ok(land >= 0 && discover > land, "must look for an existing branch PR");
  assert.ok(open > discover, "open Feature PR in code only after discover misses");
  assert.ok(awaitPr > open, "drivePrAwait runs after a PR number exists");
  assert.match(landFn, /featurePrDriveBlocked/, "done Features must not re-handshake");
  assert.match(landFn, /featurePrRepo/, "PR cwd is the Task repo, not the Feature folder");
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

test("L3: the handshake timeout is not a review deadline", () => {
  // F19/F9: `git pr-await` forks the daemon and prints. Thirty minutes of that
  // only ever held the chain lock while nothing happened, and a timeout here
  // is read as `yield` anyway — the detached waiter owns the review.
  assert.equal(orch.PR_AWAIT_CALL_TIMEOUT_MS, 60_000);
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

test("T1: Status todo is pending so approve does not skip to feature-qa", () => {
  const parseTasks = (orch as never as { parseTasks: (p: string) => Array<{ status: string; id: string }> }).parseTasks;
  const tasks = parseTasks(
    [
      "### Task 1 — Carry ids on register item",
      "- Status: todo",
      "- Complexity: critical",
      "### Task 2 — Mining-identity resolve wire type",
      "- Status: TBD",
    ].join("\n"),
  );
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]?.status, "pending");
  assert.equal(tasks[1]?.status, "pending");
  assert.equal(
    tasks.find((t) => t.status === "pending")?.id,
    "1",
    "the chain must pick Task 1, not fall through to feature-qa",
  );
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

test("W4: blockedTaskReconcile continues once the blocking problem is gone", () => {
  const reconcile = orch.blockedTaskReconcile;
  assert.equal(typeof reconcile, "function");
  assert.equal(
    reconcile({ hasHandoffFile: true, treeDirty: false, handoffLine: "/tmp/task-1.md" }),
    "done",
    "dirty-commit block (no gate:) + clean tree → mark done and continue",
  );
  assert.equal(
    reconcile({
      hasHandoffFile: true,
      treeDirty: false,
      handoffLine: "/tmp/task-1.md  gate: green",
    }),
    "done",
  );
  assert.equal(
    reconcile({
      hasHandoffFile: true,
      treeDirty: false,
      handoffLine: "/tmp/task-1.md  gate: red",
    }),
    "keep",
    "a red Command gate is still a problem",
  );
  assert.equal(
    reconcile({ hasHandoffFile: true, treeDirty: true, handoffLine: "/tmp/task-1.md" }),
    "keep",
    "tree still dirty → still a problem",
  );
  assert.equal(
    reconcile({ hasHandoffFile: false, treeDirty: false, handoffLine: "pending" }),
    "pending",
    "no handoff file → never ran",
  );
  assert.equal(
    reconcile({
      hasHandoffFile: true,
      treeDirty: false,
      handoffLine: "/tmp/task-1.md  gate: none",
    }),
    "keep",
    "ungated worker failure stays blocked",
  );
});

test("W4: applyBlockedReconcile marks a restored dirty-commit block done", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-blocked-recover-"));
  writeFileSync(join(dir, "task-1.md"), "work landed; Cargo.lock restored\n");
  const plan = [
    "### Task 1 — Gate Pearl difficulty hashrate",
    "- Status: blocked",
    "- Handoff: /tmp/task-1.md",
    "### Task 2 — Reject zero hashrate ingest",
    "- Status: pending",
  ].join("\n");
  const recovered = orch.applyBlockedReconcile(plan, dir, false);
  assert.equal(recovered.changed, true);
  assert.match(recovered.plan, /### Task 1[^]*?- Status: done/);
  assert.match(recovered.plan, /### Task 2[^]*?- Status: pending/);
  const stillDirty = orch.applyBlockedReconcile(plan, dir, true);
  assert.equal(stillDirty.changed, false);
  assert.match(stillDirty.plan, /### Task 1[^]*?- Status: blocked/);
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

test("W1: isAllowedWriterModel allows luna, cursor grok, and Anthropic Opus writers", () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).isAllowedWriterModel,
    "function",
    "isAllowedWriterModel must be exported so the Cursor Grok refuse-path is testable",
  );
  const allowed = (orch as never as { isAllowedWriterModel: (m: string) => boolean })
    .isAllowedWriterModel;

  assert.equal(allowed("openai-codex/gpt-5.6-luna"), true);
  assert.equal(allowed("openai-codex/gpt-5.6-luna:xhigh"), true);
  assert.equal(allowed("zai/glm-5.3-flash"), false);
  assert.equal(allowed("zai/glm-5.3-flash:medium"), false);
  assert.equal(allowed("cursor/grok-4.6"), true);
  assert.equal(allowed("cursor/grok-4.6:medium"), true);
  assert.equal(allowed("cursor/gpt-5.6-luna"), false);
  assert.equal(allowed("cursor/gpt-5.6-luna:xhigh"), false);
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

test("W1: runChild pins a tdd-worker on composer onto luna before spawn", async () => {
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
  assert.equal(spawn.params.model, "openai-codex/gpt-5.6-luna:xhigh");
  assert.doesNotMatch(String(spawn.params.model), /composer/);
  assert.equal(spawn.params.context, "fresh");
  assert.equal((spawn.params.turnBudget as { maxTurns: number }).maxTurns, 220);
});

const PARKED_EXCLUSION =
  "Requested subagent model 'openai-codex/gpt-5.6-luna:xhigh' is excluded and cannot be replaced by a fallback (reason: Subagent produced no output (possible model cold-start or empty response).; expires: 2026-08-27T22:39:42.777Z).";

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

test("W3: excluded luna tdd-worker does not retry when simple and critical share the pin", async () => {
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
    model: "openai-codex/gpt-5.6-luna:xhigh",
    timeoutMs: 60_000,
  });
  const outcome = (await withDeadline(p, 2000)) as { ok?: boolean; reason?: string };
  assert.notEqual(outcome.reason, "TEST_TIMEOUT", "exclusion retry never settled");
  assert.equal(outcome.ok, false);
  assert.equal(spawns.length, 1, "same simple/critical pin must not retry onto itself");
  assert.equal(spawns[0]?.params.model, "openai-codex/gpt-5.6-luna:xhigh");
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
    model: "openai-codex/gpt-5.6-luna:xhigh",
    timeoutMs: 60_000,
  });
  const outcome = (await withDeadline(p, 2000)) as { ok?: boolean; reason?: string };
  assert.notEqual(outcome.reason, "TEST_TIMEOUT");
  assert.equal(outcome.ok, false);
  assert.equal(spawns.length, 1, "other spawn failures must not fan out onto a second writer");
});

test("W3: an excluded critical luna writer does not retry (no loop)", async () => {
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
    model: "openai-codex/gpt-5.6-luna:xhigh",
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

test("W2: isAllowedPlannerModel accepts inherit only", () => {
  const allowed = (orch as never as { isAllowedPlannerModel: (m: string) => boolean })
    .isAllowedPlannerModel;
  assert.equal(allowed("inherit"), true);
  assert.equal(allowed("inherit:high"), true, "thinking suffix is still inherit");
  assert.equal(allowed("xai/grok-4.6:high"), false, "do not pin planning onto xAI Grok");
  assert.equal(allowed("xai/grok-4.6"), false);
  assert.equal(allowed("cursor/grok-4.6:high"), false);
  assert.equal(allowed(""), false);
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

  // `applySpawnPolicy` mutates its argument in place — that is the contract
  // under test — so the literals must be typed as the shape it may write, not
  // as the narrower shape they happen to start with.
  type SpawnParams = {
    agent: string;
    model?: string;
    timeoutMs?: number;
    context?: string;
    turnBudget?: { maxTurns: number };
  };
  const writer: SpawnParams = { agent: "tdd-worker", model: "cursor/composer-2.5-fast:high", timeoutMs: 4 * 60 * 60 * 1000 };
  const w = apply(writer);
  assert.equal(w.action, "pin");
  assert.equal(writer.model, "openai-codex/gpt-5.6-luna:xhigh");
  assert.equal(writer.context, "fresh");
  assert.ok((writer.timeoutMs as number) <= 90 * 60 * 1000, "4h writer timeout must clamp");
  assert.equal((writer.turnBudget as { maxTurns: number }).maxTurns, 220);

  const already: SpawnParams = { agent: "tdd-worker", model: "openai-codex/gpt-5.6-luna:xhigh" };
  assert.equal(apply(already).action, "allow");
  assert.equal(already.model, "openai-codex/gpt-5.6-luna:xhigh", "do not demote an allowed writer");
  assert.equal((already.turnBudget as { maxTurns: number }).maxTurns, 220);

  const critical: SpawnParams = { agent: "tdd-worker", model: "openai-codex/gpt-5.6-luna:xhigh" };
  assert.equal(apply(critical).action, "allow");
  assert.equal(critical.model, "openai-codex/gpt-5.6-luna:xhigh", "do not demote the critical writer");

  const anthropicQa: SpawnParams = { agent: "feature-qa", model: "anthropic/claude-opus-5:high" };
  assert.equal(apply(anthropicQa).action, "pin");
  assert.equal(anthropicQa.model, "cursor/grok-4.6:high", "retired Opus QA pins onto feature-qa's cursor grok");

  const planner: SpawnParams = { agent: "planner", model: "cursor/grok-4.6:xhigh" };
  assert.equal(apply(planner).action, "pin");
  assert.equal(planner.model, "inherit");

  const inheritPlanner: SpawnParams = { agent: "planner" };
  assert.equal(apply(inheritPlanner).action, "pin");
  assert.equal(inheritPlanner.model, "inherit");

  const demote: SpawnParams = { agent: "planner", model: "grok-build/grok-4.6:xhigh" };
  assert.equal(apply(demote).action, "pin");
  assert.equal(demote.model, "inherit");

  const alreadyPlanner = {
    agent: "planner",
    model: "inherit",
    timeoutMs: 60_000,
    turnBudget: { maxTurns: 80, graceTurns: 15 },
  };
  assert.equal(apply(alreadyPlanner).action, "allow");
  assert.equal(alreadyPlanner.model, "inherit");

  const nativeGrokPlanner = {
    agent: "planner",
    model: "xai/grok-4.6:high",
    timeoutMs: 60_000,
    turnBudget: { maxTurns: 80, graceTurns: 15 },
  };
  assert.equal(apply(nativeGrokPlanner).action, "pin");
  assert.equal(nativeGrokPlanner.model, "inherit", "planning follows the parent session, not xAI Grok");

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
    assert.equal(task.model, "openai-codex/gpt-5.6-luna:xhigh");
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
    /next_action: wait for plan-reviewer; do not approve yet/,
  );
});

test("L5: ensureFeatureNamed rewrites plan-run.md and leaves a pending-* symlink for the launch path", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "orch-plan-run-"));
  const pendingDir = join(repoDir, "pending-2026-09-02T16-23-05-632Z");
  mkdirSync(join(pendingDir, "handoffs"), { recursive: true });
  const plan = [
    "# Feature: Split Orchestrate Modules",
    "",
    "> Status: DRAFT — awaiting approval",
    "> Name: pending",
    "> Branch: pending",
    "> Repo: pi-orchestrate",
    `> Path: ${join(pendingDir, "plan.md")}`,
  ].join("\n");
  writeFileSync(join(pendingDir, "plan.md"), plan);
  writeFileSync(
    join(pendingDir, "status.md"),
    ["# Status", "name: pending", "phase: planning"].join("\n"),
  );
  writeFileSync(
    join(pendingDir, "handoffs", "plan-run.md"),
    [
      "# plan-run",
      "Name: pending",
      "Branch: pending",
      `Plan: ${join(pendingDir, "plan.md")}`,
      "Next human step: `/orchestrate approve split-orchestrate-modules`",
    ].join("\n"),
  );
  const paths = {
    repo: "pi-orchestrate",
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
  const dest = join(repoDir, "split-orchestrate-modules");
  assert.equal(named.name, "split-orchestrate-modules");
  const handoff = readFileSync(join(dest, "handoffs", "plan-run.md"), "utf8");
  assert.match(handoff, /^Name: split-orchestrate-modules$/m);
  assert.match(handoff, /^Branch: feat\/split-orchestrate-modules$/m);
  assert.equal(handoff.includes(`Plan: ${join(dest, "plan.md")}`), true);
  assert.equal(handoff.includes(pendingDir), false, "plan-run.md must not keep the deleted launch path");
  assert.doesNotMatch(
    handoff,
    /Next human step:.*\/orchestrate approve/,
    "plan-run.md must not advertise approve before plan-reviewer finishes",
  );
  assert.equal(lstatSync(pendingDir).isSymbolicLink(), true, "stale parent reads still resolve via pending-*");
  assert.equal(
    readFileSync(join(pendingDir, "plan.md"), "utf8").includes("# Feature: Split Orchestrate Modules"),
    true,
    "read of the launch pending-*/plan.md must succeed after rename",
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
  assert.ok(snap, "the fixture run must produce a snapshot");
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
  assert.ok(snap, "the fixture run must produce a snapshot");
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
  assert.ok(snap, "the fixture run must produce a snapshot");
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
  assert.ok(snap, "the fixture run must produce a snapshot");
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
    movedHeadPi() as never,
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
    stillPi as never,
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
    movedHeadPi() as never,
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
    movedHeadPi() as never,
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
 * `settings.json` scopes feature-qa, qa-opus, and plan-reviewer to
 * `cursor/grok-4.6`. Launching either on the wrong id is
 * refused by modelScope before the child starts, so every QA pass fails,
 * no PR is ever opened, and the Feature parks at `feature-qa failed`.
 * ------------------------------------------------------------------ */

test("Q1: feature-qa launches on the cursor grok-4.6 id modelScope allows", () => {
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
  assert.equal(params.model, "cursor/grok-4.6:high");
  assert.equal(params.cwd, "/tmp/wt");
  assert.equal(
    (params.turnBudget as { maxTurns: number }).maxTurns,
    60,
    "QA is not a 220-turn writer",
  );
});

test("Q1: qa-opus launches on cursor grok-4.6 high", () => {
  const params = orch.qaLaunchParams(
    { planFile: "/tmp/f/plan.md", handoffsDir: "/tmp/f/handoffs" } as never,
    "auth-reject-analytics",
    "/tmp/wt",
    "qa-opus",
  );
  assert.equal(params.model, "cursor/grok-4.6:high");
});

test("Q2: applySpawnPolicy pins feature-qa, qa-opus, and plan-reviewer onto cursor grok", () => {
  const apply = (
    orch as never as {
      applySpawnPolicy: (p: Record<string, unknown>) => { action: string; reason?: string };
    }
  ).applySpawnPolicy;
  const qa = { agent: "feature-qa", model: "cursor/claude-opus-5:high" };
  const decision = apply(qa);
  assert.equal(decision.action, "pin");
  assert.equal(qa.model, "cursor/grok-4.6:high", "feature-qa pins onto cursor grok, not native xai");

  const reviewer = { agent: "plan-reviewer", model: "cursor/claude-opus-5:xhigh" };
  assert.equal(apply(reviewer).action, "pin");
  assert.equal(reviewer.model, "openai-codex/gpt-5.6-luna:high", "plan-reviewer pins onto sidecar luna; xhigh is capped for QA");

  const alreadyXhigh = { agent: "qa-opus", model: "xai/grok-4.6:xhigh" };
  assert.equal(apply(alreadyXhigh).action, "pin");
  assert.equal(alreadyXhigh.model, "cursor/grok-4.6:high", "qa-opus pins onto cursor grok; xhigh is capped");

  const alreadyHigh = { agent: "feature-qa", model: "xai/grok-4.6:high" };
  assert.equal(apply(alreadyHigh).action, "pin");
  assert.equal(alreadyHigh.model, "cursor/grok-4.6:high", "native xai is not the feature-qa id");

  const cursorGrok = { agent: "feature-qa", model: "cursor/grok-4.6:high" };
  assert.equal(apply(cursorGrok).action, "allow");
  assert.equal(cursorGrok.model, "cursor/grok-4.6:high", "cursor-billed grok is the feature-qa id");

  // tdd-worker keeps luna: modelScope allows it for that agent.
  const worker = { agent: "tdd-worker", model: "openai-codex/gpt-5.6-luna:xhigh" };
  assert.equal(apply(worker).action, "allow");
  assert.equal(worker.model, "openai-codex/gpt-5.6-luna:xhigh");

  const retiredOpus = { agent: "tdd-worker", model: "cursor/claude-opus-5:high" };
  assert.equal(apply(retiredOpus).action, "pin");
  assert.equal(retiredOpus.model, "openai-codex/gpt-5.6-luna:xhigh", "retired cursor Opus pins onto luna");
});

/**
 * Q3: one place to change reviewer and writer models.
 *
 * `planReviewer` is plan-reviewer. `qaReviewer` is feature-qa and qa-opus,
 * falling back to `planReviewer`. `tddWorkerSimple` / `tddWorkerCritical`
 * are tdd-worker. Not in runFeatureQa, not in the spawn policy, not in each
 * agent file.
 */
test("Q3: qaModelBase comes from the orchestrate.json sidecar", () => {
  assert.equal(orch.qaModelBase('{"planReviewer":"anthropic/claude-sonnet-9"}'), "anthropic/claude-sonnet-9");
  assert.equal(
    orch.qaModelBase('{"planReviewer":"openai/gpt-6:xhigh"}'),
    "openai/gpt-6",
    "a thinking suffix in config is not part of the base id",
  );
  assert.equal(orch.qaModelBase("{}"), "cursor/grok-4.6", "missing key keeps the default");
  assert.equal(orch.qaModelBase("not json"), "cursor/grok-4.6");
  assert.equal(
    orch.qaModelBase("{}", "feature-qa"),
    "cursor/grok-4.6",
    "feature-qa defaults to cursor grok when the sidecar is empty",
  );
  assert.equal(
    orch.qaModelBase("{}", "qa-opus"),
    "cursor/grok-4.6",
    "qa-opus defaults to cursor grok when the sidecar is empty",
  );
});

test("Q3: the configured model drives launch, scope check, and pin alike", () => {
  const cfg = '{"planReviewer":"openai/gpt-6"}';
  assert.equal(orch.qaModelFor("feature-qa", "high", cfg), "openai/gpt-6:high");
  assert.equal(orch.qaModelFor("qa-opus", undefined, cfg), "openai/gpt-6:high");
  assert.equal(orch.isAllowedQaModel("openai/gpt-6:high", cfg), true);
  assert.equal(orch.isAllowedQaModel("anthropic/claude-opus-5:high", cfg), false);
});

test("Q3: qaReviewer overrides planReviewer for feature-qa and qa-opus", () => {
  const cfg = '{"planReviewer":"openai/gpt-6","qaReviewer":"cursor/grok-4.6:high"}';
  assert.equal(orch.qaModelFor("feature-qa", undefined, cfg), "cursor/grok-4.6:high");
  assert.equal(orch.qaModelFor("qa-opus", undefined, cfg), "cursor/grok-4.6:high");
  assert.equal(orch.qaModelFor("plan-reviewer", "high", cfg), "openai/gpt-6:high");
  assert.equal(orch.isAllowedQaModel("cursor/grok-4.6:high", cfg, "feature-qa"), true);
  assert.equal(orch.isAllowedQaModel("openai/gpt-6:high", cfg, "feature-qa"), false);
  assert.equal(orch.isAllowedQaModel("cursor/grok-4.6:high", cfg, "qa-opus"), true);
  assert.equal(orch.isAllowedQaModel("cursor/grok-4.6:high", cfg, "plan-reviewer"), false);
});

/**
 * Q3: tdd-worker pins live in the same sidecar as the QA models.
 * tddWorkerSimple / tddWorkerCritical, not the DEFAULT_WORKERS table.
 */
test("Q3: tdd-worker pins come from tddWorkerSimple / tddWorkerCritical", () => {
  assert.equal(orch.writerModelFor("simple", "{}"), "openai-codex/gpt-5.6-luna:xhigh");
  assert.equal(orch.writerModelFor("critical", "{}"), "openai-codex/gpt-5.6-luna:xhigh");
  assert.equal(orch.writerModelFor("simple", "not json"), "openai-codex/gpt-5.6-luna:xhigh");
  assert.equal(
    orch.writerModelFor("critical", '{"tddWorkerCritical":"openai/gpt-6:low"}'),
    "openai/gpt-6:low",
  );
  assert.equal(
    orch.writerModelFor("simple", '{"tddWorkerSimple":"openai/gpt-6"}'),
    "openai/gpt-6:xhigh",
    "missing thinking suffix keeps the default level",
  );
  assert.equal(
    orch.writerModelFor("critical", '{"tddWorkerCritical":"openai-codex/gpt-5.6-luna:xhigh"}'),
    "openai-codex/gpt-5.6-luna:xhigh",
    "writer xhigh is preserved",
  );
  assert.equal(
    orch.writerModelBase("critical", '{"tddWorkerCritical":"OpenAI/GPT-6:high"}'),
    "openai/gpt-6",
  );
  assert.equal(
    orch.writerSpec("critical", '{"tddWorkerCritical":"openai-codex/gpt-5.6-luna:xhigh"}').short,
    "gpt-5.6-luna xhigh",
  );
  assert.equal(
    orch.writerModelFor("critical", '{"TddWorkerCritical":"openai/gpt-6:low"}'),
    "openai/gpt-6:low",
    "PascalCase aliases match the documented names",
  );
});

test("Q3: live orchestrate.json pins tdd-worker to luna xhigh", () => {
  assert.equal(orch.writerModelFor("simple"), "openai-codex/gpt-5.6-luna:xhigh");
  assert.equal(orch.writerModelFor("critical"), "openai-codex/gpt-5.6-luna:xhigh");
  assert.equal(orch.overlayTaskAgentLabel("simple"), "simple · tdd-worker gpt-5.6-luna:xhigh");
  assert.equal(orch.overlayTaskAgentLabel("critical"), "critical · tdd-worker gpt-5.6-luna:xhigh");
});

test("Q3: a config-level thinking suffix is the default level for that agent", () => {
  assert.equal(orch.qaModelFor("feature-qa", undefined, '{"planReviewer":"openai/gpt-6:low"}'), "openai/gpt-6:low");
  assert.equal(
    orch.qaModelFor("feature-qa", "medium", '{"planReviewer":"openai/gpt-6:low"}'),
    "openai/gpt-6:medium",
    "an explicit caller level still wins",
  );
  assert.equal(
    orch.qaModelFor("feature-qa", "xhigh", '{"planReviewer":"openai/gpt-6:low"}'),
    "openai/gpt-6:high",
    "writer xhigh is preserved",
  );
  assert.equal(
    orch.qaModelFor("qa-opus", undefined, '{"planReviewer":"openai/gpt-6:xhigh"}'),
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

test("L4: FORBIDDEN / resume / pr-open keep the parent out of writer work", () => {
  assert.equal(typeof orch.FORBIDDEN, "string", "FORBIDDEN must be exported");
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
  assertNoStalePoller("FORBIDDEN", forbidden);
  assert.match(forbidden, /next=yield/);
  assert.match(
    forbidden,
    /Do NOT implement product code in this parent session/,
    "the parent is still not a writer",
  );
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

/* ---------------------------------------------------------------- *
 * P5 F17 — the skill is a solo-session prompt, and only that.
 *
 * It used to carry an `## /orchestrate` section: extension internals
 * (`drivePrAwait`, `armObservedLatch`), one paragraph duplicated verbatim, and
 * rules that restated the writer contract in a file no writer is given any
 * more. A git skill is the wrong owner for orchestration policy, and a prompt
 * is the wrong enforcement for something code already owns — so the policy
 * lives in `parentGitWorkflowAppend` and `WRITER_CONTRACT`, which code inlines, and
 * the enforcement lives in `classifyForRole`, which is mechanical.
 * ---------------------------------------------------------------- */

test("P5 F17: the skill no longer documents orchestration, and says whose it is not", () => {
  const src = readFileSync(GIT_WORKFLOW_SKILL, "utf8");

  assert.equal(
    /\n## `?\/orchestrate`?\n/.test(src),
    false,
    "the /orchestrate section belongs to code, not to a git skill",
  );
  for (const internal of ["drivePrAwait", "armObservedLatch"]) {
    assert.equal(
      src.includes(internal),
      false,
      `${internal} is an extension internal; a skill that names it is documenting the wrong thing`,
    );
  }

  // What must survive the deletion: a session that is *not* solo has to be
  // told so, or the `next=` table above reads as its instructions.
  const scope = skillSection("Scope");
  assert.match(scope, /solo/i, "the skill states which sessions it is for");
  assert.match(scope, /\/orchestrate/, "and which it is not for");
  assert.match(scope, /commits?\b/i, "a writer child commits");
  assert.match(
    scope,
    /git-workflow-guard|blocks/i,
    "and the rest is blocked mechanically, not asked for politely",
  );
});

test("P5 F17: the duplicated paragraph is gone", () => {
  const src = readFileSync(GIT_WORKFLOW_SKILL, "utf8");
  const seen = new Map<string, number>();
  for (const line of src.split("\n")) {
    const text = line.trim();
    if (text.length < 80) continue;
    seen.set(text, (seen.get(text) ?? 0) + 1);
  }
  const repeated = [...seen].filter(([, n]) => n > 1).map(([text]) => text.slice(0, 60));
  assert.deepEqual(repeated, [], `a skill that says a thing twice was edited by accident`);
});

test("P5 F17: the writer contract the skill used to carry is owned by code", () => {
  const block = orch.parentGitWorkflowAppend({ featureLive: true }) as string;

  assert.match(block, /read_comments_and_fix/, "code names the verdict the skill used to");
  assert.match(block, /dispatch/i, "and says it is dispatched, not worked by the reader");
  assert.match(block, /fixer/, "to a writer");
  assert.match(block, /stays? idle/i, "while the parent stays idle");
});

test("L4: the skill still leaves a solo session its own latch, verdict, and fix", () => {
  const src = readFileSync(GIT_WORKFLOW_SKILL, "utf8");

  assert.match(
    src,
    /`git pr-await <(?:PR|N)>` \*\*once\*\*/,
    "a solo session still opens exactly one wait",
  );
  assert.match(
    src,
    /`read_comments_and_fix` \| dispatch a `fixer` child[^|]*`git pr-await` once/,
    "the solo `next=` table still routes the fix to the fixer child, then push and re-await",
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
  const reviewing = orch.parentGitWorkflowAppend({ planReviewRunning: true }) as string;
  assert.match(reviewing, /Do NOT suggest or run \/orchestrate approve/);
  assert.match(reviewing, /Do NOT summarize the plan as a Task table/);
  assert.match(reviewing, /Plan draft, Plan review, and Approve/);
  assert.doesNotMatch(reviewing, /shown only after plan_review is done/);
  assert.doesNotMatch(reviewing, /Stay idle/, "reviewing is not a writer-owned phase");
  const chain = orch.parentGitWorkflowAppend({ taskChain: true }) as string;
  assert.match(chain, /rpiv-todo overlay/);
  assert.match(chain, /Do not reprint/);
  assert.match(chain, /Do not call the todo tool/);
  assert.doesNotMatch(chain, /Stay idle/, "the orchestrate parent lives in the reference checkout");
  const waiting = orch.parentGitWorkflowAppend({ awaitingApprove: true }) as string;
  assert.match(waiting, /Waiting for the human to approve/);
  assert.match(waiting, /Do NOT summarize the plan as a Task table/);
  assert.match(waiting, /Do not start Tasks/);
  const awaitingPr = orch.parentGitWorkflowAppend({ awaitingPr: true }) as string;
  assert.match(awaitingPr, /PR is still open/);
  assert.match(awaitingPr, /Do not report the Feature done/);
  assert.match(awaitingPr, /pr-latch/);
  assert.match(awaitingPr, /Do not run git pr-land/);
  const landed = orch.parentGitWorkflowAppend({ featureLanded: true }) as string;
  assert.match(landed, /One short confirmation/);
  assert.match(landed, /Do not use tools/);
  assert.doesNotMatch(landed, /SKILL\.md/);
  assert.doesNotMatch(landed, /Stay idle/);
  const landedNotJob = orch.parentGitWorkflowAppend({
    featureLanded: true,
    latchWake: true,
    featureLive: true,
  }) as string;
  assert.doesNotMatch(
    landedNotJob,
    /read tool/,
    "a Feature land must not send the model off to read the skill",
  );
});

test("L4: orchestrate.ts registers resources_discover and before_agent_start for git-workflow", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  assert.match(src, /resources_discover/);
  assert.match(src, /before_agent_start/);
  assert.match(src, /parentGitWorkflowAppend/);
  assert.match(src, /skillPaths: \[dirname\(GIT_WORKFLOW_SKILL\)\]/);
});

test("P5 F17: both hooks are kept deliberately, and the source says why", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  // F17 asked for these to be deleted *or* gated on a correct predicate.
  // Phase 1 gave `before_agent_start` the correct predicate; this test pins
  // the other half so a later reader does not delete the only line that
  // publishes the skill to pi at all.
  const at = src.indexOf(`pi.on("resources_discover"`);
  assert.notEqual(at, -1);
  const why = src.slice(Math.max(0, at - 700), at);
  assert.match(why, /F17/, "the decision names the finding it answers");
  assert.match(why, /settings\.json/, "and the fact that settles it");
  assert.match(
    src,
    /liveFeatureNeedsIdleParent\(cwd, undefined, session\)/,
    "the prompt append is gated on this session, not on the repo",
  );
  assert.match(
    src,
    /planReviewRunning: liveFeaturePlanReviewRunning\(cwd, undefined, session\)/,
    "parent must be told not to advertise approve while plan-reviewer is in flight",
  );
  assert.match(
    src,
    /taskChain: !featureLanded && liveFeatureTaskChain\(cwd, undefined, session\)/,
    "parent that owns the Feature must show todos after each Task, not one table at the end",
  );
  assert.match(
    src,
    /featureLanded/,
    "a Feature land must not be treated as a latchWake skill-read",
  );
  assert.match(
    src,
    /awaitingApprove: liveFeatureAwaitingApprove\(cwd, undefined, session\)/,
    "parent must not reprint a Task table while waiting for approve",
  );
});

/* ---------------------------------------------------------------- *
 * L5 — the idle-parent gate.
 *
 * "Stay idle" was appended to the system prompt of EVERY pi session in a repo
 * that had any Feature whose phase matched `^(implement|pr|qa)$`. That regex
 * never matched the real phases `implementing` / `feature-qa`, and four
 * Features stuck in `phase: pr` behind merged PRs poisoned every icemining
 * session for days (qa/fable_01.md F8, Phase 1.5).
 * ---------------------------------------------------------------- */

function idleParentRoot(
  rows: {
    name: string;
    phase: string;
    worktree?: string | null;
    pr?: string;
    sessionId?: string;
    sessionFile?: string;
  }[],
): string {
  const root = mkdtempSync(join(tmpdir(), "orch-idle-"));
  for (const row of rows) {
    const dir = join(root, "icemining", row.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.md"), `# Feature: ${row.name}\n`);
    const lines = [
      "# Status",
      "",
      "repo: icemining",
      `name: ${row.name}`,
      `phase: ${row.phase}`,
      `pr: ${row.pr ?? "none"}`,
    ];
    if (row.worktree !== null) lines.push(`worktree: ${row.worktree ?? "none"}`);
    if (row.sessionId) lines.push(`parent_session_id: ${row.sessionId}`);
    if (row.sessionFile) lines.push(`parent_session_file: ${row.sessionFile}`);
    writeFileSync(join(dir, "status.md"), `${lines.join("\n")}\n`);
  }
  return root;
}

test("overlay widget paint is keyed by session id, not last bind", () => {
  const a: unknown[] = [];
  const b: unknown[] = [];
  orch.bindOverlayUi({
    ui: { setWidget: (_k, v) => a.push(v) },
    sessionManager: { getSessionId: () => "sess-A", getSessionFile: () => "/tmp/A.jsonl" },
  });
  orch.bindOverlayUi({
    ui: { setWidget: (_k, v) => b.push(v) },
    sessionManager: { getSessionId: () => "sess-B", getSessionFile: () => "/tmp/B.jsonl" },
  });
  const plan = "# Feature: Only A\n\n### Task 1 — x\n- Status: pending\n";
  orch.syncOverlayTodos(plan, "parent_session_id: sess-A\nphase: implementing\n", undefined, "sess-A");
  assert.ok(a.length > 0, "owning session A must receive the board");
  assert.equal(b.length, 0, "session B must not inherit A's Feature board");
});

test("sessionOwnsFeature matches id or file and never infers from emptiness", () => {
  assert.equal(orch.sessionOwnsFeature("phase: pr\n", { id: "a" }), false);
  assert.equal(
    orch.sessionOwnsFeature("parent_session_id: none\nparent_session_file: none\n", { id: "a" }),
    false,
  );
  assert.equal(
    orch.sessionOwnsFeature("parent_session_id: sess-a\n", { id: "sess-a" }),
    true,
  );
  assert.equal(
    orch.sessionOwnsFeature("parent_session_id: sess-a\n", { id: "sess-b" }),
    false,
  );
  assert.equal(
    orch.sessionOwnsFeature("parent_session_file: /tmp/chat.jsonl\n", { file: "/tmp/chat.jsonl" }),
    true,
  );
  assert.equal(
    orch.sessionOwnsFeature("parent_session_id: old\nparent_session_file: /tmp/chat.jsonl\n", {
      id: "new-after-reload",
      file: "/tmp/chat.jsonl",
    }),
    true,
    "/reload may mint a new id; the session file is the stable claim",
  );
});

test("L5: the idle gate matches the real phase names, not `implement`/`qa`", () => {
  const WT = join(homedir(), "Dev", "git", "ice-wt", "feat-live");
  for (const phase of ["implementing", "feature-qa", "pr"]) {
    const root = idleParentRoot([{ name: "feat-live", phase, worktree: WT }]);
    try {
      assert.equal(
        orch.liveFeatureNeedsIdleParent(WT, root),
        true,
        `${phase} in the Feature's own worktree must keep the parent idle`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("L5: a Feature that is planning, reviewing or done never silences a session", () => {
  const WT = join(homedir(), "Dev", "git", "ice-wt", "feat-quiet");
  for (const phase of ["planning", "reviewing", "done", "blocked", "paused"]) {
    const root = idleParentRoot([{ name: "feat-quiet", phase, worktree: WT }]);
    try {
      assert.equal(
        orch.liveFeatureNeedsIdleParent(WT, root),
        false,
        `${phase} has no writer running, so nothing is owed`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("L5: the reference checkout is not silenced by a Feature working in a worktree", () => {
  // This is the poisoning case. The Feature's writer is in ice-wt; the person
  // sitting in ~/Dev/git/icemining is doing something else entirely.
  const WT = join(homedir(), "Dev", "git", "ice-wt", "feat-elsewhere");
  const REF = join(homedir(), "Dev", "git", "icemining");
  const root = idleParentRoot([{ name: "feat-elsewhere", phase: "pr", worktree: WT }]);
  try {
    assert.equal(orch.liveFeatureNeedsIdleParent(REF, root), false);
    assert.equal(orch.liveFeatureNeedsIdleParent(WT, root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("L5: a Feature with no worktree does not claim every chat in the repo root", () => {
  const REF = join(homedir(), "Dev", "git", "icemining");
  const root = idleParentRoot([
    { name: "feat-nowt", phase: "implementing", worktree: "none", sessionId: "sess-owner" },
  ]);
  try {
    assert.equal(
      orch.liveFeatureNeedsIdleParent(REF, root),
      false,
      "without session identity the repo root is shared by every tab",
    );
    assert.equal(
      orch.liveFeatureNeedsIdleParent(REF, root, { id: "sess-owner" }),
      true,
      "the owning session may sit in the repo root before git wt",
    );
    assert.equal(
      orch.liveFeatureNeedsIdleParent(REF, root, { id: "sess-other" }),
      false,
      "a sibling chat in the same cwd does not inherit the Feature",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("L5: liveFeaturePlanReviewRunning is true on the reference checkout while reviewing", () => {
  const REF = join(homedir(), "Dev", "git", "icemining");
  const root = idleParentRoot([
    { name: "feat-review", phase: "reviewing", worktree: "none" },
  ]);
  try {
    writeFileSync(
      join(root, "icemining", "feat-review", "status.md"),
      [
        "# Status",
        "repo: icemining",
        "name: feat-review",
        "phase: reviewing",
        "plan_review: running",
        "worktree: none",
      ].join("\n") + "\n",
    );
    assert.equal(typeof orch.liveFeaturePlanReviewRunning, "function");
    assert.equal(
      orch.liveFeaturePlanReviewRunning(REF, root),
      false,
      "unowned review does not silence every icemining tab",
    );
    writeFileSync(
      join(root, "icemining", "feat-review", "status.md"),
      [
        "# Status",
        "repo: icemining",
        "name: feat-review",
        "phase: reviewing",
        "plan_review: running",
        "worktree: none",
        "parent_session_id: sess-review",
      ].join("\n") + "\n",
    );
    assert.equal(orch.liveFeaturePlanReviewRunning(REF, root, { id: "sess-review" }), true);
    assert.equal(
      orch.liveFeaturePlanReviewRunning(join(homedir(), "Dev", "git", "ice-wt", "other"), root, {
        id: "sess-review",
      }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("L5: liveFeatureTaskChain reaches the reference checkout so todos show after each Task", () => {
  const REF = join(homedir(), "Dev", "git", "icemining");
  const WT = join(homedir(), "Dev", "git", "ice-wt", "feat-chain");
  const root = idleParentRoot([
    { name: "feat-chain", phase: "implementing", worktree: WT },
  ]);
  try {
    assert.equal(typeof orch.liveFeatureTaskChain, "function");
    assert.equal(
      orch.liveFeatureTaskChain(REF, root),
      false,
      "without ownership the reference checkout is just another chat",
    );
    const owned = idleParentRoot([
      { name: "feat-chain", phase: "implementing", worktree: WT, sessionId: "sess-chain" },
    ]);
    try {
      assert.equal(
        orch.liveFeatureTaskChain(REF, owned, { id: "sess-chain" }),
        true,
        "the owning session may sit in the reference checkout",
      );
      assert.equal(orch.liveFeatureTaskChain(WT, owned, { id: "sess-chain" }), true);
      assert.equal(
        orch.liveFeatureTaskChain(REF, owned, { id: "sess-other" }),
        false,
      );
      assert.equal(
        orch.liveFeatureNeedsIdleParent(REF, owned, { id: "sess-chain" }),
        false,
        "F8: Stay idle still does not poison the reference checkout",
      );
    } finally {
      rmSync(owned, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("L5: liveFeatureTaskChain stays on while blocked or paused so the parent does not reprint todos", () => {
  const REF = join(homedir(), "Dev", "git", "icemining");
  const WT = join(homedir(), "Dev", "git", "ice-wt", "feat-bleed");
  for (const phase of ["blocked", "paused", "pr"]) {
    const root = idleParentRoot([{ name: "feat-bleed", phase, worktree: WT }]);
    try {
      assert.equal(
        orch.liveFeatureTaskChain(REF, root),
        false,
        `${phase}: an unowned Feature does not bind every icemining tab`,
      );
      const owned = idleParentRoot([
        { name: "feat-bleed", phase, worktree: WT, sessionId: "sess-bleed" },
      ]);
      try {
        assert.equal(
          orch.liveFeatureTaskChain(REF, owned, { id: "sess-bleed" }),
          true,
          `${phase}: owning parent must not reprint the overlay`,
        );
      } finally {
        rmSync(owned, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("L5: an unrelated cwd is never silenced", () => {
  const WT = join(homedir(), "Dev", "git", "ice-wt", "feat-x");
  const root = idleParentRoot([{ name: "feat-x", phase: "pr", worktree: WT }]);
  try {
    assert.equal(
      orch.liveFeatureNeedsIdleParent(join(homedir(), "Dev", "git", "ice-wt", "other"), root),
      false,
    );
    assert.equal(orch.liveFeatureNeedsIdleParent("", root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("L5: reconcile is wired to session_start, the command handler, and an unref'd timer", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  assert.equal(
    typeof (orch as Record<string, unknown>).reconcileLiveFeaturePrs,
    "function",
    "the reconciler entry point must be exported so it can be driven and tested",
  );
  assert.match(src, /reconcileLiveFeaturePrs/, "orchestrate must call the reconciler");
  assert.match(src, /setInterval\(/, "a periodic reconcile must exist");
  assert.match(
    src,
    /reconcileTimer\.unref\?\.\(\)/,
    "the reconcile timer must be unref'd so it never holds the process open",
  );
  assert.match(src, /RECONCILE_INTERVAL_MS/);
  assert.match(
    src,
    /pi\.on\("session_start"[\s\S]{0,600}?reconcileLiveFeaturePrs/,
    "reconcile must run on session_start, which is the reload case F1 is about",
  );
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

test("D1: a Feature hosted under icemining can own icemining-devops#500, not icemining#500", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-owner-cross-"));
  const dir = seedFeatureStatus(root, "icemining", "build-timing-harness", {
    repo: "icemining",
    pr: "https://github.com/moofone/icemining-devops/pull/500",
    worktree: join(homedir(), "Dev/git/devops-wt/feat-build-timing-harness"),
    phase: "pr",
  });
  writeFileSync(
    join(dir, "plan.md"),
    [
      "> Repo: icemining",
      "### Task 1 — Wrapper",
      "- Repo: icemining-devops",
    ].join("\n"),
  );
  assert.equal(
    orch.findFeatureOwningPr("500", { repo: "icemining", root }),
    undefined,
    "icemining#500 is a different pull request than the Feature's devops PR",
  );
  assert.equal(
    orch.findFeatureOwningPr("500", { repo: "icemining-devops", root })?.dir,
    dir,
  );
  assert.equal(
    orch.findFeatureOwningPr("500", { repo: "moofone/icemining-devops", root })?.name,
    "build-timing-harness",
  );
});

test("D1: unanimous Task Repo recovers ownership when pr: is number-only", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-owner-plan-"));
  const dir = seedFeatureStatus(root, "icemining", "build-timing-harness", {
    repo: "icemining",
    pr: "500",
    phase: "done",
  });
  writeFileSync(
    join(dir, "plan.md"),
    [
      "> Repo: icemining",
      "### Task 1 — Wrapper",
      "- Repo: icemining-devops",
      "### Task 2 — Snapshot",
      "- Repo: icemining-devops",
    ].join("\n"),
  );
  assert.equal(
    orch.findFeatureOwningPr("500", { repo: "icemining", root }),
    undefined,
    "plan Tasks all in devops → not icemining#500",
  );
  assert.equal(
    orch.findFeatureOwningPr("500", { repo: "icemining-devops", root })?.dir,
    dir,
  );
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

  // No round-count cap: the loop ends at merge or at repeated findings, not
  // at a spent-round ceiling.
  assert.equal(
    classify("read_comments_and_fix", { prRound: 99 }),
    "spawn_writer",
    "a high pr_round still gets a fixer",
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
  assert.equal(params.model, "openai-codex/gpt-5.6-luna:xhigh", "review-fix is the critical writer");
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

  // F7: the solo skill tells a session to push once and then `git pr-await`.
  // Handing that to a child is how a second waiter got forked from inside a
  // fixer. The child gets its contract in the task text and nothing else.
  assert.doesNotMatch(
    task,
    /git-workflow\/SKILL\.md/,
    "the solo skill must not be cited to a child: its next= table orders a git pr-await",
  );
  assert.equal(params.skill, undefined, "no skill override for a writer child");
  assert.equal(params.skills, undefined, "no skills override for a writer child");
  assert.equal(params.reads, undefined, "no defaultReads pulling SKILL.md into the child");
  assert.match(task, /commit/i, "the writer commits");
  assert.match(task, /[Dd]o NOT `git push`/, "code pushes, one push per round");
  assert.match(task, /do NOT `gh pr comment`/, "code — not the child — speaks on the PR");
  assertNoStalePoller("reviewFixLaunchParams", task);
});

test("P2 F7: the tdd-worker contract commits and never pushes", () => {
  const paths = promptContractPaths();
  const plan = "# Feature: t\n\n### Task 1 — do the thing\n\n- Command: `npm test`\n";
  const params = orch.workerLaunchParams(
    paths,
    { id: "1", title: "do the thing", status: "pending", complexity: "simple" } as never,
    "/Users/greg/Dev/git/ice-wt/feat-x",
    plan,
  ) as Record<string, unknown>;
  const task = String(params.task);
  assert.match(task, /commit/i, "a Task that edits and does not commit is not done (F11)");
  assert.match(task, /[Dd]o NOT `git push`/, "the branch is pushed once, by code");
  assert.equal(params.skill, undefined, "no solo skill on a writer child");
  assert.equal(params.skills, undefined);
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
  const heads = branchHeadExec();
  const pi = makeFakePi(async (cmd, args) => {
    execs.push([cmd, ...(args ?? [])].join(" "));
    const head = heads(cmd, args ?? []);
    if (head) return head;
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
    prAwaitCalls(execs),
    ["git pr-await 99"],
    `code runs one git pr-await after the writer settles: ${execs.join(" | ")}`,
  );
  assert.equal(
    execs.some((e) => e.startsWith("git push")),
    false,
    "the fixer already pushed; code must not push on top of it",
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
  const heads = branchHeadExec([
    { remote: "H1", local: "H1" },
    { remote: "H2", local: "H2" },
    { remote: "H2", local: "H2" },
    { remote: "H3", local: "H3" },
  ]);
  let awaits = 0;
  const pi = makeFakePi(async (cmd, args) => {
    execs.push([cmd, ...(args ?? [])].join(" "));
    const head = heads(cmd, args ?? []);
    if (head) return head;
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
  assert.deepEqual(prAwaitCalls(execs), ["git pr-await 99", "git pr-await 99"]);
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
  const heads = branchHeadExec();
  const pi = makeFakePi(async (cmd, args) => {
    execs.push([cmd, ...(args ?? [])].join(" "));
    const head = heads(cmd, args ?? []);
    if (head) return head;
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
  const heads = branchHeadExec();
  let awaits = 0;
  const pi = makeFakePi(async (cmd, args) => {
    execs.push([cmd, ...(args ?? [])].join(" "));
    const head = heads(cmd, args ?? []);
    if (head) return head;
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
  assert.deepEqual(prAwaitCalls(execs), ["git pr-await 99", "git pr-await 99"]);
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
  assert.deepEqual(prAwaitCalls(execs), ["git pr-await 99"]);
  assert.equal(parentTurns(pi).length, 0);
});

test("D3: a high fixer round still spawns and never lands from read_comments_and_fix", async () => {
  const { dir, paths } = prFeatureFixture(99);
  const { pi, execs } = execRecorder("status=handed_off\nnext=yield\nround=21\n");
  const spawn = autoSettleSpawn(pi, "run-nocap-1");
  const { ctx } = makeFakeCtx();

  const action = await dispatchVerdict(pi, ctx, paths, dir, "read_comments_and_fix", FIX_VERDICT);
  assert.equal(action, "spawn_writer", "no round cap on fixers");
  assert.equal(spawn.count, 1);
  assert.match(readFileSync(paths.statusFile, "utf8"), /^pr_round: 100$/m);
  assert.deepEqual(prAwaitCalls(execs), ["git pr-await 99"]);
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

test("T1: subagentToolGuard allows the shared solo fixer and blocks orchestrate-only children", () => {
  const guard = (
    orch as never as {
      subagentToolGuard: (event: {
        toolName?: string;
        input?: Record<string, unknown>;
      }) => { block: true; reason: string } | undefined;
    }
  ).subagentToolGuard;
  assert.equal(guard({ toolName: "subagent", input: { agent: "fixer" } }), undefined, "solo parent can dispatch the shared fixer");
  for (const agent of ["tdd-worker", "feature-qa", "qa-opus", "plan-reviewer", "planner"]) {
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
  const writer = { agent: "tdd-worker", model: "openai-codex/gpt-5.6-luna:xhigh" };
  assert.equal(apply(writer).action, "allow");
  const planner = { agent: "planner", model: "xai/grok-4.6:high" };
  assert.notEqual(apply(planner).action, "reject");
  assert.equal(planner.model, "inherit");
});

test("T2: pinWriterCaps is a ceiling — a smaller requested budget survives", () => {
  const apply = (
    orch as never as {
      applySpawnPolicy: (p: Record<string, unknown>) => { action: string };
    }
  ).applySpawnPolicy;
  const open = {
    agent: "tdd-worker",
    model: "openai-codex/gpt-5.6-luna:xhigh",
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
  assert.equal(params.model, "inherit");
  assert.equal(params.context, "fresh");
  const task = String(params.task);
  assert.match(task, /bound objective/);
  assert.doesNotMatch(task, /You are the parent orchestrator/);
  assert.doesNotMatch(task, /todoSyncBlock|Visible todos/);
  assert.equal((params.turnBudget as { maxTurns: number }).maxTurns, 80);
});

// The planner is `acceptanceRole: writer` and its task says "overwrite plan.md",
// so an omitted acceptance is inferred as `checked` — whose evidence includes
// `tests-added`. A planner forbidden from touching product code can never
// produce that, so every planner run was rejected, `planned.ok` came back false,
// and the plan path returned before naming the Feature or running plan-reviewer.
test("T2: planner acceptance is off — it writes plan files, never tests", () => {
  const params = (orch.plannerLaunchParams as Function)(
    promptContractPaths(),
    "bound objective",
  ) as Record<string, unknown>;
  const acceptance = params.acceptance as { level?: string; reason?: string } | undefined;
  assert.ok(acceptance, "planner must declare acceptance, not inherit the inferred writer level");
  assert.equal(acceptance.level, "none");
  assert.ok(String(acceptance.reason ?? "").length > 0, "a none level must carry a reason");
});

// Every other launcher pins its child's cwd. The planner's was unset, so it
// inherited whatever the session was rooted at and ran a home-directory grep
// that timed out and lost the run.
test("T2: planner is rooted at the repo it is planning", () => {
  const params = (orch.plannerLaunchParams as Function)(
    promptContractPaths(),
    "bound objective",
  ) as Record<string, unknown>;
  assert.equal(params.cwd, "/Users/greg/Dev/git/icemining");
});

// Root cause of the lost run: Phase 1 ordered "read every spec referenced in
// AGENTS.md", pi-orchestrate has no AGENTS.md (186 of 234 repos under
// ~/Dev/git do not), and the only copy on the box is ~/AGENTS.md. With no cwd
// and two roots whose sole common parent is the home directory, the search for
// it widened to $HOME — where the file really is.
test("T2: planner is bounded to two roots and never told to find AGENTS.md", () => {
  const params = (orch.plannerLaunchParams as Function)(
    promptContractPaths(),
    "bound objective",
  ) as Record<string, unknown>;
  const task = String(params.task);
  assert.match(task, /Search scope/, "planner must be given an explicit search boundary");
  assert.match(task, /Never grep, find, or glob/);
  assert.match(task, /\/Users\/greg\/Dev\/git\/icemining/, "the code root must be named");
  assert.match(task, /\/tmp\/orch-contract/, "the durable Feature root must be named");
  assert.doesNotMatch(
    task,
    /Read every spec referenced in AGENTS\.md/,
    "an unconditional AGENTS.md read sends the planner hunting outside the repo",
  );
  assert.match(
    task,
    /Most repos have no AGENTS\.md/,
    "the planner must be told a missing AGENTS.md is normal, not something to search for",
  );
});

test("T2: planner does not tell anyone to /orchestrate approve — plan-reviewer runs first", () => {
  const params = (orch.plannerLaunchParams as Function)(
    promptContractPaths(),
    "bound objective",
  ) as Record<string, unknown>;
  const task = String(params.task);
  assert.doesNotMatch(
    task,
    /next_action: wait for \/orchestrate approve/,
    "status seed must not teach approve before plan-reviewer",
  );
  assert.doesNotMatch(
    task,
    /The next human step is/,
    "planner must not advertise approve as the next human step",
  );
  assert.match(task, /Do not mention `\/orchestrate approve`/);
  assert.match(task, /plan-reviewer/);
});

test("T2: planner requires TDD red tests and verifiable Acceptance per Task", () => {
  const params = (orch.plannerLaunchParams as Function)(
    promptContractPaths(),
    "bound objective",
  ) as Record<string, unknown>;
  const task = String(params.task);
  assert.match(task, /- Acceptance:/);
  assert.match(task, /TDD is mandatory/);
  assert.match(task, /verifiable/);
  assert.match(task, /- Red test:/);
});

test("T2: reviewLaunchParams is a plan-reviewer child", () => {
  assert.equal(typeof orch.reviewLaunchParams, "function", "reviewLaunchParams must be exported");
  const params = (orch.reviewLaunchParams as Function)(
    promptContractPaths(),
    "/tmp/wt",
    "feat-x",
  ) as Record<string, unknown>;
  assert.equal(params.agent, "plan-reviewer");
  assert.equal(params.model, "openai-codex/gpt-5.6-luna:high");
  assert.equal(params.cwd, "/tmp/wt");
  assert.equal((params.turnBudget as { maxTurns: number }).maxTurns, 60);
  const task = String(params.task);
  assert.match(task, /TDD red test exists/);
  assert.match(task, /in scope for this Task only/);
  assert.match(task, /Acceptance: is present, concrete, and verifiable/);
});

// Same defect as the planner: `plan-reviewer` is also `acceptanceRole: writer`
// and is told to "apply corrections to plan.md now", so an omitted acceptance
// infers `checked` and demands `tests-added` from a child that only edits a
// plan. `reviewPlan` would have recorded plan_review: failed on a good review.
test("T2: plan-reviewer acceptance is off — it edits the plan, never tests", () => {
  const params = (orch.reviewLaunchParams as Function)(
    promptContractPaths(),
    "/tmp/wt",
    "feat-x",
  ) as Record<string, unknown>;
  const acceptance = params.acceptance as { level?: string; reason?: string } | undefined;
  assert.ok(acceptance, "plan-reviewer must declare acceptance, not inherit the inferred level");
  assert.equal(acceptance.level, "none");
  assert.ok(String(acceptance.reason ?? "").length > 0, "a none level must carry a reason");
});

test("T3: QA findings and qa_pass_cap are bounded", () => {
  assert.equal(orch.MAX_QA_FINDINGS, 8);
  assert.equal(orch.MAX_QA_PASS_CAP, 2);
  assert.equal(typeof orch.clampedQaPassCap, "function");
  const clamp = orch.clampedQaPassCap as (n: number) => number;
  assert.equal(clamp(99), 2);
  assert.equal(clamp(1), 1);
  assert.equal(clamp(0), 0);
  assert.equal("MAX_TASKS" in orch, false, "no Feature-wide Task cap");
  assert.equal("taskCountError" in orch, false);

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
  assert.match(plan, /### Task 2 — QA: finding 1/);
  assert.match(plan, /- Acceptance: \[`true` green\]/);
  const todos = overlayTodos(
    plan,
    ["phase: feature-qa", "plan_review: done", "qa_pass: 1", "qa_pass_cap: 2"].join("\n"),
  );
  assert.equal(
    todos.some((t) => t.metadata?.kind === "task" && t.subject.includes("QA: finding 1") && t.status === "pending"),
    true,
    "remediation Tasks must appear on the overlay for the next tdd-worker",
  );
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

test("stray icemining-wt is relocated onto ice-wt; ice-wt itself is not stray", () => {
  assert.equal(typeof orch.isStrayFarmCheckout, "function");
  assert.equal(typeof orch.parseGitWtCreatedPath, "function");
  const stray = join(homedir(), "Dev/git/icemining-wt/feat-daemon-hashrate-and-purge");
  const canonical = join(homedir(), "Dev/git/ice-wt/feat-daemon-hashrate-and-purge");
  assert.equal(orch.isStrayFarmCheckout(stray, "icemining"), true);
  assert.equal(orch.isStrayFarmCheckout(canonical, "icemining"), false);
  assert.equal(orch.isStrayFarmCheckout(join(homedir(), "Dev/git/icemining"), "icemining"), false);
  assert.equal(
    orch.isStrayFarmCheckout(join(homedir(), "Dev/git/devops-wt/feat-x"), "icemining-devops"),
    false,
  );
  assert.equal(
    orch.isStrayFarmCheckout(join(homedir(), ".pi/agent/worktrees/feat-x"), "pi-extensions"),
    false,
    "host lanes are not stray product farms",
  );
});

test("parseGitWtCreatedPath reads ghl-wt success, already-exists, and git already-used", () => {
  const stray = "/Users/greg/Dev/git/icemining-wt/feat-daemon-hashrate-and-purge";
  assert.equal(
    orch.parseGitWtCreatedPath(`→ ${stray}   (feat/daemon-hashrate-and-purge)`),
    stray,
  );
  assert.equal(orch.parseGitWtCreatedPath(`ghl-wt: ${stray} already exists`), stray);
  assert.equal(
    orch.parseGitWtCreatedPath("fatal: already used by worktree at '/tmp/wt'"),
    "/tmp/wt",
  );
  assert.equal(orch.parseGitWtCreatedPath("ghl-wt: aborted"), "");
});

test("ensureFeatureWorktree relocates a stray farm before refusing", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  const fn = src.slice(src.indexOf("async function ensureFeatureWorktree("));
  const body = fn.slice(0, fn.indexOf("\nexport type FeaturePick"));
  assert.match(body, /acceptWorktreeDir/);
  assert.match(body, /parseGitWtCreatedPath/);
  assert.match(
    src,
    /\["worktree", "move"/,
    "a leftover icemining-wt checkout must be git worktree move'd onto ice-wt",
  );
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

test("featurePrRepo follows unanimous Task - Repo:, not the orchestrator folder", () => {
  const plan = [
    "# Feature: Build Timing Harness",
    "> Repo: icemining",
    "> Branch: feat/build-timing-harness",
    "",
    "### Task 1 — Wrapper",
    "- Repo: icemining-devops",
    "",
    "### Task 2 — Snapshot",
    "- Repo: icemining-devops",
  ].join("\n");
  assert.equal(
    orch.featurePrRepo(plan, "icemining"),
    "icemining-devops",
    "all Tasks in devops → PR and git pr-await cwd are devops, not ice-wt",
  );
  const mixed = plan.replace("- Repo: icemining-devops", "- Repo: icemining");
  assert.equal(
    orch.featurePrRepo(mixed, "icemining"),
    "icemining",
    "mixed Task repos fall back to plan/host rather than guessing",
  );
});

test("featurePrDriveBlocked refuses to re-await a finished Feature", () => {
  assert.equal(
    orch.featurePrDriveBlocked("phase: done\npr: 500\n"),
    "Feature is already complete; not re-driving the PR",
  );
  assert.equal(orch.featurePrDriveBlocked("phase: pr\npr: 500\n"), undefined);
});

test("T7: mutation writers never get contact_supervisor or an intercom bridge", () => {
  const apply = (
    orch as never as {
      applySpawnPolicy: (p: Record<string, unknown>) => { action: string };
    }
  ).applySpawnPolicy;

  const writer = {
    agent: "tdd-worker",
    model: "openai-codex/gpt-5.6-luna:xhigh",
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
  assert.equal(params.model, "openai-codex/gpt-5.6-luna:xhigh", "simple Task is luna xhigh");
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
  assert.match(String(params.task), /^Task 1\/1 — Identical-release cargo skip/m);
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

const SIMPLE_WORKER = "simple · tdd-worker gpt-5.6-luna:xhigh";
const CRITICAL_WORKER = "critical · tdd-worker gpt-5.6-luna:xhigh";
const PLANNER_AGENT = "inherit:high";
const REVIEWER_AGENT = "grok-4.6:high";
const QA_AGENT = "grok-4.6:high";

type OverlayTodo = {
  id: number;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  blockedBy?: number[];
  metadata?: {
    kind: orch.OverlayTodoKind;
    taskId?: string;
    qaPass?: number;
    complexity?: "simple" | "critical";
    worker?: string;
  };
};

function overlayTodos(plan: string, status: string): OverlayTodo[] {
  return (orch as never as {
    overlayTodosFromFeature: (p: string, s: string) => OverlayTodo[];
  }).overlayTodosFromFeature(plan, status);
}

function paintedWidgetLines(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "function") {
    const widget = (value as (tui: unknown, theme: unknown) => { render?: () => string[] })(
      undefined,
      undefined,
    );
    return widget?.render?.() ?? [];
  }
  return [];
}

test("overlay: mapper and sink are exported (no prompt path)", () => {
  assert.equal(typeof orch.overlayTodosFromFeature, "function");
  assert.equal(typeof orch.projectOverlayTodos, "function");
  assert.equal(typeof orch.syncOverlayTodos, "function");
  assert.equal(typeof orch.refreshFeatureOverlay, "function");
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
      { id: 1001, status: "completed", subject: `Plan draft · ${PLANNER_AGENT}`, kind: "planner" },
      { id: 1002, status: "completed", subject: `Plan review · ${REVIEWER_AGENT}`, kind: "plan-reviewer" },
      { id: 1003, status: "completed", subject: "Approve", kind: "approve" },
      { id: 1, status: "completed", subject: `Task 1 — one · ${SIMPLE_WORKER}`, kind: "task" },
      { id: 2, status: "in_progress", subject: `Task 2 — two · ${SIMPLE_WORKER}`, kind: "task" },
      { id: 3, status: "pending", subject: `Task 3 — three · ${SIMPLE_WORKER}`, kind: "task" },
      { id: 4, status: "pending", subject: `Task 4 — four · ${SIMPLE_WORKER}`, kind: "task" },
    ],
  );
  const taskTodos = todos.filter((t) => t.metadata?.kind === "task");
  assert.equal(taskTodos[1]?.activeForm, "implementing Task 2");
  assert.equal(taskTodos[0]?.activeForm, undefined);
  assert.deepEqual(todos[1]?.blockedBy, [1001]);
  assert.deepEqual(todos[2]?.blockedBy, [1002]);
  assert.deepEqual(taskTodos[0]?.blockedBy, [1003]);
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
  assert.equal(todos.length, 9);
  assert.deepEqual(
    todos.map((t) => [t.id, t.status, t.metadata?.kind]),
    [
      [1001, "completed", "planner"],
      [1002, "completed", "plan-reviewer"],
      [1003, "completed", "approve"],
      [1, "completed", "task"],
      [2, "completed", "task"],
      [3, "completed", "task"],
      [4, "completed", "task"],
      [5, "in_progress", "task"],
      [6, "pending", "qa"],
    ],
  );
  const qa = todos.find((t) => t.metadata?.kind === "qa");
  assert.equal(qa?.subject, `feature-qa · ${QA_AGENT}`);
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
    ["phase: pr", "pr: 2252", "qa_pass: 1", "qa_pass_cap: 1"].join("\n"),
  );
  assert.equal(done.find((t) => t.metadata?.kind === "qa")?.status, "completed");
  const waiting = done.filter((t) => t.status === "in_progress");
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]?.metadata?.kind, "pr");
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
      [1001, `Plan draft · ${PLANNER_AGENT}`, "completed", "planner"],
      [1002, `Plan review · ${REVIEWER_AGENT}`, "completed", "plan-reviewer"],
      [1003, "Approve", "completed", "approve"],
      [1, `Task 1 — already · ${SIMPLE_WORKER}`, "completed", "task"],
      [6, `Task 6 — QA: missing wait arm · ${SIMPLE_WORKER}`, "pending", "task"],
      [7, `feature-qa · ${QA_AGENT}`, "completed", "qa"],
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
  assert.equal(firstQa[0]?.subject, `feature-qa 1/2 · ${QA_AGENT}`);
  assert.equal(firstQa[0]?.status, "in_progress");
  assert.equal(firstQa[1]?.id, 3);
  assert.equal(firstQa[1]?.subject, `feature-qa 2/2 · ${QA_AGENT}`);
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
      [1000, "x", "in_progress", "feature"],
      [1001, `Plan draft · ${PLANNER_AGENT}`, "in_progress", "planner"],
      [1002, `Plan review · ${REVIEWER_AGENT}`, "pending", "plan-reviewer"],
      [1003, "Approve", "pending", "approve"],
    ],
  );
  assert.equal(todos.find((t) => t.metadata?.kind === "planner")?.activeForm, "writing Feature plan");
  assert.deepEqual(todos.find((t) => t.metadata?.kind === "planner")?.blockedBy, [1000]);
  assert.deepEqual(todos.find((t) => t.metadata?.kind === "plan-reviewer")?.blockedBy, [1001]);
});

test("overlay: planning stub shows Plan draft, Plan review, Approve and hides Tasks", () => {
  const plan = [
    "# Feature: (planning)",
    "> Status: DRAFT — awaiting approval",
    "> Name: pending",
    "## Tasks",
    "### Task 1 — should stay hidden",
    "- Status: pending",
  ].join("\n");
  const stub = overlayTodos(
    ["# Feature: (planning)", "> Name: pending", "## Tasks"].join("\n"),
    "phase: planning\nplan_review: none\nqa_pass_cap: 0\n",
  );
  assert.deepEqual(
    stub.map((t) => [t.metadata?.kind, t.subject, t.status]),
    [
      ["planner", `Plan draft · ${PLANNER_AGENT}`, "in_progress"],
      ["plan-reviewer", `Plan review · ${REVIEWER_AGENT}`, "pending"],
      ["approve", "Approve", "pending"],
    ],
  );
  const drafted = overlayTodos(
    plan,
    "phase: planning\nplan_review: none\nqa_pass_cap: 0\n",
  );
  assert.deepEqual(
    drafted.map((t) => t.metadata?.kind),
    ["planner", "plan-reviewer", "approve"],
    "Tasks stay off the board until plan-reviewer finishes",
  );
  assert.equal(drafted.find((t) => t.metadata?.kind === "planner")?.status, "completed");
});

test("overlay: Feature name is the parent row for all tasks", () => {
  const plan = [
    "# Feature: Name Auth Dirty Evidence",
    "> Name: name-auth-dirty-evidence",
    "### Task 1 — Fingerprint lists dirty rows",
    "- Status: in_progress",
    "- Complexity: simple",
  ].join("\n");
  const todos = overlayTodos(plan, "phase: implementing\nplan_review: done\nqa_pass_cap: 0\n");
  const feature = todos.find((t) => t.metadata?.kind === "feature");
  assert.equal(feature?.id, 1000);
  assert.equal(feature?.subject, "Name Auth Dirty Evidence");
  assert.equal(feature?.status, "in_progress");
  assert.deepEqual(todos.find((t) => t.metadata?.kind === "planner")?.blockedBy, [1000]);
  const lines = orch.overlayWidgetLines(todos);
  assert.equal(lines[0], "Todos (3/4)");
  assert.equal(lines[1], "Name Auth Dirty Evidence");
  assert.ok(lines[2]?.startsWith("├─ ✓ Plan draft"));
  assert.ok(lines.some((line) => line.includes("Task 1 — Fingerprint lists dirty rows")));
  assert.equal(
    orch.overlayFeatureLabel("# Feature: (planning)\n> Name: pending\n", "name: pending\n"),
    "",
    "placeholder title and pending Name are not a parent yet",
  );
});

test("overlay: phase pr shows an in-progress Feature PR wait row", () => {
  const plan = [
    "# Feature: Pearl Cert Submit Gate",
    "> Name: pearl-cert-submit-gate-2",
    "### Task 1 — Fail-closed verifier seam",
    "- Status: done",
    "- Complexity: critical",
  ].join("\n");
  const todos = overlayTodos(
    plan,
    ["phase: pr", "pr: 2252", "plan_review: done", "qa_pass: 2", "qa_pass_cap: 2"].join("\n"),
  );
  const pr = todos.find((t) => t.metadata?.kind === "pr");
  assert.ok(pr, "phase pr must project a wait row, not an all-done board");
  assert.equal(pr?.status, "in_progress");
  assert.match(String(pr?.subject), /PR #2252/);
  assert.equal(pr?.activeForm, "waiting for review");
  assert.equal(
    todos.filter((t) => t.metadata?.kind === "qa").every((t) => t.status === "completed"),
    true,
  );
});

test("overlay: reviewer progress stays distinct from repeated fix cycles", () => {
  for (const reviewed of ["0", "1", "2"]) {
    const todos = overlayTodos(
      ["# Feature: Remote", "> Name: remote", "### Task 1 — x", "- Status: done"].join("\n"),
      ["phase: pr", "pr: 222", "pr_round: 5", `await_round: ${reviewed}`, "await_round_total: 2"].join("\n"),
    );
    assert.equal(
      todos.find((t) => t.metadata?.kind === "pr")?.activeForm,
      `waiting for review · reviewers ${reviewed}/2`,
    );
  }
});

test("overlay: PR row says review in when the waiter already has findings", () => {
  const todos = overlayTodos(
    ["# Feature: Pearl", "> Name: pearl", "### Task 1 — x", "- Status: done"].join("\n"),
    [
      "phase: pr",
      "pr: 2256",
      "plan_review: done",
      "qa_pass: 2",
      "qa_pass_cap: 2",
      "next_action: pr-await next=read_comments_and_fix — same findings on this head",
      "worker_run_id: none",
    ].join("\n"),
  );
  const pr = todos.find((t) => t.metadata?.kind === "pr");
  assert.equal(pr?.activeForm, "review in");
});

test("overlay: PR row says fixing only while a writer is live", () => {
  const todos = overlayTodos(
    ["# Feature: Pearl", "> Name: pearl", "### Task 1 — x", "- Status: done"].join("\n"),
    [
      "phase: pr",
      "pr: 2256",
      "plan_review: done",
      "next_action: pr-await next=read_comments_and_fix",
      "worker_run_id: run-fixer-1",
    ].join("\n"),
  );
  const pr = todos.find((t) => t.metadata?.kind === "pr");
  assert.equal(pr?.activeForm, "fixing");
});

test("overlay: colon Task headings still project", () => {
  const todos = overlayTodos(
    "### Task 1: Required manifest rule_set\n- Status: pending\n",
    "plan_review: done\nqa_pass_cap: 0\n",
  );
  const task = todos.find((t) => t.metadata?.kind === "task");
  assert.equal(task?.id, 1);
  assert.equal(task?.subject, `Task 1 — Required manifest rule_set · ${SIMPLE_WORKER}`);
});

test("overlay: syncOverlayTodos publishes the snapshot to the sink, not the model", () => {
  const writes: Array<{ id: string; state: unknown }> = [];
  const sink = {
    getActiveRenderSession: () => "sess-1",
    replaceState(id: string, state: unknown) {
      writes.push({ id, state });
    },
  };
  const snapshot = orch.syncOverlayTodos(OVERLAY_PLAN_FIVE, OVERLAY_STATUS_IMPL, sink, "sess-1");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.id, "sess-1");
  assert.deepEqual(writes[0]?.state, snapshot);
  assert.deepEqual(snapshot, orch.projectOverlayTodos(OVERLAY_PLAN_FIVE, OVERLAY_STATUS_IMPL));
  assert.equal(snapshot.nextId, 1004);

  writes.length = 0;
  orch.syncOverlayTodos(OVERLAY_PLAN_FIVE, OVERLAY_STATUS_IMPL, {
    getActiveRenderSession: () => "",
    replaceState(id: string, state: unknown) {
      writes.push({ id, state });
    },
  });
  assert.deepEqual(writes, [], "no foreground session → no publish");
});

test("overlay: phase done drops the board so the session is ordinary chat", () => {
  const writes: Array<{ id: string; state: { tasks: unknown[] } }> = [];
  const sink = {
    getActiveRenderSession: () => "sess-1",
    replaceState(id: string, state: { tasks: unknown[] }) {
      writes.push({ id, state });
    },
  };
  const snapshot = orch.syncOverlayTodos(
    OVERLAY_PLAN_FIVE,
    "phase: done\npr: 2256\nparent_session_id: sess-1\nnext_action: landed\n",
    sink,
    "sess-1",
  );
  assert.deepEqual(snapshot.tasks, []);
  assert.equal(writes[0]?.id, "sess-1");
  assert.deepEqual(writes[0]?.state.tasks, []);
});

test("overlay: Task subjects include complexity and tdd-worker model:thinking", () => {
  const plan = [
    "### Task 1 — Fingerprint names dirty rows",
    "- Status: pending",
    "- Complexity: simple",
    "- Worker: openai-codex/gpt-5.6-luna, thinking xhigh",
    "### Task 2 — Gate 409 JSON",
    "- Status: pending",
    "- Complexity: critical",
    "- Worker: openai-codex/gpt-5.6-luna, thinking xhigh",
  ].join("\n");
  const todos = overlayTodos(plan, "plan_review: done\nqa_pass_cap: 0\n");
  const tasks = todos.filter((t) => t.metadata?.kind === "task");
  assert.equal(tasks[0]?.subject, `Task 1 — Fingerprint names dirty rows · ${SIMPLE_WORKER}`);
  assert.equal(tasks[0]?.metadata?.complexity, "simple");
  assert.equal(tasks[1]?.subject, `Task 2 — Gate 409 JSON · ${CRITICAL_WORKER}`);
  assert.equal(tasks[1]?.metadata?.complexity, "critical");
  assert.equal(todos.find((t) => t.metadata?.kind === "planner")?.subject, `Plan draft · ${PLANNER_AGENT}`);
  assert.equal(
    todos.find((t) => t.metadata?.kind === "plan-reviewer")?.subject,
    `Plan review · ${REVIEWER_AGENT}`,
  );
});

test("overlay: widget lines occupy the rpiv-todo slot shape", () => {
  assert.equal(typeof orch.overlayWidgetLines, "function");
  assert.equal(orch.OVERLAY_WIDGET_KEY, "rpiv-todos");
  const lines = orch.overlayWidgetLines(
    overlayTodos(
      "### Task 1 — one\n- Status: in_progress\n- Complexity: simple\n",
      "plan_review: done\nqa_pass_cap: 0\n",
    ),
  );
  assert.match(lines[0] ?? "", /^Todos \(\d+\/\d+\)$/);
  assert.ok(lines.some((line) => line.includes("tdd-worker gpt-5.6-luna:xhigh")));
  assert.ok(lines.some((line) => line.includes(`Plan draft · ${PLANNER_AGENT}`)));
});

test("overlay: parseTaskWorkerLine accepts both planner Worker spellings", () => {
  assert.deepEqual(orch.parseTaskWorkerLine("- Worker: openai-codex/gpt-5.6-luna, thinking medium\n"), {
    model: "openai-codex/gpt-5.6-luna",
    thinking: "medium",
  });
  assert.deepEqual(orch.parseTaskWorkerLine("- Worker: openai-codex/gpt-5.6-luna:xhigh\n"), {
    model: "openai-codex/gpt-5.6-luna",
    thinking: "xhigh",
  });
});

test("overlay: syncOverlayTodos paints the widget even without a store sink", () => {
  const painted: Array<{ key: string; value: unknown }> = [];
  orch.bindOverlayUi({
    hasUI: true,
    ui: {
      setWidget(key: string, value: unknown) {
        painted.push({ key, value });
      },
    },
    sessionManager: { getSessionId: () => "sess-paint" },
  });
  orch.syncOverlayTodos(
    "### Task 1 — one\n- Status: pending\n- Complexity: simple\n",
    "plan_review: done\nqa_pass_cap: 0\n",
    {
      getActiveRenderSession: () => "",
      replaceState() {},
    },
    "sess-paint",
  );
  assert.equal(painted.length, 1);
  assert.equal(painted[0]?.key, "rpiv-todos");
  const lines = paintedWidgetLines(painted[0]?.value);
  assert.ok(lines.some((line) => line.includes(SIMPLE_WORKER)));
});

test("overlay: unchanged board does not remount the widget", () => {
  const painted: unknown[] = [];
  orch.bindOverlayUi({
    hasUI: true,
    ui: {
      setWidget(_key: string, value: unknown) {
        painted.push(value);
      },
    },
    sessionManager: { getSessionId: () => "sess-stable-paint" },
  });
  const plan = "# Feature: Flicker\n\n### Task 1 — one\n- Status: pending\n- Complexity: simple\n";
  const status = "phase: planning\nplan_review: pending\nqa_pass_cap: 0\n";
  orch.syncOverlayTodos(plan, status, undefined, "sess-stable-paint");
  assert.equal(painted.length, 1, "first paint must mount the board");
  orch.syncOverlayTodos(plan, status, undefined, "sess-stable-paint");
  assert.equal(painted.length, 1, "identical board must not remount");
  orch.syncOverlayTodos(
    plan,
    "phase: planning\nplan_review: in_progress\nqa_pass_cap: 0\n",
    undefined,
    "sess-stable-paint",
  );
  assert.equal(painted.length, 2, "a real status change must repaint");
});

test("overlay: completed Task stays checked off and the next Task is pending", () => {
  const todos = overlayTodos(
    [
      "### Task 1 — Fingerprint names dirty rows",
      "- Status: done",
      "- Complexity: simple",
      "### Task 2 — Gate 409 JSON",
      "- Status: pending",
      "- Complexity: critical",
    ].join("\n"),
    "phase: implementing\nplan_review: done\nqa_pass_cap: 1\n",
  );
  const tasks = todos.filter((t) => t.metadata?.kind === "task");
  assert.equal(tasks[0]?.status, "completed");
  assert.equal(tasks[1]?.status, "pending");
  const lines = orch.overlayWidgetLines(todos);
  assert.ok(lines.some((line) => line.includes("✓") && line.includes("Task 1")));
  assert.ok(lines.some((line) => line.includes("○") && line.includes("Task 2") && line.includes(CRITICAL_WORKER)));
});

test("overlay: after a QA pass adds remediation Tasks they appear pending and the pass is completed", () => {
  const todos = overlayTodos(
    [
      "### Task 1 — already",
      "- Status: done",
      "- Complexity: simple",
      "### Task 6 — QA: missing wait arm",
      "- Status: pending",
      "- Complexity: simple",
    ].join("\n"),
    ["phase: implementing", "qa_pass: 1", "qa_pass_cap: 1"].join("\n"),
  );
  assert.equal(todos.find((t) => t.metadata?.kind === "qa")?.status, "completed");
  const added = todos.find((t) => t.metadata?.taskId === "6");
  assert.equal(added?.status, "pending");
  assert.match(added?.subject ?? "", /Task 6 — QA: missing wait arm/);
});

test("overlay: refreshFeatureOverlay paints from disk after Task completion", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-overlay-"));
  const planFile = join(root, "plan.md");
  const statusFile = join(root, "status.md");
  writeFileSync(
    planFile,
    [
      "### Task 1 — one",
      "- Status: done",
      "- Complexity: simple",
      "### Task 2 — two",
      "- Status: pending",
      "- Complexity: critical",
    ].join("\n"),
  );
  writeFileSync(statusFile, "phase: implementing\nplan_review: done\nqa_pass: 0\nqa_pass_cap: 1\n");
  const painted: Array<{ key: string; value: unknown }> = [];
  const overlayCtx = {
    hasUI: true,
    ui: {
      setWidget(key: string, value: unknown) {
        painted.push({ key, value });
      },
    },
    sessionManager: { getSessionId: () => "sess-refresh" },
  };
  orch.bindOverlayUi(overlayCtx);
  const snapshot = orch.refreshFeatureOverlay(
    {
      repo: "x",
      gitRoot: root,
      repoDir: root,
      featureDir: root,
      planFile,
      statusFile,
      handoffsDir: join(root, "handoffs"),
      archiveDir: join(root, "archive"),
    },
    overlayCtx as never,
  );
  assert.equal(
    snapshot.tasks.find((t) => t.metadata?.kind === "task" && t.metadata.taskId === "1")?.status,
    "completed",
  );
  const lines = paintedWidgetLines(painted.at(-1)?.value);
  assert.ok(lines.some((line) => line.includes("✓") && line.includes("Task 1")));
  assert.ok(lines.some((line) => line.includes(CRITICAL_WORKER)));
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
      ["feature", "in_progress"],
      ["planner", "completed"],
      ["plan-reviewer", "in_progress"],
      ["approve", "pending"],
    ],
  );
  assert.equal(todos.find((t) => t.metadata?.kind === "plan-reviewer")?.activeForm, "reviewing Feature plan");
  assert.equal(
    todos.filter((t) => t.metadata?.kind !== "feature" && t.status === "in_progress").length,
    1,
    "exactly one work item in_progress while reviewing",
  );
});

test("overlay: after plan-reviewer, Approve is in_progress until /orchestrate approve", () => {
  const plan = [
    "# Feature: Split Orchestrate Modules",
    "> Status: DRAFT — awaiting approval",
    "> Name: split-orchestrate-modules",
    "### Task 1 — parsers",
    "- Status: pending",
  ].join("\n");
  const todos = overlayTodos(
    plan,
    ["phase: planning", "plan_review: done", "qa_pass_cap: 1"].join("\n"),
  );
  const approve = todos.find((t) => t.metadata?.kind === "approve");
  assert.equal(approve?.status, "in_progress");
  assert.equal(approve?.activeForm, "waiting for /orchestrate approve");
  assert.equal(todos.find((t) => t.metadata?.kind === "task")?.status, "pending");
  assert.equal(
    todos.filter((t) => t.metadata?.kind !== "feature" && t.status === "in_progress").length,
    1,
    "exactly one work item in_progress while waiting for approve",
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
  const approve = src.lastIndexOf('if (verb === "approve")');
  const gate = src.indexOf("approveBlockedByPlanReview", approve);
  const start = src.indexOf("beginImplementation(pi, ctx, feat", gate);
  assert.ok(
    approve >= 0 && gate > approve && start > gate,
    "typed /orchestrate approve must refuse unless plan-reviewer is done, before starting the chain",
  );
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

test("gate: approveBlockedByPlanReview refuses until plan-reviewer is done", () => {
  assert.equal(typeof orch.approveBlockedByPlanReview, "function");
  assert.equal(orch.approveBlockedByPlanReview("plan_review: done\n"), undefined);
  assert.match(
    String(orch.approveBlockedByPlanReview("plan_review: running\n")),
    /cannot approve yet/,
  );
  assert.match(
    String(orch.approveBlockedByPlanReview("plan_review: in_progress\n")),
    /cannot approve yet/,
  );
  assert.match(
    String(orch.approveBlockedByPlanReview("plan_review: failed\n")),
    /\/orchestrate review first/,
  );
  assert.match(
    String(orch.approveBlockedByPlanReview("plan_review: none\n")),
    /has not finished/,
  );
});

/* ---------------------------------------------------------------- *
 * Phase 2 — the deterministic fix loop (F5, F6, F7, F9, F10)
 * ---------------------------------------------------------------- */

test("P2 F5: fixerPushState reads the branch, and an unreadable head is inconclusive", () => {
  const state = orch.fixerPushState;
  assert.equal(typeof state, "function", "fixerPushState must be exported");
  assert.equal(
    state({ remoteBefore: "a", remoteAfter: "b", localAfter: "b" }),
    "pushed",
    "origin/<branch> moved: the fixer pushed",
  );
  assert.equal(
    state({ remoteBefore: "a", remoteAfter: "a", localAfter: "b" }),
    "committed",
    "HEAD is ahead of origin: the fixer committed and code owes the push",
  );
  assert.equal(
    state({ remoteBefore: "a", remoteAfter: "a", localAfter: "a" }),
    "none",
    "nothing moved anywhere",
  );
  for (const heads of [
    { remoteBefore: "", remoteAfter: "a", localAfter: "a" },
    { remoteBefore: "a", remoteAfter: "", localAfter: "a" },
    { remoteBefore: "a", remoteAfter: "a", localAfter: "" },
  ]) {
    assert.equal(
      state(heads),
      "unknown",
      "a head git could not answer must never be read as 'no push'",
    );
  }
});

test("P2 F5: a no-op fixer on a stale verdict head is not a disagreement", () => {
  const stale = orch.fixerNoopIsStaleVerdict;
  assert.equal(
    stale({
      verdictHead: "a93099213a40ac7ce4ee444ccdde83bbdbc845fd",
      localAfter: "a22c6537eb73aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      remoteAfter: "a22c6537eb73aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    true,
    "verdict against an older head: doing nothing is correct",
  );
  assert.equal(
    stale({
      verdictHead: "a22c6537eb73aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      localAfter: "a22c6537eb73aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      remoteAfter: "a22c6537eb73aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    false,
    "verdict against the settled head: no-op is a real disagreement",
  );
  assert.equal(
    stale({ verdictHead: "aaaa", localAfter: "aaaa", remoteAfter: "aaaa" }),
    false,
  );
});

test("P2 F5: a fixer that pushed and then timed out re-awaits instead of being called a disagreement", () => {
  const settle = orch.fixerSettleAction;
  assert.equal(
    settle({ ok: false, handoffWritten: true, push: "pushed" }),
    "await",
    "the branch moved — telling the user the fixer 'answered without a push' is false",
  );
  assert.equal(
    settle({ ok: true, handoffWritten: true, push: "pushed" }),
    "await",
  );
  assert.equal(
    settle({ ok: true, handoffWritten: true, push: "committed" }),
    "push_then_await",
    "the fixer committed but did not push: code pushes, then one await",
  );
  assert.equal(
    settle({ ok: false, handoffWritten: true, push: "committed" }),
    "push_then_await",
  );
  assert.equal(
    settle({ ok: true, handoffWritten: true, push: "none" }),
    "disagree",
    "reported ok but pushed nothing: re-awaiting the same head is the silent stall",
  );
  assert.equal(
    settle({ ok: false, handoffWritten: false, push: "none" }),
    "fail",
  );
  assert.equal(
    settle({ ok: false, stopped: true, handoffWritten: true, push: "pushed" }),
    "pause",
    "a user stop stays a pause whatever the branch did",
  );
});

test("P2 F5: with no readable head the settle falls back to the old ok + handoff table", () => {
  const settle = orch.fixerSettleAction;
  assert.equal(settle({ ok: true, handoffWritten: true }), "await");
  assert.equal(settle({ ok: false, stopped: true, handoffWritten: false }), "pause");
  assert.equal(settle({ ok: false, handoffWritten: true }), "disagree");
  assert.equal(settle({ ok: false, handoffWritten: false }), "fail");
  assert.equal(settle({ ok: true, handoffWritten: true, push: "unknown" }), "await");
  assert.equal(settle({ ok: false, handoffWritten: true, push: "unknown" }), "disagree");
});

test("P2 F5: branchHeads fetches before reading origin and never throws on a dead git", async () => {
  const calls: string[][] = [];
  const pi = makeFakePi(async (cmd, args) => {
    calls.push([cmd, ...(args ?? [])]);
    if (args?.[0] === "rev-parse" && args?.[1] === "--abbrev-ref") {
      return { code: 0, stdout: "feat/x\n", stderr: "" };
    }
    if (args?.[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
    if (args?.[0] === "rev-parse" && args?.[1] === "origin/feat/x") {
      return { code: 0, stdout: "REMOTE\n", stderr: "" };
    }
    if (args?.[0] === "rev-parse" && args?.[1] === "HEAD") {
      return { code: 0, stdout: "LOCAL\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "no" };
  });
  const heads = await orch.branchHeads(pi as never, "/tmp/wt", { fetch: true });
  assert.deepEqual(heads, { branch: "feat/x", remote: "REMOTE", local: "LOCAL" });
  assert.ok(
    calls.some((c) => c[1] === "fetch"),
    "the remote head must be refreshed before it is compared",
  );

  const dead = makeFakePi(async () => {
    throw new Error("git is gone");
  });
  assert.deepEqual(await orch.branchHeads(dead as never, "/tmp/wt"), {
    branch: "",
    remote: "",
    local: "",
  });
});

test("P2 F5: runReviewFixWriter decides from the branch and pushes what the fixer only committed", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  const start = src.indexOf("async function runReviewFixWriter");
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf("\nexport async function dispatchFeaturePrVerdict", start));
  assert.match(body, /branchHeads\(/, "the round must record the branch heads itself");
  assert.match(body, /fixerPushState\(/, "the settle input must come from the branch");
  assert.match(body, /push_then_await/, "code owes the push when the fixer only committed");
  assert.ok(
    body.indexOf("branchHeads(") < body.indexOf("runChildInPhase"),
    "the before-head must be read before the fixer runs, not after",
  );
});

const BRIEF_TWO = [
  "status=action_required",
  "next=read_comments_and_fix",
  "round=3",
  "head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "brief repo=moofone/icemining pr=99 head=aaaaaaaa",
  "coverage path=src/pay.rs",
  "brief_finding path=src/pay.rs line=88 sev=P1 title=credit_share overflows",
  "brief_finding path=src/fee.rs sev=P2 title=fee rounds toward the pool",
].join("\n");

test("P2 F6: brief_finding lines parse into a stable, head-independent finding set", () => {
  const parse = orch.parseBriefFindings;
  assert.equal(typeof parse, "function", "parseBriefFindings must be exported");
  assert.deepEqual(parse(BRIEF_TWO), [
    "src/fee.rs P2 fee rounds toward the pool",
    "src/pay.rs:88 P1 credit_share overflows",
  ]);
  assert.deepEqual(parse("next=yield\nround=2\n"), [], "no findings is an empty set, not a throw");
  assert.deepEqual(
    parse("brief repo=x pr=1 head=deadbeef\ncoverage path=a.rs"),
    [],
    "`brief` and `coverage` lines are not findings",
  );

  const tag = orch.findingsTag;
  assert.equal(typeof tag, "function", "findingsTag must be exported");
  assert.equal(tag([]), "", "an empty set has no tag — it can never look like a repeat");
  assert.equal(
    tag(parse(BRIEF_TWO)),
    tag(parse(BRIEF_TWO.replace("round=3", "round=9").replace(/aaaa/g, "bbbb"))),
    "the same findings against a different head and round must tag identically",
  );
  assert.notEqual(
    tag(parse(BRIEF_TWO)),
    tag(parse(BRIEF_TWO.replace("line=88", "line=91"))),
    "a finding that moved is a different finding",
  );
});

test("P2 F6: the same findings on a second head is a disagreement", () => {
  const classify = orch.classifyFeaturePrNext;
  assert.equal(
    classify("read_comments_and_fix", { prRound: 1 }),
    "spawn_writer",
    "the ordinary round is untouched",
  );
  assert.equal(
    classify("read_comments_and_fix", { prRound: 1, findingsRepeated: true }),
    "disagree",
    "the fixer pushed and the reviewers repeated themselves: stop, do not spend another round",
  );
  assert.equal(
    classify("read_comments_and_fix", { prRound: 1 }),
    "spawn_writer",
    "pr-await said fix is needed; same-head findings still get a fixer",
  );
  assert.equal(
    classify("read_comments_and_fix", { prRound: 6 }),
    "spawn_writer",
    "no round-count cap: six spent rounds still get a fixer",
  );
  assert.equal(
    classify("read_comments_and_fix", { prRound: 99 }),
    "spawn_writer",
    "no round-count cap: a high pr_round still gets a fixer",
  );
  assert.equal(
    classify("read_comments_and_fix", { prRound: 9, chainLocked: true }),
    "refuse",
    "a writer that holds the Feature outranks a repeat: the verdict is queued, not disagreed",
  );
  assert.equal(
    classify("read_comments_and_fix", { prRound: 9, workerLive: true }),
    "refuse",
  );
  assert.equal(
    classify("git_pr_land", { prRound: 9 }),
    "land",
    "a land is never a disagreement",
  );
});

test("P2 F6: same findings on the same head still spawn a fixer", async () => {
  const tag = orch.findingsTag(orch.parseBriefFindings(BRIEF_TWO));
  const { dir, paths } = prFeatureFixture(1, [
    `last_findings: ${tag}`,
    "pr_head: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]);
  const { pi } = execRecorder("status=handed_off\nnext=yield\n");
  const spawn = autoSettleSpawn(pi, "run-same-head-1");
  const { ctx } = makeFakeCtx();

  const action = await withDeadline(
    (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
      pi,
      ctx,
      paths,
      "99",
      dir,
      { done: false, next: "read_comments_and_fix", output: BRIEF_TWO, round: "2" },
    ),
    8000,
  );

  assert.equal(action, "spawn_writer", "pr-await asked for a fix; do not park");
  assert.equal(spawn.count, 1, "a fixer must start");
  const status = readFileSync(paths.statusFile, "utf8");
  assert.doesNotMatch(
    status,
    /not another fixer/,
    "same-head findings must not ack-park the Feature",
  );
});

test("P2 F6: a disagreement is spent, commented on the PR, and spawns nothing", async () => {
  const tag = orch.findingsTag(orch.parseBriefFindings(BRIEF_TWO));
  const { dir, paths } = prFeatureFixture(1, [
    `last_findings: ${tag}`,
    "pr_head: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ]);
  const { pi, execs } = execRecorder("");
  const spawn = autoSettleSpawn(pi, "run-disagree-1");
  const { ctx, notices } = makeFakeCtx();

  const action = await withDeadline(
    (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
      pi,
      ctx,
      paths,
      "99",
      dir,
      { done: false, next: "read_comments_and_fix", output: BRIEF_TWO, round: "3" },
    ),
    6000,
  );

  assert.equal(action, "disagree", "repeated findings stop the loop");
  assert.equal(spawn.count, 0, "no fixer on a repeat");
  for (const argv of execs) {
    assert.doesNotMatch(
      argv,
      /gh pr comment/,
      "disagreement is in-session; do not comment at reviewers",
    );
    assert.doesNotMatch(argv, /git pr-await|git pr-land|gh pr merge/);
  }
  const status = readFileSync(paths.statusFile, "utf8");
  assert.match(status, /^phase: pr$/m, "a disagreement leaves the PR open, not done");
  assert.match(status, /^next_action: disagreed at /m);
  assert.equal(parentTurns(pi).length, 0, "the parent is not asked to argue with the reviewers");
  assert.ok(notices.some((n) => /99/.test(n)));
});

test("P2 F6: dispatch records the finding set so the next round can see a repeat", async () => {
  const { dir, paths } = prFeatureFixture(0);
  const { pi } = execRecorder("status=handed_off\nnext=yield\n");
  autoSettleSpawn(pi, "run-record-1");
  const { ctx } = makeFakeCtx();

  await withDeadline(
    (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
      pi,
      ctx,
      paths,
      "99",
      dir,
      { done: false, next: "read_comments_and_fix", output: BRIEF_TWO, round: "3" },
    ),
    6000,
  );

  const status = readFileSync(paths.statusFile, "utf8");
  const tag = orch.findingsTag(orch.parseBriefFindings(BRIEF_TWO));
  assert.match(
    status,
    new RegExp(`^last_findings: ${tag}$`, "m"),
    `the finding set must survive a reload: ${status}`,
  );
  assert.match(
    status,
    /^pr_head: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$/m,
    "the head the findings were raised against is recorded with them",
  );
});

test("P2 F9: one dispatch chain runs at most two git pr-await handshakes", () => {
  assert.equal(orch.AWAIT_DISPATCH_MAX_DEPTH, 2);
});

test("P2 F9: a waiter that keeps saying investigate_dead_reviewers cannot recurse forever", async () => {
  const { dir, paths } = prFeatureFixture(0);
  const execs: string[] = [];
  const pi = makeFakePi(async (cmd, args) => {
    execs.push([cmd, ...(args ?? [])].join(" "));
    // Every handshake asks for another one. Without a bound this is an
    // unbounded mutual recursion between awaitAndDispatch and dispatch.
    return {
      code: 0,
      stdout: "status=action_required\nnext=investigate_dead_reviewers\nround=4\n",
      stderr: "",
    };
  });
  const spawn = autoSettleSpawn(pi, "run-depth-1");
  const { ctx, notices } = makeFakeCtx();

  const action = await withDeadline(
    (orch as never as { dispatchFeaturePrVerdict: Function }).dispatchFeaturePrVerdict(
      pi,
      ctx,
      paths,
      "99",
      dir,
      { done: false, next: "investigate_dead_reviewers", output: "next=investigate_dead_reviewers\n", round: "4" },
    ),
    8000,
  );

  assert.notEqual((action as { reason?: string })?.reason, "TEST_TIMEOUT", "the recursion never ended");
  assert.equal(action, "reawait");
  assert.equal(spawn.count, 0, "a dead-reviewer verdict has no writer");
  assert.equal(
    prAwaitCalls(execs).length,
    orch.AWAIT_DISPATCH_MAX_DEPTH,
    `at most ${orch.AWAIT_DISPATCH_MAX_DEPTH} handshakes per chain: ${execs.join(" | ")}`,
  );
  assert.ok(
    notices.some((n) => /re-await|waiter/i.test(n)),
    `the user is told the chain stopped: ${notices.join(" | ")}`,
  );
  assert.equal(parentTurns(pi).length, 0);
});

test("P2 F9: the handshake is a handshake, and the land is not a review deadline", () => {
  assert.equal(
    orch.PR_AWAIT_CALL_TIMEOUT_MS,
    60_000,
    "git pr-await forks a daemon and prints; 30 minutes of that held the chain lock (F19)",
  );
  assert.equal(
    orch.PR_LAND_CALL_TIMEOUT_MS,
    10 * 60 * 1000,
    "ghl-pr-land merges and waits for GitHub to agree — minutes, not half an hour",
  );
});

const PLAN_WITH_CONTEXT = [
  "# Feature: Quiesce identical current-state",
  "",
  "> Status: APPROVED",
  "> Branch: feat/quiesce",
  "> Worker: cursor/grok-4.6",
  "> Plan: /Users/greg/orchestrator/icemining/quiesce/plan.md",
  "",
  "## Context",
  "",
  "Republishing an unchanged current-state row wakes every consumer for nothing.",
  "The fix is to compare before publishing.",
  "",
  "## Tasks",
  "",
  "### Task 1 — Compare before publish",
  "",
  "- Command: `cargo test -p stratum-backend`",
  "",
  "### Task 2 — Cover the equal case",
  "",
  "- Command: `cargo test -p stratum-backend`",
  "",
  "## Out of Scope",
  "",
  "- The collector leg.",
].join("\n");

test("P2 F10: the PR body is the Context and the Task titles, never the whole plan file", () => {
  const body = orch.featurePrBody(PLAN_WITH_CONTEXT, "Quiesce identical current-state");
  assert.equal(typeof body, "string");
  assert.match(body, /Republishing an unchanged current-state row/, "the Context is the body");
  assert.match(body, /Compare before publish/, "the Task titles say what landed");
  assert.match(body, /Cover the equal case/);
  assert.doesNotMatch(body, /\/Users\/greg\/orchestrator/, "no local paths on a public PR");
  assert.doesNotMatch(body, /Worker:/, "no model routing on a public PR");
  assert.doesNotMatch(body, /cargo test -p stratum-backend/, "gate commands are not PR prose");
  assert.doesNotMatch(body, /Status: APPROVED/);

  const bare = orch.featurePrBody("# Feature: t\n\n### Task 1 — only task\n", "t");
  assert.match(bare, /only task/, "a plan with no Context still gets a usable body");
});

test("P2 F10: the base branch comes from the repo, not from a hard-coded main", async () => {
  const pi = makeFakePi(async (cmd, args) => {
    if (cmd === "gh" && args?.[0] === "repo" && args?.[1] === "view") {
      return {
        code: 0,
        stdout: '{"defaultBranchRef":{"name":"develop"}}',
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: "no" };
  });
  assert.equal(await orch.defaultBaseBranch(pi as never, "/tmp/wt"), "develop");

  const broken = makeFakePi(async () => ({ code: 1, stdout: "", stderr: "gh is not logged in" }));
  assert.equal(
    await orch.defaultBaseBranch(broken as never, "/tmp/wt"),
    "main",
    "an unreachable gh falls back rather than blocking the PR",
  );
});

test("P2 F10: a branch with nothing on it refuses before gh pr create, and says why", async () => {
  const calls: string[] = [];
  const pi = makeFakePi(async (cmd, args) => {
    calls.push([cmd, ...(args ?? [])].join(" "));
    if (cmd === "gh" && args?.[0] === "repo") {
      return { code: 0, stdout: '{"defaultBranchRef":{"name":"main"}}', stderr: "" };
    }
    if (args?.[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args?.[0] === "rev-list") return { code: 0, stdout: "0\n", stderr: "" };
    if (args?.[0] === "rev-parse" && args?.[1] === "--abbrev-ref") {
      return { code: 0, stdout: "feat/quiesce\n", stderr: "" };
    }
    if (cmd === "gh" && args?.[1] === "view") return { code: 1, stdout: "", stderr: "no PR" };
    return { code: 0, stdout: "", stderr: "" };
  });

  const opened = await orch.openFeaturePr(pi as never, "/tmp/wt", {
    title: "Quiesce identical current-state",
    body: "b",
  });
  assert.equal(opened?.pr, undefined, "nothing was opened");
  assert.match(
    String(opened?.reason),
    /no commits/i,
    `the reason must name the real problem: ${opened?.reason}`,
  );
  assert.match(String(opened?.reason), /origin\/main/, "and the base it compared against");
  assert.equal(
    calls.some((c) => c.startsWith("gh pr create")),
    false,
    "gh pr create is not run against an empty branch",
  );
});

test("P2 F10: a dirty worktree refuses, naming the files", async () => {
  const pi = makeFakePi(async (cmd, args) => {
    if (cmd === "gh" && args?.[0] === "repo") {
      return { code: 0, stdout: '{"defaultBranchRef":{"name":"main"}}', stderr: "" };
    }
    if (args?.[0] === "status") {
      return { code: 0, stdout: " M src/pay.rs\n?? notes.txt\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const opened = await orch.openFeaturePr(pi as never, "/tmp/wt", { title: "t", body: "b" });
  assert.equal(opened?.pr, undefined);
  assert.match(String(opened?.reason), /uncommitted|dirty/i);
  assert.match(String(opened?.reason), /src\/pay\.rs/, "the user needs to know what is uncommitted");
});

test("P2 F10: recoverFeatureWorktree keeps a live path and ignores pending/none", () => {
  const existing = mkdtempSync(join(tmpdir(), "orch-wt-"));
  assert.equal(
    orch.recoverFeatureWorktree({
      repo: "icemining",
      name: "pearl-cert-submit-gate-2",
      worktree: existing,
    }),
    existing,
  );
  assert.equal(
    orch.recoverFeatureWorktree({
      repo: "icemining",
      name: "pending",
      worktree: "none",
      branch: "pending",
    }),
    undefined,
    "pending tokens must not be guessed as farm paths",
  );
});

test("P2 F10: Darwin Cargo.lock alone does not refuse the Feature PR", async () => {
  const pi = makeFakePi(async (cmd, args) => {
    if (cmd === "git" && args?.[0] === "status") {
      return { code: 0, stdout: " M Cargo.lock\n", stderr: "" };
    }
    if (cmd === "git" && args?.[0] === "rev-list") return { code: 0, stdout: "4\n", stderr: "" };
    if (cmd === "git" && args?.[0] === "push") return { code: 0, stdout: "ok", stderr: "" };
    if (cmd === "gh" && args?.[0] === "pr" && args?.[1] === "create") {
      return {
        code: 0,
        stdout: "https://github.com/moofone/icemining/pull/2211\n",
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const opened = await orch.openFeaturePr(pi as never, "/tmp/wt", { title: "t", body: "b" });
  assert.deepEqual(opened, {
    pr: "2211",
    url: "https://github.com/moofone/icemining/pull/2211",
  });
});

test("P2 F10: generated node_modules/target trees do not refuse the Feature PR", async () => {
  assert.equal(
    orch.isToolchainNoisePath(
      "apps/web/apps/web/node_modules/.vite/vitest/hash/_svelte_metadata.json",
    ),
    true,
  );
  assert.equal(
    orch.isToolchainNoisePath(
      "crates/auth-backend/target/codex-sync-hardening/criterion/auth_sync_lmdb/base/benchmark.json",
    ),
    true,
  );
  assert.equal(
    orch.isToolchainNoisePath("crates/auth-backend/src/lib.rs"),
    false,
    "source is never toolchain noise",
  );
  const pi = makeFakePi(async (cmd, args) => {
    if (cmd === "git" && args?.[0] === "status") {
      return {
        code: 0,
        stdout: [
          " D apps/web/apps/web/node_modules/.vite/vitest/hash/_svelte_metadata.json",
          " D crates/auth-backend/target/codex-sync-hardening/criterion/base/benchmark.json",
          " M Cargo.lock",
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    if (cmd === "git" && args?.[0] === "rev-list") return { code: 0, stdout: "5\n", stderr: "" };
    if (cmd === "git" && args?.[0] === "push") return { code: 0, stdout: "ok", stderr: "" };
    if (cmd === "gh" && args?.[0] === "pr" && args?.[1] === "create") {
      return {
        code: 0,
        stdout: "https://github.com/moofone/icemining/pull/2254\n",
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const opened = await orch.openFeaturePr(pi as never, "/tmp/wt", { title: "t", body: "b" });
  assert.deepEqual(opened, {
    pr: "2254",
    url: "https://github.com/moofone/icemining/pull/2254",
  });
});

test("P2 F10: a failed push and a failed create surface their stderr verbatim", async () => {
  const pushFailed = makeFakePi(async (cmd, args) => {
    if (cmd === "gh" && args?.[0] === "repo") {
      return { code: 0, stdout: '{"defaultBranchRef":{"name":"main"}}', stderr: "" };
    }
    if (args?.[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args?.[0] === "rev-list") return { code: 0, stdout: "3\n", stderr: "" };
    if (args?.[0] === "push") {
      return { code: 1, stdout: "", stderr: "! [remote rejected] feat/x -> feat/x (protected branch hook declined)" };
    }
    if (cmd === "gh" && args?.[1] === "view") return { code: 1, stdout: "", stderr: "no PR" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const pushed = await orch.openFeaturePr(pushFailed as never, "/tmp/wt", { title: "t", body: "b" });
  assert.equal(pushed?.pr, undefined);
  assert.match(
    String(pushed?.reason),
    /protected branch hook declined/,
    `the git stderr must reach the user: ${pushed?.reason}`,
  );

  const createFailed = makeFakePi(async (cmd, args) => {
    if (cmd === "gh" && args?.[0] === "repo") {
      return { code: 0, stdout: '{"defaultBranchRef":{"name":"main"}}', stderr: "" };
    }
    if (args?.[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args?.[0] === "rev-list") return { code: 0, stdout: "3\n", stderr: "" };
    if (args?.[0] === "push") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "gh" && args?.[1] === "create") {
      return { code: 1, stdout: "", stderr: "GraphQL: was submitted too quickly (createPullRequest)" };
    }
    if (cmd === "gh" && args?.[1] === "view") return { code: 1, stdout: "", stderr: "no PR" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const created = await orch.openFeaturePr(createFailed as never, "/tmp/wt", { title: "t", body: "b" });
  assert.equal(created?.pr, undefined);
  assert.match(
    String(created?.reason),
    /submitted too quickly/,
    `"no PR number returned" hid the real error: ${created?.reason}`,
  );
});

test("P2 F10: landFeaturePr sends the built body, not --body-file plan.md", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  const start = src.indexOf("async function landFeaturePr");
  const body = src.slice(start, start + 3000);
  assert.match(body, /featurePrBody\(/, "the PR body is built, not the plan file");
  assert.doesNotMatch(
    body,
    /bodyFile:/,
    "--body-file plan.md posted local paths and Worker: lines as the public PR body",
  );
  assert.match(body, /opened\?\.reason/, "a failed open must surface its reason");
});

test("P2 F10: a Context that is the last section of the plan still reaches the PR body", () => {
  const plan = [
    "# Feature: t",
    "",
    "### Task 1 — only task",
    "",
    "## Context",
    "",
    "The last section of the plan is still the body.",
  ].join("\n");
  assert.match(
    orch.featurePrBody(plan, "t"),
    /The last section of the plan is still the body\./,
    "JS has no \\Z: 'to the next H2 or the end' must not silently return nothing",
  );
});

/* ---------------------------------------------------------------- *
 * Phase 3 — the Task and QA lifecycle (F11, F12, F13, F14)
 * ---------------------------------------------------------------- */

test("P3 F11: an uncommitted Task is committed by code, not counted as done", async () => {
  const calls: string[] = [];
  let dirty = " M src/a.ts\n?? src/b.ts";
  const pi = makeFakePi(async (cmd, args) => {
    calls.push([cmd, ...(args ?? [])].join(" "));
    const a = args ?? [];
    if (a[0] === "status") return { code: 0, stdout: dirty, stderr: "" };
    if (a[0] === "commit") {
      dirty = "";
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const gate = await orch.ensureWriterCommit(pi as never, "/wt", "Task 3 — parser");
  assert.equal(gate.state, "committed", "a dirty tree after a writer is committed by code");
  assert.ok(
    calls.some((c) => c.startsWith("git add -- ") && c.includes("src/a.ts") && c.includes("src/b.ts")),
    "untracked new files are added by path, not git add -A",
  );
  assert.equal(
    calls.some((c) => c.includes("git add -A") || /git add -- .*Cargo\.lock/.test(c)),
    false,
    "Darwin Cargo.lock must never be added",
  );
  assert.ok(
    calls.some((c) => c.startsWith("git commit -m Task 3 — parser -- ")),
    "the commit message names the Task; pathspec excludes the lock",
  );
});

test("P3 F11: a commit that does not clear the tree blocks instead of reporting success", async () => {
  const pi = makeFakePi(async (_cmd, args) => {
    const a = args ?? [];
    if (a[0] === "status") return { code: 0, stdout: " M src/a.ts", stderr: "" };
    if (a[0] === "commit") return { code: 1, stdout: "", stderr: "nothing to commit, hook failed" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const gate = await orch.ensureWriterCommit(pi as never, "/wt", "Task 1 — x");
  assert.equal(gate.state, "dirty", "a failed commit is not a closed gate");
  assert.match(gate.reason, /hook failed/, "the git stderr reaches the user verbatim");
});

test("P3 F11: an already-clean tree runs no commit at all", async () => {
  const calls: string[] = [];
  const pi = makeFakePi(async (cmd, args) => {
    calls.push([cmd, ...(args ?? [])].join(" "));
    return { code: 0, stdout: "", stderr: "" };
  });
  const gate = await orch.ensureWriterCommit(pi as never, "/wt", "Task 1 — x");
  assert.equal(gate.state, "clean", "the worker committed; there is nothing for code to do");
  assert.deepEqual(
    calls.filter((c) => c.includes("commit") || c.includes("add")),
    [],
    "code must not manufacture an empty commit on a clean tree",
  );
});

test("P3 F11: git that cannot answer is inconclusive, never a silent land", async () => {
  const pi = makeFakePi(async () => ({ code: 128, stdout: "", stderr: "not a git repository" }));
  const gate = await orch.ensureWriterCommit(pi as never, "/wt", "Task 1 — x");
  assert.equal(gate.state, "unknown", "an unreadable status must not be read as clean or dirty");
  assert.equal(
    await orch.porcelainStatus(pi as never, "/wt"),
    undefined,
    "porcelainStatus distinguishes 'clean' from 'git could not say'",
  );
});

test("P3 F11: Task 1 refuses to start on a tree that already has someone else's changes", () => {
  const pending = [
    { id: "1", title: "a", status: "pending" },
    { id: "2", title: "b", status: "pending" },
  ] as never;
  const started = [
    { id: "1", title: "a", status: "done" },
    { id: "2", title: "b", status: "pending" },
  ] as never;
  const dirty = " M auth/admin.ts\n M auth/user.ts";

  const refusal = orch.firstTaskBlockedByDirtyTree(pending, dirty);
  assert.ok(refusal, "nothing has run yet: those edits are not this Feature's to commit");
  assert.match(refusal!, /dirty worktree/, "the reason says what it is");
  assert.match(refusal!, /auth\/admin\.ts/, "and names the files, so the user can act");

  assert.equal(
    orch.firstTaskBlockedByDirtyTree(started, dirty),
    undefined,
    "once a Task has run, a dirty tree is this Feature's own work and the commit gate owns it",
  );
  assert.equal(
    orch.firstTaskBlockedByDirtyTree(pending, ""),
    undefined,
    "a clean tree is not a refusal",
  );
  assert.equal(
    orch.firstTaskBlockedByDirtyTree(pending, undefined),
    undefined,
    "git that could not answer must not block the Feature on its own",
  );
  assert.equal(
    orch.firstTaskBlockedByDirtyTree(pending, " M Cargo.lock"),
    undefined,
    "Darwin Cargo.lock is toolchain noise, not foreign work before Task 1",
  );
  assert.equal(
    orch.firstTaskBlockedByDirtyTree(
      pending,
      " D crates/auth-backend/target/criterion/base/benchmark.json\n D apps/web/node_modules/.vite/x.json",
    ),
    undefined,
    "generated target/ and node_modules trees are not foreign work before Task 1",
  );
  assert.match(
    orch.firstTaskBlockedByDirtyTree(pending, " M Cargo.lock\n M auth/admin.ts") ?? "",
    /auth\/admin\.ts/,
    "real dirt still refuses even when a lockfile is also dirty",
  );
});

test("P3 F11: Cargo.lock-only dirt is restored, not committed or blocked", async () => {
  const calls: string[] = [];
  let dirty = " M Cargo.lock";
  const pi = makeFakePi(async (cmd, args) => {
    calls.push([cmd, ...(args ?? [])].join(" "));
    const a = args ?? [];
    if (a[0] === "status") return { code: 0, stdout: dirty, stderr: "" };
    if (a[0] === "restore") {
      dirty = "";
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const gate = await orch.ensureWriterCommit(pi as never, "/wt", "Task 1 — x");
  assert.equal(gate.state, "clean", "lockfile noise is not a Task commit");
  assert.ok(calls.some((c) => c.startsWith("git restore")), "code restores the lock to HEAD");
  assert.deepEqual(
    calls.filter((c) => c.includes("commit") || c.startsWith("git add")),
    [],
    "must not try to commit a Darwin-rewritten Cargo.lock",
  );
});

test("P3 F11: Cargo.lock-only dirt does not block when restore fails", async () => {
  const pi = makeFakePi(async (_cmd, args) => {
    const a = args ?? [];
    if (a[0] === "status") return { code: 0, stdout: " M Cargo.lock", stderr: "" };
    if (a[0] === "restore") return { code: 1, stdout: "", stderr: "restore refused" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const gate = await orch.ensureWriterCommit(pi as never, "/wt", "Task 1 — x");
  assert.equal(gate.state, "clean", "a failed lock restore is not a Feature block");
});

test("P3 F11: a real edit still commits when Cargo.lock is also dirty", async () => {
  const calls: string[] = [];
  let dirty = " M src/a.ts\n M Cargo.lock";
  const pi = makeFakePi(async (cmd, args) => {
    calls.push([cmd, ...(args ?? [])].join(" "));
    const a = args ?? [];
    if (a[0] === "status") return { code: 0, stdout: dirty, stderr: "" };
    if (a[0] === "add") {
      assert.equal(a.includes("Cargo.lock"), false, "git add must not take the lock");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (a[0] === "commit") {
      assert.equal(a.includes("Cargo.lock"), false, "git commit pathspec must not include the lock");
      dirty = " M Cargo.lock";
      return { code: 0, stdout: "", stderr: "" };
    }
    if (a[0] === "restore") {
      if (a.includes("--worktree") || !a.includes("--staged")) dirty = "";
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const gate = await orch.ensureWriterCommit(pi as never, "/wt", "Task 1 — x");
  assert.equal(gate.state, "committed");
  assert.equal(calls.some((c) => c === "git add -A" || c.startsWith("git add -A ")), false);
  assert.ok(calls.some((c) => c.startsWith("git add -- ") && c.includes("src/a.ts")));
  assert.ok(calls.some((c) => c.includes("commit") && c.includes("src/a.ts")));
});

test("P3 F11: a staged Darwin lock does not block a real-file commit when restore fails", async () => {
  const calls: string[] = [];
  let dirty = "M  src/a.ts\nM  Cargo.lock";
  const pi = makeFakePi(async (cmd, args) => {
    calls.push([cmd, ...(args ?? [])].join(" "));
    const a = args ?? [];
    if (a[0] === "status") return { code: 0, stdout: dirty, stderr: "" };
    if (a[0] === "restore") return { code: 1, stdout: "", stderr: "restore refused" };
    if (a[0] === "commit") {
      if (a.includes("Cargo.lock")) {
        return {
          code: 1,
          stdout: "",
          stderr: "Cargo.lock must not be committed from macOS (ops-canonical lock policy).",
        };
      }
      dirty = "M  Cargo.lock";
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const gate = await orch.ensureWriterCommit(pi as never, "/wt", "Task 3 — parser");
  assert.equal(gate.state, "committed", "pathspec commit lands the Task without the lock");

});

test("P3 F12: the QA cap is two passes, so QA's own remediation Tasks get reviewed", () => {
  const status = ["# Status", "qa_pass: 0", "next_action: x"].join("\n");
  assert.equal(
    orch.clampedQaPassCap(Number.NaN),
    2,
    "default cap 2: QA → fix → QA → fix → PR, not QA → fix → PR",
  );
  assert.equal(orch.clampedQaPassCap(9), 2, "MAX_QA_PASS_CAP still bounds it");
  assert.equal(orch.clampedQaPassCap(0), 0, "an explicit 0 opts out of QA entirely");
  assert.match(
    readFileSync(ORCH_SRC, "utf8"),
    /const DEFAULT_QA_PASS_CAP = 2;/,
    "the seeded qa_pass_cap in a new status.md follows the default",
  );
  assert.ok(status.includes("qa_pass: 0"), "qa_pass counts completed passes only");
});

test("P3 F12: a QA child that fails is retried once before the Feature parks", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  const chain = src.slice(src.indexOf("if (needsFeatureQa(status))"));
  const block = chain.slice(0, chain.indexOf("// ---- Everything done"));
  assert.equal(
    (block.match(/runFeatureQa\(/g) ?? []).length,
    2,
    "one retry: a transport or schema flake is not a QA verdict",
  );
  assert.match(
    block,
    /if \(added < 0\) return;/,
    "after the retry, a still-failing QA parks the Feature rather than opening a PR",
  );
});

test("P3 F13: a Task whose verified gate came back red never auto-advances", () => {
  const settle = orch.settleTaskOutcome;
  assert.deepEqual(
    settle({ ok: false, landed: true, autoAdvance: true, gated: true }),
    { action: "blocked", reason: "failed_gate" },
    "a `- Command:` gate that ran and failed is a fact about the code, not a harness quirk",
  );
  assert.deepEqual(
    settle({ ok: false, landed: true, autoAdvance: true, gated: false }),
    { action: "done_continue", reason: "failed_but_landed" },
    "an ungated Task keeps the old reading: the child's self-report is the only thing that failed",
  );
  assert.equal(
    settle({ ok: true, landed: true, autoAdvance: true, gated: true }).action,
    "done_continue",
    "a green gate still advances",
  );
  assert.equal(
    settle({ ok: false, stopped: true, landed: true, autoAdvance: true, gated: true }).action,
    "pending_pause",
    "a user pause outranks the gate: it is not a failure at all",
  );
});

test("P3 F13: orphan recovery is not a softer path past a red gate", () => {
  const snap = { state: "failed", terminal: true, ok: false, stopped: false, startedAtMs: 1 };
  assert.equal(
    orch.orphanDecision(snap, true, true, true),
    "blocked",
    "recovery must decide what the live chain would have decided",
  );
  assert.equal(
    orch.orphanDecision(snap, true, true, false),
    "done",
    "an ungated Task that landed still advances, as before",
  );
});

test("P3 F13: the gate result is recorded on the Task's handoff line", () => {
  assert.equal(orch.taskGateResult({ gated: false, ok: false }), "none");
  assert.equal(orch.taskGateResult({ gated: true, ok: true }), "green");
  assert.equal(orch.taskGateResult({ gated: true, ok: false }), "red");
  assert.match(
    readFileSync(ORCH_SRC, "utf8"),
    /const handoffLine = `\$\{handoff\}  gate: \$\{gateResult\}`;/,
    "plan.md carries the gate colour, so the next reader does not have to re-derive it",
  );
});

test("P3 F14: a plan-reviewer that died with its session no longer wedges the Feature", () => {
  const r = orch.planReviewReconcile;
  assert.equal(
    r("running", undefined),
    "failed",
    "recorded running with no run artifact is the wedge itself: reset it so review re-runs",
  );
  assert.equal(
    r("running", { state: "running", terminal: false, ok: false, stopped: false, startedAtMs: 1 }),
    "wait",
    "a genuinely live reviewer is still waited on — one writer at a time",
  );
  assert.equal(
    r("running", { state: "complete", terminal: true, ok: true, stopped: false, startedAtMs: 1 }),
    "done",
    "a reviewer that finished after its session died has done the work; record it",
  );
  assert.equal(
    r("running", { state: "failed", terminal: true, ok: false, stopped: false, startedAtMs: 1 }),
    "failed",
    "a terminal failure re-runs rather than blocking approve forever",
  );
  for (const state of ["none", "done", "failed"] as const) {
    assert.equal(r(state, undefined), "keep", "only `running` is reconciled");
  }
});

test("P3 F14: reconcilePlanReview clears the wedge and lets approve through", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-f14-"));
  try {
    const paths = { statusFile: join(dir, "status.md"), planFile: join(dir, "plan.md") } as never;
    writeFileSync(
      (paths as { statusFile: string }).statusFile,
      [
        "# Status",
        "repo: r",
        "plan: p",
        "phase: reviewing",
        "plan_review: running",
        "reviewer_run_id: dead-run",
        "reviewer_run_dir: /nonexistent/run/dir",
        "next_action: x",
        "",
      ].join("\n"),
    );
    const notices: string[] = [];
    const ctx = {
      ui: { notify: (m: string) => notices.push(String(m)) },
    } as never;
    const before = readFileSync((paths as { statusFile: string }).statusFile, "utf8");
    assert.equal(
      orch.writerBlockedByPlanReview(before),
      "plan-reviewer still running; refusing writer",
      "as found: every approve and resume is refused",
    );

    const proceed = orch.reconcilePlanReview(ctx, paths);
    assert.equal(proceed, true, "a dead reviewer must not stop the caller");
    const after = readFileSync((paths as { statusFile: string }).statusFile, "utf8");
    assert.equal(
      orch.planReviewState(after),
      "failed",
      "the field is settled on disk, so the next session does not repeat the diagnosis",
    );
    assert.equal(
      orch.writerBlockedByPlanReview(after),
      undefined,
      "and approve is reachable again",
    );
    assert.match(after, /reviewer_run_id: none/, "the dead run id is cleared with it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P3 F14: reviewPlan records the run it spawned", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  const fn = src.slice(src.indexOf("async function reviewPlan("));
  const body = fn.slice(0, fn.indexOf("\nasync function "));
  assert.match(
    body,
    /reviewerRunId: runId, reviewerRunDir: asyncRunDir\(runId\)/,
    "without the run id there is nothing for reconciliation to read",
  );
  const okAt = body.lastIndexOf("if (!review.ok)");
  const success = body.slice(okAt);
  assert.match(
    success,
    /phase: "reviewing"/,
    "after review, stay in reviewing so approve can move reviewing → implementing",
  );
  assert.equal(
    /phase: "planning"/.test(success),
    false,
    "resetting to planning makes planning → implementing illegal and wedges the Feature",
  );
  const begin = src.slice(src.indexOf("async function beginImplementation("));
  assert.ok(
    begin.indexOf("reconcilePlanReview(ctx, paths)") <
      begin.indexOf("needsPlanReview(readText(paths.planFile)"),
    "reconcile first: both gates below must see the settled field, not the stale one",
  );
});

/* ------------------------------------------------------------------ *
 * Phase 4 — Plan → approve (F15, F16, F22)
 * ------------------------------------------------------------------ */

test("P4 F15: the approve-card path names nothing", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  const fn = src.slice(src.indexOf("function presentDraftApproveCards("));
  const body = fn.slice(0, fn.indexOf("\nfunction ", 1));
  assert.equal(
    body.includes("ensureFeatureNamed"),
    false,
    "renaming from agent_settled is F15: it moves the folder out from under a " +
      "planner child that is still writing to the path it was handed",
  );
  assert.equal(
    body.includes("bindFeature("),
    false,
    "and nothing in the card path may rebind a Feature to a new directory",
  );
});

test("P4 F15: the planner completion path names once, inside the chain lock", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  const plan = src.indexOf('runChildInPhase(pi, ctx, "plan"');
  const lock = src.lastIndexOf("withChainLock(pendingDir", plan);
  const name = src.indexOf("ensureFeatureNamed(feat, readText(feat.planFile))", plan);
  assert.ok(lock > 0 && lock < plan, "planner spawn is inside the lock");
  assert.ok(name > plan, "naming must happen after the planner child exits, still inside the lock");
  assert.ok(
    src.indexOf("reviewPlan(pi, ctx, feat", name) > name,
    "and the reviewer starts on the named folder, not the pending one",
  );
  assert.equal(
    src.split("ensureFeatureNamed(").length - 1 <= 5,
    true,
    "every extra naming site is another chance to rename a live folder",
  );
});

test("P4 F15: an unnamed draft still gets a card — the name is derived, not written", () => {
  const plan = [
    "# Feature: Something Real",
    "> Status: DRAFT",
    "> Name: pending",
    "> Branch: pending",
  ].join("\n");
  const cards = orch.draftApproveCards([
    {
      archived: false,
      dir: "/tmp/orch/pending-2026-09-02T11-13-31-967Z",
      name: "pending-2026-09-02T11-13-31-967Z",
      plan,
      status: "name: pending\nplan_review: done\n",
    },
  ]);
  assert.equal(cards.length, 1, "removing the rename must not hide the Feature");
  assert.equal(cards[0]?.name, "something-real");
  assert.equal(cards[0]?.command, "/orchestrate approve something-real");
  assert.equal(
    cards[0]?.dir,
    "/tmp/orch/pending-2026-09-02T11-13-31-967Z",
    "the folder is still the pending one: the card renders an identity, it does not create one. " +
      "`discoverFeatures` derives the same name, so the command resolves and approve does the rename.",
  );
});

test("P4 F16: approve refuses a repo with no origin, and says so in one line", () => {
  const refused = orch.approveRemoteRequirement({
    hostBase: false,
    originUrl: "",
    repo: "pi-orchestrate",
  });
  assert.equal(refused.ok, false);
  assert.match(
    (refused as { reason: string }).reason,
    /pi-orchestrate has no git remote "origin"/,
    "the reason names the repo and the missing remote, not git internals",
  );
  assert.equal(
    (refused as { reason: string }).reason.includes("\n"),
    false,
    "one line: this is a refusal, not a git error dump",
  );
  assert.deepEqual(
    orch.approveRemoteRequirement({
      hostBase: false,
      originUrl: "git@github.com:me/repo.git",
      repo: "repo",
    }),
    { ok: true },
  );
  assert.deepEqual(
    orch.approveRemoteRequirement({ hostBase: true, originUrl: "", repo: "pi-extensions" }),
    { ok: true },
    "a host base materializes its worktree by copy + git init and never opens a PR",
  );
});

test("P4 F16: markPlanApproved rewrites, inserts after the title, or prepends", () => {
  assert.match(
    orch.markPlanApproved("# Feature: X\n\n> Status: DRAFT — awaiting approval\n"),
    /^> Status: APPROVED$/m,
  );
  assert.equal(
    orch.markPlanApproved("# Feature: X\n\n> Status: DRAFT\n").includes("DRAFT"),
    false,
    "the DRAFT line is replaced, not duplicated",
  );
  assert.match(
    orch.markPlanApproved("# Feature: X\n\nbody\n"),
    /# Feature: X\n\n> Status: APPROVED/,
  );
  assert.match(orch.markPlanApproved("body only\n"), /^> Status: APPROVED\nbody only/);
});

test("P4 F16: nothing is written before the refusals are past", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  const verb = src.slice(src.indexOf('      if (verb === "approve") {'));
  const body = verb.slice(0, verb.indexOf('if (verb === "implement"'));
  assert.equal(
    body.includes("markPlanApproved"),
    false,
    "F16: the approve verb writes no status marker at all — beginImplementation does, " +
      "under the chain lock, once the worktree exists",
  );
  assert.ok(
    body.indexOf("approveRemoteRequirement") < body.indexOf("ensureFeatureNamed"),
    "the remote check is read-only and comes first; naming renames a folder",
  );
  assert.ok(
    body.indexOf("ensureFeatureNamed") < body.indexOf("beginImplementation(pi, ctx, feat"),
    "and the chain only starts on a Feature that has a real name",
  );
});

test("P4 F16: APPROVED is written after the worktree exists and the Tasks parse", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  const fn = src.slice(src.indexOf("async function beginImplementation("));
  const body = fn.slice(0, fn.indexOf("\npi.registerCommand"));
  const wt = body.indexOf("ensureFeatureWorktree(pi, ctx, paths, named.branch)");
  const tasks = body.indexOf("parseTasks(named.plan)");
  const approved = body.indexOf("markPlanApproved(readText(paths.planFile))");
  assert.ok(wt > 0 && tasks > wt && approved > tasks, "validate → lock → APPROVED → chain");
  assert.ok(
    body.indexOf("opts.approve && isDraft(plan)") > 0,
    "the DRAFT guard must not reject the very approve that is about to lift it",
  );
});

test("P4 F22: the worktree comes from the Rust command, with --yes, and nothing else", () => {
  const src = readFileSync(ORCH_SRC, "utf8");
  assert.match(
    src,
    /pi\.exec\("git", \["wt", branch, "--yes"\]/,
    "ghl-wt prompts y\\/N on stdin; under pi.exec stdin is empty, so every call " +
      "without --yes exited `aborted`",
  );
  assert.equal(
    src.includes("GIT_WT"),
    false,
    "the ~/glm-review/git-wt.sh fallback is deleted: one implementation, the Rust one",
  );
  assert.equal(
    src.includes("glm-review"),
    false,
    "and no path to the retired shell script survives",
  );
});

test("P4 F22: the worktree failure leads with git's own words", () => {
  const message = orch.worktreeFailureMessage(
    "feat/thing",
    { stderr: "ghl-wt: fatal: 'origin' does not appear to be a git repository\n", stdout: "" },
    "pi-orchestrate-wt",
  );
  const lines = message.split("\n");
  assert.match(lines[0]!, /^git wt feat\/thing --yes produced no worktree\.$/);
  assert.equal(
    lines[1],
    "ghl-wt: fatal: 'origin' does not appear to be a git repository",
    "verbatim, and second — it is the only text that says why",
  );
  assert.match(message, /pi-orchestrate-wt\//);
  assert.match(
    orch.worktreeFailureMessage("feat/x", {}, "farm"),
    /\(no output\)/,
    "a silent failure still has to render",
  );
});

/* ---------------------------------------------------------------- *
 * Phase 5 — the status.md phase schema (F21).
 *
 * `phase` is free text in a text file, matched by regexes and Sets spread
 * across three modules. Nothing kept the writers and the readers in agreement,
 * and they were not: `liveFeatureNeedsIdleParent` tested `^(implement|pr|qa)$`
 * against a file that says `implementing` and `feature-qa`, and stayed wrong
 * for days in every session in the repo (F8).
 *
 * `FeaturePhase` closes one direction at compile time — a write of a phase not
 * in the list will not typecheck. These tests close the other: a reader that
 * matches a name no writer produces is dead code that looks like coverage.
 * ---------------------------------------------------------------- */

const PHASE_READERS = [
  "src/orchestrate.ts",
  "src/lib/pr-await-core.ts",
  "src/lib/pr-reconcile.ts",
] as const;

function readRepoFile(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

test("P5 F21: every phase written is one of the declared phases", () => {
  const declared = new Set<string>(orch.FEATURE_PHASES as readonly string[]);
  assert.ok(declared.size > 0);

  const written = new Set<string>();
  for (const rel of PHASE_READERS) {
    for (const m of readRepoFile(rel).matchAll(/\bphase:\s*"([a-z][a-z-]*)"/g)) {
      written.add(m[1]!);
    }
  }
  assert.ok(written.size >= 6, `expected to find the phase writes; found ${[...written]}`);
  assert.deepEqual(
    [...written].filter((p) => !declared.has(p)).sort(),
    [],
    "a phase written but not declared is a value no reader was taught",
  );
});

test("P5 F21: every phase a reader matches is one a writer produces", () => {
  // One vocabulary, no aliases: a reader comparing against anything outside
  // FEATURE_PHASES is comparing against a value nothing can write.
  const known = new Set<string>(orch.FEATURE_PHASES as readonly string[]);

  const matched = new Set<string>();
  for (const rel of PHASE_READERS) {
    const src = readRepoFile(rel);
    for (const m of src.matchAll(/\bphase\s*[!=]==\s*"([a-z][a-z-]*)"/g)) matched.add(m[1]!);
    for (const m of src.matchAll(/PHASES\s*=\s*new Set\(\[([^\]]*)\]\)/g)) {
      for (const s2 of m[1]!.matchAll(/"([a-z][a-z-]*)"/g)) matched.add(s2[1]!);
    }
  }
  assert.deepEqual(
    [...matched].filter((p) => !known.has(p)).sort(),
    [],
    "a reader matching a phase nobody writes is the F8 bug, which read for days as coverage",
  );
});

test("P5 F21: the idle-parent gate covers exactly the phases that own a writer", () => {
  const src = readRepoFile("src/orchestrate.ts");
  const set = src.match(/IDLE_PARENT_PHASES\s*=\s*new Set\(\[([^\]]*)\]\)/)?.[1] ?? "";
  const phases = [...set.matchAll(/"([a-z][a-z-]*)"/g)].map((m) => m[1]!).sort();
  assert.deepEqual(
    phases,
    ["feature-qa", "implementing", "pr"],
    "these are the phases in which a Feature holds a writer and a branch; " +
      "`planning` and `reviewing` own no worktree, and a `paused` or `blocked` " +
      "Feature is not running anything for the parent to stay out of the way of",
  );
});
