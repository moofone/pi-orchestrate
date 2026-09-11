import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { digest, taskRevisionDigest, validateTerminalOutput, type AttemptRuntime, type ExecutionProfile, type LaunchOutcome, type LaunchRequest, type Observation, type RunRef, type RuntimeCapabilities } from "./execution-contract.ts";
import { resolveExecutionProfile } from "./execution-policy.ts";
import { createExecutionIdentityBinding } from "./execution-identity.ts";

/** Structurally compatible with ExtensionAPI.events. No private runtime imports. */
export type RuntimeEventBus = { on(name: string, listener: (data: unknown) => void): () => void; emit(name: string, data: unknown): void };
export type AttemptRuntimeOptions = {
 events: RuntimeEventBus; sessionFile: string;
 /** Configured admission observation, not a reservation or a grant from ping. */
 capacity: number; remainingBudget?: number; callerTools?: string[]; callerAgents?: string[];
 readText?: (path: string) => Promise<string>; now?: () => number; timeoutMs?: number;
 /** Canonical parent session header identity; defaults to the persisted session header. */
 sessionId?: (sessionFile: string) => Promise<string>;
 /** Extra mappings require a verified installed public RPC profile contract. */
 profileEncoder?: { keys: (keyof ExecutionProfile)[]; encode(profile: ExecutionProfile): Record<string, unknown> };
};
type RecordData = Record<string, unknown>;
function record(value: unknown): RecordData { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordData : {}; }
const unknown = (reason: string): { kind: "unknown"; reason: string } => ({ kind: "unknown", reason });
const nativeKeys: (keyof ExecutionProfile)[] = ["agent", "model", "context", "timeoutMs", "thinking"];

/** Decodes lifecycle-v3 status.json (pi-subagents 42257fc, shared/types.ts and background/process-terminal.ts).
 * Older/unversioned evidence is deliberately fenced; completion events are not terminal proof.
 */
export function decodeRuntimeStatus(raw: string, run: RunRef, ownerSessionId: string, now: number): Observation {
 try {
  const status = record(JSON.parse(raw));
  if (status.lifecycleArtifactVersion !== 3 || status.runId !== run.runId || status.sessionId !== ownerSessionId || !ownerSessionId || status.mode !== "single") return unknown("Incompatible status version, mode, run, or owner");
  if (["queued", "running", "paused"].includes(String(status.state)) && status.endedAt === undefined) return { kind: "known-running", run };
  const proof = record(status.processTerminal);
  if (proof.version !== 1 || proof.runId !== run.runId || proof.state !== "observed" || !Array.isArray(proof.instances) || proof.instances.length === 0 || typeof proof.observedAt !== "number" || typeof status.endedAt !== "number" || status.endedAt <= 0) return unknown("Terminal process evidence unavailable");
  const instances = proof.instances.map(record);
  if (!Number.isFinite(proof.observedAt) || typeof proof.runnerProcessInstanceId !== "string" || !proof.runnerProcessInstanceId || !instances.some(p => p.kind === "runner" && p.processInstanceId === proof.runnerProcessInstanceId) || instances.some(p => {
   if (typeof p.processInstanceId !== "string" || !p.processInstanceId || !Number.isFinite(p.closeObservedAt) || Number(p.closeObservedAt) > Number(proof.observedAt) || (p.exitCode !== null && !Number.isInteger(p.exitCode)) || (p.signal !== null && typeof p.signal !== "string")) return true;
   if (p.kind === "runner") return p.attempt !== undefined;
   const tree = record(p.processTree);
   return p.kind !== "pi-writer" || !Number.isInteger(p.attempt) || Number(p.attempt) < 0 || tree.state !== "observed" || tree.mechanism !== "posix-process-group" || !Number.isInteger(tree.processGroupId) || Number(tree.processGroupId) <= 0 || !Number.isFinite(tree.verifiedAt);
  })) return unknown("Invalid process terminal proof");
  const steps = Array.isArray(status.steps) ? status.steps.map(record) : [];
  let outcome: "succeeded" | "failed" | "stopped";
  if (status.state === "complete" && steps.length === 1 && steps.every(s => s.status === "complete") && instances.every(p => p.exitCode === 0 && p.signal === null) && !status.stopped && !status.timedOut) outcome = "succeeded";
  else if (status.state === "stopped") outcome = "stopped";
  else if (["failed", "partial", "rejected"].includes(String(status.state))) outcome = "failed";
  else return unknown("Contradictory terminal status");
  const output = outcome === "succeeded" ? steps[0]?.structuredOutput : undefined;
  if (output !== undefined) validateTerminalOutput(output);
  return { kind: "known-terminal", evidence: { kind: "terminal", run, outcome, evidenceDigest: digest(status), observedAt: now, ...(output !== undefined ? { output: structuredClone(output) } : {}) } };
 } catch { return unknown("Malformed runtime status artifact"); }
}

export function createAttemptRuntime(options: AttemptRuntimeOptions): AttemptRuntime & { dispose(): void } {
 const readText = options.readText ?? (path => readFile(path, "utf8")), now = options.now ?? Date.now;
 const sessionId = options.sessionId ?? (async path => { const header = record(JSON.parse((await readText(path)).split("\n")[0]!)); if (header.type !== "session" || typeof header.id !== "string") throw new Error("Missing session header"); return header.id; });
 const listeners = new Set<Parameters<AttemptRuntime["subscribe"]>[0]>();
 const pending = new Set<() => void>();
 let disposed = false, ping: RecordData = {}, capabilities: RuntimeCapabilities | undefined;
 const launches = new Map<string, Promise<LaunchOutcome>>();
 const wake = (raw: unknown) => { const data = record(raw); if (typeof data.runId !== "string") return; for (const listener of listeners) { try { listener({ runId: data.runId, ...(typeof data.operationId === "string" ? { operationId: data.operationId } : {}) }); } catch { /* A consumer cannot break RPC delivery. */ } } };
 // Install before any request, including a synchronously delivered spawn completion.
 const unsubscribers = ["subagent:async-complete", "subagent:child-status", "subagent:process-terminal"].map(name => options.events.on(name, wake));
 async function rpc(method: string, params: unknown = {}): Promise<RecordData> {
  if (disposed) return {};
  return new Promise(resolve => {
   const requestId = randomUUID(); let off = () => {}; let timer: ReturnType<typeof setTimeout> | undefined;
   const finish = (data: RecordData) => { off(); if (timer) clearTimeout(timer); pending.delete(cancel); resolve(data); };
   const cancel = () => finish({}); pending.add(cancel);
   off = options.events.on(`subagents:rpc:v1:reply:${requestId}`, raw => { const reply = record(raw); if (reply.version === 1 && reply.requestId === requestId && reply.method === method) finish(reply); });
   timer = setTimeout(cancel, options.timeoutMs ?? 5_000);
   try { options.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params, source: { extension: "pi-orchestrate" } }); } catch { cancel(); }
  });
 }
 async function probe(): Promise<RuntimeCapabilities> {
  const reply = await rpc("ping"); ping = record(reply.data); const caps = record(ping.capabilities), methods = Array.isArray(ping.methods) ? ping.methods : [];
  const available = reply.success === true && ping.version === 1 && caps.asyncSpawn === true && ["spawn", "status"].every(m => methods.includes(m));
  capabilities = { available, capacity: available ? options.capacity : 0, durableOperationLookup: available && methods.includes("lookup") && record(caps.durableSpawn).version === 1 && record(caps.durableSpawn).lookup === true,
   // Same-run control is stop-only by the public RPC v1 contract: it defines no
   // pause method, and its resume re-engages a run with a required message (never
   // a same-run un-pause). Coordinator pause/resume are durable intents
   // (scheduler.applyControl) and never reach runtime.control, so nothing else
   // may be advertised here.
   controls: caps.stop === true && methods.includes("stop") ? ["stop"] : [], profiles: [...new Set([...nativeKeys, ...(options.profileEncoder?.keys ?? [])])],
   ...(options.remainingBudget !== undefined ? { remainingBudget: options.remainingBudget } : {}), ...(options.callerTools ? { callerTools: options.callerTools } : {}), ...(options.callerAgents ? { callerAgents: options.callerAgents } : {}), ...(!available ? { reason: "Detached event RPC unavailable" } : {}) };
  return structuredClone(capabilities);
 }
 async function ownerMatches(file: string): Promise<boolean> {
  return record(ping.session).sessionFile === file && file === options.sessionFile && record(ping.session).sessionId === await sessionId(file);
 }
 function runFromReply(data: unknown, owner: string, operationId?: string): RunRef | undefined {
  const details = record(record(data).details);
  if (details.mode !== "single" || typeof details.runId !== "string" || !details.runId || typeof details.asyncDir !== "string" || !isAbsolute(details.asyncDir) || (details.asyncId !== undefined && details.asyncId !== details.runId)) return;
  return { runId: details.runId, artifactDir: details.asyncDir, ownerSessionFile: owner, ...(operationId ? { operationId } : {}) };
 }
 async function observeRun(run: RunRef): Promise<Observation> {
  try {
   // Status is a reconciliation request, never human prose or missing fleet = completion.
   await rpc("status", { runId: run.runId, dir: run.artifactDir });
   return decodeRuntimeStatus(await readText(join(run.artifactDir, "status.json")), run, await sessionId(run.ownerSessionFile), now());
  } catch { return unknown("Run status/owner artifact unavailable"); }
 }
 async function launchOnce(request: LaunchRequest): Promise<LaunchOutcome> {
  const { attempt, profile } = request;
  const reject = (reason: string, category: "policy" | "budget" | "capability"): LaunchOutcome => ({ kind: "rejected-before-start", reason, category, evidence: { kind: "not-started", launchDigest: attempt.launchDigest, reason } });
  try {
   const caps = await probe();
   if (!caps.available) return reject("Detached runtime unavailable", "capability");
   if (!await ownerMatches(attempt.ownerSessionFile)) return reject("Launch owner is not the active runtime session", "policy");
   const ownerSessionId = await sessionId(attempt.ownerSessionFile);
   if (!ownerSessionId) return reject("Launch owner session header identity is unavailable", "policy");
   if (attempt.run || !["preparing", "launching"].includes(attempt.phase)) return unknown("Attempt may already have launched; reconcile instead");
   if (!isAbsolute(attempt.workspace.path) || resolve(attempt.workspace.path) !== attempt.workspace.path || request.authorization.repoId !== attempt.workspace.repoId || request.authorization.manifestId !== attempt.manifestId || request.authorization.revision !== attempt.manifestRevision || request.authorization.baseCommit !== attempt.baseCommit || attempt.workspace.baseCommit !== attempt.baseCommit || request.task.id !== attempt.taskId || taskRevisionDigest(request.task) !== attempt.taskDigest) return reject("Launch workspace/task authorization mismatch", "policy");
   const policy = resolveExecutionProfile({ explicit: profile, capabilities: caps });
   if (policy.kind === "conflict") return reject(policy.reasons.join("; "), "capability");
   if (caps.remainingBudget !== undefined && caps.remainingBudget <= 0) return reject("Runtime spawn budget exhausted", "budget");
   if (caps.capacity <= 0) { const reason = "Runtime capacity unavailable"; return { kind: "capacity-deferred", reason, evidence: { kind: "not-started", launchDigest: attempt.launchDigest, reason } }; }
   if (!profile.agent) return reject("Single launch requires resolved agent", "capability");
   if (profile.thinking && !profile.model) return reject("Thinking override requires a resolved model", "capability");
   // Public RPC spawn normalizes SubagentParams.outputSchema (not structuredOutput).
   const outputSchema = request.task.mode === "mutation"
    ? { type: "object", additionalProperties: false, required: ["kind", "commit"], properties: { kind: { const: "commits" }, commit: { type: "string", pattern: "^[a-f0-9]{40}([a-f0-9]{24})?$" } } }
    : { type: "object", additionalProperties: false, required: ["kind", "path", "digest"], properties: { kind: { const: "artifact" }, path: { type: "string" }, digest: { type: "string", pattern: "^[a-f0-9]{64}$" } } };
   const taskText = `${request.task.text}\n\nFinish with structured_output: ${request.task.mode === "mutation" ? 'exact output identity {"kind":"commits","commit":"<full final commit SHA>"}; commit only in-scope changes in this workspace' : '{"kind":"artifact","path":"<canonical absolute artifact path inside this run artifact directory>","digest":"<SHA256 of exact artifact bytes>"}; do not change Git HEAD'}. No push, PR creation, or new worktree.`;
   const executionBinding = createExecutionIdentityBinding({
    attemptId: attempt.id,
    workspaceId: attempt.workspace.id,
    workspacePath: attempt.workspace.path,
    ownerSessionId,
   });
   const params: RecordData = {
    outputSchema, agent: profile.agent, task: taskText, cwd: attempt.workspace.path, async: true, worktree: false,
    // Do not pass the attempt id as `runId`: in the public API that field is a
    // management selector, not the child's runtime identity. The child receives its generated run id and parent
    // session header id from pi-subagents; this namespaced binding selects the
    // durable attempt/workspace that those runtime facts must match.
    parentSessionId: ownerSessionId, extensionBindings: executionBinding,
   };
   for (const key of ["model", "context", "timeoutMs"] as const) if (profile[key] !== undefined) params[key] = profile[key];
   if (profile.thinking) params.model = `${profile.model}:${profile.thinking}`;
   if (options.profileEncoder) {
    const encoded = options.profileEncoder.encode(profile);
    if (["action", "workflowScript", "workflowScriptPath", "tasks", "chain", "parallel", "concurrency", "config", "resume", "operationId", "runId", "parentSessionId", "extensionBindings"].some(key => key in encoded)) return reject("Profile encoder cannot change single-attempt execution shape or identity", "policy");
    Object.assign(params, encoded);
   }
   // Never allow an injected profile mapping to alter launch identity/isolation.
   Object.assign(params, { outputSchema, agent: profile.agent, task: taskText, cwd: attempt.workspace.path, async: true, worktree: false, parentSessionId: ownerSessionId, extensionBindings: executionBinding });
   if (attempt.operationId && caps.durableOperationLookup) params.operationId = attempt.operationId;
   const reply = await rpc("spawn", params);
   if (reply.success !== true) {
    const error = record(reply.error);
    if (["invalid_params", "unsupported_method", "unsupported_version", "no_active_session"].includes(String(error.code))) return reject(String(error.message ?? error.code), "capability");
    return unknown("Spawn acknowledgement lost or execution outcome ambiguous");
   }
   const run = runFromReply(reply.data, attempt.ownerSessionFile, caps.durableOperationLookup ? attempt.operationId : undefined);
   if (!run) return unknown("Spawn reply lacks exact single-run identity");
   const observed = await observeRun(run);
   return observed.kind === "known-terminal" ? observed : { kind: "known-running", run };
  } catch { return unknown("Launch transport/owner validation failed"); }
 }
 const runtime: AttemptRuntime & { dispose(): void } = {
  probe,
  launch(request) { const existing = launches.get(request.attempt.id); if (existing) return existing; const result = launchOnce(request); launches.set(request.attempt.id, result); return result; },
  async observe(attempt) { if (attempt.run && attempt.run.ownerSessionFile !== attempt.ownerSessionFile) return unknown("Attempt/run owner mismatch"); if (attempt.run) return observeRun(attempt.run); if (attempt.operationId) return runtime.lookupOperation!(attempt.operationId, attempt.ownerSessionFile).then(result => result.kind === "known-running" || result.kind === "known-terminal" ? result : unknown("Operation outcome unresolved")); return unknown("No acknowledged run identity"); },
  async lookupOperation(operationId, owner) {
   try {
    if (!(await probe()).durableOperationLookup) return unknown("Durable lookup not advertised");
    if (!await ownerMatches(owner)) return unknown("Cannot lookup a foreign session operation");
    const reply = await rpc("lookup", { operationId }), data = record(reply.data);
    if (reply.success !== true || data.state !== "known") return unknown("Operation lookup is unknown; not proof of nonlaunch");
    const run = runFromReply(data.reply, owner, operationId); if (!run) return unknown("Lookup lacks run evidence");
    const observation = await observeRun(run); return observation.kind === "known-terminal" ? observation : { kind: "known-running", run };
   } catch { return unknown("Operation lookup unavailable"); }
  },
  async control(run, action, owner) {
   if (owner !== run.ownerSessionFile || owner !== options.sessionFile) return { kind: "forbidden", reason: "Resume the owning session; adoption is unsupported" };
   try {
    const caps = await probe();
    if (!await ownerMatches(owner)) return { kind: "forbidden", reason: "Runtime owner mismatch" };
    if (!caps.controls.includes(action)) return { kind: "unsupported", reason: `${action} has no supported same-run control contract` };
    const reply = await rpc(action, { runId: run.runId, dir: run.artifactDir }), data = record(reply.data);
    if (reply.success === true && data.runId === run.runId && data.asyncDir === run.artifactDir && data.state === "stopping") return { kind: "acknowledged", run };
    return unknown("Control acknowledgement unavailable; retain reservation");
   } catch { return unknown("Control failed; retain reservation"); }
  },
  subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  dispose() { disposed = true; unsubscribers.forEach(off => off()); for (const cancel of pending) cancel(); listeners.clear(); },
 };
 return runtime;
}
