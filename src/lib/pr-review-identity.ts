/**
 * Canonical PR key and stable verdict identity for the review controller.
 *
 * A PR is host + owner/repo + number. Verdict identity includes the head SHA
 * and review/comment identities; elapsed-time and status-clock fields are
 * excluded so a poll is not a new finding. Two rounds with the same `next=`
 * remain distinct.
 */
import { createHash } from "node:crypto";

export const PR_REVIEW_PROTOCOL_VERSION = 1 as const;

export type PrKey = {
	host: string;
	owner: string;
	repo: string;
	number: string;
};

const VOLATILE_VERDICT_KEYS = new Set([
	"elapsed_seconds",
	"cycle_start",
	"reaction_created_at",
	"timeout_policy",
	"head_commit_date",
	"dead_after_seconds",
	"review_hold_seconds",
	"status",
]);

const DEFAULT_HOST = "github.com";

export function normalizeHost(host: string | undefined): string {
	const h = (host ?? DEFAULT_HOST).trim().toLowerCase();
	return h || DEFAULT_HOST;
}

export function normalizePrNumber(pr: string | number | undefined): string {
	return String(pr ?? "").trim().replace(/^#/, "");
}

/** `owner/repo` or `host/owner/repo`, lowercased, `.git` stripped. */
export function parseGithubSlug(raw: string | undefined): { host: string; owner: string; repo: string } | undefined {
	const s = (raw ?? "").trim().replace(/\.git$/i, "");
	if (!s) return undefined;
	const parts = s.split("/").filter(Boolean);
	if (parts.length === 2) {
		const owner = parts[0]!.toLowerCase();
		const repo = parts[1]!.toLowerCase();
		if (!owner || !repo) return undefined;
		return { host: DEFAULT_HOST, owner, repo };
	}
	if (parts.length >= 3) {
		const host = normalizeHost(parts[0]);
		const owner = parts[parts.length - 2]!.toLowerCase();
		const repo = parts[parts.length - 1]!.toLowerCase();
		if (!owner || !repo) return undefined;
		return { host, owner, repo };
	}
	return undefined;
}

export function parsePrKey(input: {
	pr: string | number;
	slug?: string;
	host?: string;
	owner?: string;
	repo?: string;
}): PrKey | undefined {
	const number = normalizePrNumber(input.pr);
	if (!number || !/^\d+$/.test(number)) return undefined;
	if (input.owner && input.repo) {
		return {
			host: normalizeHost(input.host),
			owner: input.owner.trim().toLowerCase(),
			repo: input.repo.trim().toLowerCase().replace(/\.git$/i, ""),
			number,
		};
	}
	const parsed = parseGithubSlug(input.slug);
	if (!parsed) return undefined;
	return { ...parsed, number };
}

export function prKeyId(key: PrKey): string {
	return `${normalizeHost(key.host)}/${key.owner.toLowerCase()}/${key.repo.toLowerCase()}#${normalizePrNumber(key.number)}`;
}

export function prKeyFileToken(key: PrKey): string {
	return `${normalizeHost(key.host)}--${key.owner.toLowerCase()}--${key.repo.toLowerCase()}--${normalizePrNumber(key.number)}`;
}

export function samePrKey(a: PrKey, b: PrKey): boolean {
	return prKeyId(a) === prKeyId(b);
}

/** Drop waiter clock / status fields so a poll is not a new delivery. */
export function stabilizeVerdictBody(body: string): string {
	return String(body ?? "")
		.split(/\r?\n/)
		.filter((line) => {
			const key = line.split("=")[0]?.trim() ?? "";
			return key.length > 0 && !VOLATILE_VERDICT_KEYS.has(key);
		})
		.join("\n");
}

export function parseVerdictHead(body: string): string {
	for (const line of String(body ?? "").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.startsWith("head=")) return trimmed.slice(5).trim();
	}
	const token = String(body ?? "").match(/(?:^|\s)head=([0-9a-f]{7,40})/i);
	return token?.[1] ?? "";
}

export function parseVerdictNext(body: string): string {
	for (const line of String(body ?? "").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.startsWith("next=")) return trimmed.slice(5).trim();
	}
	return "";
}

/**
 * Review/comment identities and revisions, when the waiter printed them.
 * Changing elapsed text cannot mint a new identity; a new comment id can.
 */
export function extractReviewIdentities(body: string): string[] {
	const ids = new Set<string>();
	for (const token of String(body ?? "").split(/\s+/)) {
		const at = token.indexOf("=");
		if (at <= 0) continue;
		const key = token.slice(0, at);
		const value = token.slice(at + 1);
		if (!value) continue;
		if (
			key === "comment_id" ||
			key === "review_id" ||
			key === "id" ||
			key === "node_id" ||
			key === "commit_id" ||
			key === "path" ||
			key === "line" ||
			key === "original_line" ||
			key === "in_reply_to" ||
			key === "bot"
		) {
			ids.add(`${key}=${value}`);
		}
	}
	return [...ids].sort();
}

export type VerdictKind = "fix" | "env" | "dead_reviewers" | "terminal" | "other";

export function classifyVerdictNext(next: string, body = ""): VerdictKind {
	const n = String(next ?? "").trim().toLowerCase();
	if (n === "read_comments_and_fix") return "fix";
	if (n === "investigate_dead_reviewers") return "dead_reviewers";
	if (n === "done" || n === "stop" || n === "git_pr_land" || n === "git_pr_land_continue") {
		return "terminal";
	}
	if (n === "fix_command_or_environment") return "env";
	if (isGithubServerError(body)) return "env";
	if (!n || n === "yield" || n === "poll_again") return "other";
	return "other";
}

export function isGithubServerError(body: string): boolean {
	const text = String(body ?? "");
	if (/\bHTTP\s*5\d\d\b/i.test(text)) return true;
	if (/\bstatus[=:]?\s*5\d\d\b/i.test(text)) return true;
	if (/\bGitHub(?:\s+API)?\s+(?:error|unavailable|500)\b/i.test(text)) return true;
	return false;
}

export function verdictIdentity(input: {
	pr: PrKey;
	head?: string;
	next: string;
	body?: string;
	round?: string;
}): string {
	const body = input.body ?? "";
	const head = (input.head || parseVerdictHead(body)).trim().toLowerCase();
	const next = String(input.next ?? "").trim().toLowerCase();
	const round = String(input.round ?? "").trim() || "none";
	const reviews = extractReviewIdentities(body).join(";");
	const stable = stabilizeVerdictBody(body);
	const material = [
		prKeyId(input.pr),
		head || "nohead",
		next,
		`r${round}`,
		reviews,
		stable,
	].join("\n");
	return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32);
}

export function launchIdempotencyKey(input: {
	pr: PrKey;
	ownerGeneration: string;
	head: string;
	verdictIds: string[];
}): string {
	const material = [
		prKeyId(input.pr),
		input.ownerGeneration,
		input.head.toLowerCase(),
		[...input.verdictIds].sort().join(","),
	].join("\n");
	return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32);
}
