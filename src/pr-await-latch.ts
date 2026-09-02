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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	ACTIONABLE,
	actionableFingerprint,
	MECHANICAL,
	REPO_ROOT,
	SHORT_MS,
	adoptableLatch,
	ensureDriver,
	findFeatureOwningPr,
	isAcceptedFeaturePrAction,
	isDriverRunning,
	latchOff,
	logFile,
	parseAwaitCall,
	parseField,
	parsePrState,
	pidAlive,
	printedLandCommand,
	readPid,
	isReferenceCheckout,
	prLabel,
	prLinkLabel,
	registerLatchArm,
	readLatchFile,
	readWaiterVerdict,
	readLiveRound,
	referenceCheckoutFor,
	repoKey,
	resolveQueryCwd,
	spawnCwdFor,
	stateDir,
	trailingCd,
	markVerdictDelivered,
	formatWaitElapsed,
	formatWaitLine,
	originSlug,
	prUrl,
	waiterManualFiles,
	waiterPaths,
	waiterPidFiles,
	waitProgressSequence,
	type FeaturePrOwner,
	type LatchState,
} from "./lib/pr-await-core.ts";

export { ACTIONABLE, MECHANICAL, REPO_ROOT, parseAwaitCall, parseField, printedLandCommand, trailingCd };

const DRIVE_BIN =
	process.env.GHL_PR_AWAIT_BIN ??
	process.env.GHL_AWAIT_DRIVE_BIN ??
	join(homedir(), ".local", "bin", "ghl-pr-await");

export type SpawnDriver = (argv: string[]) => { pid?: number };

/**
 * `known` is the extension's in-memory latch. It is passed in because
 * `stateFile` is handed to the Rust waiter as `--state` and rewritten wholesale
 * by it; reading the cwd back out of that file races the waiter, and losing
 * that race used to degrade into `process.cwd()`.
 */
export function defaultSpawnDriver(stateFile: string, known?: LatchState): { pid?: number } {
	mkdirSync(stateDir(), { recursive: true });
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
	const fd = openSync(log, "a");
	const child = spawn(DRIVE_BIN, ["--state", stateFile, "--daemon"], {
		detached: true,
		stdio: ["ignore", fd, fd],
		env: process.env,
		cwd: spawnCwd,
	});
	child.unref();
	closeSync(fd);
	return { pid: child.pid };
}

function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	try {
		return JSON.stringify(result) ?? "";
	} catch {
		return String(result);
	}
}

export type LatchHooks = {
	spawnDriver?: SpawnDriver;
	driverRunning?: (pr: string) => boolean;
	/** Poll interval while a live session waits on a handed-off PR. 0 disables. */
	watchMs?: number;
	/**
	 * Cheap chrome refresh (elapsed + live `round=` from the waiter JSON).
	 * Separate from `watchMs` so GitHub `gh pr view` stays at 15s.
	 * 0 disables. Default 1s when `watchMs` is left at its production default.
	 */
	chromeMs?: number;
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

export default function (pi: ExtensionAPI, hooks: LatchHooks = {}) {
	const pendingCommands = new Map<string, string>();
	const seenCwds = new Set<string>();

	let latch: LatchState | undefined;
	let disabled = false;
	let ensuring = false;
	let stateFile: string | undefined;
	let sessionId: string | undefined;
	/**
	 * The extension's own copy of the latch. `stateFile` is handed to the Rust
	 * waiter as `--state`, and the waiter rewrites it wholesale with its own
	 * verdict — that is how a PR #11 verdict overwrote a PR #18 latch. Never
	 * read the latch back out of `stateFile`.
	 */
	let latchFile: string | undefined;
	let watchTimer: ReturnType<typeof setInterval> | undefined;
	let chromeTimer: ReturnType<typeof setInterval> | undefined;
	let waitStartedAt = 0;
	let waitCtx: ExtensionContext | undefined;
	/** Pi's `Loader` — same braille frames and 80ms tick as the working spinner. */
	let waitLoader: Loader | undefined;
	let terminalWoken = false;
	/** Fingerprint of the ACTIONABLE verdict already injected this session. */
	let lastActionableFingerprint: string | undefined;
	/**
	 * Fingerprint of a verdict this session dispatched and had refused. It is
	 * retried on every watch tick — that is how it drains when the chain lock
	 * frees — so it is tracked separately to keep the retry silent.
	 */
	let lastRefusedFingerprint: string | undefined;
	/**
	 * True only while this session is actually waiting. absorb / armObservedLatch
	 * set it; a later user prompt clears it so a merge cannot hijack a chat that
	 * has moved on (icemining#2150 into an unrelated git-workflow conversation).
	 */
	let deferralActive = false;
	const watchMs = hooks.watchMs ?? 15_000;
	const chromeMs = hooks.chromeMs ?? (hooks.watchMs === undefined ? 1_000 : 0);

	const spawnDriver: SpawnDriver =
		hooks.spawnDriver ?? ((argv) => defaultSpawnDriver(argv[argv.indexOf("--state") + 1] ?? "", latch));
	const driverRunning = hooks.driverRunning ?? ((pr: string) => isDriverRunning(pr));
	// `repoKey` is required, not optional: #475 in icemining-devops and #475 in
	// icemining are different pull requests, so a session whose own repo cannot be
	// named cannot establish ownership and is treated as solo.
	const featureOwnedPr: NonNullable<LatchHooks["featureOwnedPr"]> =
		hooks.featureOwnedPr ??
		((pr, s) => {
			const repo = repoKey(s.cwd);
			return repo ? findFeatureOwningPr(pr, { repo, head: s.head }) : undefined;
		});
	const onFeatureActionable: NonNullable<LatchHooks["onFeatureActionable"]> =
		hooks.onFeatureActionable ??
		(async (ctx, owner, verdict) => {
			// Imported lazily and by name. The latch must not pull the orchestrator
			// into every session at load time, and `orchestrate.ts` must never import
			// back into the latch.
			const orch = await import("./orchestrate.ts");
			return await orch.dispatchFeaturePrVerdictForOwner(pi, ctx, owner, {
				next: verdict.next,
				output: verdict.output,
				round: verdict.round,
			});
		});

	function persist(): void {
		if (!stateFile || !latchFile) return;
		try {
			mkdirSync(stateDir(), { recursive: true });
			if (latch) {
				// Ownership travels with the latch: a live owner must not be adopted away.
				const blob = JSON.stringify({ ...latch, pid: process.pid, sessionId });
				writeFileSync(latchFile, blob);
				// Seed only. The waiter owns `stateFile` once it starts and writes
				// lastNext/verdict there; overwriting it is how an ACTIONABLE
				// `read_comments_and_fix` vanished before the parent could be woken
				// (icemining#2163). Re-seed when the file is missing or names a
				// different PR.
				let seed = true;
				try {
					if (existsSync(stateFile)) {
						const existing = JSON.parse(readFileSync(stateFile, "utf8")) as { pr?: unknown };
						if (String(existing.pr ?? "") === String(latch.pr)) seed = false;
					}
				} catch {
					seed = true;
				}
				if (seed) writeFileSync(stateFile, blob);
			} else {
				rmSync(latchFile, { force: true });
				rmSync(stateFile, { force: true });
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
		// Clearing the latch must not re-arm the wake guard: reportTerminal sets
		// terminalWoken and then clears the latch, and resetting here made the
		// once-only guard a no-op. Only a genuinely different PR resets it.
		if (next?.pr && next.pr !== latch?.pr) {
			terminalWoken = false;
			lastActionableFingerprint = undefined;
			waitStartedAt = 0;
			deferralActive = next.origin === "observed";
		} else if (!next) {
			deferralActive = false;
		}
		latch = next;
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
	 * scheme first. `stateFile` is this session's `--state` path; the rest are
	 * the waiter's own bookkeeping under both spellings it has used.
	 *
	 * `latchFile` is deliberately absent: `pi-<id>.latch.json` is the
	 * extension's private copy, and treating it as waiter state is the mistake
	 * ghl-monitor makes when it respawns drivers from it (F3, F20).
	 */
	function waiterStateFiles(): string[] {
		const files: string[] = [];
		if (stateFile) files.push(stateFile);
		if (latch?.pr) files.push(...waiterManualFiles(latch.pr, stateDir()));
		return [...new Set(files)];
	}

	function waiterRound(): { round?: string; roundTotal?: string } {
		const files: string[] = [];
		if (stateFile) files.push(stateFile);
		if (latchFile) files.push(latchFile);
		if (latch?.pr) files.push(...waiterManualFiles(latch.pr, stateDir()));
		for (const path of files) {
			const v = readLiveRound(path);
			if (v?.round) return v;
		}
		if (latch?.round) return { round: latch.round, roundTotal: latch.roundTotal };
		return {};
	}

	function waitLine(link = false): string | undefined {
		if (!latch || !waitStartedAt) return undefined;
		// No spinner glyph here. `Loader` owns the frames and the 80ms timer;
		// baking a character into this string is why the chrome used to freeze
		// on the 15s poll tick. OSC 8 only on the widget — not the tab title.
		const { round, roundTotal } = waiterRound();
		return formatWaitLine({
			label: prLabel(latch),
			elapsed: formatWaitElapsed(waitStartedAt),
			round,
			roundTotal,
			...(link ? { url: prUrl(latch) } : {}),
		});
	}

	function paintWaitChrome(ctx: ExtensionContext | undefined, text?: string): void {
		if (!ctx) return;
		// Footer already has MCP/model. The Loader widget is the wait chrome.
		status(ctx);
		try {
			ctx.ui.setTitle(text);
		} catch {
			/* no UI */
		}
		try {
			if (!text) {
				ctx.ui.setWidget("pr-await", undefined);
				waitLoader = undefined;
				return;
			}
			const linked = waitLine(true) ?? text;
			if (waitLoader) {
				waitLoader.setMessage(linked);
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
						if (waitLoader === loader) waitLoader = undefined;
					};
					waitLoader = loader;
					return loader;
				},
				{ placement: "belowEditor" },
			);
		} catch {
			/* no UI */
		}
	}

	function stopWatch(): void {
		if (watchTimer) {
			clearInterval(watchTimer);
			watchTimer = undefined;
		}
		if (chromeTimer) {
			clearInterval(chromeTimer);
			chromeTimer = undefined;
		}
		writeWaitProgress(false);
		waitLoader?.stop();
		waitLoader = undefined;
		paintWaitChrome(waitCtx);
		waitCtx = undefined;
		waitStartedAt = 0;
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
	function resumeText(s: LatchState, state: "merged" | "closed"): string {
		const label = prLabel(s);
		const where = s.url ? ` (${s.url})` : "";
		const outcome = state === "merged" ? "merged" : "closed without merging";
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
				? "Fix current-head findings (red then green), one push, then git pr-await once."
				: next === "investigate_dead_reviewers"
					? "Restart reviewers, then git pr-await once."
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

	function wakeParent(ctx: ExtensionContext, text: string): void {
		if (!deferralActive) return;
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
		if (terminalWoken) return;
		terminalWoken = true;
		stopWatch();
		// A `manual-<pr>.json` for a PR that is already over is spent bookkeeping.
		// Leaving it means every later session in the repo re-adopts the same dead
		// PR for the next 24h; `manual-2162.json` was still being picked up hours
		// after that PR merged.
		if (s.source === "manual") {
			for (const path of waiterManualFiles(s.pr, stateDir())) {
				try {
					rmSync(path, { force: true });
				} catch {
					// Cleanup is best-effort; never take the session down over it.
				}
			}
		}
		status(ctx);
		notify(ctx, toastText(s, state));
		// Wake while deferralActive is still set; setLatch(undefined) clears it.
		if (opts.wake) wakeParent(ctx, resumeText(s, state));
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
		if (terminalWoken) return;
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
		await reportTerminal(ctx, s, state, opts);
	}

	function startWatch(ctx: ExtensionContext): void {
		if (watchMs <= 0 || disabled || !latch) {
			stopWatch();
			return;
		}
		waitCtx = ctx;
		if (!waitStartedAt) waitStartedAt = Date.now();
		writeWaitProgress(true);
		paintWaitChrome(ctx, waitLine());
		if (!watchTimer) {
			watchTimer = setInterval(() => {
				paintWaitChrome(ctx, waitLine());
				void (async () => {
					await checkTerminal(ctx);
					await checkActionable(ctx);
				})();
			}, watchMs);
		}
		if (!chromeTimer && chromeMs > 0) {
			chromeTimer = setInterval(() => {
				paintWaitChrome(ctx, waitLine());
			}, chromeMs);
		}
	}

	async function checkTerminal(ctx: ExtensionContext): Promise<void> {
		if (disabled || !latch) {
			stopWatch();
			return;
		}
		const state = await prState(latch.pr, latch.cwd);
		if (state === "merged" || state === "closed") {
			await finishTerminal(ctx, latch, state);
		}
	}

	/**
	 * The Grok/Claude stop-hook injects one undelivered ACTIONABLE verdict on
	 * Stop. Pi has no Stop hook — the session has already yielded — so the
	 * latch must deliver that verdict itself or review fixes never start.
	 */
	async function checkActionable(ctx: ExtensionContext): Promise<void> {
		if (disabled || !latch || !stateFile) return;
		const pr = latch.pr;
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
		const fp = actionableFingerprint({
			next: hit.lastNext,
			verdict: hit.verdict,
			round: hit.round,
		});
		if (fp === lastActionableFingerprint) return;
		// A verdict this session already tried and had refused is re-attempted on
		// every watch tick — that retry is how it drains when the chain lock is
		// released — but it must not re-announce itself each time.
		const repeatOfRefusal = fp === lastRefusedFingerprint;
		if (!repeatOfRefusal) {
			status(ctx, `pr-await ${prLabel(latch)} · ${hit.lastNext}`);
			notify(ctx, `pr-latch: ${prLinkLabel(latch)} ${hit.lastNext}`);
		}

		// A PR a live Feature owns is fixed by a writer that code dispatches, so
		// this session is told nothing to do. Waking it would make whoever holds
		// the latch the fixer: the parent orchestrator, which must not implement,
		// or — for an adopted latch — a chat that never heard of the PR.
		let owner: FeaturePrOwner | undefined;
		try {
			owner = featureOwnedPr(pr, latch);
		} catch {
			// Ownership could not be established. Solo is the pre-Feature behaviour
			// and the only one that keeps a plain session's fix moving.
			owner = undefined;
		}
		if (owner) {
			if (!owner.worktree) {
				notify(
					ctx,
					`pr-latch: ${prLinkLabel(latch)} ${hit.lastNext} belongs to Feature ${owner.name}, which ` +
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
					`pr-latch: ${prLinkLabel(latch)} ${hit.lastNext} → Feature ${owner.name}: dispatched by ` +
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
				lastRefusedFingerprint = fp;
				notify(
					ctx,
					`pr-latch: dispatching ${prLinkLabel(latch)} ${hit.lastNext} to Feature ${owner.name} failed ` +
						`(${String(err)}). Run /orchestrate resume ${owner.name}.`,
				);
				return;
			}
			if (!isAcceptedFeaturePrAction(action)) {
				// Refused: leave every file undelivered. The reconciler and the next
				// watch tick both retry it once the writer that holds the Feature is
				// done. `lastActionableFingerprint` stays unset so that retry works.
				lastRefusedFingerprint = fp;
				return;
			}
			lastActionableFingerprint = fp;
			lastRefusedFingerprint = undefined;
			for (const path of candidates) markVerdictDelivered(path);
			return;
		}
		// Solo: this session is the fixer, so the wake itself is the delivery.
		lastActionableFingerprint = fp;
		for (const path of candidates) markVerdictDelivered(path);
		wakeParent(ctx, actionableResumeText(latch, hit.lastNext, hit.verdict));
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

	async function prState(pr: string, cwd: string): Promise<ReturnType<typeof parsePrState>> {
		const tried = new Set<string>();
		for (const candidate of [resolveQueryCwd(cwd), cwd, referenceCheckoutFor(cwd)]) {
			if (!candidate || tried.has(candidate)) continue;
			tried.add(candidate);
			const { out, ok } = await sh("gh", ["pr", "view", pr, "--json", "state,mergedAt"], candidate);
			const st = parsePrState(out, ok);
			if (st !== "unknown") return st;
		}
		return "unknown";
	}

	function absorb(command: string, output: string, ctx: ExtensionContext): void {
		const cwd = trailingCd(command, /\b(?:git\s+pr-|gh\s+pr\s+)/) ?? ctx.cwd;
		if (cwd.startsWith(REPO_ROOT)) seenCwds.add(cwd);

		// pr-land --continue N must not retarget the latch. That is how a
		// leftover land of icemining#10 stole sessions that were driving
		// something else.
		if (/\bgit\s+pr-land\b/.test(command) && !/\bgit\s+pr-await\b/.test(command)) return;

		const call = parseAwaitCall(command);
		const created = /\bgh\s+pr\s+create\b/.test(command)
			? output.match(/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/)?.[1]
			: undefined;

		const pr = call?.pr ?? created;
		if (!pr) return;

		const next = parseField(output, "next");
		const cursor = parseField(output, "cursor") ?? call?.cursor;
		const head = parseField(output, "head");
		const round = parseField(output, "round");
		const roundTotal = parseField(output, "round_total");
		const url =
			output.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/)?.[0] ??
			parseField(output, "url");
		const slug = url?.match(/github\.com\/([^\s/]+\/[^\s/]+)\/pull\//)?.[1];
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
		if (!round) stripStaleWaiterRound();
	}

	function stripStaleWaiterRound(): void {
		if (!latch) return;
		const files = [
			stateFile,
			latchFile,
			...waiterManualFiles(latch.pr, stateDir()),
		].filter((p): p is string => Boolean(p));
		for (const path of files) {
			try {
				if (!existsSync(path)) continue;
				const v = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
				if (v.pr != null && String(v.pr) !== String(latch.pr)) continue;
				if (v.round == null && v.roundTotal == null && v.round_total == null) continue;
				delete v.round;
				delete v.roundTotal;
				delete v.round_total;
				delete v.round_number;
				writeFileSync(path, JSON.stringify(v));
			} catch {
				// Never take the session down over chrome bookkeeping.
			}
		}
	}

	async function handoff(ctx: ExtensionContext, opts: { wakeOnTerminal?: boolean } = {}): Promise<void> {
		if (disabled || ensuring || latchOff()) return;
		ensuring = true;
		try {
			if (!latch || !stateFile) return;

			const state = await prState(latch.pr, latch.cwd);
			if (state === "closed" || state === "merged") {
				await finishTerminal(ctx, latch, state, { wake: !!opts.wakeOnTerminal });
				return;
			}

			persist();

			// A PR a live Feature owns has a durable owner: the reconciler
			// ensures exactly one waiter for it. Forking one here too is the
			// second of the three uncoordinated spawners that put 25 daemons on
			// one PR and rate-limited GitHub (F3). Watch and drain a pending
			// verdict, but start nothing.
			let owned = false;
			try {
				owned = Boolean(featureOwnedPr(latch.pr, latch));
			} catch {
				// Ownership could not be established; treat it as solo, which is
				// the behaviour that keeps a plain session's PR moving.
				owned = false;
			}
			if (owned) {
				status(ctx, `pr-await ${prLabel(latch)} · Feature-owned`);
				notify(
					ctx,
					`pr-latch: ${prLinkLabel(latch)} belongs to a live /orchestrate Feature — ` +
						`/orchestrate owns its waiter. This session watches only.`,
				);
				startWatch(ctx);
				await checkActionable(ctx);
				return;
			}

			const running = driverRunning(latch.pr);
			if (!running && !spawnCwdFor(latch)) {
				// An open PR with no waiter and nowhere to start one. Say so loudly:
				// silence here is what left icemining#2163 open with a dead daemon.
				status(ctx, `pr-await ${prLabel(latch)} · NO WAITER`);
				notify(
					ctx,
					`pr-latch: cannot start a waiter for ${prLinkLabel(latch)} — ${latch.cwd} is not a git checkout ` +
						`and has no reference checkout. Re-run \`git pr-await ${latch.pr}\` from inside the PR's worktree.`,
				);
				return;
			}
			const result = ensureDriver({
				pr: latch.pr,
				stateFile,
				spawn: spawnDriver,
				running,
			});
			status(ctx, `pr-await ${prLabel(latch)} · handed off`);
			notify(
				ctx,
				result.action === "already"
					? `pr-latch: ${prLinkLabel(latch)} waiter already running (detached)`
					: `pr-latch: handed off ${prLinkLabel(latch)} — session may end, wait continues at 0 tokens`,
			);
			startWatch(ctx);
			// Immediate: `/rreload` and settle-with-a-waiting-verdict must not
			// wait for the 15s watch tick. No-op when lastNext is yield/poll_again.
			await checkActionable(ctx);
		} finally {
			ensuring = false;
		}
	}

	function killDriver(pr: string): void {
		// Both spellings: `/pr-latch clear` promises the waiter is stopped, and
		// leaving the repo-qualified daemon alive would keep polling GitHub.
		for (const path of waiterPidFiles(pr, stateDir())) {
			let pid = 0;
			try {
				pid = Number(readFileSync(path, "utf8").trim());
			} catch {
				continue;
			}
			if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) continue;
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// already gone
			}
		}
	}

	// `/orchestrate` runs `git pr-await` via `pi.exec`, which is not a bash tool
	// event, so absorb never sees it. Code calls `armObservedLatch` after a
	// yield handshake; this is that arm. `orchestrate.ts` must not import this
	// file — the registry lives in `pr-await-core.ts`.
	registerLatchArm((ctx, seed) => {
		if (disabled || latchOff()) return;
		setLatch({
			pr: String(seed.pr),
			cwd: seed.cwd,
			lastNext: seed.lastNext ?? "yield",
			url: seed.url,
			slug: seed.slug,
			head: seed.head,
			origin: "observed",
		});
		void handoff(ctx as ExtensionContext, { wakeOnTerminal: true });
	});

	pi.on("session_start", async (event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		sessionId = id;
		stateFile = id ? join(stateDir(), `pi-${id}.json`) : undefined;
		latchFile = id ? join(stateDir(), `pi-${id}.latch.json`) : undefined;
		seenCwds.clear();
		pendingCommands.clear();
		deferralActive = false;
		if (!stateFile || !latchFile) return;

		const reason =
			event && typeof event === "object" && typeof (event as { reason?: unknown }).reason === "string"
				? (event as { reason: string }).reason
				: "startup";

		// Prefer this session's own latch, then the legacy shared path.
		latch = readLatchFile(latchFile) ?? (existsSync(stateFile) ? readLatchFile(stateFile) : undefined);
		if (latch) {
			// Same-session reload. The previous process may have died without the
			// waiter, so re-ensure it, but do not wake: the user is not here.
			deferralActive = (latch.origin ?? "adopted") === "observed";
			if (!disabled) void handoff(ctx, { wakeOnTerminal: false });
			return;
		}

		// A pi reload mints a NEW session id, so the previous session's latch is
		// orphaned under a name we would never look for. Take it over only when
		// this session is a successor in the SAME worktree. A fresh chat in the
		// reference checkout (`~/Dev/git/icemining`) must not inherit ice-wt PRs
		// — that is how #2150 woke an unrelated conversation.
		if (disabled || latchOff()) return;
		if (reason === "new" || reason === "resume") return;
		if (isReferenceCheckout(ctx.cwd)) return;
		const repo = repoKey(ctx.cwd);
		if (!repo) return;
		const adopted = adoptableLatch(stateDir(), {
			exclude: [stateFile, latchFile],
			repo,
			cwd: ctx.cwd,
		});
		if (!adopted) return;
		setLatch({ ...adopted, origin: "adopted" });
		// Successor of a wait in this worktree: still waiting, even though origin
		// is adopted (the wake must not claim this session deferred the work).
		deferralActive = true;
		notify(ctx, `pr-latch: adopted ${prLinkLabel(adopted)} from a previous session`);
		void handoff(ctx, { wakeOnTerminal: adopted.source !== "manual" });
	});

	pi.on("session_shutdown", async () => {
		// Leave the waiter. Aborting it was the D-2 self-inflicted stall.
		stopWatch();
		pendingCommands.clear();
		seenCwds.clear();
	});

	pi.on("input", async (event) => {
		const source =
			event && typeof event === "object" ? (event as { source?: unknown }).source : undefined;
		// Our own merge/ACTIONABLE injection is source "extension". A real user
		// prompt means this session has moved on; toast on merge, do not hijack.
		if (source !== "extension") deferralActive = false;
		return { action: "continue" as const };
	});

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName !== "bash") return;
		const command = (event.args as { command?: string } | undefined)?.command;
		if (!command) return;
		const cwd = trailingCd(command);
		if (cwd) seenCwds.add(cwd);
		if (/\bgit\s+pr-await\b|\bgh\s+pr\s+create\b/.test(command)) {
			pendingCommands.set(event.toolCallId, command);
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const command = pendingCommands.get(event.toolCallId);
		if (!command) return;
		pendingCommands.delete(event.toolCallId);
		if (event.isError) return;
		absorb(command, resultText(event.result), ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (disabled || !ctx.isIdle()) return;
		void handoff(ctx, { wakeOnTerminal: true });
	});

	pi.registerCommand("pr-latch", {
		description: "Show, clear, or disable the background git pr-await latch",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "clear") {
				stopWatch();
				if (latch) killDriver(latch.pr);
				setLatch(undefined);
				status(ctx);
				ctx.ui.notify("pr-latch cleared (waiter stopped)", "info");
				return;
			}
			if (arg === "off") {
				disabled = true;
				status(ctx);
				ctx.ui.notify("pr-latch sensor disabled for this session (waiter, if any, keeps going)", "info");
				return;
			}
			if (arg === "on") {
				disabled = false;
				ctx.ui.notify("pr-latch enabled", "info");
				return;
			}
			ctx.ui.notify(
				disabled
					? "pr-latch: sensor disabled (/pr-latch on to re-enable)"
					: latch
						? `pr-latch: PR #${latch.pr} · next=${latch.lastNext ?? "?"} · ` +
							`${driverRunning(latch.pr) ? "waiter running" : "no waiter"} · ${latch.cwd}`
						: "pr-latch: no PR latched",
				"info",
			);
		},
	});
}
