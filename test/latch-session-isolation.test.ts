import { test } from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import latch from "../src/pr-await-latch.ts";

// Exercise the actual session_start handler, not just the candidate filter.
// No real GitHub, waiter, Feature, or child execution is allowed.
for (const folder of ["icemining", "wt/icemining/unrelated-chat"]) {
for (const reason of ["startup", "new", "resume", "fork", "reload", undefined]) {
 for (const source of ["dead-session", "same-process-session", "manual"] as const) {
  test(`session isolation: ${reason ?? "missing reason"} ignores ${source} in ${folder}`, async () => {
   const dir = mkdtempSync(join(tmpdir(), "latch-isolation-"));
   const previous = process.env.GHL_LATCH_STATE_DIR;
   process.env.GHL_LATCH_STATE_DIR = dir;
   const previousOrch = process.env.GHL_ORCH_ROOT;
   process.env.GHL_ORCH_ROOT = dir;
   const cwd = join(homedir(), "Dev/git", folder);
   const handlers: Record<string, any> = {};
   const effects: string[] = [];
   const own = join(dir, "pi-fresh-chat.latch.json");
   const foreign = join(dir, source === "manual" ? "manual-icemining-2656.json" : "pi-other-chat.latch.json");
   const state = JSON.stringify({ pr: "2656", cwd, slug: "moofone/icemining", origin: "observed",
    ...(source === "manual" ? {} : { pid: source === "dead-session" ? 99999999 : process.pid, sessionId: "other-chat" }),
    lastNext: "read_comments_and_fix", verdict: "next=read_comments_and_fix\npr=2656\nround=2", verdictDelivered: false });
   writeFileSync(foreign, state);
   const ctx = { cwd, isIdle: () => true, sessionManager: { getSessionId: () => "fresh-chat", getSessionFile: () => undefined },
    ui: { notify: (s: string) => effects.push(s), setStatus: (_: string, s: string) => { if (s) effects.push(s); },
     setTitle: (s: string) => { if (s) effects.push(s); }, setWidget: (_: string, content: unknown) => { if (content) effects.push("widget"); } } };
   latch({ events: new EventEmitter(), on: (name: string, fn: any) => { handlers[name] = fn; }, registerCommand() {},
    exec: async () => { effects.push("network"); return { stdout: '{"state":"OPEN"}', stderr: "", code: 0 }; },
    sendUserMessage: () => { effects.push("wake"); } } as any,
    { watchMs: 0, watchStateDir: false, driverRunning: () => true,
     spawnDriver: () => { effects.push("spawn"); return {}; }, featureOwnedPr: () => undefined } as any);
   try {
    await handlers.session_start(reason ? { reason } : {}, ctx);
    await handlers.agent_settled({}, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(effects, [], "foreign PR must produce no wake, UI, network, or waiter effects");
    assert.equal(existsSync(own), false, "must not persist stolen ownership");
    assert.equal(readFileSync(foreign, "utf8"), state, "must not acknowledge or alter another session's verdict");
   } finally {
    await handlers.session_shutdown({}, ctx);
    if (previous === undefined) delete process.env.GHL_LATCH_STATE_DIR;
    else process.env.GHL_LATCH_STATE_DIR = previous;
    if (previousOrch === undefined) delete process.env.GHL_ORCH_ROOT;
    else process.env.GHL_ORCH_ROOT = previousOrch;
    rmSync(dir, { recursive: true, force: true });
   }
  });
 }
}

}

for (const reason of ["startup", "reload", "resume"]) {
 test(`session isolation: ${reason} restores the SAME session's observed latch`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "latch-own-session-"));
  const previous = process.env.GHL_LATCH_STATE_DIR;
  process.env.GHL_LATCH_STATE_DIR = dir;
  const cwd = join(homedir(), "Dev/git/icemining");
  const handlers: Record<string, any> = {};
  const calls: string[] = [];
  writeFileSync(join(dir, "pi-owner.latch.json"), JSON.stringify({ pr: "2656", cwd, slug: "moofone/icemining", origin: "observed", sessionId: "owner" }));
  const ctx = { cwd, isIdle: () => true, sessionManager: { getSessionId: () => "owner" },
   ui: { notify() {}, setStatus() {}, setTitle() {}, setWidget() {} } };
  latch({ events: new EventEmitter(), on: (name: string, fn: any) => { handlers[name] = fn; }, registerCommand() {},
   exec: async (_: string, args: string[]) => { calls.push(args.join(" ")); return { stdout: '{"state":"OPEN"}', stderr: "", code: 0 }; },
   sendUserMessage() {} } as any,
   { watchMs: 0, watchStateDir: false, driverRunning: () => true, featureOwnedPr: () => undefined } as any);
  try {
   await handlers.session_start({ reason }, ctx);
   await new Promise<void>((resolve) => setImmediate(resolve));
   assert.ok(calls.some((s) => s.includes("2656")), "the owner still resumes its wait");
   assert.equal(JSON.parse(readFileSync(join(dir, "pi-owner.latch.json"), "utf8")).pr, "2656");
  } finally {
   await handlers.session_shutdown({}, ctx);
   if (previous === undefined) delete process.env.GHL_LATCH_STATE_DIR;
   else process.env.GHL_LATCH_STATE_DIR = previous;
   rmSync(dir, { recursive: true, force: true });
  }
 });
}
