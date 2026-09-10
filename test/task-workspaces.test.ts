import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTaskResult, TaskWorkspaces, type ResultCollectionOptions, type WorkspaceGit, type WorkspaceJournal } from "../src/lib/task-workspaces.ts";
import { digest, receiptDigest, taskRevisionDigest, type ResultReceipt, type WorkspaceRef } from "../src/lib/execution-contract.ts";
import { fakeAttempt, fakeCheck, FakeCheckExecutor, fakeManifest } from "./fixtures/execution/fakes.ts";

// Repositories are intentionally retained, including failed-operation checkpoints.
function run(cwd: string, args: readonly string[]): string {
	assert.notEqual(args[0], "symbolic-ref", "Prohibited Git command");
	const stdout = execFileSync("git", [...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" }, stdio: ["ignore", "pipe", "pipe"] });
	return args.includes("-z") ? stdout : stdout.trim();
}
function commit(cwd: string, path: string, text: string): string { mkdirSync(join(cwd, "src"), { recursive: true }); writeFileSync(join(cwd, path), text); run(cwd, ["add", path]); run(cwd, ["commit", "-m", text]); return run(cwd, ["rev-parse", "HEAD"]); }
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "u4-workspaces-"))), reference = join(root, "reference"), ownedRoot = join(root, "owned");
	mkdirSync(reference); mkdirSync(ownedRoot); run(reference, ["init", "--initial-branch=main"]);
	const base = commit(reference, "src/base", "base"), commonDir = realpathSync(join(reference, ".git")), repo = { commonDir, id: digest(commonDir) };
	const journals = new Map<string, WorkspaceJournal>(), receipts = new Map<string, ResultReceipt>(), calls: string[][] = [];
	let owned = true, fetched = true, failProvision = false, failJournal = false;
	const workspaces = Array.from({ length: 5 }, (_, index): WorkspaceRef => ({ id: `ws-${index}`, path: join(ownedRoot, `ws-${index}`), branch: `ws-${index}`, repoId: repo.id, baseCommit: base, prerequisiteDigests: [] }));
	const git: WorkspaceGit = async (cwd, argv) => {
		calls.push([...argv]);
		try {
			if (argv[0] === "wt") {
				const ws = workspaces.find(w => w.branch === argv[1])!;
				mkdirSync(ws.path); if (failProvision) throw new Error("lost helper reply/partial provision");
				// Injected provisioning stand-in: isolated repository, same immutable Git objects.
				// No installed git-wt or forbidden worktree setup/cleanup is used by tests.
				run(ws.path, ["init", `--initial-branch=${ws.branch}`]); run(ws.path, ["fetch", reference, base]); run(ws.path, ["merge", "--ff-only", "FETCH_HEAD"]);
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (argv.includes("--git-common-dir") && cwd !== reference) return { exitCode: 0, stdout: commonDir, stderr: "" };
			if (argv[0] === "cherry-pick") run(cwd, ["fetch", reference, argv[1]!]);
			return { exitCode: 0, stdout: run(cwd, argv), stderr: "" };
		} catch (error) { return { exitCode: 1, stdout: "", stderr: String(error) }; }
	};
	const adapter = new TaskWorkspaces({ repo, referencePath: reference, ownedRoot, git,
		owns: async () => owned, isFetchedBase: async value => fetched && value === base,
		readJournal: async id => structuredClone(journals.get(id)), writeJournal: async (journal, expected) => { assert.deepEqual(journals.get(journal.workspace.id), expected, "journal CAS"); if (failJournal && journal.phase === "complete") throw new Error("crash before receipt"); journals.set(journal.workspace.id, structuredClone(journal)); },
		resolveReceipt: async id => receipts.get(id), isEligibleReceipt: async r => receipts.has(r.digest),
	});
	function receipt(taskId: string, from: string, to: string, paths: string[], prerequisites: string[] = []): ResultReceipt {
		const body: Omit<ResultReceipt, "digest"> = { schemaVersion: 1, attemptId: taskId, taskId, taskDigest: digest(taskId), repoId: repo.id, baseCommit: base, prerequisiteDigests: prerequisites, output: { kind: "commits", from, to, commits: run(reference, ["rev-list", "--reverse", `${from}..${to}`]).split("\n"), paths }, checks: [], validatedAt: 1 };
		const result = { ...body, digest: receiptDigest(body) }; receipts.set(result.digest, result); return result;
	}
	return { root, reference, base, repo, workspaces, journals, receipts, calls, git, adapter, receipt,
		setOwned: (v: boolean) => { owned = v; }, setFetched: (v: boolean) => { fetched = v; }, setFailProvision: () => { failProvision = true; }, setFailJournal: () => { failJournal = true; } };
}

test("five distinct reserved workspaces preserve dirty reference and use pinned git wt argv", async () => {
	const f = fixture(); writeFileSync(join(f.reference, "src/base"), "user changes"); writeFileSync(join(f.reference, "untracked"), "user file");
	const before = run(f.reference, ["status", "--porcelain=v1"]);
	const results = await Promise.all(f.workspaces.map(w => f.adapter.prepare({ attemptId: w.id, workspace: w, prerequisites: [] })));
	assert.ok(results.every(r => r.kind === "prepared")); assert.equal(new Set(results.map(r => r.kind === "prepared" && r.workspace.path)).size, 5);
	assert.equal(run(f.reference, ["status", "--porcelain=v1"]), before); assert.equal(readFileSync(join(f.reference, "src/base"), "utf8"), "user changes");
	assert.deepEqual(f.calls.filter(a => a[0] === "wt"), f.workspaces.map(w => ["wt", w.branch, "--base", f.base, "--yes"]));
	assert.ok(!f.calls.some(a => ["worktree", "reset", "restore", "checkout", "clean", "rebase"].includes(a[0]!)));
});

test("reservation and fetched base refusal happen before provisioning", async () => {
	const f = fixture(), workspace = f.workspaces[0]!;
	f.setOwned(false); assert.equal((await f.adapter.prepare({ attemptId: "a", workspace, prerequisites: [] })).kind, "refused");
	f.setOwned(true); f.setFetched(false); assert.equal((await f.adapter.prepare({ attemptId: "a", workspace, prerequisites: [] })).kind, "refused");
	assert.equal((await f.adapter.prepare({ attemptId: "a", workspace: { ...workspace, path: f.reference }, prerequisites: [] })).kind, "refused");
	assert.equal(f.calls.filter(a => a[0] === "wt").length, 0);
});

test("shared ancestor DAG is applied once and unrelated sibling excluded", async () => {
	const f = fixture(), ancestor = commit(f.reference, "src/ancestor", "ancestor"), a = f.receipt("ancestor", f.base, ancestor, ["src/ancestor"]);
	const left = commit(f.reference, "src/left", "left"), l = f.receipt("left", ancestor, left, ["src/left"], [a.digest]);
	// A second original history branches at ancestor without switching any checkout.
	const branch = join(f.root, "right"); mkdirSync(branch); run(branch, ["init", "--initial-branch=right"]); run(branch, ["fetch", f.reference, ancestor]); run(branch, ["merge", "--ff-only", "FETCH_HEAD"]);
	const right = commit(branch, "src/right", "right"); run(f.reference, ["fetch", branch, right]);
	const r = f.receipt("right", ancestor, right, ["src/right"], [a.digest]);
	commit(f.reference, "src/unrelated", "unrelated");
	const workspace = { ...f.workspaces[0]!, prerequisiteDigests: [l.digest, r.digest] }; f.workspaces[0] = workspace;
	const result = await f.adapter.prepare({ attemptId: "dependent", workspace, prerequisites: [l, r] });
	assert.equal(result.kind, "prepared");
	assert.deepEqual(run(workspace.path, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n"), ["src/ancestor", "src/base", "src/left", "src/right"]);
	assert.equal(run(workspace.path, ["rev-list", "--count", `${f.base}..HEAD`]), "3");
	const inspected = await f.adapter.inspect(workspace);
	assert.ok(inspected.kind === "inspected");
	assert.deepEqual(inspected.appliedDigests, [a.digest, l.digest, r.digest]);
	const count = f.calls.filter(a => a[0] === "cherry-pick").length;
	assert.equal((await f.adapter.prepare({ attemptId: "dependent", workspace, prerequisites: [l, r] })).kind, "prepared");
	assert.equal(f.calls.filter(a => a[0] === "cherry-pick").length, count);
	assert.ok(result.kind === "prepared");
	assert.equal((await f.adapter.compose({ intent: { id: "ordered", deliveryGroupId: "d", workspace, inputDigests: [a.digest, r.digest, l.digest], createdAt: 1, beforeCommit: result.head, phase: "planned" }, receipts: [a, r, l] })).kind, "prepared");
	const reordered = await f.adapter.inspect(workspace); assert.ok(reordered.kind === "inspected");
	assert.deepEqual(reordered.appliedDigests, [a.digest, r.digest, l.digest]);
	assert.equal(f.calls.filter(a => a[0] === "cherry-pick").length, count);
	f.receipts.delete(a.digest);
	assert.equal((await f.adapter.inspect(workspace)).kind, "unknown");
});

test("partial provisioning and crash after mutation preserve pending intents without replay", async () => {
	for (const crash of ["provision", "journal"]) {
		const f = fixture(), workspace = f.workspaces[0]!;
		if (crash === "provision") f.setFailProvision(); else f.setFailJournal();
		assert.equal((await f.adapter.prepare({ attemptId: "a", workspace, prerequisites: [] })).kind, "unknown");
		assert.equal(f.journals.get(workspace.id)?.phase, "pending");
		assert.equal((await f.adapter.prepare({ attemptId: "a", workspace, prerequisites: [] })).kind, "unknown");
		assert.equal(f.calls.filter(a => a[0] === "wt").length, 1);
	}
});

test("in-progress Git operation is surfaced and composition refuses mutation", async () => {
	const f = fixture(), workspace = f.workspaces[0]!; await f.adapter.prepare({ attemptId: "a", workspace, prerequisites: [] });
	writeFileSync(join(workspace.path, ".git", "CHERRY_PICK_HEAD"), f.base);
	const inspected = await f.adapter.inspect(workspace); assert.ok(inspected.kind === "inspected"); assert.equal(inspected.inProgress, "CHERRY_PICK_HEAD");
	assert.equal((await f.adapter.compose({ intent: { id: "integration", deliveryGroupId: "d", workspace, inputDigests: [], createdAt: 1, beforeCommit: f.base, phase: "planned" }, receipts: [] })).kind, "refused");
});

async function resultFixture(readOnly = false, withPrerequisite = false) {
	const f = fixture(), prerequisite = withPrerequisite ? artifactReceipt(f) : undefined;
	const workspace = f.workspaces[0]!;
	workspace.prerequisiteDigests = prerequisite ? [prerequisite.digest] : [];
	await f.adapter.prepare({ attemptId: "a", workspace, prerequisites: prerequisite ? [prerequisite] : [] });
	const manifest = fakeManifest(), task = manifest.tasks[0]!; if (readOnly) task.mode = "read-only";
	const attempt = fakeAttempt(manifest); attempt.workspace = workspace; attempt.baseCommit = f.base; attempt.phase = "validating";
	attempt.prerequisiteDigests = workspace.prerequisiteDigests;
	attempt.run = { runId: "run", artifactDir: f.root, ownerSessionFile: attempt.ownerSessionFile };
	attempt.terminal = { kind: "terminal", outcome: "succeeded", run: attempt.run, evidenceDigest: digest("terminal"), observedAt: 2 };
	const head = readOnly ? f.base : commit(workspace.path, "src/result", "result");
	const options: ResultCollectionOptions = { attempt, task, workspaces: f.adapter, git: f.git, checks: new FakeCheckExecutor(), preparedHead: f.base, output: { kind: "commits", commit: head }, artifactRoot: f.root, ownsAttempt: async () => true, verifyTerminalOutput: async () => true, verifyPreparedBase: async (_a, base) => base === f.base, now: () => 10 };
	return { ...f, options, head, prerequisite };
}

test("immutable result capture is deterministic and rejects arbitrary HEAD, wrong base and scope", async () => {
	const f = await resultFixture(), result = await collectTaskResult(f.options);
	assert.equal(result.kind, "validated"); assert.deepEqual(await collectTaskResult(f.options), result);
	assert.equal((await collectTaskResult({ ...f.options, verifyTerminalOutput: async () => false })).kind, "refused");
	assert.equal((await collectTaskResult({ ...f.options, preparedHead: f.head })).kind, "refused");
	f.options.task.scope = ["other/"]; f.options.attempt.taskDigest = taskRevisionDigest(f.options.task);
	assert.equal((await collectTaskResult(f.options)).kind, "refused");
	if (result.kind === "validated") { const frozen = result.receipt.digest; commit(f.options.attempt.workspace.path, "src/later", "later"); assert.equal(result.receipt.digest, frozen); }
	assert.equal((await collectTaskResult(f.options)).kind, "refused");
});

test("terminal identity, ownership, and fresh native check evidence gate receipts", async () => {
	const f = await resultFixture();
	assert.equal((await collectTaskResult({ ...f.options, ownsAttempt: async () => false })).kind, "refused");
	assert.equal((await collectTaskResult({ ...f.options, attempt: { ...f.options.attempt, run: { ...f.options.attempt.run!, runId: "wrong" } } })).kind, "refused");
	const check = fakeCheck(); f.options.task.checks = [check]; f.options.attempt.taskDigest = taskRevisionDigest(f.options.task);
	assert.equal((await collectTaskResult(f.options)).kind, "refused");
	f.options.checks = {
		execute: async (_spec, ctx) => ({ checkId: check.id, invocationId: ctx.invocationId, startedAt: ctx.startedAt, finishedAt: ctx.startedAt, exitCode: 0, executedTests: ["test-a"], skippedTests: [], status: "passed", reportPath: "report.json", reportDigest: digest("report") }),
		validateEvidence: () => ({ valid: true, reasons: [] }),
	};
	assert.equal((await collectTaskResult(f.options)).kind, "validated");
	f.options.checks.validateEvidence = () => ({ valid: false, reasons: ["stale native report"] });
	assert.equal((await collectTaskResult(f.options)).kind, "refused");
});

test("read-only artifacts require explicit canonical path and verified bytes digest", async () => {
	const f = await resultFixture(true), path = join(f.root, "result.txt"); writeFileSync(path, "result");
	const { createHash } = await import("node:crypto");
	f.options.output = { kind: "artifact", path, digest: createHash("sha256").update("result").digest("hex") };
	assert.equal((await collectTaskResult(f.options)).kind, "validated");
	writeFileSync(path, "changed"); assert.equal((await collectTaskResult(f.options)).kind, "refused");
	f.options.output.path = join(f.root, "..", "escape"); assert.equal((await collectTaskResult(f.options)).kind, "refused");
});


test("concurrent duplicate writer and mismatched receipt claims are fenced", async () => {
	const f = fixture(), workspace = f.workspaces[0]!;
	const first = f.adapter.prepare({ attemptId: "a", workspace, prerequisites: [] });
	assert.equal((await f.adapter.prepare({ attemptId: "a", workspace, prerequisites: [] })).kind, "refused");
	assert.equal((await first).kind, "prepared");
	const head = commit(f.reference, "src/input", "input"), receipt = f.receipt("input", f.base, head, ["src/input"]);
	const next = { ...f.workspaces[1]!, prerequisiteDigests: [receipt.digest] }; f.workspaces[1] = next;
	assert.equal((await f.adapter.prepare({ attemptId: "b", workspace: next, prerequisites: [] })).kind, "refused");
	const forged = { ...receipt, output: { ...receipt.output, paths: ["src/not-real"] } } as ResultReceipt;
	assert.equal((await f.adapter.prepare({ attemptId: "b", workspace: next, prerequisites: [forged] })).kind, "refused");
	assert.equal(f.calls.filter(a => a[0] === "wt").length, 1);
});

test("conflicting composition is retained and never cherry-picked again", async () => {
	const f = fixture(), left = commit(f.reference, "src/base", "left"), l = f.receipt("left", f.base, left, ["src/base"]);
	const branch = join(f.root, "conflicting"); mkdirSync(branch); run(branch, ["init", "--initial-branch=conflicting"]); run(branch, ["fetch", f.reference, f.base]); run(branch, ["merge", "--ff-only", "FETCH_HEAD"]);
	const right = commit(branch, "src/base", "right"); run(f.reference, ["fetch", branch, right]);
	const r = f.receipt("right", f.base, right, ["src/base"]);
	const workspace = { ...f.workspaces[0]!, prerequisiteDigests: [l.digest, r.digest] }; f.workspaces[0] = workspace;
	assert.equal((await f.adapter.prepare({ attemptId: "a", workspace, prerequisites: [l, r] })).kind, "conflict");
	assert.equal(f.journals.get(workspace.id)?.phase, "pending");
	const inspected = await f.adapter.inspect(workspace); assert.ok(inspected.kind === "inspected"); assert.equal(inspected.inProgress, "CHERRY_PICK_HEAD");
	const count = f.calls.filter(a => a[0] === "cherry-pick").length;
	assert.equal((await f.adapter.prepare({ attemptId: "a", workspace, prerequisites: [l, r] })).kind, "unknown");
	assert.equal(f.calls.filter(a => a[0] === "cherry-pick").length, count);
});

test("composition refuses reuse containing an unrelated previously applied sibling", async () => {
	const f = fixture(), workspace = f.workspaces[0]!;
	await f.adapter.prepare({ attemptId: "a", workspace, prerequisites: [] });
	const head = commit(f.reference, "src/sibling", "sibling"), sibling = f.receipt("sibling", f.base, head, ["src/sibling"]);
	const intent = { id: "first", deliveryGroupId: "d", workspace, inputDigests: [sibling.digest], createdAt: 1, beforeCommit: f.base, phase: "planned" as const };
	const result = await f.adapter.compose({ intent, receipts: [sibling] }); assert.ok(result.kind === "prepared");
	assert.equal((await f.adapter.compose({ intent: { ...intent, id: "unrelated", inputDigests: [], beforeCommit: result.head }, receipts: [] })).kind, "refused");
});

test("checks cannot mutate the frozen output before receipt collection completes", async () => {
	const f = await resultFixture(), check = fakeCheck(); f.options.task.checks = [check]; f.options.attempt.taskDigest = taskRevisionDigest(f.options.task);
	f.options.checks = {
		execute: async (_spec, ctx) => {
			commit(ctx.workspace.path, "src/from-check", "check mutation");
			return { checkId: check.id, invocationId: ctx.invocationId, startedAt: 10, finishedAt: 10, exitCode: 0, status: "passed", executedTests: ["test-a"], skippedTests: [], reportPath: "report", reportDigest: digest("report") };
		}, validateEvidence: () => ({ valid: true, reasons: [] }),
	};
	assert.equal((await collectTaskResult(f.options)).kind, "refused");
});

function artifactReceipt(f: ReturnType<typeof fixture>): ResultReceipt {
	const path = join(f.root, "prerequisite.txt"); writeFileSync(path, "prerequisite");
	const body: Omit<ResultReceipt, "digest"> = { schemaVersion: 1, attemptId: "artifact", taskId: "artifact", taskDigest: digest("artifact"), repoId: f.repo.id, baseCommit: f.base, prerequisiteDigests: [], output: { kind: "artifact", path, digest: createHash("sha256").update("prerequisite").digest("hex") }, checks: [], validatedAt: 1 };
	const receipt = { ...body, digest: receiptDigest(body) }; f.receipts.set(receipt.digest, receipt); return receipt;
}

test("result scope preserves real leading-whitespace Git filenames", async () => {
	const f = await resultFixture(), cwd = f.options.attempt.workspace.path;
	mkdirSync(join(cwd, "\tsrc"));
	const head = commit(cwd, "\tsrc/escape", "escape");
	f.options.output = { kind: "commits", commit: head };
	const result = await collectTaskResult(f.options);
	assert.equal(result.kind, "refused");
	if (result.kind === "refused") assert.match(result.reason, /Out of scope: \tsrc\/escape/);
});

test("inspection revalidates composed artifacts and receipt closure", async () => {
	for (const change of ["bytes", "deleted", "ineligible", "closure"]) {
		const f = fixture(), workspace = f.workspaces[0]!, receipt = artifactReceipt(f);
		assert.equal((await f.adapter.prepare({ attemptId: "a", workspace, prerequisites: [] })).kind, "prepared");
		assert.equal((await f.adapter.compose({ intent: { id: "integration", deliveryGroupId: "d", workspace, inputDigests: [receipt.digest], createdAt: 1, beforeCommit: f.base, phase: "planned" }, receipts: [receipt] })).kind, "prepared");
		const inspected = await f.adapter.inspect(workspace); assert.ok(inspected.kind === "inspected");
		assert.deepEqual(inspected.appliedDigests, [receipt.digest]);
		assert.ok(receipt.output.kind === "artifact");
		if (change === "bytes") writeFileSync(receipt.output.path, "changed");
		if (change === "deleted") unlinkSync(receipt.output.path);
		if (change === "ineligible") f.adapter.options.isEligibleReceipt = async () => false;
		if (change === "closure") f.journals.get(workspace.id)!.appliedDigests = [];
		assert.equal((await f.adapter.inspect(workspace)).kind, "unknown", change);
	}
});

test("receipt collection rejects prerequisite artifacts changed during checks", async () => {
	const f = await resultFixture(false, true), receipt = f.prerequisite!;
	const check = fakeCheck(); f.options.task.checks = [check]; f.options.attempt.taskDigest = taskRevisionDigest(f.options.task);
	f.options.checks = {
		execute: async (_spec, ctx) => {
			assert.ok(receipt.output.kind === "artifact"); writeFileSync(receipt.output.path, "changed during check");
			return { checkId: check.id, invocationId: ctx.invocationId, startedAt: 10, finishedAt: 10, exitCode: 0, status: "passed", executedTests: ["test-a"], skippedTests: [], reportPath: "report", reportDigest: digest("report") };
		}, validateEvidence: () => ({ valid: true, reasons: [] }),
	};
	const result = await collectTaskResult(f.options); assert.equal(result.kind, "refused");
	if (result.kind === "refused") assert.match(result.reason, /Workspace changed during validation/);
});
