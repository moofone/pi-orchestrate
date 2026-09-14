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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
 */
export function admitWriteSlot(
  live: readonly WriterSlot[],
  candidate: Pick<WriterSlot, "writeSet">,
  cap: number,
): { ok: true } | { ok: false; reason: AdmitRefusal; conflictsWith?: string } {
  if (live.length >= cap) return { ok: false, reason: "cap" };
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

function sidecarPath(dir: string): string {
  return join(dir, WRITERS_SIDECAR);
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

/** Persist slots atomically (tmp + rename). Exported for sweep-and-persist callers. */
export function persistWriterSlots(dir: string, slots: WriterSlot[]): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${WRITERS_SIDECAR}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(slots, null, "\t")}\n`, "utf-8");
  renameSync(tmp, sidecarPath(dir));
}
function writeWriterSlots(dir: string, slots: WriterSlot[]): void {
  persistWriterSlots(dir, slots);
}

/**
 * Drop slots whose runs are terminal. Returns the live set and whether
 * anything was swept (callers persist only when swept to avoid chatter).
 */
export function sweepWriterSlots(
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

/** Sweep, admit, and persist one claim. Admission reason doubles as the refuse notice. */
export function claimWriterSlot(
  dir: string,
  slot: WriterSlot,
  isLive: (runDir: string, runId: string, slot?: WriterSlot) => boolean,
  cap: number,
): { ok: true } | { ok: false; reason: AdmitRefusal; conflictsWith?: string } {
  const { slots } = sweepWriterSlots(dir, isLive);
  const admitted = admitWriteSlot(slots, slot, cap);
  if (!admitted.ok) {
    if (slots.length !== readWriterSlots(dir).length) writeWriterSlots(dir, slots);
    return admitted;
  }
  writeWriterSlots(dir, [...slots, slot]);
  return { ok: true };
}

/** Release one run's slot. Missing sidecar or missing run still resolves. */
export function releaseWriterSlot(dir: string, runId: string): void {
  const slots = readWriterSlots(dir).filter((slot) => slot.runId !== runId);
  try {
    writeWriterSlots(dir, slots);
  } catch {
    /* bookkeeping must never take down the settler */
  }
}
