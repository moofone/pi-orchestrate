import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, sourceDigest, validateCoordinatorState, type DeliveryGroup, type ExecutionManifest, type IntegrationReceipt, type RepoIdentity, type WorkspaceRef } from "../src/lib/execution-contract.ts";
import { requestExecutionController } from "../src/lib/pr-review-events.ts";
import { createExecutionStore } from "../src/lib/execution-store.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "u7-registration-")));
process.env.GHL_LATCH_STATE_DIR = join(root, "latch");
process.env.GHL_ORCH_ROOT = join(root, "legacy-empty");
mkdirSync(process.env.GHL_LATCH_STATE_DIR, { recursive: true });
mkdirSync(process.env.GHL_ORCH_ROOT, { recursive: true });
const { default: registerLatch } = await import("../src/pr-await-latch.ts");

function harness(_repo: RepoIdentity, stateRoot: string) {
  const listeners = new Map<string, Set<(data: any) => void>>();
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const launchIntents: any[] = [];
  const events = {
    on(name: string, fn: (data: any) => void) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
    emit(name: string, data: any) {
      if (name === "pi.pr-review.launch") { launchIntents.push(data.intent); data.claimed = true; data.resolve({ runId: "run", recovered: false }); }
      for (const fn of listeners.get(name) ?? []) fn(data);
    },
  };
  const pi = {
    events,
    on(name: string, fn: any) { handlers.set(name, fn); },
    registerCommand() {},
    exec: async () => ({ code: 1, stdout: "", stderr: "no remote calls" }),
    sendUserMessage() {},
  };
  const sessionFile = join(root, "parent.jsonl"); writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "parent" }) + "\n");
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "session", getSessionFile: () => sessionFile }, isIdle: () => true, ui: { notify() {}, setStatus() {}, setTitle() {}, setWidget() {} } };
  registerLatch(pi as any, { watchMs: 0, chromeMs: 0, watchStateDir: false, featureOwnedPr: () => undefined });
  return { events, handlers, launchIntents, sessionFile, ctx, stateRoot };
}

test("registered latch resolves a new durable execution group without a legacy Feature and dispatches through controller", async () => {
  const commonDir = join(root, "repo.git"); mkdirSync(commonDir, { recursive: true });
  const repo = { commonDir, id: digest(commonDir) };
  const stateRoot = join(root, "orchestrator");
  const group: DeliveryGroup = { id: "group-new", featureIds: ["feature-new"], requiredTaskIds: [], checks: [], policy: "pr", completion: "merged", ownerId: "execution-owner" };
  const manifest = { schemaVersion: 1, id: "manifest-new", revision: 1, source: { path: join(root, "plan.md"), bytes: "# plan", digest: sourceDigest("# plan") }, repo, baseCommit: "a".repeat(40), scope: "src", preset: "plan-driven", features: [{ id: "feature-new", title: "new", scope: "src" }], deliveryGroups: [group], tasks: [], constraints: { capacity: 1, parallelGroups: [], provenance: [] }, provenance: [] } as unknown as ExecutionManifest;
  const workspace: WorkspaceRef = { id: "delivery-new", path: join(root, "delivery"), branch: "delivery-new", repoId: repo.id, baseCommit: manifest.baseCommit, prerequisiteDigests: [] };
  const receipt = { schemaVersion: 1, digest: "b".repeat(64), intentId: "integration-new", deliveryGroupId: group.id, inputDigests: [], beforeCommit: manifest.baseCommit, afterCommit: "c".repeat(40), checks: [], validatedAt: 1 } as IntegrationReceipt;
  const stateDir = join(stateRoot, "plan-driven-v1", "execution", repo.id); mkdirSync(stateDir, { recursive: true });
  const durableState = {
    schemaVersion: 1, repo, manifests: [manifest], activeRevisions: { [manifest.id]: 1 },
    authorizations: [{ id: "approval-new", manifestId: manifest.id, revision: manifest.revision, sourceDigest: manifest.source.digest, manifestDigest: digest(manifest), repoId: repo.id, baseCommit: manifest.baseCommit, scope: manifest.scope, capacity: 1, publication: true, approvedBy: join(root, "parent.jsonl"), approvedAt: 1 }],
    controllerMappings: [{ manifestId: manifest.id, manifestRevision: 1, groupId: group.id, ownerId: group.ownerId, generation: "generation-new", pr: { repo: "github.com/acme/repo", number: 7 }, workspace, head: receipt.afterCommit }],
    deliveries: [], tasks: [], attempts: [], results: [], integrations: [], integrationReceipts: [], reservations: [], parallelLaunchSets: [], intents: [], sequence: 0, epoch: 0, capacity: 1,
  };
  assert.doesNotThrow(() => validateCoordinatorState(durableState));
  writeFileSync(join(stateDir, "coordinator.json"), JSON.stringify(durableState));
  const h = harness(repo, stateRoot);
  assert.equal(createExecutionStore({ stateRoot: join(stateRoot, "plan-driven-v1"), repo }).read().controllerMappings?.length, 1);
  const loaded = JSON.parse(readFileSync(join(stateDir, "coordinator.json"), "utf8"));
  assert.equal(loaded.controllerMappings[0].workspace.id, workspace.id);
  assert.equal(loaded.controllerMappings[0].workspace.path, workspace.path);
  assert.equal(loaded.controllerMappings[0].workspace.repoId, repo.id);
  assert.equal(loaded.controllerMappings[0].workspace.baseCommit, manifest.baseCommit);
  const binding = await requestExecutionController(h.events, { repo, stateRoot, sessionFile: h.sessionFile });
  assert.ok(binding, "actual registered latch must claim execution binding");
  const resolved = await binding!.resolvePr({ manifest, group, receipt, workspace });
  assert.deepEqual(resolved, { kind: "authorized", pr: { repo: "github.com/acme/repo", number: 7 }, generation: "generation-new", ownerId: group.ownerId, ownerKind: "execution" });
  assert.equal((await binding!.resolvePr({ manifest, group, receipt, workspace: { ...workspace, path: join(root, "foreign-workspace") } })).kind, "refused");
  assert.equal((await binding!.resolvePr({ manifest: { ...manifest, repo: { ...repo, id: digest(join(root, "other.git")), commonDir: join(root, "other.git") } }, group, receipt, workspace })).kind, "refused");
  const handoff = binding!.controller.handoff({ pr: { host: "github.com", owner: "acme", repo: "repo", number: "7" }, owner: { kind: "execution", id: group.ownerId, generation: "generation-new" }, worktree: workspace.path, head: receipt.afterCommit });
  assert.equal(handoff.ok, true);
  const verdict = binding!.controller.observeVerdict({ pr: { host: "github.com", owner: "acme", repo: "repo", number: "7" }, next: "read_comments_and_fix", body: "next=read_comments_and_fix\nhead=" + receipt.afterCommit, head: receipt.afterCommit });
  assert.equal(verdict.accepted, true);
  const report = await binding!.controller.reconcile();
  assert.equal(report.launched, 1);
  assert.equal(h.launchIntents[0]?.owner.kind, "execution");
});
