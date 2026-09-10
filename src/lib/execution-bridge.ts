import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  digest,
  taskRevisionDigest,
  workspaceExcludedByDelivery,
  validateTerminalOutput,
  type CheckExecutor,
  type CoordinatorOwner,
  type CoordinatorState,
  type DeliveryAdapter,
  type AttemptRuntime,
  type ExecutionAuthorization,
  type ExecutionManifest,
  type RepoIdentity,
  type ResultReceipt,
  type RuntimeCapabilities,
  type WorkspaceAdapter,
  type WorkspaceRef,
} from "./execution-contract.ts";
import {
  importPlanSource,
  interpretPlan,
  interpretationConflicts,
  authorizeInterpretation,
  type ApprovalOptions,
  type ImportOptions,
  type InterpretationTransport,
} from "./plan-import.ts";
import { createExecutionStore, ExecutionStoreError, type ExecutionStore } from "./execution-store.ts";
import { createAttemptRuntime, decodeRuntimeStatus, type RuntimeEventBus } from "./attempt-runtime.ts";
import { createCheckExecutor } from "./execution-checks.ts";
import { TaskWorkspaces, type WorkspaceGit, type WorkspaceJournal, collectTaskResult } from "./task-workspaces.ts";
import { ExecutionScheduler, type SchedulerControl } from "./execution-scheduler.ts";
import { createExecutionDelivery, type DeliveryPrPort, type ExecutionDelivery } from "./execution-delivery.ts";
import { createControllerDeliveryAdapter, type ControllerDeliveryOptions } from "./execution-delivery.ts";
import { PR_REVIEW_RECONCILED_EVENT, type ExecutionControllerBinding } from "./pr-review-events.ts";
import { compileLegacyPreset, type LegacyCompileOptions } from "./execution-presets.ts";

/** New execution records live below this versioned namespace; legacy Feature records drain separately. */
export const EXECUTION_ENGINE_VERSION = "plan-driven-v1";

export type ParsedExecutionCommand = { verb: string; args: string[] };

/** Shell-like command parsing for the command argument only; no shell is invoked. */
export function parseExecutionCommand(raw: string): ParsedExecutionCommand {
  const tokens: string[] = [];
  let token = "", quote: "'" | '"' | undefined, escaped = false, quoted = false;
  const flush = () => { if (token || quoted) tokens.push(token); token = ""; quoted = false; };
  for (const char of String(raw ?? "")) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'" ) { escaped = true; continue; }
    if (quote) { if (char === quote) quote = undefined; else token += char; continue; }
    if (char === "'" || char === '"') { quote = char; quoted = true; continue; }
    if (/\s/.test(char)) { flush(); continue; }
    token += char;
  }
  if (escaped) token += "\\";
  if (quote) throw new Error("Unterminated quote in /orchestrate command");
  flush();
  const [verb = "", ...args] = tokens;
  return { verb: verb.toLowerCase(), args };
}

/** A plan path must be one complete Markdown argument, not a selector or prose. */
export function isUnambiguousPlanPath(value: string): boolean {
  return typeof value === "string" && value.trim() === value && value.length > 0 && !/[\0\r\n]/.test(value) && /\.md$/i.test(value);
}

export function resolvePlanArgument(value: string, cwd = process.cwd()): string {
  if (!isUnambiguousPlanPath(value)) throw new Error("run requires one quoted Markdown plan path");
  const path = realpathSync(isAbsolute(value) ? value : resolve(cwd, value));
  if (!/\.md$/i.test(path) || !statSync(path).isFile()) throw new Error("Plan path must be an existing Markdown file");
  return path;
}

type ExecutionPi = { exec(file: string, args: string[], options: { cwd: string; timeout?: number }): Promise<{ code?: number; stdout?: string; stderr?: string }> };
type ControllerBinding = Pick<ExecutionControllerBinding, "controller" | "controllerId" | "resolvePr" | "verifyMerge"> & Partial<Pick<ControllerDeliveryOptions, "prKey" | "acknowledged">>;

export type ExecutionBridgeOptions = {
  pi?: ExecutionPi;
  events?: RuntimeEventBus;
  repo: RepoIdentity;
  referencePath: string;
  stateRoot: string;
  sessionFile: string;
  /** Diagnostic label only; liveness never treats session/instance differences as death. */
  processStart?: string;
  capacity: number;
  interpretationTransport: InterpretationTransport;
  ownedRoot?: string;
  baseCommit?: string;
  remainingBudget?: number;
  callerTools?: string[];
  callerAgents?: string[];
  now?: () => number;
  git?: WorkspaceGit;
  runtime?: AttemptRuntime;
  workspaces?: WorkspaceAdapter;
  checks?: CheckExecutor;
  delivery?: DeliveryAdapter;
  resolvePr?: DeliveryPrPort;
  controller?: ControllerBinding;
  /** Select the new legacy-compatible sequential preset; omitted means plan-driven. */
  preset?: "plan-driven" | "legacy";
  legacy?: LegacyCompileOptions;
  repositoryName?: string;
};

export type ExecutionApproval = ApprovalOptions & { token: string };
export type ExecutionPreview = {
  /** Opaque, one-use identity of the exact displayed interpretation and approval boundary. */
  token: string;
  boundary: { capacity: number; publication: boolean };
  path: string;
  sourceDigest: string;
  manifest: ExecutionManifest;
  unresolvedDecisions: string[];
  conflicts: string[];
};
export type ExecutionRunResult =
  | { kind: "approval-required"; preview: ExecutionPreview }
  | { kind: "started"; manifest: ExecutionManifest; authorization: ExecutionAuthorization }
  | { kind: "refused"; reason: string; preview?: ExecutionPreview };

export type ExecutionBridge = {
  readonly store: ExecutionStore;
  readonly scheduler: ExecutionScheduler;
  readonly delivery: ExecutionDelivery;
  start(): Promise<void>;
  preview(planPath: string): Promise<ExecutionPreview>;
  run(planPath: string, approval?: ExecutionApproval): Promise<ExecutionRunResult>;
  control(control: SchedulerControl): Promise<void>;
  status(): ReturnType<ExecutionScheduler["progress"]>;
  shutdown(): Promise<void>;
};

function same(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return digest(a) === digest(b);
}
// Diagnostic only. Lease liveness uses the OS PID probe, never this label.
const bridgeProcessIdentity = `${process.pid}:${randomUUID()}`;
function noDelivery(): DeliveryAdapter {
  const refused = (request: { id: string }) => Promise.resolve({ kind: "not-transferred" as const, reason: `No controller delivery adapter for ${request.id}` });
  return { handoff: refused, observe: async request => ({ kind: "unknown", reason: `No controller delivery adapter for ${request.id}` }) };
}
function resultEligible(state: CoordinatorState, receipt: ResultReceipt): boolean {
  const attempt = state.attempts.find(item => item.id === receipt.attemptId);
  const manifest = attempt && state.manifests.find(item => item.id === attempt.manifestId && item.revision === attempt.manifestRevision);
  const task = manifest?.tasks.find(item => item.id === receipt.taskId);
  const record = state.tasks.find(item => item.taskId === receipt.taskId && item.manifestId === manifest?.id);
  return !!attempt && !!manifest && !!task && !!record && record.phase === "succeeded" && record.resultDigest === receipt.digest && receipt.taskDigest === taskRevisionDigest(task) && receipt.repoId === manifest.repo.id && receipt.baseCommit === manifest.baseCommit;
}

export function createExecutionBridge(options: ExecutionBridgeOptions): ExecutionBridge {
  if (!options.sessionFile || !existsSync(options.sessionFile)) throw new Error("Persisted session file required for execution ownership");
  const now = options.now ?? Date.now;
  const root = join(options.stateRoot, EXECUTION_ENGINE_VERSION);
  const processStart = options.processStart || bridgeProcessIdentity;
  const store = createExecutionStore({ stateRoot: root, repo: options.repo, processStart });
  let owner: CoordinatorOwner | undefined;
  let started = false;
  let starting: Promise<void> | undefined;
  let authorizedBase = "";
  const authorizedBases = new Set<string>();
  const restoreAuthorizedBases = () => {
    // read() validates every historical approval against its immutable manifest.
    for (const approval of store.read().authorizations) authorizedBases.add(approval.baseCommit);
  };
  const pendingPreviews = new Map<string, ExecutionPreview>();
  const git: WorkspaceGit = options.git ?? (async (cwd, argv) => {
    if (!options.pi) throw new Error("Git adapter required");
    const result = await options.pi.exec("git", [...argv], { cwd });
    return { exitCode: result.code ?? -1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  });
  const baseCommit = async (): Promise<string> => {
    if (authorizedBase) return authorizedBase;
    const fetched = await git(options.referencePath, ["fetch", "origin"]);
    if (fetched.exitCode !== 0) throw new Error(`Cannot fetch authorized base: ${fetched.stderr}`);
    const requested = options.baseCommit ?? "origin/HEAD";
    const resolved = await git(options.referencePath, ["rev-parse", `${requested}^{commit}`]);
    const commit = resolved.stdout.trim();
    if (resolved.exitCode !== 0 || !/^[a-f0-9]{40}$/i.test(commit)) throw new Error("Fetched base did not resolve to a full immutable commit");
    if (options.baseCommit && commit.toLowerCase() !== options.baseCommit.toLowerCase()) throw new Error("Fetched base changed from caller-authorized commit");
    authorizedBase = commit;
    authorizedBases.add(commit);
    return commit;
  };
  const ownedRootCandidate = options.ownedRoot ?? join(dirname(options.referencePath), `${basename(options.referencePath)}-wt`);
  mkdirSync(ownedRootCandidate, { recursive: true });
  const ownedRoot = realpathSync(ownedRootCandidate);
  const readJournal = async (id: string): Promise<WorkspaceJournal | undefined> => store.readWorkspaceJournal(id);
  const writeJournal = async (journal: WorkspaceJournal, expected: WorkspaceJournal | undefined, writer: { attemptId: string } | { integrationId: string }): Promise<void> => {
    if (!owner) throw new Error("Execution journal owner unavailable");
    store.writeWorkspaceJournal(owner, journal, expected, writer);
  };
  const owns = async (workspace: WorkspaceRef, writer: { attemptId: string } | { integrationId: string }): Promise<boolean> => {
    if (!owner) return false;
    const state = store.read();
    if (!state.owner || state.owner.epoch !== owner.epoch || state.owner.instanceId !== owner.instanceId) return false;
    if (workspaceExcludedByDelivery(state, workspace)) return false;
    return state.reservations.some(reservation =>
      reservation.workspaceId === workspace.id && reservation.workspacePath === workspace.path &&
      ("attemptId" in writer ? reservation.attemptId === writer.attemptId : reservation.integrationId === writer.integrationId));
  };
  const resolveReceipt = async (receiptDigest: string): Promise<ResultReceipt | undefined> => store.read().results.find(receipt => receipt.digest === receiptDigest);
  const isFetchedBase = async (commit: string): Promise<boolean> => authorizedBases.has(commit);
  const runtime = options.runtime ?? (() => {
    if (!options.events) throw new Error("Runtime event bus required");
    return createAttemptRuntime({ events: options.events, sessionFile: options.sessionFile, capacity: store.read().capacity || options.capacity, remainingBudget: options.remainingBudget, callerTools: options.callerTools, callerAgents: options.callerAgents });
  })();
  const workspaces = options.workspaces ?? new TaskWorkspaces({
    repo: options.repo,
    referencePath: realpathSync(options.referencePath),
    ownedRoot,
    git,
    owns,
    isFetchedBase,
    readJournal,
    writeJournal,
    resolveReceipt,
    isEligibleReceipt: async receipt => resultEligible(store.read(), receipt),
  });
  const checks = options.checks ?? createCheckExecutor({ exec: async (file, args, config) => {
    if (!options.pi) throw new Error("Check adapter required");
    const result = await options.pi.exec(file, args, { cwd: config.cwd });
    return { exitCode: result.code ?? -1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  }});
  const resolvePr = options.resolvePr ?? options.controller?.resolvePr;
  const deliveryAdapter = options.delivery ?? (options.controller ? createControllerDeliveryAdapter({
    controller: options.controller.controller,
    controllerId: options.controller.controllerId,
    ...(options.controller.prKey ? { prKey: options.controller.prKey } : {}),
    acknowledged: options.controller.acknowledged ?? (request => store.read().deliveries.find(d => d.handoff?.id === request.id)?.acknowledgement),
    verifyMerge: options.controller.verifyMerge,
  }) : noDelivery());
  let activeDelivery: ExecutionDelivery | undefined;
  const workspaceForDelivery = (manifest: ExecutionManifest, groupId: string): WorkspaceRef => {
    const key = `delivery-${digest([manifest.id, manifest.revision, groupId]).slice(0, 24)}`;
    return { id: `delivery-${digest([manifest.id, groupId])}`, path: resolve(ownedRoot, key), branch: key, repoId: manifest.repo.id, baseCommit: manifest.baseCommit, prerequisiteDigests: [] };
  };
  const scheduler = new ExecutionScheduler({
    store,
    owner: { pid: process.pid, processStart, sessionFile: realpathSync(options.sessionFile), instanceId: randomUUID() },
    onOwnerAcquired: acquired => {
      restoreAuthorizedBases();
      owner = acquired;
      activeDelivery = recreateDelivery(acquired);
    },
    runtime,
    workspaces,
    checks,
    delivery: deliveryAdapter,
    workspace: ({ attemptId, manifest, prerequisites }) => {
      const key = `task-${attemptId}`;
      return { id: attemptId, path: resolve(ownedRoot, key), branch: key, repoId: manifest.repo.id, baseCommit: manifest.baseCommit, prerequisiteDigests: prerequisites.map(receipt => receipt.digest) };
    },
    createReceipt: async ({ attempt, task }) => {
      if (!attempt.preparedHead || !attempt.run || !owner) throw new Error("Exact prepared head/runtime evidence required");
      let output = attempt.terminal?.output;
      if (!output) {
        // Compatible recovery of older evidence: canonical JSON digest, not a
        // hash of current descriptor/artifact bytes and not arbitrary HEAD.
        const raw = readFileSync(join(attempt.run.artifactDir, "status.json"), "utf8");
        const header = JSON.parse(readFileSync(attempt.run.ownerSessionFile, "utf8").split("\n")[0]!);
        if (header.type !== "session" || typeof header.id !== "string") throw new Error("Terminal output owner session unavailable");
        const decoded = decodeRuntimeStatus(raw, attempt.run, header.id, now());
        if (decoded.kind !== "known-terminal" || decoded.evidence.outcome !== "succeeded" || decoded.evidence.evidenceDigest !== attempt.terminal?.evidenceDigest) throw new Error("Terminal status changed; exact output recovery refused");
        output = decoded.evidence.output;
      }
      if (!output) throw new Error("Terminal output identity missing; inspect original run evidence before remediation");
      validateTerminalOutput(output);
      const frozenOutput = structuredClone(output);
      const result = await collectTaskResult({
        attempt,
        task,
        workspaces,
        git,
        checks,
        preparedHead: attempt.preparedHead,
        output,
        artifactRoot: attempt.run.artifactDir,
        ownsAttempt: async current => {
          const state = store.read();
          return !!state.owner && state.owner.epoch === owner!.epoch && state.owner.instanceId === owner!.instanceId && state.reservations.some(reservation => reservation.attemptId === current.id);
        },
        verifyTerminalOutput: async (_current, claimed) => same(frozenOutput, claimed),
        verifyPreparedBase: async (current, preparedHead) => {
          const journal = await readJournal(current.workspace.id);
          return !!journal && journal.phase === "complete" && journal.operationId === `prepare:${current.id}` &&
            same(journal.workspace, current.workspace) && journal.before === current.baseCommit && journal.head === preparedHead &&
            same(journal.inputDigests, current.prerequisiteDigests) && same(journal.appliedDigests, current.prerequisiteDigests);
        },
        now,
      });
      if (result.kind !== "validated") throw new Error(result.reason);
      return result.receipt;
    },
    reconcileDelivery: async () => {
      if (!owner || !activeDelivery) return;
      const state = store.read();
      for (const manifest of state.manifests.filter(item => state.activeRevisions[item.id] === item.revision)) {
        for (const group of manifest.deliveryGroups) {
          const current = state.deliveries.find(item => item.groupId === group.id);
          if (!current || ["pending", "blocked", "integrating"].includes(current.phase)) {
            await activeDelivery.integrate(manifest.id, group.id, workspaceForDelivery(manifest, group.id));
          }
          const next = store.read().deliveries.find(item => item.groupId === group.id);
          if (next && ["handoff-pending", "controller-owned"].includes(next.phase)) {
            await activeDelivery.observe(group.id);
          } else if (next?.phase === "ready" && group.policy === "pr") {
            await activeDelivery.handoff(manifest.id, group.id);
          }
        }
      }
    },
    now,
  });
  const reconcileSubscriptions = options.events ? [PR_REVIEW_RECONCILED_EVENT, "pi.execution.reconcile"].map(event => options.events!.on(event, () => {
    if (started) void scheduler.reconcile().catch(() => {});
  })) : [];
  // Bind the facade synchronously after lease acquisition, before recovery
  // invokes receipt or delivery callbacks. No Git/RPC under the store lock.
  const recreateDelivery = (nextOwner: CoordinatorOwner): ExecutionDelivery => createExecutionDelivery({
    store,
    owner: nextOwner,
    workspace: workspaces,
    checks,
    delivery: deliveryAdapter,
    ...(resolvePr ? { resolvePr } : {}),
    now,
  });
  const appendControlIntent = (control: SchedulerControl): void => {
    const state = store.read();
    const matches = state.manifests.filter(manifest => state.activeRevisions[manifest.id] === manifest.revision &&
      (manifest.id === control.targetId || manifest.features.some(feature => feature.id === control.targetId) || manifest.tasks.some(task => task.id === control.targetId)));
    if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous execution control target" : "Unknown control target");
    const manifest = matches[0]!;
    const authorization = state.authorizations.find(item => item.manifestId === manifest.id && item.revision === manifest.revision);
    if (!authorization) throw new Error("Missing target authorization");
    const session = realpathSync(options.sessionFile);
    store.appendIntent({ id: `intent-${digest([session, authorization.id, control.targetId, control.action, control.immediate ?? false])}`, sessionFile: session, authorizationId: authorization.id, kind: control.action, targetId: control.targetId, ...(control.immediate === undefined ? {} : { immediate: control.immediate }) });
  };
  const bridge: ExecutionBridge = {
    store,
    scheduler,
    get delivery() {
      if (!activeDelivery) throw new Error("Execution coordinator has not started");
      return activeDelivery;
    },
    async start() {
      if (started) return;
      if (starting) return starting;
      starting = (async () => {
        await scheduler.start();
        await scheduler.reconcile();
        started = true;
      })().finally(() => { starting = undefined; });
      await starting;
    },
    async preview(planPath) {
      const path = resolvePlanArgument(planPath);
      const source = await importPlanSource(path);
      const base = await baseCommit();
      const previous = store.read().manifests.filter(manifest => manifest.source.path === source.path).sort((a, b) => b.revision - a.revision)[0];
      const id = previous?.id ?? `execution-${digest([options.repo.id, source.path])}`;
      const identity: ImportOptions = { id, revision: previous ? previous.revision + 1 : 1, repo: options.repo, baseCommit: base, source, ...(previous ? { previous } : {}) };
      const result = options.preset === "legacy"
        ? { manifest: compileLegacyPreset(identity, options.legacy), unresolvedDecisions: [] as string[] }
        : await interpretPlan(identity, options.interpretationTransport);
      const capabilities: RuntimeCapabilities = await runtime.probe();
      const capacity = store.read().capacity || options.capacity;
      const boundary = { capacity, publication: result.manifest.deliveryGroups.some(group => group.policy === "pr") };
      const token = digest([randomUUID(), path, source.digest, digest(result.manifest), result.manifest.revision, options.repo, base, boundary]);
      const preview = { token, boundary, path, sourceDigest: source.digest, manifest: result.manifest, unresolvedDecisions: result.unresolvedDecisions, conflicts: interpretationConflicts(result.manifest, capacity, capabilities) };
      pendingPreviews.set(path, structuredClone(preview));
      return preview;
    },
    async run(planPath, approval) {
      let preview: ExecutionPreview;
      try {
        const path = resolvePlanArgument(planPath);
        const pending = approval ? pendingPreviews.get(path) : undefined;
        if (approval && (!pending || !approval.token || approval.token !== pending.token)) return { kind: "refused", reason: "Missing, replaced, or stale approval token; preview again" };
        if (pending) {
          if (approval!.capacity !== pending.boundary.capacity || (approval!.publication && !pending.boundary.publication)) return { kind: "refused", reason: "Approval exceeds displayed boundary", preview: structuredClone(pending) };
          const source = await importPlanSource(path);
          if (source.digest !== pending.sourceDigest) return { kind: "refused", reason: "Plan changed after preview; import a fresh revision", preview: pending };
          preview = structuredClone(pending);
        } else preview = await bridge.preview(path);
      } catch (error) { return { kind: "refused", reason: String(error) }; }
      if (preview.unresolvedDecisions.length || preview.conflicts.length) return { kind: "refused", reason: [...preview.unresolvedDecisions, ...preview.conflicts].join("; "), preview };
      if (!approval) {
        pendingPreviews.set(preview.path, structuredClone(preview));
        return { kind: "approval-required", preview };
      }
      const pending = pendingPreviews.get(preview.path);
      if (pending && pending.sourceDigest !== preview.sourceDigest) return { kind: "refused", reason: "Plan changed after preview; import a fresh revision", preview };
      try {
        const { token: _token, ...approved } = approval;
        const authorization = authorizeInterpretation({ manifest: preview.manifest, unresolvedDecisions: [] }, approved);
        await bridge.start();
        const activeRevision = bridge.store.read().activeRevisions[preview.manifest.id];
        if (activeRevision === undefined) scheduler.admit(preview.manifest, authorization, { initializeCapacity: true });
        else if (activeRevision === preview.manifest.revision - 1) scheduler.revise(preview.manifest, authorization);
        else return { kind: "refused", reason: `Manifest revision ${preview.manifest.revision} is not the next authorized revision`, preview };
        pendingPreviews.delete(preview.path);
        return { kind: "started", manifest: preview.manifest, authorization };
      } catch (error) { return { kind: "refused", reason: String(error), preview }; }
    },
    async control(control) {
      try {
        await bridge.start();
        await scheduler.control(control);
      } catch (error) {
        // A non-owner may observe and submit a data-only intent. It never
        // steals the coordinator lease or mutates execution state directly.
        if (error instanceof ExecutionStoreError && error.kind === "lease-held") {
          appendControlIntent(control);
          return;
        }
        throw error;
      }
    },
    status() { return scheduler.progress(); },
    async shutdown() {
      reconcileSubscriptions.forEach(off => off());
      await scheduler.shutdown();
      const runtimeWithDispose = runtime as ReturnType<typeof createAttemptRuntime> & { dispose?: () => void };
      runtimeWithDispose.dispose?.();
      started = false;
    },
  };
  return bridge;
}

export function executionTargetFromArgs(args: readonly string[]): string {
  const target = args[0] ?? "";
  if (!target || args.length !== 1) throw new Error("Execution controls require one target ID");
  return target;
}

export function executionStatusSummary(progress: ReturnType<ExecutionScheduler["progress"]>): string {
  const state = progress.state;
  const active = state.attempts.filter(attempt => ["preparing", "launching", "running", "stopping", "validating", "recovery-needed"].includes(attempt.phase)).length;
  const pending = state.tasks.filter(task => ["pending", "ready", "dependency-blocked"].includes(task.phase)).length;
  const deliveries = state.deliveries.filter(delivery => ["ready", "handoff-pending", "controller-owned", "merged"].includes(delivery.phase)).length;
  return `engine=${EXECUTION_ENGINE_VERSION} epoch=${state.epoch} active=${active} pending=${pending} deliveries=${deliveries}${progress.error ? ` error=${progress.error}` : ""}`;
}
