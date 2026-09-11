import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionInterpreter } from "../src/lib/execution-interpreter.ts";
import type { RuntimeEventBus } from "../src/lib/attempt-runtime.ts";
import type { InterpretationRequest } from "../src/lib/plan-import.ts";

// Review round 2 regression (PR#13): the production interpreter must resolve
// the launch from the runtime's committed spawn envelope exactly. Envelope
// evidence is committed pi-subagents 42257fc (git show, not the dirty sibling
// checkout; identical at origin f02d86fd):
//   src/extension/rpc.ts        reply = { version: 1, requestId, method, success, data }
//                               spawn data = dataFromToolResult() = { text, details }
//   .../async-execution.ts:1982 single-spawn details =
//                               { mode: "single", runId, results: [], asyncId, asyncDir }
// The interpreter's rpc() already unwraps `data`, so the spawn callback's
// `reply` IS `data`; these envelopes reproduce the committed payload field
// set with no permissive extra fields.

class EnvelopeBus implements RuntimeEventBus {
  readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  readonly spawns: Record<string, unknown>[] = [];
  /** Existence of the spawn cwd, probed at the moment the spawn RPC is issued. */
  spawnCwdExisted = false;
  readonly sessionFile: string;
  private readonly spawnData: unknown;
  private readonly completion: unknown;
  constructor(sessionFile: string, spawnData: unknown, completion: unknown) {
    this.sessionFile = sessionFile; this.spawnData = spawnData; this.completion = completion;
  }
  on(name: string, listener: (data: unknown) => void): () => void {
    const set = this.listeners.get(name) ?? new Set(); set.add(listener); this.listeners.set(name, set);
    return () => set.delete(listener);
  }
  emit(name: string, data: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(data);
    if (name !== "subagents:rpc:v1:request") return;
    const request = data as Record<string, unknown>;
    const reply = (value: unknown) => this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, method: request.method, success: true, data: value });
    if (request.method === "ping") {
      // Committed pingData(): version, methods, capabilities, events, session.
      reply({ version: 1, methods: ["ping", "spawn", "status", "stop"], capabilities: { status: true, asyncSpawn: true, stop: true }, events: { replyPrefix: "subagents:rpc:v1:reply:", asyncComplete: "subagent:async-complete" }, session: { sessionId: "parent", sessionFile: this.sessionFile } });
      return;
    }
    if (request.method !== "spawn") throw new Error(`Unexpected RPC: ${request.method}`);
    this.spawns.push(request.params as Record<string, unknown>);
    this.spawnCwdExisted = existsSync(String((request.params as Record<string, unknown>).cwd));
    reply(this.spawnData);
    queueMicrotask(() => this.emit("subagent:async-complete", this.completion));
  }
}

function harness(spawnData: unknown, completion: unknown) {
  const root = mkdtempSync(join(tmpdir(), "interpreter-envelope-"));
  const sessionFile = join(root, "parent.jsonl");
  mkdirSync(root, { recursive: true });
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "parent" }) + "\n");
  const bus = new EnvelopeBus(sessionFile, spawnData, completion);
  // No cwd option: the transport owns spawn isolation internally (review round
  // 2, PR#13) and must never accept a caller-directed working directory.
  const interpreter = createExecutionInterpreter({ events: bus, sessionFile });
  const request: InterpretationRequest = {
    prompt: "Interpret the plan snapshot.",
    schema: { type: "object" },
    source: { path: "plan.md", bytes: "# Ordinary plan\n", digest: "a".repeat(64) },
    identity: { id: "identity-1", revision: 1, repo: { id: "repo-1", commonDir: "/tmp/repo-1.git" }, baseCommit: "b".repeat(40) },
  };
  return { bus, interpreter, request, root };
}

// Committed async single-spawn receipt: data = { text, details }, details =
// { mode: "single", runId, results: [], asyncId, asyncDir } (42257fc
// async-execution.ts:1982 plus dataFromToolResult). The completion event is
// the committed result-watcher emission: payload spread plus top-level runId.
const runId = "interpret-1";
const structured = { manifest: { schemaVersion: 1 }, unresolvedDecisions: [] };
const faithfulSpawnData = { text: `Async: planner [${runId}]`, details: { mode: "single", runId, results: [], asyncId: runId, asyncDir: `/tmp/async/${runId}` } };
const faithfulCompletion = { sessionId: "parent", mode: "single", success: true, results: [{ structuredOutput: structured }], summary: "single run finished", runId, triggerTurn: 0 };

test("production interpreter resolves the committed single-run spawn envelope into the preview output", async () => {
  const h = harness(faithfulSpawnData, faithfulCompletion);
  const value = await h.interpreter(h.request);
  assert.deepEqual(value, structured, "the transport must resolve the run's structuredOutput");
  assert.equal(h.bus.spawns.length, 1);
  assert.equal((h.bus.spawns[0] as Record<string, unknown>).async, true, "the launch must stay a detached async spawn");
});

test("interpretation spawns into a fresh disposable directory, never the caller's reference checkout", async () => {
  const h = harness(faithfulSpawnData, faithfulCompletion);
  const value = await h.interpreter(h.request);
  assert.deepEqual(value, structured, "cwd isolation must not change interpretation output resolution");
  assert.equal(h.bus.spawns.length, 1);
  const spawn = h.bus.spawns[0] as Record<string, unknown>;
  const spawnCwd = String(spawn.cwd);
  assert.notEqual(spawnCwd, h.root, "the detached, unreviewed interpretation run must never execute in the caller's reference directory");
  assert.ok(!spawnCwd.startsWith(h.root), "the interpretation cwd must not live inside the reference directory tree");
  assert.ok(spawnCwd.startsWith(tmpdir()), "the interpretation cwd must be an isolated disposable directory under the OS temp root");
  assert.equal(h.bus.spawnCwdExisted, true, "the disposable directory must exist when the spawn is issued");
  assert.equal(spawn.worktree, false, "the run stays a plain detached spawn inside the disposable directory");
  assert.equal(existsSync(spawnCwd), false, "the disposable directory must be removed with plain fs once the request settles (never git worktree/checkout machinery)");
  assert.ok(String(spawn.task).includes(JSON.stringify(h.request.source)), "the exact snapshot bytes must still travel inside the prompt, independent of the working directory");
});

test("workflow-mode spawn identity stays rejected as lacking single-run identity", async () => {
  // Committed workflow-spawn receipt shape (42257fc test/unit/rpc.test.ts:485):
  // details = { mode: "workflow", results: [], asyncId }.
  const workflowReceipt = { text: `Async workflow [${runId}]`, details: { mode: "workflow", results: [], asyncId: runId, asyncDir: `/tmp/async/${runId}` } };
  const h = harness(workflowReceipt, faithfulCompletion);
  await assert.rejects(h.interpreter(h.request), /Interpreter spawn lacks single-run identity/,
    "a workflow-mode receipt must not satisfy the single-run identity guard");
});

test("asyncId-only spawn identity without runId stays rejected as lacking single-run identity", async () => {
  const missingRunId = { text: `Async: planner [${runId}]`, details: { mode: "single", results: [], asyncId: runId, asyncDir: `/tmp/async/${runId}` } };
  const h = harness(missingRunId, faithfulCompletion);
  await assert.rejects(h.interpreter(h.request), /Interpreter spawn lacks single-run identity/,
    "an identity without a runId must not be adopted as the single-run completion key");
});
