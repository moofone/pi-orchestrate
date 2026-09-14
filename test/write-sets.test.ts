/**
 * Shared-tree write-set tests for src/lib/write-sets.ts.
 *
 * Run: node --experimental-strip-types --test test/write-sets.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  admitWriteSlot,
  claimWriterSlot,
  groupFindingsByPath,
  normalizeWritePath,
  normalizeWriteSet,
  packPathGroups,
  parseFilesScalar,
  readWriterSlots,
  releaseWriterSlot,
  sweepWriterSlots,
  updateWriterSlots,
  type WriterSlot,
} from "../src/lib/write-sets.ts";

function slot(over: Partial<WriterSlot> = {}): WriterSlot {
  return {
    runId: "run-1",
    runDir: "/tmp/run-1",
    agent: "fixer",
    writeSet: ["src/a.ts"],
    claimedAt: 1,
    ...over,
  };
}

test("write-sets: normalizeWritePath rejects escapes and absolutes", () => {
  assert.equal(normalizeWritePath("src/a.ts"), "src/a.ts");
  assert.equal(normalizeWritePath("src/"), "src");
  assert.equal(normalizeWritePath("/abs/path"), null);
  assert.equal(normalizeWritePath("../escape"), null);
  assert.equal(normalizeWritePath("a/../b"), null);
  assert.equal(normalizeWritePath(""), null);
  assert.equal(normalizeWritePath("."), null);
  assert.equal(normalizeWritePath("a\\b"), null);
});

test("write-sets: normalizeWriteSet dedupes and drops bad entries", () => {
  assert.deepEqual(normalizeWriteSet(["b.ts", "a.ts", "b.ts", "/abs", ""]), ["a.ts", "b.ts"]);
});

test("write-sets: admitWriteSlot refuses overlap and cap, unknown runs solo", () => {
  const live = [slot({ runId: "a", writeSet: ["src/a.ts"] })];
  // Same file overlaps.
  assert.equal(admitWriteSlot(live, { writeSet: ["src/a.ts"] }, 4).ok, false);
  // Directory covering the file overlaps.
  assert.equal(admitWriteSlot(live, { writeSet: ["src"] }, 4).ok, false);
  // File under a claimed directory overlaps.
  const dirLive = [slot({ runId: "b", writeSet: ["src"] })];
  const dirRefused = admitWriteSlot(dirLive, { writeSet: ["src/a.ts"] }, 4);
  assert.equal(dirRefused.ok, false);
  if (!dirRefused.ok) assert.equal(dirRefused.reason, "overlap");
  // Disjoint files admit.
  assert.deepEqual(admitWriteSlot(live, { writeSet: ["src/b.ts"] }, 4), { ok: true });
  // Unknown (empty) candidate overlaps everything.
  const unknown = admitWriteSlot(live, { writeSet: [] }, 4);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason, "overlap");
  // Unknown live slot blocks everything too.
  const unknownLive = [slot({ runId: "c", writeSet: [] })];
  assert.equal(admitWriteSlot(unknownLive, { writeSet: ["src/z.ts"] }, 4).ok, false);
  // Cap binds before overlap is even consulted.
  const full = [slot({ runId: "1" }), slot({ runId: "2" }), slot({ runId: "3" }), slot({ runId: "4" })];
  const capped = admitWriteSlot(full, { writeSet: ["other/x.ts"] }, 4);
  assert.equal(capped.ok, false);
  if (!capped.ok) assert.equal(capped.reason, "cap");
});

test("write-sets: groupFindingsByPath also reads already-parsed findings", () => {
  const parsed = ["src/a.ts:10 block bad", "src/b.ts fix-now worse", "!!! not a path !!!"];
  const groups = groupFindingsByPath(parsed);
  assert.deepEqual(
    groups.map((g) => g.path).sort(),
    ["", "src/a.ts", "src/b.ts"],
  );
});

test("write-sets: groupFindingsByPath keys on path=, pathless share one group", () => {
  const findings = [
    "brief_finding path=src/a.ts line=10 sev=block title=bad",
    "brief_finding path=src/b.ts line=3 sev=fix-now title=worse",
    "brief_finding path=src/a.ts line=20 sev=defer title=minor",
    "brief_finding title=no path here",
  ];
  const groups = groupFindingsByPath(findings);
  assert.deepEqual(
    groups.map((g) => g.path).sort(),
    ["", "src/a.ts", "src/b.ts"],
  );
  assert.equal(groups.find((g) => g.path === "src/a.ts")?.findings.length, 2);
});

test("write-sets: packPathGroups never exceeds cap and keeps every key", () => {
  const keys = ["a", "b", "c", "d", "e", "f", "g"];
  const packed = packPathGroups(keys, 4);
  assert.ok(packed.length <= 4);
  assert.deepEqual(packed.flat().sort(), keys);
  assert.deepEqual(packPathGroups(["only"], 4), [["only"]]);
  assert.deepEqual(packPathGroups([], 4), []);
});

test("write-sets: parseFilesScalar reads - Files:, absent means solo", () => {
  assert.deepEqual(parseFilesScalar("### Task 1\n- Files: src/a.ts, src/b.ts\n"), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(parseFilesScalar("### Task 1\n- Status: pending\n"), []);
  assert.deepEqual(parseFilesScalar("- Files: none"), []);
});

test("write-sets: sidecar claim/sweep/release round-trips on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "writers-"));
  const live = new Set(["run-1"]);
  const isLive = (_runDir: string, runId: string) => live.has(runId);
  assert.deepEqual(claimWriterSlot(dir, slot({ runId: "run-1" }), isLive, 4), { ok: true });
  // Overlapping second claim refuses.
  const refused = claimWriterSlot(dir, slot({ runId: "run-2", writeSet: ["src/a.ts"] }), isLive, 4);
  assert.equal(refused.ok, false);
  // Disjoint second claim admits.
  assert.deepEqual(
    claimWriterSlot(dir, slot({ runId: "run-2", writeSet: ["src/b.ts"] }), isLive, 4),
    { ok: true },
  );
  assert.equal(readWriterSlots(dir).length, 2);
  // Dead runs sweep on next claim.
  live.add("run-2");
  live.delete("run-1");
  const { slots, swept } = sweepWriterSlots(dir, isLive);
  assert.equal(swept, true);
  assert.deepEqual(slots.map((s) => s.runId), ["run-2"]);
  releaseWriterSlot(dir, "run-1");
  releaseWriterSlot(dir, "run-2");
  assert.deepEqual(readWriterSlots(dir), []);
});

const WRITE_SETS_URL = pathToFileURL(join(process.cwd(), "src/lib/write-sets.ts")).href;

function sidecarChild(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script, ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`sidecar child exited ${code}: ${stderr}`));
    });
  });
}

test("write-sets: concurrent claims admit no overlapping duplicate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "writers-race-"));
  const script = `
    import { claimWriterSlot } from ${JSON.stringify(WRITE_SETS_URL)};
    const [dir, runId] = process.argv.slice(1);
    const result = claimWriterSlot(dir, {
      runId, runDir: '', agent: 'fixer', writeSet: ['src/race.ts'], claimedAt: Date.now()
    }, () => true, 4);
    process.stdout.write(JSON.stringify(result));
  `;
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => sidecarChild(script, [dir, `race-${i}`])),
  );
  const admittedIds = results
    .map((result) => JSON.parse(result) as { ok?: boolean })
    .filter((result) => result.ok === true);
  assert.equal(admittedIds.length, 1, "the lock must serialize read/compute/persist claims");
  assert.equal(readWriterSlots(dir).length, 1, "only one overlapping claim may be persisted");
});

test("write-sets: concurrent swap and release preserve the sibling slot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "writers-swap-race-"));
  persistWriterSlotsForTest(dir, [
    slot({ runId: "provisional", writeSet: ["src/a.ts"] }),
    slot({ runId: "sibling", writeSet: ["src/b.ts"] }),
  ]);
  const script = `
    import { updateWriterSlots } from ${JSON.stringify(WRITE_SETS_URL)};
    const [dir, operation] = process.argv.slice(1);
    updateWriterSlots(dir, () => true, (slots) => {
      if (operation === 'swap') {
        const old = slots.find((entry) => entry.runId === 'provisional');
        return { slots: [...slots.filter((entry) => entry.runId !== 'provisional'), {
          ...(old ?? { runDir: '', agent: 'fixer', writeSet: ['src/a.ts'], claimedAt: Date.now() }),
          runId: 'real'
        }], result: undefined };
      }
      return { slots: slots.filter((entry) => entry.runId !== 'sibling'), result: undefined };
    });
  `;
  await Promise.all([sidecarChild(script, [dir, "swap"]), sidecarChild(script, [dir, "release"])]);
  assert.deepEqual(readWriterSlots(dir).map((entry) => entry.runId).sort(), ["real"]);
});

function persistWriterSlotsForTest(dir: string, slots: WriterSlot[]): void {
  updateWriterSlots(dir, () => true, () => ({ slots, result: undefined }));
}
