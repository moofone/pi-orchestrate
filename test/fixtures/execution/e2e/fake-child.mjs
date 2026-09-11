import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const startedAt = Date.now();
const eventsPath = config.eventsPath;
const runId = config.runId;
const artifactDir = config.artifactDir;
const log = event => appendFileSync(eventsPath, `${JSON.stringify({ runId, pid: process.pid, ...event })}\n`);
const writeJson = (path, value) => { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(value)); renameSync(tmp, path); };
mkdirSync(artifactDir, { recursive: true });
log({ event: "start", at: startedAt, cwd: process.cwd(), taskId: config.taskId, mode: config.mode, agent: config.agent });
if (config.readyDelayMs) await new Promise(resolve => setTimeout(resolve, config.readyDelayMs));
writeJson(join(artifactDir, "status.json"), { lifecycleArtifactVersion: 3, runId, sessionId: config.sessionId, mode: "single", state: "running", steps: [] });
writeJson(join(artifactDir, "startup-snapshot.json"), {
  cwd: process.cwd(),
  taskId: config.taskId,
  agent: config.agent,
  files: Object.fromEntries((config.snapshotPaths ?? []).map(path => [path, (() => { try { return readFileSync(join(process.cwd(), path), "utf8"); } catch { return null; } })()])),
});
// Supported readiness/status notification (the `subagent:child-status` runtime
// event shape), emitted only after the atomic running-artifact publication above,
// with exact run/session identity. The parent provider event bridge decodes it.
process.stdout.write(`${JSON.stringify({ version: 1, type: "child-status", runId, sessionId: config.sessionId, state: "running", at: Date.now() })}\n`);
log({ event: "ready", at: Date.now(), taskId: config.taskId, mode: config.mode });

const waitFor = async path => {
  while (true) {
    try { if (readFileSync(path, "utf8")) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

let output;
let exitCode = 0;
try {
  if (config.barrier) {
    mkdirSync(config.barrier, { recursive: true });
    writeFileSync(join(config.barrier, `ready-${config.taskId ?? config.mode}-${process.pid}`), JSON.stringify({ pid: process.pid, runId, at: Date.now() }));
    await waitFor(join(config.barrier, "release"));
  }
  if (config.mode === "interpret") {
    output = config.output;
  } else if (config.fail) {
    exitCode = 1;
  } else if (config.outputKind === "artifact") {
    const path = join(artifactDir, `${config.taskId}.md`);
    const bytes = `artifact:${config.taskId}:${process.pid}\n`;
    writeFileSync(path, bytes);
    output = { kind: "artifact", path, digest: createHash("sha256").update(bytes).digest("hex") };
  } else {
    const path = join("src", `${config.taskId}.txt`);
    mkdirSync(join(process.cwd(), "src"), { recursive: true });
    writeFileSync(join(process.cwd(), path), `worker:${config.taskId}:pid=${process.pid}\n`);
    const env = { ...process.env, GIT_AUTHOR_NAME: "E2E child", GIT_AUTHOR_EMAIL: "e2e-child@example.test", GIT_COMMITTER_NAME: "E2E child", GIT_COMMITTER_EMAIL: "e2e-child@example.test" };
    execFileSync("git", ["add", path], { cwd: process.cwd(), env, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", `e2e worker ${config.taskId}`], { cwd: process.cwd(), env, stdio: "ignore" });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), env, encoding: "utf8" }).trim();
    output = { kind: "commits", commit };
  }
} catch (error) {
  exitCode = 1;
  log({ event: "error", at: Date.now(), error: String(error) });
}

const endedAt = Date.now();
const status = {
  lifecycleArtifactVersion: 3,
  runId,
  sessionId: config.sessionId,
  mode: "single",
  state: exitCode === 0 ? "complete" : "failed",
  endedAt,
  steps: [{ status: exitCode === 0 ? "complete" : "failed", ...(output ? { structuredOutput: output } : {}) }],
  processTerminal: {
    version: 1,
    runId,
    runnerProcessInstanceId: `runner-${process.pid}`,
    state: "observed",
    observedAt: endedAt,
    instances: [{ kind: "runner", processInstanceId: `runner-${process.pid}`, closeObservedAt: endedAt, exitCode, signal: null }],
  },
};
if (config.malformed) writeFileSync(join(artifactDir, "status.json"), "{ malformed lifecycle evidence");
else writeJson(join(artifactDir, "status.json"), status);
if (output) writeFileSync(join(artifactDir, "result.json"), JSON.stringify(output));
log({ event: "end", at: endedAt, exitCode, output, mode: config.mode, taskId: config.taskId });
process.exitCode = exitCode;
