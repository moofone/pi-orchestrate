import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fakeManifest, FakeAttemptRuntime } from "./fixtures/execution/fakes.ts";
import { digest, sourceDigest, validateAuthorization, type ExecutionManifest, type Provenance } from "../src/lib/execution-contract.ts";
import { importPlanSource, interpretPlan, normalizeInterpretation, authorizeInterpretation, interpretationConflicts, assessPlanRevision, normalizeCheck, validateImportedManifest, type ImportOptions } from "../src/lib/plan-import.ts";

// These are injected interpretation responses, not a Markdown parser or an LLM implementation.
async function response(fixture = "five-workers", count = 6) {
	const source = await importPlanSource(resolve(`test/fixtures/execution/import/${fixture}.md`));
	const m = fakeManifest(count); m.source = source;
	const inferred = (field: string): Provenance => ({ field, origin: "inferred", reason: "Conservative interpretation of omitted detail" });
	const explicit = (field: string, line: number): Provenance => ({ field, origin: "explicit", anchor: { path: source.path, startLine: line, endLine: line } });
	m.provenance = ["scope", "features", "deliveryGroups"].map(inferred);
	m.constraints.provenance = [inferred("capacity")];
	for (const t of m.tasks) t.provenance = ["text", "mode", "dependencies", "scope", "profile", "deliveryGroupId"].map(inferred);
	if (fixture === "five-workers") {
		m.features.push({ id: "feature-b", title: "Notifications", scope: "notifications" });
		m.deliveryGroups.push({ ...structuredClone(m.deliveryGroups[0]!), id: "delivery-b", featureIds: ["feature-b"], requiredTaskIds: [m.tasks[5]!.id], ownerId: "feature-b" });
		m.deliveryGroups[0]!.requiredTaskIds = m.tasks.slice(0, 5).map(t => t.id);
		m.tasks[5]!.featureId = "feature-b"; m.tasks[5]!.deliveryGroupId = "delivery-b";
		for (const t of m.tasks.slice(0, 5)) { t.profile = { agent: "specialist", model: "custom/model", context: "fork" }; t.provenance = t.provenance.filter(p => p.field !== "profile").concat(explicit("profile", 4)); }
		m.constraints.parallelGroups = [{ id: "search-five", taskIds: m.tasks.slice(0, 5).map(t => t.id), simultaneous: 5, provenance: explicit("parallelGroups", 3) }];
		m.deliveryGroups.forEach(d => { d.policy = "pr"; d.completion = "merged"; });
	}
	const options: ImportOptions = { id: m.id, revision: 1, repo: m.repo, baseCommit: m.baseCommit, source };
	return { m, options };
}

test("plan-import: ordinary five-worker Markdown preserves independent feature and explicit fork profiles", async () => {
	const { m, options } = await response();
	const result = await interpretPlan(options, async request => {
		assert.match(request.prompt, /Infer omissions/); assert.equal(request.source.digest, options.source.digest);
		return { manifest: m, unresolvedDecisions: [] };
	});
	assert.equal(result.manifest.tasks.length, 6); assert.equal(result.manifest.features.length, 2);
	assert.equal(result.manifest.constraints.parallelGroups[0]!.simultaneous, 5);
	assert.deepEqual(result.manifest.tasks[0]!.profile, { agent: "specialist", model: "custom/model", context: "fork" });
	assert.equal(result.manifest.tasks[5]!.dependencies.length, 0);
	const original = digest(result.manifest);
	assert.match(interpretationConflicts(result.manifest, 2, new FakeAttemptRuntime().capabilities).join(), /Requested capacity 6/);
	assert.throws(() => authorizeInterpretation(result, { capacity: 2, publication: true, approvedBy: "user", approvedAt: 1 }), /capacity/);
	assert.equal(digest(result.manifest), original);
	const limited = new FakeAttemptRuntime().capabilities; limited.profiles = ["agent", "model"];
	assert.match(interpretationConflicts(result.manifest, 6, limited).join(), /unsupported profile context/);
	const revision = structuredClone(result.manifest); revision.revision++;
	revision.constraints.parallelGroups = [];
	assert.equal(assessPlanRevision(result.manifest, revision).decision.kind, "approval-required");
	const auth = authorizeInterpretation(result, { capacity: 6, publication: true, approvedBy: "user", approvedAt: 1 });
	validateAuthorization(result.manifest, auth);
	assert.throws(() => authorizeInterpretation({ ...result, unresolvedDecisions: ["Conflicting delivery instructions"] }, { capacity: 6, publication: true, approvedBy: "user", approvedAt: 1 }), /Resolve/);
});

test("plan-import: sparse Markdown is data and more than twelve tasks are valid", async () => {
	const { m, options } = await response("sparse", 15);
	const result = await interpretPlan(options, async () => ({ manifest: m, unresolvedDecisions: [] }));
	assert.equal(result.manifest.tasks.length, 15);
	assert.deepEqual(result.manifest.tasks[0]!.profile, {});
	assert.equal(await readFile(options.source.path, "utf8"), options.source.bytes);
	assert.ok(result.manifest.tasks[0]!.provenance.every(p => p.origin === "inferred"));
});

test("plan-import: untrusted schema, anchors, ownership, cycles and references are rejected", async () => {
	const { m, options } = await response("sparse", 2);
	const mutations: ((v: ExecutionManifest) => void)[] = [
		v => { (v as unknown as Record<string, unknown>).script = "run()"; },
		v => { v.repo.commonDir = "/elsewhere"; },
		v => { v.tasks[0]!.dependencies = ["missing"]; },
		v => { v.tasks[0]!.dependencies = [v.tasks[1]!.id]; v.tasks[1]!.dependencies = [v.tasks[0]!.id]; },
		v => { v.tasks[1]!.id = v.tasks[0]!.id; },
		v => { v.tasks[0]!.provenance[0] = { field: "text", origin: "explicit" }; },
		v => { v.tasks[0]!.provenance[0] = { field: "text", origin: "explicit", anchor: { path: v.source.path, startLine: 999, endLine: 1000 } }; },
		v => { v.tasks[0]!.provenance = []; },
		v => { v.source.bytes += "changed"; v.source.digest = sourceDigest(v.source.bytes); },
	];
	for (const mutate of mutations) { const v = structuredClone(m); mutate(v); assert.throws(() => normalizeInterpretation({ manifest: v, unresolvedDecisions: [] }, options)); }
});

test("plan-import: explicit contradictory source remains unresolved and unsafe source checks are rejected", async () => {
	const { m, options } = await response("conflict", 5);
	const result = await interpretPlan(options, async () => ({ manifest: m, unresolvedDecisions: ["Five simultaneous workers conflict with the explicit two-worker ceiling"] }));
	assert.throws(() => authorizeInterpretation(result, { capacity: 5, publication: false, approvedBy: "user", approvedAt: 1 }), /Resolve/);
	const unsafe = await response("unsafe-check", 1);
	unsafe.m.tasks[0]!.checks = [{ id: "unsafe", cwd: ".", runner: "command", argv: ["sh", "-c", "node --test; echo $(touch sentinel)"], expectedEvidence: { requiredTests: [], rationale: "Source proposed validation" } }];
	await assert.rejects(interpretPlan(unsafe.options, async () => ({ manifest: unsafe.m, unresolvedDecisions: [] })), /Unsafe/);
});

test("plan-import: normalized argv refuses shell, traversal, inline code and mismatched runners", () => {
	const check = { id: "unit", cwd: ".", argv: ["node", "--test", "test/unit.test.ts"], runner: "node", expectedEvidence: { reportPath: "unit.json", requiredTests: ["unit"] } };
	assert.deepEqual(normalizeCheck(check), check);
	for (const argv of [["sh", "-c", "echo hi"], ["node", "--test", "$(touch sentinel)"], ["node", "--test", ";echo"], ["node", "--test", "--eval=evil"], ["git", "reset"], ["node", "test.ts"]]) assert.throws(() => normalizeCheck({ ...check, argv }));
	assert.throws(() => normalizeCheck({ ...check, cwd: "../outside" }));
	assert.throws(() => normalizeCheck({ ...check, expectedEvidence: { reportPath: "/outside", requiredTests: [] } }));
	assert.throws(() => normalizeCheck({ ...check, runner: "command", argv: ["tsc", "--noEmit"], expectedEvidence: { requiredTests: [] } }));
	assert.equal(normalizeCheck({ ...check, runner: "command", argv: ["tsc", "--noEmit"], expectedEvidence: { requiredTests: [], rationale: "Type safety" } }).runner, "command");
});

test("plan-import: source snapshots retain bytes and never auto-refresh approved revisions", async () => {
	const dir = await mkdtemp(`${tmpdir()}/plan-import-`), path = `${dir}/plan with spaces.md`;
	await writeFile(path, "\ufeff# Original\r\n"); const source = await importPlanSource(path);
	assert.equal(source.bytes, "\ufeff# Original\r\n");
	await writeFile(path, "# Changed\n"); const next = await importPlanSource(path);
	assert.notEqual(next.digest, source.digest); assert.equal(source.bytes, "\ufeff# Original\r\n");
});

test("plan-import: stable identity, approval binding, changed pending dependents and immutable contracts", async () => {
	const { m, options } = await response("sparse", 3);
	const first = normalizeInterpretation({ manifest: m, unresolvedDecisions: [] }, options).manifest;
	first.tasks[1]!.dependencies = [first.tasks[0]!.id];
	const before = digest(first), next = structuredClone(first); next.revision++;
	next.source.bytes += "\nRefine the index.\n"; next.source.digest = sourceDigest(next.source.bytes);
	next.tasks[0]!.text = "Refined index";
	const normalized = normalizeInterpretation({ manifest: next, unresolvedDecisions: [] }, { ...options, revision: 2, source: next.source, previous: first }).manifest;
	assert.deepEqual(normalized.tasks.map(t => t.id), first.tasks.map(t => t.id));
	const result = assessPlanRevision(first, normalized, { immutableTaskIds: [first.tasks[0]!.id] });
	assert.equal(result.decision.kind, "approval-required"); assert.equal(result.sourceChanged, true);
	assert.deepEqual(result.affectedPendingTaskIds, [first.tasks[1]!.id]);
	assert.deepEqual(result.retainedTaskIds, [first.tasks[0]!.id]); assert.equal(digest(first), before);
	const auth = authorizeInterpretation({ manifest: first, unresolvedDecisions: [] }, { capacity: 3, publication: false, approvedBy: "user", approvedAt: 1 });
	assert.throws(() => validateAuthorization(normalized, auth), /bind/);
});

test("plan-import: only proven in-scope additive subtasks avoid new scope approval", async () => {
	const { m } = await response("sparse", 1); const next = structuredClone(m); next.revision++;
	next.source = await importPlanSource(resolve("test/fixtures/execution/import/revised.md"));
	const added = { ...structuredClone(m.tasks[0]!), id: "discovered", parentTaskId: m.tasks[0]!.id, text: "Necessary internal helper" }; next.tasks.push(added);
	validateImportedManifest(next);
	assert.equal(assessPlanRevision(m, next).decision.kind, "approval-required");
	assert.equal(assessPlanRevision(m, next, { inScopeTaskIds: [added.id] }).decision.kind, "in-scope");
	next.scope = "New product";
	assert.equal(assessPlanRevision(m, next, { inScopeTaskIds: [added.id] }).decision.kind, "approval-required");
});
