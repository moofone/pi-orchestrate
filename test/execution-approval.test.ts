import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionBridge, type ExecutionPreview } from "../src/lib/execution-bridge.ts";
import { digest, type ExecutionManifest } from "../src/lib/execution-contract.ts";
import { FakeAttemptRuntime, FakeWorkspaceAdapter, FakeCheckExecutor, FakeDeliveryAdapter } from "./fixtures/execution/fakes.ts";

function fixture() {
 const root = realpathSync(mkdtempSync(join(tmpdir(), "execution-approval-")));
 const path = join(root, "plan.md"), sessionFile = join(root, "session.jsonl");
 writeFileSync(path, "# Plan\n"); writeFileSync(sessionFile, "");
 let count = 0;
 const options = {
  repo: { commonDir: root, id: digest(root) }, referencePath: root, stateRoot: root, sessionFile, capacity: 6,
  ownedRoot: join(root, "owned"), runtime: new FakeAttemptRuntime(), workspaces: new FakeWorkspaceAdapter(), checks: new FakeCheckExecutor(), delivery: new FakeDeliveryAdapter(),
  git: async (_cwd: string, argv: readonly string[]) => ({ exitCode: 0, stdout: argv[0] === "rev-parse" ? "a".repeat(40) : "", stderr: "" }),
  interpretationTransport: async (request: import("../src/lib/plan-import.ts").InterpretationRequest) => {
   count++;
   const provenance = (fields: string[]) => fields.map(field => ({ field, origin: "inferred" as const, reason: "fixture" }));
   const manifest: ExecutionManifest = { schemaVersion: 1, ...request.identity, source: request.source, scope: "test", preset: "plan-driven",
    features: [{ id: "f", title: "Feature", scope: "test" }],
    deliveryGroups: [{ id: "g", featureIds: ["f"], requiredTaskIds: ["t"], checks: [], policy: "local", completion: "validated", ownerId: "f" }],
    tasks: [{ id: "t", featureId: "f", deliveryGroupId: "g", text: `Interpretation ${count}`, mode: "mutation", dependencies: [], scope: ["src"], profile: { agent: "configured-worker" }, checks: [], provenance: provenance(["text", "mode", "dependencies", "scope", "profile", "deliveryGroupId"]) }],
    constraints: { capacity: 1, parallelGroups: [], provenance: provenance(["capacity"]) }, provenance: provenance(["scope", "features", "deliveryGroups"]) };
   return { manifest, unresolvedDecisions: [] };
  },
 };
 return { path, options, bridge: createExecutionBridge(options), count: () => count };
}
function approval(preview?: ExecutionPreview) {
 return { token: preview?.token ?? "missing", capacity: 6, publication: false, approvedBy: "caller", approvedAt: 10 };
}
test("approval A cannot approve replaced interpretation B of unchanged source", async () => {
 const h = fixture();
 try {
  const a = await h.bridge.run(h.path), b = await h.bridge.run(h.path);
  assert.equal(a.kind, "approval-required"); assert.equal(b.kind, "approval-required");
  if (a.kind !== "approval-required" || b.kind !== "approval-required") return;
  const result = await h.bridge.run(h.path, approval(a.preview));
  assert.equal(result.kind, "refused");
  assert.equal(h.count(), 2); assert.equal(h.bridge.store.read().authorizations.length, 0);
  assert.notEqual(a.preview.token, b.preview.token);
 } finally { await h.bridge.shutdown(); }
});
test("missing approval token never reinterprets or initializes repository capacity", async () => {
 const h = fixture();
 try {
  const before = h.bridge.store.read();
  const result = await h.bridge.run(h.path, approval());
  assert.equal(result.kind, "refused"); assert.equal(h.count(), 0);
  assert.deepEqual(h.bridge.store.read(), before);
 } finally { await h.bridge.shutdown(); }
});
test("preview is detached and exact token approval reuses interpretation with repository capacity", async () => {
 const h = fixture();
 try {
  const first = await h.bridge.run(h.path); assert.equal(first.kind, "approval-required"); if (first.kind !== "approval-required") return;
  first.preview.manifest.tasks[0]!.text = "mutated by caller";
  const result = await h.bridge.run(h.path, approval(first.preview));
  assert.equal(result.kind, "started"); if (result.kind !== "started") return;
  assert.equal(result.manifest.tasks[0]!.text, "Interpretation 1"); assert.equal(h.count(), 1);
  assert.equal(h.bridge.store.read().capacity, 6);
 } finally { await h.bridge.shutdown(); }
});
test("selectable legacy preset compiles only the new execution record", async () => {
 const h = fixture();
 writeFileSync(h.path, "# Feature: Legacy\n\n### Task 1 — Implement\n- Status: pending\n");
 const legacy = createExecutionBridge({ ...h.options, preset: "legacy", interpretationTransport: async () => { throw new Error("plan interpreter must not run for legacy preset"); } });
 try {
  const result = await legacy.run(h.path);
  assert.equal(result.kind, "approval-required");
  if (result.kind === "approval-required") { assert.equal(result.preview.manifest.preset, "legacy"); assert.ok(result.preview.manifest.tasks.some(task => task.profile.agent === "tdd-worker")); }
  assert.equal(legacy.store.read().authorizations.length, 0);
 } finally { await legacy.shutdown(); }
});

test("non-owner controls persist an authorized durable intent without taking the lease", async () => {
 const owner = fixture();
 const first = await owner.bridge.run(owner.path); assert.equal(first.kind, "approval-required"); if (first.kind !== "approval-required") return;
 assert.equal((await owner.bridge.run(owner.path, approval(first.preview))).kind, "started");
 const observer = createExecutionBridge({ ...owner.options, processStart: "observer", runtime: new FakeAttemptRuntime() });
 try {
  const taskId = observer.store.read().tasks[0]!.taskId;
  await observer.control({ targetId: taskId, action: "pause" });
  const intents = observer.store.read().intents;
  assert.equal(intents.length, 1); assert.equal(intents[0]!.targetId, taskId); assert.equal(intents[0]!.consumedAt, undefined);
  assert.equal(observer.store.read().owner?.instanceId, owner.bridge.store.read().owner?.instanceId);
 } finally { await observer.shutdown(); await owner.bridge.shutdown(); }
});

test("source change and cross-repository/base preview token are refused without state mutation", async () => {
 const h = fixture();
 try {
  const preview = await h.bridge.preview(h.path);
  writeFileSync(h.path, "# Changed\n");
  assert.equal((await h.bridge.run(h.path, approval(preview))).kind, "refused");
  writeFileSync(h.path, "# Plan\n");
  const foreign = fixture();
  try { assert.equal((await foreign.bridge.run(foreign.path, approval(preview))).kind, "refused"); }
  finally { await foreign.bridge.shutdown(); }
  const changedBase = createExecutionBridge({ ...h.options, baseCommit: "b".repeat(40) });
  try { assert.equal((await changedBase.run(h.path, approval(preview))).kind, "refused"); }
  finally { await changedBase.shutdown(); }
  assert.equal(h.bridge.store.read().authorizations.length, 0);
 } finally { await h.bridge.shutdown(); }
});

test("a consumed approval token has zero effects and needs an explicit fresh preview", async () => {
 const h = fixture();
 try {
  const first = await h.bridge.run(h.path);
  assert.equal(first.kind, "approval-required");
  if (first.kind !== "approval-required") return;
  const started = await h.bridge.run(h.path, approval(first.preview));
  assert.equal(started.kind, "started");
  if (started.kind !== "started") return;
  const consumed = h.bridge.store.read();
  const reuse = await h.bridge.run(h.path, approval(first.preview));
  assert.equal(reuse.kind, "refused", "a consumed approval cannot re-authorize anything");
  assert.equal(h.count(), 1, "reuse must not trigger a fresh interpretation");
  assert.deepEqual(h.bridge.store.read(), consumed, "reuse must leave execution state untouched");
  const fresh = await h.bridge.run(h.path);
  assert.equal(fresh.kind, "approval-required");
  if (fresh.kind !== "approval-required") return;
  assert.notEqual(fresh.preview.token, first.preview.token, "continuation requires a new displayed preview");
  assert.equal(h.count(), 2);
  const revised = await h.bridge.run(h.path, approval(fresh.preview));
  assert.equal(revised.kind, "started", "the fresh preview's own first exact approval stays valid");
 } finally { await h.bridge.shutdown(); }
});
