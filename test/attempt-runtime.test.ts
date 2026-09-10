import test from "node:test";
import assert from "node:assert/strict";
import { createAttemptRuntime, decodeRuntimeStatus, type RuntimeEventBus } from "../src/lib/attempt-runtime.ts";
import { fakeAttempt, fakeAuthorization, fakeManifest } from "./fixtures/execution/fakes.ts";
import type { LaunchRequest } from "../src/lib/execution-contract.ts";
class Bus implements RuntimeEventBus {
 listeners = new Map<string, Set<(value: unknown) => void>>();
 on(name: string, listener: (value: unknown) => void) { const set = this.listeners.get(name) ?? new Set(); set.add(listener); this.listeners.set(name, set); return () => { set.delete(listener); }; }
 emit(name: string, value: unknown) { for (const listener of this.listeners.get(name) ?? []) listener(value); }
}
const run = { runId: "run-1", artifactDir: "/fixture/run-1", ownerSessionFile: "/fixture/session.jsonl" };
function status(state = "complete") { return { lifecycleArtifactVersion: 3, runId: run.runId, sessionId: "owner", mode: "single", state, startedAt: 1, ...(state === "running" ? {} : { endedAt: 2 }), steps: [{ status: state }], processTerminal: { version: 1, runId: run.runId, runnerProcessInstanceId: "process", state: "observed", observedAt: 2, instances: [{ kind: "runner", processInstanceId: "process", closeObservedAt: 2, exitCode: 0, signal: null }] } }; }
function setup(config: { durable?: boolean; lost?: boolean; error?: string; state?: string; missing?: boolean; capacity?: number; budget?: number; lookupKnown?: boolean } = {}) {
 const events = new Bus(), calls: { method: string; params: Record<string, unknown> }[] = [];
 events.on("subagents:rpc:v1:request", raw => {
  const request = raw as { requestId: string; method: string; params: Record<string, unknown> }; calls.push(request);
  let data: unknown;
  if (request.method === "ping") data = { version: 1, methods: ["spawn", "status", "stop", ...(config.durable ? ["lookup"] : [])], capabilities: { asyncSpawn: true, stop: true, ...(config.durable ? { durableSpawn: { version: 1, lookup: true } } : {}) }, session: { sessionFile: run.ownerSessionFile, sessionId: "owner" } };
  if (request.method === "spawn") {
   events.emit("subagent:async-complete", { runId: run.runId });
   if (config.lost) return;
   if (config.error) { events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, method: request.method, success: false, error: { code: config.error, message: "rejected" } }); return; }
   data = { details: { mode: "single", runId: run.runId, asyncId: run.runId, asyncDir: run.artifactDir } };
  }
  if (request.method === "lookup") data = config.lookupKnown ? { state: "known", reply: { details: { mode: "single", runId: run.runId, asyncId: run.runId, asyncDir: run.artifactDir } } } : { state: "unknown" };
  if (request.method === "stop") data = { runId: run.runId, asyncDir: run.artifactDir, state: "stopping" };
  events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, method: request.method, success: true, data });
 });
 const runtime = createAttemptRuntime({ events, sessionFile: run.ownerSessionFile, capacity: config.capacity ?? 6, remainingBudget: config.budget, timeoutMs: 5, sessionId: async () => "owner", readText: async () => { if (config.missing) throw new Error("gone"); return JSON.stringify(status(config.state)); }, now: () => 10 });
 const manifest = fakeManifest(); const request: LaunchRequest = { attempt: fakeAttempt(manifest), task: manifest.tasks[0]!, authorization: fakeAuthorization(manifest), profile: { agent: "worker", context: "fork" } };
 return { runtime, events, calls, request };
}
test("attempt-runtime catches completion-before-ack, uses single detached child, and deduplicates launches", async () => {
 const { runtime, events, calls, request } = setup(); let wakes = 0; runtime.subscribe(() => { wakes++; });
 const [a, b] = await Promise.all([runtime.launch(request), runtime.launch(request)]);
 assert.equal(a.kind, "known-terminal"); assert.deepEqual(a, b); assert.equal(wakes, 1);
 const launches = calls.filter(c => c.method === "spawn"); assert.equal(launches.length, 1);
 assert.deepEqual(launches[0]!.params, { agent: "worker", task: request.task.text, cwd: request.attempt.workspace.path, async: true, worktree: false, context: "fork" });
 events.emit("subagent:async-complete", { runId: "foreign" }); events.emit("subagent:async-complete", { runId: run.runId });
 assert.equal((await runtime.observe({ ...request.attempt, run })).kind, "known-terminal");
 runtime.dispose(); assert.ok([...events.listeners.values()].every(set => set.size === 0 || set === events.listeners.get("subagents:rpc:v1:request")));
});
test("attempt-runtime lost reply and execution_failed remain unknown; invalid params are definitive", async () => {
 for (const [config, expected] of [[{ lost: true }, "unknown"], [{ error: "execution_failed" }, "unknown"], [{ error: "invalid_params" }, "rejected-before-start"], [{ capacity: 0 }, "capacity-deferred"], [{ budget: 0 }, "rejected-before-start"]] as const) {
  const { runtime, request } = setup(config); assert.equal((await runtime.launch(request)).kind, expected); runtime.dispose();
 }
});
test("attempt-runtime negotiates durable lookup, unknown lookup never proves nonlaunch", async () => {
 for (const durable of [false, true]) {
  const { runtime, request, calls } = setup({ durable }); request.attempt.operationId = "operation-123456789";
  assert.equal((await runtime.lookupOperation!(request.attempt.operationId, run.ownerSessionFile)).kind, "unknown");
  assert.equal(calls.some(c => c.method === "lookup"), durable);
  await runtime.launch(request); assert.equal(calls.find(c => c.method === "spawn")!.params.operationId, durable ? request.attempt.operationId : undefined); runtime.dispose();
 }
});
test("attempt-runtime foreign controls are forbidden and stop acknowledgement is not terminal", async () => {
 const { runtime, request, calls } = setup({ state: "running" });
 assert.equal((await runtime.control(run, "stop", "/foreign")).kind, "forbidden"); assert.equal(calls.length, 0);
 assert.equal((await runtime.control(run, "stop", run.ownerSessionFile)).kind, "acknowledged");
 assert.equal((await runtime.observe({ ...request.attempt, run })).kind, "known-running");
 assert.equal((await runtime.control(run, "resume", run.ownerSessionFile)).kind, "unsupported"); runtime.dispose();
});
test("attempt-runtime refuses unsupported profile and foreign launch before spawn", async () => {
 const { runtime, request, calls } = setup(); request.profile.tools = ["read"];
 assert.equal((await runtime.launch(request)).kind, "rejected-before-start"); assert.ok(!calls.some(c => c.method === "spawn")); runtime.dispose();
 const other = setup(); other.request.attempt.ownerSessionFile = "/foreign"; assert.equal((await other.runtime.launch(other.request)).kind, "rejected-before-start"); other.runtime.dispose();
});
test("attempt-runtime exact version, owner, run and terminal evidence are required", () => {
 for (const patch of [{ lifecycleArtifactVersion: 99 }, { sessionId: "foreign" }, { runId: "wrong" }, { processTerminal: { state: "pending" } }, { steps: [] }, { state: "stopping" }]) assert.equal(decodeRuntimeStatus(JSON.stringify({ ...status(), ...patch }), run, "owner", 10).kind, "unknown");
 assert.equal(decodeRuntimeStatus("garbage", run, "owner", 10).kind, "unknown");
 assert.equal(decodeRuntimeStatus(JSON.stringify(status("failed")), run, "owner", 10).kind, "known-terminal");
});

test("attempt-runtime missing artifacts and unsupported lifecycle versions remain fenced", async () => {
 const { runtime, request } = setup({ missing: true });
 const ack = await runtime.launch(request); assert.equal(ack.kind, "known-running");
 assert.equal((await runtime.observe({ ...request.attempt, run })).kind, "unknown"); runtime.dispose();
 for (const lifecycleArtifactVersion of [undefined, 1, 2, 4]) assert.equal(decodeRuntimeStatus(JSON.stringify({ ...status(), lifecycleArtifactVersion }), run, "owner", 10).kind, "unknown");
 assert.equal(decodeRuntimeStatus(JSON.stringify({ ...status(), processTerminal: { ...status().processTerminal, instances: [{}] } }), run, "owner", 10).kind, "unknown");
});
test("attempt-runtime injected verified profile mapping retains narrow tools and communication", async () => {
 const base = setup(); base.runtime.dispose();
 const runtime = createAttemptRuntime({ events: base.events, sessionFile: run.ownerSessionFile, capacity: 6, sessionId: async () => "owner", readText: async () => JSON.stringify(status()), now: () => 10,
  callerTools: ["read"], profileEncoder: { keys: ["tools", "supervisor", "intercom"], encode: profile => ({ tools: profile.tools, supervisor: profile.supervisor, intercomBridge: { mode: profile.intercom ? "auto" : "off" } }) } });
 base.request.profile = { agent: "worker", context: "fresh", tools: ["read"], supervisor: true, intercom: true };
 assert.equal((await runtime.launch(base.request)).kind, "known-terminal");
 const params = base.calls.find(call => call.method === "spawn")!.params;
 assert.deepEqual(params.tools, ["read"]); assert.equal(params.supervisor, true); assert.equal(params.context, "fresh"); runtime.dispose();
});

test("attempt-runtime recovers advertised durable reply without another launch", async () => {
 const { runtime, calls } = setup({ durable: true, lookupKnown: true });
 const result = await runtime.lookupOperation!("operation-123456789", run.ownerSessionFile);
 assert.equal(result.kind, "known-terminal"); if (result.kind === "known-terminal") assert.equal(result.evidence.run.operationId, "operation-123456789");
 assert.ok(!calls.some(call => call.method === "spawn")); runtime.dispose();
});
