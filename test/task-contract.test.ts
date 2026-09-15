import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { capturePlanBaseline, baselineMismatch, acceptCompletedDependency, writePlanBaseline, taskChecks } from "../src/lib/task-contract.ts";
import { checkTestReport } from "../src/lib/task-check.ts";
import * as orch from "../src/orchestrate.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "orch-task-contract-"));
  const paths = { repo: "test", gitRoot: dir, featureDir: dir, planFile: join(dir, "plan.md"),
    statusFile: join(dir, "status.md"), handoffsDir: join(dir, "handoffs"), repoDir: dir, archiveDir: dir };
  mkdirSync(paths.handoffsDir);
  return { dir, paths, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
const checks = [{ id: "named", cwd: ".", argv: ["node", "--test", "case.test.mjs"], runner: "node", tests: ["reject stale"], minTests: 1, maxTests: 1 },
  { id: "regression", cwd: ".", argv: ["node", "--test", "case.test.mjs"], runner: "node", minTests: 1 }];
function plan() { return `# Feature: Refusal format
### Task 1 — Previous change
- Status: done
- Handoff: previous
### Task 2 — Response format
- Status: pending
- Kind: implement
- Files: ["gate.ts", "case.test.mjs"]
- Depends on: [1]
- Starting state: Fence ordering already exists.
- Read: gate.ts::refuse; case.test.mjs::fixture
- Red test: case.test.mjs::reject stale fails on missing v2.
- Implement: Change the refusal JSON.
- Checks:
\`\`\`json
${JSON.stringify(checks)}
\`\`\`
- Acceptance: Both checks pass.
### Task 3 — SECRET_UNRELATED_TASK
- Status: pending
`; }

test("task packet excludes the full plan and includes the previous handoff", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.paths.handoffsDir, "task-1.md"), "Implemented: fence ordering exists.\nCommands: focused gate passed.");
    const params = orch.workerLaunchParams(f.paths, { id: "2", title: "Response format", status: "pending" }, f.dir, plan());
    assert.doesNotMatch(String(params.task), new RegExp(f.paths.planFile.replaceAll(".", "\\.")));
    assert.doesNotMatch(String(params.task), /SECRET_UNRELATED_TASK/);
    assert.match(String(params.task), /focused gate passed/);
    assert.match(String(params.task), /already.*green|already.*satisfied/i);
  } finally { f.dispose(); }
});

test("every structured check reaches host acceptance with an explicit cwd", () => {
  const f = fixture();
  try {
    const params = orch.workerLaunchParams(f.paths, { id: "2", title: "Response format", status: "pending" }, f.dir, plan());
    const acceptance = params.acceptance as { level: string; verify: { id: string; cwd: string; command: string }[] };
    assert.equal(acceptance.level, "verified");
    assert.deepEqual(acceptance.verify.map(c => c.id), ["named", "regression"]);
    assert.ok(acceptance.verify.every(c => c.cwd === f.dir));
  } finally { f.dispose(); }
});

test("malformed structured checks refuse dispatch instead of falling back to ungated acceptance", () => {
  const f = fixture();
  try {
    assert.throws(() => orch.workerLaunchParams(f.paths, { id: "2", title: "Response format", status: "pending" }, f.dir,
      plan().replace(JSON.stringify(checks), "[{broken}]")), /Checks/);
  } finally { f.dispose(); }
});


test("source drift returns to the reviewer before a task can be admitted", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "gate.ts"), "old");
    const task = { id: "2", body: orch.taskSection(plan(), "2"), cwd: f.dir };
    const save = () => writePlanBaseline(join(f.dir, "plan-baseline.json"), capturePlanBaseline("a".repeat(40), [task]));
    save();
    let reviews = 0;
    assert.equal(await orch.ensureTaskBaseline(f.paths, task, async () => { reviews++; return false; }), "ready");
    writeFileSync(join(f.dir, "unrelated.txt"), "unrelated");
    assert.equal(await orch.ensureTaskBaseline(f.paths, task, async () => { reviews++; return false; }), "ready");
    writeFileSync(join(f.dir, "gate.ts"), "new");
    assert.equal(await orch.ensureTaskBaseline(f.paths, task, async reason => {
      assert.match(reason, /gate.ts/); reviews++; save(); return true;
    }), "refreshed", "must reload the reviewed task, not dispatch stale instructions");
    assert.equal(reviews, 1);
    assert.equal(await orch.ensureTaskBaseline(f.paths, task, async () => { throw new Error("unexpected review"); }), "ready");
    const changed = { ...task, body: task.body.replace("Change the refusal JSON", "Remove ordering") };
    assert.equal(await orch.ensureTaskBaseline(f.paths, changed, async () => false), "blocked");
  } finally { f.dispose(); }
});

test("only declared dependency changes update the next task baseline", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "gate.ts"), "old");
    const task = { id: "2", body: orch.taskSection(plan(), "2"), cwd: f.dir };
    const independent = { ...task, id: "3", body: task.body.replace("- Depends on: [1]", "- Depends on: []") };
    const baseline = capturePlanBaseline("a".repeat(40), [task, independent]);
    writeFileSync(join(f.dir, "gate.ts"), "new");
    acceptCompletedDependency(baseline, { id: "1", cwd: f.dir, body: '- Files: ["gate.ts"]' }, [task, independent]);
    assert.equal(baselineMismatch(baseline, task), undefined);
    assert.match(baselineMismatch(baseline, independent)!, /gate.ts/);
    assert.equal(baselineMismatch(baseline, { ...task, body: task.body.replace("Status: pending", "Status: in_progress") }), undefined);
    assert.match(baselineMismatch(baseline, { ...task, cwd: join(f.dir, "other") })!, /worktree/);
  } finally { f.dispose(); }
});

test("freshness includes new files and rejects missing check contracts", () => {
  const f = fixture();
  try {
    const task = { id: "2", body: orch.taskSection(plan(), "2"), cwd: f.dir };
    const baseline = capturePlanBaseline("a".repeat(40), [task]);
    writeFileSync(join(f.dir, "case.test.mjs"), "new test");
    assert.match(baselineMismatch(baseline, task)!, /case.test.mjs/);
    assert.throws(() => capturePlanBaseline("a".repeat(40), [{ ...task, body: '- Files: ["gate.ts"]' }]), /Checks/);
  } finally { f.dispose(); }
});

test("check validation rejects accidental broad Vitest routing and ambiguous named selection", () => {
  const block = (value: unknown) => '- Checks:\n```json\n' + JSON.stringify(value) + '\n```';
  assert.throws(() => taskChecks(block([{ ...checks[0], runner: "vitest", argv: ["pnpm", "test", "--", "case.test.ts"] }])), /direct vitest/);
  assert.throws(() => taskChecks(block([{ ...checks[0], maxTests: undefined }])), /maxTests/);
  assert.throws(() => taskChecks(block([{ ...checks[0], cwd: "../canonical" }])), /relative/);
});

test("reports reject zero tests, skipped required tests and accidental broad selection", () => {
  const check = { ...checks[0]!, runner: "vitest" as const };
  const report = (names: string[]) => JSON.stringify({ numPassedTests: names.length, numFailedTests: 0,
    testResults: [{ assertionResults: names.map(fullName => ({ fullName, status: "passed" })) }] });
  assert.match(checkTestReport(check, "", report([]))!, /observed 0/);
  assert.match(checkTestReport(check, "", report(["wrong test"]))!, /required test/);
  assert.match(checkTestReport(check, "", report(["reject stale", "unrelated"]))!, /at most/);
  assert.equal(checkTestReport(check, "", report(["gate reject stale"])), undefined);
  assert.match(checkTestReport({ ...check, runner: "cargo" }, "test result: ok. 0 passed; 0 failed; 12 filtered out;")!, /observed 0/);
});

test("host command executes real Node tests and rejects an exit-zero skipped selection", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "case.test.mjs"), 'import { test } from "node:test"; test("reject stale", () => {});');
    const params = orch.workerLaunchParams(f.paths, { id: "2", title: "Response format", status: "pending" }, f.dir, plan());
    const verify = (params.acceptance as { verify: { command: string; cwd: string }[] }).verify;
    for (const check of verify) execFileSync("/bin/sh", ["-c", check.command], { cwd: check.cwd, stdio: "pipe", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
    writeFileSync(join(f.dir, "case.test.mjs"), 'import { test } from "node:test"; test.skip("reject stale", () => {});');
    const result = spawnSync("/bin/sh", ["-c", verify[0]!.command], { cwd: f.dir, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /observed 0/);
  } finally { f.dispose(); }
});

test("Vitest host wrapper consumes the fresh report and preserves argument boundaries", () => {
  const f = fixture();
  try {
    const fake = join(f.dir, "fake-vitest.mjs");
    writeFileSync(fake, `import { writeFileSync } from "node:fs";
      if (!process.argv.includes("literal $(false)")) process.exit(4);
      const file = process.argv.find(a => a.startsWith("--outputFile=")).slice(13);
      writeFileSync(file, JSON.stringify({numPassedTests:1,numFailedTests:0,testResults:[{assertionResults:[{status:"passed",fullName:"reject stale"}]}]}));`);
    const runner = fileURLToPath(new URL("../src/lib/task-check.ts", import.meta.url));
    const check = { id: "named", cwd: f.dir, argv: [process.execPath, fake, "literal $(false)"], runner: "vitest", tests: ["reject stale"], minTests: 1, maxTests: 1 };
    const result = spawnSync(process.execPath, ["--experimental-strip-types", runner, Buffer.from(JSON.stringify(check)).toString("base64url")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { f.dispose(); }
});


test("planning resolves the remote execution commit instead of canonical HEAD", async () => {
  const calls: string[] = [];
  const pi = { exec: async (command: string, argv: string[]) => {
    calls.push(`${command} ${argv.join(" ")}`);
    if (argv[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
    if (command === "gh") return { code: 0, stdout: '{"defaultBranchRef":{"name":"trunk"}}', stderr: "" };
    if (argv.includes("refs/remotes/origin/trunk^{commit}")) return { code: 0, stdout: "b".repeat(40), stderr: "" };
    throw new Error("unexpected canonical HEAD read");
  }};
  const commit = await orch.planningBase(pi as never, "/reference");
  assert.equal(commit, "b".repeat(40));
  const f = fixture();
  try {
    const prompt = String(orch.plannerLaunchParams(f.paths, "B1", commit).task);
    assert.match(prompt, new RegExp(`git show ${commit}:path`));
    assert.doesNotMatch(prompt, /4–5 Tasks is typical/);
    assert.equal(calls[0], "git fetch origin");
  } finally { f.dispose(); }
});

test("worker discrepancy is routed separately from successful or missing handoffs", () => {
  assert.equal(orch.workerPlanMismatch({ ok: true, raw: { results: [{ output: "Needs plan refresh: comparator no longer exists" }] } }), "comparator no longer exists");
  assert.equal(orch.workerPlanMismatch({ ok: true, summary: "Needs plan refresh: none" }), "");
  assert.equal(orch.workerPlanMismatch({ ok: false, summary: "Tests failed" }), "");
  assert.equal(orch.workerHandoffText({ ok: true, raw: { results: [{ summary: "Already satisfied: fence comparison" }] } }), "Already satisfied: fence comparison");
});


test("review completion records an execution baseline and refuses invalid or changed plans", async () => {
  for (const mode of ["ready", "blocked", "bad-checks", "changed-source", "lost-completed"] as const) {
    const f = fixture();
    try {
      const initial = plan().split("### Task 3")[0]!.replace("# Feature: Refusal format", "# Feature: Refusal format\n> Status: APPROVED\n> Branch: feat/test");
      writeFileSync(f.paths.planFile, initial);
      writeFileSync(f.paths.statusFile, "phase: implementing\nplan_review: done\nnext_action: Reconcile stale gate\n");
      const handlers = new Map<string, Set<(data: unknown) => void>>();
      let completed = false;
      const events = {
        on(name: string, fn: (data: unknown) => void) {
          if (!handlers.has(name)) handlers.set(name, new Set());
          handlers.get(name)!.add(fn);
          return () => handlers.get(name)?.delete(fn);
        },
        emit(name: string, data: unknown) { for (const fn of [...(handlers.get(name) ?? [])]) fn(data); },
      };
      let spawns = 0;
      events.on("subagents:rpc:v1:request", raw => {
        const req = raw as { requestId: string; params: { agent: string; cwd: string; task: string } };
        spawns++;
        assert.equal(req.params.agent, "plan-reviewer");
        assert.equal(req.params.cwd, f.dir);
        assert.match(req.params.task, /Reconcile stale gate/);
        assert.match(req.params.task, new RegExp("Execution source commit: " + "a".repeat(40)));
        let reviewed = initial.replace("# Feature: Refusal format", `# Feature: Refusal format\n> Readiness: ${mode === "blocked" ? "blocked" : "ready"}`);
        if (mode === "bad-checks") reviewed = reviewed.replace(JSON.stringify(checks), "[]");
        if (mode === "lost-completed") reviewed = reviewed.replace("- Status: done", "- Status: pending");
        writeFileSync(f.paths.planFile, reviewed);
        completed = true;
        events.emit(`subagents:rpc:v1:reply:${req.requestId}`, { success: true, data: { details: { runId: "review-fixture" } } });
        events.emit("subagent:async-complete", { runId: "review-fixture", success: true });
      });
      const pi = { events, exec: async (_command: string, args: string[]) => ({ code: 0, stderr: "",
        stdout: args[0] === "rev-parse" ? (completed && mode === "changed-source" ? "b" : "a").repeat(40) : "" }) };
      const ctx = { ui: { notify() {} } };
      const ok = await orch.reviewPlan(pi as never, ctx as never, f.paths, "test", f.dir);
      assert.equal(spawns, 1);
      assert.equal(ok, mode === "ready", mode);
      if (ok) {
        assert.match(readFileSync(join(f.dir, "plan-baseline.json"), "utf8"), /"head": "aaaaaaaa/);
        assert.match(readFileSync(f.paths.statusFile, "utf8"), /next_action: continue remaining Tasks/);
        assert.match(readFileSync(f.paths.planFile, "utf8"), /> Status: APPROVED/);
      } else assert.match(readFileSync(f.paths.statusFile, "utf8"), /plan_review: failed/);
    } finally { f.dispose(); }
  }
});
