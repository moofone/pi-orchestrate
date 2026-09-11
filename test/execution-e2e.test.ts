import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createExecutionBridge, type ExecutionBridge } from "../src/lib/execution-bridge.ts";
import { createExecutionInterpreter } from "../src/lib/execution-interpreter.ts";
import { createControllerDeliveryAdapter } from "../src/lib/execution-delivery.ts";
import { digest, type DeliveryGroup, type ExecutionManifest, type RepoIdentity } from "../src/lib/execution-contract.ts";
import type { RuntimeEventBus } from "../src/lib/attempt-runtime.ts";

const childPath = realpathSync(new URL("./fixtures/execution/e2e/fake-child.mjs", import.meta.url).pathname);
const crashOwnerPath = realpathSync(new URL("./fixtures/execution/e2e/crash-owner.mjs", import.meta.url).pathname);
const fiveWorkersPath = realpathSync(new URL("./fixtures/execution/five-workers.md", import.meta.url).pathname);
const sessionId = "e2e-parent-session";

/** This bus is the supported FAKE EVENT-RPC provider boundary. It does not
 * replace any execution adapter: each spawn is a real Node child and every
 * terminal decision is decoded from that child's lifecycle artifact. */
class ChildProvider implements RuntimeEventBus {
  readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  readonly processes = new Map<string, ChildProcess>();
  readonly starts = new Map<string, number>();
  readonly ends = new Map<string, number>();
  readonly spawnParams: Record<string, unknown>[] = [];
  readonly counts = new Map<string, number>();
  private next = 1;
  readonly root: string;
  readonly sessionFile: string;
  readonly scenario: string;
  constructor(root: string, sessionFile: string, scenario: string) {
    this.root = root; this.sessionFile = sessionFile; this.scenario = scenario;
    mkdirSync(join(root, "runs"), { recursive: true });
  }
  on(name: string, listener: (data: unknown) => void): () => void {
    const set = this.listeners.get(name) ?? new Set<(data: unknown) => void>(); set.add(listener); this.listeners.set(name, set);
    return () => set.delete(listener);
  }
  emit(name: string, data: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(data);
    if (name === "subagents:rpc:v1:request") void this.rpc(data as Record<string, unknown>);
  }
  private reply(request: Record<string, unknown>, success: boolean, data: unknown, error?: Record<string, unknown>): void {
    this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, method: request.method, success, ...(success ? { data } : { error }) });
  }
  private taskId(task: string): string {
    return /TASK_ID:\s*([A-Za-z0-9._-]+)/.exec(task)?.[1] ?? `legacy-${this.next}`;
  }
  private shouldFail(taskId: string): boolean {
    if (this.scenario !== "gamma") return false;
    return taskId === "gamma" && (this.counts.get(taskId) ?? 0) === 1;
  }
  private barrierFor(taskId: string): string | undefined {
    const barrier = join(this.root, "barrier");
    if (this.scenario === "five" && /^a[1-5]$/.test(taskId)) return barrier;
    if (this.scenario === "dependency" && /^a[3-5]$/.test(taskId)) return barrier;
    if (this.scenario === "handoff" && /^a[1-5]$/.test(taskId)) return barrier;
    if (this.scenario === "recovery" && taskId === "recovery") return barrier;
    return undefined;
  }
  private async rpc(request: Record<string, unknown>): Promise<void> {
    const method = String(request.method ?? "");
    if (method === "ping") {
      this.reply(request, true, { version: 1, methods: ["spawn", "status", "stop"], capabilities: { asyncSpawn: true, stop: true }, session: { sessionId, sessionFile: this.sessionFile } });
      return;
    }
    if (method === "status") { this.reply(request, true, { state: "known" }); return; }
    if (method === "stop") {
      const params = (request.params ?? {}) as Record<string, unknown>; const runId = String(params.runId ?? ""); const child = this.processes.get(runId);
      if (child && child.exitCode === null) child.kill("SIGTERM");
      this.reply(request, true, { runId, asyncDir: join(this.root, "runs", runId), state: "stopping" });
      return;
    }
    if (method !== "spawn") { this.reply(request, false, undefined, { code: "unsupported_method", message: method }); return; }
    const params = (request.params ?? {}) as Record<string, unknown>;
    const runId = `child-run-${this.next++}`, artifactDir = join(this.root, "runs", runId), configPath = join(this.root, `${runId}.json`);
    const task = String(params.task ?? ""), interpretation = task.includes("<source-snapshot>");
    const taskId = interpretation ? "interpretation" : this.taskId(task);
    const attempt = (this.counts.get(taskId) ?? 0) + 1; this.counts.set(taskId, attempt);
    const output = interpretation ? this.interpret(task) : undefined;
    const config = { mode: interpretation ? "interpret" : "worker", runId, sessionId, sessionFile: this.sessionFile, artifactDir, eventsPath: join(this.root, "children.jsonl"), taskId, barrier: this.barrierFor(taskId), fail: !interpretation && this.shouldFail(taskId), malformed: !interpretation && this.scenario === "malformed", output, outputKind: undefined };
    mkdirSync(artifactDir, { recursive: true }); writeFileSync(configPath, JSON.stringify(config));
    this.spawnParams.push(structuredClone(params));
    const child = spawn(process.execPath, [childPath, configPath], { cwd: String(params.cwd), env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "ignore", "pipe"] });
    this.processes.set(runId, child); this.starts.set(runId, Date.now());
    child.stderr?.on("data", value => writeFileSync(join(artifactDir, "stderr.log"), String(value), { flag: "a" }));
    child.on("close", (code, signal) => {
      this.ends.set(runId, Date.now());
      this.processes.delete(runId);
      const resultPath = join(artifactDir, "result.json");
      let outputValue: unknown; try { outputValue = JSON.parse(readFileSync(resultPath, "utf8")); } catch { /* unknown/lost child */ }
      this.emit("subagent:process-terminal", { runId, sessionId });
      this.emit("subagent:async-complete", { runId, sessionId, mode: "single", success: code === 0 && !signal, results: [{ ...(outputValue === undefined ? {} : { structuredOutput: outputValue }) }], summary: `child ${taskId}`, ...(signal ? { interrupted: true } : {}) });
    });
    this.reply(request, true, { details: { mode: "single", runId, asyncDir: artifactDir } });
  }
  private interpret(task: string): unknown {
    const match = /Required identity: (\{.*\})/.exec(task); if (!match) throw new Error("interpreter identity missing");
    const identity = JSON.parse(match[1]!); const sourceBytes = String(identity.source?.bytes ?? ""); const scenario = sourceBytes.includes("Degraded") ? "degraded" : this.scenario; return { manifest: manifestFor(identity, scenario), unresolvedDecisions: [] };
  }
  events(): Array<Record<string, unknown>> {
    if (!existsSync(join(this.root, "children.jsonl"))) return [];
    return readFileSync(join(this.root, "children.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  }
  async dispose(): Promise<void> {
    for (const child of this.processes.values()) if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function inferred(fields: string[]) { return fields.map(field => ({ field, origin: "inferred" as const, reason: "deterministic e2e fixture" })); }
function explicit(source: { path: string }, field: string) { return { field, origin: "explicit" as const, reason: "fixture says explicit" , anchor: { path: source.path, startLine: 1, endLine: 1 } }; }
function check(id: string, failing = false) {
  return { id, cwd: ".", argv: ["node", "--test", `test/${failing ? "fail" : "check"}.mjs`], runner: "command" as const, expectedEvidence: { requiredTests: [], rationale: "real node check command exit status" } };
}
function task(id: string, featureId: string, groupId: string, _source: { path: string }, dependencies: string[] = [], checks: ReturnType<typeof check>[] = []) {
  return { id, featureId, deliveryGroupId: groupId, text: `TASK_ID: ${id}\nRun the controlled child for ${id}.`, mode: "mutation" as const, dependencies, scope: ["src/"], profile: { agent: "child-worker" }, checks, provenance: inferred(["text", "mode", "dependencies", "scope", "profile", "deliveryGroupId"]) };
}
function manifestFor(identity: { id: string; revision: number; repo: RepoIdentity; baseCommit: string; source: { path: string; bytes: string; digest: string } }, scenario: string): ExecutionManifest {
  const source = identity.source, featureA = { id: "feature-a", title: "Feature A", scope: "src/" }, featureB = { id: "feature-b", title: "Feature B", scope: "src/" };
  let tasks = ["a1", "a2", "a3", "a4", "a5"].map(id => task(id, featureA.id, "delivery-a", source));
  let bTask = task("b1", featureB.id, "delivery-b", source);
  let groups: DeliveryGroup[] = [
    { id: "delivery-a", featureIds: [featureA.id], requiredTaskIds: tasks.map(item => item.id), checks: [], policy: "local", completion: "validated", ownerId: featureA.id },
    { id: "delivery-b", featureIds: [featureB.id], requiredTaskIds: [bTask.id], checks: [], policy: "local", completion: "validated", ownerId: featureB.id },
  ];
  let features = [featureA, featureB];
  if (scenario === "dependency") {
    const follow = task("followup", featureA.id, "delivery-a", source, ["a1", "a2"]); tasks = [...tasks, follow]; groups[0]!.requiredTaskIds = tasks.map(item => item.id); bTask = task("b1", featureB.id, "delivery-b", source); 
  } else if (scenario === "gamma") {
    tasks = [task("gamma", featureA.id, "delivery-a", source), task("gamma-dependent", featureA.id, "delivery-a", source, ["gamma"]), task("sibling", featureA.id, "delivery-a", source), task("b1", featureB.id, "delivery-b", source)]; groups[0]!.requiredTaskIds = ["gamma", "gamma-dependent", "sibling"]; groups[1]!.requiredTaskIds = ["b1"]; bTask = tasks[3]!;
  } else if (scenario === "conflict") {
    groups[0]!.checks = [check("combined-a", true)]; groups[1]!.checks = [check("combined-b")];
  } else if (scenario === "handoff") {
    groups[1] = { ...groups[1]!, policy: "pr", completion: "merged" }; tasks = [...tasks, bTask];
  } else if (scenario === "degraded") {
    tasks = [task("a1", featureA.id, "delivery-a", source), task("b1", featureB.id, "delivery-b", source)]; groups[0]!.requiredTaskIds = ["a1"]; bTask = tasks[1]!;
  } else if (scenario === "sparse") {
    tasks = [task("alpha", featureA.id, "delivery-a", source), task("beta", featureA.id, "delivery-a", source, source.bytes.includes("dependency") ? ["alpha"] : [])]; groups[0]!.requiredTaskIds = tasks.map(item => item.id); bTask = task("b1", featureB.id, "delivery-b", source); features = [featureA]; groups = [groups[0]!];
    if (source.bytes.includes("new-feature")) { const featureC = { id: "feature-c", title: "New Feature", scope: "src/" }; const c = task("new", featureC.id, "delivery-c", source); features.push(featureC); tasks.push(c); groups.push({ id: "delivery-c", featureIds: [featureC.id], requiredTaskIds: [c.id], checks: [], policy: "local", completion: "validated", ownerId: featureC.id }); }
  } else if (scenario === "recovery") {
    tasks = [task("recovery", featureA.id, "delivery-a", source)]; groups[0]!.requiredTaskIds = ["recovery"]; bTask = task("b1", featureB.id, "delivery-b", source); groups = [groups[0]!]; features = [featureA];
  }
  const allTasks = groups.some(group => group.id === "delivery-b") ? (tasks.some(item => item.id === "b1") ? tasks : [...tasks, bTask]) : tasks;
  const parallel = scenario === "five" || scenario === "handoff" ? [{ id: "a-five", taskIds: allTasks.filter(item => /^a[1-5]$/.test(item.id)).map(item => item.id), simultaneous: 5, provenance: explicit(source, "parallel") }] : [];
  return { schemaVersion: 1, id: identity.id, revision: identity.revision, source, repo: identity.repo, baseCommit: identity.baseCommit, scope: "src/", preset: "plan-driven", features, deliveryGroups: groups, tasks: allTasks, constraints: { capacity: scenario === "capacity" ? 5 : scenario === "degraded" ? 2 : 6, parallelGroups: parallel, provenance: inferred(["capacity"]) }, provenance: inferred(["scope", "features", "deliveryGroups"]) };
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, env: { ...process.env, GIT_AUTHOR_NAME: "E2E", GIT_AUTHOR_EMAIL: "e2e@example.test", GIT_COMMITTER_NAME: "E2E", GIT_COMMITTER_EMAIL: "e2e@example.test" } });
}
function makeRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "execution-e2e-"))), repoPath = join(root, "repo"), remote = join(root, "remote.git");
  mkdirSync(repoPath); mkdirSync(remote); git(remote, ["init", "--bare"]); git(repoPath, ["init", "--initial-branch=main"]);
  mkdirSync(join(repoPath, "src")); mkdirSync(join(repoPath, "test"));
  writeFileSync(join(repoPath, "test/check.mjs"), 'import { test } from "node:test"; test("check fixture passes", () => {});\n');
  writeFileSync(join(repoPath, "test/fail.mjs"), 'import { test } from "node:test"; test("combined gate fails", () => { throw new Error("intentional combined gate"); });\n');
  writeFileSync(join(repoPath, "README.md"), "e2e\n"); writeFileSync(join(repoPath, ".gitignore"), ".execution-check-*/\ntest/.execution-check-*/\n"); git(repoPath, ["add", "."]); git(repoPath, ["commit", "-m", "fixture base"]);
  git(repoPath, ["remote", "add", "origin", remote]); git(repoPath, ["push", "-u", "origin", "main"]); const base = git(repoPath, ["rev-parse", "HEAD"]).trim();
  return { root, repoPath: realpathSync(repoPath), remote, base, repo: { commonDir: realpathSync(join(repoPath, ".git")), id: digest(realpathSync(join(repoPath, ".git"))) } as RepoIdentity };
}

function makeHarness(scenario: string, capacity = 6) {
  const repo = makeRepo(), sessionFile = join(repo.root, "session.jsonl"), stateRoot = join(repo.root, "state"), ownedRoot = join(repo.root, "owned"), providerRoot = join(repo.root, "provider");
  mkdirSync(ownedRoot); writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId }) + "\n");
  const provider = new ChildProvider(providerRoot, sessionFile, scenario);
  const pi = {
    events: provider,
    async exec(file: string, args: string[], options: { cwd: string; timeout?: number }) {
      let actual = [...args], cwd = options.cwd;
      if (file === "git" && args[0] === "wt") actual = ["worktree", "add", "-b", args[1]!, join(ownedRoot, args[1]!), args[3]!];
      return await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => execFile(file, actual, { cwd, encoding: "utf8", timeout: options.timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NODE_TEST_CONTEXT: undefined, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) })));
    },
  };
  const bridge = createExecutionBridge({ pi, events: provider, repo: repo.repo, referencePath: repo.repoPath, stateRoot, sessionFile, processStart: `e2e:${process.pid}:${scenario}`, capacity, ownedRoot, interpretationTransport: createExecutionInterpreter({ events: provider, cwd: repo.repoPath, sessionFile }) });
  const planPath = join(repo.root, `${scenario}.md`); writeFileSync(planPath, scenario === "five" ? readFileSync(fiveWorkersPath, "utf8") : `# Sparse ${scenario}\n\nThis is the ${scenario} fixture.\n`);
  return { ...repo, sessionFile, stateRoot, ownedRoot, provider, pi, bridge, planPath };
}

type Harness = ReturnType<typeof makeHarness>;
async function approved(h: Harness, capacity = 6, publication = false): Promise<ExecutionManifest> {
  const first = await h.bridge.run(h.planPath); assert.equal(first.kind, "approval-required", JSON.stringify(first)); if (first.kind !== "approval-required") throw new Error("approval fixture");
  const second = await h.bridge.run(h.planPath, { token: first.preview.token, capacity, publication, ...(first.preview.boundary.publicationRepository ? { publicationRepository: first.preview.boundary.publicationRepository } : {}), approvedBy: h.sessionFile, approvedAt: Date.now() });
  assert.equal(second.kind, "started", JSON.stringify(second)); if (second.kind !== "started") throw new Error("start fixture"); return second.manifest;
}
async function eventually<T>(read: () => T, predicate: (value: T) => boolean, label: string, ms = 12_000): Promise<T> {
  const deadline = Date.now() + ms; let value = read();
  while (!predicate(value) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 15)); value = read(); }
  assert.ok(predicate(value), `${label}: ${JSON.stringify(value)}`); return value;
}
function taskId(manifest: ExecutionManifest, logical: string): string { return manifest.tasks.find(task => task.text.includes(`TASK_ID: ${logical}`))!.id; }
function release(h: Harness) { mkdirSync(join(h.provider.root, "barrier"), { recursive: true }); writeFileSync(join(h.provider.root, "barrier", "release"), "release\n"); }
async function close(h: Harness) { await h.bridge.shutdown(); await h.provider.dispose(); }

// Registration coverage intentionally runs the real public command. The package
// sidecar authorizes one slot, so the command must visibly refuse this explicit
// five-worker shape instead of silently serializing it. Capacity-six composition
// is exercised below through the same production bridge with an explicit test
// authorization boundary.
test("U8 registered /orchestrate command refuses explicit five-worker mismatch", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "execution-e2e-home-"))); process.env.HOME = home;
  const { default: register } = await import("../src/orchestrate.ts");
  const h = makeHarness("five"); const notifications: string[] = [], commands = new Map<string, any>(), handlers = new Map<string, any>();
  const commandPi = { ...h.pi, registerCommand(name: string, command: unknown) { commands.set(name, command); }, registerEntryRenderer() {}, registerMarkdownTransformer() {}, sendMessage() {}, on(name: string, fn: unknown) { handlers.set(name, fn); } };
  register(commandPi as any);
  try {
    await commands.get("orchestrate").handler(`run "${h.planPath}"`, { cwd: h.repoPath, hasUI: true, sessionManager: { getSessionFile: () => h.sessionFile, getSessionId: () => sessionId }, ui: { notify: (text: string) => notifications.push(text), confirm: async () => true } });
    assert.match(notifications.join("\n"), /capacity|simultaneous|conflict/i); assert.equal(h.provider.spawnParams.filter(params => String(params.task).includes("TASK_ID:")).length, 0);
  } finally { await handlers.get("session_shutdown")?.({}, {}); await h.provider.dispose(); }
});

test("U8 AE1 five real workers overlap and Feature B progresses concurrently", async () => {
  const h = makeHarness("five");
  try {
    const manifest = await approved(h); await eventually(() => h.provider.events(), events => events.filter(e => e.event === "start" && e.mode === "worker" && /^a[1-5]$/.test(String(e.taskId))).length === 5, "all A child starts");
    const starts = h.provider.events().filter(e => e.event === "start" && e.mode === "worker"); const aStarts = starts.filter(e => /^a[1-5]$/.test(String(e.taskId))); assert.equal(new Set(aStarts.map(e => e.pid)).size, 5);
    const bStart = starts.find(e => e.taskId === "b1"); assert.ok(bStart, "B must start while A group is gated");
    const aReady = h.provider.events().filter(e => e.event === "start" && /^a[1-5]$/.test(String(e.taskId))); assert.equal(aReady.length, 5);
    assert.ok(aReady.every(event => typeof event.pid === "number")); assert.equal(new Set(h.bridge.store.read().reservations.map(r => r.workspacePath)).size, 6);
    assert.equal(new Set(h.bridge.store.read().attempts.map(a => a.workspace.path)).size, 6); assert.equal(new Set(h.bridge.store.read().attempts.map(a => a.ownerSessionFile)).size, 1);
    const bDone = await eventually(() => h.bridge.store.read(), state => state.tasks.some(t => t.taskId === taskId(manifest, "b1") && t.phase === "succeeded"), "B completion");
    const bAttempt = bDone.attempts.find(a => a.taskId === taskId(manifest, "b1"))!; assert.equal(bAttempt.phase, "succeeded"); release(h);
    await eventually(() => h.bridge.store.read(), state => state.attempts.every(a => a.phase === "succeeded"), "all five A completions");
    const ends = h.provider.events().filter(e => e.event === "end" && e.mode === "worker"); const intervals = aReady.map(start => ({ start: Number(start.at), end: Number(ends.find(end => end.runId === start.runId)?.at ?? 0) }));
    const overlap = Math.max(...intervals.map(item => item.start)) < Math.min(...intervals.map(item => item.end)); assert.ok(overlap, JSON.stringify(intervals));
    assert.match(h.bridge.store.read().results.map(r => r.output.kind).join(","), /commits/);
  } finally { release(h); await close(h); }
});

test("U8 AE2 dependent launches from only alpha/beta while three siblings remain active", async () => {
  const h = makeHarness("dependency");
  try {
    const manifest = await approved(h); await eventually(() => h.provider.events(), events => events.filter(e => e.event === "start" && e.mode === "worker" && /^a[1-5]$/.test(String(e.taskId))).length === 5, "dependency siblings started");
    await eventually(() => h.bridge.store.read(), state => state.results.filter(r => [taskId(manifest, "a1"), taskId(manifest, "a2")].includes(r.taskId)).length === 2, "alpha beta receipts");
    await eventually(() => h.provider.events(), events => events.some(e => e.event === "start" && e.taskId === "followup"), "follow-up launch");
    const follow = h.bridge.store.read().attempts.find(a => a.taskId === taskId(manifest, "followup"))!; const expected = new Set([taskId(manifest, "a1"), taskId(manifest, "a2")].map(id => h.bridge.store.read().results.find(r => r.taskId === id)!.digest));
    assert.deepEqual(new Set(follow.prerequisiteDigests), expected); assert.ok(h.bridge.store.read().attempts.filter(a => ["preparing", "launching", "running"].includes(a.phase)).length >= 3); release(h);
    await eventually(() => h.bridge.store.read(), state => state.attempts.every(a => a.phase === "succeeded"), "dependency scenario completion");
  } finally { release(h); await close(h); }
});

test("U8 AE3 gamma failure explains its dependent block and targeted retry preserves siblings", async () => {
  const h = makeHarness("gamma");
  try {
    const manifest = await approved(h); const gamma = taskId(manifest, "gamma"), dependent = taskId(manifest, "gamma-dependent");
    await eventually(() => h.bridge.store.read(), state => state.attempts.some(a => a.taskId === gamma && a.phase === "failed") && state.tasks.some(t => t.taskId === dependent && t.phase === "dependency-blocked"), "gamma blocked dependent");
    const beforeSibling = h.provider.events().filter(e => e.event === "start" && e.taskId === "sibling").length; assert.equal(beforeSibling, 1); assert.match(h.bridge.store.read().tasks.find(t => t.taskId === dependent)!.reason ?? "dependency-blocked", /dependency|failed|unavailable/i);
    await h.bridge.control({ targetId: gamma, action: "retry" }); await eventually(() => h.bridge.store.read(), state => state.attempts.filter(a => a.taskId === gamma && a.phase === "succeeded").length === 1 && state.tasks.find(t => t.taskId === dependent)?.phase === "succeeded", "gamma retry");
    assert.equal(h.provider.events().filter(e => e.event === "start" && e.taskId === "gamma").length, 2); assert.equal(h.provider.events().filter(e => e.event === "start" && e.taskId === "sibling").length, beforeSibling);
  } finally { await close(h); }
});

test("U8 AE4 explicit five is refused at capacity two; degraded revision requires approval", async () => {
  const h = makeHarness("capacity", 2);
  try {
    const refused = await h.bridge.run(h.planPath); assert.equal(refused.kind, "refused"); assert.match(refused.reason, /capacity|simultaneous/i); assert.equal(h.provider.spawnParams.length, 1, "only interpretation child may run");
    writeFileSync(h.planPath, "# Degraded\n\nDegraded plan with two workers.\n"); const preview = await h.bridge.run(h.planPath); assert.equal(preview.kind, "approval-required"); if (preview.kind !== "approval-required") return; assert.equal(h.provider.spawnParams.filter(p => String(p.task).includes("TASK_ID:")).length, 0);
    const started = await h.bridge.run(h.planPath, { token: preview.preview.token, capacity: 2, publication: false, approvedBy: h.sessionFile, approvedAt: Date.now() }); assert.equal(started.kind, "started"); await eventually(() => h.bridge.store.read(), state => state.attempts.length === 2, "degraded approval scheduling");
  } finally { await close(h); }
});

test("U8 AE5 sparse Markdown is interpreted, while dependency/new-feature revision waits for approval", async () => {
  const h = makeHarness("sparse");
  try {
    const first = await h.bridge.run(h.planPath); assert.equal(first.kind, "approval-required", JSON.stringify(first)); if (first.kind !== "approval-required") return; assert.equal(first.preview.manifest.tasks.length, 2); assert.equal(first.preview.manifest.tasks[1]!.dependencies.length, 0);
    const started = await h.bridge.run(h.planPath, { token: first.preview.token, capacity: 6, publication: false, approvedBy: h.sessionFile, approvedAt: Date.now() }); assert.equal(started.kind, "started", JSON.stringify(started)); await eventually(() => h.bridge.store.read(), state => state.tasks.filter(t => t.phase === "succeeded").length === 2, "sparse initial schedule");
    writeFileSync(h.planPath, "# Sparse revision\n\nnew-feature dependency\n"); const revised = await h.bridge.run(h.planPath); assert.equal(revised.kind, "approval-required", JSON.stringify(revised)); if (revised.kind !== "approval-required") return; assert.equal(revised.preview.manifest.revision, 2); assert.ok(revised.preview.manifest.features.some(f => f.id === "feature-c")); assert.equal(h.provider.spawnParams.filter(p => String(p.task).includes("TASK_ID: new")).length, 0);
    const approvedRevision = await h.bridge.run(h.planPath, { token: revised.preview.token, capacity: 6, publication: false, approvedBy: h.sessionFile, approvedAt: Date.now() }); assert.equal(approvedRevision.kind, "started", JSON.stringify(approvedRevision));
  } finally { await close(h); }
});

test("U8 AE6 same-PID reload and true exited-owner startup reconcile one real run", async () => {
  const h = makeHarness("recovery"); let replacement: ExecutionBridge | undefined; let crash: ChildProcess | undefined;
  try {
    const manifest = await approved(h); await eventually(() => h.provider.events(), events => events.some(e => e.event === "start" && e.taskId === "recovery"), "recovery child launch"); const recoveryStart = h.provider.events().find(e => e.event === "start" && e.taskId === "recovery")!; const recoveryStatusPath = join(h.provider.root, "runs", String(recoveryStart.runId), "status.json"); const recoveryStatus = JSON.parse(readFileSync(recoveryStatusPath, "utf8")); assert.equal(recoveryStatus.state, "running"); assert.equal(existsSync(`${recoveryStatusPath}.${recoveryStart.pid}.tmp`), false); await eventually(() => h.bridge.store.read(), state => state.attempts.some(a => a.taskId === taskId(manifest, "recovery") && ["running", "launching"].includes(a.phase)), "persisted running run");
    await h.bridge.shutdown();
    crash = spawn(process.execPath, ["--experimental-strip-types", crashOwnerPath, join(h.stateRoot, "plan-driven-v1"), h.repo.commonDir, h.sessionFile], { stdio: ["ignore", "pipe", "pipe"] }); await new Promise<void>((resolve, reject) => { crash!.stdout?.once("data", () => resolve()); crash!.once("error", reject); }); const crashedPid = crash.pid!; crash.kill("SIGKILL"); await new Promise(resolve => crash!.once("close", resolve)); assert.ok(crashedPid > 0);
    replacement = createExecutionBridge({ ...((h as any).bridge ? {} : {}), pi: h.pi, events: h.provider, repo: h.repo, referencePath: h.repoPath, stateRoot: h.stateRoot, sessionFile: h.sessionFile, processStart: `e2e-reload:${process.pid}`, capacity: 6, ownedRoot: h.ownedRoot, interpretationTransport: createExecutionInterpreter({ events: h.provider, cwd: h.repoPath, sessionFile: h.sessionFile }) });
    await replacement.start({ resumePriorOwner: true }); const active = replacement.store.read(); assert.equal(active.reservations.length, 1); assert.equal(h.provider.spawnParams.filter(p => String(p.task).includes("TASK_ID: recovery")).length, 1, "the crash-owner must not replay a launch");
    release(h); await eventually(() => replacement!.store.read(), state => state.attempts.some(a => a.taskId === taskId(manifest, "recovery") && a.phase === "succeeded"), "reconciled recovery terminal");
  } finally { release(h); if (replacement) await replacement.shutdown(); else await h.bridge.shutdown(); if (crash && crash.exitCode === null) crash.kill("SIGKILL"); await h.provider.dispose(); }
});

test("U8 malformed lifecycle evidence never yields a successful receipt", async () => {
  const h = makeHarness("malformed");
  try {
    await approved(h); await eventually(() => h.bridge.store.read(), state => state.attempts.length === 6 && state.attempts.every(a => a.phase === "recovery-needed" && /Malformed runtime status artifact/.test(a.reason ?? "")), "malformed lifecycle rejection"); assert.equal(h.bridge.store.read().results.length, 0);
  } finally { await close(h); }
});

test("U8 AE7 failed combined gate blocks A while independent B reaches ready", async () => {
  const h = makeHarness("conflict");
  try {
    const manifest = await approved(h); await eventually(() => h.bridge.store.read(), state => state.tasks.every(t => t.phase === "succeeded"), "all worker receipts"); await eventually(() => h.bridge.store.read(), state => state.deliveries.some(d => d.groupId === "delivery-a" && d.phase === "blocked") && state.deliveries.some(d => d.groupId === "delivery-b" && d.phase === "ready"), "independent delivery gates");
    const state = h.bridge.store.read(); assert.match(state.deliveries.find(d => d.groupId === "delivery-a")!.reason ?? "", /combined gate|failed/i); assert.equal(state.deliveries.find(d => d.groupId === "delivery-b")!.phase, "ready"); assert.equal(state.manifests.find(m => m.id === manifest.id)!.deliveryGroups.length, 2);
  } finally { await close(h); }
});

test("U8 AE8 pause A leaves B active; controller handoff maps once and verified merge advances", async () => {
  const h = makeHarness("handoff"); let merged = false, handoffs = 0; let view: any;
  const controller = { handoff(request: any) { handoffs++; view = { pr: "github.com/acme/e2e#7", owner: request.owner, worktree: request.worktree, head: request.expectedHead, state: "waiting_review", pendingCount: 0 }; return { ok: true, state: "waiting_review" }; }, status(_pr?: any) { return view ? [view] : []; }, observeVerdict() { return { accepted: true }; }, async reconcile() { return { launched: 0 }; } };
  const delivery = createControllerDeliveryAdapter({ controller: controller as any, controllerId: "e2e-controller", acknowledged: request => ({ requestId: request.id, controllerId: "e2e-controller", obligationId: "e2e-obligation", generation: request.generation, acceptedAt: 1 }), verifyMerge: async request => merged ? { commit: request.head, url: `https://${request.pr.repo}/pull/${request.pr.number}`, observedAt: Date.now() } : undefined });
  const bridge = createExecutionBridge({ pi: h.pi, events: h.provider, repo: h.repo, referencePath: h.repoPath, stateRoot: h.stateRoot, sessionFile: h.sessionFile, processStart: "e2e-handoff", capacity: 6, ownedRoot: h.ownedRoot, repository: "github.com/acme/e2e", delivery, resolvePr: async () => ({ kind: "authorized", pr: { repo: "github.com/acme/e2e", number: 7 }, generation: "generation-e2e", ownerId: "feature-b", ownerKind: "execution" }), interpretationTransport: createExecutionInterpreter({ events: h.provider, cwd: h.repoPath, sessionFile: h.sessionFile }) });
  try {
    const first = await bridge.run(h.planPath); assert.equal(first.kind, "approval-required"); if (first.kind !== "approval-required") return; const started = await bridge.run(h.planPath, { token: first.preview.token, capacity: 6, publication: true, publicationRepository: "github.com/acme/e2e", approvedBy: h.sessionFile, approvedAt: Date.now() }); assert.equal(started.kind, "started");
    await eventually(() => bridge.store.read(), state => state.deliveries.some(d => d.groupId === "delivery-b" && d.phase === "controller-owned"), "controller handoff"); assert.equal(handoffs, 1); const before = digest(bridge.store.read().deliveries.find(d => d.groupId === "delivery-b"));
    await bridge.control({ targetId: "feature-a", action: "pause" }); assert.equal(bridge.store.read().tasks.filter(t => t.intent === "pause").length, 5); assert.equal(bridge.store.read().deliveries.find(d => d.groupId === "delivery-b")!.phase, "controller-owned");
    merged = true; view.state = "merged"; await bridge.delivery.observe("delivery-b"); assert.equal(bridge.store.read().deliveries.find(d => d.groupId === "delivery-b")!.phase, "merged"); assert.notEqual(digest(bridge.store.read().deliveries.find(d => d.groupId === "delivery-b")), before);
    h.provider.emit("subagent:async-complete", { runId: "late-run", sessionId, mode: "single", success: true }); await bridge.scheduler.reconcile(); assert.equal(bridge.store.read().deliveries.find(d => d.groupId === "delivery-b")!.phase, "merged");
  } finally { release(h); await bridge.shutdown(); await h.provider.dispose(); }
});

test("U8 AE9 selectable legacy preset preserves review/sequential TDD/QA delivery order", async () => {
  const h = makeHarness("legacy");
  try {
    const legacy = createExecutionBridge({ pi: h.pi, events: h.provider, repo: h.repo, referencePath: h.repoPath, stateRoot: h.stateRoot, sessionFile: h.sessionFile, processStart: "e2e-legacy", capacity: 1, ownedRoot: h.ownedRoot, preset: "legacy", interpretationTransport: async () => { throw new Error("legacy must not call plan interpreter"); } });
    const source = realpathSync(new URL("./fixtures/execution/import/legacy.md", import.meta.url).pathname), preview = await legacy.preview(source); assert.equal(preview.manifest.preset, "legacy"); assert.deepEqual(preview.manifest.tasks.map(t => t.profile.agent), ["plan-reviewer", "tdd-worker", "tdd-worker", "feature-qa"]); assert.deepEqual(preview.manifest.tasks.slice(1).map(t => t.dependencies.length), [1, 1, 1]); assert.equal(preview.manifest.constraints.capacity, 1); assert.equal(preview.manifest.deliveryGroups[0]!.completion, "merged"); await legacy.shutdown();
  } finally { await close(h); }
});

export { manifestFor, makeHarness };
