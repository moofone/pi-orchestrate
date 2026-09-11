import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** Env var that pins the e2e `git wt` helper (ghl-wt) explicitly. */
export const WORKTREE_HELPER_ENV = "PI_GIT_WORKFLOW_WT_BIN";

export type ResolveWorktreeHelperOptions = {
	/** Environment to read the override and default PATH from (test seam). */
	env?: Record<string, string | undefined>;
	/** PATH-style search list override (test seam). */
	path?: string;
};

/**
 * Resolve the configured `git wt` helper binary for e2e provisioning.
 *
 * Order: an explicit PI_GIT_WORKFLOW_WT_BIN override, then an executable
 * `ghl-wt` on PATH. A pinned override is authoritative — a broken one is an
 * error naming the setting, not a silent fall back to PATH. There is
 * deliberately no fallback to raw `git worktree …`: raw worktree mutation is
 * exactly what the git-workflow guard forbids, and a missing helper must be
 * an actionable failure rather than a silent skip of the overlap/composition/
 * crash coverage.
 */
export function resolveWorktreeHelper(options: ResolveWorktreeHelperOptions = {}): string {
	const env = options.env ?? process.env;
	const searchPath = options.path ?? env.PATH ?? "";
	const configured = env[WORKTREE_HELPER_ENV]?.trim();
	const candidates: string[] = [];
	if (configured) {
		candidates.push(isAbsolute(configured) ? configured : resolve(configured));
	} else {
		for (const dir of searchPath.split(delimiter)) {
			if (dir) candidates.push(join(dir, "ghl-wt"));
		}
	}
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// not present or not executable; keep resolving
		}
	}
	const detail = configured
		? `${WORKTREE_HELPER_ENV}=${configured} is missing or not executable`
		: "no executable ghl-wt found on PATH";
	throw new Error(
		`e2e worktree provisioning needs the configured git wt helper: ${detail}. ` +
			`Install ghl-wt on PATH or set ${WORKTREE_HELPER_ENV} to the binary. ` +
			`Raw git worktree is not a permitted fallback, and the affected coverage must not silently skip.`,
	);
}
