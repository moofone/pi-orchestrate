import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface TaskCheck {
  id: string;
  cwd: string;
  argv: string[];
  runner: "vitest" | "node" | "cargo" | "command";
  tests?: string[];
  minTests?: number;
  maxTests?: number;
  reason?: string;
}

/** Reports, not a successful process exit alone, establish test execution. */
export function checkTestReport(check: TaskCheck, output: string, report?: string): string | undefined {
  if (check.runner === "command") return;
  let passed = 0;
  const names: string[] = [];
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  if (check.runner === "vitest") {
    let parsed: { numPassedTests?: number; numFailedTests?: number; testResults?: { assertionResults?: { status?: string; fullName?: string; title?: string }[] }[] };
    try { parsed = JSON.parse(report ?? ""); } catch { return "missing or invalid Vitest JSON report"; }
    if (parsed.numFailedTests !== 0) return "Vitest reported failed tests";
    for (const suite of parsed.testResults ?? []) {
      for (const test of suite.assertionResults ?? []) {
        if (test.status === "passed") {
          passed++;
          names.push(test.fullName ?? test.title ?? "");
        }
      }
    }
    if (parsed.numPassedTests !== passed) return "inconsistent Vitest test count";
  } else if (check.runner === "node") {
    const summaries = [...clean.matchAll(/^# pass (\d+)\s*$/gm)];
    passed = Number(summaries.at(-1)?.[1] ?? 0);
    if (!/^# fail 0\s*$/m.test(clean) || !/^# cancelled 0\s*$/m.test(clean)) return "missing or failed Node TAP summary";
    for (const match of clean.matchAll(/^\s*ok \d+ - (.+)$/gm)) {
      if (!/ # (?:SKIP|TODO)\b/i.test(match[1]!)) names.push(match[1]!);
    }
  } else {
    const summaries = [...clean.matchAll(/^test result: ok\. (\d+) passed; 0 failed;/gm)];
    passed = summaries.reduce((n, m) => n + Number(m[1]), 0);
    for (const match of clean.matchAll(/^test (.+) \.\.\. ok\s*$/gm)) names.push(match[1]!);
  }
  if (passed < (check.minTests ?? 1)) return `expected at least ${check.minTests ?? 1} passed tests, observed ${passed}`;
  if (check.maxTests !== undefined && passed > check.maxTests) return `expected at most ${check.maxTests} passed tests, observed ${passed}`;
  for (const name of check.tests ?? []) {
    if (!names.some(n => n === name || n.endsWith(` ${name}`) || n.endsWith(`::${name}`))) {
      return `required test did not pass: ${name}`;
    }
  }
}

/** Shell-free invocation. The host's timeout kills this process group. */
export async function runTaskCheck(check: TaskCheck): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "orchestrate-check-"));
  const report = join(dir, "vitest.json");
  const argv = [...check.argv];
  // RTK's normal test filters intentionally discard reporter data. Proxy preserves it.
  if (argv[0] === "rtk") argv.splice(0, argv[1] === "proxy" ? 2 : 1);
  if (check.runner === "vitest") argv.push("--reporter=json", `--outputFile=${report}`);
  if (check.runner === "node") argv.splice(1, 0, "--test-reporter=tap");
  let output = "";
  try {
    const code = await new Promise<number>((done) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: check.cwd, stdio: ["ignore", "pipe", "pipe"] });
      let overflow = false;
      const capture = (chunk: Buffer, stream: NodeJS.WriteStream) => {
        stream.write(chunk);
        if (output.length + chunk.length > 16 * 1024 * 1024) { overflow = true; child.kill("SIGTERM"); }
        else output += chunk.toString();
      };
      child.stdout.on("data", c => capture(c, process.stdout));
      child.stderr.on("data", c => capture(c, process.stderr));
      child.on("error", error => { process.stderr.write(`${error.message}\n`); done(1); });
      child.on("close", code => done(overflow ? 1 : code ?? 1));
    });
    if (code !== 0) return code;
    const error = checkTestReport(check, output, check.runner === "vitest" ? readFileSync(report, "utf8") : undefined);
    if (error) { process.stderr.write(`Check ${check.id}: ${error}\n`); return 1; }
    return 0;
  } catch (error) {
    process.stderr.write(`Check ${check.id}: ${String(error)}\n`);
    return 1;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const check = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString()) as TaskCheck;
  process.exitCode = await runTaskCheck(check);
}
