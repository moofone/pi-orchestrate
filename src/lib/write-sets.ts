/**
 * Shared-tree writer write-sets for /orchestrate.
 *
 * Up to 4 concurrent fixers and up to 8 concurrent tdd-workers may share one
 * worktree PROVIDED their write-sets are disjoint. This module is the pure
 * core of that rule: path normalization, overlap admission, finding/Files
 * grouping, and the disk sidecar (`writers.json`) that records live slots so
 * a session replacement cannot double-book a path.
 *
 * The unknown set (no declared paths) overlaps everything: a writer with no
 * write-set runs solo, and while it is live nothing else is admitted. That
 * preserves the old one-writer safety whenever the split is not declared.
 *
 * This module never imports orchestrate.ts. Liveness is injected as a
 * callback because run snapshots live on the dispatch side.
 *
 * Run: node --experimental-strip-types --test test/write-sets.test.ts
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Max concurrent fixers sharing one worktree (disjoint write-sets). */
export const FIXER_MAX_CONCURRENT = 4;
/** Max concurrent tdd-workers sharing one worktree (disjoint write-sets). */
export const WORKER_MAX_CONCURRENT = 8;

const REPO_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Normalize one repo-relative write path. Null means unusable: absolute,
 * escaping, empty, or non-canonical. Directories are kept as prefixes; the
 * overlap check treats `a/b` as covering `a/b/c`.
 */
export function normalizeWritePath(path: string): string | null {
  const trimmed = String(path ?? "").trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "." || trimmed.includes("\\")) return null;
  if (trimmed.startsWith("/") || trimmed.startsWith("./")) return null;
  const parts = trimmed.split("/");
  if (parts.includes("") || parts.includes(".") || parts.includes("..")) return null;
  const normalized = parts.join("/");
  if (!REPO_PATH.test(normalized)) return null;
  return normalized;
}

/** Dedupe + normalize a raw path list. Nulls drop out; [] means unknown. */
export function normalizeWriteSet(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of paths) {
    const normalized = normalizeWritePath(raw);
    if (normalized) out.add(normalized);
  }
  return [...out].sort();
}

function covers(container: string, target: string): boolean {
  return target === container || target.startsWith(`${container}/`);
}

/**
 * True when the two sets may touch the same file. Either side empty (unknown
 * scope) overlaps everything, so undeclared writers always run solo.
 */
export function writeSetsOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  for (const x of a) for (const y of b) {
    if (covers(x, y) || covers(y, x)) return true;
  }
  return false;
}

export interface WriterSlot {
  runId: string;
  runDir: string;
  agent: string;
  /** Repo-relative paths this writer may touch. [] = unknown = solo. */
  writeSet: string[];
  claimedAt: number;
  label?: string;
}

export type AdmitRefusal = "cap" | "overlap";

/**
 * Pure admission: cap first (cheap, stable reason), then overlap against
 * every live slot. Empty candidate or empty live sets overlap by definition.
 *
 * Capacity is per agent class. The sidecar is shared by fixers and
 * tdd-workers, so counting every slot against the candidate's cap would let
 * one class starve the other even when their write-sets are disjoint.
 */
export function admitWriteSlot(
  live: readonly WriterSlot[],
  candidate: Pick<WriterSlot, "writeSet"> & Partial<Pick<WriterSlot, "agent">>,
  cap: number,
): { ok: true } | { ok: false; reason: AdmitRefusal; conflictsWith?: string } {
  const agent = candidate.agent?.trim() || "default";
  const counted = live.filter((slot) => (slot.agent.trim() || "default") === agent);
  if (counted.length >= cap) return { ok: false, reason: "cap" };
  for (const slot of live) {
    if (writeSetsOverlap(slot.writeSet, candidate.writeSet)) {
      return { ok: false, reason: "overlap", conflictsWith: slot.runId };
    }
  }
  return { ok: true };
}

const FINDING_PATH = /\bpath=(\S+)/;

/** Leading path of an already-parsed finding (`src/pay.rs:88 P1 ...`). */
function parsedFindingPath(finding: string): string {
  const head = finding.trim().split(/\s+/, 1)[0] ?? "";
  const withoutLine = head.replace(/:\d+$/, "");
  return normalizeWritePath(withoutLine) ?? "";
}

/**
 * Group findings by path. Accepts raw `brief_finding path=…` lines and the
 * already-parsed `path …` shape `parseBriefFindings` returns (whose `path=`
 * token is already extracted). Pathless lines share one unscoped group ("").
 */
export function groupFindingsByPath(findings: readonly string[]): Array<{ path: string; findings: string[] }> {
  const groups = new Map<string, string[]>();
  for (const raw of findings) {
    const finding = String(raw ?? "");
    // Raw `brief_finding` lines without `path=` are unscoped even when they
    // start with a path-like token; only already-parsed lines (“path …”)
    // fall through to the leading-token read.
    const path =
      FINDING_PATH.exec(finding)?.[1] ??
      (/^\s*brief_finding\b/.test(finding) ? "" : parsedFindingPath(finding));
    const list = groups.get(path) ?? [];
    list.push(finding);
    groups.set(path, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, items]) => ({ path, findings: items }));
}

/**
 * Bin-pack path-group keys into at most `cap` bundles (greedy
 * largest-first). Merging groups into one writer is always safe; splitting
 * is what must stay disjoint, and grouping already did that.
 */
export function packPathGroups(keys: readonly string[], cap: number): string[][] {
  const safeCap = Math.max(1, Math.floor(cap) || 1);
  if (keys.length === 0) return [];
  const bundles: string[][] = Array.from(
    { length: Math.min(safeCap, keys.length) },
    () => [],
  );
  keys.forEach((key, i) => {
    bundles[i % bundles.length]!.push(key);
  });
  return bundles.filter((bundle) => bundle.length > 0);
}

/** `- Files:` scalar from a plan Task section: comma/space-separated repo paths. */
export function parseFilesScalar(body: string): string[] {
  const raw = (String(body ?? "").match(/^-\s*Files:\s*(.+?)\s*$/im)?.[1] ?? "").trim();
  if (!raw || /^(pending|none|tbd|todo)$/i.test(raw)) return [];
  const parts = raw.split(/[\s,;]+/).filter(Boolean);
  return normalizeWriteSet(parts);
}

export const WRITERS_SIDECAR = "writers.json";
/** Per-Task recovery records; unlike status.md these are keyed by Task id. */
export const TASK_RUNS_SIDECAR = "task_runs.json";

export interface TaskRunRecord {
  taskId: string;
  runId: string;
  runDir: string;
  baseTag: string;
  baseHead: string;
}

const WRITERS_LOCK = ".writers.lock";
const WRITER_LOCK_STALE_MS = 30_000;
const WRITER_LOCK_WAIT_MS = 10;
const WRITER_LOCK_TIMEOUT_MS = 30_000;

type WriterLockContext = { held: Set<string> };
/** Reentrancy belongs to one async execution context, never this process. */
const WRITER_LOCK_CONTEXT = new AsyncLocalStorage<WriterLockContext | undefined>();
/** Local waiters also keep sync RMW calls from blocking the event loop. */
const LOCAL_WRITER_LOCK_TAILS = new Map<string, Promise<void>>();

function writerLockPath(dir: string): string {
  return join(dir, WRITERS_LOCK);
}

function sidecarPath(dir: string): string {
  return join(dir, WRITERS_SIDECAR);
}

function taskRunsPath(dir: string): string {
  return join(dir, TASK_RUNS_SIDECAR);
}

/**
 * Cross-process advisory lock for the sidecar. Node has no portable flock
 * binding, so the lock is an atomic exclusive-create lockfile with an owner
 * record: creation is the acquisition operation, and a dead owner can never
 * strand the sidecar. The callback stays inside the lock for the complete
 * read/sweep/compute/persist transaction.
 */
function waitSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function staleWriterLock(lockPath: string): boolean {
  let owner: { pid?: unknown } = {};
  try {
    owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
  } catch {
    // An owner record may not have made it to disk before a process died.
  }
  const pid = typeof owner.pid === "number" ? owner.pid : 0;
  if (pid > 0) return !processIsAlive(pid);
  try {
    return Date.now() - statSync(lockPath).mtimeMs >= WRITER_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

function tryAcquireWriterLock(lockPath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, "wx", 0o600);
    writeFileSync(
      fd,
      `${JSON.stringify({ pid: process.pid, token: randomUUID() })}\n`,
      "utf8",
    );
    closeSync(fd);
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* incomplete owner record */ }
      rmSync(lockPath, { force: true });
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (staleWriterLock(lockPath)) rmSync(lockPath, { force: true });
    return false;
  }
}

function acquireWriterLock(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const lockPath = writerLockPath(dir);
  const deadline = Date.now() + WRITER_LOCK_TIMEOUT_MS;
  for (;;) {
    if (tryAcquireWriterLock(lockPath)) return lockPath;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${WRITERS_LOCK}`);
    }
    waitSync(WRITER_LOCK_WAIT_MS);
  }
}

function withWriterLock<T>(dir: string, action: () => T): T {
  const requested = writerLockPath(dir);
  const owner = WRITER_LOCK_CONTEXT.getStore();
  if (owner?.held.has(requested)) return action();
  // A synchronous caller cannot wait on an async holder without freezing the
  // event loop that must release it. Queue the transaction instead; callers
  // that can wait use `await` (the uncontended path remains synchronous for
  // the existing sidecar API).
  if (LOCAL_WRITER_LOCK_TAILS.has(requested)) {
    return WRITER_LOCK_CONTEXT.run(undefined, () =>
      withWriterLockAsync(dir, async () => action()),
    ) as unknown as T;
  }
  const lockPath = acquireWriterLock(dir);
  try {
    return WRITER_LOCK_CONTEXT.run({ held: new Set([requested]) }, action);
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/** Async counterpart: do not block this process while another writer holds it. */
async function acquireWriterLockAsync(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const lockPath = writerLockPath(dir);
  const deadline = Date.now() + WRITER_LOCK_TIMEOUT_MS;
  for (;;) {
    if (tryAcquireWriterLock(lockPath)) return lockPath;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${WRITERS_LOCK}`);
    }
    await new Promise((resolve) => setTimeout(resolve, WRITER_LOCK_WAIT_MS));
  }
}

/** Run one asynchronous sidecar transaction under the cross-process lock. */
export async function withWriterLockAsync<T>(dir: string, action: () => Promise<T>): Promise<T> {
  const requested = writerLockPath(dir);
  const owner = WRITER_LOCK_CONTEXT.getStore();
  if (owner?.held.has(requested)) return action();

  // Serialize this process's async holders before touching the lockfile. This
  // both preserves ordering and lets a synchronous sibling queue rather than
  // block the event loop while this holder is awaiting.
  const previous = LOCAL_WRITER_LOCK_TAILS.get(requested) ?? Promise.resolve();
  let releaseTail!: () => void;
  const currentTail = new Promise<void>((resolve) => { releaseTail = resolve; });
  const turn = previous.then(async () => {
    const lockPath = await acquireWriterLockAsync(dir);
    try {
      const held = new Set(owner?.held ?? []);
      held.add(requested);
      return await WRITER_LOCK_CONTEXT.run({ held }, action);
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  });
  const tail = turn.then(
    () => {
      releaseTail();
    },
    () => {
      releaseTail();
    },
  );
  LOCAL_WRITER_LOCK_TAILS.set(requested, currentTail);
  void tail.then(() => {
    if (LOCAL_WRITER_LOCK_TAILS.get(requested) === currentTail) {
      LOCAL_WRITER_LOCK_TAILS.delete(requested);
    }
  });
  return turn;
}

/** Read recorded slots. Unreadable/corrupt sidecar reads as empty, never throws. */
export function readWriterSlots(dir: string): WriterSlot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sidecarPath(dir), "utf-8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: WriterSlot[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const slot = entry as Partial<WriterSlot>;
    if (typeof slot.runId !== "string" || !slot.runId) continue;
    out.push({
      runId: slot.runId,
      runDir: typeof slot.runDir === "string" ? slot.runDir : "",
      agent: typeof slot.agent === "string" ? slot.agent : "",
      writeSet: Array.isArray(slot.writeSet)
        ? normalizeWriteSet(slot.writeSet.filter((p): p is string => typeof p === "string"))
        : [],
      claimedAt: typeof slot.claimedAt === "number" ? slot.claimedAt : 0,
      ...(typeof slot.label === "string" ? { label: slot.label } : {}),
    });
  }
  return out;
}

/** Read per-Task recovery records. Corrupt records are ignored, never fatal. */
export function readTaskRuns(dir: string): TaskRunRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(taskRunsPath(dir), "utf-8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: TaskRunRecord[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const run = entry as Partial<TaskRunRecord>;
    if (typeof run.taskId !== "string" || !run.taskId) continue;
    out.push({
      taskId: run.taskId,
      runId: typeof run.runId === "string" ? run.runId : "none",
      runDir: typeof run.runDir === "string" ? run.runDir : "none",
      baseTag: typeof run.baseTag === "string" ? run.baseTag : "none",
      baseHead: typeof run.baseHead === "string" ? run.baseHead : "none",
    });
  }
  return out;
}

function persistTaskRunsUnlocked(dir: string, runs: TaskRunRecord[]): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${TASK_RUNS_SIDECAR}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(runs, null, "\t")}\n`, "utf-8");
    renameSync(tmp, taskRunsPath(dir));
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Atomically update the keyed Task recovery records under the writer lock. */
export function updateTaskRuns<T>(
  dir: string,
  mutate: (runs: TaskRunRecord[]) => { runs: TaskRunRecord[]; result: T },
): T {
  return withWriterLock(dir, () => {
    const updated = mutate(readTaskRuns(dir));
    persistTaskRunsUnlocked(dir, updated.runs);
    return updated.result;
  });
}

/** Drop records for Tasks no longer in progress and return them to release owners. */
export function sweepTaskRuns(
  dir: string,
  inProgressTaskIds: readonly string[],
): { runs: TaskRunRecord[]; swept: boolean; removed: TaskRunRecord[] } {
  return withWriterLock(dir, () => {
    const recorded = readTaskRuns(dir);
    const keep = new Set(inProgressTaskIds);
    const runs = recorded.filter((run) => keep.has(run.taskId));
    const removed = recorded.filter((run) => !keep.has(run.taskId));
    if (removed.length > 0) persistTaskRunsUnlocked(dir, runs);
    return { runs, swept: removed.length > 0, removed };
  });
}

/** Persist one Task's recovery snapshot, replacing any older attempt. */
export function upsertTaskRun(dir: string, record: TaskRunRecord): void {
  updateTaskRuns(dir, (runs) => ({
    runs: [...runs.filter((run) => run.taskId !== record.taskId), record],
    result: undefined,
  }));
}

/** Remove one Task's recovery snapshot after its outcome is settled. */
export function releaseTaskRun(dir: string, taskId: string): void {
  try {
    updateTaskRuns(dir, (runs) => ({
      runs: runs.filter((run) => run.taskId !== taskId),
      result: undefined,
    }));
  } catch {
    /* recovery bookkeeping must never take down the settler */
  }
}

/** Persist slots atomically (tmp + rename). The write itself is lock-protected. */
export function persistWriterSlots(dir: string, slots: WriterSlot[]): void {
  withWriterLock(dir, () => persistWriterSlotsUnlocked(dir, slots));
}

function persistWriterSlotsUnlocked(dir: string, slots: WriterSlot[]): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${WRITERS_SIDECAR}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(slots, null, "\t")}\n`, "utf-8");
    renameSync(tmp, sidecarPath(dir));
  } finally {
    rmSync(tmp, { force: true });
  }
}

function sweepWriterSlotsUnlocked(
  dir: string,
  isLive: (runDir: string, runId: string, slot?: WriterSlot) => boolean,
): { slots: WriterSlot[]; swept: boolean } {
  const recorded = readWriterSlots(dir);
  const live = recorded.filter((slot) => {
    try {
      return isLive(slot.runDir, slot.runId, slot);
    } catch {
      return false;
    }
  });
  return { slots: live, swept: live.length !== recorded.length };
}

/**
 * Drop expired reservations. Sweeping and its persistence happen under one
 * lock, so this is safe to use before another read-modify-write.
 */
export function sweepWriterSlots(
  dir: string,
  isLive: (runDir: string, runId: string, slot?: WriterSlot) => boolean,
): { slots: WriterSlot[]; swept: boolean } {
  return withWriterLock(dir, () => {
    const result = sweepWriterSlotsUnlocked(dir, isLive);
    if (result.swept) persistWriterSlotsUnlocked(dir, result.slots);
    return result;
  });
}

/**
 * Run one arbitrary sidecar mutation while holding the same lock as claims,
 * swaps, releases, and sweeps. Callers receive a freshly swept snapshot and
 * must return the replacement slots together with their result.
 */
export function updateWriterSlots<T>(
  dir: string,
  isLive: (runDir: string, runId: string, slot?: WriterSlot) => boolean,
  mutate: (slots: WriterSlot[]) => { slots: WriterSlot[]; result: T },
): T {
  return withWriterLock(dir, () => {
    const swept = sweepWriterSlotsUnlocked(dir, isLive);
    const updated = mutate(swept.slots);
    persistWriterSlotsUnlocked(dir, updated.slots);
    return updated.result;
  });
}

/** Sweep, admit, and persist one claim. Admission reason doubles as the refuse notice. */
export function claimWriterSlot(
  dir: string,
  slot: WriterSlot,
  isLive: (runDir: string, runId: string, slot?: WriterSlot) => boolean,
  cap: number,
): { ok: true } | { ok: false; reason: AdmitRefusal; conflictsWith?: string } {
  return withWriterLock(dir, () => {
    const swept = sweepWriterSlotsUnlocked(dir, isLive);
    const admitted = admitWriteSlot(swept.slots, slot, cap);
    if (admitted.ok) {
      persistWriterSlotsUnlocked(dir, [...swept.slots, slot]);
    } else if (swept.swept) {
      persistWriterSlotsUnlocked(dir, swept.slots);
    }
    return admitted;
  });
}

/** Release one run's slot. Missing sidecar or missing run still resolves. */
export function releaseWriterSlot(dir: string, runId: string): void {
  try {
    updateWriterSlots(dir, () => true, (slots) => ({
      slots: slots.filter((slot) => slot.runId !== runId),
      result: undefined,
    }));
  } catch {
    /* bookkeeping must never take down the settler */
  }
}
