import assert from "node:assert/strict";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { digest, transitionAttempt } from "../src/lib/execution-contract.ts";
import { canonicalRepoIdentity, createCoordinatorOwner, createExecutionStore, ExecutionStoreError } from "../src/lib/execution-store.ts";
import { admitFakeManifest, fakeAttempt, fakeManifest, fakeReservation } from "./fixtures/execution/fakes.ts";

// Disposable fixtures are intentionally retained, including on failure. No Git cleanup.
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "execution-store-")), session = join(root, "session.jsonl"), commonDir = join(root, "repo.git");
	writeFileSync(session, ""); mkdirSync(commonDir);
	const repo = { commonDir: realpathSync(commonDir), id: digest(realpathSync(commonDir)) };
	const store = createExecutionStore({ stateRoot: root, repo });
	const identity = createCoordinatorOwner(session, `test-process-${process.pid}`);
	return { root, session, repo, store, identity };
}
function seed(f: ReturnType<typeof fixture>, owner: ReturnType<typeof f.store.acquire>) {
	f.store.markReconciled(owner);
	const manifest = fakeManifest(2); manifest.repo = f.repo;
	f.store.transact(owner, state => { state.capacity = 2; admitFakeManifest(state, manifest); });
	const attempt = fakeAttempt(manifest);
	f.store.transact(owner, state => { state.attempts.push(attempt); state.reservations.push(fakeReservation(attempt)); });
	return attempt;
}

test("execution-store: canonical common-dir identity unifies linked worktrees and symlink paths", () => {
	const f = fixture(), repoPath = join(f.root, "real-repo"); mkdirSync(repoPath);
	execFileSync("git", ["init", "-q"], { cwd: repoPath });
	const first = canonicalRepoIdentity(repoPath), link = join(f.root, "alias"); symlinkSync(repoPath, link);
	assert.deepEqual(canonicalRepoIdentity(link), first);
	// Model Git's linked-worktree metadata without running a worktree command.
	const linked = join(f.root, "linked"), admin = join(first.commonDir, "worktrees", "linked"); mkdirSync(linked); mkdirSync(admin, { recursive: true });
	writeFileSync(join(linked, ".git"), `gitdir: ${admin}\n`); writeFileSync(join(admin, "commondir"), "../..\n"); writeFileSync(join(admin, "gitdir"), `${linked}/.git\n`); writeFileSync(join(admin, "HEAD"), "ref: refs/heads/linked\n");
	assert.deepEqual(canonicalRepoIdentity(linked), first);
});

test("execution-store: same-PID clean reload increments epoch and fences old callbacks without releasing children", () => {
	const f = fixture(), owner = f.store.acquire(f.identity); const attempt = seed(f, owner);
	f.store.transact(owner, s => { s.attempts[0] = transitionAttempt(transitionAttempt(attempt, "launching", { at: 2 }), "recovery-needed", { at: 3 }); });
	const before = f.store.read();
	assert.throws(() => f.store.acquire(createCoordinatorOwner(f.session, "same-process")), (e: unknown) => e instanceof ExecutionStoreError && e.kind === "lease-held");
	f.store.relinquish(owner);
	const reloaded = createExecutionStore({ stateRoot: f.root, repo: f.repo }); const next = reloaded.acquire(createCoordinatorOwner(f.session, "same-process"));
	assert.ok(next.epoch > owner.epoch); assert.notEqual(next.instanceId, owner.instanceId); assert.equal(next.pid, owner.pid);
	assert.deepEqual(reloaded.read().reservations, before.reservations); assert.deepEqual(reloaded.read().attempts, before.attempts);
	assert.equal(reloaded.read().reconciledEpoch, undefined);
	const snapshot = readFileSync(reloaded.statePath, "utf8");
	assert.throws(() => f.store.transact(owner, s => { s.capacity = 99; }), /no longer owner/);
	assert.throws(() => f.store.relinquish(owner), /no longer owner/);
	assert.equal(readFileSync(reloaded.statePath, "utf8"), snapshot);
	reloaded.markReconciled(next);
});

test("execution-store: owner death proof, not heartbeat expiry or session changes, permits lease reclamation", () => {
	const f = fixture(), owner = f.store.acquire(f.identity); seed(f, owner);
	for (const status of ["alive", "unknown"] as const) {
		const store = createExecutionStore({ stateRoot: f.root, repo: f.repo, probeOwner: () => status });
		assert.throws(() => store.acquire(createCoordinatorOwner(f.session, "replacement")), /cannot be reclaimed/);
	}
	const store = createExecutionStore({ stateRoot: f.root, repo: f.repo, probeOwner: () => "dead" });
	const next = store.acquire(createCoordinatorOwner(f.session, "replacement")); assert.ok(next.epoch > owner.epoch);
	assert.equal(store.read().reservations.length, 1); assert.equal(store.read().reconciledEpoch, undefined);
});

test("execution-store: incomplete atomic write leaves previous state authoritative and ignores temp files", () => {
	const f = fixture(), owner = f.store.acquire(f.identity); seed(f, owner);
	const before = readFileSync(f.store.statePath, "utf8");
	const failing = createExecutionStore({ stateRoot: f.root, repo: f.repo, beforeReplace: path => { writeFileSync(path, '{"schemaVersion":'); throw new Error("crash before rename"); } });
	assert.throws(() => failing.transact(owner, s => { s.capacity = 3; }), /crash before rename/);
	assert.equal(readFileSync(f.store.statePath, "utf8"), before); assert.equal(f.store.read().reservations.length, 1);
	assert.ok(readdirSync(f.store.dir).some(name => name.endsWith(".tmp")));
	f.store.transact(owner, s => { s.capacity = 3; }); assert.equal(f.store.read().capacity, 3);
});

test("execution-store: unknown versions and malformed authoritative state are refused, never overwritten", () => {
	for (const bytes of ['{"schemaVersion":999}', '{"schemaVersion":']) {
		const f = fixture(); writeFileSync(f.store.statePath, bytes);
		assert.throws(() => f.store.read(), (e: unknown) => e instanceof ExecutionStoreError && e.kind === "recovery-needed");
		assert.throws(() => f.store.acquire(f.identity)); assert.equal(readFileSync(f.store.statePath, "utf8"), bytes);
	}
});

test("execution-store: incomplete and abandoned transaction locks fail closed with bounded diagnostics", () => {
	for (const bytes of ["", "{", JSON.stringify({ owner: { pid: 99999999, processStart: "dead", sessionFile: "/fixture/session", instanceId: "dead", epoch: 1 }, token: "abandoned" })]) {
		const f = fixture(), owner = f.store.acquire(f.identity); seed(f, owner); const snapshot = readFileSync(f.store.statePath, "utf8");
		writeFileSync(f.store.lockPath, bytes);
		const store = createExecutionStore({ stateRoot: f.root, repo: f.repo, probeOwner: () => "dead" });
		assert.throws(() => store.transact(owner, s => { s.reservations = []; }), (e: unknown) => e instanceof ExecutionStoreError && e.kind === "recovery-needed" && e.path === store.lockPath);
		assert.throws(() => store.acquire(createCoordinatorOwner(f.session, "replacement")));
		assert.equal(readFileSync(store.statePath, "utf8"), snapshot); assert.equal(readFileSync(store.lockPath, "utf8"), bytes); assert.equal(store.read().reservations.length, 1);
	}
});

test("execution-store: admission requires reconciliation and capacity, reduction cannot erase occupancy", () => {
	const f = fixture(), owner = f.store.acquire(f.identity), manifest = fakeManifest(); manifest.repo = f.repo;
	f.store.transact(owner, s => { admitFakeManifest(s, manifest); });
	const attempt = fakeAttempt(manifest);
	assert.throws(() => f.store.transact(owner, s => { s.capacity = 1; s.attempts.push(attempt); s.reservations.push(fakeReservation(attempt)); }), /Reconcile/);
	f.store.markReconciled(owner);
	assert.throws(() => f.store.transact(owner, s => { s.attempts.push(attempt); s.reservations.push(fakeReservation(attempt)); }), /capacity/);
	f.store.transact(owner, s => { s.capacity = 1; s.attempts.push(attempt); s.reservations.push(fakeReservation(attempt)); });
	const before = readFileSync(f.store.statePath, "utf8");
	assert.throws(() => f.store.transact(owner, s => { s.capacity = 0; }), /capacity/);
	assert.throws(() => f.store.transact(owner, s => { s.reservations = []; }), /Unreserved/);
	assert.equal(readFileSync(f.store.statePath, "utf8"), before);
});

test("execution-store: transaction lease changes, async callbacks, and competing reservation writes are refused", () => {
	const f = fixture(), owner = f.store.acquire(f.identity); seed(f, owner);
	assert.throws(() => f.store.transact(owner, s => { s.epoch++; }), /lease/);
	assert.throws(() => f.store.transact(owner, async () => {}), /Async/);
	let contended = false;
	const hooked = createExecutionStore({ stateRoot: f.root, repo: f.repo, beforeReplace: () => {
		assert.throws(() => f.store.transact(owner, s => { const a = fakeAttempt(s.manifests[0]!, 1); s.attempts.push(a); s.reservations.push(fakeReservation(a)); }), (e: unknown) => e instanceof ExecutionStoreError && e.kind === "contention"); contended = true;
	} });
	hooked.transact(owner, s => { const a = fakeAttempt(s.manifests[0]!, 1); s.attempts.push(a); s.reservations.push(fakeReservation(a)); });
	assert.ok(contended); assert.equal(f.store.read().reservations.length, 2);
});

test("execution-store: a second session can append idempotent intents but cannot seize lease", () => {
	const f = fixture(), owner = f.store.acquire(f.identity); seed(f, owner);
	const other = join(f.root, "other-session.jsonl"); writeFileSync(other, "");
	const intent = { id: "pause-a", sessionFile: realpathSync(other), authorizationId: "approval-1", kind: "pause" as const, targetId: "feature-a" };
	f.store.appendIntent(intent); const before = f.store.read(); f.store.appendIntent(intent);
	assert.equal(f.store.read().sequence, before.sequence); assert.equal(f.store.read().intents.length, 1);
	assert.throws(() => f.store.acquire(createCoordinatorOwner(other, "other")), /lease/);
	assert.deepEqual(f.store.read().reservations, before.reservations);
});

function message(child: ChildProcess): Promise<{ kind: string }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for contender")); }, 5000);
		const receive = (value: { kind: string }) => { cleanup(); resolve(value); };
		const exit = () => { cleanup(); reject(new Error("Contender exited early")); };
		function cleanup() { clearTimeout(timer); child.off("message", receive); child.off("exit", exit); }
		child.once("message", receive); child.once("exit", exit);
	});
}

test("execution-store: two processes contending for one repository cannot create two owners", { timeout: 15000 }, async () => {
	const f = fixture();
	const children = [0, 1].map(() => fork(fileURLToPath(new URL("./fixtures/execution/store-contender.mjs", import.meta.url)), [], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "inherit", "ipc"] }));
	try {
		assert.deepEqual((await Promise.all(children.map(message))).map(m => m.kind), ["ready", "ready"]);
		const replies = children.map(message);
		children.forEach(child => child.send({ kind: "start", root: f.root, repo: f.repo, session: f.session }));
		const kinds = (await Promise.all(replies)).map(m => m.kind);
		assert.equal(kinds.filter(k => k === "acquired").length, 1);
		assert.ok(kinds.some(k => ["contention", "lease-held", "recovery-needed"].includes(k)), kinds.join(","));
		assert.equal(f.store.read().epoch, 1);
	} finally {
		await Promise.all(children.map(async child => { const exited = once(child, "exit"); child.send({ kind: "exit" }); await exited; }));
	}
});


test("execution-store: arbitrary same-PID processStart labels never prove death", () => {
 const f = fixture();
 const a = createExecutionStore({ stateRoot: f.root, repo: f.repo, processStart: "session-a" });
 const owner = a.acquire(createCoordinatorOwner(f.session, "session-a"));
 const b = createExecutionStore({ stateRoot: f.root, repo: f.repo, processStart: "session-b" });
 assert.throws(() => b.acquire(createCoordinatorOwner(f.session, "session-b")), /cannot be reclaimed/);
 a.relinquish(owner);
 assert.ok(b.acquire(createCoordinatorOwner(f.session, "session-b")).epoch > owner.epoch);
});

test("execution-store: workspace journal CAS is exclusive and lease/reservation fenced", async () => {
 const f = fixture(), owner = f.store.acquire(f.identity), attempt = seed(f, owner);
 const journal = { workspace: attempt.workspace, operationId: `prepare:${attempt.id}`, inputDigests: [], phase: "pending" as const, before: attempt.baseCommit, head: attempt.baseCommit, appliedDigests: [] };
 const write = async () => f.store.writeWorkspaceJournal(owner, journal, undefined, { attemptId: attempt.id });
 const outcomes = await Promise.allSettled([write(), write()]);
 assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
 assert.equal(outcomes.filter(o => o.status === "rejected").length, 1);
 assert.deepEqual(f.store.readWorkspaceJournal(attempt.workspace.id), journal);
 assert.throws(() => f.store.writeWorkspaceJournal(owner, { ...journal, phase: "complete" }, journal, { attemptId: "other" }), /reservation/);
 f.store.relinquish(owner);
 const next = f.store.acquire(createCoordinatorOwner(f.session, "next"));
 assert.throws(() => f.store.writeWorkspaceJournal(owner, { ...journal, phase: "complete" }, journal, { attemptId: attempt.id }), /no longer owner/);
 assert.deepEqual(f.store.readWorkspaceJournal(attempt.workspace.id), journal);
 writeFileSync(f.store.lockPath, "");
 assert.throws(() => f.store.writeWorkspaceJournal(next, { ...journal, phase: "complete" }, journal, { attemptId: attempt.id }), /Incomplete transaction lock/);
 assert.equal(readFileSync(f.store.lockPath, "utf8"), "");
});


test("execution-store: journal replacement shares the lease lock and interrupted CAS preserves prior bytes", () => {
 const f = fixture(), owner = f.store.acquire(f.identity), attempt = seed(f, owner);
 const journal = { workspace: attempt.workspace, operationId: `prepare:${attempt.id}`, inputDigests: [], phase: "pending" as const, before: attempt.baseCommit, head: attempt.baseCommit, appliedDigests: [] };
 let replaced = false;
 const hooked = createExecutionStore({ stateRoot: f.root, repo: f.repo, beforeReplace: (_temporary, destination) => {
  assert.ok(destination.endsWith(`${attempt.workspace.id}.json`));
  assert.throws(() => f.store.relinquish(owner), (e: unknown) => e instanceof ExecutionStoreError && e.kind === "contention");
  assert.throws(() => f.store.writeWorkspaceJournal(owner, journal, undefined, { attemptId: attempt.id }), /Transaction lock/);
  replaced = true;
 } });
 hooked.writeWorkspaceJournal(owner, journal, undefined, { attemptId: attempt.id }); assert.ok(replaced);
 const failing = createExecutionStore({ stateRoot: f.root, repo: f.repo, beforeReplace: () => { throw new Error("crash before journal rename"); } });
 assert.throws(() => failing.writeWorkspaceJournal(owner, { ...journal, phase: "complete" }, journal, { attemptId: attempt.id }), /crash before journal rename/);
 assert.deepEqual(f.store.readWorkspaceJournal(attempt.workspace.id), journal);
 assert.deepEqual(f.store.read().owner, owner);
});
