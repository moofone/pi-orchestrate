/**
 * Latch helpers for the pi stop-hook. The waiter is `ghl-pr-await` (Rust).
 * This module does not poll, land, or buy model turns.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const ACTIONABLE = new Set([
	"read_comments_and_fix",
	"investigate_dead_reviewers",
	"fix_command_or_environment",
]);

/**
 * Identity of one ACTIONABLE delivery. `next=` alone is not enough: every
 * later review round is also `read_comments_and_fix`, and slicing the body
 * to 160 chars made the second round look like the first, so orchestration
 * stopped after one or two fixers while findings remained.
 */
export function actionableFingerprint(input: {
	next: string;
	verdict?: string;
	round?: string;
}): string {
	const next = String(input.next ?? "").trim().toLowerCase();
	const round = String(input.round ?? "").trim() || "none";
	return `${next}:r${round}:${(input.verdict ?? "").slice(0, 4000)}`;
}

export const MECHANICAL = new Set(["git_pr_land", "git_pr_land_continue"]);

/**
 * Dispatch outcomes that consume the verdict.
 *
 * A verdict is one delivery. Marking it spent before the dispatch ran meant a
 * `refuse` — which is the normal answer while a fixer holds the chain lock for
 * half an hour — threw the finding away, and the waiter does not re-emit
 * (F4). Only these four actually did something with it; `refuse`, `notify`,
 * `confirm` and `idle` leave it on disk to be retried.
 */
export const ACCEPTED_FEATURE_PR_ACTIONS = new Set([
	"spawn_writer",
	"reawait",
	"land",
	"archive",
]);

export function isAcceptedFeaturePrAction(action: unknown): boolean {
	// A hook that returns nothing accepted it: that is the historic contract,
	// and the tests' capture hooks rely on it.
	if (action === undefined || action === null) return true;
	return typeof action === "string" && ACCEPTED_FEATURE_PR_ACTIONS.has(action);
}

/** Waiter-owned fields on `pi-<id>.json` / `manual-<pr>.json`. */
export type WaiterVerdict = {
	lastNext?: string;
	verdict?: string;
	verdictDelivered: boolean;
	pr?: string;
	round?: string;
	roundTotal?: string;
};

/** Read the waiter's verdict without treating the file as the extension latch. */
export function readWaiterVerdict(path: string): WaiterVerdict | undefined {
	try {
		const v = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		if (!v || typeof v !== "object") return undefined;
		const lastNext =
			typeof v.lastNext === "string"
				? v.lastNext
				: typeof v.last_next === "string"
					? v.last_next
					: undefined;
		const verdict = typeof v.verdict === "string" ? v.verdict : undefined;
		const delivered = v.verdictDelivered ?? v.verdict_delivered;
		const roundRaw = v.round ?? v.round_number;
		const totalRaw = v.roundTotal ?? v.round_total;
		const round =
			typeof roundRaw === "string" || typeof roundRaw === "number"
				? String(roundRaw)
				: verdict
					? parseField(verdict, "round")
					: undefined;
		const roundTotal =
			typeof totalRaw === "string" || typeof totalRaw === "number"
				? String(totalRaw)
				: verdict
					? parseField(verdict, "round_total")
					: undefined;
		return {
			lastNext,
			verdict,
			verdictDelivered: delivered === true,
			pr: v.pr != null ? String(v.pr) : undefined,
			round,
			roundTotal,
		};
	} catch {
		return undefined;
	}
}

/**
 * Live `round=` / `roundTotal=` written on each waiter poll_again tick.
 * Top-level only: the verdict body still carries the previous cycle's round
 * after a yield handoff, and parsing that is why chrome stuck on r3.
 */
export function readLiveRound(
	path: string,
): { round?: string; roundTotal?: string } | undefined {
	try {
		const v = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		if (!v || typeof v !== "object") return undefined;
		const roundRaw = v.round ?? v.round_number;
		const totalRaw = v.roundTotal ?? v.round_total;
		const round =
			typeof roundRaw === "string" || typeof roundRaw === "number"
				? String(roundRaw)
				: undefined;
		const roundTotal =
			typeof totalRaw === "string" || typeof totalRaw === "number"
				? String(totalRaw)
				: undefined;
		if (!round && !roundTotal) return undefined;
		return { round, roundTotal };
	} catch {
		return undefined;
	}
}

/**
 * Mark every waiter file for this PR spent, under both name spellings.
 *
 * Called by the dispatcher the moment it accepts an action, not when the fixer
 * finishes: a writer holds the Feature for 30-60 minutes, and leaving the file
 * undelivered for that long makes the 15s watch and the reconciler re-dispatch
 * the same verdict and refuse it over and over.
 */
export function spendWaiterVerdict(
	repo: string | undefined,
	pr: string,
	dir = stateDir(),
): void {
	const paths = new Set([
		...waiterManualFiles(pr, dir),
		...waiterPaths(repo, pr, dir).manual,
	]);
	for (const path of paths) {
		if (!existsSync(path)) continue;
		markVerdictDelivered(path);
	}
}

/** Persist that the one model turn for this verdict has been spent. */
export function markVerdictDelivered(path: string): void {
	try {
		const v = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		if (!v || typeof v !== "object") return;
		v.verdictDelivered = true;
		writeFileSync(path, JSON.stringify(v));
	} catch {
		// Never throw from persist.
	}
}

export const REPO_ROOT = join(homedir(), "Dev");

export const MAX_WORKTREE_CANDIDATES = 5;
export const SHORT_MS = 20_000;

/** A latch older than this is stale history, not something to take over. */
export const ADOPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Compact elapsed for a waiting chrome line. `startedAt` is epoch ms. */
export function formatWaitElapsed(startedAt: number, now = Date.now()): string {
	const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	const m = min % 60;
	return m ? `${h}h ${m}m` : `${h}h`;
}

/** OSC 8 hyperlink. Visible text stays `label`; click opens `url`. */
export function osc8Link(url: string, text: string): string {
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/** `owner/repo` from `remote.origin.url` in this checkout, if it is GitHub. */
export function originSlug(cwd: string): string | undefined {
	if (!cwd) return undefined;
	const git = join(cwd, ".git");
	let cfg = "";
	try {
		if (statSync(git).isDirectory()) cfg = join(git, "config");
	} catch {
		/* missing */
	}
	if (!cfg) {
		try {
			const gitdir = readFileSync(git, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
			if (!gitdir) return undefined;
			for (const candidate of [join(gitdir, "config"), join(gitdir, "..", "..", "config")]) {
				if (existsSync(candidate)) {
					cfg = candidate;
					break;
				}
			}
		} catch {
			return undefined;
		}
	}
	if (!cfg || !existsSync(cfg)) return undefined;
	let text = "";
	try {
		text = readFileSync(cfg, "utf8");
	} catch {
		return undefined;
	}
	const url = text.match(/\[remote "origin"\][^\[]*^\s*url\s*=\s*(\S+)/m)?.[1];
	const m = url?.match(/github\.com[:/]([^/\s]+\/[^/\s]+)/i);
	return m?.[1]?.replace(/\.git$/i, "");
}

/** GitHub PR URL from latch fields, if we have enough to form one. */
export function prUrl(s: Pick<LatchState, "pr" | "url" | "slug" | "cwd">): string | undefined {
	if (s.url && /^https?:\/\//i.test(s.url)) return s.url.replace(/\/+$/, "");
	const slug = s.slug || (s.cwd ? originSlug(s.cwd) : undefined);
	if (slug && s.pr) return `https://github.com/${slug}/pull/${s.pr}`;
	return undefined;
}

/** Compact latch chrome: `waiting icemining#2178 · r2/3 · 2m`. */
export function formatWaitLine(opts: {
	label: string;
	elapsed: string;
	round?: string;
	roundTotal?: string;
	url?: string;
}): string {
	const r = opts.round && opts.round !== "none" ? opts.round : "";
	const tot = opts.roundTotal && opts.roundTotal !== "none" ? opts.roundTotal : "";
	const roundBit = r ? (tot ? `r${r}/${tot}` : `r${r}`) : "";
	const label = opts.url ? osc8Link(opts.url, opts.label) : opts.label;
	return roundBit
		? `waiting ${label} · ${roundBit} · ${opts.elapsed}`
		: `waiting ${label} · ${opts.elapsed}`;
}

/**
 * iTerm2 OSC 9;4 tab progress. State 3 is *indeterminate* — the terminal
 * animates; pi writes once to start and once to stop. No timer.
 * https://iterm2.com/documentation-escape-codes.html
 */
export function waitProgressSequence(on: boolean, term = process.env.TERM ?? ""): string {
	const payload = on ? "9;4;3" : "9;4;0";
	if (/^(screen|tmux)/.test(term)) return `\x1bPtmux;\x1b\x1b]${payload}\x07\x1b\\`;
	return `\x1b]${payload}\x07`;
}

export function stateDir(): string {
	return process.env.GHL_LATCH_STATE_DIR ?? join(homedir(), ".local", "state", "ghl-await");
}

/**
 * How this session came to hold the latch. Only `observed` — the session itself
 * ran `git pr-await` or `gh pr create` — licenses a wake that tells the model it
 * deferred work until the merge. A latch that was found on disk or inferred
 * from a branch is a guess about someone else's intent and must be reported as
 * one. Absent on legacy files, which are treated as `adopted`.
 */
export type LatchOrigin = "observed" | "discovered" | "adopted";

export type LatchState = {
	pr: string;
	cursor?: string;
	lastNext?: string;
	cwd: string;
	head?: string;
	origin?: LatchOrigin;
	/** `owner/repo` when a PR URL was seen; the display name falls back to `repoKey(cwd)`. */
	slug?: string;
	url?: string;
	/** Owning pi process. A latch whose owner still runs belongs to that session. */
	pid?: number;
	sessionId?: string;
	/**
	 * Which kind of file this was adopted from. `manual-<pr>.json` is the Rust
	 * waiter's own bookkeeping and names no session, so it is evidence that a
	 * wait happened — not that *this* lineage of sessions deferred work on it.
	 */
	source?: "manual" | "session";
	/** Waiter review cycle, from `round=` / `round_total=` on git pr-await output. */
	round?: string;
	roundTotal?: string;
};

/**
 * Seed for an observed latch that was not absorbed from a bash tool event.
 * `/orchestrate` runs `git pr-await` via `pi.exec`, which never fires
 * `tool_execution_end`, so the parent would otherwise sit on `next=yield`
 * after the waiter has already landed.
 */
export type ObservedLatchSeed = {
	pr: string;
	cwd: string;
	lastNext?: string;
	url?: string;
	slug?: string;
	head?: string;
};

export type LatchArmFn = (ctx: unknown, seed: ObservedLatchSeed) => void;

let latchArm: LatchArmFn | undefined;

/** Latch plugin registers; tests replace. `undefined` unregisters. */
export function registerLatchArm(fn: LatchArmFn | undefined): void {
	latchArm = fn;
}

/**
 * Arm the live session's latch from code. No-op until the latch plugin
 * registers. Never throws: a Feature chain must not die over chrome.
 */
export function armObservedLatch(ctx: unknown, seed: ObservedLatchSeed): void {
	try {
		latchArm?.(ctx, seed);
	} catch {
		// Never take the Feature chain down over the latch.
	}
}

/** `moofone/icemining#2142`, else `icemining#2142`, else `PR #2142`. */
export function prLabel(s: Pick<LatchState, "pr" | "cwd" | "slug">): string {
	const name = s.slug ?? repoKey(s.cwd);
	return name ? `${name}#${s.pr}` : `PR #${s.pr}`;
}

/** Compact label, OSC-8 linked to the GitHub PR when we can form a URL. */
export function prLinkLabel(s: Pick<LatchState, "pr" | "cwd" | "slug" | "url">): string {
	const label = prLabel(s);
	const url = prUrl(s);
	return url ? osc8Link(url, label) : label;
}

/** `(?:^|\\s)` is load-bearing: do not match a longer key ending in `field`. */
export function parseField(text: string, field: string): string | undefined {
	const m = text.match(new RegExp(`(?:^|\\s)${field}=([^\\s]+)`));
	return m?.[1];
}

export function parseAwaitCall(command: string): { pr: string; cursor?: string } | undefined {
	const m = command.match(/\bgit\s+pr-(?:await|land)\s+([^\n;|&]*)/);
	if (!m) return undefined;
	const tokens = m[1].trim().split(/\s+/).filter(Boolean);
	let pr: string | undefined;
	let cursor: string | undefined;
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "--cursor") {
			cursor = tokens[++i];
			continue;
		}
		if (tokens[i].startsWith("-")) {
			if (tokens[i] === "--bot" || tokens[i] === "--timeout-secs") i++;
			continue;
		}
		if (!pr && /^\d+$/.test(tokens[i])) pr = tokens[i];
	}
	return pr ? { pr, cursor } : undefined;
}

export function trailingCd(command: string, upTo?: RegExp): string | undefined {
	const before = upTo ? (command.split(upTo)[0] ?? "") : command;
	let cwd: string | undefined;
	for (const m of before.matchAll(/\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
		const candidate = m[1] ?? m[2] ?? m[3];
		if (candidate.startsWith(REPO_ROOT) && existsSync(candidate)) cwd = candidate;
	}
	return cwd;
}

export function printedLandCommand(out: string): string[] | undefined {
	const m =
		out.match(/^\s*command=(.+)$/m) ??
		out.match(/^\s*(git\s+pr-land[^\n]*)$/m) ??
		out.match(/^\s*resume=(.+)$/m);
	const raw = m?.[1]?.trim();
	if (!raw) return undefined;
	const parts = raw.split(/\s+/).filter(Boolean).map((p) => p.replace(/^['"]|['"]$/g, ""));
	if (parts[0] === "git" && parts[1] === "pr-land") return parts.slice(1);
	const bin = parts[0] ?? "";
	if (bin.endsWith("ghl-pr-land") || bin.endsWith("pr-land")) {
		return ["pr-land", ...parts.slice(1)];
	}
	return undefined;
}

export function landFailedAlreadyMerged(out: string): boolean {
	return /moved after merge/i.test(out) && /refusing to delete/i.test(out);
}

/** Reference checkouts under ~/Dev/git/<repo> — .git is a directory, not a worktree file. */
export function isReferenceCheckout(cwd: string): boolean {
	if (!cwd) return false;
	const parent = dirname(cwd);
	const gitRoot = join(homedir(), "Dev", "git");
	if (parent !== gitRoot && parent !== join(homedir(), "Dev", "git-rel")) return false;
	if (basename(cwd).endsWith("-wt")) return false;
	try {
		return statSync(join(cwd, ".git")).isDirectory();
	} catch {
		return false;
	}
}

const WT_ROOT_TO_REPO: Record<string, string> = {
	"ice-wt": "icemining",
	"devops-wt": "icemining-devops",
};

/**
 * Repository a path belongs to, for both `~/Dev/git/<repo>` checkouts and
 * `~/Dev/git/<repo>-wt/<branch>` worktrees, or `undefined` outside the dev tree.
 *
 * Latch decisions are cross-repo unsafe without this: `#475` in
 * `icemining-devops` and `#475` in `icemining` are different pull requests, and
 * a session told to resume a bare number will resolve it against its own repo.
 * Pure path arithmetic — a worktree may already be deleted when this is asked.
 */
export function repoKey(cwd: string): string | undefined {
	if (!cwd) return undefined;
	for (const root of [join(homedir(), "Dev", "git"), join(homedir(), "Dev", "git-rel")]) {
		const prefix = `${root}/`;
		if (!cwd.startsWith(prefix)) continue;
		const first = cwd.slice(prefix.length).split("/")[0];
		if (!first) return undefined;
		if (first.endsWith("-wt")) return WT_ROOT_TO_REPO[first] ?? first.slice(0, -3);
		return first;
	}
	return undefined;
}

/** A live `/orchestrate` Feature that claims a PR number in its `status.md`. */
export type FeaturePrOwner = {
	dir: string;
	statusFile: string;
	repo: string;
	name: string;
	pr: string;
	worktree?: string;
	phase?: string;
};

function statusValue(text: string, key: string): string | undefined {
	const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	const v = m?.[1]?.trim();
	return v && v !== "none" ? v : undefined;
}

/** `pr: 2142` and `pr: https://github.com/o/r/pull/2142` name the same PR. */
function statusPrNumber(text: string): string | undefined {
	return statusValue(text, "pr")?.match(/(\d+)\s*$/)?.[1];
}

/** `archive/` holds finished Features; `current/` is a retired pointer. */
const NOT_A_FEATURE_DIR = new Set(["archive", "current", "handoffs"]);

function childDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

/** `feat/x`, `origin/feat/x`, `refs/heads/feat/x` are the same Feature branch. */
export function normalizeRefName(raw?: string): string {
	if (!raw) return "";
	return raw.trim().replace(/^(?:refs\/heads\/|remotes\/origin\/|origin\/)/, "");
}

const BRANCH_OWNER_PHASES = new Set(["pr", "implementing", "feature-qa", "paused", "blocked"]);

function featureOwnerFromStatus(
	dir: string,
	statusFile: string,
	text: string,
	pr: string,
): FeaturePrOwner | undefined {
	const repo = statusValue(text, "repo");
	if (!repo) return undefined;
	return {
		dir,
		statusFile,
		repo,
		name: basename(dir),
		pr,
		worktree: statusValue(text, "worktree"),
		phase: statusValue(text, "phase"),
	};
}

function statusBranchMatches(text: string, head: string): boolean {
	const want = normalizeRefName(head);
	if (!want) return false;
	const branch = normalizeRefName(statusValue(text, "branch"));
	if (branch && branch === want) return true;
	const wt = statusValue(text, "worktree");
	return Boolean(wt && basename(wt) === want.replace(/\//g, "-"));
}

/**
 * The live Feature under `root` whose `status.md` claims `pr`, or `undefined`.
 *
 * Ownership decides whether a review verdict is dispatched to a writer by code
 * or handed to the session that ran `git pr-await` itself, so it is deliberately
 * narrow. Both `pr:` and `repo:` must match: `#475` in `icemining-devops` and
 * `#475` in `icemining` are different pull requests, and the `repo:` field —
 * not the folder name — is what the Feature says about itself.
 *
 * If `pr:` was never recorded (open-child returned no schema) but this Feature
 * is already on that branch in a PR phase, `head` recovers ownership so a
 * fixer still runs. Number match always wins. Two branch matches refuse.
 *
 * `root` is injectable so tests never walk the live `~/orchestrator`, which
 * holds real Features whose PR numbers would otherwise decide a test.
 */
export function findFeatureOwningPr(
	pr: string,
	opts: { repo?: string; root?: string; head?: string } = {},
): FeaturePrOwner | undefined {
	const want = String(pr ?? "").trim();
	if (!/^\d+$/.test(want)) return undefined;
	const root = opts.root ?? process.env.GHL_ORCH_ROOT ?? join(homedir(), "orchestrator");
	const byNumber: FeaturePrOwner[] = [];
	const byBranch: FeaturePrOwner[] = [];
	for (const repoDir of childDirs(root)) {
		if (NOT_A_FEATURE_DIR.has(repoDir)) continue;
		for (const name of childDirs(join(root, repoDir))) {
			if (NOT_A_FEATURE_DIR.has(name)) continue;
			const dir = join(root, repoDir, name);
			const statusFile = join(dir, "status.md");
			let text: string;
			try {
				text = readFileSync(statusFile, "utf8");
			} catch {
				continue;
			}
			const numbered = statusPrNumber(text);
			if (numbered === want) {
				const owner = featureOwnerFromStatus(dir, statusFile, text, want);
				if (owner && (!opts.repo || owner.repo === opts.repo)) byNumber.push(owner);
				continue;
			}
			if (numbered) continue;
			if (!opts.head) continue;
			const phase = (statusValue(text, "phase") ?? "").toLowerCase();
			if (!BRANCH_OWNER_PHASES.has(phase)) continue;
			if (!statusBranchMatches(text, opts.head)) continue;
			const owner = featureOwnerFromStatus(dir, statusFile, text, want);
			if (owner && (!opts.repo || owner.repo === opts.repo)) byBranch.push(owner);
		}
	}
	if (byNumber.length === 1) return byNumber[0];
	if (byNumber.length > 1) return undefined;
	if (byBranch.length === 1) return byBranch[0];
	return undefined;
}

/**
 * Every live Feature sitting in one of `phases` with a PR number recorded.
 *
 * The same walk as `findFeatureOwningPr`, asking the opposite question: not
 * "who owns this PR?" but "which Features are waiting on one?". That is the
 * list the durable reconciler works from, and it comes from `status.md` rather
 * than from any session's memory — which is the whole point. A latch lives and
 * dies with a pi process; these files do not (F1).
 *
 * `archive/` is skipped: a finished Feature is not reconciled.
 */
export function listFeaturePrOwners(
	opts: { root?: string; phases?: Iterable<string> } = {},
): FeaturePrOwner[] {
	const root = opts.root ?? process.env.GHL_ORCH_ROOT ?? join(homedir(), "orchestrator");
	const phases = new Set(
		[...(opts.phases ?? ["pr"])].map((p) => p.trim().toLowerCase()),
	);
	const out: FeaturePrOwner[] = [];
	for (const repoDir of childDirs(root)) {
		if (NOT_A_FEATURE_DIR.has(repoDir)) continue;
		for (const name of childDirs(join(root, repoDir))) {
			if (NOT_A_FEATURE_DIR.has(name)) continue;
			const dir = join(root, repoDir, name);
			const statusFile = join(dir, "status.md");
			let text: string;
			try {
				text = readFileSync(statusFile, "utf8");
			} catch {
				continue;
			}
			const phase = (statusValue(text, "phase") ?? "").toLowerCase();
			if (!phases.has(phase)) continue;
			const pr = statusPrNumber(text);
			if (!pr) continue;
			const owner = featureOwnerFromStatus(dir, statusFile, text, pr);
			if (owner) out.push(owner);
		}
	}
	return out;
}

/** One undelivered ACTIONABLE verdict found on disk. */
export type UndeliveredVerdict = {
	path: string;
	next: string;
	verdict?: string;
	round?: string;
};

/**
 * Undelivered ACTIONABLE verdicts for a PR, from every file that may hold one.
 *
 * Both waiter spellings plus any session `pi-<id>.json` the waiter has
 * rewritten — the verdict outlives the session that asked for it, which is
 * what makes recovery after a reload possible at all.
 *
 * `pi-<id>.latch.json` is excluded: it is the extension's private copy of the
 * latch, and reading it as waiter state is the confusion behind the duplicate
 * respawns (F3, F20). A session file that does not name a PR is skipped rather
 * than guessed at — #475 means different things in different repos.
 */
export function undeliveredWaiterVerdicts(
	pr: string,
	dir = stateDir(),
): UndeliveredVerdict[] {
	const want = String(pr ?? "").trim();
	if (!want) return [];
	const paths: string[] = [...waiterManualFiles(want, dir)];
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		names = [];
	}
	for (const name of names) {
		if (!name.startsWith("pi-") || !name.endsWith(".json")) continue;
		if (name.endsWith(".latch.json")) continue;
		paths.push(join(dir, name));
	}
	const out: UndeliveredVerdict[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		if (seen.has(path)) continue;
		seen.add(path);
		const v = readWaiterVerdict(path);
		if (!v?.lastNext || !ACTIONABLE.has(v.lastNext) || v.verdictDelivered) continue;
		// A manual file is named for its PR; a session file must say so itself.
		if (v.pr ? v.pr !== want : basename(path).startsWith("pi-")) continue;
		out.push({ path, next: v.lastNext, verdict: v.verdict, round: v.round });
	}
	return out;
}

export function referenceCheckoutFor(cwd: string): string | undefined {
	if (!cwd) return undefined;
	if (existsSync(join(cwd, ".git"))) return cwd;
	// Two shapes resolve to the same reference checkout:
	//   ~/Dev/git/<repo>-wt/<branch>  a worktree (possibly already removed)
	//   ~/Dev/git/<repo>-wt           the worktree *container*, which holds no
	//                                 `.git` of its own but is a real cwd a
	//                                 session can be sitting in
	for (const [wtRoot, gitParent] of [
		[basename(dirname(cwd)), dirname(dirname(cwd))],
		[basename(cwd), dirname(cwd)],
	] as const) {
		const repo = WT_ROOT_TO_REPO[wtRoot] ?? (wtRoot.endsWith("-wt") ? wtRoot.slice(0, -3) : undefined);
		if (!repo) continue;
		const ref = join(gitParent, repo);
		if (existsSync(join(ref, ".git"))) return ref;
	}
	return undefined;
}

/**
 * Working directory to spawn the detached waiter in, or `undefined` when none
 * can be defended.
 *
 * `ghl-pr-await` resolves `owner/repo` by running `git config --get
 * remote.origin.url` in its own cwd, so a daemon started outside a checkout
 * cannot ever succeed — it just error-loops.
 */
export function spawnCwdFor(latch: Pick<LatchState, "cwd"> | undefined): string | undefined {
	if (!latch?.cwd) return undefined;
	// `referenceCheckoutFor` returns `cwd` itself when it holds a `.git`, and
	// otherwise maps a removed `<repo>-wt/<branch>` worktree back to its
	// reference checkout. Anything else — /tmp, an orchestrator scratch dir, a
	// deleted tree with no reference — yields undefined, and *no* daemon is
	// better than one that loops on `cannot resolve owner/repo`.
	//
	// There is deliberately no `process.cwd()` fallback. That fallback is how
	// icemining#2163's waiter died: it was spawned from a directory that is not
	// a checkout, logged the same resolve error ~40 times, and exited — leaving
	// an open PR with nothing waiting on it and a session that never resumed.
	return referenceCheckoutFor(latch.cwd);
}

export function resolveQueryCwd(cwd: string): string {
	if (cwd && existsSync(cwd)) return cwd;
	return referenceCheckoutFor(cwd) ?? cwd;
}

export function parsePrState(out: string, ok: boolean): "open" | "merged" | "closed" | "unknown" {
	if (!ok) return "unknown";
	try {
		const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
		if (json.mergedAt) return "merged";
		return String(json.state ?? "unknown").toLowerCase() === "open" ? "open" : "closed";
	} catch {
		return "unknown";
	}
}

export function readLatchFile(path: string): LatchState | undefined {
	try {
		const s = JSON.parse(readFileSync(path, "utf8")) as LatchState;
		return s?.pr && s?.cwd ? s : undefined;
	} catch {
		return undefined;
	}
}

export function writeLatchFile(path: string, s: LatchState | undefined): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		if (s) writeFileSync(path, JSON.stringify(s));
		else rmSync(path, { force: true });
	} catch {
		// Never throw from persist.
	}
}

/**
 * Newest *orphaned* latch in `dir` that a reloaded session may take over.
 *
 * A pi reload mints a new session id, so the previous session's latch file is
 * orphaned under a name the new session never looks for. Without adoption the
 * PR is silently forgotten: no waiter is re-ensured and no merge ever wakes the
 * parent. Waiter-owned `manual-<pr>.json` files are adoptable for the same
 * reason.
 *
 * Adoption is a claim that this session is the successor of the one that filed
 * the latch, so it is refused unless that is plausible:
 *
 * - `repo` must match. `icemining-devops#475` and `icemining#475` are different
 *   pull requests; adopting across repos is how a chat about hardware was told
 *   to resume a devops deploy, then resolved `#475` against the wrong repo.
 * - `cwd` must match when provided. Same-repo is not successorship: a session
 *   sitting in `~/Dev/git/icemining` must not inherit a latch from
 *   `ice-wt/feat-foo`. That is how one chat was told it deferred work on
 *   icemining#2150.
 * - The owning process must be gone, and provably so. A latch whose `pid` is
 *   still alive belongs to a session that is still using it — taking it spread
 *   one PR across six concurrent sessions. A `pi-<id>` latch that records no
 *   owner at all cannot be proven orphaned, so it is left alone *and* its PR is
 *   held against every other route: the same unprovable liveness that bars it
 *   as a source must bar it as a target, or the PR stays reachable through
 *   `manual-<pr>.json` and the refusal is cosmetic. `manual-<pr>` latches have
 *   no owning session by construction and stay adoptable, which is the case
 *   adoption exists for — but they are marked `source: "manual"`, because a
 *   wait having happened is not evidence that this session deferred anything.
 * - The candidate's own repo must be nameable. A latch whose `cwd` yields no
 *   `repoKey` can only ever be announced as a bare `PR #478`, which is
 *   ambiguous by construction.
 * - Provenance must not launder. An already-`adopted` or merely `discovered`
 *   latch is someone's guess; re-adopting it would let a guess look like a
 *   first-hand observation two hops later.
 *
 * `exclude` keeps a session from adopting its own state back.
 */
export function adoptableLatch(
	dir = stateDir(),
	opts: {
		exclude?: string[];
		now?: number;
		maxAgeMs?: number;
		/**
		 * Only latches for this repo, from `repoKey()`. Omitted means no repo
		 * filter — so a caller that *has* a session to speak for must refuse
		 * adoption outright when `repoKey` yields nothing, rather than passing
		 * `undefined` and silently disabling the check.
		 */
		repo?: string;
		/**
		 * Only a latch filed in this worktree. Same-repo is not enough: the
		 * reference checkout and every `ice-wt/*` branch share `repoKey`.
		 */
		cwd?: string;
		alive?: (pid: number) => boolean;
		/** Owner pid that counts as this session (an in-process reload). */
		self?: number;
	} = {},
): LatchState | undefined {
	const exclude = new Set(opts.exclude ?? []);
	const now = opts.now ?? Date.now();
	const maxAge = opts.maxAgeMs ?? ADOPT_MAX_AGE_MS;
	const alive = opts.alive ?? pidAlive;
	const self = opts.self ?? process.pid;
	let best: { state: LatchState; mtime: number } | undefined;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return undefined;
	}

	// PRs another session still holds. The waiter also files every wait under
	// `manual-<pr>.json`, so refusing the direct steal is not enough: the same PR
	// stays reachable by the other name.
	//
	// "Holds" is deliberately pessimistic. A `pi-<id>` latch with no `pid` cannot
	// be shown to be dead, so it counts as held. The old rule required a pid to
	// protect but not to be protected from, and that asymmetry is what woke a
	// session driving coins-minimal#13 about icemining-devops#478. Refusing to
	// adopt costs nothing: the detached waiter keeps running either way.
	const heldElsewhere = new Set<string>();
	for (const name of names) {
		if (!name.startsWith("pi-") || !name.endsWith(".json")) continue;
		const path = join(dir, name);
		// Our own files must never hold a PR against us: the waiter rewrites the
		// shared state path wholesale and drops `pid`, so this session's own latch
		// can come back looking ownerless.
		if (exclude.has(path)) continue;
		const owner = readLatchFile(path);
		if (!owner || owner.pid === self) continue;
		try {
			// Stale beyond the adoption window is history, not a live hold.
			if (now - statSync(path).mtimeMs > maxAge) continue;
		} catch {
			continue;
		}
		if (!owner.pid || alive(owner.pid)) heldElsewhere.add(owner.pr);
	}

	for (const name of names) {
		if (!/^(?:manual|pi)-.+\.json$/.test(name)) continue;
		const path = join(dir, name);
		if (exclude.has(path)) continue;
		let mtime: number;
		try {
			mtime = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		if (now - mtime > maxAge) continue;
		const state = readLatchFile(path);
		if (!state || !state.cwd.startsWith(REPO_ROOT)) continue;
		const stateRepo = repoKey(state.cwd);
		// Unnameable repo => the wake could only say `PR #478`, and #478 is a
		// different pull request in icemining than in icemining-devops.
		if (!stateRepo) continue;
		if (opts.repo && stateRepo !== opts.repo) continue;
		if (opts.cwd && state.cwd.replace(/\/+$/, "") !== opts.cwd.replace(/\/+$/, "")) continue;
		if (heldElsewhere.has(state.pr)) continue;
		if (state.pid) {
			// A reload inside the same process is still a successor; another live pi is not.
			if (state.pid !== self && alive(state.pid)) continue;
		} else if (name.startsWith("pi-")) {
			continue;
		}
		if (state.origin === "adopted" || state.origin === "discovered") continue;
		const source = name.startsWith("manual-") ? ("manual" as const) : ("session" as const);
		if (!best || mtime > best.mtime) best = { state: { ...state, source }, mtime };
	}
	return best?.state;
}

/**
 * The waiter's own state files, under every spelling it has used.
 *
 * `ghl-pr-await` built 2026-09-01 writes `manual-<repo>-<pr>.json` and
 * `drive-<repo>-<pr>.pid`; every earlier build wrote `manual-<pr>.json` and
 * `drive-<pr>.pid`, and the checked-in Rust source still does. This extension
 * has to read both, because which one exists depends on which binary is
 * installed — and reading only the old one is why verdicts written by the
 * handshake-spawned waiter were invisible while `isDriverRunning` stayed false
 * forever, so every settle forked another daemon (F2, F3).
 *
 * Repo-qualified first: it is the current binary's spelling, so it is the one
 * a fresh wait will have written. This is a *read* contract — nothing in this
 * extension creates `manual-*` or `drive-*.pid`; the waiter owns them.
 */
export type WaiterPaths = { manual: string[]; pid: string[]; log: string[] };

export function waiterPaths(
	repo: string | undefined,
	pr: string,
	dir = stateDir(),
): WaiterPaths {
	const number = String(pr ?? "").trim();
	const slug = (repo ?? "").trim();
	const spellings = (stem: string, ext: string): string[] => {
		const out: string[] = [];
		if (slug) out.push(join(dir, `${stem}-${slug}-${number}.${ext}`));
		out.push(join(dir, `${stem}-${number}.${ext}`));
		return out;
	};
	return {
		manual: spellings("manual", "json"),
		pid: spellings("drive", "pid"),
		log: spellings("drive", "log"),
	};
}

/**
 * Every waiter file in `dir` for this PR, whatever repo token it carries.
 *
 * A caller that holds only a PR number — the latch, which is keyed by PR —
 * cannot build the repo-qualified name, so the directory is the index instead.
 *
 * The suffix test is string arithmetic, deliberately not a regex: `drive-.*-232`
 * matches `drive-icemining-2232.pid`, and answering "#232 already has a waiter"
 * because #2232 does would leave #232 with none at all. Repo names contain
 * digits and hyphens (`icemining-devops`), so only an exact `-<pr>` tail counts.
 */
function waiterFilesFor(pr: string, stem: string, ext: string, dir: string): string[] {
	const number = String(pr ?? "").trim();
	if (!number) return [];
	const prefix = `${stem}-`;
	const suffix = `.${ext}`;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		// No state directory yet means no waiter has ever run. That is an
		// answer, not a failure: throwing here would take the session down.
		return [];
	}
	const out: string[] = [];
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
		const middle = name.slice(prefix.length, name.length - suffix.length);
		if (middle === number || middle.endsWith(`-${number}`)) out.push(join(dir, name));
	}
	// Repo-qualified before legacy, so the current binary's file is read first.
	return out.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

export function waiterPidFiles(pr: string, dir = stateDir()): string[] {
	return waiterFilesFor(pr, "drive", "pid", dir);
}

export function waiterManualFiles(pr: string, dir = stateDir()): string[] {
	return waiterFilesFor(pr, "manual", "json", dir);
}

/** Legacy spelling. Kept for callers that write nothing and know no repo. */
export function pidFile(pr: string, dir = stateDir()): string {
	return join(dir, `drive-${pr}.pid`);
}

export function logFile(pr: string, dir = stateDir(), repo?: string): string {
	return waiterPaths(repo, pr, dir).log[0]!;
}

export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists and is owned by someone else. Reporting
		// that as dead would let a latch be taken from a session that still holds it.
		return (err as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/** Every pid recorded for this PR, under any spelling. */
export function readPids(pr: string, dir = stateDir()): number[] {
	const out: number[] = [];
	for (const path of waiterPidFiles(pr, dir)) {
		try {
			const n = Number(readFileSync(path, "utf8").trim());
			if (Number.isInteger(n) && n > 0) out.push(n);
		} catch {
			// A pid file that vanished between listing and reading is not a waiter.
		}
	}
	return out;
}

export function readPid(pr: string, dir = stateDir()): number | undefined {
	return readPids(pr, dir)[0];
}

/**
 * Is any waiter for this PR alive?
 *
 * "Any", across both spellings: the question this answers is only ever asked to
 * decide whether to fork another daemon, and a false negative is what produced
 * 25 concurrent waiters on one PR.
 */
export function isDriverRunning(
	pr: string,
	dir = stateDir(),
	alive: (pid: number) => boolean = pidAlive,
): boolean {
	return readPids(pr, dir).some((pid) => alive(pid));
}

export function writePid(pr: string, pid: number, dir = stateDir()): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(pidFile(pr, dir), String(pid));
}

export function clearPid(pr: string, dir = stateDir()): void {
	rmSync(pidFile(pr, dir), { force: true });
}

export function latchOff(): boolean {
	return process.env.GHL_LATCH_OFF === "1" || process.env.GHL_LATCH_OFF === "true";
}

export type EnsureResult = { action: "spawned" | "already" | "skipped"; pid?: number };

export function ensureDriver(opts: {
	pr: string;
	stateFile: string;
	spawn: (argv: string[]) => { pid?: number };
	running?: boolean;
}): EnsureResult {
	if (opts.running) return { action: "already" };
	const spawned = opts.spawn(["--state", opts.stateFile, "--daemon"]);
	return { action: "spawned", pid: spawned.pid };
}
