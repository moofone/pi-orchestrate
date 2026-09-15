import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskCheck } from "./task-check.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const scalar = (body: string, name: string) => body.match(new RegExp(`^- ${name}: (.+)$`, "m"))?.[1]?.trim() ?? "";

export function taskChecks(body: string): TaskCheck[] | undefined {
  if (!/^- Checks:/m.test(body)) return;
  const block = body.match(/^- Checks:\s*\n```json\s*\n([\s\S]*?)\n```/m)?.[1];
  try {
    const checks: TaskCheck[] = JSON.parse(block ?? "");
    if (!Array.isArray(checks) || !checks.length) throw new Error("expected a nonempty array");
    const ids = new Set<string>();
    for (const c of checks) {
      if (!c || !/^[\w-]+$/.test(c.id) || ids.has(c.id)) throw new Error("unique check ids required");
      ids.add(c.id);
      if (typeof c.cwd !== "string") throw new Error(`${c.id}: explicit cwd required`);
      safeRelative(c.cwd, true);
      if (!Array.isArray(c.argv) || !c.argv.length || c.argv.some(a => typeof a !== "string" || !a || a.includes("\0"))) throw new Error(`${c.id}: argv must contain nonempty strings`);
      if (!["vitest", "node", "cargo", "command"].includes(c.runner)) throw new Error(`${c.id}: unknown runner`);
      if (c.runner === "command") {
        if (!c.reason?.trim()) throw new Error(`${c.id}: non-test command needs a reason`);
      } else {
        if (!Number.isSafeInteger(c.minTests) || c.minTests! < 1) throw new Error(`${c.id}: minTests must be positive`);
        if (c.maxTests !== undefined && (!Number.isSafeInteger(c.maxTests) || c.maxTests < c.minTests!)) throw new Error(`${c.id}: invalid maxTests`);
        if (c.tests !== undefined && (!Array.isArray(c.tests) || c.tests.some(n => typeof n !== "string" || !n.trim()))) throw new Error(`${c.id}: invalid test names`);
        if (c.tests?.length && c.maxTests === undefined) throw new Error(`${c.id}: named selection needs maxTests to detect an unfiltered suite`);
        const args = c.argv[0] === "rtk" ? c.argv.slice(c.argv[1] === "proxy" ? 2 : 1) : c.argv;
        if (c.runner === "vitest" && (!args.includes("vitest") || !args.includes("run") || args.includes("--") || args.some(a => /^(--reporter|--outputFile)/.test(a)))) throw new Error(`${c.id}: use direct vitest run without -- or reporter flags`);
        if (c.runner === "node" && (!/^(node|.*\/node)$/.test(args[0]!) || !args.includes("--test") || args.some(a => a.startsWith("--test-reporter")))) throw new Error(`${c.id}: use node --test without reporter flags`);
        if (c.runner === "cargo" && (!args.includes("cargo") || !args.includes("test") || args.includes("--quiet") || args.includes("-q"))) throw new Error(`${c.id}: use cargo test with its normal test report`);
      }
    }
    return checks;
  } catch (error) { throw new Error(`Invalid Checks: ${String(error)}`); }
}

function safeRelative(path: string, dot = false): void {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..") || (!dot && path === ".") || path.includes("\0")) throw new Error(`expected repository-relative path: ${path}`);
}

export function taskFiles(body: string): string[] {
  let files: unknown;
  try { files = JSON.parse(scalar(body, "Files")); } catch { throw new Error("Files must be a JSON array of repository-relative files"); }
  if (!Array.isArray(files) || !files.length || files.some(f => typeof f !== "string")) throw new Error("Files must be a nonempty list");
  for (const file of files) safeRelative(file);
  return [...new Set(files as string[])].sort();
}

export function taskDependencies(body: string): string[] {
  const value = scalar(body, "Depends on");
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some(id => !/^\d+$/.test(String(id)))) throw new Error("Depends on must be a JSON array of task ids");
  return parsed.map(String);
}

export function structuredAcceptance(body: string, cwd: string): Record<string, unknown> | undefined {
  const checks = taskChecks(body);
  if (!checks) return;
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const runner = fileURLToPath(new URL("./task-check.ts", import.meta.url));
  return { level: "verified", verify: checks.map(c => {
    const check = { ...c, cwd: resolve(cwd, c.cwd) };
    const encoded = Buffer.from(JSON.stringify(check)).toString("base64url");
    return { id: c.id, cwd: check.cwd, command: `rtk proxy ${quote(process.execPath)} --experimental-strip-types ${quote(runner)} ${quote(encoded)}`, timeoutMs: 900_000 };
  }) };
}

export interface ReviewedTask { body: string; id: string; cwd: string; sourceCommit?: string }
interface TaskSnapshot { cwd: string; sourceCommit: string; recipe: string; files: Record<string, string> }
export interface PlanBaseline { version: 1; head: string; tasks: Record<string, TaskSnapshot> }

function recipe(body: string): string {
  return hash(body.replace(/^- (Status|Handoff):.*$/gm, "").trim());
}

function fileHash(cwd: string, path: string): string {
  const file = resolve(cwd, path);
  if (!existsSync(file)) return "missing";
  const resolved = realpathSync(file);
  const rel = relative(realpathSync(cwd), resolved);
  if (rel.startsWith("../") || isAbsolute(rel) || !statSync(resolved).isFile()) throw new Error(`Files entry must be an in-repository file: ${path}`);
  return hash(readFileSync(file));
}

export function capturePlanBaseline(head: string, tasks: ReviewedTask[]): PlanBaseline {
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Cannot record review without an exact Git commit");
  const entries: PlanBaseline["tasks"] = {};
  for (const task of tasks) {
    if (entries[task.id]) throw new Error(`Duplicate Task id: ${task.id}`);
    if (!taskChecks(task.body)) throw new Error(`Task ${task.id} needs structured Checks`);
    if (!/^- Kind: (implement|verify)$/m.test(task.body)) throw new Error(`Task ${task.id} needs Kind: implement or verify`);
    if (!scalar(task.body, "Starting state")) throw new Error(`Task ${task.id} needs Starting state`);
    if (scalar(task.body, "Kind") === "implement" && !scalar(task.body, "Red test")) throw new Error(`Task ${task.id} needs Red test`);
    if (taskDependencies(task.body).some(id => Number(id) >= Number(task.id))) throw new Error(`Task ${task.id} dependencies must precede it`);
    entries[task.id] = { cwd: resolve(task.cwd), sourceCommit: task.sourceCommit ?? head, recipe: recipe(task.body), files: Object.fromEntries(taskFiles(task.body).map(f => [f, fileHash(task.cwd, f)])) };
  }
  return { version: 1, head, tasks: entries };
}

export function baselineMismatch(baseline: PlanBaseline | undefined, task: ReviewedTask): string | undefined {
  const saved = baseline?.version === 1 ? baseline.tasks[task.id] : undefined;
  if (!saved) return "task has no recorded source review";
  if (saved.cwd !== resolve(task.cwd)) return "execution worktree differs from the reviewed worktree";
  if (saved.recipe !== recipe(task.body)) return "task instructions changed since review";
  try {
    for (const [file, digest] of Object.entries(saved.files)) if (fileHash(task.cwd, file) !== digest) return `reviewed input changed: ${file}`;
  } catch (error) { return String(error); }
}

export function readPlanBaseline(path: string): PlanBaseline | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as PlanBaseline;
    return value.version === 1 && value.tasks && typeof value.head === "string" ? value : undefined;
  } catch { return; }
}

export function writePlanBaseline(path: string, baseline: PlanBaseline): void {
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

/** Only declared dependencies can anticipate the preceding task's file changes. */
export function acceptCompletedDependency(baseline: PlanBaseline, completed: ReviewedTask, remaining: ReviewedTask[]): void {
  const files = new Set(taskFiles(completed.body));
  for (const task of remaining) {
    const saved = baseline.tasks[task.id];
    if (!saved || saved.cwd !== resolve(completed.cwd) || !taskDependencies(task.body).includes(completed.id) || saved.recipe !== recipe(task.body)) continue;
    for (const file of Object.keys(saved.files)) if (files.has(file)) saved.files[file] = fileHash(task.cwd, file);
  }
}
