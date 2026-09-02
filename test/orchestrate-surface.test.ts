/**
 * Barrel-surface tests for orchestrate.ts.
 *
 * Run: node --experimental-strip-types --test test/orchestrate-surface.test.ts
 *
 * These lock the module topology of the extraction Feature: `src/lib/*` stays
 * free of `orchestrate.ts` imports (the latch lazily imports the entry point;
 * one lib import would pull the monolith into every session), the last-match
 * tokeniser lives beside `parseKeyedTokens` instead of a second copy in the
 * barrel, and unused helpers do not ride the public surface. Behavior
 * contracts stay owned by test/orchestrate.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as orch from "../src/orchestrate.ts";
import { parseKeyedField } from "../src/lib/pr-await-core.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "../src");
const LIB = join(SRC, "lib");
const ORCH_SRC = join(SRC, "orchestrate.ts");

test("surface: lib modules must not import orchestrate.ts", () => {
  // Every lib file, not a hardcoded subset: a later extraction must not
  // quietly re-introduce the cycle the latch's lazy import exists to prevent.
  for (const name of readdirSync(LIB).filter((f) => f.endsWith(".ts")).sort()) {
    const src = readFileSync(join(LIB, name), "utf8");
    assert.equal(
      /(?:from\s+|import\(\s*)["'][^"']*orchestrate\.ts["']/.test(src),
      false,
      `${name} must not import orchestrate.ts: the latch lazily imports the ` +
        `entry point, and a lib import would pull the monolith into every session`,
    );
  }
});

test("surface: parseKeyedField is last-occurrence and lives next to parseKeyedTokens", () => {
  // A handshake prints its top-level fields and then, on an actionable
  // verdict, the reviewer body beneath them — which repeats `next=`. The
  // dispatcher wants the verdict the waiter just reached, so last wins.
  assert.equal(
    parseKeyedField("next=yield round=2 next=read_comments_and_fix", "next"),
    "read_comments_and_fix",
    "the last next= wins, not the first",
  );

  // Key matching is case-insensitive — `NEXT=` is the same field as `next=`.
  // That is exactly the difference from parseField, which is first-match and
  // case-sensitive; this must not converge onto it.
  assert.equal(parseKeyedField("NEXT=Yield", "next"), "Yield");
  assert.equal(
    parseKeyedField("NEXT=Yield next=read_comments_and_fix", "next"),
    "read_comments_and_fix",
  );

  // Defined once, beside parseKeyedTokens; the barrel re-exports rather than
  // keeps a second body that can drift.
  const src = readFileSync(ORCH_SRC, "utf8");
  assert.equal(
    /function\s+parseKeyedField\b/.test(src),
    false,
    "parseKeyedField must live in pr-await-core.ts, not be redefined in orchestrate.ts",
  );
  assert.equal(typeof orch.parseKeyedField, "function", "the barrel re-exports it");
});

test("surface: editDistance is not part of the orchestrate public barrel", () => {
  // Only the failover near-miss matcher uses it; no test and no caller outside
  // the module reaches for it, so the barrel does not carry it.
  assert.notEqual(
    typeof (orch as Record<string, unknown>).editDistance,
    "function",
    "editDistance is an internal helper of the matcher, not barrel surface",
  );
});
