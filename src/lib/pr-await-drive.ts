#!/usr/bin/env node
/**
 * Back-compat trampoline. The waiter is `ghl-pr-await`.
 * `~/.local/bin/ghl-await-drive` used to import this file; after
 * setup-aliases it is a shell wrapper. Either path execs the Rust binary.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function awaitBin(): string {
	return process.env.GHL_PR_AWAIT_BIN ?? join(homedir(), ".local", "bin", "ghl-pr-await");
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

export async function main(argv: string[]): Promise<number> {
	const bin = awaitBin();
	return await new Promise((resolve) => {
		const child = spawn(bin, argv, { stdio: "inherit", env: process.env });
		child.on("error", () => resolve(1));
		child.on("close", (code) => resolve(code ?? 1));
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await main(process.argv.slice(2)));
}
