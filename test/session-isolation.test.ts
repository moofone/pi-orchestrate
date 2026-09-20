/**
 * Session-isolation regression tests for orchestration_bug.md.
 *
 * Cross-session contamination (2026-09-20): scouts in an icemining session
 * returned PPLNS review content from a different session. One proven vector
 * is ambiguous Feature binding — a generic short query silently binding the
 * first substring match across repos/sessions instead of refusing.
 *
 * Run: npm test (or: node --experimental-strip-types --test test/session-isolation.test.ts)
 *
 * Written RED: these fail against the code as found, pass after the fix.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as orch from "../src/orchestrate.ts";

function row(name: string, dir?: string) {
  return {
    name,
    dir: dir ?? `/tmp/${name}`,
    live: true,
    archived: false,
    plan: "",
    status: "",
  };
}

test("RED: ambiguous substring 'gap' across sessions must not bind first match", () => {
  const rows = [row("sync-gap"), row("pplns-gap")];
  assert.equal(
    orch.matchFeature(rows, "gap"),
    undefined,
    "two Features containing 'gap' must not silently bind the first; require disambiguation",
  );
});

test("RED: ambiguous substring 'inventory' across sessions must not bind first match", () => {
  const rows = [row("inventory-api"), row("inventory-worker")];
  assert.equal(
    orch.matchFeature(rows, "inventory"),
    undefined,
    "two Features containing 'inventory' must not silently bind the first",
  );
});

test("unique substring still binds (no over-correction)", () => {
  const rows = [row("sync-gap"), row("venue-healing")];
  assert.equal(
    orch.matchFeature(rows, "sync")?.name,
    "sync-gap",
    "a substring matching exactly one live Feature must still bind it",
  );
});

test("exact name wins over substring container", () => {
  const rows = [row("gap"), row("sync-gap")];
  assert.equal(
    orch.matchFeature(rows, "gap")?.name,
    "gap",
    "exact match must win even when another name contains it",
  );
});

test("RED: pending dir generation must be collision-proof across sessions", () => {
  assert.equal(
    typeof (orch as Record<string, unknown>).uniquePendingName,
    "function",
    "uniquePendingName helper must exist so two sessions creating Features in the same millisecond do not share pending-<utc>",
  );
});

test("RED: rapid pending names must all be unique", () => {
  const fn = (orch as unknown as {
    uniquePendingName?: (repoDir: string) => string;
  }).uniquePendingName;
  assert.ok(fn, "uniquePendingName must exist");
  const repoDir = mkdtempSync(join(tmpdir(), "pending-collision-"));
  try {
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) names.add(fn!(repoDir));
    assert.equal(
      names.size,
      50,
      "50 rapid pending generations in one process must not collide; timestamp-only names collide within the same millisecond",
    );
    for (const name of names) {
      assert.match(name, /^pending-/);
    }
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
