import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createExecutionBridge, type ExecutionBridge } from "../src/lib/execution-bridge.ts";
import { createExecutionInterpreter } from "../src/lib/execution-interpreter.ts";
import { createControllerDeliveryAdapter } from "../src/lib/execution-delivery.ts";
import { digest, type DeliveryGroup, type ExecutionManifest, type RepoIdentity } from "../src/lib/execution-contract.ts";
import type { RuntimeEventBus } from "../src/lib/attempt-runtime.ts";
import { PR_REVIEW_RECONCILED_EVENT } from "../src/lib/pr-review-events.ts";
import { resolveWorktreeHelper } from "./fixtures/execution/e2e/worktree-helper.ts";

const evidenceBase = process.env.U8_EVIDENCE_ROOT ? (mkdirSync(process.env.U8_EVIDENCE_ROOT, { recursive: true }), realpathSync(process.env.U8_EVIDENCE_ROOT)) : undefined;
let evidenceRun = 0;

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
    if (["five", "capacity", "handoff"].includes(this.scenario) && /^a[1-5]$/.test(taskId)) return barrier;
    if (this.scenario === "dependency" && /^a[3-5]$/.test(taskId)) return barrier;
    if (this.scenario === "sparse" && taskId === "alpha") return barrier;
    if (this.scenario === "late-ready" && ["a1", "b1"].includes(taskId)) return barrier;
    if (this.scenario === "pause" && taskId === "a1") return join(this.root, "barrier-a");
    if (this.scenario === "pause" && taskId === "b1") return join(this.root, "barrier-b");
    if (["recovery", "reload"].includes(this.scenario) && taskId === "recovery") return barrier;
    return undefined;
  }
  private async rpc(request: Record<string, unknown>): Promise<void> {
    const method = String(request.method ?? "");
    if (method === "ping") {
      const durable = this.scenario === "reload";
      this.reply(request, true, { version: 1, methods: ["spawn", "status", "stop", ...(durable ? ["lookup"] : [])], capabilities: { asyncSpawn: true, stop: true, ...(durable ? { durableSpawn: { version: 1, lookup: true } } : {}) }, session: { sessionId, sessionFile: this.sessionFile } });
      return;
    }
    if (method === "lookup" && this.scenario === "reload") {
      const pendingPath = join(this.root, "pending-old-reply.json");
      const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as { response: unknown };
      this.reply(request, true, { state: "known", reply: pending.response }); return;
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
    const config = {
      mode: interpretation ? "interpret" : "worker", runId, sessionId, sessionFile: this.sessionFile, artifactDir,
      eventsPath: join(this.root, "children.jsonl"), taskId, agent: params.agent,
      snapshotPaths: taskId === "followup" ? ["src/a1.txt", "src/a2.txt", "src/a3.txt", "src/a4.txt", "src/a5.txt", "src/b1.txt"] : [],
      readyDelayMs: this.scenario === "late-ready" ? 2_000 : undefined,
      barrier: this.barrierFor(taskId), fail: !interpretation && this.shouldFail(taskId), malformed: !interpretation && this.scenario === "malformed", output, outputKind: params.agent === "plan-reviewer" ? "artifact" : undefined,
    };
    mkdirSync(artifactDir, { recursive: true }); writeFileSync(configPath, JSON.stringify(config));
    this.spawnParams.push(structuredClone(params));
    const child = spawn(process.execPath, [childPath, configPath], { cwd: String(params.cwd), env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    this.processes.set(runId, child); this.starts.set(runId, Date.now());
    child.stderr?.on("data", value => writeFileSync(join(artifactDir, "stderr.log"), String(value), { flag: "a" }));
    // The child's one deterministic readiness/status line — emitted only after its
    // atomic running-artifact publication — becomes the supported
    // `subagent:child-status` runtime event. The line's run/session identity is
    // cross-checked against this spawn before it reaches the bus, so the
    // production runtime subscription (which wakes scheduler reconciliation) only
    // ever sees exact live-child evidence.
    child.stdout?.setEncoding("utf8");
    let statusLines = "";
    child.stdout?.on("data", chunk => {
      statusLines += chunk;
      for (;;) {
        const index = statusLines.indexOf("\n"); if (index < 0) break;
        const line = statusLines.slice(0, index); statusLines = statusLines.slice(index + 1);
        try {
          const note = JSON.parse(line) as Record<string, unknown>;
          if (note.type === "child-status" && note.runId === runId && note.sessionId === sessionId) this.emit("subagent:child-status", { runId, sessionId, mode: "single", state: String(note.state ?? "running") });
        } catch { /* Malformed child stdout is not a runtime event. */ }
      }
    });
    child.on("close", (code, signal) => {
      this.ends.set(runId, Date.now());
      this.processes.delete(runId);
      const resultPath = join(artifactDir, "result.json");
      let outputValue: unknown; try { outputValue = JSON.parse(readFileSync(resultPath, "utf8")); } catch { /* unknown/lost child */ }
      this.emit("subagent:process-terminal", { runId, sessionId });
      this.emit("subagent:async-complete", { runId, sessionId, mode: "single", success: code === 0 && !signal, results: [{ ...(outputValue === undefined ? {} : { structuredOutput: outputValue }) }], summary: `child ${taskId}`, ...(signal ? { interrupted: true } : {}) });
    });
    // Faithful committed spawn payload (pi-subagents 42257fc rpc.ts dataFromToolResult + async-execution.ts:1982).
    const response = { text: `Async: worker [${runId}]`, details: { mode: "single", runId, results: [], asyncId: runId, asyncDir: artifactDir } };
    if (this.scenario === "reload" && taskId === "recovery") {
      writeFileSync(join(this.root, "pending-old-reply.json"), JSON.stringify({ request, response }));
      return;
    }
    this.reply(request, true, response);
  }
  releasePendingOldReply(): void {
    const pendingPath = join(this.root, "pending-old-reply.json");
    const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as { request: Record<string, unknown>; response: unknown };
    this.reply(pending.request, true, pending.response);
    writeFileSync(join(this.root, "released-old-reply.json"), JSON.stringify({ requestId: pending.request.requestId, releasedAt: Date.now() }));
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
function task(id: string, featureId: string, groupId: string, source: { path: string }, dependencies: string[] = [], checks: ReturnType<typeof check>[] = [], explicitDependencies = false) {
  return { id, featureId, deliveryGroupId: groupId, text: `TASK_ID: ${id}\nRun the controlled child for ${id}.`, mode: "mutation" as const, dependencies, scope: ["src/"], profile: { agent: "child-worker" }, checks, provenance: [...inferred(["text", "mode", "scope", "profile", "deliveryGroupId"]), ...(explicitDependencies ? [explicit(source, "dependencies")] : inferred(["dependencies"]))] };
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
  } else if (["conflict", "controller-conflict"].includes(scenario)) {
    groups[0]!.checks = [check("combined-a", true)]; groups[1]!.checks = [check("combined-b")];
    if (scenario === "controller-conflict") groups[1] = { ...groups[1]!, policy: "pr", completion: "merged" };
  } else if (scenario === "handoff") {
    groups = [{ id: "shared-review", featureIds: [featureA.id, featureB.id], requiredTaskIds: [...tasks.map(item => item.id), bTask.id], checks: [], policy: "pr", completion: "merged", ownerId: "shared-owner" }]; tasks = [...tasks.map(item => ({ ...item, deliveryGroupId: "shared-review" })), { ...bTask, deliveryGroupId: "shared-review" }];
  } else if (scenario === "degraded") {
    tasks = [task("a1", featureA.id, "delivery-a", source), task("b1", featureB.id, "delivery-b", source)]; groups[0]!.requiredTaskIds = ["a1"]; bTask = tasks[1]!;
  } else if (scenario === "sparse") {
    const revised = source.bytes.includes("dependency"), discovered = source.bytes.includes("in-scope");
    tasks = [task("alpha", featureA.id, "delivery-a", source), task("beta", featureA.id, "delivery-a", source, revised ? ["alpha"] : [], [], true)]; groups[0]!.requiredTaskIds = tasks.map(item => item.id); bTask = task("b1", featureB.id, "delivery-b", source); features = [featureA]; groups = [groups[0]!];
    if (discovered) { const discoveredTask = task("discovered", featureA.id, "delivery-a", source); tasks.push(discoveredTask); groups[0]!.requiredTaskIds = tasks.map(item => item.id); }
    if (source.bytes.includes("new-feature")) { const featureC = { id: "feature-c", title: "New Feature", scope: "src/" }; const c = task("new", featureC.id, "delivery-c", source); features.push(featureC); tasks.push(c); groups.push({ id: "delivery-c", featureIds: [featureC.id], requiredTaskIds: [c.id], checks: [], policy: "local", completion: "validated", ownerId: featureC.id }); }
  } else if (scenario === "pause" || scenario === "late-ready") {
    tasks = [task("a1", featureA.id, "delivery-a", source), task("b1", featureB.id, "delivery-b", source)]; groups[0]!.requiredTaskIds = ["a1"]; groups[1]!.requiredTaskIds = ["b1"]; features = [featureA, featureB];
  } else if (["recovery", "reload"].includes(scenario)) {
    tasks = [task("recovery", featureA.id, "delivery-a", source)]; groups[0]!.requiredTaskIds = ["recovery"]; bTask = task("b1", featureB.id, "delivery-b", source); groups = [groups[0]!]; features = [featureA];
  }
  const allTasks = groups.some(group => group.id === "delivery-b") ? (tasks.some(item => item.id === "b1") ? tasks : [...tasks, bTask]) : tasks;
  const parallel = ["five", "handoff", "capacity"].includes(scenario) && !source.bytes.includes("capacity-revision") ? [{ id: "a-five", taskIds: allTasks.filter(item => /^a[1-5]$/.test(item.id)).map(item => item.id), simultaneous: 5, provenance: explicit(source, "parallel") }] : [];
  const constraintCapacity = scenario === "capacity" && !source.bytes.includes("capacity-revision") ? 5 : scenario === "degraded" || source.bytes.includes("capacity-revision") ? 2 : 6;
  return { schemaVersion: 1, id: identity.id, revision: identity.revision, source, repo: identity.repo, baseCommit: identity.baseCommit, scope: "src/", preset: "plan-driven", features, deliveryGroups: groups, tasks: allTasks, constraints: { capacity: constraintCapacity, parallelGroups: parallel, provenance: inferred(["capacity"]) }, provenance: inferred(["scope", "features", "deliveryGroups"]) };
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, env: { ...process.env, GIT_AUTHOR_NAME: "E2E", GIT_AUTHOR_EMAIL: "e2e@example.test", GIT_COMMITTER_NAME: "E2E", GIT_COMMITTER_EMAIL: "e2e@example.test" } });
}
function makeRepo() {
  const root = evidenceBase ? (() => { const stem = `run-${process.pid}-${evidenceRun++}`; let path = join(evidenceBase, stem); if (existsSync(path)) path = join(evidenceBase, `${stem}-${Date.now()}`); mkdirSync(path, { recursive: true }); return realpathSync(path); })() : realpathSync(mkdtempSync(join(tmpdir(), "execution-e2e-"))), repoPath = join(root, "repo"), remote = join(root, "remote.git");
  mkdirSync(repoPath); mkdirSync(remote); git(remote, ["init", "--bare"]); git(repoPath, ["init", "--initial-branch=main"]);
  mkdirSync(join(repoPath, "src")); mkdirSync(join(repoPath, "test"));
  writeFileSync(join(repoPath, "test/check.mjs"), 'import { test } from "node:test"; test("check fixture passes", () => {});\n');
  writeFileSync(join(repoPath, "test/fail.mjs"), 'import { test } from "node:test"; test("combined gate fails", () => { throw new Error("intentional combined gate"); });\n');
  writeFileSync(join(repoPath, "README.md"), "e2e\n"); writeFileSync(join(repoPath, ".gitignore"), ".execution-check-*/\ntest/.execution-check-*/\n"); git(repoPath, ["add", "."]); git(repoPath, ["commit", "-m", "fixture base"]);
  git(repoPath, ["remote", "add", "origin", remote]); git(repoPath, ["push", "-u", "origin", "main"]); // Model a cloned checkout: the explicit caller refresh happens at fixture setup,
  // because bridge preview/approval never fetch (round-2 P2). Remote-tracking refs must already exist locally.
  git(repoPath, ["fetch", "origin"]); git(repoPath, ["remote", "set-head", "origin", "--auto"]);
  const base = git(repoPath, ["rev-parse", "HEAD"]).trim();
  return { root, repoPath: realpathSync(repoPath), remote, base, repo: { commonDir: realpathSync(join(repoPath, ".git")), id: digest(realpathSync(join(repoPath, ".git"))) } as RepoIdentity };
}

// The configured `git wt` helper is resolved, not hardcoded: an explicit
// PI_GIT_WORKFLOW_WT_BIN override, then an executable ghl-wt on PATH. A
// missing helper fails the file with an actionable provisioning error
// instead of making the overlap/composition/crash coverage
// workstation-only (round-2 P1).
const worktreeHelperPath = resolveWorktreeHelper();
function makeHarness(scenario: string, capacity = 6) {
  const repo = makeRepo(), sessionFile = join(repo.root, "session.jsonl"), stateRoot = join(repo.root, "state"), ownedRoot = join(repo.root, "repo-wt"), providerRoot = join(repo.root, "provider");
  mkdirSync(ownedRoot); writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId }) + "\n");
  const provider = new ChildProvider(providerRoot, sessionFile, scenario), gitInvocations: string[][] = [];
  const pi = {
    events: provider,
    async exec(file: string, args: string[], options: { cwd: string; timeout?: number }) {
      gitInvocations.push(file === "git" ? [...args] : [file, ...args]);
      if (file === "git" && isGitMutation(args)) appendFileSync(join(provider.root, "git-mutations.jsonl"), `${JSON.stringify({ cwd: options.cwd, argv: args, at: Date.now() })}\n`);
      const helper = file === "git" && args[0] === "wt";
      const executable = helper ? worktreeHelperPath : file;
      const actual = helper ? args.slice(1) : [...args], cwd = options.cwd;
      return await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => execFile(executable, actual, { cwd, encoding: "utf8", timeout: options.timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NODE_TEST_CONTEXT: undefined, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) })));
    },
  };
  const bridge = createExecutionBridge({ pi, events: provider, repo: repo.repo, referencePath: repo.repoPath, stateRoot, sessionFile, processStart: `e2e:${process.pid}:${scenario}`, capacity, ownedRoot, interpretationTransport: createExecutionInterpreter({ events: provider, sessionFile }) });
  const planPath = join(repo.root, `${scenario}.md`); writeFileSync(planPath, scenario === "five" ? readFileSync(fiveWorkersPath, "utf8") : `# Sparse ${scenario}\n\nThis is the ${scenario} fixture.\n`);
  return { ...repo, sessionFile, stateRoot, ownedRoot, provider, pi, bridge, planPath, gitInvocations };
}

type Harness = ReturnType<typeof makeHarness>;
function stateCounts(state: ReturnType<Harness["bridge"]["store"]["read"]>) {
  return {
    attempts: state.attempts.length, attemptPhases: Object.fromEntries([...new Set(state.attempts.map(a => a.phase))].sort().map(phase => [phase, state.attempts.filter(a => a.phase === phase).length])),
    reservations: state.reservations.length, results: state.results.length, integrations: state.integrations.length, integrationReceipts: state.integrationReceipts.length,
    deliveries: state.deliveries.length, deliveryPhases: Object.fromEntries([...new Set(state.deliveries.map(d => d.phase))].sort().map(phase => [phase, state.deliveries.filter(d => d.phase === phase).length])),
  };
}
function writeCrashSnapshot(h: Harness, name: string, phase: "before" | "after", state: ReturnType<Harness["bridge"]["store"]["read"]>): void {
  writeFileSync(join(h.provider.root, `snapshot-${name}-${phase}.json`), JSON.stringify({ name, phase, at: Date.now(), counts: stateCounts(state), state }, null, 2));
}
function retainHarnessEvidence(h: Harness): void {
  const state = h.bridge.store.read(), events = h.provider.events(), starts = events.filter(e => e.event === "start" && e.mode === "worker"), ends = events.filter(e => e.event === "end" && e.mode === "worker");
  const evidence = {
    scenario: h.provider.scenario, root: h.root, providerRoot: h.provider.root, stateRoot: h.stateRoot, ownedRoot: h.ownedRoot,
    workspacePaths: [...new Set(state.attempts.map(a => a.workspace.path))], workerPids: starts.map(e => e.pid),
    overlapIntervals: starts.map(start => ({ runId: start.runId, taskId: start.taskId, pid: start.pid, start: start.at, end: ends.find(end => end.runId === start.runId)?.at ?? null })),
    combinedChecks: state.integrationReceipts.flatMap(receipt => receipt.checks.map(check => ({ intentId: receipt.intentId, checkId: check.checkId, invocationId: check.invocationId, status: check.status, startedAt: check.startedAt, finishedAt: check.finishedAt }))),
    stateCounts: stateCounts(state), crashSnapshots: readdirSync(h.provider.root).filter(name => name.startsWith("snapshot-")).sort().map(name => join(h.provider.root, name)),
    artifacts: readdirSync(h.provider.root).filter(name => /^(children|rpc-events|git-commands|git-mutations|controller-state|controller-calls|checkpoint-|snapshot-|pending-old-reply|released-old-reply|resume-|gate-)/.test(name)).map(name => join(h.provider.root, name)).filter(existsSync),
  };
  writeFileSync(join(h.root, "evidence-index.json"), JSON.stringify(evidence, null, 2));
  if (evidenceBase) appendFileSync(join(evidenceBase, "index.jsonl"), `${JSON.stringify(evidence)}\n`);
}
async function approved(h: Harness, capacity = 6, publication = false): Promise<ExecutionManifest> {
  const first = await h.bridge.run(h.planPath); assert.equal(first.kind, "approval-required", JSON.stringify(first)); if (first.kind !== "approval-required") throw new Error("approval fixture");
  const second = await h.bridge.run(h.planPath, { token: first.preview.token, capacity, publication, ...(first.preview.boundary.publicationRepository ? { publicationRepository: first.preview.boundary.publicationRepository } : {}), approvedBy: h.sessionFile, approvedAt: Date.now() });
  assert.equal(second.kind, "started", JSON.stringify(second)); if (second.kind !== "started") throw new Error("start fixture"); return second.manifest;
}
/** Consolidated E2E eventual budget. Every wait in this file observes a real
 * pipeline — real Node child processes, real Git worktrees/cherry-picks, real
 * `node --test` combined checks, and real controller handoffs — while the full
 * parallel suite loads the CPU. Measured pipelines: AE4's three capacity-2 waves
 * ≈5.3s per wave plus the final delivery-group integration ≈18–20s total; the
 * retained AE7 controller-conflict run (execution-e2e-jVSf08 at 3773d68) had all
 * six workers terminal by ≈8.8s and delivery-b integrated, checked, and handed
 * off by ≈11.6s, but delivery-a's first integration intent hit a benign
 * receipt-validation race ("missing validated current result") and its retry was
 * still composing at ≈12.1s when the previous 12s default expired — the true
 * need was ≈15s under suite load (≈2× under heavier load). AE9's legacy preset
 * pays the same per-child cost four times strictly serialized at capacity 1.
 * 30s is the workload-derived capped default covering all of these (≈2× the
 * observed ≈15s AE7 need, ≈1.5× AE4's ≈18–20s three-wave need), not a
 * retry-until-green: every predicate still asserts exact ledger phases, each
 * wait stays individually bounded, and short synchronous negative gates remain
 * immediate asserts outside this helper. */
const E2E_EVENTUAL_BUDGET_MS = 30_000;
async function eventually<T>(read: () => T, predicate: (value: T) => boolean, label: string, ms = E2E_EVENTUAL_BUDGET_MS): Promise<T> {
  const startedAt = Date.now(); const deadline = startedAt + ms; let value = read();
  while (!predicate(value) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 15)); value = read(); }
  assert.ok(predicate(value), `${label}: timed out after ${Date.now() - startedAt}ms of ${ms}ms budget: ${JSON.stringify(value)}`); return value;
}
function taskId(manifest: ExecutionManifest, logical: string): string { return manifest.tasks.find(task => task.text.includes(`TASK_ID: ${logical}`))!.id; }
function ledger(path: string): Array<Record<string, unknown>> { return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; }
function writeGateEvidence(h: Harness, name: string, value: unknown): void { writeFileSync(join(h.provider.root, `gate-${name}.json`), JSON.stringify(value, null, 2)); }
function isGitMutation(args: readonly string[]): boolean { return new Set(["wt", "add", "commit", "cherry-pick", "merge", "reset", "checkout", "update-ref"]).has(args[0] ?? ""); }
function release(h: Harness) { mkdirSync(join(h.provider.root, "barrier"), { recursive: true }); writeFileSync(join(h.provider.root, "barrier", "release"), "release\n"); }
function releasePause(h: Harness, task: "a" | "b") { mkdirSync(join(h.provider.root, `barrier-${task}`), { recursive: true }); writeFileSync(join(h.provider.root, `barrier-${task}`, "release"), "release\n"); }
async function close(h: Harness) { retainHarnessEvidence(h); await h.bridge.shutdown(); await h.provider.dispose(); }
function crashOwnerArgs(h: Harness, mode: string): string[] { return ["--experimental-strip-types", crashOwnerPath, h.stateRoot, h.repo.commonDir, h.sessionFile, h.repoPath, h.ownedRoot, h.planPath, h.provider.root, mode]; }
function startCrashOwner(h: Harness, mode: string): ChildProcess { const child = spawn(process.execPath, crashOwnerArgs(h, mode), { stdio: ["ignore", "pipe", "pipe"] }); child.stdout?.on("data", value => appendFileSync(join(h.provider.root, "owner-stdout.log"), String(value))); child.stderr?.on("data", value => appendFileSync(join(h.provider.root, "owner-stderr.log"), String(value))); return child; }
async function waitForExit(child: ChildProcess): Promise<void> { if (child.exitCode !== null) return; await new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); }); }
async function waitForStopped(child: ChildProcess, label: string): Promise<void> { await eventually(() => { try { return execFileSync("ps", ["-o", "state=", "-p", String(child.pid)], { encoding: "utf8" }).trim(); } catch { return ""; } }, state => /^T/.test(state), label); }
async function killOwner(child: ChildProcess): Promise<void> { if (child.exitCode === null) child.kill("SIGKILL"); await waitForExit(child); }
async function stopOwner(h: Harness, child: ChildProcess): Promise<void> { writeFileSync(join(h.provider.root, "stop"), "stop\n"); await waitForExit(child); }

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
    await eventually(() => h.provider.events(), events => events.some(e => e.event === "ready" && e.taskId === "followup"), "follow-up readiness");
    const followStart = h.provider.events().find(e => e.event === "start" && e.taskId === "followup")!;
    const startup = JSON.parse(readFileSync(join(h.provider.root, "runs", String(followStart.runId), "startup-snapshot.json"), "utf8"));
    assert.equal(startup.files["src/a1.txt"], startup.files["src/a1.txt"]?.startsWith("worker:a1:") ? startup.files["src/a1.txt"] : undefined);
    assert.equal(startup.files["src/a2.txt"], startup.files["src/a2.txt"]?.startsWith("worker:a2:") ? startup.files["src/a2.txt"] : undefined);
    for (const sibling of ["src/a3.txt", "src/a4.txt", "src/a5.txt", "src/b1.txt"]) assert.equal(startup.files[sibling], null, `${sibling} must be absent from composed prerequisite tree`);
    const follow = h.bridge.store.read().attempts.find(a => a.taskId === taskId(manifest, "followup"))!; const expected = new Set([taskId(manifest, "a1"), taskId(manifest, "a2")].map(id => h.bridge.store.read().results.find(r => r.taskId === id)!.digest));
    assert.deepEqual(new Set(follow.prerequisiteDigests), expected); assert.ok(h.bridge.store.read().attempts.filter(a => ["preparing", "launching", "running"].includes(a.phase)).length >= 3); release(h);
    await eventually(() => h.bridge.store.read(), state => state.attempts.every(a => a.phase === "succeeded"), "dependency scenario completion");
  } finally { release(h); await close(h); }
});

test("U8 AE3 gamma failure explains its dependent block and targeted retry preserves siblings", async () => {
  const h = makeHarness("gamma");
  try {
    const manifest = await approved(h); const gamma = taskId(manifest, "gamma"), dependent = taskId(manifest, "gamma-dependent"), sibling = taskId(manifest, "sibling"), b = taskId(manifest, "b1");
    await eventually(() => h.bridge.store.read(), state => state.attempts.some(a => a.taskId === gamma && a.phase === "failed") && state.tasks.some(t => t.taskId === dependent && t.phase === "dependency-blocked"), "gamma blocked dependent");
    await eventually(() => h.bridge.store.read(), state => state.tasks.some(t => t.taskId === sibling && t.phase === "succeeded") && state.tasks.some(t => t.taskId === b && t.phase === "succeeded"), "independent A/B completion before retry");
    const beforeSibling = h.provider.events().filter(e => e.event === "start" && e.taskId === "sibling").length; assert.equal(beforeSibling, 1); assert.match(h.bridge.store.read().tasks.find(t => t.taskId === dependent)!.reason ?? "", /dependency|failed|unavailable/i);
    await h.bridge.control({ targetId: gamma, action: "retry" }); await eventually(() => h.bridge.store.read(), state => state.attempts.filter(a => a.taskId === gamma && a.phase === "succeeded").length === 1 && state.tasks.find(t => t.taskId === dependent)?.phase === "succeeded", "gamma retry");
    assert.equal(h.provider.events().filter(e => e.event === "start" && e.taskId === "gamma").length, 2); assert.equal(h.provider.events().filter(e => e.event === "start" && e.taskId === "sibling").length, beforeSibling);
  } finally { await close(h); }
});

test("U8 AE4 explicit five is refused at capacity two; concurrency-only revision retains all tasks", async () => {
  // Capacity-two execution runs the six tasks as three serialized waves, and each
  // real-Git wave pays worktree provisioning, child spawn, child run, terminal
  // observation, and receipt validation — measured ≈5.3s per wave under the full
  // parallel suite, plus the final delivery-group integration, for an observed
  // worst need of ≈18–20s. This wait pins the shared 30s E2E eventual budget:
  // ≈1.5× that measured three-wave need (not ≥2× — 2×18–20s would be 36–40s; the
  // previous comment's arithmetic was wrong). Capped, not a retry-until-green: the
  // six-succeeded assertion, capacity-two first-wave check, and
  // notification-driven release flow below are unchanged.
  const capacityWaveBudgetMs = E2E_EVENTUAL_BUDGET_MS;
  const h = makeHarness("capacity", 2);
  try {
    const refused = await h.bridge.run(h.planPath); assert.equal(refused.kind, "refused"); assert.match(refused.reason, /capacity|simultaneous/i); assert.equal(h.provider.spawnParams.length, 1, "only interpretation child may run");
    writeFileSync(h.planPath, "# Capacity revision\n\ncapacity-revision keeps all five worker identities and removes only the simultaneous-five request.\n"); const preview = await h.bridge.run(h.planPath); assert.equal(preview.kind, "approval-required"); if (preview.kind !== "approval-required") return; assert.equal(preview.preview.manifest.tasks.length, 6); assert.equal(preview.preview.manifest.constraints.parallelGroups.length, 0); assert.deepEqual(preview.preview.manifest.tasks.map(t => t.text.split("\n")[0]!.replace("TASK_ID: ", "")).sort(), ["a1", "a2", "a3", "a4", "a5", "b1"]); assert.equal(h.provider.spawnParams.filter(p => String(p.task).includes("TASK_ID:")).length, 0);
    const started = await h.bridge.run(h.planPath, { token: preview.preview.token, capacity: 2, publication: false, approvedBy: h.sessionFile, approvedAt: Date.now() }); assert.equal(started.kind, "started");
    await eventually(() => h.provider.events(), events => events.filter(e => e.event === "ready" && e.mode === "worker").length === 2, "capacity-two first wave"); assert.equal(h.provider.events().filter(e => e.event === "start" && e.mode === "worker").length, 2); release(h);
    await eventually(() => h.bridge.store.read(), state => state.attempts.filter(a => a.phase === "succeeded").length === 6, "all five workers plus B complete", capacityWaveBudgetMs);
    const events = h.provider.events().filter(e => e.event === "start" && e.mode === "worker"); assert.equal(new Set(events.filter(e => /^a[1-5]$/.test(String(e.taskId))).map(e => e.taskId)).size, 5);
  } finally { release(h); await close(h); }
});

test("U8 AE5 approved revision executes discovered in-scope task while alpha stays gated, then fences explicit dependency revision", async () => {
  const h = makeHarness("sparse");
  try {
    const first = await h.bridge.run(h.planPath); assert.equal(first.kind, "approval-required", JSON.stringify(first)); if (first.kind !== "approval-required") return;
    assert.deepEqual(first.preview.manifest.tasks.map(item => item.text.split("\n")[0]), ["TASK_ID: alpha", "TASK_ID: beta"]); assert.equal(first.preview.manifest.tasks[1]!.dependencies.length, 0);
    const started = await h.bridge.run(h.planPath, { token: first.preview.token, capacity: 6, publication: false, approvedBy: h.sessionFile, approvedAt: Date.now() }); assert.equal(started.kind, "started", JSON.stringify(started)); if (started.kind !== "started") return;
    const baselineState = h.bridge.store.read(), baselineManifest = baselineState.manifests.find(item => item.id === started.manifest.id && item.revision === 1)!, baselineAuthorization = baselineState.authorizations.find(item => item.manifestId === started.manifest.id && item.revision === 1)!, baselineBeta = baselineManifest.tasks.find(item => item.text.includes("TASK_ID: beta"))!;
    assert.equal(baselineState.activeRevisions[started.manifest.id], 1); assert.equal(baselineAuthorization.manifestDigest, digest(baselineManifest)); assert.deepEqual(baselineBeta.dependencies, []); assert.equal(baselineBeta.provenance.find(item => item.field === "dependencies")!.origin, "explicit");
    await eventually(() => h.provider.events(), events => events.some(e => e.event === "ready" && e.taskId === "alpha"), "gated retained alpha worker");
    await eventually(() => h.bridge.store.read(), state => state.tasks.some(item => item.taskId === taskId(started.manifest, "beta") && item.phase === "succeeded"), "initial beta receipt");
    const initialStarts = Object.fromEntries(["alpha", "beta", "discovered"].map(id => [id, h.provider.events().filter(e => e.event === "start" && e.taskId === id).length]));
    writeFileSync(h.planPath, "# Sparse revision\n\nin-scope\n"); const discoveredPreview = await h.bridge.run(h.planPath); assert.equal(discoveredPreview.kind, "approval-required", JSON.stringify(discoveredPreview)); if (discoveredPreview.kind !== "approval-required") return;
    const discoveredTask = discoveredPreview.preview.manifest.tasks.find(item => item.text.includes("TASK_ID: discovered"))!; assert.equal(discoveredTask.featureId, "feature-a"); assert.deepEqual(discoveredTask.scope, ["src/"]); assert.equal(discoveredTask.dependencies.length, 0); assert.equal(discoveredPreview.preview.manifest.revision, 2);
    const discoveredStarted = await h.bridge.run(h.planPath, { token: discoveredPreview.preview.token, capacity: 6, publication: false, approvedBy: h.sessionFile, approvedAt: Date.now() }); assert.equal(discoveredStarted.kind, "started", JSON.stringify(discoveredStarted)); if (discoveredStarted.kind !== "started") return;
    await eventually(() => h.bridge.store.read(), state => state.tasks.some(item => item.taskId === taskId(discoveredStarted.manifest, "discovered") && item.phase === "succeeded"), "discovered in-scope task receipt while alpha gated");
    const alphaAttempt = h.bridge.store.read().attempts.find(item => item.taskId === taskId(discoveredStarted.manifest, "alpha"))!; assert.equal(alphaAttempt.phase, "running"); assert.equal(h.provider.events().filter(e => e.event === "start" && e.taskId === "alpha").length, Number(initialStarts.alpha ?? 0)); assert.equal(h.provider.events().filter(e => e.event === "start" && e.taskId === "beta").length, Number(initialStarts.beta ?? 0));
    const approvedBeforeDependencyChange = h.bridge.store.read(), approvedRevision = approvedBeforeDependencyChange.manifests.find(item => item.id === started.manifest.id && item.revision === 2)!, approvedRevisionAuthorization = approvedBeforeDependencyChange.authorizations.find(item => item.manifestId === started.manifest.id && item.revision === 2)!, approvedRevisionBeta = approvedRevision.tasks.find(item => item.text.includes("TASK_ID: beta"))!;
    assert.equal(approvedBeforeDependencyChange.activeRevisions[started.manifest.id], 2); assert.equal(approvedRevisionAuthorization.manifestDigest, digest(approvedRevision)); assert.deepEqual(approvedRevisionBeta.dependencies, []); assert.equal(approvedRevisionBeta.provenance.find(item => item.field === "dependencies")!.origin, "explicit");
    writeFileSync(h.planPath, "# Sparse dependency revision\n\ndependency\n"); const dependencyPreview = await h.bridge.run(h.planPath); assert.equal(dependencyPreview.kind, "approval-required", JSON.stringify(dependencyPreview)); if (dependencyPreview.kind !== "approval-required") return; assert.equal(dependencyPreview.preview.manifest.revision, 3);
    const revisedBeta = dependencyPreview.preview.manifest.tasks.find(item => item.text.includes("TASK_ID: beta"))!; assert.deepEqual(revisedBeta.dependencies, [taskId(dependencyPreview.preview.manifest, "alpha")]); assert.equal(revisedBeta.provenance.find(item => item.field === "dependencies")!.origin, "explicit"); assert.equal(h.bridge.store.read().activeRevisions[started.manifest.id], 2); assert.equal(h.bridge.store.read().manifests.some(item => item.id === started.manifest.id && item.revision === 3), false);
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(h.provider.events().filter(e => e.event === "start" && e.taskId === "beta").length, Number(initialStarts.beta ?? 0), "revision remains approval-fenced before approval");
    const dependencyStarted = await h.bridge.run(h.planPath, { token: dependencyPreview.preview.token, capacity: 6, publication: false, approvedBy: h.sessionFile, approvedAt: Date.now() }); assert.equal(dependencyStarted.kind, "started", JSON.stringify(dependencyStarted)); if (dependencyStarted.kind !== "started") return;
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(h.provider.events().filter(e => e.event === "start" && e.taskId === "beta").length, Number(initialStarts.beta ?? 0), "changed dependency waits for its gated prerequisite"); release(h);
    await eventually(() => h.bridge.store.read(), state => state.tasks.some(item => item.taskId === taskId(dependencyStarted.manifest, "beta") && item.phase === "succeeded"), "explicit dependency post-approval launch");
    assert.equal(h.provider.events().filter(e => e.event === "start" && e.taskId === "alpha").length, Number(initialStarts.alpha ?? 0)); assert.equal(h.provider.events().filter(e => e.event === "start" && e.taskId === "discovered").length, 1); assert.equal(h.provider.events().filter(e => e.event === "start" && e.taskId === "beta").length, Number(initialStarts.beta ?? 0) + 1);
    const approvedAfterDependencyChange = h.bridge.store.read(), approvedRevisionAfterChange = approvedAfterDependencyChange.manifests.find(item => item.id === started.manifest.id && item.revision === 3)!, approvedRevisionAfterChangeAuthorization = approvedAfterDependencyChange.authorizations.find(item => item.manifestId === started.manifest.id && item.revision === 3)!, approvedRevisionAfterChangeBeta = approvedRevisionAfterChange.tasks.find(item => item.text.includes("TASK_ID: beta"))!;
    assert.equal(approvedAfterDependencyChange.activeRevisions[started.manifest.id], 3); assert.equal(approvedRevisionAfterChangeAuthorization.manifestDigest, digest(approvedRevisionAfterChange)); assert.deepEqual(approvedRevisionAfterChangeBeta.dependencies, [taskId(approvedRevisionAfterChange, "alpha")]); assert.equal(approvedRevisionAfterChangeBeta.provenance.find(item => item.field === "dependencies")!.origin, "explicit");
    writeGateEvidence(h, "ae5-in-scope-and-explicit", { revisions: [1, 2, 3], discovered: { taskId: discoveredTask.id, featureId: discoveredTask.featureId, scope: discoveredTask.scope, receipts: 1 }, alphaStarts: Number(initialStarts.alpha ?? 0), betaStarts: Number(initialStarts.beta ?? 0) + 1, manifestEvidence: { baseline: { at: Date.now(), revision: baselineManifest.revision, betaDependencies: baselineBeta.dependencies, betaDependencyProvenance: baselineBeta.provenance.find(item => item.field === "dependencies"), authorizationManifestDigest: baselineAuthorization.manifestDigest }, before: { at: Date.now(), revision: approvedRevision.revision, betaDependencies: approvedRevisionBeta.dependencies, betaDependencyProvenance: approvedRevisionBeta.provenance.find(item => item.field === "dependencies"), authorizationManifestDigest: approvedRevisionAuthorization.manifestDigest }, proposed: { at: Date.now(), revision: dependencyPreview.preview.manifest.revision, betaDependencies: revisedBeta.dependencies, betaDependencyProvenance: revisedBeta.provenance.find(item => item.field === "dependencies"), approvalRequired: dependencyPreview.kind === "approval-required" }, after: { at: Date.now(), revision: approvedRevisionAfterChange.revision, betaDependencies: approvedRevisionAfterChangeBeta.dependencies, betaDependencyProvenance: approvedRevisionAfterChangeBeta.provenance.find(item => item.field === "dependencies"), authorizationManifestDigest: approvedRevisionAfterChangeAuthorization.manifestDigest } }, explicitDependency: revisedBeta.dependencies, approvalFenced: true });
  } finally { release(h); await close(h); }
});

test("U8 AE5 new-feature discovery requires its own approval and launches only afterward", async () => {
  const h = makeHarness("sparse");
  try {
    const first = await h.bridge.run(h.planPath); assert.equal(first.kind, "approval-required", JSON.stringify(first)); if (first.kind !== "approval-required") return;
    const started = await h.bridge.run(h.planPath, { token: first.preview.token, capacity: 6, publication: false, approvedBy: h.sessionFile, approvedAt: Date.now() }); assert.equal(started.kind, "started", JSON.stringify(started)); if (started.kind !== "started") return;
    await eventually(() => h.provider.events(), events => events.some(e => e.event === "ready" && e.taskId === "alpha"), "new-feature alpha gate"); await eventually(() => h.bridge.store.read(), state => state.tasks.some(item => item.taskId === taskId(started.manifest, "beta") && item.phase === "succeeded"), "new-feature baseline beta");
    writeFileSync(h.planPath, "# Sparse new feature revision\n\nnew-feature\n"); const preview = await h.bridge.run(h.planPath); assert.equal(preview.kind, "approval-required", JSON.stringify(preview)); if (preview.kind !== "approval-required") return; assert.equal(preview.preview.manifest.revision, 2); assert.ok(preview.preview.manifest.features.some(item => item.id === "feature-c")); assert.ok(preview.preview.manifest.tasks.some(item => item.text.includes("TASK_ID: new")));
    const beforeNew = h.provider.events().filter(e => e.event === "start" && e.taskId === "new").length; await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(h.provider.events().filter(e => e.event === "start" && e.taskId === "new").length, beforeNew, "new feature remains approval-fenced");
    const approvedRevision = await h.bridge.run(h.planPath, { token: preview.preview.token, capacity: 6, publication: false, approvedBy: h.sessionFile, approvedAt: Date.now() }); assert.equal(approvedRevision.kind, "started", JSON.stringify(approvedRevision)); if (approvedRevision.kind !== "started") return; await eventually(() => h.bridge.store.read(), state => state.tasks.some(item => item.taskId === taskId(approvedRevision.manifest, "new") && item.phase === "succeeded"), "new feature post-approval launch"); assert.equal(h.provider.events().filter(e => e.event === "start" && e.taskId === "new").length, 1);
    writeGateEvidence(h, "ae5-new-feature", { revision: 2, featureId: "feature-c", taskId: taskId(approvedRevision.manifest, "new"), preApprovalStarts: beforeNew, postApprovalStarts: 1, alphaStillGatedBeforeRelease: h.bridge.store.read().attempts.some(item => item.taskId === taskId(approvedRevision.manifest, "alpha") && item.phase === "running") });
  } finally { release(h); await close(h); }
});

test("U8 AE6 same-PID reload and true exited-owner startup reconcile one real run", async () => {
  const h = makeHarness("recovery"); let replacement: ExecutionBridge | undefined; let crash: ChildProcess | undefined;
  try {
    const manifest = await approved(h); await eventually(() => h.provider.events(), events => events.some(e => e.event === "start" && e.taskId === "recovery"), "recovery child launch"); const recoveryStart = h.provider.events().find(e => e.event === "start" && e.taskId === "recovery")!; await eventually(() => h.provider.events(), events => events.some(e => e.event === "ready" && e.runId === recoveryStart.runId), "recovery child readiness"); const recoveryStatusPath = join(h.provider.root, "runs", String(recoveryStart.runId), "status.json"); const recoveryStatus = JSON.parse(readFileSync(recoveryStatusPath, "utf8")); assert.equal(recoveryStatus.state, "running"); assert.equal(existsSync(`${recoveryStatusPath}.${recoveryStart.pid}.tmp`), false); await eventually(() => h.bridge.store.read(), state => state.attempts.some(a => a.taskId === taskId(manifest, "recovery") && ["running", "launching", "recovery-needed"].includes(a.phase) && !!a.run), "persisted real run");
    await h.bridge.shutdown();
    crash = spawn(process.execPath, ["--experimental-strip-types", crashOwnerPath, join(h.stateRoot, "plan-driven-v1"), h.repo.commonDir, h.sessionFile], { stdio: ["ignore", "pipe", "pipe"] }); await new Promise<void>((resolve, reject) => { crash!.stdout?.once("data", () => resolve()); crash!.once("error", reject); }); const crashedPid = crash.pid!; crash.kill("SIGKILL"); await new Promise(resolve => crash!.once("close", resolve)); assert.ok(crashedPid > 0);
    replacement = createExecutionBridge({ ...((h as any).bridge ? {} : {}), pi: h.pi, events: h.provider, repo: h.repo, referencePath: h.repoPath, stateRoot: h.stateRoot, sessionFile: h.sessionFile, processStart: `e2e-reload:${process.pid}`, capacity: 6, ownedRoot: h.ownedRoot, interpretationTransport: createExecutionInterpreter({ events: h.provider, sessionFile: h.sessionFile }) });
    await replacement.start({ resumePriorOwner: true }); const active = replacement.store.read(); assert.equal(active.reservations.length, 1); assert.equal(h.provider.spawnParams.filter(p => String(p.task).includes("TASK_ID: recovery")).length, 1, "the crash-owner must not replay a launch");
    release(h); await eventually(() => replacement!.store.read(), state => state.attempts.some(a => a.taskId === taskId(manifest, "recovery") && a.phase === "succeeded"), "reconciled recovery terminal");
  } finally { release(h); retainHarnessEvidence(h); if (replacement) await replacement.shutdown(); else await h.bridge.shutdown(); if (crash && crash.exitCode === null) crash.kill("SIGKILL"); await h.provider.dispose(); }
});

test("U8 AE6 same-PID reload fences a pending old-instance external reply after replacement acquires", async () => {
  const h = makeHarness("reload"); let replacement: ExecutionBridge | undefined;
  try {
    const manifest = await approved(h); await eventually(() => existsSync(join(h.provider.root, "pending-old-reply.json")), value => value, "old bridge pending external spawn reply");
    const oldState = h.bridge.store.read(), oldOwner = oldState.owner; assert.ok(oldOwner); assert.equal(oldState.results.length, 0); assert.equal(oldState.reservations.length, 1);
    await h.bridge.shutdown();
    replacement = createExecutionBridge({ pi: h.pi, events: h.provider, repo: h.repo, referencePath: h.repoPath, stateRoot: h.stateRoot, sessionFile: h.sessionFile, processStart: `e2e-replacement:${process.pid}`, capacity: 6, ownedRoot: h.ownedRoot, interpretationTransport: createExecutionInterpreter({ events: h.provider, sessionFile: h.sessionFile }) });
    await replacement.start({ resumePriorOwner: true }); await eventually(() => replacement!.store.read(), state => state.owner?.instanceId !== oldOwner.instanceId && state.attempts.some(item => item.taskId === taskId(manifest, "recovery") && item.phase === "running"), "replacement owns running child");
    const before = replacement.store.read(), replacementOwner = before.owner!; const beforeReservations = before.reservations.map(item => ({ id: item.id, attemptId: item.attemptId, workspacePath: item.workspacePath, slots: item.slots })); const beforeReceipts = before.results.map(item => item.digest);
    h.provider.releasePendingOldReply(); await eventually(() => existsSync(join(h.provider.root, "released-old-reply.json")), value => value, "released old-instance reply"); await new Promise(resolve => setTimeout(resolve, 100));
    const after = replacement.store.read(); assert.deepEqual(after.results.map(item => item.digest), beforeReceipts, "old callback cannot create a receipt"); assert.deepEqual(after.reservations.map(item => ({ id: item.id, attemptId: item.attemptId, workspacePath: item.workspacePath, slots: item.slots })), beforeReservations, "old callback cannot alter reservations"); assert.equal(after.owner?.instanceId, replacementOwner.instanceId); assert.equal(after.owner?.processStart, replacementOwner.processStart); assert.notEqual(after.owner?.instanceId, oldOwner.instanceId); assert.equal(after.attempts.find(item => item.taskId === taskId(manifest, "recovery"))!.phase, "running");
    writeGateEvidence(h, "ae6-old-instance-reply", { oldRequestId: JSON.parse(readFileSync(join(h.provider.root, "pending-old-reply.json"), "utf8")).request.requestId, releasedAfterReplacementOwner: replacementOwner.instanceId, beforeReceipts, afterReceipts: after.results.map(item => item.digest), beforeReservations, afterReservations: after.reservations.map(item => ({ id: item.id, attemptId: item.attemptId, workspacePath: item.workspacePath, slots: item.slots })), oldAuthorityRejected: after.owner?.instanceId !== oldOwner.instanceId }); release(h);
    await eventually(() => replacement!.store.read(), state => state.attempts.some(item => item.taskId === taskId(manifest, "recovery") && item.phase === "succeeded"), "replacement terminal receipt after old reply fence");
  } finally { release(h); if (replacement) await replacement.shutdown(); else await h.bridge.shutdown(); await h.provider.dispose(); }
});

test("U8 AE6 real owner death before spawn RPC retains unknown reservation without replay", async () => {
  const h = makeHarness("recovery"); let owner: ChildProcess | undefined; let replacement: ChildProcess | undefined;
  try {
    owner = startCrashOwner(h, "launch"); await eventually(() => existsSync(join(h.provider.root, "checkpoint-launch-intent-before-rpc.json")), value => value, "launch-intent checkpoint"); await waitForStopped(owner, "launch owner stopped at exact checkpoint");
    const before = h.bridge.store.read(); writeCrashSnapshot(h, "launch-intent-before-rpc", "before", before); assert.equal(before.attempts.length, 1); assert.equal(before.attempts[0]!.phase, "launching"); assert.equal(before.reservations.length, 1); assert.equal(before.results.length, 0); await killOwner(owner); owner = undefined;
    replacement = startCrashOwner(h, "resume-launch"); await eventually(() => existsSync(join(h.provider.root, "resume-ready.json")), value => value, "replacement owner startup"); await eventually(() => h.bridge.store.read(), state => state.attempts[0]?.phase === "recovery-needed", "unknown launch remains fenced");
    const after = h.bridge.store.read(); writeCrashSnapshot(h, "launch-intent-before-rpc", "after", after); assert.equal(after.reservations.length, 1); assert.equal(after.results.length, 0); assert.equal(readFileSync(join(h.provider.root, "rpc-events.jsonl"), "utf8").split("\n").filter(Boolean).length, 1); assert.equal(after.attempts[0]!.id, before.attempts[0]!.id);
  } finally { if (replacement) await stopOwner(h, replacement); if (owner) await killOwner(owner); await close(h); }
});

test("U8 AE6 real owner death after accepted launch before RPC acknowledgement keeps live child unknown and does not relaunch", async () => {
  const h = makeHarness("recovery"); let owner: ChildProcess | undefined; let replacement: ChildProcess | undefined;
  try {
    owner = startCrashOwner(h, "accepted"); await eventually(() => existsSync(join(h.provider.root, "checkpoint-accepted-before-ack.json")), value => value, "accepted-before-ack checkpoint"); await waitForStopped(owner, "accepted owner stopped at exact checkpoint");
    const checkpoint = JSON.parse(readFileSync(join(h.provider.root, "checkpoint-accepted-before-ack.json"), "utf8")); assert.ok(Number.isInteger(checkpoint.childPid) && checkpoint.childPid > 0); assert.doesNotThrow(() => process.kill(checkpoint.childPid, 0), "accepted child remains live behind its barrier");
    const before = h.bridge.store.read(); writeCrashSnapshot(h, "accepted-before-ack", "before", before); assert.equal(before.attempts.length, 1); assert.equal(before.attempts[0]!.phase, "launching"); assert.equal(before.reservations.length, 1); assert.equal(before.results.length, 0); await killOwner(owner); owner = undefined;
    replacement = startCrashOwner(h, "resume-accepted"); await eventually(() => existsSync(join(h.provider.root, "resume-ready.json")), value => value, "replacement owner startup"); await eventually(() => h.bridge.store.read(), state => state.attempts[0]?.phase === "recovery-needed", "accepted launch remains unknown");
    const after = h.bridge.store.read(); writeCrashSnapshot(h, "accepted-before-ack", "after", after); assert.equal(after.reservations.length, 1); assert.equal(after.results.length, 0); assert.equal(readFileSync(join(h.provider.root, "rpc-events.jsonl"), "utf8").split("\n").filter(Boolean).length, 1); assert.equal(after.attempts[0]!.id, before.attempts[0]!.id); mkdirSync(join(h.provider.root, "accepted-barrier"), { recursive: true }); writeFileSync(join(h.provider.root, "accepted-barrier", "release"), "release\\n"); await eventually(() => h.provider.events(), events => events.some(e => e.event === "end" && e.taskId === "recovery"), "accepted child terminal after fenced recovery");
  } finally { mkdirSync(join(h.provider.root, "accepted-barrier"), { recursive: true }); writeFileSync(join(h.provider.root, "accepted-barrier", "release"), "release\\n"); if (replacement) await stopOwner(h, replacement); if (owner) await killOwner(owner); await close(h); }
});

test("U8 AE6 real owner death after terminal evidence recovers one exact receipt and fences late callback", async () => {
  const h = makeHarness("recovery"); let owner: ChildProcess | undefined; let replacement: ChildProcess | undefined;
  try {
    owner = startCrashOwner(h, "terminal"); await eventually(() => existsSync(join(h.provider.root, "checkpoint-terminal-before-receipt.json")), value => value, "terminal-before-receipt checkpoint"); await waitForStopped(owner, "terminal owner stopped at exact checkpoint"); const before = h.bridge.store.read(); writeCrashSnapshot(h, "terminal-before-receipt", "before", before); assert.equal(before.results.length, 0); assert.equal(before.attempts.length, 1); await killOwner(owner); owner = undefined;
    replacement = startCrashOwner(h, "resume-terminal"); await eventually(() => existsSync(join(h.provider.root, "resume-ready.json")), value => value, "replacement owner startup"); await eventually(() => h.bridge.store.read(), state => state.results.length === 1 && state.attempts[0]?.phase === "succeeded", "terminal recovery receipt"); const recovered = h.bridge.store.read(); writeCrashSnapshot(h, "terminal-before-receipt", "after", recovered); const receiptDigest = recovered.results[0]!.digest; writeFileSync(join(h.provider.root, "late-old-callback"), "late\n"); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(h.bridge.store.read().results.length, 1); assert.equal(h.bridge.store.read().results[0]!.digest, receiptDigest); assert.equal(readFileSync(join(h.provider.root, "rpc-events.jsonl"), "utf8").split("\n").filter(Boolean).length, 1);
  } finally { if (replacement) await stopOwner(h, replacement); if (owner) await killOwner(owner); await close(h); }
});

test("U8 AE6 real owner death after Git mutation keeps completed journal and never re-cherry-picks", async () => {
  const h = makeHarness("recovery"); let owner: ChildProcess | undefined; let replacement: ChildProcess | undefined;
  try {
    owner = startCrashOwner(h, "integration"); await eventually(() => existsSync(join(h.provider.root, "checkpoint-git-mutation-before-integration-receipt.json")), value => value, "Git mutation before integration receipt checkpoint"); await waitForStopped(owner, "integration owner stopped at exact checkpoint"); const before = h.bridge.store.read(); writeCrashSnapshot(h, "git-mutation-before-integration-receipt", "before", before); assert.equal(before.integrations.length, 1); assert.equal(before.integrations[0]!.phase, "validating"); assert.equal(before.integrationReceipts.length, 0); const cherryPicksBefore = readFileSync(join(h.provider.root, "git-commands.jsonl"), "utf8").split("\n").filter(line => line.includes('"cherry-pick"')).length; assert.equal(cherryPicksBefore, 1); await killOwner(owner); owner = undefined;
    replacement = startCrashOwner(h, "resume-integration"); await eventually(() => existsSync(join(h.provider.root, "resume-ready.json")), value => value, "replacement owner startup"); await eventually(() => h.bridge.store.read(), state => state.integrationReceipts.length === 1 && state.deliveries[0]?.phase === "ready", "integration receipt recovery"); const after = h.bridge.store.read(); writeCrashSnapshot(h, "git-mutation-before-integration-receipt", "after", after); assert.equal(after.integrationReceipts.length, 1); const cherryPicksAfter = readFileSync(join(h.provider.root, "git-commands.jsonl"), "utf8").split("\n").filter(line => line.includes('"cherry-pick"')).length; assert.equal(cherryPicksAfter, cherryPicksBefore); assert.equal(after.integrations.filter(i => i.phase === "complete").length, 1);
  } finally { if (replacement) await stopOwner(h, replacement); if (owner) await killOwner(owner); await close(h); }
});

test("U8 AE6 real owner death after controller persistence keeps pending fence and reconciles one transfer", async () => {
  const h = makeHarness("recovery"); let owner: ChildProcess | undefined; let replacement: ChildProcess | undefined;
  try {
    owner = startCrashOwner(h, "controller"); await eventually(() => existsSync(join(h.provider.root, "checkpoint-controller-persist-before-local-ack.json")), value => value, "controller persistence before local acknowledgement checkpoint"); await waitForStopped(owner, "controller owner stopped at exact checkpoint"); const before = h.bridge.store.read(); writeCrashSnapshot(h, "controller-persist-before-local-ack", "before", before); assert.equal(before.deliveries[0]?.phase, "handoff-pending"); assert.equal(before.deliveries[0]?.acknowledgement, undefined); const deliveryHead = before.deliveries[0]!.handoff!.head; const controllerCallsBefore = ledger(join(h.provider.root, "controller-calls.jsonl")); const gitMutationsBefore = ledger(join(h.provider.root, "git-mutations.jsonl")); assert.equal(controllerCallsBefore.length, 1); assert.ok(gitMutationsBefore.length > 0); assert.equal(JSON.parse(readFileSync(join(h.provider.root, "controller-state.json"), "utf8")).view.head, deliveryHead); await killOwner(owner); owner = undefined;
    replacement = startCrashOwner(h, "resume-controller"); await eventually(() => existsSync(join(h.provider.root, "resume-ready.json")), value => value, "replacement owner startup"); await eventually(() => h.bridge.store.read(), state => state.deliveries[0]?.phase === "controller-owned", "persisted controller acknowledgement"); const after = h.bridge.store.read(); writeCrashSnapshot(h, "controller-persist-before-local-ack", "after", after); assert.equal(after.deliveries.length, 1); assert.ok(after.deliveries[0]!.acknowledgement); assert.equal(after.deliveries[0]!.handoff!.head, deliveryHead); assert.equal(JSON.parse(readFileSync(join(h.provider.root, "controller-state.json"), "utf8")).view.head, deliveryHead); assert.equal(ledger(join(h.provider.root, "controller-calls.jsonl")).length, controllerCallsBefore.length); assert.deepEqual(ledger(join(h.provider.root, "git-mutations.jsonl")), gitMutationsBefore);
    writeGateEvidence(h, "ae6-controller-ledgers", { controllerCalls: controllerCallsBefore.length, gitMutations: gitMutationsBefore.length, deliveryHead, unchangedAcrossRestart: true });
  } finally { if (replacement) await stopOwner(h, replacement); if (owner) await killOwner(owner); await close(h); }
});

test("U8 malformed lifecycle evidence never yields a successful receipt", async () => {
  const h = makeHarness("malformed");
  try {
    await approved(h); await eventually(() => h.bridge.store.read(), state => state.attempts.length === 6 && state.attempts.every(a => a.phase === "recovery-needed" && /Malformed runtime status artifact/.test(a.reason ?? "")), "malformed lifecycle rejection"); assert.equal(h.bridge.store.read().results.length, 0);
  } finally { await close(h); }
});

test("U8 AE7 failed A gate stays blocked while independent B completes deterministic controller lifecycle", async () => {
  const h = makeHarness("controller-conflict"), controllerStatePath = join(h.root, "controller-state.json"), controllerCallsPath = join(h.provider.root, "controller-calls.jsonl"); let bridge: ExecutionBridge | undefined, controllerReady = false;
  type ControllerState = { view?: { pr: string; owner: { kind: "feature" | "execution" | "session"; id: string; generation: string }; worktree: string; head: string; state: "waiting_review" | "merged"; pendingCount: number }; acknowledgement?: { requestId: string; controllerId: string; obligationId: string; generation: string; acceptedAt: number } };
  const readControllerState = (): ControllerState => existsSync(controllerStatePath) ? JSON.parse(readFileSync(controllerStatePath, "utf8")) as ControllerState : {};
  const writeControllerState = (value: ControllerState) => writeFileSync(controllerStatePath, JSON.stringify(value));
  const controller = {
    handoff(request: any) { const state: ControllerState = { view: { pr: "github.com/acme/e2e#7", owner: request.owner, worktree: request.worktree, head: request.head, state: "waiting_review", pendingCount: 1 } }; appendFileSync(controllerCallsPath, `${JSON.stringify({ action: "handoff", head: request.head, worktree: request.worktree })}\n`); writeControllerState(state); return { ok: true, state: "waiting_review" as const }; },
    status() { const state = readControllerState(); return controllerReady && state.view ? [state.view] : []; },
  };
  const delivery = createControllerDeliveryAdapter({
    controller, controllerId: "ae7-controller",
    acknowledged: request => readControllerState().acknowledgement?.requestId === request.id ? readControllerState().acknowledgement : undefined,
    verifyMerge: async request => readControllerState().view?.state === "merged" ? { commit: request.head, url: `https://${request.pr.repo}/pull/${request.pr.number}`, observedAt: Date.now() } : undefined,
  });
  bridge = createExecutionBridge({ pi: h.pi, events: h.provider, repo: h.repo, referencePath: h.repoPath, stateRoot: h.stateRoot, sessionFile: h.sessionFile, processStart: "e2e-ae7-controller", capacity: 6, ownedRoot: h.ownedRoot, repository: "github.com/acme/e2e", delivery, resolvePr: async () => ({ kind: "authorized", pr: { repo: "github.com/acme/e2e", number: 7 }, generation: "ae7-generation", ownerId: "feature-b", ownerKind: "execution" }), interpretationTransport: createExecutionInterpreter({ events: h.provider, sessionFile: h.sessionFile }) });
  try {
    const first = await bridge.run(h.planPath); assert.equal(first.kind, "approval-required", JSON.stringify(first)); if (first.kind !== "approval-required") return; assert.equal(first.preview.boundary.publication, true);
    const started = await bridge.run(h.planPath, { token: first.preview.token, capacity: 6, publication: true, publicationRepository: "github.com/acme/e2e", approvedBy: h.sessionFile, approvedAt: Date.now() }); assert.equal(started.kind, "started", JSON.stringify(started)); if (started.kind !== "started") return; release(h);
    await eventually(() => bridge.store.read(), state => state.deliveries.some(item => item.groupId === "delivery-a" && item.phase === "blocked") && state.deliveries.some(item => item.groupId === "delivery-b" && item.phase === "handoff-pending"), "A blocked while B handoff pending");
    const beforeController = bridge.store.read(), request = beforeController.deliveries.find(item => item.groupId === "delivery-b")!.handoff!; assert.equal(beforeController.deliveries.find(item => item.groupId === "delivery-a")!.phase, "blocked"); assert.equal(beforeController.deliveries.find(item => item.groupId === "delivery-b")!.phase, "handoff-pending"); assert.equal(ledger(controllerCallsPath).length, 1);
    controllerReady = true; writeControllerState({ ...readControllerState(), acknowledgement: { requestId: request.id, controllerId: "ae7-controller", obligationId: digest([{ host: "github.com", owner: "acme", repo: "e2e", number: "7" }, readControllerState().view!.owner, readControllerState().view!.worktree, request.head]), generation: request.generation, acceptedAt: 1 } }); h.provider.emit(PR_REVIEW_RECONCILED_EVENT, { pr: request.pr });
    await eventually(() => bridge.store.read(), state => state.deliveries.find(item => item.groupId === "delivery-b")?.phase === "controller-owned", "B controller acknowledgement"); assert.equal(bridge.store.read().deliveries.find(item => item.groupId === "delivery-a")!.phase, "blocked"); assert.equal(ledger(controllerCallsPath).length, 1);
    writeControllerState({ ...readControllerState(), view: { ...readControllerState().view!, state: "merged", pendingCount: 0 } }); h.provider.emit(PR_REVIEW_RECONCILED_EVENT, { pr: request.pr }); await eventually(() => bridge.store.read(), state => state.deliveries.find(item => item.groupId === "delivery-b")?.phase === "merged", "B verified controller merge");
    const state = bridge.store.read(); assert.equal(state.deliveries.find(item => item.groupId === "delivery-a")!.phase, "blocked"); assert.equal(state.deliveries.find(item => item.groupId === "delivery-b")!.phase, "merged"); assert.equal(state.manifests.find(item => item.id === started.manifest.id)!.deliveryGroups.length, 2); assert.equal(ledger(controllerCallsPath).length, 1);
    writeGateEvidence(h, "ae7-controller-lifecycle", { a: state.deliveries.find(item => item.groupId === "delivery-a")!.phase, bPhases: ["handoff-pending", "controller-owned", "merged"], controllerCalls: ledger(controllerCallsPath).length, deliveryHead: request.head });
  } finally { release(h); if (bridge) await bridge.shutdown(); await h.provider.dispose(); retainHarnessEvidence(h); }
});

test("U8 AE8 public bridge pause-A preserves observable independent B progress", async () => {
  const h = makeHarness("pause");
  try {
    const manifest = await approved(h); await eventually(() => h.provider.events(), events => events.some(e => e.event === "ready" && e.taskId === "a1") && events.some(e => e.event === "ready" && e.taskId === "b1"), "independently gated pause-A and B activity");
    // Fixture/provider parity: after each child atomically publishes its running
    // status artifact, the provider decodes the child's exact-run/session
    // readiness line into the supported `subagent:child-status` runtime event;
    // the production runtime subscription (attempt-runtime) wakes the scheduler
    // to reread the authoritative persisted state, so the acknowledged launch
    // cannot remain conservatively fenced (recovery-needed) when its
    // post-launch observation raced the artifact write. This barrier therefore
    // reads the store passively — no reconcile loop, no synthetic production calls.
    const beforePause = await eventually(() => h.bridge.store.read(), state => {
      const a = state.attempts.find(item => item.taskId === taskId(manifest, "a1")), b = state.attempts.find(item => item.taskId === taskId(manifest, "b1"));
      const ra = state.tasks.find(item => item.taskId === taskId(manifest, "a1")), rb = state.tasks.find(item => item.taskId === taskId(manifest, "b1"));
      return a?.phase === "running" && b?.phase === "running" && ra?.phase === "running" && rb?.phase === "running";
    }, "scheduler-acknowledged running barrier");
    const beforePauseAt = Date.now(), beforeA = beforePause.tasks.find(item => item.taskId === taskId(manifest, "a1"))!, beforeB = beforePause.tasks.find(item => item.taskId === taskId(manifest, "b1"))!, beforeBReceipts = beforePause.results.filter(item => item.taskId === taskId(manifest, "b1"));
    assert.equal(beforeA.phase, "running"); assert.equal(beforeB.phase, "running"); assert.equal(beforeBReceipts.length, 0); assert.equal(beforeA.intent, "none");
    await h.bridge.control({ targetId: "feature-a", action: "pause" }); await eventually(() => h.bridge.store.read(), state => state.tasks.find(item => item.taskId === taskId(manifest, "a1"))?.intent === "pause", "public pause owner intent persisted");
    const pauseAt = Date.now(), paused = h.bridge.store.read(), a = paused.tasks.find(item => item.taskId === taskId(manifest, "a1"))!, b = paused.tasks.find(item => item.taskId === taskId(manifest, "b1"))!, pauseBReceipts = paused.results.filter(item => item.taskId === taskId(manifest, "b1")); assert.equal(a.intent, "pause"); assert.equal(a.phase, "running"); assert.equal(b.phase, "running"); assert.equal(pauseBReceipts.length, 0);
    writeGateEvidence(h, "ae8-public-pause", { before: { at: beforePauseAt, a: { phase: beforeA.phase, intent: beforeA.intent }, b: { phase: beforeB.phase, intent: beforeB.intent }, bReceipts: beforeBReceipts }, pause: { at: pauseAt, action: "pause", target: "feature-a", a: { phase: a.phase, intent: a.intent }, b: { phase: b.phase, intent: b.intent }, bReceipts: pauseBReceipts } });
    releasePause(h, "b"); await eventually(() => h.bridge.store.read(), state => state.tasks.find(item => item.taskId === taskId(manifest, "b1"))?.phase === "succeeded", "released B completion while A remains paused");
    const afterBAt = Date.now(), afterB = h.bridge.store.read(), afterBA = afterB.tasks.find(item => item.taskId === taskId(manifest, "a1"))!, afterBB = afterB.tasks.find(item => item.taskId === taskId(manifest, "b1"))!, afterBReceipts = afterB.results.filter(item => item.taskId === taskId(manifest, "b1")); assert.equal(afterBA.intent, "pause"); assert.equal(afterBA.phase, "running"); assert.equal(afterBB.phase, "succeeded"); assert.equal(afterBReceipts.length, 1);
    writeGateEvidence(h, "ae8-public-pause", { before: { at: beforePauseAt, a: { phase: beforeA.phase, intent: beforeA.intent }, b: { phase: beforeB.phase, intent: beforeB.intent }, bReceipts: beforeBReceipts }, pause: { at: pauseAt, action: "pause", target: "feature-a", a: { phase: a.phase, intent: a.intent }, b: { phase: b.phase, intent: b.intent }, bReceipts: pauseBReceipts }, afterB: { at: afterBAt, a: { phase: afterBA.phase, intent: afterBA.intent }, b: { phase: afterBB.phase, intent: afterBB.intent }, bReceipts: afterBReceipts.map(item => ({ digest: item.digest, taskId: item.taskId })) } });
    await h.bridge.control({ targetId: "feature-a", action: "resume" }); releasePause(h, "a"); await eventually(() => h.bridge.store.read(), state => state.tasks.find(item => item.taskId === taskId(manifest, "a1"))?.phase === "succeeded", "resumed A completion");
  } finally { releasePause(h, "a"); releasePause(h, "b"); await close(h); }
});

test("U8 AE8 supported child-status notification unfences the raced live child without manual reconcile", async () => {
  const h = makeHarness("late-ready");
  try {
    const manifest = await approved(h);
    // Deterministic ordering: the fixture withholds its running-artifact
    // publication (and therefore the readiness notification) long enough that the
    // scheduler's initial launch observation precedes the artifact and
    // conservatively fences the live attempts.
    const fenced = await eventually(() => h.bridge.store.read(), state => [taskId(manifest, "a1"), taskId(manifest, "b1")].every(id => {
      const attempt = state.attempts.find(item => item.taskId === id);
      return attempt?.phase === "recovery-needed" && /Run status\/owner artifact unavailable/.test(attempt.reason ?? "");
    }), "initial launch observation precedes artifact ready");
    // No reconcile call and no synthetic production call: after the fixture child
    // atomically publishes its running artifact it emits the supported
    // child-status readiness notification; the production runtime subscription
    // must wake the scheduler to reread the authoritative state and unfence the
    // still-live children on its own.
    const unfenced = await eventually(() => h.bridge.store.read(), state => [taskId(manifest, "a1"), taskId(manifest, "b1")].every(id => {
      const attempt = state.attempts.find(item => item.taskId === id), record = state.tasks.find(item => item.taskId === id);
      return attempt?.phase === "running" && !!attempt.run && record?.phase === "running" && record.intent === "none";
    }), "readiness notification unfences live children");
    writeGateEvidence(h, "ae8-child-status-unfence", { fenced: { a: fenced.attempts.find(item => item.taskId === taskId(manifest, "a1"))?.reason, b: fenced.attempts.find(item => item.taskId === taskId(manifest, "b1"))?.reason }, unfenced: { a: unfenced.attempts.find(item => item.taskId === taskId(manifest, "a1"))?.phase, b: unfenced.attempts.find(item => item.taskId === taskId(manifest, "b1"))?.phase }, manualReconcileCalls: 0 });
    release(h);
    await eventually(() => h.bridge.store.read(), state => state.attempts.every(a => a.phase === "succeeded"), "unfenced live children reach terminal");
  } finally { release(h); await close(h); }
});

test("U8 AE8 approved shared nondefault PR grouping creates one fenced obligation and reconciles persisted ack", async () => {
  const h = makeHarness("handoff"), controllerStatePath = join(h.root, "controller-state.json"), controllerCallsPath = join(h.provider.root, "controller-calls.jsonl"), gitMutationsPath = join(h.provider.root, "git-mutations.jsonl"); let handoffs = 0;
  type ControllerState = { view?: { pr: string; owner: { kind: "feature" | "execution" | "session"; id: string; generation: string }; worktree: string; head: string; state: "waiting_review" | "merged"; pendingCount: number }; acknowledgement?: { requestId: string; controllerId: string; obligationId: string; generation: string; acceptedAt: number } };
  const readControllerState = (): ControllerState => existsSync(controllerStatePath) ? JSON.parse(readFileSync(controllerStatePath, "utf8")) as ControllerState : {};
  const writeControllerState = (value: ControllerState) => writeFileSync(controllerStatePath, JSON.stringify(value));
  const controller = {
    handoff(request: any) {
      handoffs++;
      appendFileSync(controllerCallsPath, `${JSON.stringify({ action: "handoff", requestId: request.id, head: request.head, worktree: request.worktree })}\n`);
      writeControllerState({ view: { pr: "github.com/acme/e2e#7", owner: request.owner, worktree: request.worktree, head: "unacknowledged-controller-head", state: "waiting_review", pendingCount: 0 } });
      return { ok: true, state: "waiting_review" as const };
    },
    status() { const state = readControllerState(); return state.view ? [state.view] : []; },
  };
  const delivery = createControllerDeliveryAdapter({
    controller, controllerId: "e2e-controller",
    acknowledged: request => { const acknowledgement = readControllerState().acknowledgement; return acknowledgement?.requestId === request.id ? acknowledgement : undefined; },
    verifyMerge: async request => { const state = readControllerState(); return state.view?.state === "merged" ? { commit: request.head, url: `https://${request.pr.repo}/pull/${request.pr.number}`, observedAt: Date.now() } : undefined; },
  });
  const bridge = createExecutionBridge({ pi: h.pi, events: h.provider, repo: h.repo, referencePath: h.repoPath, stateRoot: h.stateRoot, sessionFile: h.sessionFile, processStart: "e2e-handoff", capacity: 6, ownedRoot: h.ownedRoot, repository: "github.com/acme/e2e", delivery, resolvePr: async () => ({ kind: "authorized", pr: { repo: "github.com/acme/e2e", number: 7 }, generation: "generation-e2e", ownerId: "shared-owner", ownerKind: "execution" }), interpretationTransport: createExecutionInterpreter({ events: h.provider, sessionFile: h.sessionFile }) });
  try {
    const first = await bridge.run(h.planPath); assert.equal(first.kind, "approval-required", JSON.stringify(first)); if (first.kind !== "approval-required") return; assert.equal(first.preview.manifest.deliveryGroups.length, 1); assert.equal(first.preview.manifest.deliveryGroups[0]!.id, "shared-review");
    const started = await bridge.run(h.planPath, { token: first.preview.token, capacity: 6, publication: true, publicationRepository: "github.com/acme/e2e", approvedBy: h.sessionFile, approvedAt: Date.now() }); assert.equal(started.kind, "started", JSON.stringify(started)); release(h);
    await eventually(() => bridge.store.read(), state => state.tasks.filter(t => t.phase === "succeeded").length === 6 && state.deliveries.some(d => d.groupId === "shared-review" && d.phase === "handoff-pending"), "persisted handoff before acknowledgement");
    assert.equal(handoffs, 1); assert.equal(bridge.store.read().deliveries[0]!.acknowledgement, undefined);
    const request = bridge.store.read().deliveries[0]!.handoff!; const deliveryHead = request.head; const persistedView = readControllerState().view!; const controllerCallsBefore = ledger(controllerCallsPath); const gitMutationsBefore = ledger(gitMutationsPath); assert.equal(controllerCallsBefore.length, 1); assert.ok(gitMutationsBefore.length > 0); writeControllerState({ ...readControllerState(), view: { ...persistedView, head: request.head }, acknowledgement: { requestId: request.id, controllerId: "e2e-controller", obligationId: digest([{ host: "github.com", owner: "acme", repo: "e2e", number: "7" }, persistedView.owner, persistedView.worktree, request.head]), generation: request.generation, acceptedAt: 1 } });
    h.provider.emit(PR_REVIEW_RECONCILED_EVENT, { pr: request.pr }); await eventually(() => bridge.store.read(), state => state.deliveries[0]!.phase === "controller-owned", "controller-reconciled persisted acknowledgement");
    const startsBeforeMerge = h.provider.events().filter(e => e.event === "start" && e.mode === "worker").length;
    writeControllerState({ ...readControllerState(), view: { ...readControllerState().view!, state: "merged" } }); h.provider.emit(PR_REVIEW_RECONCILED_EVENT, { pr: request.pr }); await eventually(() => bridge.store.read(), state => state.deliveries[0]!.phase === "merged", "verified merge after controller reconciliation");
    const actualRun = h.provider.events().find(e => e.event === "end" && e.taskId === "b1")!; h.provider.emit("subagent:async-complete", { runId: actualRun.runId, sessionId, mode: "single", success: true }); h.provider.emit(PR_REVIEW_RECONCILED_EVENT, { pr: request.pr }); h.provider.emit("subagent:async-complete", { runId: actualRun.runId, sessionId, mode: "single", success: true }); h.provider.emit(PR_REVIEW_RECONCILED_EVENT, { pr: request.pr }); await bridge.scheduler.reconcile(); assert.equal(handoffs, 1); assert.equal(ledger(controllerCallsPath).length, controllerCallsBefore.length); assert.deepEqual(ledger(gitMutationsPath), gitMutationsBefore); assert.equal(h.provider.events().filter(e => e.event === "start" && e.mode === "worker").length, startsBeforeMerge); assert.equal(bridge.store.read().deliveries.length, 1); assert.equal(bridge.store.read().deliveries[0]!.handoff!.head, deliveryHead); assert.equal(readControllerState().view!.head, deliveryHead); writeGateEvidence(h, "ae8-ledgers", { controllerCalls: ledger(controllerCallsPath).length, gitMutations: ledger(gitMutationsPath).length, deliveryHead, unchangedAfterDuplicateReorderedNotifications: true });
  } finally { release(h); retainHarnessEvidence(h); await bridge.shutdown(); await h.provider.dispose(); }
});

test("U8 AE9 selectable legacy preset executes review-TDD-QA roles in order and reaches delivery gate", async () => {
  const h = makeHarness("legacy");
  try {
    const legacy = createExecutionBridge({ pi: h.pi, events: h.provider, repo: h.repo, referencePath: h.repoPath, stateRoot: h.stateRoot, sessionFile: h.sessionFile, processStart: "e2e-legacy", capacity: 1, ownedRoot: h.ownedRoot, preset: "legacy", legacy: { policy: "local", profiles: { "feature-qa": { model: "e2e-model" } } }, interpretationTransport: async () => { throw new Error("legacy must not call plan interpreter"); } });
    const source = realpathSync(new URL("./fixtures/execution/import/legacy.md", import.meta.url).pathname), preview = await legacy.run(source); assert.equal(preview.kind, "approval-required", JSON.stringify(preview)); if (preview.kind !== "approval-required") return; assert.equal(preview.preview.manifest.preset, "legacy"); assert.deepEqual(preview.preview.manifest.tasks.map(t => t.profile.agent), ["plan-reviewer", "tdd-worker", "tdd-worker", "feature-qa"]); assert.deepEqual(preview.preview.manifest.tasks.slice(1).map(t => t.dependencies.length), [1, 1, 1]); assert.equal(preview.preview.manifest.constraints.capacity, 1); assert.equal(preview.preview.manifest.deliveryGroups[0]!.completion, "validated");
    const started = await legacy.run(source, { token: preview.preview.token, capacity: 1, publication: false, approvedBy: h.sessionFile, approvedAt: Date.now() }); assert.equal(started.kind, "started", JSON.stringify(started));
    await eventually(() => legacy.store.read(), state => state.tasks.filter(t => t.phase === "succeeded").length === 4 && state.deliveries[0]?.phase === "ready", "legacy review-TDD-QA delivery gate");
    const agents = h.provider.events().filter(e => e.event === "start" && e.mode === "worker").map(e => String(e.agent)); assert.deepEqual(agents, ["plan-reviewer", "tdd-worker", "tdd-worker", "feature-qa"]); const intervals = h.provider.events().filter(e => e.event === "start" && e.mode === "worker").map(start => ({ start: Number(start.at), end: Number(h.provider.events().find(end => end.event === "end" && end.runId === start.runId)?.at ?? 0) })); assert.ok(intervals.every((item, index) => index === 0 || item.start >= intervals[index - 1]!.end), JSON.stringify(intervals));
  } finally { await close(h); }
});

export { manifestFor, makeHarness };
