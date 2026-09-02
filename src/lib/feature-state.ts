/**
 * The Feature lifecycle as data: one vocabulary, one parser, one writer.
 *
 * `phase` used to be free text in a text file, read by a `new RegExp` built per
 * call in two modules that did not agree with each other — orchestrate's was
 * case-insensitive and returned `""` for a missing key, pr-await-core's was
 * case-sensitive, required a non-empty value, and silently mapped `none` to
 * undefined. Nothing connected the writers to the readers, and they drifted:
 * `liveFeatureNeedsIdleParent` tested `^(implement|pr|qa)$` against a file that
 * says `implementing` and `feature-qa`, and appended FORBIDDEN to the system
 * prompt of every session in the repo for days (F8).
 *
 * Three things replace that:
 *
 *   - `parseStatusFields` — one line-based parse, no regex anywhere.
 *   - `FeaturePhase` — the eight values, and nothing else. Older spellings
 *     were migrated on disk, not translated at read time.
 *   - `PHASE_TRANSITIONS` — which moves are legal, so an illegal one is
 *     refused at the write instead of discovered as a wedged Feature.
 */

/* ------------------------------------------------------------------ *
 * status.md, parsed
 * ------------------------------------------------------------------ */

/**
 * `key: value` lines from a status.md, first occurrence winning.
 *
 * Deliberately not a regex. The two it replaces disagreed about case, about
 * whether an empty value counts, and about `none`; a reader that has the whole
 * record in hand cannot disagree with itself. Keys are lower-cased: status.md
 * is written by this extension in lower case, and the old orchestrate reader
 * matched case-insensitively, so anything else would silently drop fields that
 * used to be found.
 */
export function parseStatusFields(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		// `## Tasks` and the table under it are not fields, and a task row is
		// full of colons — stop there. The document's own `# Status` title is a
		// single hash and must not end the scan before it starts.
		if (line.startsWith("##")) break;
		if (!line || line.startsWith("#") || line.startsWith(">") || line.startsWith("|")) continue;
		const at = line.indexOf(":");
		if (at <= 0) continue;
		const key = line.slice(0, at).trim().toLowerCase();
		if (!key || key.includes(" ")) continue;
		if (out.has(key)) continue;
		out.set(key, line.slice(at + 1).trim());
	}
	return out;
}

/** One field, or `""`. The orchestrate-side contract. */
export function statusField(text: string, key: string): string {
	return parseStatusFields(text).get(key.toLowerCase()) ?? "";
}

/**
 * One field, or `undefined` — with `none` treated as absent.
 *
 * status.md seeds every optional field as the literal `none`, so for callers
 * asking "is this set?" the string is the same as a missing key.
 */
export function statusValue(text: string, key: string): string | undefined {
	const v = statusField(text, key);
	return v && v !== "none" ? v : undefined;
}

/* ------------------------------------------------------------------ *
 * The phases
 * ------------------------------------------------------------------ */

export const FEATURE_PHASES = [
	"planning",
	"reviewing",
	"implementing",
	"feature-qa",
	"pr",
	"done",
	"paused",
	"blocked",
] as const;

export type FeaturePhase = (typeof FEATURE_PHASES)[number];

const PHASE_SET: ReadonlySet<string> = new Set(FEATURE_PHASES);

export function isFeaturePhase(value: string): value is FeaturePhase {
	return PHASE_SET.has(value);
}

/**
 * The phase this text names, or `undefined` if it names none.
 *
 * There is no alias table. Five older spellings (`merged`, `superseded`,
 * `releasing`, `tasks-complete`, `idle`) did exist on disk; they were migrated
 * to canonical phases once, on evidence from each Feature's own `next_action`,
 * rather than translated forever at read time. `test/feature-state.test.ts`
 * walks the live orchestrator root and fails if a non-canonical phase reappears
 * — which is the signal to migrate again, not to add a mapping.
 */
export function parsePhase(raw: string | undefined): FeaturePhase | undefined {
	const v = (raw ?? "").trim().toLowerCase();
	return isFeaturePhase(v) ? v : undefined;
}

/** The phase recorded in a status.md. */
export function readPhase(status: string): FeaturePhase | undefined {
	return parsePhase(statusField(status, "phase"));
}

/* ------------------------------------------------------------------ *
 * The transitions
 * ------------------------------------------------------------------ */

/** Phases from which work can still resume. `done` is the only terminal one. */
export const TERMINAL_PHASES: ReadonlySet<FeaturePhase> = new Set<FeaturePhase>(["done"]);

/**
 * Interruptions rather than stages: a Feature in one of these is not doing
 * anything, and the interesting question is where it was when it stopped.
 */
export const INTERRUPTION_PHASES: ReadonlySet<FeaturePhase> = new Set<FeaturePhase>([
	"paused",
	"blocked",
]);

export function isInterruption(phase: FeaturePhase | undefined): boolean {
	return phase !== undefined && INTERRUPTION_PHASES.has(phase);
}

/** status.md field holding the phase an interruption suspended. */
export const PHASE_PREV_FIELD = "phase_prev";

/**
 * Where a paused or blocked Feature should go back to.
 *
 * `resume` used to re-derive this from the plan — walk the Tasks, see what is
 * unfinished, and infer a phase. That works while the answer is a Task, and
 * quietly does the wrong thing when it is not: a Feature interrupted at `pr`
 * has every Task done, so re-derivation sends it back through the
 * implementation chain instead of to the PR it already has open.
 *
 * `undefined` means the record is missing, unparseable, or names a move that
 * is no longer legal — in which case the caller should fall back to deriving,
 * not trust a stale value.
 */
export function resumePhase(status: string): FeaturePhase | undefined {
	const current = readPhase(status);
	if (!isInterruption(current)) return undefined;
	const prev = parsePhase(statusValue(status, PHASE_PREV_FIELD));
	if (!prev || isInterruption(prev)) return undefined;
	return canTransition(current, prev) ? prev : undefined;
}

/**
 * Which moves are legal, and only those.
 *
 * Self-transitions are legal wherever the phase is a loop the chain really runs
 * — a Task finishing and the next starting is `implementing → implementing`,
 * a fix round is `pr → pr`, a second QA pass is `feature-qa → feature-qa` —
 * because the point of writing the phase again is the `reason`, which is what
 * the transition log is for.
 *
 * `paused` and `blocked` can be entered from anywhere and left for anywhere:
 * they are interruptions, not stages, and `resume` puts the Feature back where
 * it was (see `phase_prev`). Nothing leaves `done`; a finished Feature is
 * archived, not re-opened.
 */
export const PHASE_TRANSITIONS: Readonly<Record<FeaturePhase, readonly FeaturePhase[]>> = {
	planning: ["planning", "reviewing", "blocked", "paused"],
	reviewing: ["reviewing", "planning", "implementing", "blocked", "paused"],
	implementing: ["implementing", "feature-qa", "pr", "done", "blocked", "paused"],
	"feature-qa": ["feature-qa", "implementing", "pr", "done", "blocked", "paused"],
	pr: ["pr", "done", "blocked", "paused"],
	done: [],
	paused: [...FEATURE_PHASES],
	blocked: [...FEATURE_PHASES],
};

/** The phase a Feature starts in. Reached from nothing, once, at seed time. */
export const INITIAL_PHASE: FeaturePhase = "planning";

export function canTransition(from: FeaturePhase | undefined, to: FeaturePhase): boolean {
	// No recorded phase is a Feature being seeded, or one whose status.md
	// predates the field. Only the entry phase may be claimed that way; anything
	// else would let a corrupt file license any move at all.
	if (from === undefined) return to === INITIAL_PHASE;
	// Writing the phase a Feature is already in is a no-op, not a move, and that
	// includes the terminal one. A merged Feature has `done` written by
	// `runFeaturePrLand`, again by the archive branch of the verdict dispatcher,
	// and again by any reconcile that re-raises the merge; refusing the repeats
	// would stamp "[phase move refused: done is terminal]" onto the next_action
	// of a Feature that finished correctly.
	if (from === to) return true;
	return PHASE_TRANSITIONS[from].includes(to);
}

/**
 * Why a move was refused, in one line, or `undefined` when it is legal.
 *
 * The message names the legal moves rather than only the illegal one: the
 * reader of this text is either a developer who just wrote a new call site or a
 * user staring at a stuck Feature, and both need to know where it can go.
 */
export function transitionRefusal(
	from: FeaturePhase | undefined,
	to: FeaturePhase,
): string | undefined {
	if (canTransition(from, to)) return undefined;
	if (from === undefined) {
		return `Cannot start a Feature in "${to}": a new Feature begins in "${INITIAL_PHASE}".`;
	}
	const legal = PHASE_TRANSITIONS[from];
	if (legal.length === 0) {
		return `"${from}" is terminal — a finished Feature is archived, not moved to "${to}".`;
	}
	return `Illegal phase move "${from}" → "${to}". From "${from}" the legal moves are: ${legal.join(", ")}.`;
}

/* ------------------------------------------------------------------ *
 * The log
 * ------------------------------------------------------------------ */

/** File name under `handoffs/` that records every accepted move. */
export const TRANSITIONS_LOG = "transitions.log";

/**
 * One line of `handoffs/transitions.log`.
 *
 * Tab-separated and append-only. The previous QA pass had to reconstruct what a
 * Feature had done from mtimes and half-written handoffs; a Feature that
 * records its own history answers "how did it get here" without that.
 */
export function formatTransitionLogLine(input: {
	at: Date;
	from: FeaturePhase | undefined;
	to: FeaturePhase;
	reason: string;
}): string {
	// `toISOString()` throws RangeError on an invalid Date. The caller wraps the
	// write in a try/catch so history is never worth a crash — which means a bad
	// clock would have thrown away the transition record *silently*. The move is
	// the thing worth keeping; a sentinel says the time is unknown rather than
	// inventing a plausible one. (Found by the property test, not by a caller.)
	const at = Number.isFinite(input.at?.getTime?.())
		? input.at.toISOString()
		: "(invalid-time)";
	const reason = input.reason.replace(/[\t\n\r]+/g, " ").trim() || "(no reason given)";
	return `${at}\t${input.from ?? "(new)"}\t${input.to}\t${reason}\n`;
}
