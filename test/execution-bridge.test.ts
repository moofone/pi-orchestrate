import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseExecutionCommand, isUnambiguousPlanPath, createExecutionBridge } from "../src/lib/execution-bridge.ts";
import { digest, workspaceExcludedByDelivery, type ExecutionManifest } from "../src/lib/execution-contract.ts";
import type { InterpretationRequest } from "../src/lib/plan-import.ts";
import { FakeAttemptRuntime, FakeWorkspaceAdapter, FakeCheckExecutor, FakeDeliveryAdapter } from "./fixtures/execution/fakes.ts";

test("execution command preserves quoted Markdown plan paths and rejects ambiguous input", () => {
  assert.deepEqual(parseExecutionCommand('run "docs/plans/plan with spaces.md"'), {
    verb: "run",
    args: ["docs/plans/plan with spaces.md"],
  });
  assert.deepEqual(parseExecutionCommand("run 'docs/plans/plan.md'"), {
    verb: "run",
    args: ["docs/plans/plan.md"],
  });
  assert.throws(() => parseExecutionCommand('run "docs/plans/broken.md'), /unterminated quote/i);
  assert.equal(isUnambiguousPlanPath("docs/plans/plan.md"), true);
  assert.equal(isUnambiguousPlanPath("docs/plans/plan with spaces.md"), true);
  assert.equal(isUnambiguousPlanPath("docs/plans/plan.txt"), false);
  assert.equal(isUnambiguousPlanPath("plan.md extra"), false);
});

test("execution bridge previews without auto-approval and binds approval to the snapshot", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "execution-bridge-")));
  const planPath = join(root, "plan with spaces.md");
  const sessionFile = join(root, "session.jsonl");
  writeFileSync(planPath, "# Plan\n");
  writeFileSync(sessionFile, "");
  const ownedRoot = join(root, "owned"); mkdirSync(ownedRoot);
  const baseCommit = "a".repeat(40);
  const repo = { commonDir: root, id: digest(root) };
  const runtime = new FakeAttemptRuntime();
  const workspaces = new FakeWorkspaceAdapter();
  let interpretations = 0;
  const checks = new FakeCheckExecutor();
  const delivery = new FakeDeliveryAdapter();
  const bridge = createExecutionBridge({
    repo, referencePath: root, stateRoot: root, sessionFile, processStart: "bridge-test", capacity: 1,
    ownedRoot, runtime, workspaces, checks, delivery,
    git: async (_cwd, argv) => ({ exitCode: 0, stdout: argv[0] === "rev-parse" ? `${baseCommit}\n` : "", stderr: "" }),
    interpretationTransport: async request => {
      interpretations++;
      const feature = { id: "feature", title: "Feature", scope: "feature" };
      const group = { id: "delivery", featureIds: [feature.id], requiredTaskIds: ["logical-task"], checks: [], policy: "local" as const, completion: "validated" as const, ownerId: feature.id };
      const task = { id: "logical-task", featureId: feature.id, deliveryGroupId: group.id, text: "Implement", mode: "mutation" as const, dependencies: [], scope: ["src"], profile: { agent: "tdd-worker" }, checks: [], provenance: ["text", "mode", "dependencies", "scope", "profile", "deliveryGroupId"].map(field => ({ field, origin: "inferred" as const, reason: "fixture" })) };
      const manifest: ExecutionManifest = { schemaVersion: 1, id: request.identity.id, revision: request.identity.revision, source: request.source, repo: request.identity.repo, baseCommit: request.identity.baseCommit, scope: "fixture", preset: "plan-driven", features: [feature], deliveryGroups: [group], tasks: [task], constraints: { capacity: 1, parallelGroups: [], provenance: [{ field: "capacity", origin: "inferred", reason: "fixture" }] }, provenance: [{ field: "scope", origin: "inferred", reason: "fixture" }, { field: "features", origin: "inferred", reason: "fixture" }, { field: "deliveryGroups", origin: "inferred", reason: "fixture" }] };
      return { manifest, unresolvedDecisions: [] };
    },
  });
  const preview = await bridge.run(planPath);
  assert.equal(preview.kind, "approval-required", JSON.stringify(preview));
  assert.equal(bridge.store.read().authorizations.length, 0, "preview must not auto-approve");
  if (preview.kind !== "approval-required") return;
  const started = await bridge.run(planPath, { token: preview.preview.token, capacity: 1, publication: false, approvedBy: sessionFile, approvedAt: 10 });
  assert.equal(started.kind, "started");
  assert.equal(interpretations, 1, "approval must use the exact preview snapshot, not reinterpret the plan");
  if (started.kind === "started") {
    assert.equal(started.authorization.sourceDigest, preview.preview.sourceDigest);
    assert.equal(started.authorization.manifestDigest, digest(started.manifest));
  }
  await bridge.shutdown();
});

test("refused approval previews are detached and cannot poison the token-bound manifest", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "execution-bridge-preview-integrity-")));
  const planPath = join(root, "plan.md"), sessionFile = join(root, "session.jsonl");
  writeFileSync(planPath, "# Plan\n"); writeFileSync(sessionFile, "");
  const ownedRoot = join(root, "owned"); mkdirSync(ownedRoot);
  const baseCommit = "b".repeat(40), repo = { commonDir: root, id: digest(root) };
  const runtime = new FakeAttemptRuntime(); const workspaces = new FakeWorkspaceAdapter();
  const bridge = createExecutionBridge({
    repo, referencePath: root, stateRoot: root, sessionFile, processStart: "preview-integrity", capacity: 1,
    ownedRoot, runtime, workspaces, checks: new FakeCheckExecutor(), delivery: new FakeDeliveryAdapter(),
    git: async (_cwd, argv) => ({ exitCode: 0, stdout: argv[0] === "rev-parse" ? `${baseCommit}\n` : "", stderr: "" }),
    interpretationTransport: async request => {
      const feature = { id: "feature", title: "Feature", scope: "feature" };
      const group = { id: "delivery", featureIds: [feature.id], requiredTaskIds: ["task"], checks: [], policy: "local" as const, completion: "validated" as const, ownerId: feature.id };
      const task = { id: "task", featureId: feature.id, deliveryGroupId: group.id, text: "approved task", mode: "mutation" as const, dependencies: [], scope: ["src"], profile: { agent: "tdd-worker" }, checks: [], provenance: ["text", "mode", "dependencies", "scope", "profile", "deliveryGroupId"].map(field => ({ field, origin: "inferred" as const, reason: "fixture" })) };
      return { manifest: { schemaVersion: 1, id: request.identity.id, revision: request.identity.revision, source: request.source, repo: request.identity.repo, baseCommit: request.identity.baseCommit, scope: "fixture", preset: "plan-driven" as const, features: [feature], deliveryGroups: [group], tasks: [task], constraints: { capacity: 1, parallelGroups: [], provenance: [{ field: "capacity", origin: "inferred" as const, reason: "fixture" }] }, provenance: [{ field: "scope", origin: "inferred" as const, reason: "fixture" }, { field: "features", origin: "inferred" as const, reason: "fixture" }, { field: "deliveryGroups", origin: "inferred" as const, reason: "fixture" }] }, unresolvedDecisions: [] };
    },
  });
  const first = await bridge.run(planPath);
  assert.equal(first.kind, "approval-required"); if (first.kind !== "approval-required") return;
  writeFileSync(planPath, "# changed\n");
  const refused = await bridge.run(planPath, { token: first.preview.token, capacity: 1, publication: false, approvedBy: sessionFile, approvedAt: 1 });
  assert.equal(refused.kind, "refused"); if (refused.kind !== "refused" || !refused.preview) return;
  refused.preview.manifest.tasks[0]!.text = "UNAPPROVED MUTATION";
  writeFileSync(planPath, "# Plan\n");
  const approved = await bridge.run(planPath, { token: first.preview.token, capacity: 1, publication: false, approvedBy: sessionFile, approvedAt: 2 });
  assert.equal(approved.kind, "started", "detached refusal data must not mutate the cached approval");
  if (approved.kind === "started") assert.equal(approved.manifest.tasks[0]!.text, "approved task");
  await bridge.shutdown();
});

test("non-owner control invocations receive fresh durable identities", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "execution-bridge-controls-"))), planPath = join(root, "plan.md"), sessionA = join(root, "owner.jsonl"), sessionB = join(root, "observer.jsonl");
  writeFileSync(planPath, "# Plan\n"); writeFileSync(sessionA, ""); writeFileSync(sessionB, ""); mkdirSync(join(root, "owned"));
  const repo = { commonDir: root, id: digest(root) }, baseCommit = "d".repeat(40);
  const make = (sessionFile: string) => createExecutionBridge({ repo, referencePath: root, stateRoot: root, sessionFile, processStart: sessionFile, capacity: 1, ownedRoot: join(root, "owned"), runtime: new FakeAttemptRuntime(), workspaces: new FakeWorkspaceAdapter(), checks: new FakeCheckExecutor(), delivery: new FakeDeliveryAdapter(), git: async (_cwd, argv) => ({ exitCode: 0, stdout: argv[0] === "rev-parse" ? `${baseCommit}\n` : "", stderr: "" }), interpretationTransport: async request => {
    const feature = { id: "feature", title: "Feature", scope: "src" }, group = { id: "delivery", featureIds: [feature.id], requiredTaskIds: ["task"], checks: [], policy: "local" as const, completion: "validated" as const, ownerId: feature.id };
    const task = { id: "task", featureId: feature.id, deliveryGroupId: group.id, text: "task", mode: "mutation" as const, dependencies: [], scope: ["src"], profile: { agent: "tdd-worker" }, checks: [], provenance: ["text", "mode", "dependencies", "scope", "profile", "deliveryGroupId"].map(field => ({ field, origin: "inferred" as const, reason: "fixture" })) };
    return { manifest: { schemaVersion: 1, id: request.identity.id, revision: request.identity.revision, source: request.source, repo: request.identity.repo, baseCommit: request.identity.baseCommit, scope: "src", preset: "plan-driven" as const, features: [feature], deliveryGroups: [group], tasks: [task], constraints: { capacity: 1, parallelGroups: [], provenance: [{ field: "capacity", origin: "inferred" as const, reason: "fixture" }] }, provenance: [{ field: "scope", origin: "inferred" as const, reason: "fixture" }, { field: "features", origin: "inferred" as const, reason: "fixture" }, { field: "deliveryGroups", origin: "inferred" as const, reason: "fixture" }] }, unresolvedDecisions: [] };
  }});
  const owner = make(sessionA), preview = await owner.run(planPath); assert.equal(preview.kind, "approval-required", JSON.stringify(preview)); if (preview.kind !== "approval-required") return;
  assert.equal((await owner.run(planPath, { token: preview.preview.token, capacity: 1, publication: false, approvedBy: sessionA, approvedAt: 1 })).kind, "started");
  const observer = make(sessionB), targetId = owner.store.read().manifests[0]!.id;
  await observer.control({ targetId, action: "pause" });
  await observer.control({ targetId, action: "pause" });
  for (let i = 0; i < 100 && owner.store.read().intents.some(intent => intent.consumedAt === undefined) === false; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const intents = observer.store.read().intents;
  assert.equal(intents.length, 2); assert.notEqual(intents[0]!.id, intents[1]!.id); assert.notEqual(intents[0]!.invocationId, intents[1]!.invocationId);
  assert.ok(intents.some(intent => intent.consumedAt !== undefined), "durable state watch should wake the idle owner");
  await observer.shutdown(); await owner.shutdown();
  const restarted = make(sessionA); await restarted.start({ resumePriorOwner: true });
  assert.equal(restarted.store.read().owner?.sessionFile, realpathSync(sessionA), "startup recovery is scoped to the prior owner session");
  await restarted.shutdown();
});

test("delivery handoff fences exclude workspace IDs and canonical paths across groups", () => {
  const workspace = { id: "delivery-workspace", path: "/tmp/canonical-delivery" };
  assert.equal(workspaceExcludedByDelivery({ deliveries: [{ groupId: "g1", phase: "controller-owned", handoff: { workspace } }] }, workspace), true);
  assert.equal(workspaceExcludedByDelivery({ deliveries: [{ groupId: "g1", phase: "handoff-pending", handoff: { workspace: { id: "other", path: workspace.path } } }] }, workspace), true);
  assert.equal(workspaceExcludedByDelivery({ deliveries: [{ groupId: "g1", phase: "ready" }] }, workspace), false);
});

// Base authorization: preview is detached and approval-gated, so it must
// resolve its base from already-present immutable local state and never fetch
// or otherwise mutate the reference repository. Only the explicit
// refreshBase() port may fetch, and it is the only operation that can
// retarget the authorized base.
const fixtureInterpretation = async (request: InterpretationRequest) => {
  const feature = { id: "feature", title: "Feature", scope: "feature" };
  const group = { id: "delivery", featureIds: [feature.id], requiredTaskIds: ["task"], checks: [], policy: "local" as const, completion: "validated" as const, ownerId: feature.id };
  const task = { id: "task", featureId: feature.id, deliveryGroupId: group.id, text: "Implement", mode: "mutation" as const, dependencies: [], scope: ["src"], profile: { agent: "tdd-worker" }, checks: [], provenance: ["text", "mode", "dependencies", "scope", "profile", "deliveryGroupId"].map(field => ({ field, origin: "inferred" as const, reason: "fixture" })) };
  return { manifest: { schemaVersion: 1, id: request.identity.id, revision: request.identity.revision, source: request.source, repo: request.identity.repo, baseCommit: request.identity.baseCommit, scope: "fixture", preset: "plan-driven" as const, features: [feature], deliveryGroups: [group], tasks: [task], constraints: { capacity: 1, parallelGroups: [], provenance: [{ field: "capacity", origin: "inferred", reason: "fixture" }] }, provenance: [{ field: "scope", origin: "inferred", reason: "fixture" }, { field: "features", origin: "inferred", reason: "fixture" }, { field: "deliveryGroups", origin: "inferred", reason: "fixture" }] }, unresolvedDecisions: [] };
};

function baseFixtureBridge(root: string, sessionFile: string, state: { resolvedBase: string; resolveFails: boolean }, gitCalls: string[][]) {
  const repo = { commonDir: root, id: digest(root) };
  return createExecutionBridge({
    repo, referencePath: root, stateRoot: root, sessionFile, processStart: "base-auth", capacity: 1,
    ownedRoot: join(root, "owned"), runtime: new FakeAttemptRuntime(), workspaces: new FakeWorkspaceAdapter(), checks: new FakeCheckExecutor(), delivery: new FakeDeliveryAdapter(),
    git: async (_cwd, argv) => {
      gitCalls.push([...argv]);
      if (argv[0] === "rev-parse" && state.resolveFails) return { exitCode: 128, stdout: "", stderr: "fatal: ambiguous argument 'origin/HEAD'" };
      return { exitCode: 0, stdout: argv[0] === "rev-parse" ? `${state.resolvedBase}\n` : "", stderr: "" };
    },
    interpretationTransport: fixtureInterpretation,
  });
}

function baseFixtureRoot(prefix: string): { root: string; planPath: string; sessionFile: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const planPath = join(root, "plan.md"), sessionFile = join(root, "session.jsonl");
  writeFileSync(planPath, "# Plan\n"); writeFileSync(sessionFile, ""); mkdirSync(join(root, "owned"));
  return { root, planPath, sessionFile };
}

test("preview resolves the base from local state without fetching or mutating repository state", async () => {
  const { root, planPath, sessionFile } = baseFixtureRoot("execution-bridge-base-nofetch-");
  const baseCommit = "a".repeat(40), state = { resolvedBase: baseCommit, resolveFails: false }, gitCalls: string[][] = [];
  const bridge = baseFixtureBridge(root, sessionFile, state, gitCalls);
  const fetches = () => gitCalls.filter(argv => argv[0] === "fetch").length;
  const preview = await bridge.run(planPath);
  assert.equal(preview.kind, "approval-required", JSON.stringify(preview));
  if (preview.kind !== "approval-required") return;
  assert.equal(preview.preview.manifest.baseCommit, baseCommit, "preview must bind the base resolved from existing immutable local state");
  assert.equal(fetches(), 0, "preview must not fetch or otherwise mutate the reference repository before approval");
  const started = await bridge.run(planPath, { token: preview.preview.token, capacity: 1, publication: false, approvedBy: sessionFile, approvedAt: 1 });
  assert.equal(started.kind, "started", JSON.stringify(started));
  if (started.kind === "started") assert.equal(started.manifest.baseCommit, baseCommit, "approval must execute the exact previewed base SHA");
  assert.equal(fetches(), 0, "approval must not fetch either; the default path carries no implicit remote effects");
  await bridge.shutdown();
});

test("moved refs cannot retarget the authorized base; only explicit refreshBase retargets", async () => {
  const { root, planPath, sessionFile } = baseFixtureRoot("execution-bridge-base-retarget-");
  const first = "a".repeat(40), moved = "b".repeat(40), state = { resolvedBase: first, resolveFails: false }, gitCalls: string[][] = [];
  const bridge = baseFixtureBridge(root, sessionFile, state, gitCalls);
  const fetches = () => gitCalls.filter(argv => argv[0] === "fetch").length;
  const preview = await bridge.run(planPath);
  assert.equal(preview.kind, "approval-required", JSON.stringify(preview));
  if (preview.kind !== "approval-required") return;
  assert.equal(preview.preview.manifest.baseCommit, first);
  state.resolvedBase = moved; // remote-tracking refs moved underneath the bridge
  const started = await bridge.run(planPath, { token: preview.preview.token, capacity: 1, publication: false, approvedBy: sessionFile, approvedAt: 1 });
  assert.equal(started.kind, "started", JSON.stringify(started));
  if (started.kind === "started") assert.equal(started.manifest.baseCommit, first, "approval must execute the exact previewed base, not the moved ref");
  const next = await bridge.run(planPath);
  assert.equal(next.kind, "approval-required", JSON.stringify(next));
  if (next.kind !== "approval-required") return;
  assert.equal(next.preview.manifest.baseCommit, first, "moving refs must not retarget the authorized base");
  const refreshed = await bridge.refreshBase();
  assert.equal(refreshed, moved, "explicit refresh returns the newly fetched base");
  assert.equal(fetches(), 1, "only the explicit refresh fetches");
  const retargeted = await bridge.run(planPath);
  assert.equal(retargeted.kind, "approval-required", JSON.stringify(retargeted));
  if (retargeted.kind !== "approval-required") return;
  assert.equal(retargeted.preview.manifest.baseCommit, moved, "explicit refresh is the only path that retargets the authorized base");
  await bridge.shutdown();
});

test("missing local base refuses actionable without any fetch; refreshBase is the only fetch path", async () => {
  const { root, planPath, sessionFile } = baseFixtureRoot("execution-bridge-base-missing-");
  const baseCommit = "c".repeat(40), state = { resolvedBase: baseCommit, resolveFails: true }, gitCalls: string[][] = [];
  const bridge = baseFixtureBridge(root, sessionFile, state, gitCalls);
  const fetches = () => gitCalls.filter(argv => argv[0] === "fetch").length;
  const refused = await bridge.run(planPath);
  assert.equal(refused.kind, "refused", JSON.stringify(refused));
  if (refused.kind !== "refused") return;
  assert.match(refused.reason, /refresh/i, "refusal must name the explicit refresh remedy");
  assert.equal(fetches(), 0, "even a missing base must never trigger an implicit fetch");
  state.resolveFails = false; // base now exists locally, e.g. after a caller-initiated fetch
  const refreshed = await bridge.refreshBase();
  assert.equal(refreshed, baseCommit);
  assert.equal(fetches(), 1, "refreshBase is the only fetch path");
  const preview = await bridge.run(planPath);
  assert.equal(preview.kind, "approval-required", JSON.stringify(preview));
  if (preview.kind !== "approval-required") return;
  assert.equal(preview.preview.manifest.baseCommit, baseCommit);
  await bridge.shutdown();
});
