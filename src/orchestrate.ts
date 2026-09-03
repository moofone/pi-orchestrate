/**
 * /orchestrate — parent command for ~/orchestrator Feature → Tasks.
 *
 *   /orchestrate <objective>     planner → plan-reviewer, then wait for approval
 *   /orchestrate approve <name> name folder, auto-advance Tasks, Feature PR + land
 *   /orchestrate resume|status|qa|archive
 *   implement / pr remain as crash-resume escape hatches only
 *
 * Live Feature: ~/orchestrator/<repo>/<name>/{plan.md,status.md,handoffs/}
 * While planning (no title yet): ~/orchestrator/<repo>/pending-<utc>/
 * After `# Feature:` exists, pending-* is renamed to <name>/. No current/
 * pointer. Never slugged from the raw objective.
 * Visible overlay: rpiv-todo `todo` tool, mirrored from planner → plan-reviewer → Tasks → feature-qa.
 * Tasks never start while plan-reviewer is in flight. Approve waits for (or runs)
 * plan-reviewer first. That sequence is code, not a parent-model prompt.
 * Sidecar `orchestrate.json` `autoAdvanceOnLanded` (default true): a Task whose
 * worktree changed is marked done and the chain continues even if the
 * acceptance harness reported failed. Per-Feature override:
 * `auto_advance_on_landed` in status.md.
 * Approve is a TUI card (`orchestrate-approve` entry), not a markdown fence.
 * Never .pi/plan.md / enter_plan_mode. Workers never open a PR; code runs `gh pr create`.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  actionableFingerprint,
  armObservedLatch,
  findFeatureOwningPr,
  isDriverRunning,
  landFailedAlreadyMerged,
  listFeaturePrOwners,
  MECHANICAL,
  parseKeyedField,
  printedLandCommand,
  repoKey,
  spendWaiterVerdict,
  undeliveredWaiterVerdicts,
  wakeLiveLatch,
  waiterPaths,
  type FeaturePrOwner,
} from "./lib/pr-await-core.ts";
import {
  TRANSITIONS_LOG as TRANSITIONS_LOG_NAME,
  formatTransitionLogLine,
  isInterruption,
  readPhase as readFeaturePhase,
  writeStatusFields,
  resumePhase,
  statusField,
  transitionRefusal as phaseTransitionRefusal,
  type FeaturePhase,
  type FeaturePhase as Phase,
} from "./lib/feature-state.ts";
import {
  DEFAULT_QA_PASS_CAP,
  needsFeatureQa,
  needsPlanReview,
  planReviewReconcile,
  planReviewState,
  qaPassState,
  writerBlockedByPlanReview,
} from "./lib/lifecycle.ts";
import { spawnDetachedWaiter } from "./lib/pr-await-drive.ts";
import { reconcileFeaturePrs, type ReconcileResult } from "./lib/pr-reconcile.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  overlayTodosFromFeature,
  overlayWidgetLines,
  projectOverlayTodos,
  type OverlayTodo,
  type OverlayTodoState,
} from "./lib/overlay.ts";
import {
  classifyFeaturePrNext,
  fixSpawnCount,
  fixerPushState,
  fixerSettleAction,
  type FeaturePrAction,
} from "./lib/feature-pr.ts";
import {
  featureTitle,
  isApproved,
  isDraft,
  isPendingToken,
  MAX_TASKS,
  parseTasks,
  PENDING_TOKEN,
  planHeaderField,
  planHeaderStatus,
  planRepoName,
  reopenTasksThatNeverStarted,
  setTaskHandoffInPlan,
  setTaskStatusInPlan,
  taskCountError,
  taskGateCommand,
  taskSection,
  type Task,
} from "./lib/plan-tasks.ts";

// The latch reads Feature ownership from the same helper; re-exported here so
// the dispatcher has one public surface and the latch never imports this file.
export { findFeatureOwningPr };
export { parseKeyedField };
export type { FeaturePrOwner } from "./lib/pr-await-core.ts";

const ORCH_ROOT = join(homedir(), "orchestrator");
const REF_ROOT = join(homedir(), "Dev/git");
/** Isolated host-Feature lanes. Pi auto-loads each extensions/<name>/index.ts; never put a lane there. */
export const HOST_WORKTREE_ROOT = join(homedir(), ".pi/agent/worktrees");
/** Repo → worktree farm directory name. Default is `<repo>-wt`. */
const REPO_TO_WT_ROOT: Record<string, string> = {
  icemining: "ice-wt",
  "icemining-devops": "devops-wt",
};

export function worktreeFarmFor(repo: string): string {
  if (isHostBase(repo)) return HOST_WORKTREE_ROOT;
  const farm = REPO_TO_WT_ROOT[repo] ?? `${repo}-wt`;
  return join(REF_ROOT, farm);
}
export const GIT_WORKFLOW_SKILL = "/Users/greg/.grok/skills/git-workflow/SKILL.md";

export const FORBIDDEN = [
  "Do NOT call enter_plan_mode or exit_plan_mode.",
  "Do NOT write `.pi/plan.md`, repo-root `plan.md`, or any plan file inside the git worktree.",
  "Do NOT ask how to deliver the plan (no questionnaire / no “exit plan mode to write a file”).",
  "Do NOT implement product code in this parent session.",
  "Do NOT open a PR per Task. tdd-worker never opens a PR.",
  "Do NOT edit, stage, or commit in a reference checkout under ~/Dev/git/<repo>.",
  "Do NOT launch tdd-worker with cwd set to a reference checkout.",
  "Do NOT spawn tdd-worker, fixer, feature-qa, qa-opus, planner, or plan-reviewer from this parent. The /orchestrate extension launches those.",
  "Do NOT launch tdd-worker on composer-*, inherit, or unnamed models. Simple tdd-worker is zai/glm-5.3-flash:medium. Critical tdd-worker is cursor/grok-4.6:medium. feature-qa, qa-opus, and plan-reviewer run on the reviewer model configured once in extensions/orchestrate.json (`qaModel`, xai/grok-4.6:high) — never name your own. Never fall back to this session's model.",
  "ALWAYS follow git-workflow aliases: `git wt`, `git pr-await`, `git pr-land`, `git wt-rm`. Never raw `git worktree add` / `gh pr merge` for those steps.",
  "`next=yield` means stop talking. Do not re-invoke, pipe, `timeout`, or `--once` on `git pr-await`. `ghl-pr-await` owns the wait.",
].join("\n");

interface Paths {
  repo: string;
  gitRoot: string;
  repoDir: string;
  featureDir: string;
  planFile: string;
  statusFile: string;
  handoffsDir: string;
  archiveDir: string;
}

const RESERVED_NAMES = new Set(["current", "archive", "pending"]);

const WORKERS = {
  simple: {
    model: "zai/glm-5.3-flash",
    thinking: "medium",
    short: "glm medium",
  },
  critical: {
    model: "cursor/grok-4.6",
    thinking: "medium",
    short: "cursor grok medium",
  },
} as const;

function workerFor(complexity?: "simple" | "critical") {
  return complexity ? WORKERS[complexity] : undefined;
}

const WRITER_AGENTS = new Set(["tdd-worker", "fixer", "feature-qa", "qa-opus", "plan-reviewer"]);

/**
 * The review agents, and the one place their model is decided.
 *
 * Reviewers are a different allow-list from writers: `settings.json` scopes
 * these three to `qaModel` (xai/grok-4.6). GLM flash is legal for a simple
 * tdd-worker and refused here; launching QA on the wrong id is refused by
 * modelScope before the child starts and parks a finished Feature at
 * `feature-qa failed` with no PR, forever, which is why the id is read from
 * one place rather than repeated at each launch site.
 *
 * To change the reviewer model, edit `qaModel` in `orchestrate.json` and
 * widen `modelScope.agents.*` in settings.json to match. Nothing else.
 */
const QA_AGENTS = new Set(["feature-qa", "qa-opus", "plan-reviewer"]);
const DEFAULT_QA_MODEL = "xai/grok-4.6";
/** Per-agent thinking, used when neither the caller nor `qaModel` names one. */
const QA_THINKING: Record<string, string> = {
  "feature-qa": "high",
  "qa-opus": "high",
  "plan-reviewer": "high",
};

/** QA never launches above high. Simple tdd-worker is glm medium. */
function capThinking(level: string): string {
  return /^(xhigh|extra-high|max)$/i.test(level.trim()) ? "high" : level;
}

function qaModelSetting(jsonText?: string): string {
  const text = jsonText ?? (existsSync(SIDECAR_PATH) ? readText(SIDECAR_PATH) : "");
  if (!text.trim()) return DEFAULT_QA_MODEL;
  try {
    const parsed = JSON.parse(text) as { qaModel?: unknown };
    if (typeof parsed.qaModel === "string" && parsed.qaModel.trim()) return parsed.qaModel.trim();
  } catch {
    /* malformed sidecar keeps the default */
  }
  return DEFAULT_QA_MODEL;
}

/** The reviewer model id without any `:thinking` suffix. */
export function qaModelBase(jsonText?: string): string {
  return (qaModelSetting(jsonText).split(":")[0] ?? "").trim().toLowerCase() || DEFAULT_QA_MODEL;
}

/** The full `id:thinking` a reviewer launches on. Caller level wins. */
export function qaModelFor(agent: string, thinking?: string, jsonText?: string): string {
  const configured = qaModelSetting(jsonText).split(":")[1]?.trim();
  const level = capThinking(thinking?.trim() || configured || QA_THINKING[agent] || "high");
  return `${qaModelBase(jsonText)}:${level}`;
}

export function isAllowedQaModel(model: string, jsonText?: string): boolean {
  if (typeof model !== "string") return false;
  return (model.split(":")[0] ?? "").trim().toLowerCase() === qaModelBase(jsonText);
}

/** Writers may not inherit the parent Cursor Grok session. */
export function isAllowedWriterModel(model: string): boolean {
  if (typeof model !== "string") return false;
  const base = (model.split(":")[0] ?? "").trim().toLowerCase();
  return (
    base === "zai/glm-5.3-flash" ||
    base === "cursor/grok-4.6" ||
    base === "cursor/gpt-5.6-luna" ||
    base === "anthropic/claude-opus-5"
  );
}

/** Why this spawn must not go out. `undefined` means the guard does not apply or the model is allowed. */
export function writerSpawnRejection(params: Record<string, unknown>): string | undefined {
  const agent = typeof params.agent === "string" ? params.agent : "";
  if (!WRITER_AGENTS.has(agent)) return undefined;
  const model = typeof params.model === "string" ? params.model.trim() : "";
  const allowed = QA_AGENTS.has(agent) ? isAllowedQaModel(model) : isAllowedWriterModel(model);
  if (allowed) return undefined;
  const shown = model || "(inherited parent model)";
  return QA_AGENTS.has(agent)
    ? `refusing ${agent} on ${shown}; QA is ${qaModelFor(agent)} only — never inherit`
    : `refusing ${agent} on ${shown}; orchestration writers are ` +
        `zai/glm-5.3-flash or cursor/grok-4.6 only — never composer or inherit`;
}

/**
 * pi-subagents reads reasoning effort from a `:level` suffix on the model id or
 * from the agent's own frontmatter. A top-level `thinking` launch parameter is
 * only consumed by `action='watchdog.configure'`, so passing it here would be
 * silently dropped and every child would inherit its agent default instead of
 * the level this table names.
 */
function modelWithThinking(worker: { model: string; thinking: string }): string {
  return `${worker.model}:${worker.thinking}`;
}

function utcStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

const NAME_MAX = 36;
const PLACEHOLDER_TITLE =
  /^(?:\(planning\)|planning|untitled|\(untitled\)|\(draft\)|draft)$/i;

function slug(text: string, max = NAME_MAX): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s) return "feature";
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const i = cut.lastIndexOf("-");
  return (i >= 12 ? cut.slice(0, i) : cut).replace(/-+$/g, "") || "feature";
}

/**
 * `git check-ref-format --branch` rules, as far as a planner-authored
 * `> Branch:` header can violate them. A title annotated with prose —
 * `feat/x (both repos: a, b)` — still starts with `feat/` but is not a ref.
 */
const BAD_REF = /[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|\.lock$|^[/.]|[/.]$/;

function isValidBranchName(branch: string): boolean {
  return !!branch && !BAD_REF.test(branch);
}

function isPlaceholderTitle(title: string): boolean {
  return !title.trim() || PLACEHOLDER_TITLE.test(title.trim());
}

/** Short unique identity from the plan title — not the raw user objective. */
function nameFromTitle(title: string): string {
  if (isPlaceholderTitle(title)) return "";
  const cleaned = title.replace(/^(?:feature|plan)\s*[:.—–-]+\s*/i, "");
  return slug(cleaned);
}

function firstRealName(...values: string[]): string {
  for (const value of values) {
    if (value && !isPendingToken(value)) return value;
  }
  return "";
}

/** Folder / approve-command name: skip `pending`, then the `# Feature:` slug. */
export function featureIdentityName(plan: string, status = "", dir = ""): string {
  return (
    firstRealName(
      statusField(status, "name"),
      planHeaderField(plan, "Name"),
      nameFromTitle(featureTitle(plan, "")),
    ) || (dir && !isPendingToken(basename(dir)) ? basename(dir) : "")
  );
}

function isApprovableName(name: string): boolean {
  return !!name && !isPendingToken(name) && !/^pending-\d{4}-/.test(name);
}

function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name);
}

function listTakenNames(paths: Paths, keep?: string): Set<string> {
  const taken = new Set<string>(RESERVED_NAMES);
  if (existsSync(paths.archiveDir)) {
    for (const ent of readdirSync(paths.archiveDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const stamped = ent.name.match(/^\d{4}-\d{2}-\d{2}T[0-9-]+Z(?:-(.+))?$/);
      taken.add(stamped?.[1] || ent.name);
    }
  }
  if (existsSync(paths.repoDir)) {
    for (const ent of readdirSync(paths.repoDir, { withFileTypes: true })) {
      if (ent.name === "current" || ent.name === "archive") continue;
      if (ent.isDirectory() || ent.isSymbolicLink()) taken.add(ent.name);
    }
  }
  const farm = worktreeFarmFor(paths.repo);
  if (existsSync(farm)) {
    for (const ent of readdirSync(farm, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith("feat-")) taken.add(ent.name.slice("feat-".length));
    }
  }
  if (keep && !isPendingToken(keep) && !isReservedName(keep)) taken.delete(keep);
  return taken;
}

function uniquifyName(base: string, taken: Set<string>): string {
  const root = base && !isReservedName(base) ? base : "feature";
  if (!taken.has(root) && !isReservedName(root)) return root;
  for (let n = 2; n < 100; n++) {
    const candidate = `${root.slice(0, Math.max(8, NAME_MAX - 3))}-${n}`;
    if (!taken.has(candidate) && !isReservedName(candidate)) return candidate;
  }
  return `${root.slice(0, 20)}-${utcStamp().slice(0, 15)}`;
}

function lstatSafe(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function bindFeature(paths: Paths, dir: string): Paths {
  paths.featureDir = dir;
  paths.planFile = join(dir, "plan.md");
  paths.statusFile = join(dir, "status.md");
  paths.handoffsDir = join(dir, "handoffs");
  return paths;
}

/** `~/orchestrator/<repo>/<name>` or `~/orchestrator/<repo>/archive/<ts>-<name>`. */
export function featureRepoFromDir(dir: string): string | undefined {
  const root = ORCH_ROOT.replace(/\/+$/, "");
  const normalized = dir.replace(/\/+$/, "");
  if (normalized === root || !normalized.startsWith(`${root}/`)) return undefined;
  const repo = normalized.slice(root.length + 1).split("/")[0];
  if (!repo || RESERVED_NAMES.has(repo)) return undefined;
  return repo;
}

/**
 * Direct child of `~/Dev/git` that is a product checkout, not the farm root
 * itself and not a `*-wt` worktree farm.
 */
export function repoNameFromGitRoot(gitRoot: string): string | undefined {
  const root = gitRoot.replace(/\/+$/, "");
  if (!root || root === REF_ROOT) return undefined;
  if (isWorktreeFarm(root)) return undefined;
  if (dirname(root) === REF_ROOT) return basename(root);
  return undefined;
}

function rebindToFeatureDir(paths: Paths, dir: string): Paths {
  const repo = featureRepoFromDir(dir);
  if (repo) {
    paths.repo = repo;
    paths.repoDir = join(ORCH_ROOT, repo);
    paths.archiveDir = join(paths.repoDir, "archive");
    const gitRoot = join(REF_ROOT, repo);
    if (existsSync(gitRoot)) paths.gitRoot = gitRoot;
  }
  return bindFeature(paths, dir);
}

/** Rename pending-* (or any pre-name folder) → <name>/. No current/ symlink. */
function promoteLiveFolder(paths: Paths, name: string): string {
  if (!name || isPendingToken(name) || isReservedName(name)) {
    return paths.featureDir;
  }
  const dest = join(paths.repoDir, name);
  if (!paths.featureDir) {
    mkdirSync(join(dest, "handoffs"), { recursive: true });
    bindFeature(paths, dest);
    return dest;
  }
  const src = paths.featureDir;
  if (src !== dest && existsSync(src) && !existsSync(dest)) {
    renameSync(src, dest);
    if (basename(src).startsWith("pending-")) {
      try {
        symlinkSync(relative(dirname(src), dest) || name, src);
      } catch {
        /* dest is the source of truth */
      }
    }
  }
  bindFeature(paths, dest);
  return dest;
}

function upsertHeader(plan: string, key: string, value: string): string {
  const re = new RegExp(`^>\\s*${key}:\\s*.*$`, "im");
  if (re.test(plan)) return plan.replace(re, `> ${key}: ${value}`);
  if (/^>\s*Status:/m.test(plan)) {
    return plan.replace(/^(>\s*Status:.*)$/m, `$1\n> ${key}: ${value}`);
  }
  if (/^#\s+.+$/m.test(plan)) {
    return plan.replace(/^(#\s+.+)$/m, `$1\n\n> ${key}: ${value}`);
  }
  return `> ${key}: ${value}\n${plan}`;
}

function isPaused(status: string): boolean {
  const v = statusField(status, "pause").toLowerCase();
  return v === "after-task" || v === "on" || v === "yes" || v === "paused";
}

const DEFAULT_AUTO_ADVANCE_ON_LANDED = true;
const SIDECAR_PATH = join(dirname(fileURLToPath(import.meta.url)), "orchestrate.json");

/** `true`/`yes`/`on`/`1` and `false`/`no`/`off`/`0`. Empty or unknown → fallback. */
export function parseFlag(raw: string, fallback: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (!v) return fallback;
  if (v === "true" || v === "yes" || v === "on" || v === "1") return true;
  if (v === "false" || v === "no" || v === "off" || v === "0") return false;
  return fallback;
}

export function sidecarAutoAdvanceOnLanded(jsonText?: string): boolean {
  const text = jsonText ?? (existsSync(SIDECAR_PATH) ? readText(SIDECAR_PATH) : "");
  if (!text.trim()) return DEFAULT_AUTO_ADVANCE_ON_LANDED;
  try {
    const parsed = JSON.parse(text) as { autoAdvanceOnLanded?: unknown };
    if (typeof parsed.autoAdvanceOnLanded === "boolean") return parsed.autoAdvanceOnLanded;
    if (typeof parsed.autoAdvanceOnLanded === "string") {
      return parseFlag(parsed.autoAdvanceOnLanded, DEFAULT_AUTO_ADVANCE_ON_LANDED);
    }
  } catch {
    /* malformed sidecar keeps the default */
  }
  return DEFAULT_AUTO_ADVANCE_ON_LANDED;
}

/** Feature status.md overrides sidecar. Missing key inherits sidecar (default true). */
export function autoAdvanceOnLanded(
  status: string,
  sidecar = sidecarAutoAdvanceOnLanded(),
): boolean {
  const raw = statusField(status, "auto_advance_on_landed");
  return raw ? parseFlag(raw, sidecar) : sidecar;
}

/** Both fingerprints must be readable; identical or empty is not a land. */
export function worktreeChanged(before: string, after: string): boolean {
  return Boolean(before && after && before !== after);
}

/**
 * What the Feature chain does with one Task's result.
 *
 * This is only the Task-to-Task decision. It never returns a Feature-end
 * action (`qa` / `pr` / next Feature): those are a different loop, and a
 * success that did not touch ice-wt (host-only Features) must still start
 * the next Task instead of blocking the Feature.
 */
export type TaskSettleAction = "done_continue" | "blocked" | "pending_pause";

/** What the Task's own `- Command:` gate said. `none` = the Task had none. */
export type TaskGate = "none" | "green" | "red";

export function taskGateResult(input: { gated: boolean; ok: boolean }): TaskGate {
  if (!input.gated) return "none";
  return input.ok ? "green" : "red";
}

export function settleTaskOutcome(input: {
  ok: boolean;
  stopped?: boolean;
  landed: boolean;
  autoAdvance: boolean;
  /** The Task has a runnable `- Command:` gate, so `ok` is a verified fact. */
  gated?: boolean;
}): { action: TaskSettleAction; reason: string } {
  if (!input.ok && input.stopped) return { action: "pending_pause", reason: "stopped" };
  if (input.ok) return { action: "done_continue", reason: input.landed ? "ok" : "ok_unchanged" };
  // `failed_but_landed` exists for the 39% of Tasks with no runnable gate,
  // where a harness fail plus a changed worktree usually means the child's own
  // report was the only thing that failed. Where a real command ran and came
  // back red, that reading is wrong: the Task is broken and the chain must not
  // build the next Task on top of it (F13).
  if (input.gated) return { action: "blocked", reason: "failed_gate" };
  if (input.landed && input.autoAdvance) {
    return { action: "done_continue", reason: "failed_but_landed" };
  }
  return { action: "blocked", reason: input.landed ? "failed" : "failed_unchanged" };
}

/* ------------------------------------------------------------------ *
 * Orphan-run recovery
 *
 * `runFeatureChain` is an in-process loop, and `runChild` settles on an
 * event delivered to this process. When the pi session that owns the chain
 * exits while a tdd-worker is still running, the child keeps going in its
 * own process and finishes normally — but nobody is listening. plan.md is
 * left saying `in_progress`, status.md keeps a `worker_run_id` that will
 * never settle, and the Task's work sits on the branch unrecorded.
 *
 * The next `/orchestrate resume` used to pick that `in_progress` Task first
 * and run it again. The work was already committed, so the second worker
 * changed nothing, tripped the unchanged-worktree guard, and left the Task
 * `blocked` — after which the blocked guard made resume refuse forever.
 *
 * pi-subagents writes each run's lifecycle to `status.json` on disk, so the
 * answer to "what happened to that child?" outlives the session that
 * spawned it. Recovery reads it, and decides from that plus git evidence.
 * ------------------------------------------------------------------ */

/** Where pi-subagents keeps async run artifacts for this uid. */
export function asyncRunDir(runId: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(tmpdir(), `pi-subagents-uid-${uid}`, "async-subagent-runs", runId);
}

export interface RunSnapshot {
  state: string;
  terminal: boolean;
  ok: boolean;
  stopped: boolean;
  startedAtMs: number;
}

const TERMINAL_RUN_STATES = new Set([
  "complete",
  "completed",
  "failed",
  "error",
  "stopped",
  "cancelled",
  "canceled",
  "rejected",
  "timeout",
  "timed_out",
]);

/** States that mean "someone stopped this", which is a re-run, not a failure. */
const STOPPED_RUN_STATES = new Set(["stopped", "cancelled", "canceled", "rejected"]);

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a live process this uid may not signal; ESRCH is a dead one.
    return (error as { code?: string })?.code === "EPERM";
  }
}

/**
 * One async run's terminal state, read from its own on-disk lifecycle file.
 *
 * A recorded `running` whose runner pid is gone is terminal too: that run
 * died with the session that spawned it and will never write another byte.
 * Believing the file alone would make recovery wait forever for a corpse.
 */
export function readRunSnapshot(
  dir: string,
  isAlive: (pid: number) => boolean = processAlive,
): RunSnapshot | undefined {
  if (!dir) return undefined;
  const raw = readText(join(dir, "status.json"));
  if (!raw.trim()) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const state = typeof parsed.state === "string" ? parsed.state.toLowerCase() : "";
  const steps = Array.isArray(parsed.steps) ? (parsed.steps as { status?: unknown }[]) : [];
  const stepStates = steps.map((s) =>
    typeof s?.status === "string" ? s.status.toLowerCase() : "",
  );
  const ended = typeof parsed.endedAt === "number" && parsed.endedAt > 0;
  const pid = typeof parsed.pid === "number" ? parsed.pid : 0;
  const alive = !ended && isAlive(pid);
  const stopped =
    STOPPED_RUN_STATES.has(state) || stepStates.some((s) => STOPPED_RUN_STATES.has(s));
  const terminal = ended || TERMINAL_RUN_STATES.has(state) || !alive;
  const ok =
    terminal &&
    !stopped &&
    (state === "complete" || state === "completed") &&
    stepStates.every((s) => s === "complete" || s === "completed");
  return {
    state,
    terminal,
    ok,
    stopped,
    startedAtMs: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
  };
}

export type OrphanDecision = "wait" | "done" | "blocked" | "rerun";

/**
 * What to do with a Task left `in_progress` by a session that is gone.
 *
 * Every branch mirrors what the live chain would have decided had it seen
 * the completion itself, so recovery cannot be a softer path to `done` than
 * running the Task normally.
 */
export function orphanDecision(
  snapshot: RunSnapshot | undefined,
  landed: boolean,
  autoAdvance: boolean,
  gated = false,
): OrphanDecision {
  // No run artifact at all (retention swept it, or the spawn never named a
  // run): git evidence is the only witness left.
  if (!snapshot) return landed ? "done" : "rerun";
  if (!snapshot.terminal) return "wait";
  if (snapshot.stopped) return "rerun";
  if (snapshot.ok) return landed ? "done" : "blocked";
  // Same rule as `settleTaskOutcome`: recovery is not a softer path past a
  // gate that ran and came back red (F13).
  if (gated) return "blocked";
  return landed && autoAdvance ? "done" : "blocked";
}

/** status.md holds one value per line, and a fingerprint is two. */
export function fingerprintTag(fingerprint: string): string {
  if (!fingerprint) return "";
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);
}

/**
 * Did the orphaned worker leave anything behind?
 *
 * The recorded pre-Task fingerprint is the exact answer. Features started
 * before that field existed have none, so the fallback is the handoff file:
 * the worker writes it last, so one dated after the run started is this
 * run's, while an older one is a leftover from a previous attempt.
 */
export function landedByEvidence(evidence: {
  baseTag: string;
  nowTag: string;
  handoffMtimeMs?: number;
  runStartedAtMs?: number;
}): boolean {
  if (evidence.baseTag && evidence.nowTag) return evidence.baseTag !== evidence.nowTag;
  const handoff = evidence.handoffMtimeMs ?? 0;
  const started = evidence.runStartedAtMs ?? 0;
  return handoff > 0 && started > 0 && handoff >= started;
}

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export const APPROVE_ENTRY = "orchestrate-approve";

export interface ApproveCardData {
  name: string;
  command: string;
  title?: string;
  branch?: string;
  dir?: string;
}

export function approveCommand(name: string): string {
  return `/orchestrate approve ${name}`;
}

/** Pi draws fences as literal ```, so strip approve fences; the TUI card is the block. */
export function stripApproveFences(markdown: string): { markdown: string; names: string[] } {
  const names: string[] = [];
  let next = markdown.replace(
    /[ \t]*```[a-zA-Z0-9_-]*[ \t]*\r?\n[ \t]*\/orchestrate[ \t]+approve[ \t]+([a-z0-9][a-z0-9-]{0,48})[ \t]*\r?\n[ \t]*```[ \t]*/gi,
    (_m, name: string) => {
      names.push(String(name));
      return "";
    },
  );
  next = next.replace(/^[ \t]*Approve with:[ \t]*\n+/gim, "");
  next = next.replace(/\n{3,}/g, "\n\n");
  return { markdown: next, names };
}

export function approveCardMarkerPath(dir: string): string {
  return join(dir, "handoffs", "approve-card.shown");
}

export function draftApproveCards(
  rows: { archived: boolean; dir: string; name: string; plan: string; status: string }[],
): ApproveCardData[] {
  const out: ApproveCardData[] = [];
  for (const row of rows) {
    if (row.archived) continue;
    if (!isDraft(row.plan) || isApproved(row.plan)) continue;
    // Approve is the last user step after plan-reviewer finishes. A card
    // during planning/review is how Task 1 used to overlap the reviewer.
    if (planReviewState(row.status) !== "done") continue;
    const name = featureIdentityName(row.plan, row.status, row.dir);
    if (!isApprovableName(name)) continue;
    const branch =
      firstRealName(
        statusField(row.status, "branch"),
        planHeaderField(row.plan, "Branch"),
      ) || `feat/${name}`;
    out.push({
      name,
      command: approveCommand(name),
      title: featureTitle(row.plan, name),
      branch,
      dir: row.dir,
    });
  }
  return out;
}

type ApproveTheme = {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

function visibleWidth(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function clipVisible(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

/** Duck-typed TUI component: bordered card, no `@earendil-works/pi-tui` import. */
export function renderApproveEntry(
  entry: { data?: ApproveCardData },
  _options: { expanded: boolean },
  theme: ApproveTheme,
): { render: (width: number) => string[]; invalidate: () => void } {
  const data = entry.data ?? { name: "pending", command: approveCommand("pending") };
  const subtitle = [data.title, data.branch].filter(Boolean).join(" · ");
  const rows: { text: string; paint: (s: string) => string }[] = [
    { text: "Approve", paint: (s) => theme.fg("customMessageLabel", s) },
  ];
  if (subtitle) rows.push({ text: subtitle, paint: (s) => theme.fg("muted", s) });
  rows.push({ text: data.command, paint: (s) => theme.bold(theme.fg("accent", s)) });
  return {
    invalidate() {},
    render(width: number) {
      const outer = Math.max(20, Math.min(width, 80));
      const inner = Math.max(1, outer - 4);
      const h = "─".repeat(inner + 2);
      const top = theme.bg("customMessageBg", theme.fg("border", `┌${h}┐`));
      const bot = theme.bg("customMessageBg", theme.fg("border", `└${h}┘`));
      const body = rows.map((row) => {
        const clipped = clipVisible(row.text, inner);
        const padded = clipped + " ".repeat(inner - visibleWidth(clipped));
        return theme.bg(
          "customMessageBg",
          `${theme.fg("border", "│")} ${row.paint(padded)} ${theme.fg("border", "│")}`,
        );
      });
      return [top, ...body, bot];
    },
  };
}

/**
 * Draw the approve card for every named draft. Read-only with respect to the
 * Feature: it renders what exists and writes nothing but its own shown-marker.
 *
 * It used to call `ensureFeatureNamed` first, from the `agent_settled` handler
 * — which renames `pending-<utc>` to `<name>` the instant a `# Feature:` line
 * appears, while the planner child is still writing to the path it was handed.
 * The planner recreated the pending folder, the completion path named it too, and
 * `uniquifyName` appended `-2`. Three folders per plan, the real one under the
 * name nobody would type (F15). Naming now happens once, in the planner
 * completion path, under the chain lock. Nothing is hidden by that: the card's
 * name comes from `featureIdentityName`, which derives it from the title, and
 * `discoverFeatures` derives the same one — so `/orchestrate approve <name>`
 * resolves an unnamed folder and approve performs the rename.
 */
function presentDraftApproveCards(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  paths: Paths,
): void {
  try {
    const newly: ApproveCardData[] = [];
    for (const card of draftApproveCards(discoverFeatures(paths))) {
      if (!card.dir) continue;
      const marker = approveCardMarkerPath(card.dir);
      if (readText(marker).trim() === card.name) continue;
      try {
        pi.appendEntry(APPROVE_ENTRY, card);
      } catch {
        continue;
      }
      writeText(marker, `${card.name}\n`);
      newly.push(card);
    }
    if (newly.length !== 1) return;
    try {
      if (!ctx.ui.getEditorText()?.trim()) ctx.ui.setEditorText(newly[0]!.command);
    } catch {
      /* print/RPC mode has no editor; reload invalidates ctx */
    }
  } catch (error) {
    if (!isStaleCtxError(error)) throw error;
  }
}

function formatTodoProgress(paths: Paths, headline: string, extra: string[] = []): string {
  const todos = overlayTodosFromFeature(readText(paths.planFile), readText(paths.statusFile));
  const lines = todos.map((t) => {
    const mark =
      t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : "pending";
    return `- ${t.subject} (${mark})`;
  });
  return [headline, "", "Todos:", ...lines, ...extra].join("\n");
}

export function worktreePathFor(branch: string, repo = "icemining"): string {
  return join(worktreeFarmFor(repo), branch.replace(/\//g, "-"));
}

function isWorktreeFarm(dir: string): boolean {
  const normalized = dir.replace(/\/+$/, "");
  if (normalized === HOST_WORKTREE_ROOT) return true;
  const name = basename(dir);
  return dirname(dir) === REF_ROOT && (name === "ice-wt" || name.endsWith("-wt"));
}

function isReferenceCheckout(gitRoot: string): boolean {
  return dirname(gitRoot) === REF_ROOT && !isWorktreeFarm(gitRoot);
}

function isAllowedWorktreePath(dir: string, repo?: string): boolean {
  if (!dir || !existsSync(join(dir, ".git"))) return false;
  if (isReferenceCheckout(dir)) return false;
  const farm = dirname(dir);
  if (!isWorktreeFarm(farm)) return false;
  if (repo && farm !== worktreeFarmFor(repo)) return false;
  return true;
}

function parseAlreadyUsedWorktree(text: string): string {
  return (text.match(/already used by worktree at '([^']+)'/i)?.[1] ?? "").trim();
}

async function findExistingWorktree(
  pi: ExtensionAPI,
  gitRoot: string,
  branch: string,
): Promise<string | null> {
  const result = await pi.exec("git", ["worktree", "list", "--porcelain"], {
    cwd: gitRoot,
    timeout: 15000,
  });
  if (result.code !== 0) return null;
  const want = `refs/heads/${branch}`;
  for (const block of result.stdout.split(/\n\n+/)) {
    const wt = block.match(/^worktree (.+)$/m)?.[1]?.trim();
    const br = block.match(/^branch (.+)$/m)?.[1]?.trim();
    if (wt && br === want) return wt;
  }
  return null;
}

function hostCopyFilter(from: string): boolean {
  const base = basename(from);
  return base !== "backups" && base !== "node_modules" && base !== ".git";
}

/** Snapshot the live host checkout into an isolated lane. Never the reverse. */
async function materializeHostWorktree(
  pi: ExtensionAPI,
  src: string,
  dest: string,
): Promise<boolean> {
  if (!src || !dest || isLiveHostCheckout(dest) || dest === src) return false;
  if (existsSync(join(dest, ".git"))) return true;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, filter: hostCopyFilter });
  } catch {
    return false;
  }
  try {
    const init = await pi.exec("git", ["init"], { cwd: dest, timeout: 15_000 });
    return init.code === 0 && existsSync(join(dest, ".git"));
  } catch {
    return false;
  }
}

/**
 * What the user is shown when `git wt` produced no worktree.
 *
 * `ghl-wt`'s own stderr goes through verbatim and first: it is the only text
 * that says *why* (no origin, branch already used, dirty base). The old message
 * led with "No usable worktree" and buried git's answer, so a missing remote
 * read as an orchestrate bug (F22).
 */
export function worktreeFailureMessage(
  branch: string,
  result: { stdout?: string; stderr?: string },
  farm: string,
): string {
  const said = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  return [
    `git wt ${branch} --yes produced no worktree.`,
    said || "(no output)",
    `Need a checkout under ${farm}/, never a reference checkout.`,
  ].join("\n");
}

/** Rewrite (or insert) the plan's `> Status:` line as `APPROVED`. */
export function markPlanApproved(plan: string): string {
  if (/^>\s*Status:/m.test(plan)) {
    return plan.replace(/^>\s*Status:.*$/m, "> Status: APPROVED");
  }
  if (/^#\s+.+$/m.test(plan)) {
    return plan.replace(/^(#\s+.+)$/m, `$1\n\n> Status: APPROVED`);
  }
  return `> Status: APPROVED\n${plan}`;
}

export type ApprovePreflight = { ok: true } | { ok: false; reason: string };

/**
 * Approve pre-flight: a Feature that cannot reach a PR must not be started.
 *
 * `ghl-wt` branches off `origin/<default>`, `gh pr create` needs a remote, and
 * `pr-await`/`pr-land` need a PR — so a repo with no `origin` fails the whole
 * lifecycle, and it used to fail *after* the plan had been marked APPROVED,
 * deep inside `ensureFeatureWorktree`, as a raw git internals dump (F16/F22).
 * Host bases are exempt: their worktree is a copy plus `git init`, and they
 * never open a PR.
 */
export function approveRemoteRequirement(input: {
  hostBase: boolean;
  originUrl: string;
  repo: string;
}): ApprovePreflight {
  if (input.hostBase) return { ok: true };
  if (input.originUrl.trim()) return { ok: true };
  return {
    ok: false,
    reason:
      `Cannot approve: ${input.repo} has no git remote "origin", so this Feature could never open a PR. ` +
      `Add one (git remote add origin …), then approve. The plan stays DRAFT.`,
  };
}

/** `remote.origin.url`, or `""` when there is none (or git refused to answer). */
async function originUrl(pi: ExtensionAPI, cwd: string): Promise<string> {
  try {
    const out = await pi.exec("git", ["remote", "get-url", "origin"], {
      cwd,
      timeout: 30_000,
    });
    return out.code === 0 ? out.stdout.trim() : "";
  } catch {
    return "";
  }
}

async function ensureFeatureWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  paths: Paths,
  branch: string,
): Promise<string | null> {
  if (isPendingToken(branch) || !branch.startsWith("feat/")) {
    uiNotify(ctx, `Cannot git wt: branch is ${branch || "pending"}`, "error");
    return null;
  }
  if (!isValidBranchName(branch)) {
    uiNotify(ctx, 
      `Cannot git wt: "${branch}" is not a valid branch name.\nFix "> Branch:" in ${paths.planFile} to a bare feat/<name> ref — annotations belong in the plan body.`,
      "error",
    );
    return null;
  }
  if (isHostBase(paths.repo)) {
    const dest = worktreePathFor(branch, paths.repo);
    if (isLiveHostCheckout(dest)) {
      uiNotify(
        ctx,
        `Host Feature worktree resolved to the live checkout (${dest}). Refusing — edit a lane under ${HOST_WORKTREE_ROOT}.`,
        "error",
      );
      return null;
    }
    const ready = await materializeHostWorktree(pi, paths.gitRoot, dest);
    if (!ready || !isAllowedWorktreePath(dest, paths.repo)) {
      uiNotify(
        ctx,
        `Could not materialize host worktree at ${dest} (copy of ${paths.gitRoot} + git init). Live extensions checkout was not used.`,
        "error",
      );
      return null;
    }
    upsertStatusFile(paths, { worktree: dest, branch });
    return dest;
  }
  const recorded = statusField(readText(paths.statusFile), "worktree");
  const existing = await findExistingWorktree(pi, paths.gitRoot, branch);
  const preferred = worktreePathFor(branch, paths.repo);
  const candidates = [recorded, existing, existsSync(preferred) ? preferred : ""].filter(
    (p): p is string => Boolean(p) && p !== "none",
  );
  for (const dir of candidates) {
    if (isAllowedWorktreePath(dir, paths.repo)) {
      upsertStatusFile(paths, { worktree: dir, branch });
      return dir;
    }
  }
  // One implementation, the Rust one. `--yes` is not optional: `ghl-wt` prompts
  // y/N on stdin, and under pi.exec stdin is empty, so every call without it
  // exited `aborted` — which the retired shell-script fallback then hid behind
  // a second implementation with different semantics (F22).
  const result = await pi.exec("git", ["wt", branch, "--yes"], {
    cwd: paths.gitRoot,
    timeout: 180000,
  });
  const dir =
    (existsSync(preferred) && preferred) ||
    parseAlreadyUsedWorktree(`${result.stderr}\n${result.stdout}`) ||
    (await findExistingWorktree(pi, paths.gitRoot, branch));
  if (!dir || !isAllowedWorktreePath(dir, paths.repo)) {
    uiNotify(
      ctx,
      worktreeFailureMessage(branch, result, basename(worktreeFarmFor(paths.repo))),
      "error",
    );
    return null;
  }
  upsertStatusFile(paths, { worktree: dir, branch });
  return dir;
}

export type FeaturePick = {
  archived: boolean;
  dir: string;
  name: string;
  plan: string;
  status: string;
};

interface FeatureRow extends FeaturePick {
  live: boolean;
}

function discoverFeatures(paths: Paths): FeatureRow[] {
  const rows: FeatureRow[] = [];
  const seen = new Set<string>();
  const consider = (dir: string, archived: boolean) => {
    const planFile = join(dir, "plan.md");
    if (!existsSync(planFile) || seen.has(dir)) return;
    seen.add(dir);
    const plan = readText(planFile);
    const status = readText(join(dir, "status.md"));
    const name = featureIdentityName(plan, status, dir) || basename(dir);
    rows.push({
      name,
      dir,
      live: !archived,
      archived,
      plan,
      status,
    });
  };
  if (existsSync(paths.repoDir)) {
    for (const ent of readdirSync(paths.repoDir, { withFileTypes: true })) {
      if (ent.name === "archive" || ent.name === "current") continue;
      if (ent.isDirectory()) consider(join(paths.repoDir, ent.name), false);
    }
  }
  if (existsSync(paths.archiveDir)) {
    for (const ent of readdirSync(paths.archiveDir, { withFileTypes: true })) {
      if (ent.isDirectory()) consider(join(paths.archiveDir, ent.name), true);
    }
  }
  rows.sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name));
  return rows;
}

/** Levenshtein. Used so `failure` still binds a unique live `failover` Feature. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[b.length]!;
}

function uniqueNearMiss(rows: FeatureRow[], want: string): FeatureRow | undefined {
  const scored = rows
    .filter((r) => !r.archived)
    .map((r) => ({
      r,
      d: Math.min(
        editDistance(want, r.name.toLowerCase()),
        editDistance(want, basename(r.dir).toLowerCase()),
      ),
    }))
    .filter((x) => x.d >= 1 && x.d <= 3)
    .sort((a, b) => a.d - b.d || a.r.name.localeCompare(b.r.name));
  if (scored.length === 0) return undefined;
  if (scored.length > 1 && scored[0]!.d === scored[1]!.d) return undefined;
  return scored[0]!.r;
}

/**
 * Identity strings a typed approve/resume name may use.
 * Includes the untruncated `# Feature:` kebab so planner's
 * `/orchestrate approve <kebab-of-title>` still binds after NAME_MAX cuts the folder.
 */
function featureMatchKeys(row: FeaturePick): string[] {
  const keys = new Set<string>();
  const add = (s: string) => {
    const v = s.trim().toLowerCase();
    if (v && !isPendingToken(v)) keys.add(v);
  };
  add(row.name);
  add(basename(row.dir));
  const title = featureTitle(row.plan, "");
  if (title && !isPlaceholderTitle(title)) {
    const cleaned = title.replace(/^(?:feature|plan)\s*[:.—–-]+\s*/i, "");
    add(slug(cleaned, 80));
  }
  return [...keys];
}

export function matchFeature(rows: FeatureRow[], want: string): FeatureRow | undefined {
  const w = want.trim().toLowerCase();
  if (!w) return undefined;
  const keyed = rows.map((r) => ({ r, keys: featureMatchKeys(r) }));
  const exact = keyed.find((x) => x.keys.includes(w));
  if (exact) return exact.r;
  // NAME_MAX drops a trailing token (`…-commits`). A unique live name that is
  // a hyphen-bounded prefix of the query is that leftover, not a miss.
  const extensions = keyed.filter((x) => {
    if (x.r.archived) return false;
    return x.keys.some((k) => k.length >= 12 && w.startsWith(`${k}-`));
  });
  if (extensions.length === 1) return extensions[0]!.r;
  return (
    rows.find(
      (r) =>
        r.name.toLowerCase().includes(w) ||
        basename(r.dir).toLowerCase().includes(w),
    ) || uniqueNearMiss(rows, w)
  );
}

function featureIsActive(row: FeaturePick): boolean {
  if (row.archived) return false;
  if (parseTasks(row.plan).some((t) => t.status === "in_progress")) return true;
  const phase = statusField(row.status, "phase").toLowerCase();
  return (
    phase === "implementing" ||
    phase === "feature-qa" ||
    phase === "reviewing" ||
    phase === "pr" ||
    phase === "planning"
  );
}

/** Features the approve card would offer: named draft, plan-reviewer done. */
export function featuresWaitingForApprove(rows: FeaturePick[]): FeaturePick[] {
  const cards = draftApproveCards(rows);
  const dirs = new Set(cards.map((c) => c.dir).filter(Boolean));
  const names = new Set(cards.map((c) => c.name));
  return rows.filter(
    (r) => !r.archived && ((r.dir && dirs.has(r.dir)) || names.has(r.name)),
  );
}

export function defaultFeature(
  rows: FeaturePick[],
  verb = "",
): FeaturePick | undefined {
  const live = rows.filter((r) => !r.archived);
  if (verb === "approve") {
    const waiting = featuresWaitingForApprove(live);
    return waiting.length === 1 ? waiting[0] : undefined;
  }
  const active = live.filter(featureIsActive);
  if (active.length === 1) return active[0];
  const drafts = live.filter(
    (r) => isDraft(r.plan) || basename(r.dir).startsWith("pending-"),
  );
  if (active.length === 0 && drafts.length === 1) return drafts[0];
  if (live.length === 1) return live[0];
  return undefined;
}

/** User-facing miss: always `/orchestrate <verb> <actual-name>`, never `<name>`. */
export function missingFeatureMessage(
  verb: string,
  want: string,
  rows: FeaturePick[],
): string {
  const live = rows.filter((r) => !r.archived);
  const names =
    verb === "approve"
      ? featuresWaitingForApprove(live).map((r) => r.name)
      : live.map((r) => r.name);
  const instruct = names.map((n) => `/orchestrate ${verb} ${n}`).join("\n");
  if (want.trim()) {
    if (names.length) return `No Feature matching "${want}".\n${instruct}`;
    // Approve candidates are drafts with plan-reviewer done. Live Features that
    // are still planning must not be reported as "Live: (none)".
    if (verb === "approve" && live.length) {
      return `No Feature matching "${want}". Waiting for approve: (none)`;
    }
    return `No Feature matching "${want}". Live: (none)`;
  }
  if (names.length === 0) {
    return `No Feature to ${verb}. /orchestrate status`;
  }
  return `Which Feature to ${verb}?\n${instruct}`;
}

function orchRepos(): string[] {
  if (!existsSync(ORCH_ROOT)) return [];
  return readdirSync(ORCH_ROOT, { withFileTypes: true })
    .filter((ent) => ent.isDirectory() && !RESERVED_NAMES.has(ent.name))
    .map((ent) => ent.name);
}

function stubPathsForRepo(repo: string): Paths {
  const repoDir = join(ORCH_ROOT, repo);
  return {
    repo,
    gitRoot: join(REF_ROOT, repo),
    repoDir,
    featureDir: "",
    planFile: "",
    statusFile: "",
    handoffsDir: "",
    archiveDir: join(repoDir, "archive"),
  };
}

function discoverAllFeatures(): FeatureRow[] {
  const rows: FeatureRow[] = [];
  const seen = new Set<string>();
  for (const repo of orchRepos()) {
    for (const row of discoverFeatures(stubPathsForRepo(repo))) {
      if (seen.has(row.dir)) continue;
      seen.add(row.dir);
      rows.push(row);
    }
  }
  return rows;
}

function allLiveFeatureNames(): string[] {
  const names: string[] = [];
  for (const row of discoverAllFeatures()) {
    if (row.archived) continue;
    names.push(row.name, basename(row.dir));
  }
  return [...new Set(names)];
}

function selectFeature(
  paths: Paths,
  ctx: ExtensionCommandContext,
  want: string,
  verb: string,
): Paths | null {
  const local = discoverFeatures(paths);
  let row = want ? matchFeature(local, want) : defaultFeature(local, verb);
  const fleet = row ? [] : discoverAllFeatures();
  if (!row) {
    row = want ? matchFeature(fleet, want) : defaultFeature(fleet, verb);
  }
  if (!row || (row.archived && verb !== "status")) {
    const pool = fleet.length ? fleet : local;
    uiNotify(ctx, missingFeatureMessage(verb, want, pool), "error");
    return null;
  }
  const asked = want.trim().toLowerCase();
  if (
    asked &&
    row.name.toLowerCase() !== asked &&
    basename(row.dir).toLowerCase() !== asked
  ) {
    uiNotify(ctx, `Using Feature ${row.name} (matched "${want}")`, "info");
  }
  return rebindToFeatureDir(paths, row.dir);
}

/** Verbs that take a Feature folder name as the next token. */
const NAMED_VERBS = new Set([
  "approve",
  "resume",
  "pause",
  "qa",
  "review",
  "pr",
  "archive",
  "implement",
  "tdd",
]);

/**
 * These are never English objective openers. `/orchestrate approve <name>`
 * must not seed a new Feature, even when the cwd repo has zero live Features
 * (cwd `~/Dev/git` is not a repo). Cross-repo select then binds the real one.
 */
const ALWAYS_MANAGEMENT = new Set(["approve", "resume", "pause", "archive", "pr"]);

/** A Task selector that is never an English word: `all`, `3`, `2-5`. */
const TASK_SELECTOR_RE = /^(?:all|\d+(?:-\d+)?)$/;

/**
 * Decide whether a line that opens with a management verb is that subcommand
 * or an objective that merely starts with the same word ("implement per-shard
 * rate limiting", "review the auth middleware"). Free-form objectives are the
 * common case for this command, so a verb only wins when the rest of the line
 * reads like a Feature or Task selector.
 *
 * `liveNames` is every non-archived Feature name and folder basename.
 */
export function isManagementInvocation(
  head: string,
  rest: string,
  liveNames: string[],
): boolean {
  if (!NAMED_VERBS.has(head)) return false;
  if (ALWAYS_MANAGEMENT.has(head)) return true;
  let tokens = rest.trim() ? rest.trim().toLowerCase().split(/\s+/) : [];
  // `now` is a pause modifier, not part of the selector.
  if (head === "pause") tokens = tokens.filter((t) => t !== "now");
  // A bare verb is unambiguous even with nothing live: the error it produces
  // is the right answer.
  if (tokens.length === 0) return true;
  // One token is a name or a Task selector; keep reporting "No Feature
  // matching" on a typo rather than silently seeding a new Feature.
  // This check is *before* the empty-liveNames bail-out: cwd `~/Dev/git`
  // has no Features of its own, and that used to turn `approve <slug>`
  // into a new pending Feature.
  if (tokens.length === 1) return true;
  // Nothing to select — the line cannot be management, so it is an objective.
  if (liveNames.length === 0) return false;
  // Multi-token management is only `<feature> <task>` or a bare Task selector.
  const names = liveNames.map((n) => n.toLowerCase());
  const first = tokens[0];
  if (first === undefined) return false;
  return TASK_SELECTOR_RE.test(first) || names.some((n) => n === first || n.includes(first));
}

/** Verbs that force the objective reading of a line that starts with a verb. */
const PLAN_VERBS = new Set(["plan", "new"]);

/**
 * The objective text for a line that is not a management invocation. `plan`
 * and `new` are explicit openers and drop their own token; anything else is
 * an objective verbatim, so `/orchestrate implement X` still plans "implement X".
 * Returns "" when an explicit opener carries no objective.
 */
export function objectiveFrom(head: string, rest: string, raw: string): string {
  return PLAN_VERBS.has(head) ? rest.trim() : raw.trim();
}

const VERB_COMPLETIONS = [
  {
    value: "plan",
    label: "plan",
    description: "plan <objective> — new Feature (same as a bare objective)",
  },
  {
    value: "approve",
    label: "approve",
    description: "approve <name> — git wt + Tasks + Feature PR",
  },
  { value: "pause", label: "pause", description: "Stop after current Task" },
  { value: "resume", label: "resume", description: "Unpause and continue" },
  { value: "status", label: "status", description: "All Features, Tasks, PRs" },
  { value: "review", label: "review", description: "xai/grok-4.6 high plan review" },
  { value: "qa", label: "qa", description: "xai/grok-4.6 high QA Tasks on a Feature" },
  { value: "help", label: "help", description: "Usage" },
];

export type FeatureBase = {
  id: string;
  gitRoot: string;
  label: string;
};

export type BaseDecision =
  | { action: "use"; base: FeatureBase }
  | { action: "confirm-switch"; from: FeatureBase; to: FeatureBase }
  | { action: "select" };

export const PI_EXTENSIONS_ROOT = join(homedir(), ".pi/agent/extensions");

export const HOST_BASES: FeatureBase[] = [
  {
    id: "pi-extensions",
    gitRoot: PI_EXTENSIONS_ROOT,
    label: "pi-extensions (~/.pi/agent/extensions)",
  },
];

function underDir(cwd: string, root: string): boolean {
  const c = cwd.replace(/\/+$/, "");
  const r = root.replace(/\/+$/, "");
  return c === r || c.startsWith(`${r}/`);
}

/** True when `dir` is the live auto-loaded host checkout (or a path inside it). */
export function isLiveHostCheckout(dir: string, hosts: FeatureBase[] = HOST_BASES): boolean {
  return hosts.some((b) => underDir(dir || "", b.gitRoot));
}

export function detectFeatureBase(
  cwd: string,
  gitRoot: string,
  hosts: FeatureBase[] = HOST_BASES,
): FeatureBase | undefined {
  const start = (cwd || "").replace(/\/+$/, "");
  for (const host of hosts) {
    if (underDir(start, host.gitRoot) || underDir(gitRoot, host.gitRoot)) return host;
  }
  if (underDir(start, HOST_WORKTREE_ROOT) || underDir(gitRoot, HOST_WORKTREE_ROOT)) {
    return hosts.find((h) => h.id === "pi-extensions") ?? hosts[0];
  }
  const repo = repoNameFromGitRoot(gitRoot) || guessRepoFromCwd(start);
  if (repo) {
    const root = join(REF_ROOT, repo);
    return { id: repo, gitRoot: existsSync(root) ? root : gitRoot, label: `${repo} (${root})` };
  }
  const top = (gitRoot || "").replace(/\/+$/, "");
  if (top && existsSync(join(top, ".git")) && dirname(top) !== REF_ROOT) {
    const id = slug(basename(top));
    return { id, gitRoot: top, label: `${id} (${top})` };
  }
  return undefined;
}

export function baseDecision(detected?: FeatureBase, last?: FeatureBase): BaseDecision {
  if (!detected) return { action: "select" };
  if (!last || last.id === detected.id) return { action: "use", base: detected };
  return { action: "confirm-switch", from: last, to: detected };
}

export function listFeatureBases(hosts: FeatureBase[] = HOST_BASES): FeatureBase[] {
  const out: FeatureBase[] = [];
  const seen = new Set<string>();
  const add = (b: FeatureBase) => {
    if (!b.id || seen.has(b.id)) return;
    seen.add(b.id);
    out.push(b);
  };
  for (const host of hosts) add(host);
  if (existsSync(REF_ROOT)) {
    for (const ent of readdirSync(REF_ROOT, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dir = join(REF_ROOT, ent.name);
      if (isWorktreeFarm(dir)) continue;
      if (existsSync(join(dir, ".git"))) {
        add({ id: ent.name, gitRoot: dir, label: `${ent.name} (${dir})` });
      }
    }
  }
  for (const repo of orchRepos()) {
    add({
      id: repo,
      gitRoot: join(REF_ROOT, repo),
      label: `${repo} (${join(REF_ROOT, repo)})`,
    });
  }
  return out;
}

const LAST_BASE_PATH = join(ORCH_ROOT, ".last-base");

export function readLastBase(jsonText?: string): FeatureBase | undefined {
  const text = jsonText ?? (existsSync(LAST_BASE_PATH) ? readText(LAST_BASE_PATH) : "");
  if (!text.trim()) return undefined;
  try {
    const parsed = JSON.parse(text) as { id?: unknown; gitRoot?: unknown; label?: unknown };
    if (typeof parsed.id !== "string" || !parsed.id.trim()) return undefined;
    const gitRoot = typeof parsed.gitRoot === "string" ? parsed.gitRoot : "";
    return {
      id: parsed.id.trim(),
      gitRoot,
      label: typeof parsed.label === "string" && parsed.label.trim() ? parsed.label : parsed.id,
    };
  } catch {
    return undefined;
  }
}

function writeLastBase(base: FeatureBase): void {
  writeText(LAST_BASE_PATH, `${JSON.stringify({ id: base.id, gitRoot: base.gitRoot, label: base.label })}\n`);
}

function applyBase(paths: Paths, base: FeatureBase): Paths {
  paths.repo = base.id;
  paths.gitRoot = base.gitRoot;
  paths.repoDir = join(ORCH_ROOT, base.id);
  paths.archiveDir = join(paths.repoDir, "archive");
  migrateLegacyCurrent(paths.repoDir);
  return paths;
}

function isHostBase(repo: string, hosts: FeatureBase[] = HOST_BASES): boolean {
  return hosts.some((b) => b.id === repo);
}

function guessRepoFromCwd(cwd: string): string {
  const start = cwd.replace(/\/+$/, "");
  if (!start || start === REF_ROOT) return "";
  const fromRoot = repoNameFromGitRoot(start);
  if (fromRoot) return fromRoot;
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const named = repoNameFromGitRoot(dir);
    if (named) return named;
    if (dirname(dir) === REF_ROOT) {
      return isWorktreeFarm(dir) ? "" : basename(dir);
    }
    const gitPath = join(dir, ".git");
    const st = lstatSafe(gitPath);
    if (st?.isDirectory()) {
      const repo = repoNameFromGitRoot(dir);
      return repo ?? basename(dir);
    }
    if (st?.isFile()) {
      const gitdir = readText(gitPath).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() ?? "";
      const parts = gitdir.split(/[\\/]/);
      const gitIdx = parts.lastIndexOf(".git");
      if (gitIdx > 0) {
        const main = parts[gitIdx - 1] ?? "";
        if (main && main !== "ice-wt" && !main.endsWith("-wt")) return main;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

function liveFeatureNames(repo: string): string[] {
  if (!repo) return allLiveFeatureNames();
  const rows = discoverFeatures(stubPathsForRepo(repo));
  const names = rows.filter((r) => !r.archived).map((r) => r.name);
  return [...new Set(names)];
}

/**
 * Pi TUI replaces the *entire* argument prefix with `item.value` on Tab/Enter.
 * Returning `{ value: "approve" }` after the user typed `approve <name>` would
 * wipe the name, so named verbs complete Feature folders as `"approve <name>"`.
 * Return null once the name is fully typed so Enter submits instead of re-applying.
 */
export function orchestrateArgumentCompletions(
  prefix: string,
  cwd = process.cwd(),
): { value: string; label: string; description?: string }[] | null {
  const raw = prefix ?? "";
  const space = raw.search(/\s/);
  if (space === -1) {
    const p = raw.toLowerCase();
    if (NAMED_VERBS.has(p)) return featureNameCompletions(p, "", cwd);
    const items = VERB_COMPLETIONS.filter((c) => !p || c.value.startsWith(p));
    if (items.length === 1 && items[0]?.value === p) return null;
    return items.length ? items : null;
  }
  const head = raw.slice(0, space).trim().toLowerCase();
  if (!NAMED_VERBS.has(head)) return null;
  return featureNameCompletions(head, raw.slice(space + 1), cwd);
}

function featureNameCompletions(
  verb: string,
  rest: string,
  cwd: string,
): { value: string; label: string; description?: string }[] | null {
  const needle = rest.trim().toLowerCase();
  const names = liveFeatureNames(guessRepoFromCwd(cwd));
  const matched = names.filter(
    (n) =>
      !needle ||
      n.toLowerCase().startsWith(needle) ||
      n.toLowerCase().includes(needle),
  );
  if (matched.length === 0) return null;
  if (needle && matched.length === 1 && matched[0]?.toLowerCase() === needle) {
    return null;
  }
  return matched.map((n) => ({
    value: `${verb} ${n}`,
    label: n,
    description: "Feature",
  }));
}

async function prStateLine(pi: ExtensionAPI, pr: string): Promise<string> {
  if (!pr || pr === "none") return "none";
  try {
    const result = await pi.exec(
      "gh",
      ["pr", "view", pr, "--json", "state,url,number"],
      { timeout: 15000 },
    );
    if (result.code !== 0) return pr;
    const j = JSON.parse(result.stdout) as {
      state?: string;
      url?: string;
      number?: number;
    };
    const st = (j.state || "UNKNOWN").toUpperCase();
    return `${st} ${j.url || pr}`;
  } catch {
    return pr;
  }
}

async function formatFleetStatus(
  pi: ExtensionAPI,
  paths: Paths,
): Promise<string> {
  const rows = paths.repo ? discoverFeatures(paths) : discoverAllFeatures();
  if (rows.length === 0) {
    return paths.repo
      ? `No Features under ${paths.repoDir}\nStart with /orchestrate <objective>`
      : `No Features under ${ORCH_ROOT}\nStart with /orchestrate <objective> from a repo checkout`;
  }
  const blocks: string[] = [`${paths.repo || "all"} Features`, ""];
  for (const row of rows) {
    const header = planHeaderStatus(row.plan) || statusField(row.status, "phase") || "?";
    const mark = row.live ? "●" : row.archived ? "◌" : "○";
    const where = row.live ? "live" : row.archived ? "archived" : "idle";
    const tasks = parseTasks(row.plan);
    const taskLine = tasks.length
      ? tasks.map((t) => `${t.id}:${t.status}`).join("  ")
      : "(no ### Task N sections)";
    const pr = await prStateLine(
      pi,
      statusField(row.status, "pr") || planHeaderField(row.plan, "PR"),
    );
    blocks.push(
      `${mark} ${row.name}  ${header}  ${where}`,
      `  dir: ${row.dir}`,
      `  branch: ${statusField(row.status, "branch") || planHeaderField(row.plan, "Branch") || "pending"}`,
      `  worktree: ${statusField(row.status, "worktree") || "none"}`,
      `  pause: ${statusField(row.status, "pause") || "off"}`,
      `  plan_review: ${statusField(row.status, "plan_review") || "none"}`,
      `  PR: ${pr}`,
      `  Tasks: ${taskLine}`,
      "",
    );
  }
  return blocks.join("\n").trimEnd();
}

function applyFeatureIdentity(
  paths: Paths,
  plan: string,
  name: string,
  branch: string,
): string {
  const dest = promoteLiveFolder(paths, name);
  const namedPlan = join(dest, "plan.md");
  let next = upsertHeader(plan, "Name", name);
  next = upsertHeader(next, "Branch", branch);
  next = upsertHeader(next, "Path", namedPlan);
  writeText(paths.planFile, next);
  upsertStatusFile(paths, {
    feature: featureTitle(next, name),
    name,
    branch,
    dir: dest,
    planPath: namedPlan,
  });
  return next;
}

/** Assign Name + Branch from `# Feature:` once the planner has written a title. */
export function ensureFeatureNamed(
  paths: Paths,
  plan: string,
): { plan: string; name: string; branch: string; assigned: boolean } {
  const existingName = planHeaderField(plan, "Name");
  const existingBranch = planHeaderField(plan, "Branch");
  if (!isPendingToken(existingName) && !isPendingToken(existingBranch)) {
    // Both headers are planner prose until proven otherwise. `name` becomes a
    // directory and `branch` becomes a git ref, so neither is trusted verbatim.
    const name = slug(existingName || existingBranch.replace(/^feat\//, ""));
    const branch =
      existingBranch.startsWith("feat/") && isValidBranchName(existingBranch)
        ? existingBranch
        : `feat/${name}`;
    const next = applyFeatureIdentity(paths, plan, name, branch);
    return { plan: next, name, branch, assigned: false };
  }
  const title = featureTitle(plan, "");
  const base = nameFromTitle(title);
  if (!base) {
    return {
      plan,
      name: existingName || "pending",
      branch: existingBranch || "pending",
      assigned: false,
    };
  }
  const name = uniquifyName(base, listTakenNames(paths, existingName));
  const branch = `feat/${name}`;
  const next = applyFeatureIdentity(paths, plan, name, branch);
  upsertStatusFile(paths, {
    nextAction: `wait for /orchestrate approve ${name}`,
  });
  return { plan: next, name, branch, assigned: true };
}

function readText(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

const STALE_CTX = /stale after session replacement or reload/i;

export function isStaleCtxError(error: unknown): boolean {
  return STALE_CTX.test(String((error as { message?: string })?.message ?? error));
}

/** Notify without throwing if reload invalidated the command ctx. */
export function uiNotify(
  ctx: { ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } },
  message: string,
  type: "info" | "warning" | "error" = "info",
): void {
  try {
    ctx.ui?.notify?.(message, type);
  } catch (error) {
    if (!isStaleCtxError(error)) throw error;
  }
}

function ensureDirs(paths: Paths): void {
  mkdirSync(paths.handoffsDir, { recursive: true });
}

async function resolvePaths(
  pi: ExtensionAPI,
  ctx: { cwd?: string },
  repoArg?: string,
): Promise<Paths> {
  const cwd = ctx.cwd || process.cwd();
  let gitRoot = cwd;
  try {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 5000,
    });
    const top = result.stdout.trim();
    if (result.code === 0 && top) gitRoot = top;
  } catch {
    /* cwd fallback */
  }
  const repo = (
    repoArg?.trim() ||
    repoNameFromGitRoot(gitRoot) ||
    guessRepoFromCwd(cwd)
  ).replace(/\/+$/, "");
  const repoDir = join(ORCH_ROOT, repo);
  migrateLegacyCurrent(repoDir);
  return {
    repo,
    gitRoot,
    repoDir,
    featureDir: "",
    planFile: "",
    statusFile: "",
    handoffsDir: "",
    archiveDir: join(ORCH_ROOT, repo, "archive"),
  };
}

/** Drop leftover current/ symlink or fold a leftover current/ dir into pending-*. */
function migrateLegacyCurrent(repoDir: string): void {
  const current = join(repoDir, "current");
  const st = lstatSafe(current);
  if (!st) return;
  if (st.isSymbolicLink()) {
    unlinkSync(current);
    return;
  }
  const planFile = join(current, "plan.md");
  if (!existsSync(planFile)) return;
  const plan = readText(planFile);
  const named =
    planHeaderField(plan, "Name") || nameFromTitle(featureTitle(plan, ""));
  let destName =
    named && !isPendingToken(named) ? named : `pending-${utcStamp()}`;
  const dest = join(repoDir, destName);
  if (existsSync(dest)) destName = `pending-${utcStamp()}`;
  const finalDest = join(repoDir, destName);
  if (!existsSync(finalDest)) renameSync(current, finalDest);
}

export interface OverlayTodoSink {
  replaceState(sessionId: string, state: OverlayTodoState): void;
  getActiveRenderSession(): string;
}

let overlaySink: OverlayTodoSink | undefined;
let overlayPi: ExtensionAPI | undefined;
let overlaySessionId = "";
let overlayUi: {
  setWidget?: (key: string, value: unknown, opts?: { placement?: string }) => void;
} | undefined;

/** Same slot as `@juicesharp/rpiv-todo` so Feature state is the visible panel. */
export const OVERLAY_WIDGET_KEY = "rpiv-todos";

export function setOverlayTodoSink(sink: OverlayTodoSink | undefined): void {
  overlaySink = sink;
}

export function bindOverlayUi(ctx: {
  hasUI?: boolean;
  ui?: {
    setWidget?: (key: string, value: unknown, opts?: { placement?: string }) => void;
  };
  sessionManager?: { getSessionId?: () => string };
}): void {
  if (ctx.hasUI === false) {
    overlayUi = undefined;
    return;
  }
  if (typeof ctx.ui?.setWidget === "function") overlayUi = { setWidget: ctx.ui.setWidget };
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    if (id) overlaySessionId = id;
  } catch {
    /* stale ctx */
  }
}

function bindOverlayFromCommand(ctx: ExtensionCommandContext | ExtensionContext): void {
  bindOverlayUi({
    hasUI: ctx.hasUI,
    ui: {
      setWidget: (key, value, opts) => {
        (ctx.ui.setWidget as (k: string, v: unknown, o?: { placement?: string }) => void)(
          key,
          value,
          opts,
        );
      },
    },
    sessionManager: ctx.sessionManager,
  });
}

/**
 * Component factory, not a string array. Pi's string-array widgets are clipped
 * at 10 lines (`MAX_WIDGET_LINES`) with "... (widget truncated)". A typical
 * Feature is planner + reviewer + approve + N tasks + two QA passes — already
 * more than 10 rows — so the overlay must be a component.
 */
export function overlayWidgetFactory(
  todos: OverlayTodo[],
): ((tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void }) | undefined {
  const lines = overlayWidgetLines(todos);
  if (lines.length === 0) return undefined;
  return (_tui, _theme) => ({
    render(width: number) {
      if (!(width > 0)) return lines;
      return lines.map((line) => truncateToWidth(line, width, "…"));
    },
    invalidate() {},
  });
}

function publishOverlayWidget(todos: OverlayTodo[]): void {
  const ui = overlayUi;
  if (!ui?.setWidget) return;
  try {
    ui.setWidget(OVERLAY_WIDGET_KEY, overlayWidgetFactory(todos), { placement: "aboveEditor" });
  } catch {
    /* stale ctx after /reload */
  }
}

export function syncOverlayTodos(plan: string, status: string): OverlayTodoState {
  const snapshot = projectOverlayTodos(plan, status);
  const fromSink = overlaySink?.getActiveRenderSession() ?? "";
  const sessionId = fromSink || overlaySessionId;
  if (overlaySink && sessionId) {
    overlaySink.replaceState(sessionId, snapshot);
    try {
      overlayPi?.events?.emit("tool_execution_end", { toolName: "todo", isError: false });
    } catch {
      /* overlay refresh is best-effort */
    }
  }
  // Pi loads each extension with `jiti({ moduleCache: false })`, so importing
  // rpiv-todo's store is usually a second Map. Occupy the same widget slot as a
  // *component* so the panel shows every Feature row instead of clipping at 10.
  publishOverlayWidget(snapshot.tasks);
  return snapshot;
}

function syncOverlayTodosFromPaths(paths: Paths, statusText: string): void {
  syncOverlayTodos(readText(paths.planFile), statusText);
}

const RPIV_TODO_STORE = join(
  homedir(),
  ".pi/agent/npm/node_modules/@juicesharp/rpiv-todo/state/store.ts",
);

async function bindRpivTodoOverlaySink(pi: ExtensionAPI): Promise<void> {
  overlayPi = pi;
  if (overlaySink) return;
  const specifiers = [
    pathToFileURL(RPIV_TODO_STORE).href,
    "@juicesharp/rpiv-todo/state/store.ts",
    "@juicesharp/rpiv-todo/state/store.js",
  ];
  for (const specifier of specifiers) {
    try {
      const mod = (await import(specifier)) as Partial<OverlayTodoSink>;
      if (
        typeof mod.replaceState === "function" &&
        typeof mod.getActiveRenderSession === "function"
      ) {
        overlaySink = {
          replaceState: mod.replaceState,
          getActiveRenderSession: mod.getActiveRenderSession,
        };
        return;
      }
    } catch {
      /* try the next specifier */
    }
  }
}

function syncLiveFeatureOverlay(): void {
  const rows = discoverAllFeatures().filter((row) => !row.archived);
  const active = rows.filter(featureIsActive);
  const row = active.length === 1 ? active[0] : defaultFeature(rows);
  if (!row) return;
  syncOverlayTodos(row.plan, row.status);
}

/**
 * Plan/Task parsing and mutation lives in `lib/plan-tasks.ts`: the
 * `### Task N` parser, the status/handoff writers, the `- Command:` gate, and
 * the plan-header readers. Re-exported here because that is where every
 * caller already looks.
 */
export {
  MAX_TASKS,
  parseTasks,
  planRepoName,
  reopenTasksThatNeverStarted,
  setTaskHandoffInPlan,
  setTaskStatusInPlan,
  taskCountError,
  taskGateCommand,
  taskSection,
} from "./lib/plan-tasks.ts";

/**
 * The Feature lifecycle lives in `lib/feature-state.ts`: the phase vocabulary,
 * the legal moves between phases, and the one line-based status.md parser that
 * replaced the per-call `new RegExp` readers. Re-exported here because that is
 * where every caller already looks.
 */
export {
  FEATURE_PHASES,
  INITIAL_PHASE,
  PHASE_TRANSITIONS,
  TERMINAL_PHASES,
  TRANSITIONS_LOG,
  canTransition,
  formatTransitionLogLine,
  isFeaturePhase,
  parsePhase,
  parseStatusFields,
  readPhase,
  transitionRefusal,
  type FeaturePhase,
} from "./lib/feature-state.ts";

/**
 * The plan-reviewer / QA-pass gates live in `lib/lifecycle.ts`: the durable
 * `plan_review` field, the QA pass counter, and the reconcile rule for a
 * reviewer that died with its session. Re-exported here because that is
 * where every caller already looks.
 */
export {
  MAX_QA_PASS_CAP,
  approveBlockedByPlanReview,
  clampedQaPassCap,
  needsPlanReview,
  planReviewReconcile,
  planReviewState,
  writerBlockedByPlanReview,
  type PlanReviewReconcile,
  type PlanReviewState,
} from "./lib/lifecycle.ts";

/**
 * The deterministic rpiv-todo mapper lives in `lib/overlay.ts`: the plan.md +
 * status.md → todo-board projection. The sink binding stays here because it
 * needs the extension API. Re-exported here because that is where every
 * caller already looks.
 */
export {
  OVERLAY_PLANNER_ID,
  OVERLAY_REVIEWER_ID,
  OVERLAY_APPROVE_ID,
  overlayTodosFromFeature,
  overlayWidgetLines,
  projectOverlayTodos,
  type OverlayTodo,
  type OverlayTodoKind,
  type OverlayTodoState,
  type OverlayTodoStatus,
} from "./lib/overlay.ts";

/**
 * The Feature-PR verdict policy lives in `lib/feature-pr.ts`: the judgment
 * `next=` → action table and the fixer-settle decision. Dispatch, branch-head
 * reads and latch wiring stay here because they need the extension API and
 * git. Re-exported here because that is where every caller already looks.
 */
export {
  FIX_ROUND_CAP,
  classifyFeaturePrNext,
  fixerPushState,
  fixerSettleAction,
  type FeaturePrAction,
  type FixerPushState,
  type FixerSettle,
} from "./lib/feature-pr.ts";

/**
 * Append one line to `handoffs/transitions.log`.
 *
 * Best-effort by design: the log is a record of what happened, and failing to
 * write history must never stop the thing that was happening. Append-only, so
 * two chains touching one Feature cannot lose each other's lines.
 */
function appendTransitionLog(
  paths: Paths,
  from: Phase | undefined,
  to: Phase,
  reason: string,
): void {
  try {
    mkdirSync(paths.handoffsDir, { recursive: true });
    appendFileSync(
      join(paths.handoffsDir, TRANSITIONS_LOG_NAME),
      formatTransitionLogLine({ at: new Date(), from, to, reason }),
    );
  } catch {
    /* history is not worth a crash */
  }
}

export function upsertStatusFile(
  paths: Paths,
  patch: {
    phase?: FeaturePhase;
    /** Phase an interruption suspended; `none` clears it. See `resumePhase`. */
    phasePrev?: string;
    activeTask?: string;
    missionId?: string;
    workerRunId?: string;
    workerRunDir?: string;
    taskBase?: string;
    nextAction?: string;
    branch?: string;
    worktree?: string;
    feature?: string;
    name?: string;
    dir?: string;
    planPath?: string;
    pr?: string;
    prRound?: string;
    pause?: string;
    qaPass?: string;
    qaPassCap?: string;
    planReview?: string;
    /** Async-run id / dir of the plan-reviewer, so a dead one can be settled. */
    reviewerRunId?: string;
    reviewerRunDir?: string;
    /** Fingerprint of a verdict dispatch refused; `none` clears it. */
    pendingVerdict?: string;
    /** Head the current verdict was raised against. */
    prHead?: string;
    /** Tag of the `brief_finding` set last dispatched; `none` clears it. */
    lastFindings?: string;
    verdictFingerprint?: string;
    tasks?: Task[];
  },
): void {
  let text = readText(paths.statusFile);
  // Every phase write in this extension arrives here, which makes this the one
  // place the lifecycle can be enforced rather than described. An illegal move
  // is refused and recorded; the rest of the patch still applies, because the
  // fields around `phase` are usually the evidence for why the move was
  // attempted and dropping them would make the refusal harder to diagnose.
  // Nothing throws: a wrong transition table must not be able to take down a
  // chain that was otherwise working.
  if (patch.phase) {
    const from = readFeaturePhase(text);
    const refusal = phaseTransitionRefusal(from, patch.phase);
    if (refusal) {
      appendTransitionLog(paths, from, patch.phase, `REFUSED ${refusal}`);
      patch = {
        ...patch,
        phase: undefined,
        // Visible where a user already looks. A refusal nobody can see is the
        // same wedged Feature as before, with extra machinery.
        nextAction: `${patch.nextAction ?? ""} [phase move refused: ${refusal}]`.trim(),
      };
    } else if (from !== patch.phase) {
      // Self-transitions are legal but unlogged: `pr → pr` happens on every
      // waiter handshake, and a line per poll would bury the moves that matter.
      // What changed on a self-transition is `next_action`, which is written.
      appendTransitionLog(paths, from, patch.phase, patch.nextAction ?? "");
      // An interruption records what it suspended, so `resume` can put the
      // Feature back rather than re-deriving a phase from the Task list — which
      // is wrong for exactly the Features whose work is not a Task any more.
      // Leaving one clears it: a stale `phase_prev` is worse than none.
      if (isInterruption(patch.phase) && !isInterruption(from)) {
        patch = { ...patch, phasePrev: from ?? "none" };
      } else if (!isInterruption(patch.phase)) {
        patch = { ...patch, phasePrev: "none" };
      }
    }
  }
  if (!text.trim()) {
    text = [
      "# Status",
      "",
      `repo: ${paths.repo}`,
      `plan: ${paths.planFile}`,
      `dir: ${paths.featureDir}`,
      "feature: ",
      "name: pending",
      "branch: pending",
      "worktree: none",
      "phase: planning",
      "phase_prev: none",
      "active_task: none",
      "mission_id: none",
      "worker_run_id: none",
      "worker_run_dir: none",
      "task_base: none",
      "pr: none",
      "pr_round: none",
      "pause: off",
      "qa_pass: 0",
      `qa_pass_cap: ${DEFAULT_QA_PASS_CAP}`,
      "plan_review: none",
      "reviewer_run_id: none",
      "reviewer_run_dir: none",
      "next_action: wait for user",
      "",
      "## Tasks",
      "",
      "| id | title | status | handoff |",
      "|----|-------|--------|---------|",
      "",
    ].join("\n");
  }
  // Collected, then applied in one structured pass. The old per-field
  // `new RegExp` + `String.replace` interpolated `$1` out of any value that
  // contained it, and `.+` failed to match a field whose current value was
  // empty — which duplicated the field at the top instead of updating it.
  const pending: Array<[string, string]> = [];
  const setField = (key: string, value: string) => {
    pending.push([key, value]);
  };
  setField("repo", paths.repo);
  setField("plan", patch.planPath ?? paths.planFile);
  if (patch.dir !== undefined) setField("dir", patch.dir);
  if (patch.feature !== undefined) setField("feature", patch.feature);
  if (patch.name !== undefined) setField("name", patch.name);
  if (patch.branch !== undefined) setField("branch", patch.branch);
  if (patch.worktree !== undefined) setField("worktree", patch.worktree);
  if (patch.phase) setField("phase", patch.phase);
  if (patch.phasePrev !== undefined) setField("phase_prev", patch.phasePrev);
  if (patch.activeTask !== undefined) setField("active_task", patch.activeTask);
  if (patch.missionId !== undefined) setField("mission_id", patch.missionId);
  if (patch.workerRunId !== undefined) setField("worker_run_id", patch.workerRunId);
  if (patch.workerRunDir !== undefined) setField("worker_run_dir", patch.workerRunDir);
  if (patch.taskBase !== undefined) setField("task_base", patch.taskBase);
  if (patch.pr !== undefined) setField("pr", patch.pr);
  if (patch.prRound !== undefined) setField("pr_round", patch.prRound);
  if (patch.pause !== undefined) setField("pause", patch.pause);
  if (patch.qaPass !== undefined) setField("qa_pass", patch.qaPass);
  if (patch.qaPassCap !== undefined) setField("qa_pass_cap", patch.qaPassCap);
  if (patch.planReview !== undefined) setField("plan_review", patch.planReview);
  if (patch.reviewerRunId !== undefined) setField("reviewer_run_id", patch.reviewerRunId);
  if (patch.reviewerRunDir !== undefined) setField("reviewer_run_dir", patch.reviewerRunDir);
  if (patch.pendingVerdict !== undefined) setField("pending_verdict", patch.pendingVerdict);
  if (patch.prHead !== undefined) setField("pr_head", patch.prHead);
  if (patch.lastFindings !== undefined) setField("last_findings", patch.lastFindings);
  if (patch.verdictFingerprint !== undefined) {
    setField("verdict_fingerprint", patch.verdictFingerprint);
  }
  if (patch.nextAction) setField("next_action", patch.nextAction);
  if (patch.tasks) {
    const table = [
      "| id | title | status | handoff |",
      "|----|-------|--------|---------|",
      ...patch.tasks.map((s) => `| ${s.id}  | ${s.title} | ${s.status} |  |`),
    ].join("\n");
    if (/^## (?:Tasks|Slices)\b/m.test(text)) {
      text = text.replace(
        /## (?:Tasks|Slices)\n[\s\S]*?(?=\n## |\n*$)/,
        `## Tasks\n\n${table}\n`,
      );
    } else {
      text += `\n## Tasks\n\n${table}\n`;
    }
  }
  // One structured pass over the field block, after the Tasks table has been
  // rebuilt — `writeStatusFields` leaves everything from the first `##` on
  // untouched, so the order does not matter, but doing it last keeps the
  // field-block edit adjacent to the write it produces.
  text = writeStatusFields(text, pending);
  const next = text.endsWith("\n") ? text : `${text}\n`;
  writeText(paths.statusFile, next);
  syncOverlayTodosFromPaths(paths, next);
}

function archiveFeature(paths: Paths): string {
  const plan = readText(paths.planFile);
  const raw =
    planHeaderField(plan, "Name") || nameFromTitle(featureTitle(plan, ""));
  const name = isPendingToken(raw) || !raw ? basename(paths.featureDir) || "unnamed" : raw;
  const dest = join(paths.archiveDir, `${utcStamp()}-${name}`);
  mkdirSync(paths.archiveDir, { recursive: true });
  const src = paths.featureDir;
  if (src && existsSync(src)) renameSync(src, dest);
  return dest;
}

function seedFeature(paths: Paths, objective: string): void {
  ensureDirs(paths);
  const note = objective.trim();
  if (!existsSync(paths.planFile)) {
    writeText(
      paths.planFile,
      [
        "# Feature: (planning)",
        "",
        "> Status: DRAFT — awaiting approval",
        "> Name: pending",
        "> Branch: pending",
        `> Repo: ${paths.repo}`,
        `> Path: ${paths.planFile}`,
        "",
        note ? `Objective (not the Feature name):\n\n> ${note}\n` : "",
        "_Planner is writing this file. Name and branch are assigned after the title exists. Do not implement._",
        "",
        "## Tasks",
        "",
      ].join("\n"),
    );
  }
  upsertStatusFile(paths, {
    phase: "planning",
    feature: "(planning)",
    name: "pending",
    branch: "pending",
    dir: paths.featureDir,
    worktree: "none",
    activeTask: "none",
    missionId: "none",
    workerRunId: "none",
    pr: "none",
    planReview: "none",
    nextAction: "wait for planner to write plan.md, then name from title",
  });
}

/* ------------------------------------------------------------------ *
 * pi-subagents RPC — the parent runs the Task chain itself
 *
 * Task selection, model choice, disk state, and the pause/QA/PR branch are
 * decisions this extension already knows how to make. They used to be
 * restated as prose for the parent model to follow. They are now code.
 *
 * Requests go over the documented in-process bridge (`subagents:rpc:v1:*`).
 * The bridge resolves the extension context itself, so a spawn is valid as
 * long as the host has an active session — it does not depend on the ctx this
 * extension captured. What DOES go stale across a session replacement is the
 * captured ctx used for `ui.notify`, `isIdle`, and the phase ceiling's
 * session id, so the chain re-checks the ceiling as it goes.
 * ------------------------------------------------------------------ */

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const RPC_REPLY_TIMEOUT_MS = 30_000;

/**
 * Hard deadline for one child. Passed to pi-subagents so the child is actually
 * stopped rather than merely abandoned, and mirrored by a local watchdog: the
 * result watcher only delivers a completion to the session that owns it, so a
 * session replacement mid-chain can drop the event that this loop is awaiting.
 * Without the watchdog that stalls the chain forever with no notification.
 */
const CHILD_TIMEOUT_MS = 90 * 60 * 1000;
const CHILD_WATCHDOG_GRACE_MS = 5 * 60 * 1000;
const WRITER_TURN_BUDGET = { maxTurns: 220, graceTurns: 30 };
export const QA_TURN_BUDGET = { maxTurns: 60, graceTurns: 10 };
const PLANNER_TURN_BUDGET = { maxTurns: 80, graceTurns: 15 };
const WRITER_MAX_CONCURRENCY = 2;
const PLANNER_MODEL = "xai/grok-4.6:high";
export const MAX_QA_FINDINGS = 8;

export function isAllowedPlannerModel(model: string): boolean {
  if (typeof model !== "string") return false;
  const trimmed = model.trim().toLowerCase();
  const base = trimmed.split(":")[0] ?? "";
  const thinking = trimmed.split(":")[1] ?? "";
  return base === "xai/grok-4.6" && thinking === "high";
}

/** Cursor-billed ids that burned 1k–7k turn workers. Native `xai/grok-4.6` is not this. */
export function isForbiddenBillingModel(model: string): boolean {
  if (typeof model !== "string") return true;
  const base = (model.split(":")[0] ?? "").trim().toLowerCase();
  if (!base || base === "inherit") return true;
  if (base.startsWith("cursor/")) return true;
  if (base.includes("composer")) return true;
  if (base === "grok-4.6") return true;
  return false;
}

function defaultWriterModel(agent: string, thinking?: string): string {
  if (QA_AGENTS.has(agent)) return qaModelFor(agent, thinking);
  return modelWithThinking(WORKERS.simple);
}

function turnCapFor(agent: string): { maxTurns: number; graceTurns: number } {
  if (agent === "planner") return PLANNER_TURN_BUDGET;
  if (QA_AGENTS.has(agent)) return QA_TURN_BUDGET;
  return WRITER_TURN_BUDGET;
}

function clampTurnBudget(
  requested: unknown,
  cap: { maxTurns: number; graceTurns: number },
): { maxTurns: number; graceTurns: number } {
  const r =
    requested && typeof requested === "object"
      ? (requested as { maxTurns?: unknown; graceTurns?: unknown })
      : {};
  const maxTurns =
    typeof r.maxTurns === "number" && r.maxTurns > 0
      ? Math.min(r.maxTurns, cap.maxTurns)
      : cap.maxTurns;
  const graceTurns =
    typeof r.graceTurns === "number" && r.graceTurns > 0
      ? Math.min(r.graceTurns, cap.graceTurns)
      : cap.graceTurns;
  return { maxTurns, graceTurns };
}

/** Mutation writers must never get `contact_supervisor`. progress_update does not wait for a reply, so GLM loops it for thousands of turns. */
const MUTATION_WRITERS = new Set(["tdd-worker", "fixer"]);
export const WRITER_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
export const WRITER_INTERCOM_OFF = { mode: "off" } as const;

function muteWriterSupervisor(params: Record<string, unknown>): void {
  const agent = typeof params.agent === "string" ? params.agent : "";
  if (!MUTATION_WRITERS.has(agent)) return;
  params.intercomBridge = { ...WRITER_INTERCOM_OFF };
  params.tools = [...WRITER_TOOLS];
}

function pinWriterCaps(params: Record<string, unknown>): void {
  params.context = "fresh";
  const timeout = params.timeoutMs;
  params.timeoutMs =
    typeof timeout === "number" && timeout > 0 ? Math.min(timeout, CHILD_TIMEOUT_MS) : CHILD_TIMEOUT_MS;
  const agent = typeof params.agent === "string" ? params.agent : "";
  params.turnBudget = clampTurnBudget(params.turnBudget, turnCapFor(agent));
  muteWriterSupervisor(params);
}

function applyOneSpawn(params: Record<string, unknown>): {
  action: "allow" | "pin" | "reject";
  reason?: string;
} {
  if (typeof params.action === "string" && params.action.trim()) return { action: "allow" };
  const agent = typeof params.agent === "string" ? params.agent.trim() : "";
  const model = typeof params.model === "string" ? params.model.trim() : "";

  if (agent === "planner") {
    let action: "allow" | "pin" = "allow";
    let reason: string | undefined;
    if (!isAllowedPlannerModel(model)) {
      params.model = PLANNER_MODEL;
      action = "pin";
      reason = `pinned planner to ${PLANNER_MODEL} (refused ${model || "inherit"})`;
    }
    if (params.context === undefined) params.context = "fresh";
    const timeout = params.timeoutMs;
    const nextTimeout =
      typeof timeout === "number" && timeout > 0 ? Math.min(timeout, CHILD_TIMEOUT_MS) : CHILD_TIMEOUT_MS;
    if (params.timeoutMs !== nextTimeout) {
      params.timeoutMs = nextTimeout;
      action = "pin";
    }
    const nextBudget = clampTurnBudget(params.turnBudget, PLANNER_TURN_BUDGET);
    const prevBudget = params.turnBudget as { maxTurns?: number; graceTurns?: number } | undefined;
    if (
      !prevBudget ||
      prevBudget.maxTurns !== nextBudget.maxTurns ||
      prevBudget.graceTurns !== nextBudget.graceTurns
    ) {
      params.turnBudget = nextBudget;
      action = "pin";
    } else {
      params.turnBudget = nextBudget;
    }
    return { action, reason };
  }

  if (WRITER_AGENTS.has(agent)) {
    let action: "allow" | "pin" = "allow";
    let reason: string | undefined;
    // A QA agent is held to the narrower scope: only the billing half of
    // the id is corrected here. Thinking above high is capped separately.
    const allowed = QA_AGENTS.has(agent)
      ? isAllowedQaModel(model)
      : isAllowedWriterModel(model);
    if (!allowed) {
      const pinned = defaultWriterModel(agent, model.split(":")[1]?.trim());
      params.model = pinned;
      action = "pin";
      reason = `pinned ${agent} to ${pinned} (refused ${model || "inherit"})`;
    } else if (QA_AGENTS.has(agent) && typeof params.model === "string") {
      const capped = params.model.replace(/:(xhigh|extra-high|max)\b/i, ":high");
      if (capped !== params.model) {
        params.model = capped;
        action = "pin";
        reason = `capped ${agent} thinking to high (refused xhigh)`;
      }
    }
    pinWriterCaps(params);
    if (typeof params.concurrency === "number" && params.concurrency > WRITER_MAX_CONCURRENCY) {
      params.concurrency = WRITER_MAX_CONCURRENCY;
      action = "pin";
      reason ??= `clamped ${agent} concurrency to ${WRITER_MAX_CONCURRENCY}`;
    }
    return { action, reason };
  }

  if (model && isForbiddenBillingModel(model)) {
    return {
      action: "reject",
      reason: `refusing ${agent || "subagent"} on ${model}; cursor/grok-4.6, composer, and inherit are not allowed`,
    };
  }
  if (typeof params.model === "string" && /grok-4\.6/i.test(params.model)) {
    const capped = params.model.replace(/:(xhigh|extra-high|max)\b/i, ":high");
    if (capped !== params.model) {
      params.model = capped;
      return { action: "pin", reason: `capped grok-4.6 thinking to high (refused xhigh)` };
    }
  }
  return { action: "allow" };
}

function nestedSpawnRecords(params: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const key of ["parallel", "tasks"]) {
    const value = params[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        out.push(item as Record<string, unknown>);
      }
    }
  }
  return out;
}

/**
 * Deterministic spawn policy: known writers/planner are pinned to the billed
 * model they are supposed to use; any other agent on Cursor Grok/Composer is
 * refused. Mutates `params` on pin/allow (caps). Reject leaves params as-is.
 */
export function applySpawnPolicy(params: Record<string, unknown>): {
  action: "allow" | "pin" | "reject";
  reason?: string;
} {
  const rank = { allow: 0, pin: 1, reject: 2 } as const;
  let worst: { action: "allow" | "pin" | "reject"; reason?: string } = { action: "allow" };
  for (const child of nestedSpawnRecords(params)) {
    const nested = applySpawnPolicy(child);
    if (rank[nested.action] > rank[worst.action]) worst = nested;
  }
  const self = applyOneSpawn(params);
  if (rank[self.action] > rank[worst.action]) worst = self;
  return worst;
}

/** Parent-model `subagent` tool path — mutate input on pin, `{block}` on reject. */
const PARENT_FORBIDDEN_AGENTS = new Set([
  "tdd-worker",
  "fixer",
  "feature-qa",
  "qa-opus",
  "plan-reviewer",
  "planner",
]);

export function subagentToolGuard(event: {
  toolName?: string;
  input?: unknown;
  args?: unknown;
}): { block: true; reason: string } | undefined {
  if (event.toolName !== "subagent") return undefined;
  const input = event.input ?? event.args;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const params = input as Record<string, unknown>;
  if (typeof params.action === "string" && params.action.trim()) return undefined;
  const agent = typeof params.agent === "string" ? params.agent.trim() : "";
  if (PARENT_FORBIDDEN_AGENTS.has(agent)) {
    return {
      block: true,
      reason: `refusing parent spawn of ${agent}; /orchestrate launches it`,
    };
  }
  const decision = applySpawnPolicy(params);
  if (decision.action === "reject") {
    return { block: true, reason: decision.reason ?? "spawn rejected" };
  }
  return undefined;
}

interface RpcReply {
  success?: boolean;
  data?: { text?: string; details?: Record<string, unknown> };
  error?: { code?: string; message?: string };
}

interface ChildOutcome {
  ok: boolean;
  runId?: string;
  state?: string;
  summary?: string;
  reason?: string;
  /** A user stop is not a failed Task; the chain pauses instead of blocking. */
  stopped?: boolean;
  /** The completion notification verbatim, for structured-output recovery. */
  raw?: Record<string, unknown>;
}

let rpcSeq = 0;

function rpcRequestId(method: string): string {
  rpcSeq += 1;
  return `orchestrate-${method}-${process.pid}-${Date.now()}-${rpcSeq}`;
}

export function rpcCall(pi: ExtensionAPI, method: string, params: unknown): Promise<RpcReply> {
  if (method === "spawn" && params && typeof params === "object" && !Array.isArray(params)) {
    const decision = applySpawnPolicy(params as Record<string, unknown>);
    if (decision.action === "reject") {
      return Promise.resolve({
        success: false,
        error: { code: "invalid_params", message: decision.reason ?? "spawn rejected" },
      });
    }
  }
  return new Promise((resolve) => {
    const requestId = rpcRequestId(method);
    let settled = false;
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (reply: RpcReply) => {
      if (settled) return;
      settled = true;
      try {
        off?.();
      } catch {
        /* bus already torn down */
      }
      if (timer) clearTimeout(timer);
      resolve(reply);
    };
    off = pi.events.on(`${RPC_REPLY_PREFIX}${requestId}`, (reply) => {
      finish((reply ?? {}) as RpcReply);
    });
    timer = setTimeout(() => {
      finish({
        success: false,
        error: {
          code: "timeout",
          message: `no subagent RPC reply for ${method} in ${RPC_REPLY_TIMEOUT_MS}ms`,
        },
      });
    }, RPC_REPLY_TIMEOUT_MS);
    timer.unref?.();
    try {
      pi.events.emit(RPC_REQUEST_EVENT, { version: 1, requestId, method, params });
    } catch (error) {
      finish({ success: false, error: { code: "emit_failed", message: String(error) } });
    }
  });
}

function rpcErrorText(reply: RpcReply): string {
  return reply.error?.message || reply.error?.code || "subagent RPC failed";
}

/**
 * Launch one async child and resolve when it reaches a terminal state.
 *
 * The completion listener is registered before the spawn so a child that
 * finishes quickly cannot settle before anyone is listening.
 */
/**
 * Whether a completion means "someone stopped this", however it was reported.
 *
 * pi-subagents does not put the answer in one field: `buildCompletionDetails`
 * (`runs/background/notify.ts`) derives its own `stopped` from the top-level
 * flag, `state === "stopped"`, and each child's flag or status. Reading only
 * the top-level flag misclassifies a `/orchestrate pause now` as a failed
 * Task, which marks it `blocked` — and the blocked guard at the top of
 * `runFeatureChain` then makes `/orchestrate resume` refuse forever.
 *
 * A timeout is deliberately not a stop: nobody asked for it, so it must still
 * block the Task rather than quietly park it as pending.
 */
export function isStoppedCompletion(data: unknown): boolean {
  const n = (data ?? {}) as {
    stopped?: boolean;
    state?: string;
    results?: ({ stopped?: boolean; status?: string } | null)[];
  };
  if (n.stopped === true || n.state === "stopped") return true;
  return (
    Array.isArray(n.results) &&
    n.results.some((child) => child?.stopped === true || child?.status === "stopped")
  );
}

/** Completions seen before the spawn reply names the run. Bounded, see below. */
const EARLY_COMPLETION_CAP = 64;

/**
 * pi-subagents parks a model for 24h after an empty/cold-start response and
 * then refuses an explicit request with no fallback. Orchestrate simple
 * writers *are* that explicit request, so treating the throw as a Task
 * failure marked the Task `blocked` and made `/orchestrate resume` refuse
 * forever. Infra, not the Task — retry once on the critical writer.
 */
export function isExcludedModelFailure(reason: string | undefined): boolean {
  return typeof reason === "string" && /is excluded and cannot be replaced by a fallback/i.test(reason);
}

function isSimpleWriterModel(model: unknown): boolean {
  if (typeof model !== "string") return false;
  return (model.split(":")[0] ?? "").trim().toLowerCase() === WORKERS.simple.model;
}

function shouldRetryExcludedSimpleWriter(
  params: Record<string, unknown>,
  outcome: ChildOutcome,
): boolean {
  if (outcome.ok || outcome.stopped) return false;
  if (!isExcludedModelFailure(outcome.reason)) return false;
  if (params.agent !== "tdd-worker" && params.agent !== "fixer") return false;
  const fallback = modelWithThinking(WORKERS.critical);
  if (typeof params.model === "string" && params.model === fallback) return false;
  return isSimpleWriterModel(params.model);
}

export function runChild(
  pi: ExtensionAPI,
  params: Record<string, unknown>,
  onRunId?: (runId: string) => void,
): Promise<ChildOutcome> {
  const policy = applySpawnPolicy(params);
  if (policy.action === "reject") return Promise.resolve({ ok: false, reason: policy.reason });
  return awaitSpawn(pi, params, onRunId).then((outcome) => {
    if (!shouldRetryExcludedSimpleWriter(params, outcome)) return outcome;
    return awaitSpawn(
      pi,
      { ...params, model: modelWithThinking(WORKERS.critical) },
      onRunId,
    );
  });
}


function awaitSpawn(
  pi: ExtensionAPI,
  params: Record<string, unknown>,
  onRunId?: (runId: string) => void,
): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    let runId = "";
    let settled = false;
    let off: (() => void) | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      try {
        off?.();
      } catch {
        /* bus already torn down */
      }
      if (watchdog) clearTimeout(watchdog);
      resolve(outcome);
    };
    const deadline =
      (typeof params.timeoutMs === "number" ? params.timeoutMs : CHILD_TIMEOUT_MS) +
      CHILD_WATCHDOG_GRACE_MS;
    watchdog = setTimeout(() => {
      finish({
        ok: false,
        runId,
        reason: `no completion for ${runId || "the child"} within ${Math.round(deadline / 60000)}m`,
      });
    }, deadline);
    watchdog.unref?.();

    const deliver = (data: unknown): boolean => {
      const n = (data ?? {}) as {
        runId?: string;
        success?: boolean;
        state?: string;
        summary?: string;
        interrupted?: boolean;
        timedOut?: boolean;
      };
      if (!runId || n.runId !== runId) return false;
      const stopped = isStoppedCompletion(data);
      const aborted = Boolean(n.interrupted || n.timedOut || stopped);
      finish({
        ok: n.success === true && !aborted,
        runId,
        raw: (data ?? {}) as Record<string, unknown>,
        state: typeof n.state === "string" ? n.state : undefined,
        summary: typeof n.summary === "string" ? n.summary : undefined,
        stopped,
        reason: n.timedOut
          ? "timed out"
          : stopped
            ? "stopped"
            : n.interrupted
              ? "interrupted"
              : undefined,
      });
      return true;
    };

    // Registering the listener before the spawn is not enough on its own: the
    // runId only arrives with the spawn reply, so a completion that overtakes
    // that reply matches nothing and used to be discarded — after which the
    // promise settled only via the watchdog, 4h05m later. Hold anything that
    // arrives too early and re-offer it once the run has a name. The cap keeps
    // an unrelated event storm from growing this without bound.
    const early: unknown[] = [];
    off = pi.events.on(ASYNC_COMPLETE_EVENT, (data) => {
      if (!runId) {
        if (early.length < EARLY_COMPLETION_CAP) early.push(data);
        return;
      }
      deliver(data);
    });

    void rpcCall(pi, "spawn", params).then((reply) => {
      if (!reply.success) {
        finish({ ok: false, reason: rpcErrorText(reply) });
        return;
      }
      const id = reply.data?.details?.runId;
      if (typeof id !== "string" || !id) {
        finish({ ok: false, reason: "spawn reply carried no runId" });
        return;
      }
      runId = id;
      onRunId?.(id);
      for (const data of early.splice(0)) {
        if (deliver(data)) return;
      }
    });
  });
}

/** Stop a child this extension spawned. Used by `/orchestrate pause`. */
async function stopRun(pi: ExtensionAPI, runId: string): Promise<boolean> {
  if (!runId || runId === "none") return false;
  const reply = await rpcCall(pi, "stop", { runId });
  return reply.success === true;
}

/* ------------------------------------------------------------------ *
 * Phase capability ceilings
 *
 * Which agent may run in which phase was prose: two paragraphs explaining
 * that `feature-qa` is the automatic pass and `qa-opus` is the end-of-line
 * one, and please do not confuse them. A ceiling makes a wrong agent fail
 * before spawn instead.
 *
 * Only agent allowlists are applied. `allowedTools` is deliberately left
 * open: these reviewers run `git diff` through bash, so a read-only tool
 * ceiling would break the very agents it looks like it should protect.
 *
 * A ceiling is registered against one session id and it constrains the WHOLE
 * session, not just this extension's children — so it is held only while a
 * child is in flight, and re-registered per child rather than once for a
 * multi-hour chain. Phases the parent hands to the model (`plan`, `review`)
 * cannot be ceilinged from here and are deliberately absent.
 * ------------------------------------------------------------------ */

interface CeilingRegistration {
  dispose(): void;
}

type RegisterCeiling = (input: {
  sessionId: string;
  source: string;
  ceiling: { allowedAgents?: string[]; allowedTools?: string[]; denyExtensions?: boolean };
}) => CeilingRegistration;

const PHASE_AGENTS: Record<string, string[]> = {
  implement: ["tdd-worker", "fixer", "feature-qa"],
  qa: ["qa-opus"],
  plan: ["planner"],
  review: ["plan-reviewer"],
};

let registerCeiling: RegisterCeiling | null = null;

/**
 * `pi-subagents` lives under `~/.pi/agent/npm/node_modules`, which is not on
 * the module path from this file — the bare specifier always fails here. The
 * absolute path does resolve, and resolves to the SAME module instance the
 * running extension uses, so a ceiling registered through it is enforced.
 * (Verified behaviourally: a non-allowlisted spawn is rejected before launch,
 * not merely accepted by a second, inert registry.)
 *
 * Optional hardening: if it cannot be loaded, phase isolation degrades to the
 * prompt wording that was already there — never to a hard failure.
 */
const CAPABILITY_CEILING_MODULE = join(
  homedir(),
  ".pi/agent/npm/node_modules/pi-subagents/src/api/capability-ceiling.ts",
);

async function loadCapabilityCeiling(): Promise<void> {
  for (const specifier of [
    "pi-subagents/capability-ceiling",
    pathToFileURL(CAPABILITY_CEILING_MODULE).href,
  ]) {
    try {
      const mod = (await import(specifier)) as {
        registerSubagentCapabilityCeiling?: RegisterCeiling;
      };
      if (typeof mod.registerSubagentCapabilityCeiling === "function") {
        registerCeiling = mod.registerSubagentCapabilityCeiling;
        return;
      }
    } catch {
      /* try the next specifier */
    }
  }
  registerCeiling = null;
}

function applyPhaseCeiling(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  phase: keyof typeof PHASE_AGENTS | string,
): CeilingRegistration | null {
  const allowedAgents = PHASE_AGENTS[phase];
  if (!registerCeiling || !allowedAgents) return null;
  try {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId) return null;
    return registerCeiling({
      sessionId,
      source: `orchestrate:${phase}`,
      ceiling: { allowedAgents },
    });
  } catch {
    return null;
  }
}

/**
 * One child, ceilinged for exactly as long as it is in flight.
 *
 * Registering once for a whole Feature would pin the allowlist to the session
 * id captured at the start and would also forbid every other agent in the
 * user's own session for hours. Per child, the ceiling is re-derived from the
 * live context and released the moment the child lands.
 */
async function runChildInPhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  phase: keyof typeof PHASE_AGENTS | string,
  params: Record<string, unknown>,
  onRunId?: (runId: string) => void,
): Promise<ChildOutcome> {
  const ceiling = applyPhaseCeiling(pi, ctx, phase);
  try {
    return await runChild(pi, params, onRunId);
  } finally {
    ceiling?.dispose();
  }
}

function taskScalar(body: string, name: string): string {
  const raw = (body.match(new RegExp(`^-\\s*${name}:\\s*(.+)\\s*$`, "im"))?.[1] ?? "").trim();
  if (!raw || isPendingToken(raw)) return "";
  const fenced = raw.match(/^(`+)([^`]+)\1$/)?.[2]?.trim();
  return (fenced || raw).split(/\s/)[0] ?? "";
}

/** Task `- Repo:` wins over plan `> Repo:`. Empty means inherit Feature worktree. */
export function taskRepoName(body: string, plan = ""): string {
  const fromTask = taskScalar(body, "Repo");
  if (/^[A-Za-z0-9._-]+$/.test(fromTask)) return fromTask;
  return planRepoName(plan);
}

function existingGitDir(dir: string): string {
  const cleaned = dir.replace(/\/+$/, "");
  return cleaned && existsSync(join(cleaned, ".git")) ? cleaned : "";
}

/**
 * Writer cwd for one Task. Feature worktree stays put; a later Task can sit in
 * another farm (devops-wt, coins-minimal-wt) or a `cd /abs` checkout.
 *
 * Order: `- Cwd:` / `- Worktree:`, Command `cd /abs`, Task/plan Repo farm, Feature worktree.
 */
export function taskWorkerCwd(body: string, fallback: string, plan = "", branch = ""): string {
  const explicit = taskScalar(body, "Cwd") || taskScalar(body, "Worktree");
  const fromField = explicit.startsWith("/") ? existingGitDir(explicit) : "";
  if (fromField) return fromField;
  const blob = `${taskGateCommand(body)}\n${body}`;
  const cd = blob.match(/\bcd\s+(\/[^\s;&|]+)/)?.[1] ?? "";
  const fromCd = existingGitDir(cd) || (cd && existsSync(cd.replace(/\/+$/, "")) ? cd.replace(/\/+$/, "") : "");
  if (fromCd) return fromCd;
  const repo = taskRepoName(body, plan);
  if (repo) {
    if (branch) {
      const preferred = existingGitDir(worktreePathFor(branch, repo));
      if (preferred) return preferred;
    }
    if (fallback) {
      const sibling = existingGitDir(join(worktreeFarmFor(repo), basename(fallback)));
      if (sibling) return sibling;
    }
  }
  return fallback;
}

/** Create `farm/feat-…` in `repo` if missing. Never writes the reference checkout. */
export async function ensureRepoWorktree(
  pi: ExtensionAPI,
  repo: string,
  branch: string,
): Promise<string> {
  if (!repo || isPendingToken(branch) || !branch.startsWith("feat/") || !isValidBranchName(branch)) {
    return "";
  }
  const preferred = worktreePathFor(branch, repo);
  const already = existingGitDir(preferred);
  if (already) return already;
  const root = join(REF_ROOT, repo);
  if (!existsSync(root) || isHostBase(repo)) return "";
  try {
    await pi.exec("git", ["wt", branch], { cwd: root, timeout: 180_000 });
  } catch {
    return existingGitDir(preferred);
  }
  return existingGitDir(preferred);
}

/**
 * Runtime gates default to a 120s ceiling inside pi-subagents, which is under
 * the cost of a single `cargo test -p …` in this repo. The `gate` shorthand
 * cannot carry a timeout — it normalizes to a verify entry with none, and it
 * cannot be combined with `acceptance` — so the gate is expressed as the
 * explicit verify form instead.
 */
const GATE_TIMEOUT_MS = 900_000;

function gateAcceptance(command: string): Record<string, unknown> {
  return {
    level: "verified",
    verify: [{ id: "gate", command, timeoutMs: GATE_TIMEOUT_MS }],
  };
}

/**
 * A zero-token answer to "did this child actually do anything?".
 *
 * Only 61% of Task sections across the real plans carry a runnable
 * `- Command:` gate. The other 39% fall back to `checked` acceptance, where
 * the child's own report is the only evidence in play. HEAD plus porcelain
 * status covers every form real work takes — committed, staged, unstaged, or
 * untracked — so an identical fingerprint across the run means nothing was
 * produced, whatever the report claims.
 *
 * Returns "" when git cannot answer. An unreadable fingerprint is
 * inconclusive and must never block a Task on its own.
 */
async function worktreeFingerprint(pi: ExtensionAPI, worktree: string): Promise<string> {
  try {
    const head = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: worktree, timeout: 15_000 });
    const status = await pi.exec("git", ["status", "--porcelain"], {
      cwd: worktree,
      timeout: 30_000,
    });
    if (head.code !== 0 || status.code !== 0) return "";
    return `${head.stdout.trim()}\n${actionablePorcelain(stripOuterNewlines(status.stdout))}`;
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ *
 * The commit gate (F11)
 *
 * A writer's only git operation is `git commit`. It is also the one the
 * models skip most: `worktreeFingerprint` counts unstaged edits as a land, so
 * a Task that edited and never committed used to be marked `done`. The next
 * worker then started on a dirty tree, feature-qa reviewed uncommitted code,
 * and `openFeaturePr` pushed HEAD — which did not contain the work.
 *
 * So code closes the gate itself after every writer: if the tree is dirty,
 * code commits it deterministically; if it cannot, the Task blocks with a
 * reason rather than advancing over work that is not on the branch.
 * ------------------------------------------------------------------ */

/** `clean` = nothing to do; `committed` = code closed the gate; `unknown` = git could not answer. */
export type CommitGateState = "clean" | "committed" | "dirty" | "unknown";

/** Drop surrounding newlines without eating porcelain's leading XY space. */
function stripOuterNewlines(raw: string): string {
  let text = raw;
  while (text.startsWith("\n")) text = text.slice(1);
  while (text.endsWith("\n")) text = text.slice(0, -1);
  return text;
}

/** `git status --porcelain`, or undefined when git cannot answer. */
export async function porcelainStatus(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string | undefined> {
  try {
    const out = await pi.exec("git", ["status", "--porcelain"], { cwd, timeout: 30_000 });
    if (out.code !== 0) return undefined;
    // Do not String#trim: porcelain v1 uses a leading space in XY (` M file`).
    return stripOuterNewlines(out.stdout);
  } catch {
    return undefined;
  }
}

/** Decode git's C-style quoted pathname (`quote.c` unquote_c_style). */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = inner[++i];
    if (next === undefined) break;
    if (next === "\\" || next === '"') {
      out += next;
      continue;
    }
    if (next === "n") {
      out += "\n";
      continue;
    }
    if (next === "t") {
      out += "\t";
      continue;
    }
    if (next === "r") {
      out += "\r";
      continue;
    }
    if (next === "a") {
      out += "\u0007";
      continue;
    }
    if (next === "b") {
      out += "\b";
      continue;
    }
    if (next === "f") {
      out += "\f";
      continue;
    }
    if (next === "v") {
      out += "\v";
      continue;
    }
    if (next >= "0" && next <= "7") {
      let oct = next;
      let count = 1;
      while (count < 3 && i + 1 < inner.length) {
        const digit = inner[i + 1];
        if (digit === undefined || digit < "0" || digit > "7") break;
        oct += digit;
        i++;
        count++;
      }
      out += String.fromCharCode(Number.parseInt(oct, 8));
      continue;
    }
    out += next;
  }
  return out;
}

/** Dest path after the rename/copy arrow that sits outside C-style quotes. */
export function renameDestination(rest: string): string {
  if (rest.startsWith('"')) {
    let i = 1;
    while (i < rest.length) {
      if (rest[i] === "\\" && i + 1 < rest.length) {
        i += 2;
        continue;
      }
      if (rest[i] === '"') {
        i++;
        break;
      }
      i++;
    }
    const after = rest.slice(i);
    if (after.startsWith(" -> ")) return after.slice(4);
    return rest.slice(0, i);
  }
  const arrow = rest.indexOf(" -> ");
  if (arrow >= 0) return rest.slice(arrow + 4);
  return rest;
}

/** Path from one `git status --porcelain` v1 line (rename dest wins). */
export function porcelainEntryPath(line: string): string {
  if (line.length < 4) return "";
  const xy = line.slice(0, 2);
  let rest = line.slice(3);
  if (xy.includes("R") || xy.includes("C")) rest = renameDestination(rest);
  rest = rest.trim();
  return unquoteGitPath(rest);
}

/**
 * Darwin `cargo test` rewrites Cargo.lock; icemining's pre-commit hook refuses
 * that lock from macOS (ops-canonical). Residual lock dirt is not Feature work.
 * Linux ops *must* still commit lock updates — do not ignore by basename alone.
 */
export function isCommitGateIgnoredPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "darwin") return false;
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return base === "Cargo.lock";
}

/** Porcelain with ignored residual files (Darwin Cargo.lock) removed. */
export function actionablePorcelain(
  porcelain: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return porcelain
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      return !isCommitGateIgnoredPath(porcelainEntryPath(line), platform);
    })
    .join("\n");
}

/**
 * Refuse to start the *first* Task on a worktree that already has changes.
 *
 * Only the first: once a Task has run, a dirty tree is this Feature's own
 * work-in-progress and the commit gate below owns it. Before then, anything
 * uncommitted belongs to someone else, and committing it under a Task's
 * message would attribute a stranger's edits to this plan.
 *
 * Darwin Cargo.lock-only dirt is ignored: cargo churn is not someone else's
 * Feature, and the Mac pre-commit hook would refuse the commit anyway.
 * Linux still treats a lock change as Feature work.
 */
export function firstTaskBlockedByDirtyTree(
  tasks: Task[],
  porcelain: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (porcelain === undefined || !porcelain.trim()) return undefined;
  if (tasks.some((t) => t.status !== "pending")) return undefined;
  const actionable = actionablePorcelain(porcelain, platform);
  if (!actionable) return undefined;
  const files = actionable
    .split("\n")
    .map((line) => porcelainEntryPath(line))
    .filter(Boolean);
  const shown = files.slice(0, 8).join(", ");
  return (
    `dirty worktree: ${files.length} uncommitted file(s) before Task 1 — ${shown}` +
    `${files.length > 8 ? ", …" : ""}. Commit or stash them, then /orchestrate resume.`
  );
}

/**
 * Close the commit gate for one writer.
 *
 * `git add -A` is deliberate: a writer's untracked new files are as much of
 * the Task as its edits, and leaving them behind would push a half-Task.
 * The commit itself is pathspec'd to actionable files so an already-staged
 * Darwin Cargo.lock is not included (Mac pre-commit refuses that lock; we
 * cannot `git reset`/`git restore` it). Leftover lock dirt is not a block.
 */
export async function ensureWriterCommit(
  pi: ExtensionAPI,
  cwd: string,
  message: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ state: CommitGateState; reason: string }> {
  const before = await porcelainStatus(pi, cwd);
  if (before === undefined) return { state: "unknown", reason: "git status --porcelain failed" };
  const paths = actionablePorcelain(before, platform)
    .split("\n")
    .map((line) => porcelainEntryPath(line))
    .filter(Boolean);
  if (paths.length === 0) return { state: "clean", reason: "" };
  try {
    const add = await pi.exec("git", ["add", "-A"], { cwd, timeout: 120_000 });
    if (add.code !== 0) {
      return { state: "dirty", reason: `git add -A failed: ${(add.stderr || "").trim()}` };
    }
    const literalPaths = paths.map((path) => `:(literal)${path}`);
    const commit = await pi.exec("git", ["commit", "-m", message, "--", ...literalPaths], {
      cwd,
      timeout: 120_000,
    });
    if (commit.code !== 0) {
      return { state: "dirty", reason: `git commit failed: ${(commit.stderr || "").trim()}` };
    }
  } catch (error) {
    return { state: "dirty", reason: `commit gate error: ${String(error)}` };
  }
  const after = await porcelainStatus(pi, cwd);
  if (after && actionablePorcelain(after, platform)) {
    return { state: "dirty", reason: "worktree still dirty after the commit" };
  }
  return { state: "committed", reason: "" };
}

/**
 * The five lines every writer child gets, in its own task text.
 *
 * Children used to be handed the solo `git-workflow` skill instead. That
 * skill's `next=` table says "fix …, one push, then `git pr-await` once" —
 * correct for a person working alone, and exactly wrong for a child inside a
 * Feature that already has a waiter (F7). Stating the contract here keeps it
 * next to the work; `lib/git-workflow-guard.ts` is what actually enforces it.
 */
const WRITER_CONTRACT = [
  "You write code and commit it. Nothing else on this Feature is yours.",
  "Work only in the worktree named below, never in a reference checkout.",
  "Commit what you finish. Do NOT `git push` — code pushes once per round.",
  "Do NOT open a PR, do NOT `gh pr comment`, do NOT `gh pr merge`, do NOT `git wt`, do NOT `git pr-await`, do NOT `git pr-land`.",
  "Anything you cannot do goes in your handoff. Then settle; code takes it from there.",
];

export function workerLaunchParams(
  paths: Paths,
  task: Task,
  worktree: string,
  plan: string,
): Record<string, unknown> {
  const worker = workerFor(task.complexity) ?? WORKERS.simple;
  const body = taskSection(plan, task.id);
  const gate = taskGateCommand(body);
  const cwd = taskWorkerCwd(body, worktree, plan, planHeaderField(plan, "Branch"));
  const params: Record<string, unknown> = {
    agent: "tdd-worker",
    task: [
      `Implement exactly this Task and nothing else.`,
      ...WRITER_CONTRACT,
      `Do NOT start the next Task.`,
      `Feature plan (this Task's section only): ${paths.planFile}`,
      `Writer cwd: ${cwd}`,
      "",
      body || `See Task ${task.id} in ${paths.planFile}`,
    ].join("\n"),
    context: "fresh",
    cwd,
    model: modelWithThinking(worker),
    timeoutMs: CHILD_TIMEOUT_MS,
    turnBudget: WRITER_TURN_BUDGET,
    intercomBridge: { ...WRITER_INTERCOM_OFF },
    tools: [...WRITER_TOOLS],
    // v1: do not inject "write an acceptance-report JSON". That made Luna
    // reread the Task's Read list forever (0 edits, thousands of reads).
    agentContract: { version: 1 },
  };
  params.acceptance = gate
    ? gateAcceptance(gate)
    : {
        level: "none",
        reason: "tdd-worker implements; host Command gate is absent on this Task",
      };
  return params;
}

/* ------------------------------------------------------------------ *
 * QA findings arrive as data, not prose
 *
 * The QA child returns schema-validated JSON, so this extension renders the
 * remediation Tasks with the same code that writes every other Task. Nothing
 * hand-transcribes a review into a contract.
 * ------------------------------------------------------------------ */

const QA_FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocker", "fix-now", "defer", "correct"] },
          title: { type: "string" },
          goal: { type: "string" },
          complexity: { type: "string", enum: ["simple", "critical"] },
          read: { type: "array", items: { type: "string" } },
          redTest: { type: "string" },
          command: { type: "string" },
          implement: { type: "string" },
          invariants: { type: "array", items: { type: "string" } },
          outOfTask: { type: "array", items: { type: "string" } },
          evidence: { type: "string" },
        },
        required: ["severity", "title", "goal", "complexity", "redTest", "command", "implement"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

interface QaFinding {
  severity: string;
  title: string;
  goal: string;
  complexity: string;
  read?: string[];
  redTest: string;
  command: string;
  implement: string;
  invariants?: string[];
  outOfTask?: string[];
  evidence?: string;
}

export function parseQaFindings(raw: unknown): QaFinding[] {
  const source =
    raw && typeof raw === "object" && Array.isArray((raw as { findings?: unknown }).findings)
      ? ((raw as { findings: unknown[] }).findings)
      : [];
  const out: QaFinding[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const severity = String(f.severity ?? "").toLowerCase();
    if (severity !== "blocker" && severity !== "fix-now") continue; // Defer/Correct never become Tasks.
    const title = String(f.title ?? "").trim();
    if (!title) continue;
    out.push({
      severity,
      title,
      goal: String(f.goal ?? "").trim(),
      complexity: String(f.complexity ?? "").toLowerCase() === "critical" ? "critical" : "simple",
      read: Array.isArray(f.read) ? f.read.map(String) : undefined,
      redTest: String(f.redTest ?? "").trim(),
      command: String(f.command ?? "").trim(),
      implement: String(f.implement ?? "").trim(),
      invariants: Array.isArray(f.invariants) ? f.invariants.map(String) : undefined,
      outOfTask: Array.isArray(f.outOfTask) ? f.outOfTask.map(String) : undefined,
      evidence: typeof f.evidence === "string" ? f.evidence : undefined,
    });
  }
  return out;
}

export function renderQaTask(finding: QaFinding, id: number): string {
  const worker = finding.complexity === "critical" ? WORKERS.critical : WORKERS.simple;
  const list = (values: string[] | undefined) =>
    values && values.length ? values.map((v) => `\`${v}\``).join(", ") : "—";
  return [
    `### Task ${id} — QA: ${finding.title}`,
    `- Status: pending`,
    `- Complexity: ${finding.complexity}`,
    `- Worker: ${worker.model}, thinking ${worker.thinking}`,
    `- Goal: ${finding.goal || finding.title}`,
    `- Read: ${list(finding.read)}`,
    `- Red test: ${finding.redTest || "—"}`,
    `- Command: \`${finding.command}\``,
    `- Implement: ${finding.implement || "—"}`,
    `- Invariants: ${finding.invariants?.join("; ") || "—"}`,
    `- Out of task: ${finding.outOfTask?.join("; ") || "—"}`,
    finding.evidence ? `- QA evidence: ${finding.evidence}` : "",
    `- Handoff: (orchestrator fills)`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Append remediation Tasks after the highest existing Task id. */
export function appendQaTasks(paths: Paths, findings: QaFinding[]): number {
  const limited = findings.slice(0, MAX_QA_FINDINGS);
  if (!limited.length) return 0;
  const plan = readText(paths.planFile);
  const nextId =
    parseTasks(plan).reduce((max, t) => Math.max(max, Number.parseInt(t.id, 10) || 0), 0) + 1;
  const blocks = limited.map((f, i) => renderQaTask(f, nextId + i)).join("\n");
  writeText(paths.planFile, `${plan.replace(/\s*$/, "")}\n\n${blocks}`);
  return limited.length;
}

/* ------------------------------------------------------------------ *
 * Feature PR — one `git pr-await`. The alias daemonizes `ghl-pr-await`
 * and prints `next=yield`. Reviews take hours in that waiter; they are
 * not bounded here. This timeout is only the handshake (fork + print).
 * On timeout: treat as yield. Do not fail the Feature. Do not prompt.
 * ------------------------------------------------------------------ */

/**
 * Handshake only. Reviews live in `ghl-pr-await --daemon` (unbounded).
 *
 * `git pr-await` forks the daemon and prints; that is seconds. Waiting half an
 * hour for it only ever meant the chain lock was held for half an hour while
 * nothing happened (F19). A timeout here is read as `yield`, which is the
 * truth: the detached waiter owns the review either way.
 */
export const PR_AWAIT_CALL_TIMEOUT_MS = 60_000;

/**
 * `git pr-await` handshakes one dispatch chain may run.
 *
 * `reawait` calls `awaitAndDispatch`, which dispatches the next verdict, which
 * can `reawait` again — mutual recursion with no bound (F9). The invariant is
 * one handshake per round; two is the slack for a verdict that arrives during
 * the first one.
 */
export const AWAIT_DISPATCH_MAX_DEPTH = 2;

interface PrAwaitOutcome {
  done: boolean;
  next: string;
  output: string;
  round: string;
  /** The user paused the Feature; the PR is untouched and still open. */
  paused?: boolean;
  /** `next=yield` / `poll_again` — waiter owns the rest. Do not send to the model. */
  silent?: boolean;
}

/**
 * One `git pr-await`. `yield` / `poll_again` are silent. Judgment `next=`
 * values are returned so code can dispatch them.
 *
 * The waiter's `round=N` is reported as a toast and returned, but it is *not*
 * written to status.md: `pr_round` counts the fix-writers this Feature has
 * spent, and overwriting that count with a review
 * round would scramble the round shown on the next fixer.
 */
export async function drivePrAwait(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  paths: Paths,
  pr: string,
  worktree: string,
): Promise<PrAwaitOutcome> {
  if (isPaused(readText(paths.statusFile))) {
    upsertStatusFile(paths, {
      phase: "paused",
      pr,
      nextAction: `paused with PR ${pr} open — /orchestrate resume to run git pr-await once`,
    });
    return { done: false, next: "", output: "", round: "", paused: true };
  }
  // Exactly one git pr-await. A loop here is a token/CPU bomb; ghl-pr-await waits.
  const result = await pi.exec("git", ["pr-await", pr], {
    cwd: worktree,
    timeout: PR_AWAIT_CALL_TIMEOUT_MS,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const round = parseKeyedField(output, "round");
  const spent = fixSpawnCount(statusField(readText(paths.statusFile), "pr_round"));
  const label =
    `fixer round ${spent}` +
    (round && round !== "none" ? `, reviewer round ${round}` : "");
  uiNotify(ctx, `PR ${pr} — await (${label})`, "info");
  const next = parseKeyedField(output, "next").toLowerCase();
  if (next === "done") {
    upsertStatusFile(paths, { phase: "done", pr, nextAction: "landed" });
    return { done: true, next, output, round };
  }
  if (next === "stop") {
    upsertStatusFile(paths, {
      phase: "pr",
      pr,
      nextAction: `pr-await next=stop (${label}) — confirm merged or closed unmerged`,
    });
    return { done: false, next, output, round };
  }
  // yield / poll_again / missing next= (handshake timeout or empty print):
  // the waiter owns hours-long review. Never fail the Feature. Never prompt.
  if (next === "yield" || next === "poll_again" || !next) {
    upsertStatusFile(paths, {
      phase: "pr",
      pr,
      nextAction: `pr-await next=yield — ${label} — ghl-pr-await owns the wait (0 tokens)`,
    });
    uiNotify(ctx, 
      !next
        ? `PR ${pr}: git pr-await handshake returned no next= (${label}). Waiter owns the review (hours). Not failing the Feature.`
        : `PR ${pr} — await (${label}). Handed to ghl-pr-await (0 tokens).`,
      "info",
    );
    // `pi.exec('git','pr-await')` is not a bash tool event, so the latch's
    // absorb never sees this handshake. Without an observed latch the parent
    // never watches, merge never wakes, and status.md stays on yield forever
    // (icemining#2197).
    const url =
      output.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/)?.[0] ||
      parseKeyedField(output, "url") ||
      undefined;
    const slug = url?.match(/github\.com\/([^\s/]+\/[^\s/]+)\/pull\//)?.[1];
    armObservedLatch(ctx, {
      pr,
      cwd: worktree,
      lastNext: next || "yield",
      url: url || undefined,
      slug,
      head: parseKeyedField(output, "head") || undefined,
    });
    return { done: false, next: next || "yield", output, round, silent: true };
  }
  upsertStatusFile(paths, {
    phase: "pr",
    pr,
    nextAction: `pr-await next=${next} — ${label}`,
  });
  return { done: false, next, output, round };
}

/* ------------------------------------------------------------------ *
 * Feature PR review-fix — code dispatches, the parent stays idle
 *
 * A judgment `next=` on a Feature-owned PR is an event, not a request for the
 * parent to start implementing. These are the pure decisions behind that
 * dispatch: what the verdict means, and the contract the writer receives.
 * ------------------------------------------------------------------ */

/**
 * `branch`, `origin/<branch>` and `HEAD` for a worktree; `""` for anything git
 * cannot answer.
 *
 * `fetch` refreshes the remote ref first. Without it `origin/<branch>` is
 * whatever the last fetch left behind, and a fixer's push would look like no
 * push at all.
 */
export async function branchHeads(
  pi: ExtensionAPI,
  worktree: string,
  opts: { fetch?: boolean } = {},
): Promise<{ branch: string; remote: string; local: string }> {
  const empty = { branch: "", remote: "", local: "" };
  const run = async (args: string[], timeout: number): Promise<string> => {
    try {
      const r = await pi.exec("git", args, { cwd: worktree, timeout });
      return r.code === 0 ? String(r.stdout ?? "").trim() : "";
    } catch {
      return "";
    }
  };
  try {
    const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"], 15_000);
    if (!branch || branch === "HEAD") return empty;
    if (opts.fetch) await run(["fetch", "origin", branch], 120_000);
    return {
      branch,
      remote: await run(["rev-parse", `origin/${branch}`], 15_000),
      local: await run(["rev-parse", "HEAD"], 15_000),
    };
  } catch {
    return empty;
  }
}

/**
 * The reviewers' finding set, from the waiter's own `brief_finding` lines.
 *
 * Sorted and stripped of head, round and elapsed noise, so the same complaints
 * against two different heads produce the same list — which is the signal that
 * a fixer pushed and changed nobody's mind.
 */
export function parseBriefFindings(body: string): string[] {
  const out = new Set<string>();
  for (const line of String(body ?? "").split("\n")) {
    const m = line.match(/^\s*brief_finding\s+(.*)$/);
    if (!m) continue;
    const rest = m[1] ?? "";
    const path = rest.match(/\bpath=(\S+)/)?.[1] ?? "";
    const at = rest.match(/\bline=(\d+)/)?.[1] ?? "";
    const sev = rest.match(/\bsev=(\S+)/)?.[1] ?? "";
    // `title=` runs to the end of the line — it is free text with spaces.
    const title = rest.match(/\btitle=(.*)$/)?.[1]?.trim() ?? "";
    if (!path && !title) continue;
    out.add(`${path}${at ? `:${at}` : ""}${sev ? ` ${sev}` : ""}${title ? ` ${title}` : ""}`);
  }
  return [...out].sort();
}

/**
 * A comparable tag for a finding set. Empty for an empty set: "no findings" must
 * never match "no findings" and read as a repeat.
 */
export function findingsTag(findings: string[]): string {
  if (!findings.length) return "";
  return fingerprintTag(findings.join("\n"));
}

/**
 * The head a verdict was raised against.
 *
 * The waiter prints `head=<sha>` on its own line, and again inside the `brief`
 * and `comment` lines. `parseKeyedField` takes the last match, which is one of
 * those — so read the standalone line first and only fall back to a scan.
 */
export function verdictHead(body: string): string {
  const own = String(body ?? "").match(/^head=(\S+)\s*$/m)?.[1];
  return (own ?? parseKeyedField(body, "head")).trim();
}

/**
 * The `fixer` contract for one review-fix round.
 *
 * Same agent and same forbids as a Task: the writer fixes and pushes, and code
 * — not the child — runs the single `git pr-await` afterwards. The waiter's own
 * output is the body, so nothing paraphrases a review into a contract.
 */
export function reviewFixLaunchParams(
  paths: Paths,
  pr: string,
  worktree: string,
  result: { next: string; output: string; round?: string },
  spawn = 1,
): Record<string, unknown> {
  const waiterRound =
    result.round && result.round !== "none" ? `, reviewer round ${result.round}` : "";
  return {
    agent: "fixer",
    task: [
      `Review-fix round ${spawn} on PR ${pr}.`,
      `Fix the review findings on PR ${pr} and nothing else.`,
      ...WRITER_CONTRACT,
      `The review is not yours to wait on: once you settle, code runs \`git pr-await ${pr}\` once (fixer round ${spawn} latch).`,
      `Feature plan: ${paths.planFile}`,
      `Single writer worktree (already created): ${worktree}`,
      "",
      `Fix only findings against the current head of this PR. Red test first for critical or money-moving behaviour, then commit in ${worktree} only — never in a reference checkout.`,
      `A comment marked 👀 is still being written: leave the current head alone and report it in your handoff instead of changing it.`,
      `A finding against an older head is already answered — say so; do not re-fix it.`,
      "",
      `Waiter verdict (\`next=${result.next || "(none)"}\`${waiterRound}):`,
      "```",
      (result.output ?? "").slice(-4000).trim(),
      "```",
    ].join("\n"),
    context: "fresh",
    cwd: worktree,
    // A review fix touches already-reviewed code on an open PR; that is the
    // critical writer's job, not the cheap one's.
    model: modelWithThinking(WORKERS.critical),
    output: join(paths.handoffsDir, `pr-fix-${pr}-${spawn}.md`),
    outputMode: "inline",
    timeoutMs: CHILD_TIMEOUT_MS,
    turnBudget: WRITER_TURN_BUDGET,
    intercomBridge: { ...WRITER_INTERCOM_OFF },
    tools: [...WRITER_TOOLS],
    // No `skill` / `skills` / `reads`: the solo git-workflow skill's `next=`
    // table orders "one push, then git pr-await once", and an obedient fixer
    // forked a second waiter from inside a child session (F7). The child's
    // whole contract is WRITER_CONTRACT, in the task text, backed by the
    // mechanical block in `lib/git-workflow-guard.ts`.
    agentContract: { version: 1 },
    acceptance: {
      level: "none",
      reason: "fixer implements review findings; git pr-await is the gate",
    },
  };
}

/**
 * Whether a writer still owns this Feature according to disk.
 *
 * `RUNNING_CHAINS` only knows about this process: a session that died mid-fix
 * leaves no lock behind, just a `worker_run_id`. A run whose snapshot cannot be
 * read is not evidence of a live writer — that is a dead session's leftover, and
 * treating it as live would wedge the Feature until someone edited status.md —
 * so only a non-terminal snapshot refuses a second fixer.
 */
function featureWorkerLive(status: string): boolean {
  const runId = statusField(status, "worker_run_id");
  if (isPendingToken(runId)) return false;
  const recorded = statusField(status, "worker_run_dir");
  const dir = !isPendingToken(recorded) ? recorded : asyncRunDir(runId);
  const snapshot = readRunSnapshot(dir);
  return Boolean(snapshot && !snapshot.terminal);
}

/**
 * A finished or vanished run must not keep `worker_run_id` set. That leftover
 * is how a dead writer made the next `read_comments_and_fix` `refuse` until
 * someone edited status.md by hand.
 */
export function sweepStaleWorkerRecord(paths: Paths): boolean {
  const status = readText(paths.statusFile);
  if (!featureWorkerLive(status) && !isPendingToken(statusField(status, "worker_run_id"))) {
    upsertStatusFile(paths, { workerRunId: "none", workerRunDir: "none" });
    return true;
  }
  return false;
}

/** The toast for a verdict that does not become a writer. */
function featurePrVerdictNotice(
  action: FeaturePrAction,
  pr: string,
  verdict: string,
  spent = 0,
): string {
  const head = `PR ${pr} — pr-await next=${verdict || "(none)"}`;
  if (action === "refuse") {
    return `${head}: a writer already holds this Feature. No second fixer was started.`;
  }
  if (action === "reawait") {
    return `${head}: no code finding to fix — code runs git pr-await once more (fixer round ${spent}).`;
  }
  if (action === "land") return `${head}: the waiter lands this PR. Nothing to fix.`;
  if (action === "archive") return `${head}: landed.`;
  if (action === "confirm") return `${head}: the PR is closed — confirm merged or closed unmerged.`;
  return `${head}. No writer for this verdict; the session stays idle.`;
}

/**
 * A land is one `git pr-land`, and one only. `ghl-pr-land` merges, waits for
 * GitHub to report the merge, and cleans the worktree up, so it needs more than
 * a handshake's worth of time.
 */
export const PR_LAND_CALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Land the PR through the git-workflow alias — never `gh pr merge`, which
 * skips the waiter's post-merge cleanup and its already-merged handling.
 *
 * Exactly one attempt. A PR that GitHub already merged is landed, not a
 * failure to retry: `ghl-pr-land` reports that as a refusal to delete a branch
 * that moved after the merge, and re-running it would fail the same way
 * forever.
 */
async function runFeaturePrLand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  paths: Paths,
  pr: string,
  worktree: string,
  result: { next: string; output: string; round?: string },
  reason: string,
): Promise<void> {
  // A `git_pr_land_continue` verdict carries the waiter's own resume argv
  // (a continuation cursor this side cannot reconstruct). Any other verdict
  // gets the plain form: a review body is attacker-adjacent text, and reading
  // an argv out of it would let a comment choose the command.
  const argv = MECHANICAL.has(String(result.next ?? "").trim().toLowerCase())
    ? (printedLandCommand(result.output ?? "") ?? ["pr-land", pr])
    : ["pr-land", pr];
  upsertStatusFile(paths, { phase: "pr", pr, nextAction: `git ${argv.join(" ")} — ${reason}` });
  uiNotify(ctx, `PR ${pr} — ${reason}. Landing with \`git ${argv.join(" ")}\`.`, "info");

  let code = 1;
  let output = "";
  try {
    const exec = await pi.exec("git", argv, { cwd: worktree, timeout: PR_LAND_CALL_TIMEOUT_MS });
    code = exec.code ?? 1;
    output = `${exec.stdout ?? ""}\n${exec.stderr ?? ""}`.trim();
  } catch (error) {
    output = String((error as { message?: string })?.message ?? error);
  }

  if (code === 0 || landFailedAlreadyMerged(output) || /already merged/i.test(output)) {
    upsertStatusFile(paths, { phase: "done", pr, nextAction: "landed" });
    uiNotify(ctx, `PR ${pr} landed. Feature complete.`, "info");
    return;
  }
  upsertStatusFile(paths, {
    phase: "pr",
    pr,
    nextAction: `git ${argv.join(" ")} failed — land it by hand, then /orchestrate resume`,
  });
  uiNotify(ctx, 
    `git ${argv.join(" ")} failed on PR ${pr}. Not retrying.\n${output.slice(-600)}`,
    "error",
  );
}

/**
 * Handshake, then dispatch any judgment `next=` so a follow-up
 * `read_comments_and_fix` cannot be dropped. Yield / done / pause stay silent.
 */
async function awaitAndDispatch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  paths: Paths,
  pr: string,
  worktree: string,
  opts: { holdsChainLock?: boolean; depth?: number } = {},
): Promise<PrAwaitOutcome> {
  const depth = opts.depth ?? 0;
  if (depth >= AWAIT_DISPATCH_MAX_DEPTH) {
    // The chain has had its handshakes. The waiter is still running and still
    // owns this PR; the reconciler picks up whatever it says next. Recursing
    // further is the unbounded loop, not progress (F9).
    upsertStatusFile(paths, {
      pr,
      nextAction: `pr-await handshakes spent (${depth}) — ghl-pr-await owns the wait`,
    });
    uiNotify(ctx,
      `PR ${pr}: ${depth} git pr-await handshakes in one chain is the bound. ` +
        `The waiter owns the review from here; nothing was dropped.`,
      "info",
    );
    return { done: false, next: "", output: "", round: "", silent: true };
  }
  const follow = await drivePrAwait(pi, ctx, paths, pr, worktree);
  if (follow.paused || follow.done || follow.silent) return follow;
  await dispatchFeaturePrVerdict(pi, ctx, paths, pr, worktree, follow, {
    ...opts,
    depth: depth + 1,
  });
  return follow;
}

/**
 * Push the Feature branch. Writers commit; code pushes (F7).
 *
 * stderr is returned verbatim rather than swallowed: "no upstream", "protected
 * branch" and "non-fast-forward" each need a different answer from the user,
 * and a generic failure message hid all three.
 */
export async function pushFeatureBranch(
  pi: ExtensionAPI,
  worktree: string,
  branch: string,
): Promise<{ ok: boolean; reason: string }> {
  if (!branch) return { ok: false, reason: "no branch to push (detached HEAD?)" };
  try {
    const r = await pi.exec("git", ["push", "-u", "origin", branch], {
      cwd: worktree,
      timeout: 120_000,
    });
    if (r.code === 0) return { ok: true, reason: "" };
    return {
      ok: false,
      reason: `${String(r.stderr ?? "").trim() || String(r.stdout ?? "").trim()}`.slice(-600) ||
        `git push exited ${r.code}`,
    };
  } catch (error) {
    return { ok: false, reason: String((error as { message?: string })?.message ?? error) };
  }
}

/**
 * Stop the fix loop and say so on the PR.
 *
 * The spec's termination rule is "loop until merge, or until the orchestrator
 * disagrees with the reviewers". Nothing implemented the second half, so PRs
 * consumed seven fixers each (F6). One comment from code — never from a child,
 * which cannot comment (F7) — records why the loop stopped, and the Feature
 * parks with a `next_action` a human can act on.
 */
export async function recordFeatureDisagreement(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  paths: Paths,
  pr: string,
  worktree: string,
  input: { reason: string; handoff?: string; head?: string; findings?: string[] },
): Promise<void> {
  const head = input.head || statusField(readText(paths.statusFile), "pr_head");
  const shortHead = head && !isPendingToken(head) ? head.slice(0, 12) : "";
  const body = [
    `Orchestrator: stopping the automated fix loop on this PR.`,
    "",
    `Reason: ${input.reason}.`,
    ...(shortHead ? ["", `Head at the time: \`${shortHead}\`.`] : []),
    ...(input.findings?.length
      ? ["", "Findings still open:", ...input.findings.map((f) => `- ${f}`)]
      : []),
    "",
    "Merge this PR if you agree with the code as it stands, or reply here and re-run `/orchestrate resume`.",
  ].join("\n");

  let posted = false;
  try {
    const r = await pi.exec("gh", ["pr", "comment", pr, "--body", body], {
      cwd: worktree,
      timeout: 60_000,
    });
    posted = r.code === 0;
  } catch {
    posted = false;
  }

  upsertStatusFile(paths, {
    phase: "pr",
    pr,
    ...(shortHead ? { prHead: head } : {}),
    nextAction:
      `disagreed${shortHead ? ` at ${shortHead}` : ""} — ${input.reason}; merge or reply on the PR`,
  });
  uiNotify(ctx,
    `PR ${pr} — the fix loop stopped: ${input.reason}.\n` +
      (posted ? "A comment explaining that is on the PR.\n" : "Could not post the PR comment.\n") +
      (input.handoff ? `Handoff: ${input.handoff}\n` : "") +
      "Merge it yourself if you agree with the code as it stands.",
    "info",
  );
}

/**
 * One review-fix round: a `fixer` in the Feature worktree, then a single
 * `git pr-await` run by code. A judgment `next=` from that await is dispatched
 * again — that is how a later review round still gets a fixer.
 *
 * The spawn is counted on disk *before* the child starts, so a session that
 * dies mid-fix cannot hand the next one a free round against the cap.
 */
async function runReviewFixWriter(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  paths: Paths,
  pr: string,
  worktree: string,
  result: { next: string; output: string; round?: string },
): Promise<void> {
  const spawn = fixSpawnCount(statusField(readText(paths.statusFile), "pr_round")) + 1;
  upsertStatusFile(paths, {
    phase: "pr",
    pr,
    prRound: String(spawn),
    worktree,
    workerRunId: "none",
    workerRunDir: "none",
    nextAction: `fixer round ${spawn} on PR ${pr}`,
  });
  uiNotify(ctx,
    `PR ${pr} — fixer round ${spawn}: one fixer in ${worktree}.\n` +
      `The session stays idle; code runs git pr-await once (fixer round ${spawn} latch) when that writer settles.`,
    "info",
  );

  // The branch before the fixer. Read here rather than after, so "did this
  // round move origin/<branch>?" is a comparison and not a guess.
  const before = await branchHeads(pi, worktree, { fetch: true });

  const outcome = await runChildInPhase(
    pi,
    ctx,
    "implement",
    reviewFixLaunchParams(paths, pr, worktree, result, spawn),
    (runId) => upsertStatusFile(paths, { workerRunId: runId, workerRunDir: asyncRunDir(runId) }),
  );
  upsertStatusFile(paths, { workerRunId: "none", workerRunDir: "none" });

  const handoff = join(paths.handoffsDir, `pr-fix-${pr}-${spawn}.md`);
  // Commit gate before the branch is read (F11): an uncommitted fix is
  // invisible to `fixerPushState`, which would call the round a no-op and
  // post a disagreement over work that was actually done.
  const gate = await ensureWriterCommit(pi, worktree, `fix: review round ${spawn}`);
  if (gate.state === "dirty") {
    upsertStatusFile(paths, {
      phase: "pr",
      pr,
      nextAction: `fixer round ${spawn} left the worktree dirty — ${gate.reason}`,
    });
    uiNotify(ctx,
      `PR ${pr} — fixer round ${spawn} left ${worktree} dirty and code could not commit it:\n${gate.reason}`,
      "error",
    );
    return;
  }
  if (gate.state === "committed") {
    uiNotify(ctx, `PR ${pr} — fixer round ${spawn} did not commit; code committed it.`, "info");
  }
  const after = await branchHeads(pi, worktree, { fetch: true });
  const push = fixerPushState({
    remoteBefore: before.remote,
    remoteAfter: after.remote,
    localAfter: after.local,
  });
  const settle = fixerSettleAction({
    ok: outcome.ok,
    stopped: outcome.stopped,
    handoffWritten: Boolean(readText(handoff).trim()),
    push,
  });
  if (settle === "pause") {
    upsertStatusFile(paths, {
      phase: "pr",
      pr,
      nextAction: `fixer round ${spawn} stopped — /orchestrate resume ${basename(paths.featureDir)}`,
    });
    uiNotify(ctx, `Fixer round ${spawn} on PR ${pr} stopped.\nHandoff: ${handoff}`, "info");
    return;
  }
  if (settle === "fail") {
    upsertStatusFile(paths, {
      phase: "pr",
      pr,
      nextAction: `fixer round ${spawn} did not pass — inspect the handoff, then /orchestrate resume`,
    });
    uiNotify(ctx, 
      `Fixer round ${spawn} on PR ${pr} did not pass (${outcome.reason ?? outcome.state ?? "failed"}).\n` +
        `Handoff: ${handoff}\nNot re-awaiting: no handoff, findings unchanged.`,
      "error",
    );
    return;
  }
  if (settle === "disagree") {
    // The branch did not move: the remaining finding is a product call, not a
    // code gap. Re-awaiting would re-dispatch the same head and burn another
    // round, so the disagreement is posted on the PR and the loop stops.
    await recordFeatureDisagreement(pi, ctx, paths, pr, worktree, {
      reason: `fixer round ${spawn} changed nothing on the branch`,
      handoff,
      head: after.remote || before.remote,
    });
    return;
  }

  if (settle === "push_then_await") {
    // The fixer committed and stopped short of the push. Writers are not
    // allowed to push (F7), so this is code's job, not a failed round.
    const pushed = await pushFeatureBranch(pi, worktree, after.branch);
    if (!pushed.ok) {
      upsertStatusFile(paths, {
        phase: "pr",
        pr,
        nextAction: `fixer round ${spawn} committed but the push failed — ${pushed.reason}`,
      });
      uiNotify(ctx,
        `PR ${pr} — fixer round ${spawn} committed, but code could not push:\n${pushed.reason}`,
        "error",
      );
      return;
    }
    uiNotify(ctx, `PR ${pr} — fixer round ${spawn} committed; code pushed ${after.branch}.`, "info");
  }

  // Exactly one `git pr-await`, in code. The writer is forbidden from waiting,
  // and the parent is never handed the review to work through itself. A
  // judgment `next=` here is another round, not the end of the Feature.
  // depth 0: a completed fix round is a new cycle, not deeper recursion. What
  // bounds *this* loop is the round cap in `classifyFeaturePrNext` (F6).
  await awaitAndDispatch(pi, ctx, paths, pr, worktree, { holdsChainLock: true, depth: 0 });
}

/**
 * Act on one judgment `next=` for a Feature-owned PR. Returns what was done.
 *
 * A review verdict is an event, so code answers it: `read_comments_and_fix`
 * becomes one writer plus one `git pr-await`, exactly like a Task. The parent
 * session is never sent a turn about it, which is what `FORBIDDEN` says.
 *
 * `holdsChainLock` is for callers that are already inside `withChainLock` for
 * this Feature (the chain's own PR step). Without it the re-entrant acquire
 * would refuse the very dispatch the chain just asked for.
 */
export async function dispatchFeaturePrVerdict(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  paths: Paths,
  pr: string,
  worktree: string,
  result: { next: string; output: string; round?: string },
  opts: { holdsChainLock?: boolean; depth?: number } = {},
): Promise<FeaturePrAction> {
  sweepStaleWorkerRecord(paths);
  const status = readText(paths.statusFile);

  // The reviewers' own finding set, and the head they raised it against. The
  // same set on a *different* head means a fixer pushed and changed nobody's
  // mind — the disagreement the spec asks for, and the only thing that ends
  // the loop short of a merge (F6). The same set on the *same* head is just
  // the verdict arriving twice and must not stop anything.
  const head = verdictHead(result.output);
  const findings = parseBriefFindings(result.output);
  const findingsTagNow = findingsTag(findings);
  const lastFindings = statusField(status, "last_findings");
  const lastHead = statusField(status, "pr_head");
  const findingsRepeated = Boolean(
    findingsTagNow &&
      findingsTagNow === lastFindings &&
      head &&
      !isPendingToken(lastHead) &&
      head !== lastHead,
  );

  const action = classifyFeaturePrNext(result.next, {
    prRound: statusField(status, "pr_round"),
    chainLocked: opts.holdsChainLock ? false : RUNNING_CHAINS.has(paths.featureDir),
    workerLive: featureWorkerLive(status),
    findingsRepeated,
  });

  // The waiter owns the rest: no status write, no toast, no model turn.
  if (action === "idle") return action;

  // Hashed, not raw: a verdict body is many lines and status.md holds one
  // value per line, so the raw fingerprint would be unreadable back out.
  const fingerprint = fingerprintTag(
    actionableFingerprint({
      next: result.next,
      verdict: result.output,
      round: result.round,
    }),
  );

  if (action === "refuse") {
    // A writer already owns this Feature. The verdict is NOT consumed: it is
    // recorded so the reconciler can drain it when the lock frees. Marking it
    // delivered here is what lost review findings for a whole fixer round (F4).
    const already = statusField(status, "pending_verdict");
    upsertStatusFile(paths, {
      pr,
      pendingVerdict: fingerprint,
      ...(already === fingerprint
        ? {}
        : {
            nextAction:
              `pr-await next=${result.next || "(none)"} refused — a writer holds this Feature; ` +
              `queued for retry`,
          }),
    });
    // The same refusal arrives on every waiter write and reconciler tick while
    // the writer runs.
    // Saying so once is information; saying it 120 times is noise.
    if (already !== fingerprint) {
      uiNotify(ctx, featurePrVerdictNotice(action, pr, result.next), "warning");
    }
    return action;
  }

  /**
   * Consume the verdict and clear any queued retry.
   *
   * Called the moment an action is committed to, not when the writer finishes
   * 30-60 minutes later: until the file is marked, every watch tick and every
   * reconcile pass sees the same undelivered ACTIONABLE and dispatches it again.
   */
  const accept = () => {
    spendWaiterVerdict(paths.repo, pr);
    upsertStatusFile(paths, { pendingVerdict: "none", verdictFingerprint: fingerprint });
  };

  const spent = fixSpawnCount(statusField(status, "pr_round"));

  if (action === "disagree") {
    // Spend the verdict: the loop is over, and leaving it undelivered would
    // have the reconciler re-raise the same disagreement every 60 seconds.
    accept();
    await recordFeatureDisagreement(pi, ctx, paths, pr, worktree, {
      reason: findingsRepeated
        ? `the same ${findings.length} finding${findings.length === 1 ? "" : "s"} came back on a new head after fixer round ${spent}`
        : `${spent} fixer rounds is the cap`,
      head: head || undefined,
      findings,
    });
    return action;
  }

  if (action === "reawait") {
    // A reviewer that never answered leaves nothing to fix, so no writer is
    // spawned; only the waiter can notice the review restarting.
    accept();
    upsertStatusFile(paths, {
      pr,
      nextAction: `pr-await next=${result.next || "(none)"} — re-awaiting once (fixer round ${spent})`,
    });
    uiNotify(ctx, featurePrVerdictNotice(action, pr, result.next, spent), "info");
    await awaitAndDispatch(pi, ctx, paths, pr, worktree, {
      holdsChainLock: opts.holdsChainLock,
      depth: opts.depth ?? 0,
    });
    return action;
  }

  if (action === "land") {
    accept();
    await runFeaturePrLand(
      pi,
      ctx,
      paths,
      pr,
      worktree,
      result,
      `pr-await next=${result.next} (fixer round ${spent})`,
    );
    return action;
  }

  if (action === "archive") {
    // Latch-detected merge never went through `drivePrAwait`'s `next=done`
    // branch, so phase may still be `pr` / `next=yield`. Always land here.
    accept();
    upsertStatusFile(paths, { phase: "done", pr, nextAction: "landed" });
    uiNotify(ctx, featurePrVerdictNotice(action, pr, result.next, spent), "info");
    // L3 §5 C: this archive is the second half of a finish the waiter never
    // saw, so the session holding the latch must hear about it now, not at the
    // 10-minute backstop. Same registry seam as `armObservedLatch` — never an
    // import of the latch module — and never a throw into the dispatch path.
    wakeLiveLatch(ctx, pr, result.next === "stop" ? "closed" : "merged");
    return action;
  }

  if (action !== "spawn_writer") {
    // `phase` is deliberately untouched: `drivePrAwait` already recorded `done`
    // for a landed PR, and rewriting it to `pr` here would un-land it.
    upsertStatusFile(paths, {
      pr,
      nextAction: `pr-await next=${result.next || "(none)"} — ${action} (fixer round ${spent})`,
    });
    // `refuse` returns above, so only `confirm`/`notify` reach here. The
    // ternary that used to test for it was dead: a refusal is warned about at
    // its own branch, which is where F4's "the finding vanished" note lives.
    uiNotify(ctx, featurePrVerdictNotice(action, pr, result.next, spent), "info");
    return action;
  }

  // The verdict is spent as the writer starts, not when it finishes: the
  // fixer holds the Feature for the better part of an hour.
  const fix = async () => {
    accept();
    // What this round was sent to fix, so the next one can recognise the same
    // complaints coming back against a head this fixer moved.
    upsertStatusFile(paths, {
      ...(findingsTagNow ? { lastFindings: findingsTagNow } : {}),
      ...(head ? { prHead: head } : {}),
    });
    await runReviewFixWriter(pi, ctx, paths, pr, worktree, result);
  };
  if (opts.holdsChainLock) {
    await fix();
    return action;
  }
  // One writer per Feature, decided by the lock rather than by the snapshot
  // above: between the classify and here, a chain may have started.
  if (await withChainLock(paths.featureDir, fix)) return action;
  // Lost that race. Nothing was spent, so record the retry the same way the
  // early refusal does.
  upsertStatusFile(paths, { pr, pendingVerdict: fingerprint });
  uiNotify(ctx, featurePrVerdictNotice("refuse", pr, result.next), "warning");
  return "refuse";
}

/**
 * Same dispatch for a caller that found the Feature on disk rather than through
 * `/orchestrate` — the pr-await latch, which knows a `FeaturePrOwner` and must
 * not know where a Feature keeps its plan, status, and handoffs.
 *
 * `ctx` is a plain `ExtensionContext` because the latch is a sensor, not a
 * command handler. Nothing on the dispatch path touches the session-control
 * methods `ExtensionCommandContext` adds; `ui` and `sessionManager` are the
 * whole surface it uses.
 */
export async function dispatchFeaturePrVerdictForOwner(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  owner: FeaturePrOwner,
  result: { next: string; output: string; round?: string },
): Promise<FeaturePrAction> {
  // No worktree, nowhere to run a writer. Refusing beats launching a child
  // whose cwd is empty.
  if (!owner.worktree) return "refuse";
  const repoDir = dirname(owner.dir);
  const paths = bindFeature(
    {
      repo: owner.repo,
      gitRoot: join(REF_ROOT, owner.repo),
      repoDir,
      featureDir: owner.dir,
      planFile: "",
      statusFile: "",
      handoffsDir: "",
      archiveDir: join(repoDir, "archive"),
    },
    owner.dir,
  );
  // Branch-recovered ownership must stick: the next verdict looks at `pr:`.
  if (!normalizePrNumber(statusField(readText(paths.statusFile), "pr"))) {
    upsertStatusFile(paths, { pr: owner.pr, nextAction: `pr-await ${owner.pr}` });
  }
  return dispatchFeaturePrVerdict(
    pi,
    ctx as ExtensionCommandContext,
    paths,
    owner.pr,
    owner.worktree,
    result,
  );
}

/* ------------------------------------------------------------------ *
 * Durable Feature PR reconcile
 *
 * `pr-reconcile.ts` holds the decisions; this is the wiring that gives it a
 * real `gh`, a real dispatcher, and real files. It runs on `session_start`, on
 * every `/orchestrate` verb, whenever a chain releases the lock with a verdict
 * queued, and on one process-wide 60s timer while any Feature is in `phase: pr`.
 *
 * That is deliberately more triggers than strictly needed. The failure being
 * fixed is a Feature nobody is watching (F1), so every moment this extension is
 * awake for any reason is a chance to notice.
 * ------------------------------------------------------------------ */

export const RECONCILE_INTERVAL_MS = 60_000;

/** Paths for a Feature the reconciler found on disk. */
function ownerPaths(owner: FeaturePrOwner): Paths {
  const repoDir = dirname(owner.dir);
  return bindFeature(
    {
      repo: owner.repo,
      gitRoot: join(REF_ROOT, owner.repo),
      repoDir,
      featureDir: owner.dir,
      planFile: "",
      statusFile: "",
      handoffsDir: "",
      archiveDir: join(repoDir, "archive"),
    },
    owner.dir,
  );
}

/** `gh pr view` for one Feature, from a directory that can answer. */
async function featurePrState(
  pi: ExtensionAPI,
  owner: FeaturePrOwner,
): Promise<{ state: "open" | "merged" | "closed" | "unknown"; head?: string }> {
  const candidates = [owner.worktree, join(REF_ROOT, owner.repo)].filter(
    (dir): dir is string => typeof dir === "string" && dir.length > 0 && existsSync(dir),
  );
  for (const cwd of candidates) {
    try {
      const result = await pi.exec(
        "gh",
        ["pr", "view", owner.pr, "--json", "state,mergedAt,headRefOid"],
        { cwd, timeout: 20_000 },
      );
      if (result.code !== 0) continue;
      const json = JSON.parse(String(result.stdout ?? "")) as {
        state?: unknown;
        mergedAt?: unknown;
        headRefOid?: unknown;
      };
      const head = typeof json.headRefOid === "string" ? json.headRefOid : undefined;
      if (json.mergedAt) return { state: "merged", head };
      const state = String(json.state ?? "").toLowerCase();
      if (!state) continue;
      return { state: state === "open" ? "open" : "closed", head };
    } catch {
      // Try the next directory; an unanswerable PR stays `unknown`, and
      // `unknown` never closes a Feature.
    }
  }
  return { state: "unknown" };
}

/**
 * One reconcile pass over every live Feature PR in this orchestrator root.
 *
 * Never throws: it is called from event handlers and a timer, and a session
 * must not die because `gh` was rate-limited or a status.md was half-written.
 */
export async function reconcileLiveFeaturePrs(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
): Promise<ReconcileResult | undefined> {
  try {
    return await reconcileFeaturePrs({
      listFeatures: () => listFeaturePrOwners(),
      prState: (owner) => featurePrState(pi, owner),
      undeliveredVerdicts: (owner) => undeliveredWaiterVerdicts(owner.pr),
      dispatch: (owner, verdict) =>
        dispatchFeaturePrVerdictForOwner(pi, ctx as ExtensionContext, owner, verdict),
      driverRunning: (owner) => isDriverRunning(owner.pr),
      ensureWaiter: (owner) => {
        // The waiter's own `--state` file, never the extension's latch copy,
        // and never a path this extension then writes to (F20).
        const paths = waiterPaths(owner.repo, owner.pr);
        const cwd =
          (owner.worktree && existsSync(owner.worktree) && owner.worktree) ||
          join(REF_ROOT, owner.repo);
        if (!existsSync(cwd)) return;
        spawnDetachedWaiter({
          stateFile: paths.manual[0]!,
          cwd,
          logFile: paths.log[0]!,
        });
      },
      writeStatus: (owner, patch) => {
        upsertStatusFile(ownerPaths(owner), patch);
      },
      onError: (owner, error) => {
        uiNotify(
          ctx as { ui?: { notify?: (m: string, t?: "info" | "warning" | "error") => void } },
          `Reconcile of Feature ${owner.name} (PR ${owner.pr}) failed: ${String(error)}`,
          "warning",
        );
      },
    });
  } catch {
    // A reconcile pass is best-effort by construction.
    return undefined;
  }
}

let reconcileTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Keep one process-wide timer alive exactly while some Feature is in the PR
 * phase. Unref'd, so it never holds pi open, and torn down when the last PR
 * lands — a 60s poll that runs forever in every session is the kind of cost
 * this review is trying to remove, not add.
 */
function armReconcileTimer(pi: ExtensionAPI, ctx: ExtensionContext): void {
  let live = false;
  try {
    live = listFeaturePrOwners().length > 0;
  } catch {
    live = false;
  }
  if (!live) {
    if (reconcileTimer) {
      clearInterval(reconcileTimer);
      reconcileTimer = undefined;
    }
    return;
  }
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    void reconcileLiveFeaturePrs(pi, ctx).then(() => {
      // Stop the timer once the last PR phase is over.
      try {
        if (listFeaturePrOwners().length === 0 && reconcileTimer) {
          clearInterval(reconcileTimer);
          reconcileTimer = undefined;
        }
      } catch {
        /* keep polling */
      }
    });
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();
}

/* ------------------------------------------------------------------ *
 * The Feature chain
 * ------------------------------------------------------------------ */

/** Feature dirs with a chain in flight. One writer per Feature, enforced. */
const RUNNING_CHAINS = new Set<string>();

/**
 * Run `body` only if this Feature has no chain in flight; `false` means it was
 * refused and `body` never ran.
 *
 * The lock has to be taken before anything else touches the Feature. The TUI
 * fires a slash command without awaiting the previous one, and the guard used
 * to sit *after* `implement <task>` had already rewritten `plan.md` — so a
 * refused command still flipped a done Task back to pending, which the chain
 * that was already running would then pick up and re-run. Acquiring first
 * makes refusal mean "nothing happened".
 *
 * Errors propagate; the lock is released either way, so a thrown chain does
 * not wedge the Feature until the extension reloads.
 */
/**
 * Called after a chain releases the Feature lock. Set by the extension so
 * `withChainLock` keeps its two-argument shape and stays testable in isolation.
 */
let onChainReleased: ((featureDir: string) => void) | undefined;

export function setChainReleaseHook(fn: ((featureDir: string) => void) | undefined): void {
  onChainReleased = fn;
}

export async function withChainLock(
  featureDir: string,
  body: () => Promise<unknown>,
): Promise<boolean> {
  if (RUNNING_CHAINS.has(featureDir)) return false;
  RUNNING_CHAINS.add(featureDir);
  try {
    await body();
    return true;
  } finally {
    RUNNING_CHAINS.delete(featureDir);
    // A verdict refused while this chain held the lock is now dispatchable.
    // Waiting for the next 60s tick would be correct but slow, and the review
    // round it belongs to is already minutes old.
    try {
      onChainReleased?.(featureDir);
    } catch {
      // The drain is best-effort; never fail a finished chain over it.
    }
  }
}

/** Persisted structured-output artifacts named by the completion notification. */
function structuredOutputPaths(outcome: ChildOutcome): string[] {
  const results = outcome.raw?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((row) => (row as { structuredOutputPath?: unknown })?.structuredOutputPath)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** Structured output as carried on the completion notification, if present. */
function structuredResult(outcome: ChildOutcome): unknown {
  const raw = outcome.raw;
  if (!raw) return undefined;
  if (raw.structuredOutput !== undefined) return raw.structuredOutput;
  const results = raw.results;
  if (Array.isArray(results)) {
    for (const row of results) {
      const value = (row as { structuredOutput?: unknown })?.structuredOutput;
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

/**
 * Run every remaining Task, then feature-QA, then land one Feature PR.
 *
 * Everything this function decides — which Task is next, which model runs
 * it, when to stop for a pause or a block, whether QA is owed, when the PR
 * may open — used to be prose in `implementPrompt`. Only the work that
 * genuinely needs a model is delegated, and each delegation is one child
 * with an explicit contract.
 */
async function runFeatureChain(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  paths: Paths,
  name: string,
  worktree: string,
): Promise<void> {
  // Before anything is scheduled: settle a Task an earlier session left in
  // flight. Without this the loop below would pick that Task first and run
  // it a second time over work that is already on the branch.
  if (!(await reconcileOrphanTask(pi, ctx, paths, name, worktree))) return;
  for (;;) {
    let plan = readText(paths.planFile);
    const reopened = reopenTasksThatNeverStarted(plan, paths.handoffsDir);
    if (reopened !== plan) {
      writeText(paths.planFile, reopened);
      plan = reopened;
      uiNotify(ctx, `Reopened Task(s) that never started (no handoff).`, "info");
    }
    const tasks = parseTasks(plan);

    if (tasks.some((t) => t.status === "blocked")) {
      upsertStatusFile(paths, {
        phase: "blocked",
        nextAction: "resolve the blocked Task, then /orchestrate resume",
      });
      uiNotify(ctx, `Blocked Task on ${name}. Chain stopped, no PR opened.`, "warning");
      return;
    }

    const inFlight = tasks.find((t) => t.status === "in_progress");
    const task = inFlight ?? tasks.find((t) => t.status === "pending");

    if (task) {
      const statusNow = readText(paths.statusFile);
      const blockedByReview = writerBlockedByPlanReview(statusNow);
      if (blockedByReview || needsPlanReview(plan, statusNow)) {
        uiNotify(
          ctx,
          blockedByReview ?? "plan-reviewer has not finished; not starting Tasks.",
          "error",
        );
        return;
      }
      if (!inFlight && isPaused(statusNow)) {
        upsertStatusFile(paths, {
          phase: "paused",
          pause: "after-task",
          nextAction: "/orchestrate resume",
        });
        uiNotify(ctx, `Paused on ${name} before Task ${task.id}.`, "info");
        return;
      }

      const worker = workerFor(task.complexity) ?? WORKERS.simple;
      writeText(paths.planFile, setTaskStatusInPlan(plan, task.id, "in_progress"));
      const planNow = readText(paths.planFile);
      const body = taskSection(planNow, task.id);
      const branch = planHeaderField(planNow, "Branch");
      let writerCwd = taskWorkerCwd(body, worktree, planNow, branch);
      if (writerCwd === worktree) {
        const repo = taskRepoName(body, planNow);
        if (repo && worktreeFarmFor(repo) !== dirname(worktree)) {
          const made = await ensureRepoWorktree(pi, repo, branch);
          if (made) writerCwd = made;
        }
      }
      // Nothing has run yet and the tree already has changes: they are not
      // this Feature's, and the commit gate below would sign them with a Task
      // message. Stop instead (F11).
      const dirtyFirst = firstTaskBlockedByDirtyTree(
        tasks,
        await porcelainStatus(pi, writerCwd),
      );
      if (dirtyFirst) {
        writeText(paths.planFile, setTaskStatusInPlan(planNow, task.id, "pending"));
        upsertStatusFile(paths, {
          phase: "blocked",
          activeTask: "none",
          nextAction: dirtyFirst,
          tasks: parseTasks(readText(paths.planFile)),
        });
        uiNotify(ctx, `${name}: ${dirtyFirst}\nNo Task started, no PR opened.`, "error");
        return;
      }

      upsertStatusFile(paths, {
        phase: "implementing",
        activeTask: task.id,
        worktree,
        nextAction: `tdd-worker Task ${task.id} (${worker.short})`,
        tasks: parseTasks(planNow),
      });
      uiNotify(ctx, 
        `Task ${task.id} — ${task.title}\n${worker.short} · ${task.complexity ?? "simple (default)"}\ncwd ${writerCwd}`,
        "info",
      );

      const beforeFingerprint = await worktreeFingerprint(pi, writerCwd);
      // Recorded before the spawn, not kept in a local only: if this session
      // dies mid-Task, the next one still knows what the worktree looked like
      // before the worker touched it, and can tell landed work from none.
      upsertStatusFile(paths, {
        taskBase: fingerprintTag(beforeFingerprint) || "none",
        workerRunDir: "none",
      });
      const outcome = await runChildInPhase(
        pi,
        ctx,
        "implement",
        workerLaunchParams(paths, task, worktree, readText(paths.planFile)),
        (runId) =>
          upsertStatusFile(paths, { workerRunId: runId, workerRunDir: asyncRunDir(runId) }),
      );

      const after = readText(paths.planFile);
      const handoff = join(paths.handoffsDir, `task-${task.id}.md`);
      // A child this extension stopped (`/orchestrate pause now`) is not a
      // failed Task. Leaving it `blocked` would make `/orchestrate resume`
      // hit the blocked guard above and refuse forever.
      if (!outcome.ok && outcome.stopped) {
        writeText(paths.planFile, setTaskStatusInPlan(after, task.id, "pending"));
        upsertStatusFile(paths, {
          phase: "paused",
          pause: "after-task",
          workerRunId: "none",
          workerRunDir: "none",
          taskBase: "none",
          activeTask: "none",
          nextAction: "/orchestrate resume",
          tasks: parseTasks(readText(paths.planFile)),
        });
        uiNotify(ctx, 
          `Task ${task.id} stopped and left pending on ${name}.\n/orchestrate resume re-runs it from the start.`,
          "info",
        );
        return;
      }
      // The commit gate, before any fingerprint is read (F11). A worker that
      // edited and did not commit leaves work that `git push` would not carry,
      // so code commits it here or the Task blocks. Committing also changes
      // HEAD, which is what makes the fingerprint below evidence of a *land*
      // rather than of an unstaged edit.
      const gate = await ensureWriterCommit(pi, writerCwd, `Task ${task.id} — ${task.title}`);
      if (gate.state === "dirty") {
        writeText(
          paths.planFile,
          setTaskHandoffInPlan(setTaskStatusInPlan(after, task.id, "blocked"), task.id, handoff),
        );
        upsertStatusFile(paths, {
          phase: "blocked",
          workerRunId: "none",
          workerRunDir: "none",
          taskBase: "none",
          activeTask: task.id,
          nextAction: `dirty worktree after Task ${task.id}: ${gate.reason}`,
          tasks: parseTasks(readText(paths.planFile)),
        });
        uiNotify(ctx,
          `Task ${task.id} left ${writerCwd} dirty and code could not commit it:\n${gate.reason}\n` +
            `Chain stopped, no PR opened.`,
          "error",
        );
        return;
      }
      if (gate.state === "committed") {
        uiNotify(ctx, `Task ${task.id} was not committed by its worker; code committed it.`, "info");
      }

      // Fingerprint after the child, before deciding fail vs continue. A
      // harness fail with a changed worktree is a false fail when
      // autoAdvanceOnLanded is on (default): the work landed, so the next
      // Task starts instead of waiting for /orchestrate resume.
      const afterFingerprint = await worktreeFingerprint(pi, writerCwd);
      const landed = worktreeChanged(beforeFingerprint, afterFingerprint);
      // A Task with a runnable `- Command:` was graded by the host, so
      // `outcome.ok` is a verified fact about the code and not the child's
      // opinion of itself. That changes what a failure means (F13).
      const gated = Boolean(taskGateCommand(body));
      const gateResult = taskGateResult({ gated, ok: outcome.ok });
      const handoffLine = `${handoff}  gate: ${gateResult}`;
      if (!outcome.ok) {
        const failSettle = settleTaskOutcome({
          ok: false,
          landed,
          autoAdvance: autoAdvanceOnLanded(readText(paths.statusFile)),
          gated,
        });
        if (failSettle.action === "done_continue") {
          writeText(
            paths.planFile,
            setTaskHandoffInPlan(setTaskStatusInPlan(after, task.id, "done"), task.id, handoffLine),
          );
          upsertStatusFile(paths, {
            workerRunId: "none",
            workerRunDir: "none",
            taskBase: "none",
            activeTask: "none",
            tasks: parseTasks(readText(paths.planFile)),
          });
          uiNotify(ctx, 
            `Task ${task.id} succeeded; harness reported failed. Work landed — continuing.\n` +
              `Handoff: ${handoff}`,
            "info",
          );
          if (isPaused(readText(paths.statusFile))) {
            upsertStatusFile(paths, { phase: "paused", nextAction: "/orchestrate resume" });
            uiNotify(ctx, `Paused after Task ${task.id}. /orchestrate resume to continue.`, "info");
            return;
          }
          continue;
        }
        writeText(
          paths.planFile,
          setTaskHandoffInPlan(
            setTaskStatusInPlan(after, task.id, "blocked"),
            task.id,
            handoffLine,
          ),
        );
        const red = failSettle.reason === "failed_gate";
        upsertStatusFile(paths, {
          phase: "blocked",
          workerRunId: "none",
          workerRunDir: "none",
          taskBase: "none",
          activeTask: task.id,
          nextAction: red
            ? `Task ${task.id} gate is red — fix it, then /orchestrate resume`
            : "inspect the handoff, then /orchestrate resume",
          tasks: parseTasks(readText(paths.planFile)),
        });
        uiNotify(ctx,
          `Task ${task.id} did not pass (${outcome.reason ?? outcome.state ?? "failed"}).\n` +
            (red
              ? `Its \`- Command:\` gate ran and came back red; work landing does not change that.\n`
              : "") +
            `Handoff: ${handoff}\nChain stopped, no PR opened.`,
          "error",
        );
        return;
      }

      const settle = settleTaskOutcome({
        ok: outcome.ok,
        stopped: outcome.stopped,
        landed,
        autoAdvance: autoAdvanceOnLanded(readText(paths.statusFile)),
      });
      // Host-only Features (edits outside ice-wt) used to die here: success +
      // unchanged fingerprint marked `blocked`, so the next Task never started.
      // `settleTaskOutcome` advances to the next Task instead. It never QA/PRs
      // or starts another Feature — that is the loop below, after Tasks end.
      if (settle.action === "done_continue" && settle.reason === "ok_unchanged") {
        writeText(
          paths.planFile,
          setTaskHandoffInPlan(setTaskStatusInPlan(after, task.id, "done"), task.id, handoffLine),
        );
        upsertStatusFile(paths, {
          workerRunId: "none",
          workerRunDir: "none",
          taskBase: "none",
          activeTask: "none",
          tasks: parseTasks(readText(paths.planFile)),
        });
        uiNotify(ctx, 
          `Task ${task.id} done (worktree unchanged — host-side edits still count). Next Task.\n` +
            `Handoff: ${handoff}`,
          "info",
        );
        if (isPaused(readText(paths.statusFile))) {
          upsertStatusFile(paths, { phase: "paused", nextAction: "/orchestrate resume" });
          uiNotify(ctx, `Paused after Task ${task.id}. /orchestrate resume to continue.`, "info");
          return;
        }
        continue;
      }

      writeText(
        paths.planFile,
        setTaskHandoffInPlan(setTaskStatusInPlan(after, task.id, "done"), task.id, handoffLine),
      );
      upsertStatusFile(paths, {
        workerRunId: "none",
        workerRunDir: "none",
        taskBase: "none",
        activeTask: "none",
        tasks: parseTasks(readText(paths.planFile)),
      });
      uiNotify(
        ctx,
        formatTodoProgress(paths, `Task ${task.id} done (gate: ${gateResult}).`),
        "info",
      );

      if (isPaused(readText(paths.statusFile))) {
        upsertStatusFile(paths, { phase: "paused", nextAction: "/orchestrate resume" });
        uiNotify(ctx, `Paused after Task ${task.id}. /orchestrate resume to continue.`, "info");
        return;
      }
      continue;
    }

    // ---- No Tasks left: QA owed? ----
    const status = readText(paths.statusFile);
    if (needsFeatureQa(status)) {
      const { pass, cap } = qaPassState(status);
      upsertStatusFile(paths, {
        phase: "feature-qa",
        nextAction: `feature-qa pass ${pass + 1}/${cap}`,
      });
      uiNotify(ctx, `All Tasks done on ${name}. feature-qa ${pass + 1}/${cap} (xai/grok-4.6 high)…`, "info");

      let added = await runFeatureQa(pi, ctx, paths, name, worktree);
      // One automatic retry (F12). A QA child that dies in transport or misses
      // its schema is a flake, not a verdict, and parking the Feature for a
      // manual `/orchestrate resume` over it wasted whole Features.
      if (added < 0) {
        uiNotify(ctx, `feature-qa pass ${pass + 1}/${cap} did not produce findings. Retrying once…`, "warning");
        added = await runFeatureQa(pi, ctx, paths, name, worktree);
      }
      // Only a completed pass counts. Incrementing before this check would let
      // a failed QA satisfy the cap, and the next `/orchestrate resume` would
      // walk straight past QA into the PR.
      if (added < 0) return; // QA itself failed twice; runFeatureQa already reported.
      upsertStatusFile(paths, { qaPass: String(pass + 1) });
      if (added > 0) {
        uiNotify(
          ctx,
          formatTodoProgress(
            paths,
            `feature-qa added ${added} remediation Task(s). Next tdd-worker implements them.`,
          ),
          "info",
        );
        continue;
      }
      uiNotify(ctx, "feature-qa found nothing to fix.", "info");
      continue;
    }

    // ---- Everything done and QA satisfied: land one Feature PR ----
    // Host extensions have no git remote. A PR worker against a git-init copy
    // cannot land, and copying back into the live auto-load dir is the bug
    // this farm exists to avoid. Stop here; install is a reload, not a merge.
    if (isHostBase(paths.repo)) {
      upsertStatusFile(paths, {
        phase: "done",
        nextAction: `host Feature complete — install from ${worktree} into ~/.pi/agent/extensions, then reload pi`,
      });
      uiNotify(
        ctx,
        `Host Feature ${name} is done in isolated worktree:\n${worktree}\nNot opening a PR (no owner remote). Copy changed files into ~/.pi/agent/extensions and reload pi.`,
        "info",
      );
      return;
    }
    await landFeaturePr(pi, ctx, paths, name, worktree);
    return;
  }
}

/** How often a still-live orphan run is re-read while the chain waits. */
const ORPHAN_POLL_MS = 15_000;

/**
 * Settle a Task left `in_progress` by a session that is no longer running.
 *
 * Returns false when the chain must stop (the Task ended up blocked, or its
 * worker is genuinely still running and outlived the wait), true when the
 * loop may proceed — either past a Task now recorded `done`, or into a
 * re-run of one now back at `pending`.
 */
export async function reconcileOrphanTask(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  paths: Paths,
  name: string,
  worktree: string,
): Promise<boolean> {
  const task = parseTasks(readText(paths.planFile)).find((t) => t.status === "in_progress");
  if (!task) return true;

  const status = readText(paths.statusFile);
  const runId = statusField(status, "worker_run_id");
  const recordedDir = statusField(status, "worker_run_dir");
  const dir = !isPendingToken(recordedDir)
    ? recordedDir
    : isPendingToken(runId)
      ? ""
      : asyncRunDir(runId);

  let snapshot = readRunSnapshot(dir);
  if (snapshot && !snapshot.terminal) {
    uiNotify(ctx, 
      `Task ${task.id} is still running from an earlier session (run ${runId.slice(0, 8)}).\n` +
        `Waiting for it instead of starting it twice. /orchestrate pause now stops it.`,
      "info",
    );
    const deadline = Date.now() + CHILD_TIMEOUT_MS;
    while (snapshot && !snapshot.terminal && Date.now() < deadline) {
      if (isPaused(readText(paths.statusFile))) break;
      await sleep(ORPHAN_POLL_MS);
      snapshot = readRunSnapshot(dir);
    }
  }

  const baseTag = statusField(readText(paths.statusFile), "task_base");
  const handoff = join(paths.handoffsDir, `task-${task.id}.md`);
  const landed = landedByEvidence({
    baseTag: isPendingToken(baseTag) ? "" : baseTag,
    nowTag: fingerprintTag(await worktreeFingerprint(pi, worktree)),
    handoffMtimeMs: fileMtimeMs(handoff),
    runStartedAtMs: snapshot?.startedAtMs ?? 0,
  });
  const decision = orphanDecision(
    snapshot,
    landed,
    autoAdvanceOnLanded(readText(paths.statusFile)),
    Boolean(taskGateCommand(taskSection(readText(paths.planFile), task.id))),
  );
  const plan = readText(paths.planFile);
  const cleared = { workerRunId: "none", workerRunDir: "none", taskBase: "none" } as const;

  if (decision === "wait") {
    upsertStatusFile(paths, {
      phase: "paused",
      nextAction: `Task ${task.id} worker still live (run ${runId}) — /orchestrate pause now, or resume later`,
    });
    uiNotify(ctx, 
      `Task ${task.id} on ${name} is still being written by run ${runId.slice(0, 8)}.\n` +
        `Nothing started, to keep one writer on ${worktree}.`,
      "warning",
    );
    return false;
  }

  if (decision === "done") {
    writeText(
      paths.planFile,
      setTaskHandoffInPlan(setTaskStatusInPlan(plan, task.id, "done"), task.id, handoff),
    );
    upsertStatusFile(paths, {
      ...cleared,
      activeTask: "none",
      tasks: parseTasks(readText(paths.planFile)),
    });
    uiNotify(ctx, 
      `Task ${task.id} recovered: its worker finished (${snapshot?.state ?? "no run record"}) ` +
        `after the session that started it ended, and the work is on the branch.\n` +
        `Handoff: ${handoff}\nContinuing the chain.`,
      "info",
    );
    return true;
  }

  if (decision === "blocked") {
    writeText(
      paths.planFile,
      setTaskHandoffInPlan(setTaskStatusInPlan(plan, task.id, "blocked"), task.id, handoff),
    );
    upsertStatusFile(paths, {
      ...cleared,
      phase: "blocked",
      activeTask: task.id,
      nextAction: "inspect the handoff, then /orchestrate resume",
      tasks: parseTasks(readText(paths.planFile)),
    });
    uiNotify(ctx, 
      `Task ${task.id} was orphaned by a dead session and left nothing usable ` +
        `(${snapshot?.state ?? "no run record"}${landed ? "" : ", worktree unchanged"}).\n` +
        `Handoff: ${handoff}\nChain stopped, no PR opened.`,
      "error",
    );
    return false;
  }

  writeText(paths.planFile, setTaskStatusInPlan(plan, task.id, "pending"));
  upsertStatusFile(paths, {
    ...cleared,
    activeTask: "none",
    tasks: parseTasks(readText(paths.planFile)),
  });
  uiNotify(ctx, 
    `Task ${task.id} was orphaned (${snapshot?.state ?? "no run record"}) and left no work. ` +
      `Re-running it from the start.`,
    "info",
  );
  return true;
}

/**
 * The QA child's launch contract. Its model comes from `qaModelFor`, which
 * reads `orchestrate.json` — the reviewer model is configured in one place,
 * and the spawn policy checks that same value, so a launch cannot disagree
 * with the scope it will be judged against.
 */
export function qaLaunchParams(
  paths: Paths,
  name: string,
  worktree: string,
  agent: "feature-qa" | "qa-opus",
  thinking?: string,
): Record<string, unknown> {
  const stem = agent === "qa-opus" ? "qa-end" : "feature-qa";
  return {
    agent,
    task: [
      `Read-only QA of Feature ${name} — this Feature only.`,
      `Diff this worktree against the plan: ${paths.planFile}`,
      `Restrict to this worktree, this plan, this Feature's files. Do not review other Features,`,
      `other branches, or unrelated dirty files. Do not edit product code. Do not open a PR.`,
      "",
      `Classify every finding as blocker | fix-now | defer | correct, with file:line evidence.`,
      `For each blocker and fix-now, return a complete tdd-worker contract:`,
      `goal, complexity (simple|critical), read, redTest, command, implement, invariants, outOfTask.`,
      `The command must be a real, runnable red/green command for this repo.`,
      `Return findings through the structured output schema. Defer and correct are recorded but never become Tasks.`,
    ].join("\n"),
    context: "fresh",
    cwd: worktree,
    model: qaModelFor(agent, thinking),
    output: join(paths.handoffsDir, `${stem}.md`),
    outputMode: "inline",
    outputSchema: QA_FINDINGS_SCHEMA,
    acceptance: { level: "none", reason: "read-only review" },
    timeoutMs: CHILD_TIMEOUT_MS,
    turnBudget: QA_TURN_BUDGET,
  };
}

/**
 * One read-only QA child over this Feature, returning findings as data.
 * Returns the number of remediation Tasks appended, or -1 if QA failed.
 */
async function runFeatureQa(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  paths: Paths,
  name: string,
  worktree: string,
  agent: "feature-qa" | "qa-opus" = "feature-qa",
  thinking: "high" | "xhigh" = "high",
): Promise<number> {
  const stem = agent === "qa-opus" ? "qa-end" : "feature-qa";
  const outcome = await runChildInPhase(
    pi,
    ctx,
    agent === "qa-opus" ? "qa" : "implement",
    qaLaunchParams(paths, name, worktree, agent, thinking),
  );

  if (!outcome.ok) {
    upsertStatusFile(paths, {
      phase: "feature-qa",
      nextAction: `${agent} failed — /orchestrate resume to retry`,
    });
    uiNotify(ctx, 
      `${agent} did not complete (${outcome.reason ?? outcome.state ?? "failed"}). No PR opened.`,
      "error",
    );
    return -1;
  }

  // "Reviewed and clean" and "returned nothing to read" are different facts.
  // Treating a missing payload as zero findings would open the PR on the
  // strength of a review that never produced one.
  const payload = readStructuredOutput(paths, stem, outcome);
  if (payload === undefined || !Array.isArray((payload as { findings?: unknown })?.findings)) {
    upsertStatusFile(paths, {
      phase: "feature-qa",
      nextAction: `${agent} returned no structured findings — /orchestrate resume to retry`,
    });
    uiNotify(ctx, 
      `${agent} completed but returned no structured findings (schema not satisfied).\n` +
        `Handoff: ${join(paths.handoffsDir, `${stem}.md`)}\nNo PR opened.`,
      "error",
    );
    return -1;
  }

  return appendQaTasks(paths, parseQaFindings(payload));
}

/**
 * Structured output travels with the completion, but the durable artifact on
 * disk is the fallback when the event carries only a summary.
 */
function readStructuredOutput(
  paths: Paths,
  stem: string,
  outcome: ChildOutcome,
): unknown {
  const direct = structuredResult(outcome);
  if (direct !== undefined) return direct;
  // The validated payload is also persisted; the notification records where.
  for (const path of structuredOutputPaths(outcome)) {
    const text = readText(path);
    if (!text.trim()) continue;
    try {
      return JSON.parse(text);
    } catch {
      /* try the next artifact */
    }
  }
  const raw = readText(join(paths.handoffsDir, `${stem}.md`));
  if (!raw.trim()) return undefined;
  const fenced = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const candidate = fenced?.[1] ?? raw.slice(raw.indexOf("{"));
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/** Digits-only PR number from a schema field, URL, or `pr=N`. */
export function normalizePrNumber(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || PENDING_TOKEN.test(trimmed)) return "";
  const url = trimmed.match(/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i);
  if (url?.[1]) return url[1];
  if (/^\d+$/.test(trimmed)) return trimmed;
  const labeled = trimmed.match(/\bpr[#=:\s]+(\d+)\b/i);
  return labeled?.[1] ?? "";
}

/** First GitHub pull URL / `pr=N` / JSON `pr` in a child dump. */
export function parseOpenedPr(text: string): { pr: string; url?: string } | undefined {
  if (!text.trim()) return undefined;
  const href = text.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/);
  if (href?.[1]) return { pr: href[1], url: href[0] };
  const brace = text.indexOf("{");
  if (brace >= 0) {
    try {
      const json = JSON.parse(text.slice(brace, text.lastIndexOf("}") + 1)) as {
        pr?: unknown;
        url?: unknown;
      };
      const pr = normalizePrNumber(json.pr) || normalizePrNumber(json.url);
      if (pr) {
        const parsed: { pr: string; url?: string } = { pr };
        if (typeof json.url === "string" && json.url.trim()) parsed.url = json.url.trim();
        return parsed;
      }
    } catch {
      /* not JSON */
    }
  }
  const labeled = text.match(/\bPR\s+#?(\d+)\b/i) || text.match(/\bpr[=:](\d+)\b/i);
  return labeled?.[1] ? { pr: labeled[1] } : undefined;
}

export function resolveOpenedPr(input: {
  structured?: { opened?: boolean; pr?: unknown; url?: unknown } | null;
  summary?: string;
  handoff?: string;
}): { pr: string; url?: string } | undefined {
  const fromStruct = normalizePrNumber(input.structured?.pr);
  if (fromStruct) {
    const resolved: { pr: string; url?: string } = { pr: fromStruct };
    if (typeof input.structured?.url === "string" && input.structured.url.trim()) {
      resolved.url = input.structured.url.trim();
    }
    return resolved;
  }
  return parseOpenedPr(input.summary ?? "") || parseOpenedPr(input.handoff ?? "");
}

/** Current-branch PR already on GitHub. One-shot; the waiter still owns merge. */
export async function discoverBranchPr(
  pi: ExtensionAPI,
  worktree: string,
): Promise<{ pr: string; url?: string } | undefined> {
  try {
    const result = await pi.exec("gh", ["pr", "view", "--json", "number,url"], {
      cwd: worktree,
      timeout: 15000,
    });
    if (result.code !== 0) return undefined;
    const json = JSON.parse(String(result.stdout ?? "")) as { number?: unknown; url?: unknown };
    const pr = normalizePrNumber(json.number) || normalizePrNumber(json.url);
    if (!pr) return undefined;
    return {
      pr,
      url: typeof json.url === "string" ? json.url : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * The repo's default branch. `--base main` was hard-coded, which is simply
 * wrong in any repo that calls it something else.
 *
 * Falls back to `main` rather than refusing: an unreachable `gh` is not a
 * reason to withhold a PR that would otherwise open fine.
 */
export async function defaultBaseBranch(pi: ExtensionAPI, worktree: string): Promise<string> {
  try {
    const r = await pi.exec("gh", ["repo", "view", "--json", "defaultBranchRef"], {
      cwd: worktree,
      timeout: 30_000,
    });
    if (r.code !== 0) return "main";
    const json = JSON.parse(String(r.stdout ?? "")) as { defaultBranchRef?: { name?: unknown } };
    const name = json.defaultBranchRef?.name;
    return typeof name === "string" && name.trim() ? name.trim() : "main";
  } catch {
    return "main";
  }
}

/**
 * The public PR body: the plan's `## Context` plus the Task titles.
 *
 * `--body-file plan.md` posted the whole plan — `/Users/greg/orchestrator/…`
 * paths, `> Worker:` model routing, gate commands — as the public body of a
 * PR on someone else's repo (F10). Reviewers need what changed and why; none
 * of the rest is theirs to read.
 */
export function featurePrBody(plan: string, title: string): string {
  // Not a single regex: JS has no `\Z`, so "up to the next H2 or the end of
  // the plan" is a slice, and a Context that is the last section still lands.
  const start = plan.search(/^##\s+Context\s*$/m);
  let context = "";
  if (start >= 0) {
    const rest = plan.slice(start).replace(/^.*\n?/, "");
    const end = rest.search(/^##\s/m);
    context = (end >= 0 ? rest.slice(0, end) : rest).trim();
  }
  const tasks = parseTasks(plan).map((t) => `- Task ${t.id} — ${t.title}`);
  return [
    context || title.trim(),
    ...(tasks.length ? ["", "## Tasks", "", ...tasks] : []),
  ]
    .join("\n")
    .trim();
}

/**
 * Push the branch and open one non-draft Feature PR. Writers never do this.
 *
 * Pre-flighted, because `gh pr create` on a branch with no commits fails with
 * "No commits between …" and the old code discarded that stderr and reported
 * "no PR number returned" — which is how `quiesce-identical-current-state`
 * parked in `phase: pr` with nothing anyone could act on (F10).
 *
 * A check git cannot answer never blocks: an unreadable `status` or `rev-list`
 * falls through to `gh pr create`, whose own error is now surfaced verbatim.
 */
export async function openFeaturePr(
  pi: ExtensionAPI,
  worktree: string,
  input: { title: string; body?: string; base?: string },
): Promise<{ pr?: string; url?: string; reason?: string } | undefined> {
  // `pr` is optional because every pre-flight refusal returns a `reason` and no
  // PR — that is the whole point of F10's pre-flight. The caller reads
  // `opened?.pr ?? ""` and branches on the empty string.
  const title = input.title.trim();
  if (!title) return { reason: "missing PR title" };
  const base = input.base?.trim() || (await defaultBaseBranch(pi, worktree));

  const git = async (args: string[], timeout = 30_000) => {
    try {
      return await pi.exec("git", args, { cwd: worktree, timeout });
    } catch (error) {
      return {
        code: 1,
        stdout: "",
        stderr: String((error as { message?: string })?.message ?? error),
      };
    }
  };

  // 1. Nothing uncommitted. A writer that edited and did not commit produces a
  // PR that is missing the work it was opened for (F11).
  const porcelain = await git(["status", "--porcelain"]);
  if (porcelain.code === 0 && String(porcelain.stdout ?? "").trim()) {
    const files = String(porcelain.stdout).trim().split("\n").slice(0, 8).join("; ");
    return { reason: `uncommitted changes in ${worktree}: ${files}` };
  }

  // 2. Something to review. `origin/<base>` is refreshed first, or the count
  // is measured against whatever the last fetch left behind.
  await git(["fetch", "origin", base], 120_000);
  const ahead = await git(["rev-list", "--count", `origin/${base}..HEAD`]);
  if (ahead.code === 0 && Number.parseInt(String(ahead.stdout ?? "").trim(), 10) === 0) {
    // A branch that is level with base may still already have a PR.
    const existing = await discoverBranchPr(pi, worktree);
    if (existing) return existing;
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout?.trim() || "HEAD";
    return {
      reason:
        `no commits on ${branch} ahead of origin/${base} — nothing to review ` +
        `(did the writers commit?)`,
    };
  }

  const pushed = await git(["push", "-u", "origin", "HEAD"], 120_000);
  if (pushed.code !== 0) {
    const existing = await discoverBranchPr(pi, worktree);
    if (existing) return existing;
    const why = `${String(pushed.stderr ?? "").trim() || String(pushed.stdout ?? "").trim()}`;
    return { reason: `git push failed: ${why.slice(-600) || `exit ${pushed.code}`}` };
  }

  const args = [
    "pr",
    "create",
    "--title",
    title,
    "--base",
    base,
    "--body",
    (input.body ?? title).trim() || title,
  ];
  let createError = "";
  try {
    const created = await pi.exec("gh", args, { cwd: worktree, timeout: 60_000 });
    const parsed = parseOpenedPr(`${created.stdout ?? ""}\n${created.stderr ?? ""}`);
    if (parsed) return parsed;
    if (created.code !== 0) {
      createError = `${String(created.stderr ?? "").trim() || String(created.stdout ?? "").trim()}`;
    }
  } catch (error) {
    createError = String((error as { message?: string })?.message ?? error);
  }

  const existing = await discoverBranchPr(pi, worktree);
  if (existing) return existing;
  return {
    reason: createError
      ? `gh pr create failed: ${createError.slice(-600)}`
      : "no PR number returned",
  };
}

/** Open one Feature PR in code (`gh pr create`), then drive `git pr-await`. */
async function landFeaturePr(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  paths: Paths,
  name: string,
  worktree: string,
): Promise<void> {
  let pr = normalizePrNumber(statusField(readText(paths.statusFile), "pr"));
  let url: string | undefined;

  // Resume / a previous open that did not record the number: branch is source of truth.
  if (!pr) {
    const existing = await discoverBranchPr(pi, worktree);
    if (existing) {
      pr = existing.pr;
      url = existing.url;
    }
  }

  if (!pr) {
    upsertStatusFile(paths, { phase: "pr", nextAction: "opening one Feature PR" });
    uiNotify(ctx, `All Tasks done on ${name}. Opening one Feature PR from ${worktree}…`, "info");

    const plan = readText(paths.planFile);
    const title = featureTitle(plan, name);
    const opened = await openFeaturePr(pi, worktree, {
      title,
      body: featurePrBody(plan, title),
    });
    pr = opened?.pr ?? "";
    url = opened?.url ?? url;
    if (!pr) {
      // Verbatim, and on disk: "Feature PR not on the branch" told nobody
      // whether the branch was empty, the push was rejected, or gh was down.
      const why = opened?.reason ?? "no PR number returned";
      upsertStatusFile(paths, {
        phase: "pr",
        nextAction: `Feature PR not opened — ${why.replace(/\s+/g, " ").slice(0, 300)}`,
      });
      uiNotify(ctx, `Could not open the Feature PR.\n${why}`, "error");
      return;
    }
  }

  upsertStatusFile(paths, { pr, nextAction: `pr-await ${pr}` });
  uiNotify(
    ctx,
    `PR ${pr}${url ? ` — ${url}` : ""} is open. Handing to ghl-pr-await (event-driven, 0 tokens).`,
    "info",
  );

  const result = await drivePrAwait(pi, ctx, paths, pr, worktree);
  if (result.done) {
    uiNotify(ctx, `PR ${pr} landed (next=done). Feature ${name} complete.`, "info");
    return;
  }
  // A pause is the user's decision, not a state needing judgment. Handing it
  // to the model would restart the very poll they just stopped.
  if (result.paused) {
    uiNotify(ctx, 
      `Paused with PR ${pr} still open on ${name}.\n/orchestrate resume to run git pr-await once.`,
      "info",
    );
    return;
  }
  if (result.silent || result.next === "yield") {
    uiNotify(ctx, 
      result.done
        ? `PR ${pr} landed without a model turn.`
        : `PR ${pr} is with ghl-pr-await (0 tokens). Not handing to the session.`,
      "info",
    );
    return;
  }
  // A judgment verdict is dispatched, not handed to this session: the parent
  // does not implement, and the writer it spawns does not wait on the review.
  await dispatchFeaturePrVerdict(pi, ctx, paths, pr, worktree, result, {
    holdsChainLock: true,
  });
}

export function gitWorkflowBlock(paths: Paths, worktree?: string): string {
  const farm = worktreeFarmFor(paths.repo);
  const wt = worktree || `(status.md worktree — must be under ${basename(farm)})`;
  const refNote = isReferenceCheckout(paths.gitRoot)
    ? `${paths.gitRoot} is a **reference checkout** (read-only). Do not use it as cwd.`
    : `${paths.gitRoot} may be used only to run \`git wt\`; product work still happens in ${basename(farm)}.`;
  return `## Feature git-workflow — role split

Canonical skill: ${GIT_WORKFLOW_SKILL}
Cite that path. Do not paste wt/await/land steps into a handoff.

**Worktree:** REQUIRED cwd \`${wt}\` under \`${farm}/\` or another \`~/Dev/git/*-wt/\` farm. Never a reference checkout. ${refNote}
Parent already ran \`git wt <branch>\` (or reused the farm). Do **not** \`git wt\` again. If \`${wt}\` is missing or is a reference checkout: **STOP**. Do not implement in ${paths.gitRoot}.
tdd-worker and fixer must NOT \`git wt\`, must NOT open a PR, must NOT \`git pr-await\`.

**After Tasks + QA cap:** code runs \`gh pr create\` (not a tdd-worker) and \`git pr-await\` once. A judgment \`next=\` on this Feature's PR (\`read_comments_and_fix\`, \`investigate_dead_reviewers\`, \`fix_command_or_environment\`) is then dispatched by this extension, not by you: a review fix spawns one \`fixer\` in the Feature worktree, and code runs \`git pr-await\` once after that writer settles. A later undelivered \`read_comments_and_fix\` spawns another fixer — code keeps doing that until the waiter lands or the user merges. Never stop while review data still says there are current-head findings to fix. The parent session stays idle — it does not repair review findings and does not run \`git pr-await\` itself. Never \`gh pr merge\`. Never \`git worktree add\`. Never pipe/timeout/--once on \`git pr-await\`.
One Feature = one worktree = one branch = one PR. Never a draft. Never a PR per Task. If a Task is blocked, stop.
`;
}

/** Phases in which a Feature actually owns a writer and a branch. */
const IDLE_PARENT_PHASES = new Set(["implementing", "feature-qa", "pr"]);

function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/**
 * Is *this* cwd inside a Feature that currently owns a writer?
 *
 * Two bugs lived in the old predicate. Its regex `^(implement|pr|qa)$` never
 * matched the phases actually written to status.md — `implementing` and
 * `feature-qa` — so it was under-inclusive on the states that matter. And it
 * asked only "does this repo have such a Feature?", so four Features stuck in
 * `phase: pr` behind PRs that had merged days earlier appended `FORBIDDEN` and
 * "stay idle" to the system prompt of every pi session in icemining (F8).
 *
 * The question that is actually worth answering is narrower: is the session
 * sitting in the directory that Feature's writer is working in? A Feature
 * writing in `ice-wt/feat-foo` has no claim on someone working in the
 * reference checkout. A Feature that has not been given a worktree yet — host
 * Features, anything before `git wt` — can only be working in the repo root,
 * so that is the one cwd it may still claim.
 *
 * `root` is injectable so tests never walk the live `~/orchestrator`.
 */
export function liveFeatureNeedsIdleParent(cwd: string, root?: string): boolean {
  if (!cwd) return false;
  // `repoKey` is the one that resolves a worktree farm (`ice-wt/feat-foo` →
  // `icemining`); `guessRepoFromCwd` deliberately returns "" for a farm, which
  // would make this predicate blind in exactly the directory a writer uses.
  const repo = repoKey(cwd) || guessRepoFromCwd(cwd) || repoNameFromGitRoot(cwd) || "";
  if (!repo) return false;
  const repoDir = join(root ?? ORCH_ROOT, repo);
  const paths: Paths = {
    repo,
    gitRoot: cwd,
    repoDir,
    featureDir: "",
    planFile: "",
    statusFile: "",
    handoffsDir: "",
    archiveDir: join(repoDir, "archive"),
  };
  const gitRoot = join(REF_ROOT, repo);
  return discoverFeatures(paths).some((row) => {
    if (!row.live) return false;
    const phase = (statusField(row.status, "phase") || "").toLowerCase();
    if (!IDLE_PARENT_PHASES.has(phase)) return false;
    const worktree = statusField(row.status, "worktree");
    if (worktree && !isPendingToken(worktree)) return samePath(cwd, worktree);
    // No worktree recorded: the repo root is the only place it can be working.
    return samePath(cwd, gitRoot);
  });
}

export function liveFeaturePlanReviewRunning(cwd: string, root?: string): boolean {
  if (!cwd) return false;
  const repo = repoKey(cwd) || guessRepoFromCwd(cwd) || repoNameFromGitRoot(cwd) || "";
  if (!repo) return false;
  const repoDir = join(root ?? ORCH_ROOT, repo);
  const paths: Paths = {
    repo,
    gitRoot: cwd,
    repoDir,
    featureDir: "",
    planFile: "",
    statusFile: "",
    handoffsDir: "",
    archiveDir: join(repoDir, "archive"),
  };
  const gitRoot = join(REF_ROOT, repo);
  return discoverFeatures(paths).some((row) => {
    if (!row.live) return false;
    if (planReviewState(row.status) !== "running") return false;
    const worktree = statusField(row.status, "worktree");
    if (worktree && !isPendingToken(worktree)) return samePath(cwd, worktree);
    return samePath(cwd, gitRoot);
  });
}

export function liveFeatureTaskChain(cwd: string, root?: string): boolean {
  if (!cwd) return false;
  const repo = repoKey(cwd) || guessRepoFromCwd(cwd) || repoNameFromGitRoot(cwd) || "";
  if (!repo) return false;
  const repoDir = join(root ?? ORCH_ROOT, repo);
  const paths: Paths = {
    repo,
    gitRoot: cwd,
    repoDir,
    featureDir: "",
    planFile: "",
    statusFile: "",
    handoffsDir: "",
    archiveDir: join(repoDir, "archive"),
  };
  const gitRoot = join(REF_ROOT, repo);
  return discoverFeatures(paths).some((row) => {
    if (!row.live) return false;
    const phase = (statusField(row.status, "phase") || "").toLowerCase();
    if (phase !== "implementing" && phase !== "feature-qa") return false;
    const worktree = statusField(row.status, "worktree");
    if (worktree && !isPendingToken(worktree) && samePath(cwd, worktree)) return true;
    return samePath(cwd, gitRoot);
  });
}

/**
 * Forced into the parent system prompt. The Feature-parent branch inlines the
 * git-workflow skill: skills are progressive-disclosure and models skip the
 * read (git-workflow-guard.ts documents that), so citing the path is not
 * enough — this block is the skill, for the sessions that need it. The solo
 * latch-wake branch deliberately does not cite the skill at all (L5): after
 * `git pr-await` prints `next=yield` the parent just stops, because code
 * injects the next user message. No "I will not talk until" promise, and no
 * dependency on the git-workflow skill, covers that wake.
 */
export function parentGitWorkflowAppend(input: {
  featureLive?: boolean;
  latchWake?: boolean;
  planReviewRunning?: boolean;
  taskChain?: boolean;
}): string | undefined {
  if (!input.featureLive && !input.latchWake && !input.planReviewRunning && !input.taskChain) {
    return undefined;
  }
  const parts: string[] = [];
  if (input.featureLive) {
    parts.push(
      `git-workflow is not optional progressive disclosure. Read ${GIT_WORKFLOW_SKILL} with the read tool before any worktree, PR, review-fix, or merge work. The skills-list description is not the skill.`,
    );
  }
  if (input.latchWake) {
    parts.push(
      "After git pr-await prints next=yield, stop talking; code injects the next user message.",
    );
  }
  if (input.featureLive) {
    parts.push(FORBIDDEN);
    parts.push(
      "A live /orchestrate Feature owns PR work in this session. Stay idle: do not implement product code, do not repair review findings, do not run git pr-await. Code dispatches one fixer per current-head verdict and keeps dispatching while review data still says read_comments_and_fix.",
    );
  }
  if (input.planReviewRunning) {
    parts.push(
      "plan-reviewer is still running. Stay quiet. Do NOT summarize the plan as a Task table, todo list, or slice board. Do NOT suggest or run /orchestrate approve. One short line is enough: plan-reviewer is running; wait.",
    );
  }
  if (input.taskChain) {
    parts.push(
      "A Feature is running Tasks in this repo. After each tdd-worker or feature-qa child completes, show the current todo list immediately (done/now/pending). Do not wait until all Tasks are done to show progress. Do not spawn tdd-worker; the extension does.",
    );
  }
  return parts.join("\n\n");
}

export function plannerLaunchParams(paths: Paths, objective: string): Record<string, unknown> {
  return {
    agent: "planner",
    task: plannerBody(paths, objective),
    context: "fresh",
    model: PLANNER_MODEL,
    output: join(paths.handoffsDir, "plan-run.md"),
    outputMode: "inline",
    timeoutMs: CHILD_TIMEOUT_MS,
    turnBudget: PLANNER_TURN_BUDGET,
  };
}

function plannerBody(paths: Paths, objective: string): string {
  return `You are \`planner\` on xai/grok-4.6 thinking high. Do NOT implement product code.
Do NOT write plan files inside the git worktree. Do NOT use enter_plan_mode.

Objective:
${objective}

Durable location (mandatory):
- ${paths.planFile}
- ${paths.statusFile}
- ${paths.handoffsDir}/

This is one **Feature** (one branch, one PR) made of sequential **Tasks** (tdd-worker slices). 4–5 Tasks is typical; never more than ${MAX_TASKS}.

The \`# Feature:\` title must be short and concrete (3–6 words). It becomes the unique Name and \`feat/<name>\` branch **after** you write the plan. Do **not** slug this objective. Leave \`> Name: pending\` and \`> Branch: pending\`.

Every Task needs \`- Complexity: simple|critical\` **and** a matching \`- Worker: <model>, thinking <level>\` line so the plan and \`/todos\` show what will run.
- **Most Tasks are simple** → \`Worker: ${WORKERS.simple.model}, thinking ${WORKERS.simple.thinking}\`
- **critical** only when extra risk is identified (be extra careful) → \`Worker: ${WORKERS.critical.model}, thinking ${WORKERS.critical.thinking}\`
Do **not** derive Complexity from keyword lists or file counts.

\`- Command:\` is executed on the host as this Task's red/green gate, so write it
as **one single-line fenced command and nothing else** — no prose, no "then:",
no "(red → green)" annotation, no second command in the same line. Caveats,
platform notes, and multi-step recipes belong in \`- Implement:\` or \`- Red test:\`.
A Task with no single runnable command must leave \`- Command:\` empty; it then
falls back to evidence-based acceptance instead of running your sentence in a shell.
Examples of **simple**: add match arms + tests, TTL constants, inspector strings, pin a dep, rename, fixture.
Examples of **critical**: money/accounting/payouts, auth/secrets, TOCTOU/races, hot-path/zero-alloc, wire/schema, hard to unwind.

After each phase, append a few lines to ${paths.handoffsDir}/plan-progress.md so a human can tail progress. Write the real \`# Feature:\` title into plan.md as soon as you know it; do not leave the file as \`(planning)\` until the very end.

### Phase 1 — Spec & Context Discovery
Read every spec referenced in AGENTS.md that is relevant. Cite anchors; do not paste specs.
Read adjacent code. Identify reuse vs new. Planning may read a reference checkout; do not edit it.

### Phase 2 — Clarification
Use \`contact_supervisor\` (need_decision) until scope, contracts, and acceptance are clear. If already unambiguous, proceed.

### Phase 3 — Deep Analysis
Architecture fit, impact/blast radius, correctness/invariants, security, performance, failure & concurrency.

### Phase 4 — Tasks for one fresh \`tdd-worker\` (${WORKERS.simple.short}; ${WORKERS.critical.short} when critical)
A Task is too big if: more than 10 named files to read; two ownership seams; contract > ~150 lines; you cannot name the exact files and the exact failing test; red+green cannot be one focused test command.
Sequential Tasks share **one** feature worktree (one writer). No per-Task PR.
Each Task **must** be an H3 heading \`### Task N — title\` (em dash) or \`### Task N: title\` (colon). A numbered list under \`## Tasks\` is invisible to \`/orchestrate approve\`.

### Phase 5 — Write the living Feature plan + status
Overwrite ${paths.planFile}:

\`\`\`markdown
# Feature: [short 3–6 word title]

> Status: DRAFT — awaiting approval
> Name: pending
> Branch: pending
> Repo: ${paths.repo}
> Path: ${paths.planFile}

## Context
[1–2 paragraphs; spec anchors only]

## Architecture fit
- Current seam
- Where this change sits
- Pattern extended vs new
- What must not move

## Impact
- Consumers / blast radius
- API-ABI / wire / schema
- Tests that must change
- Specs/invariants touched (IDs)

## Tasks

### Task 1 — [title]
- Status: pending
- Complexity: simple | critical
- Worker: ${WORKERS.simple.model}, thinking ${WORKERS.simple.thinking}   # or ${WORKERS.critical.short} if critical
- Goal: [one sentence]
- Read: [\`file\`, \`file\`]
- Do not read: [...]
- Red test: [\`path::test\` proving X including rejection]
- Repo: ${paths.repo}   # or icemining-devops / coins-minimal when this Task is not the Feature worktree
- Command: \`rtk cargo test -p crate --lib the_test\`
- Implement: [smallest change]
- Invariants: […]
- Out of task: […]
- Handoff: (orchestrator fills)

## Design Decisions
| Decision | Choice | Rationale |

## Risks & Mitigations
| Risk | Impact | Mitigation |

## Out of Scope
- […]
\`\`\`

Also overwrite ${paths.statusFile} with repo/plan/feature, name: pending, branch: pending, phase: planning, active_task: none, worktree: none, pr: none, next_action: wait for named approve after # Feature: title exists, and a Tasks table.

TDD: every Task is preceded by a described failing test; prove correctness and rejection; cite spec anchors.
Present ${paths.planFile}. Stop. Do not implement.
The next human step is \`/orchestrate approve <kebab-of-# Feature: title>\` — always the specific name, never a bare \`/orchestrate approve\`.
`;
}

export function reviewLaunchParams(
  paths: Paths,
  cwd: string,
  featureName: string,
): Record<string, unknown> {
  return {
    agent: "plan-reviewer",
    task: [
      `Review ${paths.planFile} against the real code and specs for Feature ${featureName}.`,
      `Apply high-confidence corrections to that plan.md now (wrong files, missing red tests, oversized Tasks, broken invariants, stale title).`,
      `Do not implement product code. Do not edit anything outside ${dirname(paths.planFile)}.`,
      `Low-confidence / product decisions: contact_supervisor or an Open questions section — do not guess.`,
    ].join("\n"),
    context: "fresh",
    cwd,
    model: qaModelFor("plan-reviewer"),
    output: join(paths.handoffsDir, "plan-review.md"),
    outputMode: "inline",
    timeoutMs: CHILD_TIMEOUT_MS,
    turnBudget: QA_TURN_BUDGET,
  };
}

/**
 * Await plan-reviewer. Never returns until that child settles. Callers must
 * hold the Feature chain lock so approve cannot start a writer in parallel.
 */
async function reviewPlan(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  paths: Paths,
  featureName: string,
): Promise<boolean> {
  const branch =
    statusField(readText(paths.statusFile), "branch") ||
    planHeaderField(readText(paths.planFile), "Branch");
  const existingWt =
    (!isPendingToken(branch) &&
      (await findExistingWorktree(pi, paths.gitRoot, branch))) ||
    "";
  const cwd =
    existingWt && isAllowedWorktreePath(existingWt, paths.repo)
      ? existingWt
      : paths.gitRoot;
  mkdirSync(paths.handoffsDir, { recursive: true });
  upsertStatusFile(paths, {
    phase: "reviewing",
    planReview: "running",
    reviewerRunId: "none",
    reviewerRunDir: "none",
    nextAction: `plan-reviewer (xai/grok-4.6 high); wait to finish before Tasks`,
  });
  uiNotify(
    ctx,
    `Review ${featureName} (xai/grok-4.6 high) — high-confidence plan edits only\nread cwd ${cwd}`,
    "info",
  );
  const review = await runChildInPhase(
    pi,
    ctx,
    "review",
    reviewLaunchParams(paths, cwd, featureName),
    // Recorded so a reviewer that dies with its session can be settled from
    // its own on-disk lifecycle file instead of wedging the Feature (F14).
    (runId) => upsertStatusFile(paths, { reviewerRunId: runId, reviewerRunDir: asyncRunDir(runId) }),
  );
  if (!review.ok) {
    upsertStatusFile(paths, {
      phase: "reviewing",
      planReview: "failed",
      reviewerRunId: "none",
      reviewerRunDir: "none",
      nextAction: `/orchestrate review ${featureName}`,
    });
    uiNotify(
      ctx,
      `plan-reviewer did not complete (${review.reason ?? review.state ?? "failed"}).`,
      "error",
    );
    return false;
  }
  upsertStatusFile(paths, {
    phase: "reviewing",
    planReview: "done",
    reviewerRunId: "none",
    reviewerRunDir: "none",
    nextAction: `wait for /orchestrate approve ${featureName}`,
  });
  return true;
}

/**
 * Settle a `plan_review: running` left behind by a session that is gone.
 *
 * Returns false when the reviewer is genuinely still alive and the caller must
 * not proceed. Called under the chain lock, before anything consults
 * `needsPlanReview` or `writerBlockedByPlanReview` (F14).
 */
export function reconcilePlanReview(ctx: ExtensionCommandContext, paths: Paths): boolean {
  const status = readText(paths.statusFile);
  const state = planReviewState(status);
  const recordedDir = statusField(status, "reviewer_run_dir");
  const runId = statusField(status, "reviewer_run_id");
  const dir = !isPendingToken(recordedDir)
    ? recordedDir
    : isPendingToken(runId)
      ? ""
      : asyncRunDir(runId);
  const decision = planReviewReconcile(state, readRunSnapshot(dir));

  if (decision === "keep") return true;
  if (decision === "wait") {
    uiNotify(
      ctx,
      `plan-reviewer is still running from an earlier session (run ${runId.slice(0, 8)}).\n` +
        `Not starting writers over it.`,
      "warning",
    );
    return false;
  }
  if (decision === "done") {
    upsertStatusFile(paths, {
      planReview: "done",
      reviewerRunId: "none",
      reviewerRunDir: "none",
    });
    uiNotify(ctx, `plan-reviewer from an earlier session finished; plan review recorded done.`, "info");
    return true;
  }
  upsertStatusFile(paths, {
    planReview: "failed",
    reviewerRunId: "none",
    reviewerRunDir: "none",
  });
  uiNotify(
    ctx,
    `plan-reviewer from an earlier session is gone without finishing. Plan review reset — it re-runs now.`,
    "warning",
  );
  return true;
}

async function beginImplementation(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  paths: Paths,
  wanted?: string,
  opts: { approve?: boolean } = {},
): Promise<void> {
  const plan = readText(paths.planFile);
  if (!plan.trim()) {
    uiNotify(ctx,
      `No Feature at ${paths.planFile}. /orchestrate <objective> first.`,
      "error",
    );
    return;
  }
  if (!opts.approve && isDraft(plan) && !isApproved(plan)) {
    uiNotify(ctx, 
      `Feature is still DRAFT.\n${paths.planFile}\nRun /orchestrate approve ${basename(paths.featureDir)} first.`,
      "warning",
    );
    return;
  }
  const named = ensureFeatureNamed(paths, plan);
  if (isPendingToken(named.name) || isPendingToken(named.branch)) {
    uiNotify(ctx, 
      `Name/Branch still pending. Need a real # Feature: title in ${paths.planFile}`,
      "error",
    );
    return;
  }
  // The TUI fires a slash command without awaiting the previous one, so a
  // second `approve`/`resume`/`qa` would start a second chain over the same
  // plan.md and the same single-writer worktree. The lock is taken here —
  // after the Feature has its final folder, before anything writes to it — so
  // that a refusal leaves no trace: no `git wt`, no status.md, and above all
  // no `implement <task>` re-opening a Task that the live chain would re-run.
  const ran = await withChainLock(paths.featureDir, async () => {
    const worktree = await ensureFeatureWorktree(pi, ctx, paths, named.branch);
    if (!worktree) return;
    const tasks = parseTasks(named.plan);
    if (tasks.length === 0) {
      const sample = named.plan.match(/^#{2,4}\s+(?:Task|Slice)\b.*$/m)?.[0];
      uiNotify(ctx, 
        sample
          ? `No Tasks found in ${paths.planFile}\nSaw: ${sample}\nNeed: ### Task N — title  (em dash, hyphen, or colon after the number)`
          : `No Tasks found in ${paths.planFile}`,
        "error",
      );
      return;
    }
    const tooMany = taskCountError(tasks.length);
    if (tooMany) {
      uiNotify(ctx, tooMany, "error");
      return;
    }
    // F16: APPROVED is written last, once nothing left can refuse — the
    // worktree exists and the plan has a workable Task list. Written first, a
    // failed approve left the plan APPROVED with nothing running: `isDraft` is
    // then false, the card is never re-offered, and `defaultFeature('approve')`
    // stops finding the Feature at all.
    if (opts.approve) {
      writeText(paths.planFile, markPlanApproved(readText(paths.planFile)));
      uiNotify(
        ctx,
        `Approved ${named.name} (${named.branch})\nStarting Tasks → Feature PR via git-workflow`,
        "info",
      );
    }
    upsertStatusFile(paths, {
      feature: featureTitle(named.plan, paths.repo),
      name: named.name,
      branch: named.branch,
      worktree,
      tasks,
    });

    // An explicit `/orchestrate implement <task>` re-opens one Task, then the
    // chain carries on from there like any other run.
    if (wanted) {
      const target = tasks.find(
        (s) => s.id === wanted || s.title.toLowerCase().includes(wanted.toLowerCase()),
      );
      if (!target) {
        uiNotify(ctx, `No Task matching "${wanted}" on ${named.name}`, "error");
        return;
      }
      if (target.status === "done" || target.status === "blocked") {
        writeText(
          paths.planFile,
          setTaskStatusInPlan(readText(paths.planFile), target.id, "pending"),
        );
      }
    }

    // A reviewer recorded `running` may belong to a session that no longer
    // exists. Settle that from its own run artifact first, so the two checks
    // below see the truth rather than a stale field (F14).
    if (!reconcilePlanReview(ctx, paths)) return;

    // Deterministic: never start tdd-worker until plan-reviewer has settled.
    // If the user approved during review, wait here (run it) instead of overlapping.
    if (needsPlanReview(readText(paths.planFile), readText(paths.statusFile))) {
      uiNotify(ctx, `Plan review is required before Tasks. Running plan-reviewer first…`, "info");
      const ok = await reviewPlan(pi, ctx, paths, named.name);
      if (!ok) return;
    }
    const stillBlocked = writerBlockedByPlanReview(readText(paths.statusFile));
    if (stillBlocked) {
      uiNotify(ctx, stillBlocked, "error");
      return;
    }

    try {
      await runFeatureChain(pi, ctx, paths, named.name, worktree);
    } catch (error) {
      upsertStatusFile(paths, {
        phase: "blocked",
        workerRunId: "none",
        nextAction: "chain error — /orchestrate resume",
      });
      uiNotify(ctx, `Feature chain stopped: ${String(error)}`, "error");
    }
  });

  if (!ran) {
    uiNotify(ctx, 
      `A chain is already running on ${named.name}.\n` +
        `/orchestrate status to watch it, /orchestrate pause to stop after the current Task.`,
      "warning",
    );
  }
}

function helpText(paths?: Paths): string {
  const loc = paths
    ? `\nRepo Features: ${paths.repoDir}/<name>/`
    : `\nPlans live at ~/orchestrator/<repo>/<name>/plan.md (pending-<utc>/ while untitled)`;
  return `Orchestrator — Feature (one PR) → Tasks (tdd-workers). Not pi-xai /plan.
Name/folder/branch assigned from \`# Feature:\` after the planner writes it — never from the objective. No current/ pointer.
${loc}

/orchestrate <objective>     planner → plan-reviewer → wait for approve
/orchestrate plan <objective>  same, explicitly — use it when the objective
                             itself opens with a verb below ("implement …")
/orchestrate approve [name]  last user step after plan-reviewer: git wt, Tasks, Feature PR
                             (omit name when exactly one Feature is waiting for approve;
                             otherwise /orchestrate approve <that-feature>)
/orchestrate pause           finish current Task, do not start the next
/orchestrate pause now       also stop the running child immediately
/orchestrate resume          unpause + continue auto loop
/orchestrate status          all Features, Tasks, PRs
/orchestrate review [feature]  xai/grok-4.6 high plan review; high-confidence plan edits
/orchestrate qa [feature]      end QA: qa-opus xai/grok-4.6 high (auto feature-qa is xai/grok-4.6 high after Tasks 1..N)
/orchestrate implement [feature] [task]   escape hatch: re-open one Task
/orchestrate pr [feature]                 escape hatch: land the Feature PR

Tasks, feature-qa, and one git pr-await run in this extension, not as model
instructions. A Task's "- Command:" becomes a host-run gate when it is written
as a single fenced command, so green is verified rather than reported; prose
falls back to evidence-based acceptance instead of being run by the shell.
git pr-await daemonizes; next=yield is silent. A judgment next= on a Feature PR
is dispatched in code — one fixer applies it, then code re-awaits once — so
the session is never asked to implement; pr_round counts those fix writers.
One chain per Feature: a second approve/resume while one is running is refused.
autoAdvanceOnLanded (orchestrate.json, default true): harness fail + landed
work → next Task. Override per Feature with auto_advance_on_landed in status.md.
qaModel (orchestrate.json) is the ONE place the reviewer model is set — it
drives feature-qa, qa-opus, and plan-reviewer launches and the spawn-policy
pin alike. Changing it also needs modelScope.agents.* in settings.json.
Approve/resume/implement first settle a Task an earlier (now dead) session
left in_progress: its run's own status.json plus git evidence decide done /
re-run / blocked, and a worker that is still live is waited on, never doubled.

Overlay: rpiv-todo /todos mirrors planner → plan-reviewer → Tasks → feature-qa.
Approve is a TUI card after plan-reviewer finishes, not a fence. Tasks never overlap review.`;
}

export default function orchestrateExtension(pi: ExtensionAPI): void {
  overlayPi = pi;
  void loadCapabilityCeiling();
  void bindRpivTodoOverlaySink(pi);
  let lastCtx: ExtensionContext | undefined;
  setChainReleaseHook((featureDir) => {
    // Only when something is actually queued: a chain that ended cleanly must
    // not trigger a `gh pr view` for every Feature in the fleet.
    const statusFile = join(featureDir, "status.md");
    const pending = statusField(readText(statusFile), "pending_verdict");
    if (!pending || isPendingToken(pending)) return;
    if (!lastCtx) return;
    void reconcileLiveFeaturePrs(pi, lastCtx);
  });
  const republishOverlay = () => {
    queueMicrotask(() => {
      void bindRpivTodoOverlaySink(pi).then(() => syncLiveFeatureOverlay());
    });
  };
  // One handler per event: `pi.on` is not documented to chain, and a second
  // registration that silently replaced the overlay republish would be a very
  // quiet bug.
  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    bindOverlayFromCommand(ctx);
    republishOverlay();
    // The durable half of the PR phase. A session starting anywhere is enough
    // to notice a merged PR, or a verdict the session that opened the PR never
    // lived to see (F1, F8).
    void reconcileLiveFeaturePrs(pi, ctx);
    armReconcileTimer(pi, ctx);
  });
  pi.on("session_compact", republishOverlay);
  pi.on("session_tree", republishOverlay);
  // F17 proposed deleting this along with `before_agent_start`. It stays, for a
  // reason worth writing down: `~/.pi/agent/settings.json` registers only
  // `skill-author`, so this line is the *only* thing that publishes
  // git-workflow to a pi session at all. Removing it would not stop the skill
  // leaking into orchestration — it would make it unavailable to the solo
  // sessions the skill was just rescoped for. What it publishes is a path, not
  // prompt text, and the `/orchestrate` section that made that path a policy
  // document is gone.
  pi.on("resources_discover", async () => ({
    skillPaths: [dirname(GIT_WORKFLOW_SKILL)],
  }));
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd =
      (typeof event.systemPromptOptions?.cwd === "string" && event.systemPromptOptions.cwd) ||
      (typeof (ctx as { cwd?: string }).cwd === "string" && (ctx as { cwd?: string }).cwd) ||
      process.cwd();
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    const extra = parentGitWorkflowAppend({
      featureLive: liveFeatureNeedsIdleParent(cwd),
      latchWake: /pr-latch:|read_comments_and_fix/.test(prompt),
      planReviewRunning: liveFeaturePlanReviewRunning(cwd),
      taskChain: liveFeatureTaskChain(cwd),
    });
    if (!extra) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
  });

  pi.registerEntryRenderer<ApproveCardData>(APPROVE_ENTRY, (entry, options, theme) =>
    // pi's `Theme` carries more than the card uses; `ApproveTheme` is the three
    // functions it actually calls, so the renderer stays testable with a stub.
    renderApproveEntry(entry, options, theme as unknown as ApproveTheme),
  );
  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (messageType !== "assistant") return markdown;
    return stripApproveFences(markdown).markdown;
  });
  pi.on("agent_settled", async (_event, ctx) => {
    try {
      presentDraftApproveCards(pi, ctx, await resolvePaths(pi, ctx));
    } catch {
      /* approve card is best-effort */
    }
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "enter_plan_mode") {
      return {
        block: true as const,
        reason:
          "enter_plan_mode writes .pi/plan.md (wrong file; writes are blocked). " +
          "Use /orchestrate <objective> — Feature plan at ~/orchestrator/<repo>/<name>/plan.md after the title exists.",
      };
    }
    const blocked = subagentToolGuard(event);
    if (blocked) return blocked;
  });

  pi.registerCommand("orchestrate", {
    description:
      "approve [name] — git wt, Tasks, one Feature PR (name required when >1 Feature is waiting for approve)",
    getArgumentCompletions(prefix) {
      return orchestrateArgumentCompletions(prefix);
    },
    async handler(args, ctx) {
      const raw = (args ?? "").trim();
      const tokens = raw.length ? raw.split(/\s+/) : [];
      const head = (tokens[0] ?? "").toLowerCase();
      const rest = tokens.slice(1).join(" ");

      const paths = await resolvePaths(pi, ctx);

      // Every verb is a reconcile point. The user typing anything at all is a
      // better trigger than the 60s timer, and it costs one `gh pr view` per
      // Feature that is actually in the PR phase.
      lastCtx = ctx as unknown as ExtensionContext;
      void reconcileLiveFeaturePrs(pi, ctx);
      armReconcileTimer(pi, ctx as unknown as ExtensionContext);

      if (!raw || head === "help") {
        uiNotify(ctx, helpText(paths), "info");
        return;
      }

      if (head === "status" || head === "show") {
        uiNotify(ctx, await formatFleetStatus(pi, paths), "info");
        return;
      }

      // `verb` is empty when the line only *starts* with a verb word; those
      // fall through to the objective path at the bottom.
      // Names come from every orchestrator repo: cwd `~/Dev/git` is not a
      // repo, so the cwd-local list is empty even when host-ops Features exist.
      const liveNames = allLiveFeatureNames();
      const verb = isManagementInvocation(head, rest, liveNames) ? head : "";

      if (verb === "approve") {
        const feat = selectFeature(paths, ctx, rest, "approve");
        if (!feat) return;
        const plan = readText(feat.planFile);
        if (!plan.trim()) {
          uiNotify(ctx, `No plan at ${feat.planFile}`, "error");
          return;
        }
        // F16: validate → lock → APPROVED → chain. Everything that can refuse
        // runs here, before a single byte of `> Status: APPROVED` is written;
        // the marker itself goes in inside `beginImplementation`'s chain lock,
        // after the worktree exists.
        const preflight = approveRemoteRequirement({
          hostBase: isHostBase(feat.repo),
          originUrl: await originUrl(pi, feat.gitRoot),
          repo: feat.repo,
        });
        if (!preflight.ok) {
          uiNotify(ctx, preflight.reason, "error");
          return;
        }
        const named = ensureFeatureNamed(feat, plan);
        if (isPendingToken(named.name) || isPendingToken(named.branch)) {
          uiNotify(ctx,
            `Cannot approve: Name is still pending — the planner never wrote a real # Feature: title.\nPlan stays DRAFT at ${feat.planFile}`,
            "error",
          );
          return;
        }
        await beginImplementation(pi, ctx, feat, undefined, { approve: true });
        return;
      }

      if (verb === "implement" || verb === "tdd") {
        // `implement [feature] [task]`. The leading token is a Feature only
        // when it names one exactly; otherwise the whole argument is the Task
        // selector. Argument completions offer Feature names here, so both
        // readings have to resolve.
        const rows = discoverFeatures(paths);
        const parts = rest.trim() ? rest.trim().split(/\s+/) : [];
        const first = (parts[0] ?? "").toLowerCase();
        const exact = first
          ? rows.find(
              (r) =>
                !r.archived &&
                (r.name.toLowerCase() === first ||
                  basename(r.dir).toLowerCase() === first),
            )
          : undefined;
        const feat = exact
          ? bindFeature(paths, exact.dir)
          : selectFeature(paths, ctx, "", "implement");
        if (!feat) return;
        const target = (exact ? parts.slice(1).join(" ") : rest).trim();
        const wanted = target && !/^\s*all\b/i.test(target) ? target : undefined;
        await beginImplementation(pi, ctx, feat, wanted);
        return;
      }

      if (verb === "pr") {
        const feat = selectFeature(paths, ctx, rest, "pr");
        if (!feat) return;
        const named = ensureFeatureNamed(feat, readText(feat.planFile));
        // Under the same lock as the chain: this step now dispatches review
        // fixes, and two writers on one branch clobber each other's commits.
        const prRan = await withChainLock(feat.featureDir, async () => {
          const worktree = await ensureFeatureWorktree(pi, ctx, feat, named.branch);
          if (!worktree) return;
          uiNotify(ctx, `Landing Feature PR from ${worktree}`, "info");
          await landFeaturePr(pi, ctx, feat, named.name, worktree);
        });
        if (!prRan) {
          uiNotify(ctx, `A chain is already running on ${named.name}. Nothing started.`, "warning");
        }
        return;
      }

      if (verb === "pause") {
        // `now` is a modifier, not a Feature name.
        const pauseNow = /(^|\s)now(\s|$)/i.test(rest);
        const pauseTarget = rest.replace(/(^|\s)now(\s|$)/i, " ").trim();
        const feat = selectFeature(paths, ctx, pauseTarget, "pause");
        if (!feat) return;
        upsertStatusFile(feat, {
          pause: "after-task",
          nextAction: "finish current Task, then wait for /orchestrate resume",
        });
        const inflight = parseTasks(readText(feat.planFile)).find(
          (t) => t.status === "in_progress",
        );
        // `pause` used to be a flag the model was asked to read between Tasks.
        // Stopping is now optional but real: `pause now` ends the live child.
        if (pauseNow) {
          const runId = statusField(readText(feat.statusFile), "worker_run_id");
          const stopped = await stopRun(pi, runId);
          upsertStatusFile(feat, {
            phase: "paused",
            workerRunId: "none",
            nextAction: "/orchestrate resume",
          });
          uiNotify(ctx, 
            stopped
              ? `Stopped the running child and paused. /orchestrate resume to continue.`
              : `Pause armed; no live child to stop (worker_run_id=${runId || "none"}).`,
            "info",
          );
          return;
        }
        uiNotify(ctx, 
          inflight
            ? `Pause armed. Task ${inflight.id} will finish; next Task will not start.\n` +
                `/orchestrate pause now <name> stops the running child immediately.`
            : `Pause armed. No Task running. /orchestrate resume to continue.`,
          "info",
        );
        return;
      }

      if (verb === "resume") {
        const feat = selectFeature(paths, ctx, rest, "resume");
        if (!feat) return;
        // Where the interruption suspended this Feature, when it recorded it.
        // Read before `pause: off`, which does not move the phase but is the
        // kind of write that makes ordering easy to get wrong later.
        const restore = resumePhase(readText(feat.statusFile));
        upsertStatusFile(feat, { pause: "off" });

        // A Feature interrupted at `pr` has every Task done, so deriving its
        // phase from the plan sends it back through the implementation chain
        // — past a PR that is already open. The PR phase has an owner; hand it
        // back to that owner instead.
        if (restore === "pr") {
          uiNotify(ctx, `Resuming ${basename(feat.featureDir)} at its open PR`, "info");
          upsertStatusFile(feat, { phase: "pr", nextAction: "resumed — reconciling the PR" });
          await reconcileLiveFeaturePrs(pi, ctx);
          return;
        }
        uiNotify(
          ctx,
          restore
            ? `Resuming ${basename(feat.featureDir)} at ${restore} (Tasks → git-workflow PR)`
            : `Resuming auto loop (Tasks → git-workflow PR)`,
          "info",
        );
        await beginImplementation(pi, ctx, feat);
        return;
      }

      if (verb === "qa") {
        const want = rest.trim();
        const rows = discoverFeatures(paths);
        const row = want ? matchFeature(rows, want) : defaultFeature(rows);
        if (!row) {
          uiNotify(ctx, 
            want
              ? `No Feature matching "${want}". /orchestrate status to list.`
              : `No Feature to QA. /orchestrate <objective> first.`,
            "error",
          );
          return;
        }
        if (row.archived) {
          uiNotify(ctx, `Refusing QA on archived Feature ${row.name}`, "warning");
          return;
        }
        const featPaths = bindFeature(paths, row.dir);
        const branch =
          statusField(row.status, "branch") ||
          planHeaderField(row.plan, "Branch");
        const worktree = await ensureFeatureWorktree(pi, ctx, featPaths, branch);
        if (!worktree) return;
        uiNotify(ctx, 
          `End QA ${row.name} (qa-opus, xai/grok-4.6 high) → remediation Tasks\ncwd ${worktree}`,
          "info",
        );
        let added = -1;
        const qaRan = await withChainLock(featPaths.featureDir, async () => {
          added = await runFeatureQa(
            pi,
            ctx,
            featPaths,
            row.name,
            worktree,
            "qa-opus",
          );
        });
        if (!qaRan) {
          uiNotify(ctx, `A chain is already running on ${row.name}. Not starting QA.`, "warning");
          return;
        }
        if (added < 0) return;
        if (added === 0) {
          uiNotify(ctx, `qa-opus found nothing to fix on ${row.name}.`, "info");
          return;
        }
        uiNotify(ctx, 
          `qa-opus added ${added} remediation Task(s). Running them, then the Feature PR…`,
          "info",
        );
        await beginImplementation(pi, ctx, featPaths);
        return;
      }

      if (verb === "review") {
        const want = rest.trim();
        const rows = discoverFeatures(paths);
        const row = want ? matchFeature(rows, want) : defaultFeature(rows);
        if (!row) {
          uiNotify(ctx, 
            want
              ? `No Feature matching "${want}". /orchestrate status to list.`
              : `No Feature to review. /orchestrate <objective> first.`,
            "error",
          );
          return;
        }
        if (row.archived) {
          uiNotify(ctx, `Refusing review on archived Feature ${row.name}`, "warning");
          return;
        }
        const featPaths = bindFeature(paths, row.dir);
        let reviewOk = false;
        const ran = await withChainLock(featPaths.featureDir, async () => {
          reviewOk = await reviewPlan(pi, ctx, featPaths, row.name);
        });
        if (!ran) {
          uiNotify(
            ctx,
            `A chain is already running on ${row.name}. Not starting plan-reviewer.`,
            "warning",
          );
          return;
        }
        if (!reviewOk) return;
        presentDraftApproveCards(pi, ctx, featPaths);
        uiNotify(ctx, `Review finished. ${featPaths.planFile}`, "info");
        return;
      }

      if (verb === "archive") {
        const feat = selectFeature(paths, ctx, rest, "archive");
        if (!feat) return;
        const dest = archiveFeature(feat);
        uiNotify(ctx, `Archived to ${dest}`, "info");
        return;
      }

      // `plan`/`new` force the objective reading, for an objective whose own
      // wording collides with a management verb.
      const objective = objectiveFrom(head, rest, raw);
      if (!objective) {
        uiNotify(ctx, 
          `/orchestrate plan <objective> — describe what to build.`,
          "error",
        );
        return;
      }
      const cwd = ctx.cwd || process.cwd();
      const detected = detectFeatureBase(cwd, paths.gitRoot);
      const last = readLastBase();
      const decision = baseDecision(detected, last);
      let chosen = detected;
      if (decision.action === "confirm-switch") {
        const ok = ctx.hasUI
          ? await ctx.ui.confirm(
              "Switch Feature base?",
              `This session is in ${decision.to.label}.\nLast Feature was ${decision.from.id}.\nPlan against ${decision.to.id}?`,
            )
          : true;
        if (ok) {
          chosen = decision.to;
        } else if (ctx.hasUI) {
          const options = [decision.to.label, decision.from.label, "Cancel"];
          const pick = await ctx.ui.select("Use which base?", options);
          if (!pick || pick === "Cancel") {
            uiNotify(ctx, "No base selected. Not planning.", "warning");
            return;
          }
          chosen = pick === decision.from.label ? decision.from : decision.to;
        } else {
          chosen = decision.from;
        }
      } else if (decision.action === "select") {
        const bases = listFeatureBases();
        if (!ctx.hasUI || !bases.length) {
          uiNotify(ctx, 
            `cwd is not a known Feature base (${cwd}).\ncd to a ~/Dev/git/<repo> checkout, ~/.pi/agent/extensions, or /orchestrate approve <name>.`,
            "error",
          );
          return;
        }
        const pick = await ctx.ui.select(
          "Feature base — cwd is not a known checkout",
          bases.map((b) => b.label),
        );
        chosen = bases.find((b) => b.label === pick);
        if (!chosen) {
          uiNotify(ctx, "No base selected. Not planning.", "warning");
          return;
        }
      }
      if (!chosen) {
        uiNotify(ctx, 
          `cwd is not a known Feature base (${cwd}).\ncd to a ~/Dev/git/<repo> checkout, ~/.pi/agent/extensions, or /orchestrate approve <name>.`,
          "error",
        );
        return;
      }
      applyBase(paths, chosen);
      writeLastBase(chosen);
      const feat = bindFeature(paths, join(paths.repoDir, `pending-${utcStamp()}`));
      seedFeature(feat, objective);
      uiNotify(ctx, 
        `Planning a new Feature → ${feat.planFile}\n` +
          (NAMED_VERBS.has(head)
            ? `Read as an objective, not the "${head}" subcommand (/orchestrate status to manage live Features).\n`
            : "") +
          `Name/folder assigned after the planner writes # Feature: (not from the objective). Other Features stay put.`,
        "info",
      );
      const planned = await runChildInPhase(pi, ctx, "plan", plannerLaunchParams(feat, objective));
      if (!planned.ok) {
        uiNotify(ctx, 
          `Planner did not complete (${planned.reason ?? planned.state ?? "failed"}). Plan remains DRAFT.\n${feat.planFile}`,
          "error",
        );
        return;
      }
      // F15: this is the only place a Feature is named. Naming renames the
      // folder out from under whoever holds the old path, so it runs exactly
      // once, after the planner child has exited, inside the chain lock. The
      // lock key is the pre-rename `featureDir`, which is what the `finally`
      // releases — `feat` is rebound by the rename, the captured string is not.
      let named: { plan: string; name: string; branch: string } | undefined;
      let reviewOk = false;
      const pendingDir = feat.featureDir;
      const ran = await withChainLock(pendingDir, async () => {
        named = ensureFeatureNamed(feat, readText(feat.planFile));
        if (isPendingToken(named.name)) return;
        reviewOk = await reviewPlan(pi, ctx, feat, named.name);
      });
      if (!ran) {
        uiNotify(
          ctx,
          `A chain is already running on ${basename(pendingDir)}. plan-reviewer did not start.`,
          "warning",
        );
        return;
      }
      if (!named || isPendingToken(named.name)) {
        uiNotify(
          ctx,
          `Planner finished but Name is still pending — need a real # Feature: title.\n${feat.planFile}`,
          "warning",
        );
        return;
      }
      if (!reviewOk) return;
      presentDraftApproveCards(pi, ctx, feat);
      uiNotify(
        ctx,
        `Plan reviewed: ${feat.planFile}\nName ${named.name} (${named.branch}). Waiting on /orchestrate approve ${named.name}. This session is idle.`,
        "info",
      );
    },
  });
}
