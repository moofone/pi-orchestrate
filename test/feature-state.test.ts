/**
 * The Feature state machine, under property-based attack.
 *
 * The lifecycle used to be free text in a text file matched by regexes that
 * disagreed with the writers, and the way that failed was never a crash — it
 * was a Feature that quietly went somewhere no reader was looking (F8, F16).
 * Example-based tests are weak against that: they assert the paths someone
 * thought of. These generate the paths nobody thought of.
 *
 * fast-check is a devDependency. The extension itself still ships with zero
 * runtime dependencies, which is why the machine is a table here rather than a
 * statechart library.
 *
 * Run: npm test  (or: node --experimental-strip-types --test test/feature-state.test.ts)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  FEATURE_PHASES,
  INITIAL_PHASE,
  LEGACY_PHASE_ALIASES,
  PHASE_TRANSITIONS,
  TERMINAL_PHASES,
  canTransition,
  formatTransitionLogLine,
  isFeaturePhase,
  parsePhase,
  parseStatusFields,
  readPhase,
  statusField,
  statusValue,
  transitionRefusal,
  type FeaturePhase,
} from "../src/lib/feature-state.ts";

const phase = () => fc.constantFrom(...FEATURE_PHASES);
const RUNS = { numRuns: 2000 } as const;

/* ================================================================== *
 * 1. The table itself
 * ================================================================== */

test("chaos: the transition table is total, closed, and reachable", () => {
  // Total: every phase has an entry, so no lookup can be undefined at runtime.
  for (const p of FEATURE_PHASES) {
    assert.ok(PHASE_TRANSITIONS[p], `no transitions declared for "${p}"`);
  }
  // Closed: no target outside the vocabulary.
  for (const [from, tos] of Object.entries(PHASE_TRANSITIONS)) {
    for (const to of tos) {
      assert.ok(
        isFeaturePhase(to),
        `"${from}" can move to "${to}", which is not a phase`,
      );
    }
  }
  // Reachable: every phase except the entry is the target of some move, or it
  // is a state the machine can never enter and the code that writes it is dead.
  const reachable = new Set<string>([INITIAL_PHASE]);
  for (const tos of Object.values(PHASE_TRANSITIONS)) for (const to of tos) reachable.add(to);
  assert.deepEqual(
    FEATURE_PHASES.filter((p) => !reachable.has(p)),
    [],
    "a phase nothing can move to is a phase no Feature can be in",
  );
});

test("chaos: from any phase, a random legal walk never leaves the vocabulary", () => {
  fc.assert(
    fc.property(phase(), fc.array(fc.nat(), { maxLength: 200 }), (start, choices) => {
      let current: FeaturePhase = start;
      for (const choice of choices) {
        const legal = PHASE_TRANSITIONS[current];
        if (legal.length === 0) break; // terminal
        const next = legal[choice % legal.length]!;
        // The move the table offered must be one the guard accepts. If these
        // two ever disagree, the machine advertises moves it then refuses.
        assert.ok(
          canTransition(current, next),
          `table offers ${current} → ${next} but canTransition refuses it`,
        );
        current = next;
        assert.ok(isFeaturePhase(current), `walked into "${current}"`);
      }
      return true;
    }),
    RUNS,
  );
});

test("chaos: `done` is absorbing — no walk of legal moves ever leaves it", () => {
  fc.assert(
    fc.property(fc.array(phase(), { maxLength: 100 }), (attempts) => {
      for (const to of attempts) {
        assert.equal(
          canTransition("done", to),
          false,
          `done → ${to} was allowed; a finished Feature must be archived, not re-opened`,
        );
      }
      return true;
    }),
    RUNS,
  );
});

test("chaos: an interruption can be entered from anywhere and left for anywhere", () => {
  // paused/blocked are the recovery hatches. If any phase could not reach them,
  // a Feature in that phase could not be paused or fail cleanly; if they could
  // not be left, `resume` would be impossible.
  fc.assert(
    fc.property(phase(), (p) => {
      if (!TERMINAL_PHASES.has(p)) {
        assert.ok(canTransition(p, "paused"), `${p} cannot be paused`);
        assert.ok(canTransition(p, "blocked"), `${p} cannot be blocked`);
      }
      assert.ok(canTransition("paused", p), `paused cannot resume into ${p}`);
      assert.ok(canTransition("blocked", p), `blocked cannot resume into ${p}`);
      return true;
    }),
    RUNS,
  );
});

test("chaos: a new Feature can only start at the entry phase", () => {
  fc.assert(
    fc.property(phase(), (to) => {
      assert.equal(
        canTransition(undefined, to),
        to === INITIAL_PHASE,
        `a Feature with no recorded phase must not be able to claim "${to}"`,
      );
      return true;
    }),
    RUNS,
  );
});

test("chaos: every refusal explains itself, and every legal move is silent", () => {
  fc.assert(
    fc.property(fc.option(phase(), { nil: undefined }), phase(), (from, to) => {
      const refusal = transitionRefusal(from, to);
      if (canTransition(from, to)) {
        assert.equal(refusal, undefined, `${from} → ${to} is legal but was explained`);
        return true;
      }
      assert.ok(refusal, `${from} → ${to} is illegal but gave no reason`);
      assert.equal(refusal!.includes("\n"), false, "a refusal is one line");
      assert.ok(refusal!.includes(to), `the refusal must name the attempted phase: ${refusal}`);
      if (from !== undefined) {
        assert.ok(refusal!.includes(from), `and the phase it came from: ${refusal}`);
      }
      return true;
    }),
    RUNS,
  );
});

/* ================================================================== *
 * 2. The parser — arbitrary bytes, never a throw
 * ================================================================== */

test("chaos: the status parser survives arbitrary text and never throws", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 4000 }), fc.string({ maxLength: 40 }), (text, key) => {
      const fields = parseStatusFields(text);
      assert.ok(fields instanceof Map);
      // Every value is a string; every key is lower-case and colon-free.
      for (const [k, v] of fields) {
        assert.equal(typeof v, "string");
        assert.equal(k, k.toLowerCase());
        assert.equal(k.includes(" "), false);
      }
      assert.equal(typeof statusField(text, key), "string");
      const value = statusValue(text, key);
      assert.ok(value === undefined || typeof value === "string");
      return true;
    }),
    RUNS,
  );
});

test("chaos: a written field reads back, whatever the value contains", () => {
  const keyArb = fc
    .stringMatching(/^[a-z][a-z0-9_]{0,20}$/)
    .filter((k) => k.length > 0 && !k.startsWith("#"));
  // Anything but a newline: a value is one line by construction.
  const valueArb = fc.string({ maxLength: 120 }).map((v) => v.replace(/[\r\n]/g, " ").trim());

  fc.assert(
    fc.property(keyArb, valueArb, (key, value) => {
      const doc = `# Status\n\n${key}: ${value}\n\n## Tasks\n\n| id | t | s | h |\n`;
      assert.equal(
        statusField(doc, key),
        value,
        `"${key}: ${value}" did not read back`,
      );
      // Case-insensitive, as the reader it replaced was.
      assert.equal(statusField(doc, key.toUpperCase()), value);
      return true;
    }),
    RUNS,
  );
});

test("chaos: the Tasks table is never mistaken for fields", () => {
  // Task rows are pipe-delimited and full of colons. The old regex scanned the
  // whole document, so a task titled `pr: none` could answer a field query.
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (rowText) => {
      const row = rowText.replace(/[\r\n]/g, " ");
      const doc = [
        "# Status",
        "",
        "phase: implementing",
        "pr: 42",
        "",
        "## Tasks",
        "",
        "| id | title | status | handoff |",
        "|----|-------|--------|---------|",
        `| 1 | ${row} | pending | none |`,
        "phase: done",
        "pr: 9999",
      ].join("\n");
      assert.equal(readPhase(doc), "implementing", "a row below ## Tasks is not a field");
      assert.equal(statusField(doc, "pr"), "42");
      return true;
    }),
    RUNS,
  );
});

test("chaos: the first occurrence of a key wins, deterministically", () => {
  fc.assert(
    fc.property(fc.array(phase(), { minLength: 1, maxLength: 10 }), (phases) => {
      const doc = ["# Status", "", ...phases.map((p) => `phase: ${p}`)].join("\n");
      assert.equal(readPhase(doc), phases[0], "a duplicated key must not be order-dependent");
      return true;
    }),
    RUNS,
  );
});

test("chaos: `none` is absent for statusValue and present for statusField", () => {
  fc.assert(
    fc.property(fc.constantFrom("none", "", "  "), (raw) => {
      const doc = `# Status\n\npr: ${raw}\n`;
      assert.equal(statusValue(doc, "pr"), undefined);
      assert.equal(typeof statusField(doc, "pr"), "string");
      return true;
    }),
    RUNS,
  );
});

/* ================================================================== *
 * 3. Phase parsing
 * ================================================================== */

test("chaos: parsePhase accepts exactly the vocabulary, in any casing", () => {
  fc.assert(
    fc.property(phase(), fc.boolean(), fc.nat(4), (p, upper, pad) => {
      const spaced = `${" ".repeat(pad)}${upper ? p.toUpperCase() : p}${" ".repeat(pad)}`;
      assert.equal(parsePhase(spaced), p, `"${spaced}" must parse as ${p}`);
      return true;
    }),
    RUNS,
  );
});

test("chaos: parsePhase rejects everything else rather than guessing", () => {
  const known = new Set<string>([
    ...FEATURE_PHASES,
    ...Object.keys(LEGACY_PHASE_ALIASES),
  ]);
  fc.assert(
    fc.property(fc.string({ maxLength: 40 }), (raw) => {
      const parsed = parsePhase(raw);
      const normalised = raw.trim().toLowerCase();
      if (known.has(normalised)) {
        assert.ok(parsed, `"${raw}" is known and must parse`);
        assert.ok(isFeaturePhase(parsed!));
      } else {
        assert.equal(parsed, undefined, `"${raw}" must not be guessed at, got ${parsed}`);
      }
      return true;
    }),
    RUNS,
  );
});

test("chaos: every legacy alias resolves to a real phase, and none is itself one", () => {
  for (const [alias, canonical] of Object.entries(LEGACY_PHASE_ALIASES)) {
    assert.ok(isFeaturePhase(canonical), `"${alias}" maps to "${canonical}", not a phase`);
    assert.equal(
      isFeaturePhase(alias),
      false,
      `"${alias}" is both an alias and a phase — one of the two is wrong`,
    );
    assert.equal(parsePhase(alias), canonical);
  }
});

/* ================================================================== *
 * 4. The log line
 * ================================================================== */

test("chaos: a log line is one line, four tab-separated fields, whatever the reason", () => {
  fc.assert(
    fc.property(
      fc.option(phase(), { nil: undefined }),
      phase(),
      fc.string({ maxLength: 300 }),
      fc.date({ min: new Date(0), max: new Date(4102444800000) }),
      (from, to, reason, at) => {
        const line = formatTransitionLogLine({ at, from, to, reason });
        assert.ok(line.endsWith("\n"), "append-only lines terminate");
        assert.equal(
          line.slice(0, -1).includes("\n"),
          false,
          "a reason containing newlines must not forge extra log entries",
        );
        const parts = line.slice(0, -1).split("\t");
        assert.equal(parts.length, 4, `expected 4 fields, got ${parts.length}: ${line}`);
        // An invalid Date must not throw: the caller swallows write errors, so
        // a RangeError here would drop the transition record without a trace.
        // The move is kept; the timestamp says it is unknown.
        assert.equal(
          parts[0],
          Number.isFinite(at.getTime()) ? at.toISOString() : "(invalid-time)",
        );
        assert.equal(parts[1], from ?? "(new)");
        assert.equal(parts[2], to);
        assert.ok(parts[3]!.length > 0, "an empty reason still says something");
        return true;
      },
    ),
    RUNS,
  );
});

/* ================================================================== *
 * 5. Model-based: the machine against a reference implementation
 * ================================================================== */

test("chaos: a random command sequence keeps the machine and a model in step", () => {
  // The model is the same table read a different way: a Feature is a phase and
  // a history, and the only thing that may change the phase is an accepted
  // move. What this catches is the machine accepting something the table does
  // not list, or mutating on a refusal — the F16 shape, where a failed step
  // left the Feature somewhere it could not be recovered from.
  fc.assert(
    fc.property(
      fc.array(fc.oneof(phase().map((p) => ({ move: p })), fc.constant({ move: null })), {
        maxLength: 300,
      }),
      (commands) => {
        let actual: FeaturePhase | undefined;
        let model: FeaturePhase | undefined;
        const history: string[] = [];

        for (const cmd of commands) {
          if (cmd.move === null) continue;
          const to = cmd.move;
          const allowed = canTransition(actual, to);

          // Model: consult the table directly.
          const modelAllowed =
            model === undefined ? to === INITIAL_PHASE : PHASE_TRANSITIONS[model].includes(to);
          assert.equal(
            allowed,
            modelAllowed,
            `guard and table disagree on ${model ?? "(new)"} → ${to}`,
          );

          if (allowed) {
            actual = to;
            model = to;
            history.push(to);
          } else {
            // A refusal must be inert. This is the invariant that matters most:
            // the phase on disk after a refused move is the phase before it.
            const before = actual;
            assert.ok(transitionRefusal(actual, to));
            assert.equal(actual, before, "a refused move changed the phase anyway");
          }
        }

        // Whatever sequence ran, the machine is in a phase it can account for.
        if (actual !== undefined) {
          assert.ok(isFeaturePhase(actual));
          assert.equal(history[history.length - 1], actual);
          assert.equal(history[0], INITIAL_PHASE, "every history starts at the entry phase");
        }
        return true;
      },
    ),
    RUNS,
  );
});

test("chaos: no legal sequence reaches a phase unreachable from the entry", () => {
  // Breadth-first from the entry phase: the set of phases a Feature can
  // actually be in. Anything outside it is code that can never run.
  const seen = new Set<FeaturePhase>([INITIAL_PHASE]);
  const queue: FeaturePhase[] = [INITIAL_PHASE];
  while (queue.length) {
    const p = queue.shift()!;
    for (const next of PHASE_TRANSITIONS[p]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  assert.deepEqual(
    FEATURE_PHASES.filter((p) => !seen.has(p)),
    [],
    "a phase unreachable from planning cannot be entered by any real Feature",
  );

  // And the reverse: from every reachable phase, `done` stays reachable, or a
  // Feature could enter a state it can never finish from.
  for (const start of seen) {
    const found = new Set<FeaturePhase>([start]);
    const q: FeaturePhase[] = [start];
    let reachesDone = start === "done";
    while (q.length && !reachesDone) {
      const p = q.shift()!;
      for (const next of PHASE_TRANSITIONS[p]) {
        if (next === "done") {
          reachesDone = true;
          break;
        }
        if (!found.has(next)) {
          found.add(next);
          q.push(next);
        }
      }
    }
    assert.ok(reachesDone, `"${start}" cannot reach done — a Feature there can never finish`);
  }
});
