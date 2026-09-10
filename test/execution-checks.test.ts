import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, realpath, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckExecutor, decodeCheckReport } from "../src/lib/execution-checks.ts";
import { fakeWorkspace } from "./fixtures/execution/fakes.ts";
import type { CheckSpec } from "../src/lib/execution-contract.ts";
const fixtures = { node: "node.tap", vitest: "vitest.json", cargo: "cargo.jsonl" };
async function fixture(runner: keyof typeof fixtures) { return readFile(new URL(`./fixtures/execution/reports/${fixtures[runner]}`, import.meta.url), "utf8"); }
function spec(runner: CheckSpec["runner"] = "node"): CheckSpec { return { id: "test-check", cwd: ".", argv: runner === "vitest" ? ["vitest", "run", "--reporter=json", "--outputFile=report.json"] : ["node", "--test"], runner, expectedEvidence: { reportPath: "report.json", requiredTests: ["selected test"] } }; }
async function workspace() { return { ...fakeWorkspace(), path: await realpath(await mkdtemp(join(tmpdir(), "execution-checks-"))) }; }
test("execution-checks decodes native Node TAP, Vitest JSON and Cargo streams, allowing unrelated skips", async () => {
 for (const runner of ["node", "vitest", "cargo"] as const) assert.deepEqual(decodeCheckReport(runner, await fixture(runner)), { executedTests: ["selected test"], skippedTests: ["unrelated test"], failed: false });
});
test("execution-checks executes argv without a shell and records unique fresh reports for each runner", async () => {
 for (const runner of ["node", "vitest", "cargo"] as const) {
  const ws = await workspace(), raw = await fixture(runner); let calls = 0;
  const executor = createCheckExecutor({ exec: async (file, args, options) => { calls++; assert.equal(file, runner === "vitest" ? "vitest" : "node"); assert.equal(options.cwd, ws.path); if (runner === "vitest") await writeFile(args.find(arg => arg.startsWith("--outputFile="))!.slice("--outputFile=".length), raw); return { exitCode: 0, stdout: raw, stderr: "" }; }, now: () => 1 });
  const check = spec(runner), evidence = await executor.execute(check, { workspace: ws, invocationId: runner, startedAt: 1 });
  assert.equal(evidence.status, "passed", evidence.reason ?? "check failed"); assert.ok(evidence.reportPath?.includes(`.execution-check-${runner}`));
  assert.equal(executor.validateEvidence(check, evidence, { invocationId: runner, notBefore: 1 }).valid, true);
  assert.equal(executor.validateEvidence(check, evidence, { invocationId: "foreign", notBefore: 1 }).valid, false);
  assert.equal((await executor.execute(check, { workspace: ws, invocationId: runner, startedAt: 1 })).status, "unknown"); assert.equal(calls, 1);
 }
});
test("execution-checks refuses zero/all-skipped/missing selections and exit/report contradiction", async () => {
 const raw = await fixture("node");
 for (const [report, exitCode, required] of [
  [raw.replace("ok 1 - selected test", "ok 1 - selected test # SKIP"), 0, "selected test"],
  [raw, 0, "absent"], [raw, 1, "selected test"],
  ["TAP version 13\n1..0\n# tests 0\n# fail 0\n", 0, "selected test"],
  [raw.replace("ok 1 - selected test", "not ok 1 - selected test").replace("# fail 0", "# fail 1"), 0, "selected test"],
 ] as const) {
  const executor = createCheckExecutor({ exec: async () => ({ exitCode, stdout: report, stderr: "" }), now: () => 1 }); const check = spec(); check.expectedEvidence.requiredTests = [required];
  assert.notEqual((await executor.execute(check, { workspace: await workspace(), invocationId: "selection", startedAt: 1 })).status, "passed");
 }
});
test("execution-checks refuses missing and stale Vitest reports", async () => {
 for (const stale of [false, true]) {
  const executor = createCheckExecutor({ exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), ...(stale ? { stat: async () => ({ mtimeMs: 0, isFile: () => true }) } : {}), now: () => 10 });
  const result = await executor.execute(spec("vitest"), { workspace: await workspace(), invocationId: "report", startedAt: 10 }); assert.equal(result.status, "unknown");
 }
});
test("execution-checks validates failures and refuses malformed/contradictory native reports", async () => {
 const vitest = JSON.parse(await fixture("vitest")); vitest.testResults[0].assertionResults[0].status = "failed"; vitest.numFailedTests = 1; vitest.numPassedTests = 0; vitest.success = false;
 assert.equal(decodeCheckReport("vitest", JSON.stringify(vitest)).failed, true);
 vitest.success = true; assert.throws(() => decodeCheckReport("vitest", JSON.stringify(vitest)), /contradict/);
 assert.throws(() => decodeCheckReport("cargo", '{"type":"suite","event":"started","test_count":2}\n'), /Incomplete/);
 assert.throws(() => decodeCheckReport("node", "arbitrary success"), /TAP/);
 const failed = (await fixture("cargo")).replace('"name":"selected test","event":"ok"', '"name":"selected test","event":"failed"').replace('"type":"suite","event":"ok"', '"type":"suite","event":"failed"').replace('"passed":1,"failed":0', '"passed":0,"failed":1');
 assert.equal(decodeCheckReport("cargo", failed).failed, true);
});
test("execution-checks refuses escaped cwd/report paths and symlinks before execution", async () => {
 const ws = await workspace(), outside = await workspace(); await symlink(outside.path, join(ws.path, "escape"));
 let calls = 0; const executor = createCheckExecutor({ exec: async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; } });
 for (const [index, check] of [{ ...spec(), cwd: ".." }, { ...spec(), cwd: "escape" }, { ...spec(), expectedEvidence: { reportPath: "../report.json", requiredTests: [] } }, { ...spec(), expectedEvidence: { reportPath: "escape/report.json", requiredTests: [] } }].entries()) assert.equal((await executor.execute(check, { workspace: ws, invocationId: `escape-${index}`, startedAt: 1 })).status, "unknown");
 assert.equal(calls, 0);
});
test("execution-checks requires command rationale and passes metacharacters as literal argv", async () => {
 const ws = await workspace(); let observed: string[] = [];
 const executor = createCheckExecutor({ exec: async (_file, args) => { observed = args; return { exitCode: 0, stdout: "", stderr: "" }; } });
 const check: CheckSpec = { id: "command", cwd: ".", runner: "command", argv: ["printf", "$(touch forbidden); literal"], expectedEvidence: { requiredTests: [] } };
 assert.equal((await executor.execute(check, { workspace: ws, invocationId: "bad", startedAt: 1 })).status, "unknown");
 check.expectedEvidence.rationale = "Validate generated documentation";
 assert.equal((await executor.execute(check, { workspace: ws, invocationId: "good", startedAt: 1 })).status, "passed"); assert.deepEqual(observed, ["$(touch forbidden); literal"]);
});
test("execution-checks default process executor validates an actual Node test report", async () => {
 const ws = await workspace(); await writeFile(join(ws.path, "case.test.mjs"), 'import test from "node:test"; test("selected test", () => {});\n');
 const check = spec(); check.argv = [process.execPath, "--test", "--test-reporter=tap", "case.test.mjs"];
 const executor = createCheckExecutor(); const result = await executor.execute(check, { workspace: ws, invocationId: "actual-node", startedAt: Date.now() }); assert.equal(result.status, "passed", result.reason ?? "check failed");
});

test("execution-checks native Node suite names identify executed leaves, not suite success", async () => {
 const ws = await workspace(); await writeFile(join(ws.path, "suite.test.mjs"), 'import { describe, it } from "node:test"; describe("suite", () => { it("selected test", () => {}); it.skip("other", () => {}); });\n');
 const check = spec(); check.argv = [process.execPath, "--test", "--test-reporter=tap", "suite.test.mjs"]; check.expectedEvidence.requiredTests = ["suite > selected test"];
 const result = await createCheckExecutor().execute(check, { workspace: ws, invocationId: "node-suite", startedAt: Date.now() });
 assert.equal(result.status, "passed", result.reason ?? "suite failed"); assert.deepEqual(result.executedTests, ["suite > selected test"]);
});
test("execution-checks persisted invocation markers prevent replay in a new executor", async () => {
 const ws = await workspace(), raw = await fixture("node"); let calls = 0;
 const options = { exec: async () => { calls++; return { exitCode: 0, stdout: raw, stderr: "" }; }, now: () => 1 };
 const context = { workspace: ws, invocationId: "durable-invocation", startedAt: 1 };
 assert.equal((await createCheckExecutor(options).execute(spec(), context)).status, "passed");
 assert.equal((await createCheckExecutor(options).execute(spec(), context)).status, "unknown"); assert.equal(calls, 1);
});
