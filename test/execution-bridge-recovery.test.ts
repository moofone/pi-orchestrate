import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createExecutionBridge, type ExecutionBridge } from "../src/lib/execution-bridge.ts";
import { decodeRuntimeStatus } from "../src/lib/attempt-runtime.ts";
import { digest, type TerminalOutput, type DeliveryAdapter } from "../src/lib/execution-contract.ts";
import { createCoordinatorOwner } from "../src/lib/execution-store.ts";
import type { SchedulerOptions } from "../src/lib/execution-scheduler.ts";
import { TaskWorkspaces, type WorkspaceGit, type WorkspaceJournal } from "../src/lib/task-workspaces.ts";
import { admitFakeManifest, fakeAttempt, fakeManifest, fakeReservation, FakeAttemptRuntime } from "./fixtures/execution/fakes.ts";

// White-box adapter access only: production construction, not permissive receipt/workspace predicates.
const ports = (bridge: ExecutionBridge) => (bridge.scheduler as unknown as { options: SchedulerOptions }).options;
function git(cwd: string, args: readonly string[]): string {
 assert.ok(!["reset", "restore", "checkout", "switch", "clean", "rebase", "symbolic-ref"].includes(args[0]!));
 return execFileSync("git", [...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" }, stdio: ["ignore", "pipe", "pipe"] });
}
function commit(cwd: string, name: string): string {
 mkdirSync(join(cwd, "src"), { recursive: true }); writeFileSync(join(cwd, "src", name), name);
 git(cwd, ["add", `src/${name}`]); git(cwd, ["commit", "-m", name]); return git(cwd, ["rev-parse", "HEAD"]).trim();
}
function fixture(mode: "mutation" | "read-only" = "mutation", policy: "local" | "pr" = "local") {
 const root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-recovery-"))), referencePath = join(root, "reference"), ownedRoot = join(root, "owned"), sessionFile = join(root, "session.jsonl");
 mkdirSync(referencePath); mkdirSync(ownedRoot); writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "owner" }) + "\n");
 git(referencePath, ["init", "--initial-branch=main"]); const base = commit(referencePath, "base");
 const commonDir = realpathSync(join(referencePath, ".git")), repo = { commonDir, id: digest(commonDir) }, runtime = new FakeAttemptRuntime();
 runtime.capabilities.available = false;
 const calls: string[][] = [];
 const adapter: WorkspaceGit = async (cwd, argv) => {
  calls.push([...argv]);
  try {
   // Only the installed git-wt provisioning boundary is injected. Real linked Git workspaces.
   const args = argv[0] === "wt" ? ["worktree", "add", "-b", argv[1]!, join(ownedRoot, argv[1]!), argv[3]!] : argv;
   return { exitCode: 0, stdout: git(cwd, args), stderr: "" };
  } catch (error) { return { exitCode: 1, stdout: "", stderr: String(error) }; }
 };
 const options = { repo, referencePath, stateRoot: root, ownedRoot, sessionFile, runtime, git: adapter, capacity: 2, interpretationTransport: async () => { throw new Error("Recovery must not preview/fetch"); } };
 const bridge = createExecutionBridge(options), manifest = fakeManifest(); manifest.repo = repo; manifest.baseCommit = base; manifest.tasks[0]!.mode = mode; manifest.deliveryGroups[0]!.policy = policy; manifest.deliveryGroups[0]!.completion = policy === "pr" ? "merged" : "validated";
 const attempt = fakeAttempt(manifest); attempt.ownerSessionFile = sessionFile;
 attempt.workspace = { ...attempt.workspace, path: join(ownedRoot, attempt.workspace.branch) };
 const owner = bridge.store.acquire(createCoordinatorOwner(sessionFile, "bootstrap")); bridge.store.markReconciled(owner);
 bridge.store.transact(owner, state => { state.capacity = 2; admitFakeManifest(state, manifest); state.authorizations[0]!.publication = policy === "pr"; state.attempts.push(attempt); state.reservations.push(fakeReservation(attempt)); state.tasks[0]!.attemptIds = [attempt.id]; state.tasks[0]!.phase = "preparing"; });
 const workspace = new TaskWorkspaces({ repo, referencePath, ownedRoot, git: adapter, owns: async () => true, isFetchedBase: async value => value === base, readJournal: async id => bridge.store.readWorkspaceJournal(id), writeJournal: async (j, expected, writer) => bridge.store.writeWorkspaceJournal(owner, j, expected, writer ?? { attemptId: attempt.id }), resolveReceipt: async () => undefined, isEligibleReceipt: async () => false });
 async function prepare() {
  const result = await workspace.prepare({ attemptId: attempt.id, workspace: attempt.workspace, prerequisites: [] });
  assert.equal(result.kind, "prepared", JSON.stringify(result));
  if (result.kind === "prepared") attempt.preparedHead = result.head;
 }
 function terminal(output?: TerminalOutput) {
  const artifactDir = join(root, "run"); mkdirSync(artifactDir, { recursive: true });
  const run = { runId: "run", artifactDir, ownerSessionFile: sessionFile };
  const status = { lifecycleArtifactVersion: 3, runId: run.runId, sessionId: "owner", mode: "single", state: "complete", endedAt: 2, steps: [{ status: "complete", ...(output ? { structuredOutput: output } : {}) }], processTerminal: { version: 1, runId: run.runId, runnerProcessInstanceId: "process", state: "observed", observedAt: 2, instances: [{ kind: "runner", processInstanceId: "process", closeObservedAt: 2, exitCode: 0, signal: null }] } };
  writeFileSync(join(artifactDir, "status.json"), JSON.stringify(status));
  const observed = decodeRuntimeStatus(JSON.stringify(status), run, "owner", 3); assert.equal(observed.kind, "known-terminal");
  if (observed.kind !== "known-terminal") throw new Error("fixture proof");
  attempt.run = run; attempt.terminal = observed.evidence; attempt.phase = "validating";
  return observed;
 }
 function persist(phase = attempt.phase) {
  attempt.phase = phase;
  if (["running", "validating"].includes(phase)) bridge.store.transact(owner, state => { state.attempts[0]!.phase = "launching"; });
  bridge.store.transact(owner, state => { state.attempts[0] = structuredClone(attempt); state.tasks[0]!.phase = phase; });
  bridge.store.relinquish(owner);
 }
 return { root, base, referencePath, ownedRoot, sessionFile, options, bridge, manifest, attempt, owner, runtime, calls, prepare, terminal, persist };
}
async function settle(bridge: ExecutionBridge) {
 for (let i = 0; i < 120; i++) {
  const a = bridge.store.read().attempts[0]!;
  if (["succeeded", "recovery-needed"].includes(a.phase)) return a;
  await new Promise(resolve => setTimeout(resolve, 10));
 }
 throw new Error(`Timed out: ${JSON.stringify(bridge.status())}`);
}

test("bridge journal callbacks require an owner and cannot race past CAS", async () => {
 const f = fixture();
 const workspace = ports(f.bridge).workspaces as TaskWorkspaces;
 const j: WorkspaceJournal = { workspace: f.attempt.workspace, operationId: `prepare:${f.attempt.id}`, phase: "pending", before: f.base, head: f.base, inputDigests: [], appliedDigests: [] };
 const unowned = await Promise.allSettled([workspace.options.writeJournal(j, undefined, { attemptId: f.attempt.id }), workspace.options.writeJournal(j, undefined, { attemptId: f.attempt.id })]);
 assert.equal(unowned.filter(r => r.status === "fulfilled").length, 0, "no bridge owner bound yet");
 f.persist("preparing"); await f.bridge.start();
 const outcomes = await Promise.allSettled([workspace.options.writeJournal(j, undefined, { attemptId: f.attempt.id }), workspace.options.writeJournal(j, undefined, { attemptId: f.attempt.id })]);
 assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
 await f.bridge.shutdown();
 await assert.rejects(workspace.options.writeJournal({ ...j, phase: "complete" }, j, { attemptId: f.attempt.id }), /owner/);
});

test("bridge real mutation receipt uses the durable prepared head, not terminal HEAD", async () => {
 const f = fixture(); await f.prepare(); const head = commit(f.attempt.workspace.path, "result"); f.terminal({ kind: "commits", commit: head }); f.persist();
 await f.bridge.start();
 try {
  const attempt = await settle(f.bridge); assert.equal(attempt.phase, "succeeded", attempt.reason ?? "");
  const output = f.bridge.store.read().results[0]!.output;
  assert.deepEqual(output, { kind: "commits", from: f.base, to: head, commits: [head], paths: ["src/result"] });
  assert.ok(!f.calls.some(c => c[0] === "fetch"));
 } finally { await f.bridge.shutdown(); }
});

test("bridge refuses later HEAD movement instead of inferring another terminal output", async () => {
 const f = fixture(); await f.prepare(); const head = commit(f.attempt.workspace.path, "result"); f.terminal({ kind: "commits", commit: head }); commit(f.attempt.workspace.path, "later"); f.persist();
 await f.bridge.start();
 try { const attempt = await settle(f.bridge); assert.equal(attempt.phase, "recovery-needed"); assert.match(attempt.reason!, /output commit/); assert.equal(f.bridge.store.read().results.length, 0); }
 finally { await f.bridge.shutdown(); }
});

for (const legacy of [false, true]) test(`bridge read-only frozen artifact resists replaced descriptor/bytes (legacy=${legacy})`, async () => {
 const f = fixture("read-only"); await f.prepare(); mkdirSync(join(f.root, "run")); const path = join(f.root, "run", "report.md"); writeFileSync(path, "original");
 const output: TerminalOutput = { kind: "artifact", path, digest: createHash("sha256").update("original").digest("hex") }; f.terminal(output);
 if (legacy) delete f.attempt.terminal!.output;
 writeFileSync(path, "replacement"); writeFileSync(join(f.root, "run", "result.json"), JSON.stringify({ path, digest: createHash("sha256").update("replacement").digest("hex") }));
 f.persist(); await f.bridge.start();
 try { const attempt = await settle(f.bridge); assert.equal(attempt.phase, "recovery-needed"); assert.match(attempt.reason!, /artifact|terminal result/i); assert.equal(f.bridge.store.read().results.length, 0); }
 finally { await f.bridge.shutdown(); }
});

for (const change of ["none", "status", "missing-output"] as const) test(`bridge legacy terminal output requires exact status digest (${change})`, async () => {
 const f = fixture("read-only"); await f.prepare(); mkdirSync(join(f.root, "run")); const path = join(f.root, "run", "report.md"); writeFileSync(path, "original");
 f.terminal(change === "missing-output" ? undefined : { kind: "artifact", path, digest: createHash("sha256").update("original").digest("hex") }); delete f.attempt.terminal!.output;
 if (change === "status") { const statusPath = join(f.root, "run", "status.json"), status = JSON.parse(readFileSync(statusPath, "utf8")); status.steps[0].structuredOutput.digest = "a".repeat(64); writeFileSync(statusPath, JSON.stringify(status)); }
 f.persist(); await f.bridge.start();
 try { const attempt = await settle(f.bridge); assert.equal(attempt.phase, change === "none" ? "succeeded" : "recovery-needed", attempt.reason ?? ""); if (change !== "none") assert.match(attempt.reason!, /terminal.*output|status.*changed/i); }
 finally { await f.bridge.shutdown(); }
});

for (const phase of ["running", "preparing", "validating", "recovery-needed"] as const) test(`bridge restart without preview restores historical bases and ${phase} recovery`, async () => {
 const f = fixture(); await f.prepare(); const head = commit(f.attempt.workspace.path, "result"); const observation = f.terminal({ kind: "commits", commit: head });
 if (phase === "running") { delete f.attempt.terminal; f.runtime.observations.set(f.attempt.id, observation); }
 if (phase === "preparing") { delete f.attempt.terminal; delete f.attempt.run; }
 f.persist(phase);
 // Add a second authorized historical revision at a different base without changing this attempt.
 const seed = f.bridge.store.acquire(createCoordinatorOwner(f.sessionFile, "revision")); f.bridge.store.markReconciled(seed);
 const newer = structuredClone(f.manifest); newer.revision++; newer.baseCommit = commit(f.referencePath, "new-base");
 f.bridge.store.transact(seed, state => { const approval = { ...state.authorizations[0]!, id: "new-approval", revision: newer.revision, baseCommit: newer.baseCommit, manifestDigest: digest(newer) }; state.manifests.push(newer); state.authorizations.push(approval); state.activeRevisions[newer.id] = newer.revision; });
 f.bridge.store.relinquish(seed);
 const restarted = createExecutionBridge(f.options); await restarted.start();
 try {
  const result = await ports(restarted).workspaces.inspect(f.attempt.workspace); assert.equal(result.kind, "inspected", JSON.stringify(result));
  if (phase !== "preparing") assert.equal((await settle(restarted)).phase, "succeeded", JSON.stringify(restarted.status()));
  else { assert.equal((await settle(restarted)).phase, "recovery-needed"); assert.equal(f.runtime.launches.length, 0); assert.equal(restarted.store.read().reservations.length, 1); }
 } finally { await restarted.shutdown(); }
});

test("bridge transient receipt failure is retryable without relaunch or reservation loss", async () => {
 const f = fixture(); await f.prepare(); const head = commit(f.attempt.workspace.path, "result"); f.terminal({ kind: "commits", commit: head }); f.persist();
 const original = ports(f.bridge).createReceipt; let fail = true;
 ports(f.bridge).createReceipt = async input => { if (fail) throw new Error("temporary receipt adapter unavailable"); return original(input); };
 await f.bridge.start();
 try {
  assert.equal((await settle(f.bridge)).phase, "recovery-needed"); assert.equal(f.bridge.store.read().reservations.length, 1);
  fail = false; await f.bridge.scheduler.control({ targetId: f.attempt.taskId, action: "resume" });
  assert.equal((await settle(f.bridge)).phase, "succeeded"); assert.equal(f.runtime.launches.length, 0);
 } finally { await f.bridge.shutdown(); }
});

function deliveryTarget(f: ReturnType<typeof fixture>) {
 const groupId = f.manifest.deliveryGroups[0]!.id, key = `delivery-${digest([f.manifest.id, f.manifest.revision, groupId]).slice(0, 24)}`;
 return { id: `delivery-${digest([f.manifest.id, groupId])}`, path: join(f.ownedRoot, key), branch: key, repoId: f.manifest.repo.id, baseCommit: f.base, prerequisiteDigests: [] };
}
async function successfulTask(policy: "local" | "pr" = "local") {
 const f = fixture("mutation", policy); await f.prepare(); f.terminal({ kind: "commits", commit: commit(f.attempt.workspace.path, "result") }); f.persist();
 ports(f.bridge).reconcileDelivery = undefined; await f.bridge.start(); assert.equal((await settle(f.bridge)).phase, "succeeded");
 return f;
}
async function deliverySettles(bridge: ExecutionBridge, phase: string) {
 for (let i = 0; i < 120; i++) {
  const delivery = bridge.store.read().deliveries[0];
  if (delivery?.phase === phase) return delivery;
  await new Promise(resolve => setTimeout(resolve, 10));
 }
 assert.fail(`Delivery did not reach ${phase}: ${JSON.stringify(bridge.status())}`);
}
test("bridge recovers persisted integrating through U6 without replaying real Git composition", async () => {
 const f = await successfulTask(), workspace = ports(f.bridge).workspaces, original = workspace.compose.bind(workspace);
 workspace.compose = async request => { const result = await original(request); assert.equal(result.kind, "prepared"); await f.bridge.shutdown(); return result; };
 await assert.rejects(f.bridge.delivery.integrate(f.manifest.id, f.manifest.deliveryGroups[0]!.id, deliveryTarget(f)), /no longer owner/);
 assert.equal(f.bridge.store.read().deliveries[0]!.phase, "integrating");
 const before = f.calls.filter(c => c[0] === "cherry-pick").length;
 const restarted = createExecutionBridge(f.options); await restarted.start();
 try { await deliverySettles(restarted, "ready"); assert.equal(f.calls.filter(c => c[0] === "cherry-pick").length, before); assert.equal(restarted.store.read().reservations.length, 0); }
 finally { await restarted.shutdown(); }
});
async function persistedHandoff(phase: "handoff-pending" | "controller-owned") {
 const f = await successfulTask("pr");
 const result = await f.bridge.delivery.integrate(f.manifest.id, f.manifest.deliveryGroups[0]!.id, deliveryTarget(f)); assert.equal(result.kind, "ready");
 const state = f.bridge.store.read(), receipt = state.integrationReceipts[0]!, group = f.manifest.deliveryGroups[0]!;
 const request = { id: "handoff-request", deliveryGroupId: group.id, ownerId: group.ownerId, generation: "generation-1", pr: { repo: "github.com/example/repo", number: 1 }, workspace: deliveryTarget(f), head: receipt.afterCommit, integrationDigest: receipt.digest };
 const acknowledgement = { requestId: request.id, controllerId: "controller", obligationId: "obligation", generation: request.generation, acceptedAt: 10 };
 f.bridge.store.transact(f.bridge.scheduler.currentOwner()!, draft => { const d = draft.deliveries[0]!; d.phase = phase; d.handoff = request; if (phase === "controller-owned") d.acknowledgement = acknowledgement; });
 await f.bridge.shutdown(); return { ...f, request, acknowledgement };
}
for (const phase of ["handoff-pending", "controller-owned"] as const) test(`bridge restart observes ${phase} and advances verified merge`, async () => {
 const f = await persistedHandoff(phase); let observed = 0;
 const delivery: DeliveryAdapter = { handoff: async () => { throw new Error("Do not transfer again"); }, observe: async request => { assert.deepEqual(request, f.request); observed++; return { kind: "merged", acknowledgement: f.acknowledgement, commit: f.request.head, url: "https://github.com/example/repo/pull/1", observedAt: 20 }; } };
 const restarted = createExecutionBridge({ ...f.options, delivery }); await restarted.start();
 try { await deliverySettles(restarted, "merged"); assert.ok(observed > 0); }
 finally { await restarted.shutdown(); }
});
test("bridge unavailable controller observation preserves pending handoff fence", async () => {
 const f = await persistedHandoff("handoff-pending"), restarted = createExecutionBridge(f.options); await restarted.start();
 try {
  const observed = await restarted.delivery.observe(f.request.deliveryGroupId);
  assert.equal(observed.phase, "handoff-pending"); assert.equal(observed.nonTransfer, undefined); assert.match(observed.reason!, /adapter/);
 } finally { await restarted.shutdown(); }
});
test("bridge surfaces ready PR handoff wiring errors instead of swallowing them", async () => {
 const f = await successfulTask("pr"); await f.bridge.delivery.integrate(f.manifest.id, f.manifest.deliveryGroups[0]!.id, deliveryTarget(f)); await f.bridge.shutdown();
 const restarted = createExecutionBridge(f.options); await restarted.start();
 try {
  for (let i = 0; i < 80 && !restarted.status().error; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(restarted.status().error ?? "", /Authorized PR discovery port required/); assert.equal(restarted.store.read().deliveries[0]!.phase, "ready");
 } finally { await restarted.shutdown(); }
});

for (const corruption of ["head", "operation", "prerequisites"] as const) test(`bridge preparation journal mismatch is refused (${corruption})`, async () => {
 const f = fixture(); await f.prepare(); const head = commit(f.attempt.workspace.path, "result"); f.terminal({ kind: "commits", commit: head });
 const prior = f.bridge.store.readWorkspaceJournal(f.attempt.workspace.id)!;
 const changed = { ...prior, ...(corruption === "head" ? { head } : corruption === "operation" ? { operationId: "prepare:other" } : { inputDigests: ["foreign"] }) };
 f.bridge.store.writeWorkspaceJournal(f.owner, changed, prior, { attemptId: f.attempt.id }); f.persist(); await f.bridge.start();
 try { const attempt = await settle(f.bridge); assert.equal(attempt.phase, "recovery-needed"); assert.match(attempt.reason!, /Prepared base\/prerequisites mismatch/); assert.equal(f.bridge.store.read().results.length, 0); }
 finally { await f.bridge.shutdown(); }
});

test("bridge never substitutes replaced status output for its frozen terminal artifact", async () => {
 const f = fixture("read-only"); await f.prepare(); mkdirSync(join(f.root, "run")); const path = join(f.root, "run", "report.md"); writeFileSync(path, "original");
 f.terminal({ kind: "artifact", path, digest: createHash("sha256").update("original").digest("hex") });
 writeFileSync(path, "replacement"); const statusPath = join(f.root, "run", "status.json"), status = JSON.parse(readFileSync(statusPath, "utf8")); status.steps[0].structuredOutput.digest = createHash("sha256").update("replacement").digest("hex"); writeFileSync(statusPath, JSON.stringify(status));
 f.persist(); await f.bridge.start();
 try { const attempt = await settle(f.bridge); assert.equal(attempt.phase, "recovery-needed"); assert.match(attempt.reason!, /artifact/i); assert.equal(f.bridge.store.read().results.length, 0); }
 finally { await f.bridge.shutdown(); }
});
