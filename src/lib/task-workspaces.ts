import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
	digest, receiptDigest, taskRevisionDigest, validateCheckEvidence,
	type CheckExecutor, type IntegrationIntent, type RepoIdentity, type ResultReceipt,
	type TaskAttempt, type TaskSpec, type WorkspaceAdapter, type WorkspaceInspection,
	type WorkspaceOutcome, type WorkspaceRef,
} from "./execution-contract.ts";

export type WorkspaceGit = (cwd: string, argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
/** Caller must persist atomically before returning; pending records are never replayed. */
export type WorkspaceJournal = {
	workspace: WorkspaceRef; operationId: string; inputDigests: string[];
	phase: "pending" | "complete"; before: string; head: string; appliedDigests: string[];
};
export type TaskWorkspaceOptions = {
	repo: RepoIdentity; referencePath: string; ownedRoot: string; git: WorkspaceGit;
	/** Consult current epoch, exclusive reservation, and delivery ownership fence. */
	owns: (workspace: WorkspaceRef, writer: { attemptId: string } | { integrationId: string }) => Promise<boolean>;
	/** True only for an authorized full SHA recorded after the initial fetch. */
	isFetchedBase: (commit: string) => Promise<boolean>;
	readJournal: (workspaceId: string) => Promise<WorkspaceJournal | undefined>;
	/** Durable compare-and-swap; reject if current record differs from expected. */
	writeJournal: (journal: WorkspaceJournal, expected: WorkspaceJournal | undefined) => Promise<void>;
	resolveReceipt: (digest: string) => Promise<ResultReceipt | undefined>;
	/** Must consult validated producer/manifest state, not just receipt hashes. */
	isEligibleReceipt: (receipt: ResultReceipt) => Promise<boolean>;
};
function requireThat(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
function sha(value: string): boolean { return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value); }
function same(a: unknown, b: unknown): boolean { return digest(a) === digest(b); }
function canonical(path: string): string {
	if (existsSync(path)) return realpathSync(path);
	return resolve(realpathSync(dirname(path)), path.slice(dirname(path).length + 1));
}
function within(root: string, path: string): boolean { const rel = relative(root, path); return !!rel && !rel.startsWith("..") && !isAbsolute(rel); }
async function gitRead(git: WorkspaceGit, cwd: string, argv: string[]): Promise<string> {
	const result = await git(cwd, argv); requireThat(result.exitCode === 0, `Git ${argv[0]} failed: ${result.stderr}`); return result.stdout.trim();
}
function lines(text: string): string[] { return text ? text.split("\n") : []; }
async function range(git: WorkspaceGit, cwd: string, from: string, to: string): Promise<{ commits: string[]; paths: string[] }> {
	requireThat(sha(from) && sha(to), "Full immutable commit IDs required");
	requireThat((await git(cwd, ["merge-base", "--is-ancestor", from, to])).exitCode === 0, "Wrong base ancestry");
	const commits = lines(await gitRead(git, cwd, ["rev-list", "--reverse", "--topo-order", `${from}..${to}`]));
	const paths = new Set<string>();
	for (const commit of commits) {
		const parents = (await gitRead(git, cwd, ["show", "-s", "--format=%P", commit])).split(" ");
		requireThat(parents.length === 1 && sha(parents[0]!), "Merge/root result commits require explicit remediation");
		const changed = await gitRead(git, cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit]);
		for (const path of changed.split("\0").filter(Boolean)) paths.add(path);
	}
	return { commits, paths: [...paths].sort() };
}

export class TaskWorkspaces implements WorkspaceAdapter {
	readonly options: TaskWorkspaceOptions;
	private busy = new Set<string>();
	constructor(options: TaskWorkspaceOptions) { this.options = options; }
	private async validate(workspace: WorkspaceRef): Promise<void> {
		const o = this.options;
		requireThat(realpathSync(o.repo.commonDir) === o.repo.commonDir && digest(o.repo.commonDir) === o.repo.id, "Noncanonical repository");
		requireThat(realpathSync(o.ownedRoot) === o.ownedRoot && canonical(workspace.path) === workspace.path && within(o.ownedRoot, workspace.path), "Workspace outside canonical owned root");
		requireThat(workspace.path !== realpathSync(o.referencePath) && workspace.repoId === o.repo.id, "Reference/foreign workspace refused");
		requireThat(sha(workspace.baseCommit) && await o.isFetchedBase(workspace.baseCommit), "Unrecorded fetched base");
		requireThat(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(workspace.branch) && !workspace.branch.includes(".."), "Unsafe branch");
		requireThat((await o.git(o.referencePath, ["check-ref-format", "--branch", workspace.branch])).exitCode === 0, "Invalid branch");
	}
	async inspect(workspace: WorkspaceRef): Promise<WorkspaceInspection> {
		try {
			await this.validate(workspace);
			const o = this.options, cwd = workspace.path;
			requireThat(realpathSync(cwd) === cwd, "Workspace missing/aliased");
			const common = await gitRead(o.git, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
			requireThat(realpathSync(common) === o.repo.commonDir, "Foreign Git repository");
			requireThat(await gitRead(o.git, cwd, ["symbolic-ref", "--short", "HEAD"]) === workspace.branch, "Workspace branch mismatch");
			const head = await gitRead(o.git, cwd, ["rev-parse", "HEAD"]);
			requireThat(sha(head) && (await o.git(cwd, ["merge-base", "--is-ancestor", workspace.baseCommit, head])).exitCode === 0, "Workspace base mismatch");
			let inProgress: string | undefined;
			for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "index.lock"]) {
				const path = await gitRead(o.git, cwd, ["rev-parse", "--path-format=absolute", "--git-path", marker]);
				if (existsSync(resolve(cwd, path))) { inProgress = marker; break; }
			}
			const journal = await o.readJournal(workspace.id);
			if (journal) requireThat(same(journal.workspace, workspace), "Workspace metadata mismatch");
			if (journal?.phase === "pending") inProgress ??= "unfinished-workspace-intent";
			return { kind: "inspected", workspace, head, clean: !(await gitRead(o.git, cwd, ["status", "--porcelain=v1", "--untracked-files=all"])), ...(inProgress ? { inProgress } : {}), appliedDigests: journal?.appliedDigests ?? [] };
		} catch (error) { return { kind: "unknown", reason: String(error) }; }
	}
	private async receipts(workspace: WorkspaceRef, inputs: ResultReceipt[]): Promise<ResultReceipt[]> {
		const ordered: ResultReceipt[] = [], active = new Set<string>(), seen = new Set<string>();
		const visit = async (receipt: ResultReceipt): Promise<void> => {
			requireThat(!active.has(receipt.digest), "Receipt dependency cycle"); if (seen.has(receipt.digest)) return;
			const { digest: recorded, ...body } = receipt;
			requireThat(recorded === receiptDigest(body) && receipt.schemaVersion === 1 && receipt.repoId === workspace.repoId && receipt.baseCommit === workspace.baseCommit && await this.options.isEligibleReceipt(receipt), "Ineligible prerequisite receipt/base");
			if (receipt.output.kind === "artifact") requireThat(realpathSync(receipt.output.path) === receipt.output.path && statSync(receipt.output.path).isFile() && createHash("sha256").update(readFileSync(receipt.output.path)).digest("hex") === receipt.output.digest, "Prerequisite artifact changed/missing");
			active.add(recorded);
			for (const id of receipt.prerequisiteDigests) { const parent = await this.options.resolveReceipt(id); requireThat(parent && parent.digest === id, "Missing receipt ancestor"); await visit(parent); }
			active.delete(recorded); seen.add(recorded); ordered.push(receipt);
		};
		for (const input of inputs) await visit(input);
		return ordered;
	}
	prepare(request: Parameters<WorkspaceAdapter["prepare"]>[0]): Promise<WorkspaceOutcome> {
		return this.mutate(request.workspace, { attemptId: request.attemptId }, `prepare:${request.attemptId}`, request.workspace.baseCommit, request.workspace.prerequisiteDigests, request.prerequisites, true);
	}
	compose(request: { intent: IntegrationIntent; receipts: ResultReceipt[] }): Promise<WorkspaceOutcome> {
		return this.mutate(request.intent.workspace, { integrationId: request.intent.id }, `compose:${request.intent.id}`, request.intent.beforeCommit, request.intent.inputDigests, request.receipts, false);
	}
	private async mutate(workspace: WorkspaceRef, writer: { attemptId: string } | { integrationId: string }, operationId: string, before: string, ids: string[], inputs: ResultReceipt[], provision: boolean): Promise<WorkspaceOutcome> {
		if (this.busy.has(workspace.path)) return { kind: "refused", reason: "Workspace writer already active" };
		this.busy.add(workspace.path); let pending = false;
		try {
			const o = this.options;
			await this.validate(workspace);
			const own = async () => requireThat(await o.owns(workspace, writer), "Missing exclusive reservation/current execution ownership");
			await own();
			requireThat(sha(before) && same(ids, inputs.map(r => r.digest)) && new Set(ids).size === ids.length, "Prerequisite selection mismatch");
			const receipts = await this.receipts(workspace, inputs);
			const prior = await o.readJournal(workspace.id);
			if (prior) {
				requireThat(same(prior.workspace, workspace), "Journal workspace mismatch");
				requireThat(prior.appliedDigests.every(id => receipts.some(r => r.digest === id)), "Composition contains unrelated prior results");
				if (prior.phase === "pending") return { kind: "unknown", reason: "Unfinished Git intent; inspect manually without replay" };
				if (prior.operationId === operationId) {
					requireThat(same(prior.inputDigests, ids) && prior.before === before, "Operation identity reused");
					const inspected = await this.inspect(workspace);
					requireThat(inspected.kind === "inspected" && inspected.clean && !inspected.inProgress && inspected.head === prior.head, "Completed operation workspace changed");
					return { kind: "prepared", workspace, head: prior.head };
				}
			}
			if (provision) requireThat(!existsSync(workspace.path) && !prior, "Existing workspace cannot be adopted");
			else {
				const inspected = await this.inspect(workspace);
				requireThat(prior && inspected.kind === "inspected" && inspected.clean && !inspected.inProgress && inspected.head === before && prior.head === before, "Composition requires recorded clean before commit");
			}
			// Verify immutable ranges before creating an intent or mutating Git.
			for (const receipt of receipts) if (receipt.output.kind === "commits") {
				requireThat((await o.git(o.referencePath, ["merge-base", "--is-ancestor", workspace.baseCommit, receipt.output.from])).exitCode === 0, "Receipt from unrelated base");
				const actual = await range(o.git, o.referencePath, receipt.output.from, receipt.output.to);
				requireThat(same(actual.commits, receipt.output.commits) && same(actual.paths, receipt.output.paths), "Receipt range mismatch");
			}
			let journal: WorkspaceJournal = { workspace, operationId, inputDigests: ids, phase: "pending", before, head: before, appliedDigests: prior?.appliedDigests ?? [] };
			await own(); pending = true; await o.writeJournal(structuredClone(journal), prior);
			if (provision) {
				await own(); const result = await o.git(o.referencePath, ["wt", workspace.branch, "--base", workspace.baseCommit, "--yes"]);
				requireThat(result.exitCode === 0, `Git helper provisioning uncertain: ${result.stderr}`);
				const inspected = await this.inspect(workspace);
				requireThat(inspected.kind === "inspected" && inspected.head === before && inspected.clean && inspected.inProgress === "unfinished-workspace-intent", "Helper workspace/base mismatch");
			}
			const applied = new Set(journal.appliedDigests), commits = new Set<string>(receipts.filter(r => applied.has(r.digest)).flatMap(r => r.output.kind === "commits" ? r.output.commits : []));
			for (const receipt of receipts) {
				if (applied.has(receipt.digest)) continue;
				if (receipt.output.kind === "commits") for (const commit of receipt.output.commits) {
					if (commits.has(commit)) continue; commits.add(commit);
					// Existing ancestry is safe to skip; cherry-picked ancestor receipts are skipped by digest.
					if ((await o.git(workspace.path, ["merge-base", "--is-ancestor", commit, "HEAD"])).exitCode === 0) continue;
					await own(); const result = await o.git(workspace.path, ["cherry-pick", commit]);
					if (result.exitCode !== 0) return { kind: "conflict", reason: `Composition unfinished; preserved for recovery: ${result.stderr}` };
				}
				applied.add(receipt.digest);
			}
			const head = await gitRead(o.git, workspace.path, ["rev-parse", "HEAD"]);
			requireThat(!(await gitRead(o.git, workspace.path, ["status", "--porcelain=v1", "--untracked-files=all"])), "Composition dirty");
			const expected = structuredClone(journal);
			journal = { ...journal, phase: "complete", head, appliedDigests: [...applied] };
			await own(); await o.writeJournal(structuredClone(journal), expected);
			return { kind: "prepared", workspace, head };
		} catch (error) { return { kind: pending ? "unknown" : "refused", reason: String(error) }; }
		finally { this.busy.delete(workspace.path); }
	}
}

export type ResultCollectionOptions = {
	attempt: TaskAttempt; task: TaskSpec; workspaces: WorkspaceAdapter; git: WorkspaceGit; checks: CheckExecutor;
	/** Exact composed head recorded before launching this attempt. */
	preparedHead: string;
	/** Explicit output decoded from this run's terminal artifacts, never inferred from HEAD. */
	output: { kind: "commits"; commit: string } | { kind: "artifact"; path: string; digest: string };
	artifactRoot: string;
	/** Verify current reservation/epoch and that output is bound to exact terminal run evidence. */
	ownsAttempt: (attempt: TaskAttempt) => Promise<boolean>;
	verifyTerminalOutput: (attempt: TaskAttempt, output: ResultCollectionOptions["output"]) => Promise<boolean>;
	/** Verify the recorded prepared head and prerequisite closure against durable state. */
	verifyPreparedBase: (attempt: TaskAttempt, preparedHead: string) => Promise<boolean>;
	now: () => number;
};
export type ResultCollectionOutcome = { kind: "validated"; receipt: ResultReceipt } | { kind: "refused"; reason: string };
/** Caller persists returned immutable receipt before making a task eligible. */
export async function collectTaskResult(options: ResultCollectionOptions): Promise<ResultCollectionOutcome> {
	try {
		const o = options, a = structuredClone(o.attempt), task = structuredClone(o.task);
		requireThat(a.taskId === task.id && a.taskDigest === taskRevisionDigest(task) && a.phase === "validating" && a.terminal?.outcome === "succeeded" && a.run && same(a.run, a.terminal.run) && a.ownerSessionFile === a.run.ownerSessionFile && !!a.terminal.evidenceDigest && a.terminal.observedAt >= a.createdAt, "Missing exact successful terminal/task evidence");
		requireThat(a.baseCommit === a.workspace.baseCommit && same(a.prerequisiteDigests, a.workspace.prerequisiteDigests) && sha(o.preparedHead) && await o.verifyPreparedBase(a, o.preparedHead), "Prepared base/prerequisites mismatch");
		requireThat(await o.ownsAttempt(a) && await o.verifyTerminalOutput(a, o.output), "Unowned/unbound terminal result");
		const inspection = await o.workspaces.inspect(a.workspace);
		requireThat(inspection.kind === "inspected" && inspection.clean && !inspection.inProgress, "Unclean/unknown workspace result");
		let output: ResultReceipt["output"];
		const artifactDigest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
		if (o.output.kind === "commits") {
			requireThat(task.mode === "mutation" && sha(o.output.commit) && inspection.head === o.output.commit, "Missing exact output commit");
			const actual = await range(o.git, a.workspace.path, o.preparedHead, o.output.commit);
			requireThat(actual.commits.length > 0, "No result commits");
			for (const path of actual.paths) requireThat(!isAbsolute(path) && !path.split("/").includes("..") && task.scope.some(scope => scope && !isAbsolute(scope) && !scope.split("/").includes("..") && (path === scope || (scope.endsWith("/") && path.startsWith(scope)))), `Out of scope: ${path}`);
			output = { kind: "commits", from: o.preparedHead, to: o.output.commit, ...actual };
		} else {
			requireThat(task.mode === "read-only" && inspection.head === o.preparedHead, "Read-only task changed Git head");
			const path = o.output.path;
			requireThat(realpathSync(o.artifactRoot) === o.artifactRoot && realpathSync(path) === path && within(o.artifactRoot, path) && statSync(path).isFile() && artifactDigest(path) === o.output.digest, "Unverified artifact path/digest");
			output = { kind: "artifact", path, digest: o.output.digest };
		}
		const checks: ResultReceipt["checks"] = [];
		for (const check of task.checks) {
			const startedAt = o.now(), invocationId = digest([a.id, a.terminal.evidenceDigest, check.id, startedAt]);
			requireThat(startedAt >= a.terminal.observedAt && await o.ownsAttempt(a), "Stale check/ownership");
			const evidence = await o.checks.execute(check, { workspace: a.workspace, invocationId, startedAt });
			validateCheckEvidence(evidence);
			requireThat(evidence.checkId === check.id && evidence.invocationId === invocationId && evidence.startedAt >= startedAt && evidence.status === "passed" && evidence.exitCode === 0 && o.checks.validateEvidence(check, evidence, { invocationId, notBefore: startedAt }).valid, "Required check evidence rejected");
			if (check.runner !== "command") requireThat(evidence.reportPath && evidence.reportDigest && evidence.executedTests.length > 0 && check.expectedEvidence.requiredTests.every(id => evidence.executedTests.includes(id)), "Missing required native report/tests");
			checks.push(evidence);
		}
		const final = await o.workspaces.inspect(a.workspace);
		requireThat(final.kind === "inspected" && final.clean && !final.inProgress && final.head === inspection.head && await o.ownsAttempt(a), "Workspace changed during validation");
		if (output.kind === "artifact") requireThat(realpathSync(output.path) === output.path && artifactDigest(output.path) === output.digest, "Artifact changed during validation");
		const validatedAt = o.now(); requireThat(validatedAt >= a.terminal.observedAt && checks.every(c => c.finishedAt <= validatedAt), "Invalid validation time");
		const body: Omit<ResultReceipt, "digest"> = { schemaVersion: 1, attemptId: a.id, taskId: a.taskId, taskDigest: a.taskDigest, repoId: a.workspace.repoId, baseCommit: a.baseCommit, prerequisiteDigests: a.prerequisiteDigests, output, checks, validatedAt };
		return { kind: "validated", receipt: { ...body, digest: receiptDigest(body) } };
	} catch (error) { return { kind: "refused", reason: String(error) }; }
}
