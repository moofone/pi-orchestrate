/**
 * Detached waiter process helper. The waiter is `ghl-pr-await`; this module
 * only starts it and never owns the wait loop.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function awaitBin(): string {
	return (
		process.env.GHL_PR_AWAIT_BIN ??
		join(homedir(), ".local", "bin", "ghl-pr-await")
	);
}

/**
 * Start one detached `ghl-pr-await --daemon` and return its pid.
 *
 * Lives here rather than in the latch so `orchestrate.ts` can start a waiter
 * without importing `pr-await-latch.ts`: the latch already imports the
 * orchestrator lazily to dispatch verdicts, and a static edge the other way
 * would close that cycle and pull the orchestrator into every session at load.
 *
 * `cwd` must be a real checkout. `ghl-pr-await` resolves `owner/repo` by
 * running git in its own cwd, so a daemon started anywhere else just loops on
 * `cannot resolve owner/repo` and exits — which is how one PR ended up open
 * with nothing waiting on it.
 */
export function spawnDetachedWaiter(opts: {
	stateFile: string;
	cwd: string;
	logFile?: string;
}): { pid?: number } {
	if (!opts.cwd || !existsSync(opts.cwd)) return {};
	let stdio: "ignore" | ["ignore", number, number] = "ignore";
	let fd: number | undefined;
	try {
		if (opts.logFile) {
			mkdirSync(dirname(opts.logFile), { recursive: true });
			fd = openSync(opts.logFile, "a");
			stdio = ["ignore", fd, fd];
		}
		const child = spawn(awaitBin(), ["--state", opts.stateFile, "--daemon"], {
			detached: true,
			stdio,
			env: process.env,
			cwd: opts.cwd,
		});
		child.unref();
		return { pid: child.pid };
	} catch {
		return {};
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* already closed */
			}
		}
	}
}
