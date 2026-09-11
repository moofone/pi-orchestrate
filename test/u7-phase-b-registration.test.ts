import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, sourceDigest, validateCoordinatorState, type DeliveryGroup, type ExecutionManifest, type IntegrationReceipt, type RepoIdentity, type WorkspaceRef } from "../src/lib/execution-contract.ts";
import { createExecutionBridge } from "../src/lib/execution-bridge.ts";
import { requestExecutionController } from "../src/lib/pr-review-events.ts";
import { createExecutionStore } from "../src/lib/execution-store.ts";
import { createReviewStore } from "../src/lib/pr-review-store.ts";
import { FakeAttemptRuntime, FakeCheckExecutor, FakeWorkspaceAdapter } from "./fixtures/execution/fakes.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "u7-registration-")));
process.env.GHL_LATCH_STATE_DIR = join(root, "latch");
process.env.GHL_ORCH_ROOT = join(root, "legacy-empty");
mkdirSync(process.env.GHL_LATCH_STATE_DIR, { recursive: true });
mkdirSync(process.env.GHL_ORCH_ROOT, { recursive: true });
const { default: registerLatch } = await import("../src/pr-await-latch.ts");

function harness(_repo: RepoIdentity, stateRoot: string, exec: (file: string, args: string[]) => Promise<{ code?: number; stdout?: string; stderr?: string }> = async () => ({ code: 1, stdout: "", stderr: "no remote calls" })) {
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
    exec: (file: string, args: string[]) => exec(file, args),
    sendUserMessage() {},
  };
  const sessionFile = join(root, "parent.jsonl"); writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "parent" }) + "\n");
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "session", getSessionFile: () => sessionFile }, isIdle: () => true, ui: { notify() {}, setStatus() {}, setTitle() {}, setWidget() {} } };
  registerLatch(pi as any, { watchMs: 0, chromeMs: 0, watchStateDir: false, featureOwnedPr: () => undefined });
  return { events, handlers, launchIntents, sessionFile, ctx, stateRoot, pi };
}

async function runDefaultBootstrapCase(input: {
  fetch?: string; push?: string; expanded?: string; approved?: string; missingOrigin?: boolean; approvePublication?: boolean; changeAfterPreview?: boolean; mutateFence?: "owner" | "lifecycle";
} = {}): Promise<{ pushes: number; creates: number; state: ReturnType<ReturnType<typeof createExecutionBridge>["store"]["read"]> }> {
  const localRoot = realpathSync(mkdtempSync(join(tmpdir(), "u7-default-case-")));
  process.env.GHL_LATCH_STATE_DIR = join(localRoot, "latch"); mkdirSync(process.env.GHL_LATCH_STATE_DIR, { recursive: true });
  const commonDir = join(localRoot, "repo.git"); mkdirSync(commonDir, { recursive: true });
  const repo = { commonDir, id: digest(commonDir) }, stateRoot = join(localRoot, "orchestrator"), ownedRoot = join(localRoot, "owned"); mkdirSync(ownedRoot);
  const planPath = join(localRoot, "plan.md"); writeFileSync(planPath, "# approved plan\n");
  const baseCommit = "a".repeat(40), integratedHead = "c".repeat(40), approved = input.approved ?? "github.com/acme/approved";
  const group: DeliveryGroup = { id: "group-default-case", featureIds: ["feature-default-case"], requiredTaskIds: [], checks: [], policy: "pr", completion: "merged", ownerId: "execution-default-case" };
  const task = { id: "task-default-case", featureId: group.featureIds[0]!, deliveryGroupId: group.id, text: "bootstrap", mode: "read-only" as const, dependencies: [], scope: ["src"], profile: {}, checks: [], provenance: ["text", "mode", "dependencies", "scope", "profile", "deliveryGroupId"].map(field => ({ field, origin: "inferred" as const, reason: "fixture" })) };
  const manifestFor = (source: { path: string; bytes: string; digest: string }, id: string, revision: number): ExecutionManifest => ({
    schemaVersion: 1, id, revision, source, repo, baseCommit, scope: "src", preset: "plan-driven",
    features: [{ id: group.featureIds[0]!, title: "Default case", scope: "src" }], deliveryGroups: [group], tasks: [task],
    constraints: { capacity: 1, parallelGroups: [], provenance: [{ field: "capacity", origin: "inferred" as const, reason: "fixture" }] }, provenance: ["scope", "features", "deliveryGroups"].map(field => ({ field, origin: "inferred" as const, reason: "fixture" })),
  });
  const workspaces = new FakeWorkspaceAdapter();
  workspaces.inspect = async candidate => ({ kind: "inspected", workspace: candidate, head: workspaces.compositions.length ? integratedHead : baseCommit, clean: true, appliedDigests: [] });
  let fenceMutated = false;
  let bridge: ReturnType<typeof createExecutionBridge> | undefined;
  workspaces.compose = async request => { workspaces.compositions.push(structuredClone(request)); return { kind: "prepared", workspace: request.intent.workspace, head: integratedHead }; };
  let currentFetch = input.fetch ?? `https://${approved}.git`, currentPush = input.push ?? currentFetch, pushes = 0, creates = 0;
  const h = harness(repo, stateRoot, async (file, args) => {
    if (file === "git" && args[0] === "remote" && args[1] === "get-url") {
      if (!fenceMutated && input.mutateFence && bridge) {
        const current = bridge.store.read();
        if (current.owner) {
          bridge.store.transact(current.owner, draft => {
            if (input.mutateFence === "owner") draft.reconciledEpoch = current.owner!.epoch + 1;
            if (input.mutateFence === "lifecycle") { const delivery = draft.deliveries.find(item => item.groupId === group.id); if (delivery) delivery.phase = "blocked"; }
          });
          fenceMutated = true;
        }
      }
      if (input.missingOrigin) return { code: 1, stdout: "", stderr: "no origin" };
      return { code: 0, stdout: `${args.includes("--push") ? currentPush : currentFetch}\n`, stderr: "" };
    }
    if (file === "git" && args[0] === "ls-remote" && args[1] === "--get-url") return { code: 0, stdout: `${input.expanded ?? currentFetch}\n`, stderr: "" };
    if (file === "gh" && args[0] === "pr" && args[1] === "list") return { code: 0, stdout: "[]", stderr: "" };
    if (file === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${integratedHead}\n`, stderr: "" };
    if (file === "git" && args[0] === "branch") return { code: 0, stdout: `${bridge?.store.read().controllerBootstrapIntents?.[0]?.branch ?? "branch"}\n`, stderr: "" };
    if (file === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (file === "git" && args[0] === "push") { pushes++; return { code: 0, stdout: "", stderr: "" }; }
    if (file === "gh" && args[0] === "pr" && args[1] === "create") { creates++; return { code: 0, stdout: "", stderr: "" }; }
    return { code: 1, stdout: "", stderr: `unexpected ${file} ${args.join(" ")}` };
  });
  const binding = await requestExecutionController(h.events, { repo, stateRoot, sessionFile: h.sessionFile });
  assert.ok(binding);
  bridge = createExecutionBridge({
    pi: h.pi, repo, referencePath: localRoot, stateRoot, sessionFile: h.sessionFile, processStart: "u7-default-case", capacity: 2, baseCommit, ownedRoot,
    runtime: new FakeAttemptRuntime(), workspaces, checks: new FakeCheckExecutor(), controller: binding, resolvePr: binding!.resolvePr, repository: approved,
    git: async (_cwd: string, argv: string[]) => ({ exitCode: 0, stdout: argv[0] === "rev-parse" ? `${baseCommit}\n` : "", stderr: "" }),
    interpretationTransport: async (request: any) => ({ manifest: manifestFor(request.source, request.identity.id, request.identity.revision), unresolvedDecisions: [] }),
  } as any);
  (bridge.scheduler as any).admission = async () => {};
  try {
    const preview = await bridge.run(planPath); assert.equal(preview.kind, "approval-required", JSON.stringify(preview));
    if (preview.kind === "approval-required") {
      if (input.changeAfterPreview) currentFetch = currentPush = `https://github.com/acme/changed.git`;
      const started = await bridge.run(planPath, { token: preview.preview.token, capacity: 2, publication: input.approvePublication ?? true, publicationRepository: approved, approvedBy: h.sessionFile, approvedAt: 2 });
      if (started.kind === "started") for (let i = 0; i < (input.mutateFence ? 0 : 4); i++) { await new Promise(resolve => setTimeout(resolve, 25)); await bridge.scheduler.reconcile(); }
    }
    return { pushes, creates, state: bridge.store.read() };
  } finally { await bridge.shutdown(); }
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

test("production bridge bootstraps a first PR mapping from an approved plan with no seeded mapping or obligation", async () => {
  const localRoot = realpathSync(mkdtempSync(join(tmpdir(), "u7-bootstrap-")));
  process.env.GHL_LATCH_STATE_DIR = join(localRoot, "latch"); mkdirSync(process.env.GHL_LATCH_STATE_DIR, { recursive: true });
  const commonDir = join(localRoot, "repo.git"); mkdirSync(commonDir, { recursive: true });
  const repo = { commonDir, id: digest(commonDir) };
  const stateRoot = join(localRoot, "orchestrator"), ownedRoot = join(localRoot, "owned"); mkdirSync(ownedRoot);
  const planPath = join(localRoot, "plan.md"); writeFileSync(planPath, "# approved plan\n");
  const baseCommit = "a".repeat(40), integratedHead = "c".repeat(40);
  const feature = { id: "feature-bootstrap", title: "Bootstrap", scope: "src" };
  const sharedFeature = { id: "feature-bootstrap-shared", title: "Shared", scope: "src" };
  const group: DeliveryGroup = { id: "group-bootstrap", featureIds: [feature.id, sharedFeature.id], requiredTaskIds: [], checks: [], policy: "pr", completion: "merged", ownerId: "execution-bootstrap" };
  const task = { id: "task-bootstrap", featureId: feature.id, deliveryGroupId: group.id, text: "bootstrap", mode: "read-only" as const, dependencies: [], scope: ["src"], profile: {}, checks: [], provenance: ["text", "mode", "dependencies", "scope", "profile", "deliveryGroupId"].map(field => ({ field, origin: "inferred" as const, reason: "fixture" })) };
  const makeManifest = (identity: { id: string; revision: number; repo: RepoIdentity; baseCommit: string; source: { path: string; bytes: string; digest: string } }): ExecutionManifest => ({
    schemaVersion: 1, id: identity.id, revision: identity.revision, source: identity.source, repo: identity.repo, baseCommit: identity.baseCommit,
    scope: "src", preset: "plan-driven", features: [feature, sharedFeature], deliveryGroups: [group], tasks: [task],
    constraints: { capacity: 1, parallelGroups: [], provenance: [{ field: "capacity", origin: "inferred" as const, reason: "fixture" }] },
    provenance: ["scope", "features", "deliveryGroups"].map(field => ({ field, origin: "inferred" as const, reason: "fixture" })),
  });
  let deliveryWorkspace: WorkspaceRef | undefined;
  const workspaces = new FakeWorkspaceAdapter();
  workspaces.inspect = async candidate => {
    deliveryWorkspace = deliveryWorkspace ?? candidate;
    const head = workspaces.compositions.length ? integratedHead : baseCommit;
    return { kind: "inspected", workspace: candidate, head, clean: true, appliedDigests: [] };
  };
  workspaces.compose = async request => {
    workspaces.compositions.push(structuredClone(request));
    deliveryWorkspace = request.intent.workspace;
    return { kind: "prepared", workspace: request.intent.workspace, head: integratedHead };
  };
  const h = harness(repo, stateRoot);
  const initialState = createExecutionStore({ stateRoot: join(stateRoot, "plan-driven-v1"), repo }).read();
  assert.equal(initialState.controllerMappings?.length ?? 0, 0, "regression starts with no controller mapping");
  assert.equal(createReviewStore(process.env.GHL_LATCH_STATE_DIR!).list().length, 0, "regression starts with no controller obligation");
  const binding = await requestExecutionController(h.events, { repo, stateRoot, sessionFile: h.sessionFile });
  assert.ok(binding, "actual registered latch must provide the controller binding");
  let remoteCalls = 0, creates = 0;
  const bootstrapPr = {
    discover: async (request: any) => {
      assert.equal(request.group.id, group.id);
      assert.equal(request.branch, request.workspace.branch);
      assert.equal(request.head, integratedHead);
      assert.equal(request.repository, "github.com/acme/bootstrap");
      remoteCalls++;
      if (remoteCalls === 1) return { kind: "not-found" as const };
      return { kind: "found" as const, pr: { repo: "github.com/acme/bootstrap", number: 17 }, branch: request.workspace.branch, head: integratedHead };
    },
    create: async (request: any) => {
      assert.equal(request.repository, "github.com/acme/bootstrap");
      creates++;
      return { kind: "unknown" as const, reason: "create acknowledgement lost" };
    },
  };
  const runtime = new FakeAttemptRuntime();
  const bridge = createExecutionBridge({
    repo, referencePath: localRoot, stateRoot, sessionFile: h.sessionFile, processStart: "u7-bootstrap", capacity: 2, ownedRoot,
    runtime, workspaces, checks: new FakeCheckExecutor(), controller: binding, resolvePr: binding!.resolvePr,
    bootstrapPr, repository: "github.com/acme/bootstrap", git: async (_cwd: string, argv: string[]) => ({ exitCode: 0, stdout: argv[0] === "rev-parse" ? `${baseCommit}\n` : "", stderr: "" }),
    interpretationTransport: async (request: any) => ({ manifest: makeManifest({ id: request.identity.id, revision: request.identity.revision, repo: request.identity.repo, baseCommit: request.identity.baseCommit, source: request.source }), unresolvedDecisions: [] }),
  } as any);
  // This fixture exercises the real delivery path with a non-required task;
  // suppress only unrelated task admission so no worker completion is faked.
  (bridge.scheduler as any).admission = async () => {};
  const preview = await bridge.run(planPath);
  assert.equal(preview.kind, "approval-required", JSON.stringify(preview));
  if (preview.kind !== "approval-required") return;
  const started = await bridge.run(planPath, { token: preview.preview.token, capacity: 2, publication: true, publicationRepository: "github.com/acme/bootstrap", approvedBy: h.sessionFile, approvedAt: 2 });
  assert.equal(started.kind, "started", JSON.stringify(started));
  for (let i = 0; i < 120 && bridge.store.read().deliveries[0]?.phase !== "controller-owned"; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const state = bridge.store.read();
  assert.equal(state.deliveries[0]?.phase, "controller-owned", JSON.stringify(bridge.status()));
  assert.equal(state.controllerMappings?.length, 1, "production code must create the initial mapping");
  assert.equal(state.controllerMappings?.[0]?.groupId, group.id);
  assert.equal(state.controllerMappings?.[0]?.pr.number, 17);
  assert.equal(state.controllerMappings?.[0]?.head, integratedHead);
  assert.equal(creates, 1);
  assert.equal(remoteCalls, 2, "lost create acknowledgement must reconcile the same deterministic PR before handoff");
  assert.equal(state.controllerBootstrapIntents?.length, 1);
  assert.equal(state.controllerBootstrapIntents?.[0]?.phase, "complete");
  const verdict = binding!.controller.observeVerdict({ pr: { host: "github.com", owner: "acme", repo: "bootstrap", number: "17" }, next: "read_comments_and_fix", body: `next=read_comments_and_fix\\nhead=${integratedHead}`, head: integratedHead });
  assert.equal(verdict.accepted, true);
  const launched = await binding!.controller.reconcile();
  assert.equal(launched.launched, 1);
  assert.equal(h.launchIntents[0]?.owner.kind, "execution");
  const mapping = structuredClone(state.controllerMappings![0]);
  await bridge.shutdown();
  const restarted = createExecutionBridge({
    repo, referencePath: localRoot, stateRoot, sessionFile: h.sessionFile, processStart: "u7-bootstrap-restart", capacity: 2, ownedRoot,
    runtime: new FakeAttemptRuntime(), workspaces, checks: new FakeCheckExecutor(), controller: binding, resolvePr: binding!.resolvePr,
    bootstrapPr, repository: "github.com/acme/bootstrap", git: async (_cwd: string, argv: string[]) => ({ exitCode: 0, stdout: argv[0] === "rev-parse" ? `${baseCommit}\n` : "", stderr: "" }),
    interpretationTransport: async () => { throw new Error("restart must not reinterpret"); },
  } as any);
  await restarted.start({ resumePriorOwner: true });
  assert.deepEqual(restarted.store.read().controllerMappings?.[0], mapping);
  assert.equal(creates, 1, "restart must reuse the durable mapping, not create a second PR");
  await restarted.shutdown();
});

test("default publication rejects missing, invalid, foreign, and ambiguous destinations before effects", async () => {
  for (const input of [
    { missingOrigin: true },
    { fetch: "not-a-repository", push: "not-a-repository" },
    { fetch: "https://github.com/acme/foreign.git", push: "https://github.com/acme/foreign.git" },
    { fetch: "https://github.com/acme/approved.git", push: "https://github.com/acme/other.git" },
    { fetch: "https://github.com/acme/approved.git", push: "https://github.com/acme/approved.git\nhttps://github.com/acme/other.git" },
  ]) {
    const result = await runDefaultBootstrapCase(input);
    assert.equal(result.pushes, 0, JSON.stringify(input));
    assert.equal(result.creates, 0, JSON.stringify(input));
  }
});

test("default publication consults the rewrite-aware ls-remote expansion and refuses divergence", async () => {
  // git ls-remote --get-url is the documented insteadOf-expansion lookup. When
  // its expanded fetch destination diverges from the configured remote URL
  // (here: insteadOf rewrites onto a foreign gh-alias host), the configured
  // URLs would bind an approval slug the transport never reaches.
  const result = await runDefaultBootstrapCase({ expanded: "git@gh-alias:acme/elsewhere.git" });
  assert.equal(result.pushes, 0, "a rewritten expanded destination must refuse publication before any effect");
  assert.equal(result.creates, 0, "a rewritten expanded destination must refuse PR creation");
});

test("default publication accepts insteadOf- and pushInsteadOf-expanded destinations that canonicalize to the approved slug", async () => {
  // insteadOf rewrites the fetch URL into scp form; pushInsteadOf rewrites the
  // push URL into ssh:// form on the same host; the expanded lookup agrees with
  // the fetch URL. Every destination still canonicalizes to the approved slug.
  const ok = await runDefaultBootstrapCase({
    fetch: "git@github.com:acme/approved.git",
    push: "ssh://git@github.com/acme/approved.git",
    expanded: "git@github.com:acme/approved.git",
  });
  assert.equal(ok.pushes, 1, "rewrite-expanded destinations that match the approved slug must publish");
  assert.equal(ok.creates, 1);
});

test("default publication refuses a pushInsteadOf expansion that retargets a foreign host", async () => {
  const result = await runDefaultBootstrapCase({ push: "git@ssh.foreign-host.dev:acme/approved.git" });
  assert.equal(result.pushes, 0, "a pushInsteadOf host rewrite must never push to an unapproved host");
  assert.equal(result.creates, 0);
});

test("missing publication approval and destination changes after preview refuse before effects", async () => {
  const missing = await runDefaultBootstrapCase({ approvePublication: false });
  assert.equal(missing.pushes, 0);
  assert.equal(missing.creates, 0);
  const changed = await runDefaultBootstrapCase({ changeAfterPreview: true });
  assert.equal(changed.pushes, 0);
  assert.equal(changed.creates, 0);
  for (const mutateFence of ["owner", "lifecycle"] as const) {
    const fenced = await runDefaultBootstrapCase({ mutateFence });
    assert.equal(fenced.pushes, 0, mutateFence);
    assert.equal(fenced.creates, 0, mutateFence);
  }
});

test("default bootstrap creates once, fences unknown retries, then discovers the same PR", async () => {
  const localRoot = realpathSync(mkdtempSync(join(tmpdir(), "u7-default-bootstrap-")));
  process.env.GHL_LATCH_STATE_DIR = join(localRoot, "latch"); mkdirSync(process.env.GHL_LATCH_STATE_DIR, { recursive: true });
  const commonDir = join(localRoot, "repo.git"); mkdirSync(commonDir, { recursive: true });
  const repo = { commonDir, id: digest(commonDir) }, stateRoot = join(localRoot, "orchestrator"), ownedRoot = join(localRoot, "owned"); mkdirSync(ownedRoot);
  const planPath = join(localRoot, "plan.md"); writeFileSync(planPath, "# approved plan\n");
  const baseCommit = "a".repeat(40), integratedHead = "c".repeat(40);
  const group: DeliveryGroup = { id: "group-default-bootstrap", featureIds: ["feature-default-bootstrap"], requiredTaskIds: [], checks: [], policy: "pr", completion: "merged", ownerId: "execution-default-bootstrap" };
  const task = { id: "task-default-bootstrap", featureId: group.featureIds[0]!, deliveryGroupId: group.id, text: "bootstrap", mode: "read-only" as const, dependencies: [], scope: ["src"], profile: {}, checks: [], provenance: ["text", "mode", "dependencies", "scope", "profile", "deliveryGroupId"].map(field => ({ field, origin: "inferred" as const, reason: "fixture" })) };
  const makeManifest = (identity: { id: string; revision: number; repo: RepoIdentity; baseCommit: string; source: { path: string; bytes: string; digest: string } }): ExecutionManifest => ({
    schemaVersion: 1, id: identity.id, revision: identity.revision, source: identity.source, repo: identity.repo, baseCommit: identity.baseCommit,
    scope: "src", preset: "plan-driven", features: [{ id: group.featureIds[0]!, title: "Default bootstrap", scope: "src" }], deliveryGroups: [group], tasks: [task],
    constraints: { capacity: 1, parallelGroups: [], provenance: [{ field: "capacity", origin: "inferred" as const, reason: "fixture" }] }, provenance: ["scope", "features", "deliveryGroups"].map(field => ({ field, origin: "inferred" as const, reason: "fixture" })),
  });
  const workspaces = new FakeWorkspaceAdapter();
  workspaces.inspect = async candidate => ({ kind: "inspected", workspace: candidate, head: workspaces.compositions.length ? integratedHead : baseCommit, clean: true, appliedDigests: [] });
  workspaces.compose = async request => { workspaces.compositions.push(structuredClone(request)); return { kind: "prepared", workspace: request.intent.workspace, head: integratedHead }; };
  let branch = "", listCalls = 0, pushCalls = 0, createCalls = 0, phaseAtPush = "";
  let bridge: ReturnType<typeof createExecutionBridge> | undefined;
  const h = harness(repo, stateRoot, async (file, args) => {
    if (file === "git" && args[0] === "remote" && args[1] === "get-url") return { code: 0, stdout: "https://github.com/acme/bootstrap.git\n", stderr: "" };
    if (file === "git" && args[0] === "ls-remote" && args[1] === "--get-url") return { code: 0, stdout: "https://github.com/acme/bootstrap.git\n", stderr: "" };
    if (file === "gh" && args[0] === "pr" && args[1] === "list") {
      listCalls++;
      assert.equal(args[args.indexOf("--repo") + 1], "github.com/acme/bootstrap");
      const head = args[args.indexOf("--head") + 1]!; branch ||= head;
      if (listCalls < 4) return { code: 0, stdout: "[]", stderr: "" };
      return { code: 0, stdout: JSON.stringify([{ number: 17, url: "https://github.com/acme/bootstrap/pull/17", headRefName: branch, headRefOid: integratedHead }]), stderr: "" };
    }
    if (file === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${integratedHead}\n`, stderr: "" };
    if (file === "git" && args[0] === "branch") return { code: 0, stdout: `${branch}\n`, stderr: "" };
    if (file === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (file === "git" && args[0] === "push") { pushCalls++; phaseAtPush = bridge?.store.read().controllerBootstrapIntents?.[0]?.phase ?? ""; return { code: 0, stdout: "", stderr: "" }; }
    if (file === "gh" && args[0] === "pr" && args[1] === "create") { createCalls++; assert.equal(args[args.indexOf("--repo") + 1], "github.com/acme/bootstrap"); return { code: 0, stdout: "", stderr: "" }; }
    return { code: 1, stdout: "", stderr: `unexpected ${file} ${args.join(" ")}` };
  });
  const binding = await requestExecutionController(h.events, { repo, stateRoot, sessionFile: h.sessionFile });
  assert.ok(binding);
  bridge = createExecutionBridge({
    pi: h.pi, repo, referencePath: localRoot, stateRoot, sessionFile: h.sessionFile, processStart: "u7-default-bootstrap", capacity: 2, baseCommit, ownedRoot,
    runtime: new FakeAttemptRuntime(), workspaces, checks: new FakeCheckExecutor(), controller: binding, resolvePr: binding!.resolvePr, repository: "github.com/acme/bootstrap",
    git: async (_cwd: string, argv: string[]) => ({ exitCode: 0, stdout: argv[0] === "rev-parse" ? `${baseCommit}\n` : "", stderr: "" }),
    interpretationTransport: async (request: any) => ({ manifest: makeManifest({ id: request.identity.id, revision: request.identity.revision, repo: request.identity.repo, baseCommit: request.identity.baseCommit, source: request.source }), unresolvedDecisions: [] }),
  } as any);
  (bridge.scheduler as any).admission = async () => {};
  try {
    const preview = await bridge.run(planPath); assert.equal(preview.kind, "approval-required", JSON.stringify(preview)); if (preview.kind !== "approval-required") return;
    const started = await bridge.run(planPath, { token: preview.preview.token, capacity: 2, publication: true, publicationRepository: "github.com/acme/bootstrap", approvedBy: h.sessionFile, approvedAt: 2 });
    assert.equal(started.kind, "started", JSON.stringify(started));
    await new Promise(resolve => setTimeout(resolve, 25));
    await bridge.scheduler.reconcile();
    const beforeRestart = bridge.store.read();
    assert.equal(createCalls, 1);
    assert.equal(pushCalls, 1);
    assert.equal(phaseAtPush, "creating");
    assert.equal(beforeRestart.controllerBootstrapIntents?.[0]?.phase, "unknown");
    await bridge.shutdown();
    bridge = createExecutionBridge({
      pi: h.pi, repo, referencePath: localRoot, stateRoot, sessionFile: h.sessionFile, processStart: "u7-default-bootstrap-restart", capacity: 2, baseCommit, ownedRoot,
      runtime: new FakeAttemptRuntime(), workspaces, checks: new FakeCheckExecutor(), controller: binding, resolvePr: binding!.resolvePr, repository: "github.com/acme/bootstrap",
      git: async (_cwd: string, argv: string[]) => ({ exitCode: 0, stdout: argv[0] === "rev-parse" ? `${baseCommit}\n` : "", stderr: "" }),
      interpretationTransport: async () => { throw new Error("restart must not reinterpret"); },
    } as any);
    (bridge.scheduler as any).admission = async () => {};
    await bridge.start({ resumePriorOwner: true });
    for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 25)); await bridge.scheduler.reconcile(); }
    const state = bridge.store.read();
    assert.equal(state.controllerBootstrapIntents?.[0]?.phase, "complete");
    assert.deepEqual(state.controllerBootstrapIntents?.[0]?.pr, { repo: "github.com/acme/bootstrap", number: 17 });
    assert.equal(state.controllerMappings?.[0]?.pr.number, 17);
    assert.equal(createCalls, 1, "restart retries discovery only after unknown creation outcome");
  } finally { await bridge.shutdown(); }
});
