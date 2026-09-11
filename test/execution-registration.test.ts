import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { digest } from "../src/lib/execution-contract.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { InterpretationRequest } from "../src/lib/plan-import.ts";
import type { ExecutionManifest } from "../src/lib/execution-contract.ts";

// Each node:test file runs in its own process; sandbox every legacy/default path
// before loading the real extension. No live user configuration or provider calls.
const home = realpathSync(mkdtempSync(join(tmpdir(), "execution-registration-")));
process.env.HOME = home;
const { default: register } = await import("../src/orchestrate.ts");
function manifest(request: InterpretationRequest): ExecutionManifest {
 const provenance = (fields: string[]) => fields.map(field => ({ field, origin: "inferred" as const, reason: "fixture choice" }));
 return { schemaVersion: 1, ...request.identity, source: request.source, scope: "fixture", preset: "plan-driven",
 features: [{ id: "arbitrary-feature", title: "Visible feature", scope: "src" }],
 deliveryGroups: [{ id: "shared-group", featureIds: ["arbitrary-feature"], requiredTaskIds: ["work"], checks: [], policy: "local", completion: "validated", ownerId: "arbitrary-feature" }],
 tasks: [{ id: "work", featureId: "arbitrary-feature", deliveryGroupId: "shared-group", text: "Visible task", mode: "mutation", dependencies: [], scope: ["src"], profile: { agent: "custom-engineer" }, checks: [], provenance: provenance(["text", "mode", "dependencies", "scope", "profile", "deliveryGroupId"]) }],
 constraints: { capacity: 1, parallelGroups: [], provenance: provenance(["capacity"]) }, provenance: provenance(["scope", "features", "deliveryGroups"]) };
}
function harness(early = true, approve = false) {
 const root = join(home, `repo-${Math.random().toString(16).slice(2)}`); mkdirSync(root); mkdirSync(join(root, ".git"));
 const sessionFile = join(root, "parent.jsonl"), plan = join(root, "plan.md");
 writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "parent" }) + "\n"); writeFileSync(plan, "# Ordinary plan\n");
 const listeners = new Map<string, Set<(data: any) => void>>();
 const handlers = new Map<string, (event: any, ctx: any) => any>();
 const commands = new Map<string, any>(); const notifications: string[] = [], confirmations: string[] = [], spawns: Record<string, unknown>[] = [], execs: string[][] = [];
 let interpret = 0;
 const events = {
  on(name: string, listener: (data: any) => void) { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); return () => { set.delete(listener); }; },
  emit(name: string, data: any) {
   for (const listener of listeners.get(name) ?? []) listener(data);
   if (name !== "subagents:rpc:v1:request") return;
   const reply = (value: unknown) => events.emit(`subagents:rpc:v1:reply:${data.requestId}`, { version: 1, requestId: data.requestId, method: data.method, success: true, data: value });
   if (data.method === "ping") { reply({ version: 1, methods: ["spawn", "status", "stop"], capabilities: { asyncSpawn: true, stop: true }, session: { sessionId: "parent", sessionFile } }); return; }
   if (data.method === "spawn") {
    spawns.push(data.params); const runId = `interpret-${++interpret}`;
    const task = String(data.params.task), identity = JSON.parse(task.match(/Required identity: (.*)/)![1]!);
    const output = { manifest: manifest({ identity, source: identity.source } as InterpretationRequest), unresolvedDecisions: [] };
    const completion = { runId, sessionId: "parent", mode: "single", success: true, results: [{ structuredOutput: output }], summary: "ordinary text is not JSON" };
    if (early) events.emit("subagent:async-complete", completion);
    reply({ details: { runId, mode: "single", asyncDir: join(root, runId) } });
    if (!early) queueMicrotask(() => events.emit("subagent:async-complete", completion));
    return;
   }
   throw new Error(`Unexpected RPC: ${data.method}`);
  },
 };
 const pi = {
  events, on(name: string, handler: any) { assert.equal(handlers.has(name), false, `duplicate handler ${name}`); handlers.set(name, handler); },
  registerCommand(name: string, command: any) { commands.set(name, command); },
  registerEntryRenderer() {}, registerMarkdownTransformer() {}, sendMessage() {},
  async exec(file: string, args: string[]) { execs.push([file, ...args]); assert.equal(file, "git", `Unexpected remote/process boundary: ${file}`);
   if (args.includes("--show-toplevel")) return { code: 0, stdout: root, stderr: "" };
   if (args.includes("--git-common-dir")) return { code: 0, stdout: join(root, ".git"), stderr: "" };
   if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
   if (args[0] === "rev-parse") return { code: 0, stdout: "a".repeat(40), stderr: "" };
   throw new Error(`Unexpected Git: ${args.join(" ")}`);
  },
 };
 const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "parent" },
 ui: { notify: (text: string) => notifications.push(text), confirm: async (_title: string, body: string) => { confirmations.push(body); return approve; } } };
 register(pi as unknown as ExtensionAPI);
 return { root, plan, sessionFile, ctx, pi, events, handlers, commands, notifications, confirmations, spawns, execs,
  command: (text: string) => commands.get("orchestrate").handler(text, ctx as unknown as ExtensionCommandContext),
  shutdown: () => handlers.get("session_shutdown")!({}, ctx),
 };
}
function seedCrashedOwner(h: ReturnType<typeof harness>): number {
 const storeModule = new URL("../src/lib/execution-store.ts", import.meta.url).pathname;
 const contractModule = new URL("../src/lib/execution-contract.ts", import.meta.url).pathname;
 const fakesModule = new URL("./fixtures/execution/fakes.ts", import.meta.url).pathname;
 const script = `
  const { createExecutionStore, createCoordinatorOwner } = await import(${JSON.stringify(storeModule)});
  const { digest } = await import(${JSON.stringify(contractModule)});
  const { fakeManifest, fakeAuthorization, fakeAttempt, fakeReservation, admitFakeManifest } = await import(${JSON.stringify(fakesModule)});
  const root = process.argv[1], commonDir = process.argv[2], sessionFile = process.argv[3];
  const repo = { commonDir, id: digest(commonDir) }, store = createExecutionStore({ stateRoot: root, repo });
  const manifest = fakeManifest(); manifest.repo = repo;
  const owner = store.acquire(createCoordinatorOwner(sessionFile, "crashed-process"));
  store.markReconciled(owner);
  store.transact(owner, state => {
   state.capacity = 1; admitFakeManifest(state, manifest);
   const attempt = fakeAttempt(manifest); attempt.ownerSessionFile = sessionFile; attempt.operationId = attempt.id;
   attempt.workspace = { ...attempt.workspace, path: root + "/workspace" }; attempt.phase = "preparing";
   state.attempts.push(attempt); state.reservations.push({ ...fakeReservation(attempt), workspaceId: attempt.workspace.id, workspacePath: attempt.workspace.path });
   state.tasks[0].attemptIds = [attempt.id]; state.tasks[0].phase = "preparing";
  });
  console.log(process.pid);
 `;
 const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, join(home, "orchestrator", "plan-driven-v1"), join(h.root, ".git"), h.sessionFile], { encoding: "utf8" });
 return Number(output.trim());
}
for (const early of [true, false]) test(`registered command accepts structured-only interpretation (early=${early}) without profile pins or coordinator lease`, async () => {
 const h = harness(early);
 try {
  await h.command(`run "${h.plan}"`);
  assert.equal(h.confirmations.length, 1, h.notifications.join("\n"));
  assert.match(h.confirmations[0]!, /Visible task/); assert.match(h.confirmations[0]!, /custom-engineer/);
  assert.match(h.confirmations[0]!, /inferred/); assert.match(h.confirmations[0]!, /shared-group/);
  assert.equal(h.spawns.length, 1);
  for (const pin of ["model", "context", "tools", "intercomBridge", "turnBudget"]) assert.equal(pin in h.spawns[0]!, false, pin);
  await h.command("execution status");
  assert.match(h.notifications.at(-1)!, /epoch=0/);
 } finally { await h.shutdown(); }
});
test("registered lifecycle recovers first-crash active work for the same canonical session", async () => {
 const h = harness(true, true); const crashedPid = seedCrashedOwner(h);
 const statePath = join(home, "orchestrator", "plan-driven-v1", "execution", digest(join(h.root, ".git")), "coordinator.json");
 const crashed = JSON.parse(readFileSync(statePath, "utf8"));
 assert.equal(crashed.lastOwner, undefined, "the crash fixture must not prepopulate clean-relinquishment history");
 assert.equal(crashed.owner?.pid, crashedPid);
 await h.handlers.get("session_start")!({}, h.ctx);
 await new Promise(resolve => setTimeout(resolve, 100));
 const state = JSON.parse(await (await import("node:fs/promises")).readFile(statePath, "utf8"));
 assert.equal(state.owner?.sessionFile, realpathSync(h.sessionFile), "the first-crash owner session must reacquire durable active work");
 assert.notEqual(state.owner?.pid, crashedPid, "startup must replace the terminated owner lease");
 assert.ok(state.owner?.epoch > 1, "startup must advance the crash-recovery epoch");
 assert.equal(state.attempts[0]?.phase, "recovery-needed", "the real bridge scheduler must recover the persisted preparation");
 assert.ok(state.reconciledEpoch === state.owner?.epoch, "startup must complete phase-A reconciliation");
 await h.shutdown();
});

test("registered lifecycle resumes prior owning session after clean shutdown without another command", async () => {
 const h = harness(true, true);
 await h.command(`run "${h.plan}"`);
 await new Promise(resolve => setTimeout(resolve, 40));
 await h.shutdown();
 await h.handlers.get("session_start")!({}, h.ctx);
 await new Promise(resolve => setTimeout(resolve, 40));
 const statePath = join(home, "orchestrator", "plan-driven-v1", "execution", digest(join(h.root, ".git")), "coordinator.json");
 const state = JSON.parse(await (await import("node:fs/promises")).readFile(statePath, "utf8"));
 assert.equal(state.owner?.sessionFile, realpathSync(h.sessionFile), "the prior owner session must reacquire durable active work");
 await h.shutdown();
});

test("registered lifecycle fences initialization resolved after shutdown without acquiring a lease", async () => {
 const h = harness(); let release!: () => void, entered!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
 const exec = h.pi.exec;
 h.pi.exec = async (file, args) => { if (args.includes("--git-common-dir")) { entered(); await gate; } return exec(file, args); };
 const startup = h.handlers.get("session_start")!({}, h.ctx);
 await waiting;
 const shutdown = h.shutdown(); release();
 await Promise.all([startup, shutdown]);
 // Allow callbacks queued by the old fire-and-forget initializer to expose themselves.
 await new Promise(resolve => setTimeout(resolve, 20));
 const statePath = join(home, "orchestrator", "plan-driven-v1", "execution", digest(join(h.root, ".git")), "coordinator.json");
 assert.equal(existsSync(statePath), false, "observation/late startup must not acquire coordinator ownership");
 await h.command("execution status"); assert.match(h.notifications.at(-1)!, /shut down|cancelled/i);
});
export { harness };
