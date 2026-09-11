import { stableTaskId, type ExecutionManifest, type ExecutionProfile, type Provenance, type CheckSpec } from "./execution-contract.ts";
import { parseTasks, taskSection, featureTitle, taskGateCommand, isPendingToken } from "./plan-tasks.ts";
import { validateImportedManifest, type ImportOptions } from "./plan-import.ts";

export type LegacyRole = "worker" | "plan-reviewer" | "feature-qa";
/** Only selectable legacy defaults; never imported by the plan-driven normalizer. */
export function legacyProfileDefaults(role: LegacyRole): ExecutionProfile {
	return { agent: role === "worker" ? "tdd-worker" : role, model: role === "worker" ? "openai-codex/gpt-5.6-luna" : "xai/grok-4.6", thinking: role === "worker" ? "xhigh" : "high", context: "fresh", supervisor: false, intercom: false, tools: ["read", "grep", "find", "ls", "bash", "edit", "write"], maxTurns: role === "worker" ? 220 : 60, timeoutMs: 90 * 60 * 1000 };
}
/** Return launch overrides, not the agent's resolved settings. Undefined resolution means
 * the caller has not resolved the agent yet: withhold fallback fields in that case. */
export function legacyLaunchProfile(role: LegacyRole, explicit: ExecutionProfile = {}, resolved?: ExecutionProfile): ExecutionProfile {
	if (!resolved) return structuredClone(explicit);
	const fallback = legacyProfileDefaults(role);
	for (const key of Object.keys(resolved) as (keyof ExecutionProfile)[]) delete fallback[key];
	return { ...fallback, ...explicit };
}
export type LegacyCompileOptions = {
	/** These are explicit caller choices, not global configuration writes. */
	profiles?: Record<string, ExecutionProfile>;
	checks?: Record<string, CheckSpec[]>;
	deliveryChecks?: CheckSpec[];
	policy?: "local" | "pr";
};
/** New runs only. Existing status/handoff state is neither consumed nor hot-migrated.
 * QA failure/remediation remains a revision decision, never predeclared successful QA. */
export function compileLegacyPreset(input: ImportOptions, options: LegacyCompileOptions = {}): ExecutionManifest {
	const parsed = parseTasks(input.source.bytes);
	if (!parsed.length) throw new Error("Legacy preset requires legacy Task headings; use plan-driven import for ordinary Markdown");
	if (new Set(parsed.map(t => t.id)).size !== parsed.length) throw new Error("Duplicate legacy task ID");
	for (const task of parsed) {
		const section = taskSection(input.source.bytes, task.id);
		const command = section.match(/^-\s*Command:[ \t]*(.*)$/im)?.[1] ?? "";
		if ((!isPendingToken(command) || taskGateCommand(section)) && !options.checks?.[`task-${task.id}`]?.length) throw new Error(`Legacy task ${task.id} requires caller-normalized checks; shell gates are not imported`);
	}
	const featureId = `${input.id}:feature`, deliveryId = `${input.id}:delivery`;
	const inferred = (field: string): Provenance => ({ field, origin: "inferred", reason: "Selected legacy sequential TDD/QA preset" });
	const definitions = [
		{ key: "plan-reviewer", text: "Review plan scope and implementation readiness before implementation.", mode: "read-only" as const, role: "plan-reviewer" as const },
		...parsed.map(t => ({ key: `task-${t.id}`, text: `Use TDD: prove the targeted red test, implement, then verify green.\n\n${taskSection(input.source.bytes, t.id)}`, mode: "mutation" as const, role: "worker" as const })),
		{ key: "feature-qa", text: "Validate the combined feature and report required remediation. Delivery requires successful QA; failures require bounded remediation and renewed QA.", mode: "mutation" as const, role: "feature-qa" as const },
	];
	const ids = definitions.map(d => stableTaskId(input.id, d.key));
	const manifest: ExecutionManifest = {
		schemaVersion: 1, id: input.id, revision: input.revision, source: structuredClone(input.source), repo: structuredClone(input.repo), baseCommit: input.baseCommit,
		scope: featureTitle(input.source.bytes, input.id), preset: "legacy",
		features: [{ id: featureId, title: featureTitle(input.source.bytes, input.id), scope: featureTitle(input.source.bytes, input.id) }],
		deliveryGroups: [{ id: deliveryId, featureIds: [featureId], requiredTaskIds: ids, checks: structuredClone(options.deliveryChecks ?? []), policy: options.policy ?? "pr", completion: options.policy === "local" ? "validated" : "merged", ownerId: featureId }],
		tasks: definitions.map((d, i) => ({ id: ids[i]!, featureId, deliveryGroupId: deliveryId, text: d.text, mode: d.mode, dependencies: i ? [ids[i - 1]!] : [], scope: ["."], profile: { agent: legacyProfileDefaults(d.role).agent!, ...options.profiles?.[d.key] }, checks: structuredClone(options.checks?.[d.key] ?? []), provenance: ["text", "mode", "dependencies", "scope", "profile", "deliveryGroupId"].map(inferred) })),
		constraints: { capacity: 1, parallelGroups: [], provenance: [inferred("capacity")] }, provenance: ["scope", "features", "deliveryGroups"].map(inferred),
	};
	validateImportedManifest(manifest); return manifest;
}
