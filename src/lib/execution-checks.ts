import { execFile } from "node:child_process";
import { readFile, realpath, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { sourceDigest, validateCheckEvidence, validateCheckSpec, type CheckEvidence, type CheckExecutor, type CheckSpec } from "./execution-contract.ts";

export type CheckReport = { executedTests: string[]; skippedTests: string[]; failed: boolean };
function unique(values: string[]): string[] { return [...new Set(values)]; }
function obj(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed report object"); return value as Record<string, unknown>; }
/** Decode native report bytes, never a worker-authored normalized success claim. */
export function decodeCheckReport(runner: Exclude<CheckSpec["runner"], "command">, raw: string): CheckReport {
 const executedTests: string[] = [], skippedTests: string[] = []; let failed = false, failedCount = 0;
 const add = (name: unknown, status: unknown) => {
  if (typeof name !== "string" || !name) throw new Error("Missing test identity");
  if (["skip", "skipped", "pending", "todo", "ignored"].includes(String(status))) skippedTests.push(name);
  else if (["passed", "ok", "failed", "not ok"].includes(String(status))) { executedTests.push(name); if (["failed", "not ok"].includes(String(status))) { failed = true; failedCount++; } }
  else throw new Error("Unknown test status");
 };
 if (runner === "vitest") {
  const report = obj(JSON.parse(raw)); if (typeof report.success !== "boolean" || !Array.isArray(report.testResults) || !Number.isInteger(report.numTotalTests)) throw new Error("Invalid Vitest JSON report");
  for (const rawSuite of report.testResults) { const suite = obj(rawSuite); if (!Array.isArray(suite.assertionResults)) throw new Error("Missing Vitest assertions"); for (const rawTest of suite.assertionResults) { const test = obj(rawTest); add(test.fullName, test.status); } }
  if (report.numTotalTests !== executedTests.length + skippedTests.length || report.numFailedTests !== failedCount || report.numPassedTests !== executedTests.length - failedCount || report.numPendingTests !== skippedTests.length) throw new Error("Vitest totals contradict assertions");
  if (report.success !== !failed) throw new Error("Vitest success contradicts assertions");
 } else if (runner === "cargo") {
  let suites = 0, ended = 0, declared = 0, suiteExecuted = 0, suiteSkipped = 0, suiteFailed = 0;
  for (const line of raw.trim().split(/\r?\n/)) {
   const event = obj(JSON.parse(line));
   if (event.type === "suite" && event.event === "started") { if (!Number.isInteger(event.test_count)) throw new Error("Invalid Cargo suite count"); if (suites !== ended) throw new Error("Overlapping Cargo suites"); suites++; declared += Number(event.test_count); suiteExecuted = executedTests.length; suiteSkipped = skippedTests.length; suiteFailed = failedCount; }
   else if (event.type === "suite" && ["ok", "failed"].includes(String(event.event))) { if (suites !== ended + 1 || event.passed !== executedTests.length - suiteExecuted - (failedCount - suiteFailed) || event.failed !== failedCount - suiteFailed || event.ignored !== skippedTests.length - suiteSkipped || (event.event === "failed") !== (failedCount > suiteFailed)) throw new Error("Cargo suite totals contradict test results"); ended++; }
   else if (event.type === "test" && event.event !== "started") { if (suites !== ended + 1) throw new Error("Cargo test outside suite"); add(event.name, event.event); }
   else if (event.type !== "test") throw new Error("Unknown Cargo result event");
  }
  if (!suites || ended !== suites || declared !== executedTests.length + skippedTests.length) throw new Error("Incomplete Cargo test stream");
 } else {
  if (!/^TAP version 13\r?$/m.test(raw) || /^\s*Bail out!/m.test(raw)) throw new Error("Invalid/incomplete Node TAP");
  let points = 0, rootPoints = 0;
  const totals = { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  const headings = new Map<number, string>();
  const lines = raw.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
   const heading = /^(\s*)# Subtest: (.+)$/.exec(line);
   if (heading) { const indent = heading[1]!.length; for (const key of headings.keys()) if (key >= indent) headings.delete(key); headings.set(indent, heading[2]!); }
   const match = /^(\s*)(not ok|ok) \d+ - (.*?)(?:\s+# (SKIP|TODO)\b.*)?$/.exec(line);
   if (match) {
    const indent = match[1]!.length; if (!indent) rootPoints++;
    const diagnostic: string[] = [];
    for (let next = index + 1; next < lines.length && /^\s/.test(lines[next]!); next++) diagnostic.push(lines[next]!);
    const isSuite = diagnostic.some(text => new RegExp(`^ {${indent + 2}}type: ['"]suite['"]$`).test(text));
    if (isSuite) { totals.suites++; if (match[2] === "not ok" && !match[4]) failed = true; continue; }
    points++; const parents = [...headings].filter(([depth]) => depth < indent).sort(([a], [b]) => a - b).map(([, name]) => name);
    const cancelled = diagnostic.some(text => new RegExp(`^ {${indent + 2}}failureType: ['"](?:cancelledByParent|testTimeoutFailure)['"]$`).test(text));
    if (cancelled && match[2] !== "not ok") throw new Error("Node TAP cancellation contradicts result");
    const outcome = match[4] === "SKIP" ? "skipped" : match[4] === "TODO" ? "todo" : cancelled ? "cancelled" : match[2] === "ok" ? "pass" : "fail";
    totals[outcome]++;
    // Cancelled tests are not proof of execution; retain the public non-executed list.
    if (outcome === "cancelled") { skippedTests.push([...parents, match[3]].join(" > ")); failed = true; }
    else add([...parents, match[3]].join(" > "), outcome === "pass" ? "passed" : outcome === "fail" ? "failed" : outcome);
   }
  }
  totals.tests = points;
  const plans = [...raw.matchAll(/^1\.\.(\d+)\r?$/gm)];
  if (plans.length !== 1 || Number(plans[0]![1]) !== rootPoints) throw new Error("Incomplete or contradictory Node TAP plan");
  for (const [field, count] of Object.entries(totals)) {
   const summaries = [...raw.matchAll(new RegExp(`^# ${field} (\\d+)\\r?$`, "gm"))];
   if (summaries.length !== 1 || Number(summaries[0]![1]) !== count) throw new Error(`Incomplete or contradictory Node TAP ${field} total`);
  }
 }
 if (new Set(executedTests).size !== executedTests.length || new Set(skippedTests).size !== skippedTests.length || executedTests.some(t => skippedTests.includes(t))) throw new Error("Ambiguous duplicate test identity");
 return { executedTests, skippedTests, failed };
}
export type CheckExecutorOptions = {
 exec?: (file: string, args: string[], options: { cwd: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
 readText?: (path: string) => Promise<string>; realpath?: (path: string) => Promise<string>;
 stat?: (path: string) => Promise<{ mtimeMs: number; isFile(): boolean }>;
 mkdir?: (path: string) => Promise<void>; writeExclusive?: (path: string, bytes: string) => Promise<void>; now?: () => number;
};
function contained(root: string, path: string): boolean { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); }
export function createCheckExecutor(options: CheckExecutorOptions = {}): CheckExecutor {
 const read = options.readText ?? (path => readFile(path, "utf8")), canonical = options.realpath ?? realpath, metadata = options.stat ?? stat, now = options.now ?? Date.now;
 const makeDir = options.mkdir ?? (async path => { await mkdir(path, { recursive: true }); }), write = options.writeExclusive ?? (async (path, bytes) => { await writeFile(path, bytes, { flag: "wx" }); });
 const exec = options.exec ?? ((file, args, config) => new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolveResult => { execFile(file, args, { cwd: config.cwd, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => resolveResult({ exitCode: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout, stderr })); }));
 const used = new Set<string>();
 const executor: CheckExecutor = {
  async execute(check, context) {
   const evidence: CheckEvidence = { checkId: check.id, invocationId: context.invocationId, startedAt: context.startedAt, finishedAt: context.startedAt, exitCode: -1, executedTests: [], skippedTests: [], status: "unknown" };
   try {
    validateCheckSpec(check);
    if (!/^[a-zA-Z0-9_-]+$/.test(context.invocationId) || used.has(context.invocationId)) throw new Error("Fresh unique invocation identity required");
    used.add(context.invocationId);
    const root = await canonical(context.workspace.path);
    if (root !== context.workspace.path) throw new Error("Workspace must be canonical and caller-owned");
    const cwd = await canonical(resolve(root, check.cwd)); if (!contained(root, cwd)) throw new Error("Check cwd escapes owned workspace");
    if (check.argv.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Invalid check argv");
    let reportPath: string | undefined, argv = [...check.argv];
    if (check.runner !== "command") {
     const declared = resolve(cwd, check.expectedEvidence.reportPath!); if (!contained(root, declared)) throw new Error("Report escapes owned workspace");
     const parent = await canonical(dirname(declared)); if (!contained(root, parent)) throw new Error("Report parent symlink escapes workspace");
     const invocationDir = resolve(parent, `.execution-check-${context.invocationId}`);
     // A persisted exclusive marker prevents replay across executor recreation.
     await makeDir(invocationDir); if (await canonical(invocationDir) !== invocationDir) throw new Error("Invocation report directory is a symlink");
     await write(resolve(invocationDir, "invocation.json"), JSON.stringify({ checkId: check.id, invocationId: context.invocationId, startedAt: context.startedAt }));
     reportPath = resolve(invocationDir, "report");
     if (check.runner === "vitest") {
      let replaced = false;
      argv = argv.map((arg, index) => { if (["--outputFile", "--outputFile.json"].includes(argv[index - 1] ?? "") && resolve(cwd, arg) === declared) { replaced = true; return reportPath!; } const match = /^(--outputFile(?:\.json)?=)(.*)$/.exec(arg); if (match && resolve(cwd, match[2]!) === declared) { replaced = true; return `${match[1]}${reportPath}`; } return arg; });
      if (!replaced || !argv.some((arg, index) => arg === "--reporter=json" || arg === "--reporters=json" || (arg === "json" && ["--reporter", "--reporters"].includes(argv[index - 1] ?? "")))) throw new Error("Vitest requires explicit JSON reporter and outputFile argument");
     }
    }
    if (check.runner === "command") {
     const invocationDir = resolve(cwd, `.execution-check-${context.invocationId}`);
     await makeDir(invocationDir); if (await canonical(invocationDir) !== invocationDir) throw new Error("Invocation directory is a symlink");
     await write(resolve(invocationDir, "invocation.json"), JSON.stringify({ checkId: check.id, invocationId: context.invocationId, startedAt: context.startedAt }));
    }
    evidence.startedAt = Math.max(context.startedAt, now());
    const result = await exec(argv[0]!, argv.slice(1), { cwd }); evidence.exitCode = result.exitCode;
    if (check.runner !== "command") {
     if (check.runner !== "vitest") await write(reportPath!, result.stdout);
     const report = await metadata(reportPath!); if (!report.isFile() || report.mtimeMs < evidence.startedAt || await canonical(reportPath!) !== reportPath) throw new Error("Missing/stale/symlink report");
     const raw = await read(reportPath!); const decoded = decodeCheckReport(check.runner, raw);
     evidence.reportPath = reportPath; evidence.reportDigest = sourceDigest(raw); evidence.executedTests = unique(decoded.executedTests); evidence.skippedTests = unique(decoded.skippedTests);
     if (!evidence.executedTests.length || check.expectedEvidence.requiredTests.some(t => !evidence.executedTests.includes(t))) throw new Error("Zero/all-skipped or missing required selected tests");
     if ((result.exitCode === 0) === decoded.failed) throw new Error("Exit/report contradiction");
     evidence.status = decoded.failed ? "failed" : "passed";
    } else evidence.status = result.exitCode === 0 ? "passed" : "failed";
   } catch (error) { evidence.status = "unknown"; evidence.reason = String(error); }
   evidence.finishedAt = Math.max(evidence.startedAt, now()); return evidence;
  },
  validateEvidence(check, evidence, context) {
   const reasons: string[] = [];
   try { validateCheckSpec(check); validateCheckEvidence(evidence); } catch (error) { reasons.push(String(error)); }
   if (evidence.checkId !== check.id || evidence.invocationId !== context.invocationId || evidence.startedAt < context.notBefore) reasons.push("Wrong invocation/check identity or stale evidence");
   if (evidence.status !== "passed" || evidence.exitCode !== 0) reasons.push("Check did not pass");
   if (check.runner !== "command" && (!evidence.reportPath || !isAbsolute(evidence.reportPath) || !evidence.reportDigest || !/^[a-f0-9]{64}$/.test(evidence.reportDigest) || !evidence.reportPath.includes(`${sep}.execution-check-${context.invocationId}${sep}`) || !evidence.executedTests.length || check.expectedEvidence.requiredTests.some(t => !evidence.executedTests.includes(t)) || evidence.executedTests.some(t => evidence.skippedTests.includes(t)))) reasons.push("Missing report or required test execution");
   return { valid: reasons.length === 0, reasons };
  },
 };
 return executor;
}
