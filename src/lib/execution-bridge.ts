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
  validateAuthorization,
  workspaceExcludedByDelivery,
  validateTerminalOutput,
  type CheckExecutor,
  type CoordinatorOwner,
  type CoordinatorState,
  type DeliveryAdapter,
  type AttemptRuntime,
  type ExecutionAuthorization,
  type ExecutionControllerBootstrapIntent,
  type ExecutionControllerMapping,
  type ExecutionManifest,
  type DeliveryGroup,
  type IntegrationReceipt,
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
import { parseGithubSlug, parsePrKey } from "./pr-review-identity.ts";
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
export type ExecutionPrBootstrapRequest = {
  manifest: ExecutionManifest; group: DeliveryGroup; receipt: IntegrationReceipt; workspace: WorkspaceRef;
  operationId: string; generation: string; branch: string; head: string; repository: string;
};
export type ExecutionPrBootstrapResult =
  | { kind: "found" | "created"; pr: { repo: string; number: number }; branch: string; head: string }
  | { kind: "not-found" }
  | { kind: "unknown" | "refused"; reason: string };
export type ExecutionPrBootstrapDiscovery = Exclude<ExecutionPrBootstrapResult, { kind: "created" }>;
export type ExecutionPrBootstrapCreation = Extract<ExecutionPrBootstrapResult, { kind: "found" | "created" | "unknown" | "refused" }>;
/** Discovery is read-only. Creation is the only publication-capable operation;
 * the bridge owns authorization, intent durability, exact mapping persistence, and fencing. */
export type ExecutionPrBootstrapPort = {
  discover(request: ExecutionPrBootstrapRequest): Promise<ExecutionPrBootstrapDiscovery>;
  create(request: ExecutionPrBootstrapRequest): Promise<ExecutionPrBootstrapCreation>;
};

/** Canonical host/owner/repository slug accepted at the publication boundary. */
export function canonicalPublicationRepository(value: string): string | undefined {
  let raw = String(value ?? "").trim();
  if (!raw) return undefined;
  raw = raw.replace(/^git@([^:]+):/, "https://$1/");
  if (raw.includes("://")) {
    try {
      const url = new URL(raw);
      if (url.password || url.search || url.hash) return undefined;
      const parts = url.pathname.split("/").filter(Boolean).map(part => part.replace(/\.git$/i, ""));
      if (parts.length !== 2) return undefined;
      raw = `${url.host}/${parts[0]!}/${parts[1]!}`;
    } catch { return undefined; }
  }
  raw = raw.replace(/\.git$/i, "");
  const parts = raw.split("/");
  if (parts.length !== 3 || parts.some(part => !part)) return undefined;
  const parsed = parseGithubSlug(raw);
  return parsed ? `${parsed.host}/${parsed.owner}/${parsed.repo}` : undefined;
}

function createGitHubExecutionPrBootstrap(pi: ExecutionPi): ExecutionPrBootstrapPort {
  const run = async (file: string, args: string[], cwd: string, timeout = 60_000) => {
    try { return await pi.exec(file, args, { cwd, timeout }); }
    catch (error) { return { code: -1, stdout: "", stderr: String(error) }; }
  };
  const parsePr = (value: unknown): { repo: string; number: number } | undefined => {
    if (typeof value !== "string") return undefined;
    try {
      const url = new URL(value); const parts = url.pathname.split("/").filter(Boolean);
      const number = Number(parts[3]);
      const repo = parts.length === 4 && parts[1]!.toLowerCase().endsWith(".git") === false && parts[2]!.toLowerCase() === "pull" ? canonicalPublicationRepository(`${url.host}/${parts[0]!}/${parts[1]!}`) : undefined;
      if (!repo || !Number.isSafeInteger(number) || number < 1) return undefined;
      return { repo, number };
    } catch { return undefined; }
  };
  const parseRemote = (value: string): string | undefined => {
    const normalized = value.trim().replace(/^git@([^:]+):/, "https://$1/");
    try {
      const url = new URL(normalized.includes("://") ? normalized : `https://${normalized}`);
      if (url.password || url.search || url.hash) return undefined;
      const parts = url.pathname.split("/").filter(Boolean).map(part => part.toLowerCase().endsWith(".git") ? part.slice(0, -4) : part);
      return parts.length === 2 ? canonicalPublicationRepository(`${url.host}/${parts[0]!}/${parts[1]!}`) : undefined;
    } catch { return undefined; }
  };
  const uniqueRemote = (value: string): string[] => [...new Set(value.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
  const destination = async (request: ExecutionPrBootstrapRequest): Promise<{ repository: string } | { reason: string }> => {
    const approved = canonicalPublicationRepository(request.repository);
    if (!approved) return { reason: "Approved publication repository is missing or noncanonical" };
    const fetch = await run("git", ["remote", "get-url", "--all", "origin"], request.workspace.path, 30_000);
    const push = await run("git", ["remote", "get-url", "--all", "--push", "origin"], request.workspace.path, 30_000);
    const fetchUrls = fetch.code === 0 ? uniqueRemote(String(fetch.stdout ?? "")) : [];
    const pushUrls = push.code === 0 ? uniqueRemote(String(push.stdout ?? "")) : [];
    const fetchRepos = fetchUrls.map(parseRemote), pushRepos = pushUrls.map(parseRemote);
    if (fetch.code !== 0 || push.code !== 0 || fetchUrls.length !== 1 || pushUrls.length !== 1 || !fetchRepos[0] || !pushRepos[0]) return { reason: "Effective GitHub repository destination is unavailable, ambiguous, or noncanonical" };
    const fetchSet = new Set(fetchRepos as string[]), pushSet = new Set(pushRepos as string[]);
    if (fetchSet.size !== 1 || pushSet.size !== 1 || !fetchSet.has(approved) || !pushSet.has(approved)) return { reason: "Effective fetch/push destination does not match approved publication repository" };
    return { repository: approved };
  };
  const discover = async (request: ExecutionPrBootstrapRequest): Promise<ExecutionPrBootstrapDiscovery> => {
    const checked = await destination(request);
    if ("reason" in checked) return { kind: "refused", reason: checked.reason };
    const result = await run("gh", ["pr", "list", "--repo", checked.repository, "--head", request.workspace.branch, "--state", "all", "--limit", "20", "--json", "number,url,headRefName,headRefOid"], request.workspace.path);
    if (result.code !== 0) return { kind: "unknown", reason: String(result.stderr ?? result.stdout ?? "gh pr list failed") };
    let rows: Array<{ number?: unknown; url?: unknown; headRefName?: unknown; headRefOid?: unknown }>;
    try { rows = JSON.parse(String(result.stdout ?? "")) as Array<{ number?: unknown; url?: unknown; headRefName?: unknown; headRefOid?: unknown }>; }
    catch (error) { return { kind: "unknown", reason: `Invalid gh PR discovery response: ${String(error)}` }; }
    const exact = rows.filter(row => row.headRefName === request.workspace.branch && row.headRefOid === request.receipt.afterCommit).map(row => ({ ...row, pr: parsePr(row.url) })).filter(row => row.pr && row.pr.repo === checked.repository && Number.isSafeInteger(row.number) && Number(row.number) === row.pr.number);
    if (exact.length > 1) return { kind: "unknown", reason: "Multiple PRs match the authorized branch/head" };
    if (exact.length === 1) return { kind: "found", pr: exact[0]!.pr!, branch: request.workspace.branch, head: request.receipt.afterCommit };
    if (rows.some(row => row.headRefName === request.workspace.branch || row.headRefOid === request.receipt.afterCommit)) return { kind: "unknown", reason: "Remote PR branch/head does not match the authorized integration" };
    return { kind: "not-found" };
  };
  const create = async (request: ExecutionPrBootstrapRequest): Promise<ExecutionPrBootstrapCreation> => {
    const checked = await destination(request);
    if ("reason" in checked) return { kind: "refused", reason: checked.reason };
    const head = await run("git", ["rev-parse", "HEAD"], request.workspace.path, 30_000);
    const branch = await run("git", ["branch", "--show-current"], request.workspace.path, 30_000);
    const clean = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], request.workspace.path, 30_000);
    if (head.code !== 0 || String(head.stdout ?? "").trim() !== request.receipt.afterCommit || branch.code !== 0 || String(branch.stdout ?? "").trim() !== request.workspace.branch || clean.code !== 0 || String(clean.stdout ?? "").trim()) return { kind: "refused", reason: "Delivery workspace branch/head/clean state is not authorized" };
    const beforePush = await destination(request);
    if ("reason" in beforePush) return { kind: "refused", reason: beforePush.reason };
    const pushed = await run("git", ["push", "-u", "origin", `${request.workspace.branch}:${request.workspace.branch}`], request.workspace.path, 120_000);
    if (pushed.code !== 0) {
      const afterPush = await discover(request);
      return afterPush.kind === "found" ? afterPush : { kind: "unknown", reason: `Push outcome unknown: ${String(pushed.stderr ?? pushed.stdout ?? "")}` };
    }
    const beforeCreate = await destination(request);
    if ("reason" in beforeCreate) return { kind: "refused", reason: beforeCreate.reason };
    const created = await run("gh", ["pr", "create", "--repo", beforeCreate.repository, "--head", request.workspace.branch, "--title", `Plan delivery ${request.group.id}`, "--body", `operation: ${request.operationId}`], request.workspace.path, 60_000);
    const afterCreate = await discover(request);
    if (afterCreate.kind === "found") return { ...afterCreate, kind: "created" };
    return afterCreate.kind === "not-found"
      ? { kind: "unknown", reason: created.code === 0 ? "PR create acknowledgement did not expose the created PR" : `PR create outcome unknown: ${String(created.stderr ?? created.stdout ?? "")}` }
      : afterCreate;
  };
  return { discover, create };
}

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
  /** Authorized PR bootstrap boundary; omitted preserves local-only/refusal behavior. */
  bootstrapPr?: ExecutionPrBootstrapPort;
  /** Canonical effective fetch/push publication destination captured before preview, when available. */
  repository?: string;
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
  boundary: { capacity: number; publication: boolean; publicationRepository?: string };
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
  start(options?: { resumePriorOwner?: boolean }): Promise<void>;
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
  const bootstrapPr = options.bootstrapPr ?? (options.pi ? createGitHubExecutionPrBootstrap(options.pi) : undefined);
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
  const previewFingerprints = new Map<string, string>();
  const activeDurableWork = (state: CoordinatorState): boolean =>
    state.attempts.some(attempt => ["preparing", "launching", "running", "stopping", "validating", "recovery-needed"].includes(attempt.phase)) ||
    state.integrations.some(intent => intent.phase !== "complete") ||
    state.deliveries.some(delivery => ["integrating", "ready", "handoff-pending", "controller-owned"].includes(delivery.phase)) ||
    state.intents.some(intent => intent.consumedAt === undefined);
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
  const rawResolvePr = options.resolvePr ?? options.controller?.resolvePr;
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
  const canonicalPr = (pr: { repo: string; number: number }): { repo: string; number: number } | undefined => {
    const parsed = parsePrKey({ slug: pr.repo, pr: pr.number });
    return parsed && Number.isSafeInteger(Number(parsed.number)) && Number(parsed.number) > 0 ? { repo: `${parsed.host}/${parsed.owner}/${parsed.repo}`, number: Number(parsed.number) } : undefined;
  };
  const bootstrapControllerMapping = async (request: Parameters<NonNullable<typeof rawResolvePr>>[0]): Promise<Awaited<ReturnType<NonNullable<typeof rawResolvePr>>>> => {
    if (!bootstrapPr) return { kind: "refused", reason: "Authorized PR bootstrap port required" };
    if (request.manifest.preset !== "plan-driven" || request.group.policy !== "pr") return { kind: "refused", reason: "PR bootstrap is unavailable for this execution preset" };
    const currentOwner = owner;
    if (!currentOwner) return { kind: "unknown", reason: "Execution coordinator owner unavailable" };
    let state = store.read();
    const manifest = state.manifests.find(item => item.id === request.manifest.id && item.revision === request.manifest.revision);
    const groupMatches = state.manifests.filter(item => state.activeRevisions[item.id] === item.revision).flatMap(item => item.deliveryGroups.map(group => ({ manifest: item, group }))).filter(item => item.group.id === request.group.id);
    const authorization = manifest && state.authorizations.find(item => item.manifestId === manifest.id && item.revision === manifest.revision);
    if (!manifest || digest(manifest) !== digest(request.manifest) || state.activeRevisions[manifest.id] !== manifest.revision || groupMatches.length !== 1 || digest(groupMatches[0]!.group) !== digest(request.group) || !authorization) return { kind: "refused", reason: "Stale, foreign, or ambiguous execution manifest/group" };
    try { validateAuthorization(manifest, authorization); } catch (error) { return { kind: "refused", reason: `Invalid persisted approval: ${String(error)}` }; }
    const approvedRepository = authorization.publicationRepository && canonicalPublicationRepository(authorization.publicationRepository);
    const configuredRepository = options.repository && canonicalPublicationRepository(options.repository);
    if (!authorization.publication || !approvedRepository || !configuredRepository || approvedRepository !== configuredRepository || manifest.repo.id !== options.repo.id || request.workspace.repoId !== options.repo.id || request.workspace.baseCommit !== manifest.baseCommit) return { kind: "refused", reason: "Publication approval or repository boundary is invalid" };
    const delivery = state.deliveries.find(item => item.groupId === request.group.id);
    if (!delivery || delivery.phase !== "ready" || !delivery.integrationDigest || delivery.handoff) return { kind: "refused", reason: "Delivery lifecycle is stale or already fenced" };
    const receipt = state.integrationReceipts.find(item => item.digest === delivery.integrationDigest && item.deliveryGroupId === request.group.id);
    const integration = receipt && state.integrations.find(item => item.id === receipt.intentId);
    if (!receipt || !integration || digest(integration.workspace) !== digest(request.workspace) || receipt.afterCommit !== request.receipt.afterCommit || digest(request.receipt) !== digest(receipt)) return { kind: "refused", reason: "Integration receipt/workspace is stale or foreign" };
    const inspected = await workspaces.inspect(request.workspace);
    if (inspected.kind !== "inspected" || digest(inspected.workspace) !== digest(request.workspace) || !inspected.clean || inspected.inProgress || inspected.head !== receipt.afterCommit || digest(inspected.appliedDigests) !== digest(receipt.inputDigests)) return { kind: "refused", reason: "Delivery workspace no longer matches validated receipt" };
    state = store.read();
    if (!state.owner || digest(state.owner) !== digest(currentOwner) || state.reconciledEpoch !== currentOwner.epoch) return { kind: "unknown", reason: "Execution owner/lifecycle fence changed" };
    const generation = `execution-${digest([manifest.id, manifest.revision, digest(manifest), request.group.id, request.group.ownerId, options.repo.id, request.workspace.id, request.workspace.path, receipt.digest, receipt.afterCommit]).slice(0, 32)}`;
    const operationId = `pr-bootstrap-${digest([manifest.id, manifest.revision, digest(manifest), request.group.id, request.group.ownerId, options.repo.id, request.workspace.id, request.workspace.path, request.workspace.branch, receipt.digest, receipt.afterCommit])}`;
    const intentBody: Omit<ExecutionControllerBootstrapIntent, "phase" | "createdAt" | "updatedAt" | "pr" | "reason"> = {
      id: operationId, operationId, manifestId: manifest.id, manifestRevision: manifest.revision, manifestDigest: digest(manifest), sourceDigest: manifest.source.digest,
      authorizationId: authorization.id, groupId: request.group.id, ownerId: request.group.ownerId, generation, repo: options.repo, receiptDigest: receipt.digest,
      publicationRepository: approvedRepository, workspace: request.workspace, branch: request.workspace.branch, head: receipt.afterCommit,
    };
    const existingMapping = (state.controllerMappings ?? []).find(item => item.manifestId === manifest.id && item.manifestRevision === manifest.revision && item.groupId === request.group.id);
    if (existingMapping) return { kind: "authorized", pr: existingMapping.pr, generation: existingMapping.generation, ownerId: existingMapping.ownerId, ownerKind: "execution" };
    const existingIntent = (state.controllerBootstrapIntents ?? []).find(item => item.operationId === operationId);
    if (!existingIntent) {
      try {
        store.transact(currentOwner, draft => {
          const current = draft.controllerBootstrapIntents ?? (draft.controllerBootstrapIntents = []);
          if (current.some(item => item.operationId === operationId)) return;
          current.push({ ...intentBody, phase: "planned", createdAt: now(), updatedAt: now() });
        });
        state = store.read();
      } catch (error) { return { kind: "unknown", reason: `Bootstrap intent persistence failed: ${String(error)}` }; }
    }
    const intent = (state.controllerBootstrapIntents ?? []).find(item => item.operationId === operationId);
    if (!intent) return { kind: "unknown", reason: "Bootstrap intent was not durably recorded" };
    const persistRemote = (result: Extract<ExecutionPrBootstrapResult, { kind: "found" | "created" }>): Awaited<ReturnType<NonNullable<typeof rawResolvePr>>> => {
      const pr = canonicalPr(result.pr);
      const expectedRepository = intent.publicationRepository && canonicalPublicationRepository(intent.publicationRepository);
      if (!expectedRepository || result.branch !== request.workspace.branch || result.head !== receipt.afterCommit || !pr || pr.repo !== expectedRepository) {
        return { kind: "refused", reason: "Remote PR reconciliation does not match authorized branch/head/repository" };
      }
      const mapping: ExecutionControllerMapping = { manifestId: manifest.id, manifestRevision: manifest.revision, groupId: request.group.id, ownerId: request.group.ownerId, generation, pr, workspace: request.workspace, head: receipt.afterCommit, manifestDigest: digest(manifest), sourceDigest: manifest.source.digest, authorizationId: authorization.id, integrationDigest: receipt.digest, operationId };
      try {
        store.transact(currentOwner, draft => {
          const latest = draft.controllerBootstrapIntents?.find(item => item.operationId === operationId);
          if (!latest) throw new Error("Bootstrap intent disappeared");
          const duplicate = (draft.controllerMappings ?? []).find(item => item.manifestId === manifest.id && item.manifestRevision === manifest.revision && item.groupId === request.group.id);
          if (duplicate) { if (digest(duplicate) !== digest(mapping)) throw new Error("Controller mapping identity mismatch"); return; }
          if ((draft.controllerMappings ?? []).some(item => item.groupId !== request.group.id && item.pr.repo === pr.repo && item.pr.number === pr.number)) throw new Error("PR already mapped to another delivery group; approve one shared group");
          latest.phase = "complete"; latest.updatedAt = now(); latest.pr = pr; delete latest.reason;
          (draft.controllerMappings ?? (draft.controllerMappings = [])).push(mapping);
        });
      } catch (error) { return { kind: "unknown", reason: `Bootstrap mapping persistence failed: ${String(error)}` }; }
      return { kind: "authorized", pr, generation, ownerId: request.group.ownerId, ownerKind: "execution" };
    };
    const bootstrapRequest = (): ExecutionPrBootstrapRequest => ({ manifest, group: request.group, receipt, workspace: request.workspace, operationId, generation, branch: request.workspace.branch, head: receipt.afterCommit, repository: intent.publicationRepository! });
    const bootstrapFence = (current: CoordinatorState, currentIntent: ExecutionControllerBootstrapIntent | undefined): boolean => {
      if (!currentIntent || currentIntent.operationId !== operationId || currentIntent.manifestId !== manifest.id || currentIntent.manifestRevision !== manifest.revision || currentIntent.manifestDigest !== digest(manifest) || currentIntent.sourceDigest !== manifest.source.digest || currentIntent.authorizationId !== authorization.id || currentIntent.groupId !== request.group.id || currentIntent.ownerId !== request.group.ownerId || currentIntent.generation !== generation || currentIntent.receiptDigest !== receipt.digest || currentIntent.publicationRepository !== intent.publicationRepository) return false;
      if (!current.owner || digest(current.owner) !== digest(currentOwner) || current.reconciledEpoch !== currentOwner.epoch || current.activeRevisions[manifest.id] !== manifest.revision) return false;
      const currentDelivery = current.deliveries.find(item => item.groupId === request.group.id);
      if (!currentDelivery || currentDelivery.phase !== "ready" || currentDelivery.integrationDigest !== receipt.digest || currentDelivery.handoff) return false;
      const currentManifest = current.manifests.find(item => item.id === manifest.id && item.revision === manifest.revision);
      const currentGroup = currentManifest?.deliveryGroups.find(item => item.id === request.group.id);
      const currentAuthorization = current.authorizations.find(item => item.id === authorization.id);
      if (!currentManifest || digest(currentManifest) !== digest(manifest) || !currentGroup || digest(currentGroup) !== digest(request.group) || !currentAuthorization) return false;
      try { validateAuthorization(currentManifest, currentAuthorization); } catch { return false; }
      return currentAuthorization.publicationRepository === intent.publicationRepository;
    };
    const persistUnknown = (reason: string): void => {
      try { store.transact(currentOwner, draft => { const latest = draft.controllerBootstrapIntents?.find(item => item.operationId === operationId); if (latest && latest.phase !== "complete") { latest.phase = "unknown"; latest.updatedAt = now(); latest.reason = reason; } }); } catch { /* retain the conservative unknown fence */ }
    };
    const discoverOnly = async (): Promise<ExecutionPrBootstrapDiscovery> => {
      const latest = store.read();
      const currentIntent = latest.controllerBootstrapIntents?.find(item => item.operationId === operationId);
      if (!bootstrapFence(latest, currentIntent) || currentIntent?.phase === "complete") return { kind: "unknown", reason: "Bootstrap owner/authorization/generation fence changed" };
      try { return await bootstrapPr!.discover(bootstrapRequest()); }
      catch (error) { return { kind: "unknown", reason: String(error) }; }
    };
    if (intent.phase !== "planned") {
      const retry = await discoverOnly();
      if (retry.kind === "found") return persistRemote(retry);
      if (retry.kind === "unknown") { persistUnknown(retry.reason); return retry; }
      if (retry.kind === "refused") return retry;
      return { kind: "unknown", reason: "Prior PR bootstrap outcome is unknown; reconcile the deterministic branch before retrying" };
    }
    const initial = await discoverOnly();
    if (initial.kind === "found") return persistRemote(initial);
    if (initial.kind === "unknown" || initial.kind === "refused") {
      if (initial.kind === "unknown") persistUnknown(initial.reason);
      return initial;
    }
    try {
      store.transact(currentOwner, draft => { const latest = draft.controllerBootstrapIntents?.find(item => item.operationId === operationId); if (!latest || latest.phase !== "planned" || latest.publicationRepository !== intent.publicationRepository) throw new Error("Bootstrap intent is no longer creatable"); latest.phase = "creating"; latest.updatedAt = now(); delete latest.reason; });
    } catch (error) { return { kind: "unknown", reason: String(error) }; }
    const beforeCreate = store.read();
    const createIntent = beforeCreate.controllerBootstrapIntents?.find(item => item.operationId === operationId);
    if (!createIntent) return { kind: "unknown", reason: "Bootstrap owner/authorization/generation fence changed before publication" };
    if (!bootstrapFence(beforeCreate, createIntent) || createIntent.phase !== "creating") return { kind: "unknown", reason: "Bootstrap owner/authorization/generation fence changed before publication" };
    let created: ExecutionPrBootstrapCreation;
    try { created = await bootstrapPr!.create(bootstrapRequest()); }
    catch (error) { created = { kind: "unknown", reason: String(error) }; }
    if (created.kind === "found" || created.kind === "created") return persistRemote(created);
    if (created.kind === "unknown") persistUnknown(created.reason);
    if (created.kind === "refused") return created;
    return { kind: "unknown", reason: "PR bootstrap did not produce a reconciled mapping" };

  };
  const resolvePr = rawResolvePr && bootstrapPr ? async (request: Parameters<NonNullable<typeof rawResolvePr>>[0]) => {
    const first = await rawResolvePr(request);
    if (first.kind === "authorized" || request.manifest.preset !== "plan-driven") return first;
    const bootstrapped = await bootstrapControllerMapping(request);
    if (bootstrapped.kind !== "authorized") return bootstrapped;
    const resolved = await rawResolvePr(request);
    return resolved.kind === "authorized" ? resolved : { kind: "refused" as const, reason: "Bootstrap mapping was persisted but controller resolution refused it" };
  } : rawResolvePr;
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
    const invocationId = control.invocationId ?? randomUUID();
    store.appendIntent({ id: `intent-${digest([session, authorization.id, control.targetId, control.action, control.immediate ?? false, invocationId])}`, sessionFile: session, authorizationId: authorization.id, kind: control.action, targetId: control.targetId, ...(control.immediate === undefined ? {} : { immediate: control.immediate }), invocationId });
  };
  const bridge: ExecutionBridge = {
    store,
    scheduler,
    get delivery() {
      if (!activeDelivery) throw new Error("Execution coordinator has not started");
      return activeDelivery;
    },
    async start(startOptions = {}) {
      if (started) return;
      if (starting) return starting;
      if (startOptions.resumePriorOwner) {
        const state = store.read();
        const session = realpathSync(options.sessionFile);
        // Clean shutdown leaves lastOwner; a process crash leaves the current
        // owner in place and never gets a chance to record lastOwner. Select
        // the current owner first so a foreign live/dead lease is never
        // bypassed by a stale historical owner. Store.acquire remains the
        // authority for PID liveness and lease contention.
        const recordedOwner = state.owner ?? state.lastOwner;
        let recordedSession = "";
        try { recordedSession = realpathSync(recordedOwner?.sessionFile ?? ""); } catch { /* malformed/missing session is not resumable */ }
        if (!recordedOwner || recordedSession !== session || !activeDurableWork(state)) return;
      }
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
      const publication = result.manifest.deliveryGroups.some(group => group.policy === "pr");
      const publicationRepository = publication ? canonicalPublicationRepository(options.repository ?? "") : undefined;
      const boundary = { capacity, publication, ...(publicationRepository ? { publicationRepository } : {}) };
      const token = digest([randomUUID(), path, source.digest, digest(result.manifest), result.manifest.revision, options.repo, base, boundary]);
      const preview = { token, boundary, path, sourceDigest: source.digest, manifest: result.manifest, unresolvedDecisions: result.unresolvedDecisions, conflicts: interpretationConflicts(result.manifest, capacity, capabilities) };
      pendingPreviews.set(path, structuredClone(preview));
      previewFingerprints.set(preview.token, digest({ path, sourceDigest: preview.sourceDigest, boundary: preview.boundary, manifest: preview.manifest, unresolvedDecisions: preview.unresolvedDecisions, conflicts: preview.conflicts }));
      return structuredClone(preview);
    },
    async run(planPath, approval) {
      let preview: ExecutionPreview;
      try {
        const path = resolvePlanArgument(planPath);
        const pending = approval ? pendingPreviews.get(path) : undefined;
        if (approval && (!pending || !approval.token || approval.token !== pending.token)) return { kind: "refused", reason: "Missing, replaced, or stale approval token; preview again" };
        if (approval && pending) {
          const expected = previewFingerprints.get(pending.token);
          const actual = digest({ path, sourceDigest: pending.sourceDigest, boundary: pending.boundary, manifest: pending.manifest, unresolvedDecisions: pending.unresolvedDecisions, conflicts: pending.conflicts });
          if (!expected || expected !== actual) return { kind: "refused", reason: "Preview integrity changed; preview again" };
        }
        if (pending) {
          if (approval!.capacity !== pending.boundary.capacity || (approval!.publication && !pending.boundary.publication) || approval!.publicationRepository !== pending.boundary.publicationRepository) return { kind: "refused", reason: "Approval exceeds displayed boundary", preview: structuredClone(pending) };
          const source = await importPlanSource(path);
          if (source.digest !== pending.sourceDigest) return { kind: "refused", reason: "Plan changed after preview; import a fresh revision", preview: structuredClone(pending) };
          preview = structuredClone(pending);
        } else preview = await bridge.preview(path);
      } catch (error) { return { kind: "refused", reason: String(error) }; }
      if (preview.unresolvedDecisions.length || preview.conflicts.length) return { kind: "refused", reason: [...preview.unresolvedDecisions, ...preview.conflicts].join("; "), preview };
      if (!approval) {
        pendingPreviews.set(preview.path, structuredClone(preview));
        previewFingerprints.set(preview.token, digest({ path: preview.path, sourceDigest: preview.sourceDigest, boundary: preview.boundary, manifest: preview.manifest, unresolvedDecisions: preview.unresolvedDecisions, conflicts: preview.conflicts }));
        return { kind: "approval-required", preview: structuredClone(preview) };
      }
      const pending = pendingPreviews.get(preview.path);
      if (pending && pending.sourceDigest !== preview.sourceDigest) return { kind: "refused", reason: "Plan changed after preview; import a fresh revision", preview };
      if (preview.boundary.publication && !preview.boundary.publicationRepository) return { kind: "refused", reason: "Publication requires an approved canonical repository destination", preview };
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
