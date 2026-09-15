/**
 * Pi stop-hook for an unmerged PR. The session is allowed to die.
 *
 * `agent_settled` is the sensor: the model stopped. If this session's PR is
 * still open, persist the latch and ensure a detached `ghl-pr-await --daemon`
 * exists. Mechanical wait is that Rust process (0 tokens). This extension
 * does not poll, land, or spawn `pi --print` one-shots.
 *
 * A *live* parent is woken once when the PR merges or closes, or when the
 * waiter records an undelivered ACTIONABLE verdict (`read_comments_and_fix`,
 * `investigate_dead_reviewers`, `fix_command_or_environment`). Reload of an
 * already-terminal latch notifies only — the user is not in that session —
 * but an undelivered ACTIONABLE verdict still wakes: that is how review
 * fixes continue after `/rreload` without a Stop hook.
 *
 * One exception to that wake: a PR a live `/orchestrate` Feature owns. Its
 * verdict is dispatched to a writer by code, so the session holding the latch
 * gets a toast and nothing else. It is not the fixer — the parent must not
 * implement, and an adopted latch may belong to a chat that never heard of
 * the PR.
 *
 * `session_shutdown` must not kill the waiter.
 *
 * `/pr-latch` shows state, `/pr-latch clear` drops the PR and SIGTERMs its
 * waiter, `/pr-latch off` disables the sensor for this session (waiter keeps
 * going).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";
import { spawnDetachedWaiter } from "./lib/pr-await-drive.ts";
import {
	existsSync,
	mkdirSync,
	openSync,
	closeSync,
	readFileSync,
	rmSync,
	watch,
	writeFileSync,
	writeSync,
	type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readPhase, sessionOwnsFeature, statusValue } from "./lib/feature-state.ts";

import {
	ACTIONABLE,
	actionableFingerprint,
	MECHANICAL,
	REPO_ROOT,
	SHORT_MS,
	adoptableLatch,
	ensureDriver,
	findFeatureOwningPr,
	listFeaturePrOwners,
	isAcceptedFeaturePrAction,
	isDriverRunning,
	latchOff,
	logFile,
	parseAwaitCall,
	parseField,
	parsePrState,
	ghPrViewArgs,
	githubPrUrlFor,
	githubRepoShortName,
	normalizeGithubSlug,
	printedLandCommand,
	prLabel,
	prLinkLabel,
	registerLatchArm,
	requestFeaturePrDispatch,
	registerLatchTerminal,
	readLatchFile,
	readWaiterVerdict,
	readLiveRound,
	stopWaiterForPr,
	waiterLogTerminalState,
	waiterVerdictIsMissingPr,
	referenceCheckoutFor,
	repoKey,
	resolveQueryCwd,
	seedWaiterState,
	spawnCwdFor,
	stateDir,
	waiterStatePath,
	trailingCd,
	markVerdictDelivered,
	formatWaitElapsed,
	formatWaitLine,
	waitChromePhase,
	originSlug,
	prUrl,
	waiterManualFiles,
	waitProgressSequence,
	type FeaturePrOwner,
	type LatchState,
} from "./lib/pr-await-core.ts";
import {
	claimWaitDelivery,
	WAIT_OUTCOME_EVENT,
	WAIT_PROTOCOL_VERSION,
	waitOutcomeIdentity,
	type WaitOutcomeNotice,
} from "./lib/wait-protocol.ts";

export { ACTIONABLE, MECHANICAL, REPO_ROOT, parseAwaitCall, parseField, printedLandCommand, trailingCd };

export type SpawnDriver = (argv: string[]) => { pid?: number };

/**
 * How long a wait may go without asking GitHub anything at all.
 *
 * The wake-up is `fs.watch` on the state directory; this is only the backstop
 * for a waiter that died without writing a verdict. Ten minutes of latency on
 * that case buys back a `gh pr view` every fifteen seconds, per latched
 * session, forever (F18).
 */
export const WATCH_BACKSTOP_MS = 10 * 60_000;

/** Waiter verdicts that mean the PR is over, so the `gh` check is worth its cost. */
const TERMINAL_NEXT = new Set(["done", "stop"]);

/** Settle window for a burst of waiter writes. One `gh` call, not one per event. */
const WATCH_DEBOUNCE_MS = 250;

/**
 * `known` is the extension's in-memory latch. It is passed in because
 * `stateFile` is handed to the Rust waiter as `--state` and rewritten wholesale
 * by it; reading the cwd back out of that file races the waiter, and losing
 * that race used to degrade into `process.cwd()`.
 */
export function defaultSpawnDriver(stateFile: string, known?: LatchState): { pid?: number } {
	const latch =
		known ??
		(() => {
			try {
				return JSON.parse(readFileSync(stateFile, "utf8")) as LatchState;
			} catch {
				return undefined;
			}
		})();
	const spawnCwd = spawnCwdFor(latch);
	// No checkout, no daemon. `ghl-pr-await` resolves owner/repo from its own
	// cwd, so spawning anyway just burns a process on a resolve-error loop.
	if (!spawnCwd) return {};
	const log = latch
		? logFile(latch.pr, stateDir(), repoKey(latch.cwd))
		: join(stateDir(), "drive-unknown.log");
	return spawnDetachedWaiter({ stateFile, cwd: spawnCwd, logFile: log });
}

function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (result && typeof result === "object") {
		const value = result as { content?: unknown; output?: unknown };
		if (Array.isArray(value.content)) {
			return value.content.filter((part) => part?.type === "text" && typeof part.text === "string")
				.map((part) => part.text).join("\n");
		}
		if (typeof value.output === "string") return value.output;
	}
	try {
		return JSON.stringify(result) ?? "";
	} catch {
		return String(result);
	}
}

export type LatchHooks = {
	spawnDriver?: SpawnDriver;
	driverRunning?: (pr: string) => boolean;
	/**
	 * Backstop interval for the `gh pr view` check. 0 disables.
	 *
	 * This was 15s, and it was the third poller on the same PR behind the
	 * waiter and the monitor — a `gh pr view` per session per 15 seconds, for
	 * however many sessions held a latch, which is a large share of what
	 * rate-limited GitHub (F18). The wake-up is `fs.watch` on the state
	 * directory now: the waiter writes its verdict there, so the event is
	 * exactly as timely and costs nothing. What remains on a timer is the case
	 * `fs.watch` cannot cover — a waiter that died without writing anything —
	 * and ten minutes is soon enough for that.
	 */
	watchMs?: number;
	/**
	 * Cheap chrome refresh (elapsed + live `round=` from the waiter JSON).
	 * Local file reads only, never `gh`, which is why it can run at 1s while
	 * `watchMs` is minutes. 0 disables. Default 1s when `watchMs` is left at
	 * its production default.
	 */
	chromeMs?: number;
	/**
	 * Watch the state directory for waiter writes. Default on; tests that drive
	 * the tick by hand turn it off so a stray write cannot race the assertion.
	 */
	watchStateDir?: boolean;
	/**
	 * The live `/orchestrate` Feature that owns this PR, or `undefined` for a solo
	 * latch. Injectable so tests never walk the real `~/orchestrator`, whose
	 * Features claim real PR numbers.
	 */
	featureOwnedPr?: (pr: string, latch: LatchState) => FeaturePrOwner | undefined;
	/**
	 * What to do with a Feature-owned verdict. The default hands it to
	 * `orchestrate.ts`, which spawns one writer and re-awaits in code; tests
	 * capture the call instead of spawning a child.
	 *
	 * The returned action decides whether the verdict was consumed. Returning
	 * nothing means accepted, which is what the capture hooks rely on; a
	 * `refuse` leaves every waiter file undelivered for a later retry (F4).
	 */
	onFeatureActionable?: (
		ctx: ExtensionContext,
		owner: FeaturePrOwner,
		verdict: { pr: string; next: string; output: string; round?: string },
	) => void | string | Promise<void | string>;
};

type LatchSlot = {
	pendingCommands: Map<string, string>;
	seenCwds: Set<string>;
	latch: LatchState | undefined;
	disabled: boolean;
	ensuring: boolean;
	sessionId: string;
	latchFile: string | undefined;
	watchTimer: ReturnType<typeof setInterval> | undefined;
	chromeTimer: ReturnType<typeof setInterval> | undefined;
	stateWatcher: FSWatcher | undefined;
	watchDebounce: ReturnType<typeof setTimeout> | undefined;
	waitStartedAt: number;
	waitCtx: ExtensionContext | undefined;
	waitLoader: Loader | undefined;
	terminalWoken: boolean;
	lastActionableFingerprint: string | undefined;
	lastRefusedFingerprint: string | undefined;
	actionableWakeInFlight: boolean;
	deferralActive: boolean;
	/** True only after this session has seen the waiter's `--state` file. */
	waiterStateSeen: boolean;
	/** Last live ctx for this slot — reconciler wake has no ALS. */
	holdCtx: ExtensionContext | undefined;
};

const latchAls = new AsyncLocalStorage<LatchSlot>();
const latchSlots = new Map<string, LatchSlot>();

function newLatchSlot(sessionId: string): LatchSlot {
	return {
		pendingCommands: new Map(),
		seenCwds: new Set(),
		latch: undefined,
		disabled: false,
		ensuring: false,
		sessionId,
		latchFile: sessionId ? join(stateDir(), `pi-${sessionId}.latch.json`) : undefined,
		watchTimer: undefined,
		chromeTimer: undefined,
		stateWatcher: undefined,
		watchDebounce: undefined,
		waitStartedAt: 0,
		waitCtx: undefined,
		waitLoader: undefined,
		terminalWoken: false,
		lastActionableFingerprint: undefined,
		lastRefusedFingerprint: undefined,
		actionableWakeInFlight: false,
		deferralActive: false,
		waiterStateSeen: false,
		holdCtx: undefined,
	};
}

function latchSlotOf(
	ctx?: { sessionManager?: { getSessionId?: () => string } },
	sessionId?: string,
): LatchSlot {
	let id = (sessionId ?? "").trim();
	if (!id && ctx) {
		try {
			id = ctx.sessionManager?.getSessionId?.() ?? "";
		} catch {
			id = "";
		}
	}
	let slot = latchSlots.get(id);
	if (!slot) {
		slot = newLatchSlot(id);
		latchSlots.set(id, slot);
	}
	return slot;
}

function runLatchSlot<T>(slot: LatchSlot, fn: () => T): T {
	return latchAls.run(slot, fn);
}

export default function (pi: ExtensionAPI, hooks: LatchHooks = {}) {
	function st(): LatchSlot {
		const cur = latchAls.getStore();
		if (cur) return cur;
		let fb = latchSlots.get("");
		if (!fb) {
			fb = newLatchSlot("");
			latchSlots.set("", fb);
		}
		return fb;
	}
	function mustLatch(): LatchState {
		const held = st().latch;
		if (!held) throw new Error("pr-await-latch: this session has no latch");
		return held;
	}
	const pendingCommands = {
		get size() {
			return st().pendingCommands.size;
		},
		clear() {
			st().pendingCommands.clear();
		},
		get(k: string) {
			return st().pendingCommands.get(k);
		},
		set(k: string, v: string) {
			st().pendingCommands.set(k, v);
		},
		delete(k: string) {
			return st().pendingCommands.delete(k);
		},
	};
	const seenCwds = {
		add(v: string) {
			st().seenCwds.add(v);
		},
		clear() {
			st().seenCwds.clear();
		},
	};

	const watchMs = hooks.watchMs ?? WATCH_BACKSTOP_MS;
	const chromeMs = hooks.chromeMs ?? (hooks.watchMs === undefined ? 1_000 : 0);
	const watchStateDir = hooks.watchStateDir ?? true;

	function withSession<T>(
		ctx: { sessionManager?: { getSessionId?: () => string } } | undefined,
		fn: () => T,
		sessionId?: string,
	): T {
		return runLatchSlot(latchSlotOf(ctx, sessionId), fn);
	}

	const spawnDriver: SpawnDriver =
		hooks.spawnDriver ?? ((argv) => defaultSpawnDriver(argv[argv.indexOf("--state") + 1] ?? "", mustLatch()));
	const driverRunning =
		hooks.driverRunning ??
		((pr: string) => isDriverRunning(pr, undefined, undefined, st().latch?.slug));
	// Prefer the latch slug over cwd origin: ice-wt is the Feature host farm,
	// not the PR, and repoKey(ice-wt) is how icemining-devops#500 bound to
	// icemining#500. `repoKey` remains the fallback when the handshake printed
	// no URL. A session that cannot name a repo is treated as solo.
	const featureOwnedPr: NonNullable<LatchHooks["featureOwnedPr"]> =
		hooks.featureOwnedPr ??
		((pr, s) => {
			const repo = githubRepoShortName(s.slug) || repoKey(s.cwd);
			return repo ? findFeatureOwningPr(pr, { repo, head: s.head }) : undefined;
		});
	const onFeatureActionable: NonNullable<LatchHooks["onFeatureActionable"]> =
		hooks.onFeatureActionable ??
		((ctx, owner, verdict) => requestFeaturePrDispatch(pi.events, ctx, owner, verdict));

	/**
	 * The `--state` file for the latched PR: a waiter file, never this session's.
	 * Undefined before a PR is latched, because the waiter's files are keyed by
	 * PR and there is nothing to name yet.
	 */
	function waiterState(): string | undefined {
		if (!st().latch?.pr) return undefined;
		return waiterStatePath(repoKey(mustLatch().cwd), mustLatch().pr, stateDir());
	}

	/**
	 * Write the latch. One file, ours (F20).
	 *
	 * This used to also seed the waiter's `--state` path with the same blob —
	 * `pid`, `st().sessionId`, `origin` and all — which is what made a waiter rewrite
	 * readable as a session latch. The waiter's bootstrap now happens once, at
	 * spawn, in `seedWaiterState`, and carries `{pr, cwd}` only.
	 */
	function persist(): void {
		const file = st().latchFile;
		if (!file) return;
		try {
			mkdirSync(stateDir(), { recursive: true });
			const held = st().latch;
			if (held) {
				// Ownership travels with the latch: a live owner must not be adopted away.
				writeFileSync(
					file,
					JSON.stringify({ ...held, pid: process.pid, sessionId: st().sessionId }),
				);
			} else {
				// Only ours. The waiter's file is the waiter's, and it may still hold
				// an undelivered verdict for a PR this session merely stopped watching.
				rmSync(file, { force: true });
			}
		} catch {
			// Never take the session down over the latch.
		}
	}

	function setLatch(next: LatchState | undefined): void {
		if (next && !next.slug) {
			const slug = originSlug(next.cwd);
			if (slug) next = { ...next, slug, url: next.url || prUrl({ ...next, slug }) };
		} else if (next && !next.url) {
			const url = prUrl(next);
			if (url) next = { ...next, url };
		}
		if (next && !next.generation) next = { ...next, generation: randomUUID() };
		if (next && !next.ownerKind) {
			let owner: FeaturePrOwner | undefined;
			try {
				owner = featureOwnedPr(next.pr, next);
			} catch {
				owner = undefined;
			}
			next = owner
				? { ...next, ownerKind: "feature", ownerId: owner.dir }
				: { ...next, ownerKind: "session", ownerId: st().sessionId || "session" };
		}
		// Clearing the latch must not re-arm the wake guard: reportTerminal sets
		// st().terminalWoken and then clears the latch, and resetting here made the
		// once-only guard a no-op. Only a genuinely different PR resets it.
		if (next?.pr && next.pr !== st().latch?.pr) {
			st().terminalWoken = false;
			st().lastActionableFingerprint = undefined;
			st().waitStartedAt = 0;
			st().waiterStateSeen = false;
			st().deferralActive = next.origin === "observed";
		} else if (!next) {
			st().deferralActive = false;
		}
		st().latch = next;
		persist();
	}

	function writeWaitProgress(on: boolean): void {
		// Tests redirect GHL_LATCH_STATE_DIR into tmp; never write OSC there.
		const dir = process.env.GHL_LATCH_STATE_DIR;
		if (dir && dir !== join(homedir(), ".local", "state", "ghl-await")) return;
		const seq = waitProgressSequence(on);
		// Pi's TUI owns stdout. OSC must go to the real tty or iTerm never sees it.
		try {
			const fd = openSync("/dev/tty", "w");
			writeSync(fd, seq);
			closeSync(fd);
		} catch {
			try {
				process.stdout.write(seq);
			} catch {
				/* no tty */
			}
		}
	}

	/**
	 * Every file that may carry waiter state for the latched PR, newest naming
	 * scheme first — the waiter's own bookkeeping under both spellings it has
	 * used, which is every file that can carry a verdict now that TS writes none
	 * of them.
	 *
	 * `st().latchFile` is deliberately absent: `pi-<id>.latch.json` is the
	 * extension's private copy, and treating it as waiter state is the mistake
	 * ghl-monitor makes when it respawns drivers from it (F3, F20).
	 */
	function waiterStateFiles(): string[] {
		const files: string[] = [];
		const own = waiterState();
		if (own) files.push(own);
		if (st().latch?.pr) files.push(...waiterManualFiles(mustLatch().pr, stateDir(), mustLatch().slug));
		return [...new Set(files)];
	}

	function waiterRound(): { round?: string; roundTotal?: string } {
		const files: string[] = [...waiterStateFiles()];
		const latchPath = st().latchFile;
		if (latchPath) files.push(latchPath);
		for (const path of files) {
			const v = readLiveRound(path);
			if (!v?.round) continue;
			// A yield handoff carries no round=, so the waiter's file still holds
			// the previous cycle's until it polls again. Showing it is how the
			// spinner stuck on r3 across a new wait. The stale value is filtered
			// here rather than deleted out of a file this module does not own.
			if (st().latch?.roundStale && v.round === mustLatch().roundStale) continue;
			return v;
		}
		if (st().latch?.round) return { round: mustLatch().round, roundTotal: mustLatch().roundTotal };
		return {};
	}

	function waiterLastNext(): string {
		for (const path of waiterStateFiles()) {
			const v = readWaiterVerdict(path)?.lastNext;
			if (v) return v;
		}
		return st().latch?.lastNext ?? "";
	}

	function waitLine(link = false): string | undefined {
		if (!st().latch || !st().waitStartedAt) return undefined;
		// No spinner glyph here. `Loader` owns the frames and the 80ms timer;
		// baking a character into this string is why the chrome used to freeze
		// on the chrome tick. OSC 8 only on the widget — not the tab title.
		const { round, roundTotal } = waiterRound();
		const phase = waitChromePhase({
			next: waiterLastNext(),
			writerLive: featureWriterLive(mustLatch()),
		});
		return formatWaitLine({
			label: prLabel(mustLatch()),
			elapsed: formatWaitElapsed(st().waitStartedAt),
			round,
			roundTotal,
			phase,
			...(link ? { url: prUrl(mustLatch()) } : {}),
		});
	}

	function featureWriterLive(held: LatchState): boolean {
		try {
			const owner = featureOwnedPr(held.pr, held);
			if (!owner) return false;
			const raw = readFileSync(owner.statusFile, "utf8");
			const id = raw.match(/^worker_run_id:\s*(\S+)/m)?.[1];
			return Boolean(id && id !== "none");
		} catch {
			return false;
		}
	}

	function paintWaitChrome(ctx: ExtensionContext | undefined, text?: string): void {
		if (!ctx) return;
		// One chrome only: the Loader widget. setStatus shares the footer with
		// MCP/model and duplicated the wait line there.
		status(ctx);
		try {
			ctx.ui.setTitle(text ?? "");
		} catch {
			/* no UI */
		}
		try {
			if (!text) {
				ctx.ui.setWidget("pr-await", undefined);
				st().waitLoader = undefined;
				return;
			}
			const linked = waitLine(true) ?? text;
			const existingLoader = st().waitLoader;
			if (existingLoader) {
				existingLoader.setMessage(linked);
				return;
			}
			ctx.ui.setWidget(
				"pr-await",
				(tui, theme) => {
					const loader = new Loader(
						tui,
						(s) => theme.fg("accent", s),
						(s) => theme.fg("muted", s),
						linked,
					);
					(loader as Loader & { dispose: () => void }).dispose = () => {
						loader.stop();
						if (st().waitLoader === loader) st().waitLoader = undefined;
					};
					st().waitLoader = loader;
					return loader;
				},
				{ placement: "belowEditor" },
			);
		} catch {
			/* no UI */
		}
	}

	function stopWatch(): void {
		if (st().watchTimer) {
			clearInterval(st().watchTimer);
			st().watchTimer = undefined;
		}
		if (st().chromeTimer) {
			clearInterval(st().chromeTimer);
			st().chromeTimer = undefined;
		}
		if (st().watchDebounce) {
			clearTimeout(st().watchDebounce);
			st().watchDebounce = undefined;
		}
		if (st().stateWatcher) {
			try {
				st().stateWatcher?.close();
			} catch {
				/* already gone */
			}
			st().stateWatcher = undefined;
		}
		writeWaitProgress(false);
		st().waitLoader?.stop();
		st().waitLoader = undefined;
		paintWaitChrome(st().waitCtx);
		st().waitCtx = undefined;
		st().waitStartedAt = 0;
	}

	/**
	 * What the parent is told on a terminal PR.
	 *
	 * An `observed` latch — this session ran `git pr-await` or opened the PR — may
	 * be stated as fact: the session really did defer work until this merge.
	 * Anything inherited or inferred may not. The wake says where the latch came
	 * from and leaves the model free to conclude it is irrelevant, because it
	 * often is: an unrelated chat once received `Continue the work you deferred`
	 * for a devops PR it had never heard of.
	 */
	function rememberCtx(ctx: ExtensionContext): void {
		st().holdCtx = ctx;
	}

	function resumeText(s: LatchState, state: "merged" | "closed"): string {
		const label = prLabel(s);
		const where = s.url ? ` (${s.url})` : "";
		const outcome = state === "merged" ? "merged" : "closed without merging";
		let owner: FeaturePrOwner | undefined;
		try {
			owner = featureOwnedPr(s.pr, s);
		} catch {
			owner = undefined;
		}
		// Code already archived. One line in chat; not a job, not a skill read.
		if (owner) {
			return state === "merged"
				? `pr-latch: ${label} merged${where}. Feature ${owner.name} is complete. One short confirmation. Do not use tools. Do not read files. Do not run git pr-land or git wt-rm.`
				: `pr-latch: ${label} closed without merging${where}. Feature ${owner.name} did not land. One short confirmation. Do not use tools. Do not read files. Do not run git pr-land or git wt-rm.`;
		}
		if ((s.origin ?? "adopted") === "observed") {
			return state === "merged"
				? `pr-latch: ${label} merged${where}. Continue the work you deferred until this merge. Do not wait for another user message.`
				: `pr-latch: ${label} closed without merging${where}. Continue or stop based on that outcome. Do not wait for another user message.`;
		}
		const source =
			s.origin === "discovered"
				? `inferred from the branch checked out in ${s.cwd}`
				: "inherited from an earlier session, not started in this one";
		return (
			`pr-latch: ${label} ${outcome}${where}. This latch was ${source}. ` +
			`If this session was waiting on that outcome, continue that work now without waiting for another user message. ` +
			`If it was not \u2014 the PR belongs to different work, or nothing in this conversation depends on it \u2014 ` +
			`do nothing, change no files, and stay idle.`
		);
	}

	function actionableResumeText(
		s: LatchState,
		next: string,
		verdict: string | undefined,
	): string {
		const label = prLabel(s);
		const what =
			next === "read_comments_and_fix"
				? "Dispatch a fixer child (subagent tool, agent: fixer, cwd: your worktree) with this verdict. Solo mode uses the same fixer as /orchestrate; do not invoke /orchestrate. The child validates and commits without pushing; after a successful handoff, push once, then git pr-await once. Do not implement it yourself."
				: next === "investigate_dead_reviewers"
					? "Investigate and repair the failed reviewer, not the waiter. A confused/bailed reaction is a failure, not an active review. Do not post another blind retry comment or re-await without verifying that reviewer recovery actually started. If recovery is blocked, report the concrete blocker rather than waiting silently."
					: next === "fix_command_or_environment"
						? "Fix env, then git pr-await once."
						: "Act on this verdict, then git pr-await once.";
		// Adopted is a successor (reload minted a new session id). Imperative, or
		// `/rreload` repeats the #2163 stall: the model is told it may stay idle.
		const observedOrSuccessor = s.origin === "observed" || s.origin === "adopted";
		const originNote = observedOrSuccessor
			? "Do not wait for another user message."
			: `This latch was inferred from the branch checked out in ${s.cwd}. ` +
				`If this session was waiting on that verdict, continue now. ` +
				`If it was not, do nothing, change no files, and stay idle.`;
		const body = verdict?.trim() ? `\n\n${verdict.trim()}` : "";
		return `pr-latch: ${label} next=${next}. ${what} ${originNote}${body}`;
	}

	function toastText(s: LatchState, state: "merged" | "closed"): string {
		const label = prLinkLabel(s);
		return state === "merged" ? `pr-latch: ${label} merged` : `pr-latch: ${label} closed without merging`;
	}

	function lookupFeatureOwner(s: LatchState): FeaturePrOwner | undefined {
		try {
			return featureOwnedPr(s.pr, s);
		} catch {
			return undefined;
		}
	}

	function ownerIsStale(s: LatchState): boolean {
		if (s.ownerKind !== "feature" || !s.ownerId) return false;
		const owner = lookupFeatureOwner(s);
		return !owner || owner.dir !== s.ownerId;
	}

	function waitNotice(s: LatchState, outcome: string): WaitOutcomeNotice {
		const live = lookupFeatureOwner(s);
		const kind = s.ownerKind ?? (live ? "feature" : "session");
		const id = s.ownerId ?? live?.dir ?? st().sessionId ?? "session";
		return {
			v: WAIT_PROTOCOL_VERSION,
			owner: { kind, id },
			source: "pr",
			identity: waitOutcomeIdentity("pr", `${s.slug ?? "pr"}#${s.pr}`),
			generation: s.generation ?? st().sessionId ?? "none",
			outcome,
			deliveredAt: Date.now(),
		};
	}

	function emitWaitOutcome(notice: WaitOutcomeNotice): void {
		try {
			pi.events?.emit(WAIT_OUTCOME_EVENT, notice);
		} catch {
			// Optional bus. Standalone latch still delivers by owner.
		}
	}

	function wakeParent(ctx: ExtensionContext, text: string): void {
		// Observed: this session ran pr-await. A later prompt is not /pr-latch clear.
		// Adopted/discovered: a later prompt is evidence the guess was wrong.
		const origin = st().latch?.origin ?? "adopted";
		if (origin !== "observed" && !st().deferralActive) return;
		try {
			if (ctx.isIdle()) pi.sendUserMessage(text);
			else pi.sendUserMessage(text, { deliverAs: "followUp" });
		} catch {
			// print/rpc mode, or streaming without a delivery mode — toast already fired.
		}
	}

	async function reportTerminal(
		ctx: ExtensionContext,
		s: LatchState,
		state: "merged" | "closed",
		opts: { wake: boolean } = { wake: true },
	): Promise<void> {
		if (st().terminalWoken) return;
		st().terminalWoken = true;
		stopWatch();
		// Spent bookkeeping: a waiter-written `manual-<pr>.json` for a PR that is
		// already over must not be re-adopted. Leaving it is how
		// `manual-pi-subagents-2150.json` survived icemining#2150's merge.
		for (const path of waiterManualFiles(s.pr, stateDir(), s.slug)) {
			try {
				rmSync(path, { force: true });
			} catch {
				// Cleanup is best-effort; never take the session down over it.
			}
		}
		status(ctx);
		notify(ctx, toastText(s, state));
		// A 404 waiter keeps REST-polling after the latch is spent. SIGTERM it
		// here: `/pr-latch clear` already does, and a terminal PR is the same end.
		stopWaiterForPr(s.pr, stateDir(), s.slug);
		const notice = waitNotice(s, state);
		const firstDelivery = claimWaitDelivery(stateDir(), notice);
		if (firstDelivery) emitWaitOutcome(notice);
		// Wake while the latch still names origin; setLatch(undefined) drops it.
		// Duplicates, restarts, and stale Feature owners notify without inference.
		if (opts.wake && firstDelivery && !ownerIsStale(s)) wakeParent(ctx, resumeText(s, state));
		setLatch(undefined);
	}

	/**
	 * Terminal PR: a Feature-owned one updates status.md in code (`next=done` /
	 * `stop`) so `/orchestrate` is not stuck on `pr-await next=yield` after the
	 * waiter has already landed. The parent is still woken on merge/close — the
	 * no-wake exception is ACTIONABLE verdicts only.
	 */
	async function finishTerminal(
		ctx: ExtensionContext,
		s: LatchState,
		state: "merged" | "closed",
		opts: { wake: boolean } = { wake: true },
	): Promise<void> {
		await withSession(ctx, async () => {
			if (st().terminalWoken) return;
			rememberCtx(ctx);
			let owner: FeaturePrOwner | undefined;
			try {
				owner = featureOwnedPr(s.pr, s);
			} catch {
				owner = undefined;
			}
			if (owner) {
				try {
					await onFeatureActionable(ctx, owner, {
						pr: s.pr,
						next: state === "merged" ? "done" : "stop",
						output: "",
					});
				} catch (err) {
					notify(
						ctx,
						`pr-latch: dispatching ${prLinkLabel(s)} ${state} to Feature ${owner.name} failed ` +
							`(${String(err)}).`,
					);
				}
			}
			// Dispatch may drop ALS the same way `pi.exec` does.
			await withSession(ctx, () => reportTerminal(ctx, s, state, opts));
		});
	}

	/**
	 * Does the waiter's own state say this PR is finished?
	 *
	 * Asked before spending a `gh pr view`. A waiter that has landed or seen the
	 * PR closed says so in the file it just wrote — and it deletes that file
	 * once the PR is terminal, so a state path that has vanished under a live
	 * mustLatch() is the same news by another route.
	 */
	function waiterSaysTerminal(): boolean {
		return diskOutcome() !== undefined || waiterMechanical() || waiterVanishedAfterSeen();
	}

	function waiterVanishedAfterSeen(): boolean {
		const own = waiterState();
		if (own && existsSync(own)) {
			st().waiterStateSeen = true;
			return false;
		}
		// A file this session never saw is not "the waiter deleted it after land".
		// Feature-owned handoff used to treat that missing path as terminal and
		// spend a `gh pr view` on every log append (LATCH_BUGS L2).
		return Boolean(own && st().waiterStateSeen);
	}

	function waiterMechanical(): boolean {
		for (const path of waiterStateFiles()) {
			const next = readWaiterVerdict(path)?.lastNext;
			if (next && MECHANICAL.has(next)) return true;
		}
		return false;
	}

	/**
	 * Terminal outcome already on disk — log, JSON, or status.md. Enough to
	 * wake without GitHub, which is how a rate-limit used to keep a merge silent.
	 */
	function diskOutcome(): "merged" | "closed" | undefined {
		const held = st().latch;
		if (!held) return undefined;
		try {
			const owner = featureOwnedPr(held.pr, held);
			if (owner) {
				const text = readFileSync(owner.statusFile, "utf8");
				if (readPhase(text) === "done") return "merged";
				const next = (statusValue(text, "next_action") ?? "").toLowerCase();
				if (next === "landed") return "merged";
				if (/\bclosed\b/.test(next) && !/\bmerged\b/.test(next)) return "closed";
			}
		} catch {
			/* ownership or status.md unreadable is not terminal */
		}
		for (const path of waiterStateFiles()) {
			const next = readWaiterVerdict(path)?.lastNext;
			if (next && TERMINAL_NEXT.has(next)) return next === "stop" ? "closed" : "merged";
		}
		return waiterLogTerminalState(held.pr, undefined, held.slug);
	}

	/**
	 * Fire-and-forget watch I/O. `mustLatch()` after `await pi.exec` used to
	 * become uncaughtException and kill the TUI when ALS dropped or the latch
	 * was cleared mid-tick.
	 */
	function spawnWatchTick(slot: LatchSlot, work: () => Promise<void>): void {
		void runLatchSlot(slot, async () => {
			try {
				await work();
			} catch {
				// A watch tick must never take the process down.
			}
		});
	}

	/**
	 * A waiter write landed in the state directory. Everything this does is
	 * local file reads except the `gh` call, which is spent only when the
	 * waiter's own state already says the PR is over — the whole point of F18
	 * is that GitHub is asked by one process, not by every session watching.
	 */
	function onStateDirChange(ctx: ExtensionContext): void {
		if (st().watchDebounce || st().disabled || !st().latch) return;
		const slot = st();
		st().watchDebounce = setTimeout(() => {
			runLatchSlot(slot, () => {
				st().watchDebounce = undefined;
				if (st().disabled || !st().latch) return;
				paintWaitChrome(ctx, waitLine());
				spawnWatchTick(slot, async () => {
					const outcome = diskOutcome();
					if (outcome) {
						const held = st().latch;
						if (!held) return;
						await finishTerminal(ctx, held, outcome);
						return;
					}
					await checkActionable(ctx);
					if (waiterSaysTerminal()) await checkTerminal(ctx);
				});
			});
		}, WATCH_DEBOUNCE_MS);
		st().watchDebounce?.unref?.();
	}

	function startWatch(ctx: ExtensionContext): void {
		if (watchMs <= 0 || st().disabled || !st().latch) {
			stopWatch();
			return;
		}
		const slot = st();
		rememberCtx(ctx);
		st().waitCtx = ctx;
		if (!st().waitStartedAt) st().waitStartedAt = Date.now();
		writeWaitProgress(true);
		paintWaitChrome(ctx, waitLine());
		if (!st().watchTimer) {
			st().watchTimer = setInterval(() => {
				runLatchSlot(slot, () => {
					paintWaitChrome(ctx, waitLine());
					spawnWatchTick(slot, async () => {
						const outcome = diskOutcome();
						if (outcome) {
							const held = st().latch;
							if (!held) return;
							await finishTerminal(ctx, held, outcome);
							return;
						}
						await checkTerminal(ctx);
						await checkActionable(ctx);
					});
				});
			}, watchMs);
			st().watchTimer?.unref?.();
		}
		if (!st().chromeTimer && chromeMs > 0) {
			st().chromeTimer = setInterval(() => {
				runLatchSlot(slot, () => {
					paintWaitChrome(ctx, waitLine());
					// status.md lives under ~/orchestrator, not the waiter dir.
					// Reconciler archive never fires fs.watch; this is how an idle
					// session notices a merge another process already wrote.
					if (st().terminalWoken || !st().latch) return;
					const outcome = diskOutcome();
					if (!outcome) return;
					spawnWatchTick(slot, async () => {
						if (st().terminalWoken || !st().latch) return;
						const held = st().latch;
						if (!held) return;
						await finishTerminal(ctx, held, outcome);
					});
				});
			}, chromeMs);
			st().chromeTimer?.unref?.();
		}
		if (!st().stateWatcher && watchStateDir) {
			try {
				mkdirSync(stateDir(), { recursive: true });
				st().stateWatcher = watch(stateDir(), { persistent: false }, () => {
					runLatchSlot(slot, () => onStateDirChange(ctx));
				});
				// A directory that cannot be watched is not a reason to stop
				// waiting: the backstop timer still runs.
				st().stateWatcher?.on("error", () => {
					runLatchSlot(slot, () => {
						st().stateWatcher = undefined;
					});
				});
			} catch {
				st().stateWatcher = undefined;
			}
		}
	}

	async function checkTerminal(ctx: ExtensionContext): Promise<void> {
		const held = st().latch;
		if (st().disabled || !held) {
			stopWatch();
			return;
		}
		const state = await prState(held.pr, held.cwd, held.slug);
		if (state !== "merged" && state !== "closed") return;
		// `pi.exec` can drop AsyncLocalStorage. Re-bind before touching the slot.
		await withSession(ctx, async () => {
			if (st().disabled || st().terminalWoken) return;
			const still = st().latch;
			if (!still || still.pr !== held.pr) return;
			await finishTerminal(ctx, still, state);
		});
	}

	/**
	 * The Grok/Claude stop-hook injects one undelivered ACTIONABLE verdict on
	 * Stop. Pi has no Stop hook — the session has already yielded — so the
	 * mustLatch() must deliver that verdict itself or review fixes never start.
	 */
	async function checkActionable(ctx: ExtensionContext): Promise<void> {
		const held = st().latch;
		if (st().disabled || !held) return;
		const pr = held.pr;
		const candidates = waiterStateFiles();
		let hit:
			| { path: string; lastNext: string; verdict?: string; round?: string }
			| undefined;
		for (const path of candidates) {
			const v = readWaiterVerdict(path);
			if (!v?.lastNext || !ACTIONABLE.has(v.lastNext) || v.verdictDelivered) continue;
			if (v.pr && v.pr !== pr) continue;
			hit = { path, lastNext: v.lastNext, verdict: v.verdict, round: v.round };
			break;
		}
		if (!hit) return;
		// Waiter REST 404 on get-a-pull-request is a missing PR, not an env fix.
		if (waiterVerdictIsMissingPr(hit.verdict)) {
			await finishTerminal(ctx, held, "closed");
			return;
		}
		const fp = actionableFingerprint({
			next: hit.lastNext,
			verdict: hit.verdict,
			round: hit.round,
		});
		if (fp === st().lastActionableFingerprint) return;
		// A verdict this session already tried and had refused is re-attempted on
		// every watch tick — that retry is how it drains when the chain lock is
		// released — but it must not re-announce itself each time.
		const repeatOfRefusal = fp === st().lastRefusedFingerprint;
		if (!repeatOfRefusal) {
			status(ctx, `pr-await ${prLabel(held)} · ${hit.lastNext}`);
			notify(ctx, `pr-latch: ${prLinkLabel(held)} ${hit.lastNext}`);
		}

		// A PR a live Feature owns is fixed by a writer that code dispatches, so
		// this session is told nothing to do. Waking it would make whoever holds
		// the latch the fixer: the parent orchestrator, which must not implement,
		// or — for an adopted mustLatch() — a chat that never heard of the PR.
		let owner: FeaturePrOwner | undefined;
		try {
			owner = featureOwnedPr(pr, held);
		} catch {
			// Ownership could not be established. Solo is the pre-Feature behaviour
			// and the only one that keeps a plain session's fix moving.
			owner = undefined;
		}
		if (owner) {
			if (!owner.worktree) {
				notify(
					ctx,
					`pr-latch: ${prLinkLabel(held)} ${hit.lastNext} belongs to Feature ${owner.name}, which ` +
						`records no worktree — nothing dispatched. Set \`worktree:\` in ${owner.statusFile}, ` +
						`then /orchestrate resume ${owner.name}.`,
				);
				return;
			}
			// What the verdict costs — a writer, a re-await, nothing — is the
			// dispatcher's call, and it toasts that itself. This one only says the
			// verdict left this session.
			if (!repeatOfRefusal) {
				notify(
					ctx,
					`pr-latch: ${prLinkLabel(held)} ${hit.lastNext} → Feature ${owner.name}: dispatched by ` +
						`/orchestrate. This session stays idle.`,
				);
			}
			// Dispatch decides whether the verdict was consumed. Marking it first
			// is F4: a `refuse` while a fixer holds the chain lock threw the
			// finding away, and the waiter never re-emits it.
			let action: unknown;
			try {
				action = await onFeatureActionable(ctx, owner, {
					pr,
					next: hit.lastNext,
					output: hit.verdict ?? "",
					round: hit.round,
				});
			} catch (err) {
				// A failed dispatch is reported, never converted into a parent turn:
				// the session that holds the latch is still not the fixer. The
				// verdict stays on disk so a later attempt can still find it.
				await withSession(ctx, () => {
					st().lastRefusedFingerprint = fp;
				});
				notify(
					ctx,
					`pr-latch: dispatching ${prLinkLabel(held)} ${hit.lastNext} to Feature ${owner.name} failed ` +
						`(${String(err)}). Run /orchestrate resume ${owner.name}.`,
				);
				return;
			}
			await withSession(ctx, () => {
				if (!isAcceptedFeaturePrAction(action)) {
					// Refused: leave every file undelivered. The reconciler and the next
					// watch tick both retry it once the writer that holds the Feature is
					// done. `st().lastActionableFingerprint` stays unset so that retry works.
					st().lastRefusedFingerprint = fp;
					return;
				}
				st().lastActionableFingerprint = fp;
				st().lastRefusedFingerprint = undefined;
				for (const path of candidates) markVerdictDelivered(path, fp);
			});
			return;
		}
		// Solo: the wake itself is the delivery; the session dispatches the shared
		// fixer child (git-workflow skill) instead of implementing the findings.
		const slot = st();
		if (slot.actionableWakeInFlight) return;
		if (held.origin !== "observed" && !slot.deferralActive) return;
		slot.actionableWakeInFlight = true;
		try {
			await pi.sendUserMessage(actionableResumeText(held, hit.lastNext, hit.verdict),
				ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			// A delayed delivery must not acknowledge a later handoff/session.
			if (slot.latch?.generation !== held.generation) return;
			slot.lastActionableFingerprint = fp;
			slot.lastRefusedFingerprint = undefined;
			for (const path of candidates) markVerdictDelivered(path, fp);
		} catch (error) {
			slot.lastRefusedFingerprint = fp;
			notify(ctx, `pr-latch: recovery wake failed (${String(error)}); verdict retained for retry.`);
		} finally {
			slot.actionableWakeInFlight = false;
		}
	}

	function notify(ctx: ExtensionContext, text: string): void {
		try {
			ctx.ui.notify(text, "info");
		} catch {
			// No UI in print/rpc mode.
		}
	}

	function status(ctx: ExtensionContext, text?: string): void {
		try {
			ctx.ui.setStatus("pr-await", text ?? "");
		} catch {
			// No UI in print/rpc mode.
		}
	}

	async function sh(cmd: string, args: string[], cwd: string): Promise<{ out: string; ok: boolean }> {
		try {
			const res = await pi.exec(cmd, args, { cwd, timeout: SHORT_MS });
			return { out: `${res.stdout}\n${res.stderr}`, ok: res.code === 0 && !res.killed };
		} catch (err) {
			return { out: String(err), ok: false };
		}
	}

	async function prState(pr: string, cwd: string, slug?: string): Promise<ReturnType<typeof parsePrState>> {
		const args = ghPrViewArgs(pr, slug);
		const tried = new Set<string>();
		for (const candidate of [resolveQueryCwd(cwd), cwd, referenceCheckoutFor(cwd)]) {
			if (!candidate || tried.has(candidate)) continue;
			tried.add(candidate);
			const { out, ok } = await sh("gh", args, candidate);
			const st = parsePrState(out, ok);
			if (st !== "unknown") return st;
			if (waiterVerdictIsMissingPr(out) && (await repoAccessible(candidate, slug))) return "closed";
		}
		return "unknown";
	}

	async function repoAccessible(cwd: string, slug?: string): Promise<boolean> {
		const repo = normalizeGithubSlug(slug) || originSlug(cwd) || "";
		if (!repo.includes("/")) return false;
		const { ok } = await sh("gh", ["repo", "view", repo, "--json", "name"], cwd);
		return ok;
	}

	function absorb(command: string, output: string, ctx: ExtensionContext): void {
		const call = parseAwaitCall(command);
		const shellCwd = trailingCd(command, /\b(?:git\s+(?:-C\s+)?|gh\s+pr\s+)/) ?? ctx.cwd;
		const cwd = call?.cwd ? resolve(shellCwd, call.cwd) : shellCwd;
		if (cwd.startsWith(REPO_ROOT)) seenCwds.add(cwd);

		// pr-land --continue N must not retarget the latch. That is how a
		// leftover land of icemining#10 stole sessions that were driving
		// something else.
		if (/\bgit\s+pr-land\b/.test(command) && !/\bgit\s+pr-await\b/.test(command)) return;

		const created = /\bgh\s+pr\s+create\b/.test(command)
			? output.match(/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/)?.[1]
			: undefined;

		const pr = call?.pr ?? created;
		if (!pr) return;

		const next = parseField(output, "next");
		if (call && next === "yield") {
			// An explicit new wait must not inherit the previous attempt's
			// suppression when the same reviewer fails on the same head again.
			st().lastActionableFingerprint = undefined;
			st().lastRefusedFingerprint = undefined;
		}
		const cursor = parseField(output, "cursor") ?? call?.cursor;
		const head = parseField(output, "head");
		const round = parseField(output, "round");
		const roundTotal = parseField(output, "round_total");
		const fromText = githubPrUrlFor(pr, output) ?? githubPrUrlFor(pr, parseField(output, "url"));
		const url = fromText?.url;
		const slug = fromText?.slug;
		// First-hand: this session ran the command, so it may later be told that it
		// deferred work until this PR resolves.
		setLatch({
			pr,
			cursor,
			lastNext: next,
			cwd,
			head,
			url,
			slug,
			round,
			roundTotal,
			origin: "observed",
		});
		// A yield handoff has no round=. Leaving the previous cycle's r3 in
		// the waiter JSON is why the spinner stayed on 3 after a new wait.
		if (!round) markInheritedWaiterRound();
	}

	/**
	 * Remember the `round=` a new wait inherits, so chrome can ignore it.
	 *
	 * A yield handoff has no `round=`; the waiter's file keeps the previous
	 * cycle's until its next poll, and painting that is why the spinner stayed
	 * on r3 after a fresh wait. The old fix deleted the field out of the
	 * waiter's own file — a second writer on a file this module does not own
	 * (F20). Recording the value is the same answer with one writer: the moment
	 * the waiter writes any other round, the filter in `waiterRound` stops
	 * matching and live progress appears.
	 */
	function markInheritedWaiterRound(): void {
		if (!st().latch) return;
		let stale: string | undefined;
		for (const path of [...waiterStateFiles(), st().latchFile].filter(
			(p): p is string => Boolean(p),
		)) {
			const v = readLiveRound(path);
			if (v?.round) {
				stale = v.round;
				break;
			}
		}
		if (!stale) return;
		st().latch = { ...mustLatch(), roundStale: stale };
		persist();
	}

	function ensureWaiterIfNeeded(): { action: "spawned" | "already" | "skipped" } | undefined {
		const running = driverRunning(mustLatch().pr);
		if (running) return { action: "already" };
		if (!spawnCwdFor(mustLatch())) return undefined;
		const statePath = waiterStatePath(repoKey(mustLatch().cwd), mustLatch().pr, stateDir());
		seedWaiterState(statePath, { pr: mustLatch().pr, cwd: mustLatch().cwd });
		return ensureDriver({
			pr: mustLatch().pr,
			stateFile: statePath,
			spawn: spawnDriver,
			running: false,
		});
	}

	async function handoff(ctx: ExtensionContext, opts: { wakeOnTerminal?: boolean } = {}): Promise<void> {
		if (st().disabled || st().ensuring || latchOff()) return;
		const slot = st();
		slot.ensuring = true;
		try {
			const held = slot.latch;
			if (!held) return;
			rememberCtx(ctx);

			const recorded = diskOutcome();
			if (recorded) {
				await finishTerminal(ctx, held, recorded, { wake: !!opts.wakeOnTerminal });
				return;
			}

			const state = await prState(held.pr, held.cwd, held.slug);
			await runLatchSlot(slot, async () => {
				const live = st().latch;
				if (!live || live.pr !== held.pr) return;
				if (state === "closed" || state === "merged") {
					await finishTerminal(ctx, live, state, { wake: !!opts.wakeOnTerminal });
					return;
				}

				persist();

			// One waiter, pid-locked. Feature-owned used to skip spawn entirely and
			// die if the reconciler was not running in this process. Restarting a
			// dead waiter is not F3 — F3 was spawning while one was already alive.
			let owned = false;
			try {
				owned = Boolean(featureOwnedPr(mustLatch().pr, mustLatch()));
			} catch {
				owned = false;
			}
			if (owned) {
				const result = ensureWaiterIfNeeded();
				status(ctx, `pr-await ${prLabel(mustLatch())} · Feature-owned`);
				notify(
					ctx,
					result?.action === "spawned"
						? `pr-latch: ${prLinkLabel(mustLatch())} Feature-owned — waiter restarted (none was alive)`
						: `pr-latch: ${prLinkLabel(mustLatch())} belongs to a live /orchestrate Feature — ` +
							`this session watches; a waiter is ${result ? "already running" : "not startable here"}.`,
				);
				startWatch(ctx);
				await checkActionable(ctx);
				return;
			}

			const running = driverRunning(mustLatch().pr);
			if (!running && !spawnCwdFor(mustLatch())) {
				if (mustLatch().slug) {
					status(ctx, `pr-await ${prLabel(mustLatch())} · watching`);
					startWatch(ctx);
					await checkActionable(ctx);
					return;
				}
				// An open PR with no waiter and nowhere to start one. Say so loudly:
				// silence here is what left icemining#2163 open with a dead daemon.
				status(ctx, `pr-await ${prLabel(mustLatch())} · NO WAITER`);
				notify(
					ctx,
					`pr-latch: cannot start a waiter for ${prLinkLabel(mustLatch())} — ${mustLatch().cwd} is not a git checkout ` +
						`and has no reference checkout. Re-run \`git pr-await ${mustLatch().pr}\` from inside the PR's worktree.`,
				);
				return;
			}
			const result = ensureWaiterIfNeeded() ?? { action: "skipped" as const };
			status(ctx, `pr-await ${prLabel(mustLatch())} · handed off`);
			notify(
				ctx,
				result.action === "already"
					? `pr-latch: ${prLinkLabel(mustLatch())} waiter already running (detached)`
					: `pr-latch: handed off ${prLinkLabel(mustLatch())} — session may end, wait continues at 0 tokens`,
			);
				startWatch(ctx);
				// Immediate: `/rreload` and settle-with-a-waiting-verdict must not
				// wait for a state-dir event. No-op when lastNext is yield/poll_again.
				await checkActionable(ctx);
			});
		} finally {
			slot.ensuring = false;
		}
	}

	function killDriver(pr: string): void {
		stopWaiterForPr(pr, stateDir(), st().latch?.pr === pr ? mustLatch().slug : undefined);
	}

	// `/orchestrate` runs `git pr-await` via `pi.exec`, which is not a bash tool
	// event, so absorb never sees it. Code calls `armObservedLatch` after a
	// yield handshake; this is that arm. `orchestrate.ts` must not import this
	// file — the registry lives in `pr-await-core.ts`.
	registerLatchArm((ctx, seed) => {
		void withSession(
			ctx as ExtensionContext,
			async () => {
				if (st().disabled || latchOff()) return;
				setLatch({
					pr: String(seed.pr),
					cwd: seed.cwd,
					lastNext: seed.lastNext ?? "yield",
					url: seed.url,
					slug: seed.slug,
					head: seed.head,
					origin: "observed",
					round: seed.round,
					roundTotal: seed.roundTotal,
				});
				await handoff(ctx as ExtensionContext, { wakeOnTerminal: true });
			},
			seed.sessionId,
		).catch(() => {});
	}, pi.events);

	registerLatchTerminal((notice) => {
		let hit = false;
		for (const slot of latchSlots.values()) {
			const held = slot.latch;
			if (!held || slot.disabled) continue;
			if (String(held.pr) !== String(notice.pr)) continue;
			const observed = (held.origin ?? "adopted") === "observed";
			if (notice.sessionId) {
				const named = slot.sessionId && notice.sessionId === slot.sessionId;
				// Parent session id and the session that ran pr-await can differ.
				// Waking only the parent left 2258's latch holder silent.
				if (!named && !observed) continue;
			} else if (!observed) {
				continue;
			}
			const ctx = slot.holdCtx ?? slot.waitCtx;
			if (!ctx) continue;
			hit = true;
			// Body is sync until the first await; reportTerminal has none, so
			// terminalWoken is set before the reconciler's caller continues.
			void runLatchSlot(slot, () => reportTerminal(ctx, held, notice.state)).catch(() => {});
		}
		return hit;
	}, pi.events);

	pi.on("session_start", async (event, ctx) => withSession(ctx, async () => {
		const id = ctx.sessionManager.getSessionId();
		st().sessionId = id;
		rememberCtx(ctx);
		st().latchFile = id ? join(stateDir(), `pi-${id}.latch.json`) : undefined;
		seenCwds.clear();
		pendingCommands.clear();
		st().deferralActive = false;
		if (!st().latchFile) return;

		const reason =
			event && typeof event === "object" && typeof (event as { reason?: unknown }).reason === "string"
				? (event as { reason: string }).reason
				: "startup";

		// This session's own mustLatch(), and only that. The fallback used to be the
		// shared `pi-<id>.json`, which by then was whatever the waiter had last
		// written — a waiter rewrite read back as a session latch (F20).
		const latchPath = st().latchFile;
		st().latch = latchPath ? readLatchFile(latchPath) : undefined;
		if (st().latch) {
			// Same-session `/reload`. The user is in this chat.
			st().deferralActive = (mustLatch().origin ?? "adopted") === "observed";
			if (!st().disabled) void handoff(ctx, { wakeOnTerminal: true }).catch(() => {});
			return;
		}

		// A pi reload mints a NEW session id, so the previous session's latch is
		// orphaned under a name we would never look for. Re-arm only a Feature
		// this session actually owns (parent_session_id / parent_session_file).
		// Never pick "the newest Feature PR in this repo" — every chat in
		// ~/Dev/git/icemining shares that cwd, which is how auth and graph tabs
		// woke up as pearl-cert-submit-gate-2 after /reload.
		//
		// `reason === "new"` must not skip this: /reload often mints a new id on
		// the same session file. Skipping left 2258 as "open, next=yield" in chat
		// after reload while status.md already said landed.
		if (st().disabled || latchOff()) return;

		let ownId = st().sessionId;
		let sessionFile = "";
		try {
			sessionFile = ctx.sessionManager.getSessionFile() ?? "";
		} catch {
			sessionFile = "";
		}
		const owned = listFeaturePrOwners({
			phases: ["pr", "paused", "blocked", "feature-qa", "implementing"],
		}).filter((owner) => {
			try {
				return sessionOwnsFeature(readFileSync(owner.statusFile, "utf8"), {
					id: ownId,
					file: sessionFile,
				});
			} catch {
				return false;
			}
		});
		const waiting = owned.filter((o) => (o.phase ?? "").toLowerCase() === "pr");
		const bind = waiting.length === 1 ? waiting[0] : undefined;
		if (bind) {
			const owner = bind;
			const wt =
				owner.worktree && existsSync(owner.worktree) ? owner.worktree : ctx.cwd;
			setLatch({
				pr: owner.pr,
				cwd: wt,
				url: owner.slug?.includes("/")
					? `https://github.com/${owner.slug}/pull/${owner.pr}`
					: undefined,
				slug: owner.slug,
				lastNext: "yield",
				origin: "observed",
			});
			st().deferralActive = true;
			void handoff(ctx, { wakeOnTerminal: true }).catch(() => {});
			return;
		}
		if (reason === "new") return;
		const repo = repoKey(ctx.cwd);
		if (!repo) return;
		const adopted = adoptableLatch(stateDir(), {
			exclude: st().latchFile ? [st().latchFile as string] : [],
			repo,
			cwd: ctx.cwd,
		});
		if (!adopted) return;
		setLatch({ ...adopted, origin: "adopted" });
		// Successor of a wait in this worktree: still waiting, even though origin
		// is adopted (the wake must not claim this session deferred the work).
		st().deferralActive = true;
		notify(ctx, `pr-latch: adopted ${prLinkLabel(adopted)} from a previous session`);
		void handoff(ctx, { wakeOnTerminal: adopted.source !== "manual" }).catch(() => {});
	}));

	pi.on("session_shutdown", async (_event, ctx) => withSession(ctx, () => {
		// Leave the waiter. Aborting it was the D-2 self-inflicted stall.
		stopWatch();
		pendingCommands.clear();
		seenCwds.clear();
		const id = st().sessionId;
		if (id) latchSlots.delete(id);
	}));

	pi.on("input", async (event, ctx) => withSession(ctx, () => {
		const source =
			event && typeof event === "object" ? (event as { source?: unknown }).source : undefined;
		// Our own merge/ACTIONABLE injection is source "extension". A real user
		// prompt means this session has moved on; toast on merge, do not hijack.
		if (source !== "extension") {
			const origin = st().latch?.origin ?? "adopted";
			if (origin === "adopted" || origin === "discovered") st().deferralActive = false;
		}
		return { action: "continue" as const };
	}));

	pi.on("tool_execution_start", async (event, ctx) => withSession(ctx, () => {
		if (event.toolName !== "bash") return;
		const command = (event.args as { command?: string } | undefined)?.command;
		if (!command) return;
		const cwd = trailingCd(command);
		if (cwd) seenCwds.add(cwd);
		if ((parseAwaitCall(command) && /\bpr-await\b/.test(command)) || /\bgh\s+pr\s+create\b/.test(command)) {
			pendingCommands.set(event.toolCallId, command);
		}
	}));

	pi.on("tool_execution_end", async (event, ctx) => withSession(ctx, () => {
		const command = pendingCommands.get(event.toolCallId);
		if (!command) return;
		pendingCommands.delete(event.toolCallId);
		if (event.isError) return;
		absorb(command, resultText(event.result), ctx);
	}));

	pi.on("agent_settled", async (_event, ctx) => withSession(ctx, () => {
		if (st().disabled || !ctx.isIdle()) return;
		void handoff(ctx, { wakeOnTerminal: true }).catch(() => {});
	}));

	pi.registerCommand("pr-latch", {
		description: "Show, clear, or disable the background git pr-await latch",
		handler: async (args, ctx) => withSession(ctx, async () => {
			const arg = args.trim();
			if (arg === "clear") {
				stopWatch();
				if (st().latch) killDriver(mustLatch().pr);
				setLatch(undefined);
				status(ctx);
				ctx.ui.notify("pr-latch cleared (waiter stopped)", "info");
				return;
			}
			if (arg === "off") {
				st().disabled = true;
				status(ctx);
				ctx.ui.notify("pr-latch sensor disabled for this session (waiter, if any, keeps going)", "info");
				return;
			}
			if (arg === "on") {
				st().disabled = false;
				ctx.ui.notify("pr-latch enabled", "info");
				return;
			}
			const held = st().latch;
			ctx.ui.notify(
				st().disabled
					? "pr-latch: sensor disabled (/pr-latch on to re-enable)"
					: held
						? `pr-latch: PR #${held.pr} · next=${held.lastNext ?? "?"} · ` +
							`${driverRunning(held.pr) ? "waiter running" : "no waiter"} · ${held.cwd}`
						: "pr-latch: no PR latched",
				"info",
			);
		}),
	});
}
