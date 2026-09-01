#!/usr/bin/env node
/**
 * Back-compat trampoline. The waiter is `ghl-pr-await`.
 * `~/.local/bin/ghl-await-drive` used to import this file; after
 * setup-aliases it is a shell wrapper. Either path execs the Rust binary.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export function awaitBin(): string {
	return process.env.GHL_PR_AWAIT_BIN ?? join(homedir(), ".local", "bin", "ghl-pr-await");
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
