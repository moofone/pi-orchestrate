import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createExecutionBridge } from "../../../../src/lib/execution-bridge.ts";
import { digest, sourceDigest, stableTaskId } from "../../../../src/lib/execution-contract.ts";

const args = process.argv.slice(2);
const [stateRoot, commonDir, sessionFile] = args;
if (args.length < 8) {
  const { createCoordinatorOwner, createExecutionStore } = await import("../../../../src/lib/execution-store.ts");
  const repo = { commonDir, id: digest(commonDir) };
  const store = createExecutionStore({ stateRoot, repo });
  const owner = store.acquire(createCoordinatorOwner(sessionFile, `e2e-crash-${process.pid}`));
  store.markReconciled(owner);
  process.stdout.write(`${process.pid}\n`);
  setInterval(() => {}, 1_000).unref();
} else {
  const [, , , referencePath, ownedRoot, planPath, providerRoot, mode] = args;
  const resume = mode.startsWith("resume");
  const scenario = resume ? mode.slice("resume-".length) : mode;
  const sessionId = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]).id;
  const repo = { commonDir, id: digest(commonDir) };
  mkdirSync(providerRoot, { recursive: true }); mkdirSync(join(providerRoot, "runs"), { recursive: true });
  const eventListeners = new Map();
  const processes = new Map();
  const appendJson = (name, value) => appendFileSync(join(providerRoot, name), `${JSON.stringify(value)}\n`);
  const readJson = name => existsSync(join(providerRoot, name)) ? JSON.parse(readFileSync(join(providerRoot, name), "utf8")) : {};
  const writeJson = (name, value) => writeFileSync(join(providerRoot, name), JSON.stringify(value));
  const waitFor = async path => { while (!existsSync(path)) await new Promise(resolve => setTimeout(resolve, 5)); };
  const checkpoint = async (name, details = {}) => {
    writeJson(`checkpoint-${name}.json`, { name, pid: process.pid, at: Date.now(), ...details });
    process.stdout.write(`CHECKPOINT ${name}\n`);
    await waitFor(join(providerRoot, `release-${name}`));
  };
  const reply = (request, success, data, error) => emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, method: request.method, success, ...(success ? { data } : { error }) });
  const emit = (name, data) => { for (const listener of eventListeners.get(name) ?? []) listener(data); if (name === "subagents:rpc:v1:request") void rpc(data); };
  const rpc = async request => {
    const method = String(request.method ?? "");
    if (method === "ping") { reply(request, true, { version: 1, methods: ["spawn", "status", "stop"], capabilities: { asyncSpawn: true, stop: true }, session: { sessionId, sessionFile } }); return; }
    if (method === "status") { reply(request, true, { state: "known" }); return; }
    if (method === "stop") { const runId = String(request.params?.runId ?? ""); processes.get(runId)?.kill("SIGTERM"); reply(request, true, { runId, asyncDir: join(providerRoot, "runs", runId), state: "stopping" }); return; }
    if (method !== "spawn") { reply(request, false, undefined, { code: "unsupported_method", message: method }); return; }
    const params = request.params ?? {}, runId = `crash-run-${(readJson("run-counter.json").next ?? 1)}`;
    writeJson("run-counter.json", { next: Number(runId.split("-").at(-1)) + 1 });
    appendJson("rpc-events.jsonl", { event: "spawn", runId, pid: process.pid, at: Date.now() });
    const artifactDir = join(providerRoot, "runs", runId), configPath = join(providerRoot, `${runId}.json`);
    const taskId = /TASK_ID:\s*([A-Za-z0-9._-]+)/.exec(String(params.task ?? ""))?.[1] ?? "recovery";
    mkdirSync(artifactDir, { recursive: true }); writeFileSync(configPath, JSON.stringify({ mode: "worker", runId, sessionId, artifactDir, eventsPath: join(providerRoot, "children.jsonl"), taskId, agent: params.agent }));
    if (scenario === "launch") { await checkpoint("launch-intent-before-rpc", { runId, taskId }); }
    const childPath = new URL("./fake-child.mjs", import.meta.url).pathname;
    const child = spawn(process.execPath, [childPath, configPath], { cwd: String(params.cwd), env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "ignore", "pipe"] });
    processes.set(runId, child);
    child.stderr?.on("data", value => appendFileSync(join(artifactDir, "stderr.log"), String(value)));
    child.on("close", (code, signal) => {
      processes.delete(runId);
      const resultPath = join(artifactDir, "result.json"); let result;
      try { result = JSON.parse(readFileSync(resultPath, "utf8")); } catch {}
      const finish = () => {
        emit("subagent:process-terminal", { runId, sessionId });
        emit("subagent:async-complete", { runId, sessionId, mode: "single", success: code === 0 && !signal, results: [{ ...(result === undefined ? {} : { structuredOutput: result }) }], ...(signal ? { interrupted: true } : {}) });
      };
      if (scenario === "terminal") void checkpoint("terminal-before-receipt", { runId, taskId }).then(finish); else finish();
    });
    if (scenario !== "launch") reply(request, true, { details: { mode: "single", runId, asyncDir: artifactDir } });
  };
  const events = { on(name, listener) { const listeners = eventListeners.get(name) ?? new Set(); listeners.add(listener); eventListeners.set(name, listeners); return () => listeners.delete(listener); }, emit };
  const runGit = (cwd, argv) => new Promise(resolve => {
    const helper = argv[0] === "wt", executable = helper ? "/Users/greg/.local/bin/ghl-wt" : "git", actual = helper ? argv.slice(1) : argv;
    execFile(executable, actual, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Crash owner", GIT_AUTHOR_EMAIL: "crash-owner@example.test", GIT_COMMITTER_NAME: "Crash owner", GIT_COMMITTER_EMAIL: "crash-owner@example.test" } }, (error, stdout, stderr) => {
      appendJson("git-commands.jsonl", { cwd, argv, code: error ? (typeof error.code === "number" ? error.code : -1) : 0, at: Date.now() }); resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
  const source = { path: planPath, bytes: readFileSync(planPath, "utf8"), digest: sourceDigest(readFileSync(planPath, "utf8")) };
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: referencePath, encoding: "utf8" }).trim();
  const taskId = stableTaskId(`crash-${digest(source.path)}`, "recovery"), featureId = "crash-feature", groupId = "crash-group";
  const check = { id: "crash-integration-check", cwd: ".", argv: ["node", "--test", "test/check.mjs"], runner: "command", expectedEvidence: { requiredTests: [], rationale: "crash boundary fixture" } };
  const manifest = {
    schemaVersion: 1, id: `crash-${digest(source.path)}`, revision: 1, source, repo, baseCommit, scope: "src/", preset: "plan-driven",
    features: [{ id: featureId, title: "Crash feature", scope: "src/" }],
    deliveryGroups: [{ id: groupId, featureIds: [featureId], requiredTaskIds: [taskId], checks: scenario === "integration" ? [check] : [], policy: scenario === "controller" ? "pr" : "local", completion: scenario === "controller" ? "merged" : "validated", ownerId: featureId }],
    tasks: [{ id: taskId, featureId, deliveryGroupId: groupId, text: "TASK_ID: recovery\nRun the crash-boundary worker.", mode: "mutation", dependencies: [], scope: ["src/"], profile: { agent: "child-worker" }, checks: [], provenance: ["text", "mode", "scope", "profile", "deliveryGroupId", "dependencies"].map(field => ({ field, origin: "inferred", reason: "crash boundary fixture" })) }],
    constraints: { capacity: 1, parallelGroups: [], provenance: [{ field: "capacity", origin: "inferred", reason: "crash boundary fixture" }] }, provenance: ["scope", "features", "deliveryGroups"].map(field => ({ field, origin: "inferred", reason: "crash boundary fixture" })),
  };
  const lockPath = join(stateRoot, "plan-driven-v1", "execution", repo.id, "transaction.lock");
  const controllerPath = join(providerRoot, "controller-state.json");
  const controllerState = () => existsSync(controllerPath) ? JSON.parse(readFileSync(controllerPath, "utf8")) : {};
  const controller = {
    handoff(request) { const pr = { host: "github.com", owner: "acme", repo: "e2e", number: "7" }; const ack = { requestId: "", controllerId: "crash-controller", obligationId: digest([pr, request.owner, request.worktree, request.head]), generation: request.owner.generation, acceptedAt: Date.now() }; writeJson("controller-state.json", { view: { pr: "github.com/acme/e2e#7", owner: request.owner, worktree: request.worktree, head: request.head, state: "waiting_review", pendingCount: 0 }, acknowledgement: ack }); return { ok: true, state: "waiting_review" }; },
    status() { const value = controllerState(); return value.view ? [value.view] : []; },
  };
  const delivery = scenario === "controller" ? {
    handoff: async request => { const value = controllerState(); value.view ??= { pr: request.pr.repo + "#" + request.pr.number, owner: { kind: request.ownerKind ?? "execution", id: request.ownerId, generation: request.generation }, worktree: request.workspace.path, head: request.head, state: "waiting_review", pendingCount: 0 }; value.acknowledgement ??= { requestId: request.id, controllerId: "crash-controller", obligationId: digest([request.pr, value.view.owner, value.view.worktree, request.head]), generation: request.generation, acceptedAt: Date.now() }; value.acknowledgement.requestId = request.id; writeJson("controller-state.json", value); if (!resume) { if (mode === "controller") await checkpoint("controller-persist-before-local-ack", { requestId: request.id, lockExists: existsSync(lockPath) }); } return { kind: "accepted", acknowledgement: value.acknowledgement }; },
    observe: async request => { const value = controllerState(); return value.acknowledgement ? { kind: "accepted", acknowledgement: value.acknowledgement } : { kind: "unknown", reason: "Controller acknowledgement unavailable" }; },
  } : undefined;
  const checks = scenario === "integration" ? {
    async execute(spec, context) { if (mode === "integration") await checkpoint("git-mutation-before-integration-receipt", { invocationId: context.invocationId, workspace: context.workspace.path }); return { checkId: spec.id, invocationId: context.invocationId, startedAt: context.startedAt, finishedAt: context.startedAt + 1, exitCode: 0, executedTests: [], skippedTests: [], status: "passed", reason: "crash boundary fixture" }; },
    validateEvidence() { return { valid: true, reasons: [] }; },
  } : undefined;
  const bridge = createExecutionBridge({ pi: { exec: async (file, argv, options) => { const result = await runGit(options.cwd, argv); return { code: result.code, stdout: result.stdout, stderr: result.stderr }; } }, events, repo, referencePath, stateRoot, sessionFile, processStart: "crash-owner-fixed-identity", capacity: 1, ownedRoot, baseCommit, ...(delivery ? { repository: "github.com/acme/e2e", delivery, resolvePr: async () => ({ kind: "authorized", pr: { repo: "github.com/acme/e2e", number: 7 }, generation: "crash-generation", ownerId: featureId, ownerKind: "execution" }) } : {}), ...(checks ? { checks } : {}), interpretationTransport: async request => ({ manifest: { ...manifest, id: request.identity.id, revision: request.identity.revision, repo: request.identity.repo, baseCommit: request.identity.baseCommit, source: request.source }, unresolvedDecisions: [] }) });
  if (resume) {
    await bridge.start({ resumePriorOwner: true }); writeJson("resume-ready.json", { pid: process.pid, at: Date.now() }); process.stdout.write(`OWNER_READY ${process.pid}\n`);
    let lateSent = false;
    while (!existsSync(join(providerRoot, "stop"))) {
      if (!lateSent && existsSync(join(providerRoot, "late-old-callback"))) { lateSent = true; emit("subagent:async-complete", { runId: "crash-run-1", sessionId, mode: "single", success: true }); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await bridge.shutdown(); process.exit(0);
  }
  const first = await bridge.run(planPath); if (first.kind !== "approval-required") throw new Error(JSON.stringify(first)); const started = await bridge.run(planPath, { token: first.preview.token, capacity: 1, publication: scenario === "controller", ...(scenario === "controller" ? { publicationRepository: "github.com/acme/e2e" } : {}), approvedBy: sessionFile, approvedAt: Date.now() }); if (started.kind !== "started") throw new Error(JSON.stringify(started));
  process.stdout.write(`OWNER_READY ${process.pid}\n`); await waitFor(join(providerRoot, "stop")); await bridge.shutdown(); process.exit(0);
}
