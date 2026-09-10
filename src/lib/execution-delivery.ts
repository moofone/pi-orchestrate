import {
	canonicalJson, deliveryFenced, digest, receiptDigest, taskRevisionDigest, validateAuthorization, validateCheckEvidence, workspaceExcludedByDelivery,
	type CheckEvidence, type CheckExecutor, type CoordinatorOwner, type CoordinatorState,
	type DeliveryAdapter, type DeliveryGroup, type DeliveryObservation, type DeliveryRecord,
	type ExecutionManifest, type HandoffAcknowledgement, type HandoffRequest,
	type IntegrationReceipt, type ResultReceipt, type WorkspaceAdapter, type WorkspaceInspection, type WorkspaceOutcome, type WorkspaceRef,
} from "./execution-contract.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { ReviewController } from "./pr-review-controller.ts";
import { parsePrKey, prKeyId, samePrKey, type PrKey } from "./pr-review-identity.ts";

export type RemediationProposal = {
	kind: "remediation-required"; groupId: string; taskIds: string[]; inputDigests: string[];
	reason: string; checks: CheckEvidence[]; intentId?: string;
};
export type IntegrationOutcome = { kind: "ready"; receipt: IntegrationReceipt } |
	RemediationProposal | { kind: "fenced"; delivery: DeliveryRecord };
/** Discovery/creation authorization belongs to U7. This port must not mutate the delivery Git workspace.
 * Repeated calls must discover the same approved PR/owner generation, not create additional PRs. */
export type DeliveryPrPort = (request: {
	manifest: ExecutionManifest; group: DeliveryGroup; receipt: IntegrationReceipt; workspace: WorkspaceRef;
}) => Promise<{ kind: "authorized"; pr: HandoffRequest["pr"]; generation: string; ownerId?: string; ownerKind?: "feature" | "execution" | "session" } |
	{ kind: "refused" | "unknown"; reason: string }>;
export type ExecutionDeliveryOptions = {
	store: ExecutionStore; owner: CoordinatorOwner; workspace: WorkspaceAdapter; checks: CheckExecutor;
	delivery: DeliveryAdapter; resolvePr?: DeliveryPrPort; now?: () => number;
};
export type ExecutionDelivery = {
	/** U7 provisions a dedicated, canonical, clean delivery worktree before this call.
	 * Recovery uses inspect.appliedDigests as adapter-verified ancestry, never arbitrary HEAD movement. */
	integrate(manifestId: string, groupId: string, workspace: WorkspaceRef): Promise<IntegrationOutcome>;
	handoff(manifestId: string, groupId: string): Promise<DeliveryRecord>;
	observe(groupId: string): Promise<DeliveryRecord>;
};

// Serialize external work across facade instances sharing this process/store. Durable reservations
// and owner epochs provide the cross-process fence; no RPC/Git occurs inside transactions.
const operations = new Map<string, Promise<unknown>>();
async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
	const previous = operations.get(key);
	const next = (previous ? previous.catch(() => {}) : Promise.resolve()).then(action);
	operations.set(key, next);
	try { return await next; } finally { if (operations.get(key) === next) operations.delete(key); }
}
function activeGroup(state: CoordinatorState, manifestId: string, groupId: string) {
	const manifest = state.manifests.find(m => m.id === manifestId && m.revision === state.activeRevisions[manifestId]);
	const group = manifest?.deliveryGroups.find(g => g.id === groupId);
	if (!manifest || !group) throw new Error("Missing active delivery group");
	const matches = state.manifests.filter(m => state.activeRevisions[m.id] === m.revision).flatMap(m => m.deliveryGroups).filter(g => g.id === groupId);
	if (matches.length !== 1) throw new Error("Delivery group ID must have one active manifest owner");
	const auth = state.authorizations.find(a => a.manifestId === manifestId && a.revision === manifest.revision);
	if (!auth) throw new Error("Missing delivery authorization");
	validateAuthorization(manifest, auth);
	return { manifest, group };
}
function record(state: CoordinatorState, groupId: string): DeliveryRecord {
	let delivery = state.deliveries.find(d => d.groupId === groupId);
	if (!delivery) { delivery = { groupId, phase: "pending" }; state.deliveries.push(delivery); }
	return delivery;
}
function sameWorkspace(a: WorkspaceRef, b: WorkspaceRef): boolean { return digest(a) === digest(b); }
function bindingKey(pr: HandoffRequest["pr"]): PrKey {
	const key = parsePrKey({ slug: pr.repo, pr: pr.number });
	if (!key || !Number.isSafeInteger(pr.number) || pr.number < 1) throw new Error("Invalid authorized PR binding");
	return key;
}
function validAck(request: HandoffRequest, ack: HandoffAcknowledgement): boolean {
	return ack.requestId === request.id && ack.generation === request.generation && !!ack.controllerId && !!ack.obligationId && Number.isSafeInteger(ack.acceptedAt) && ack.acceptedAt >= 0;
}

export function createExecutionDelivery(options: ExecutionDeliveryOptions): ExecutionDelivery {
	const { store, owner, workspace, checks, delivery } = options;
	const now = options.now ?? Date.now;
	const mutate = (fn: (state: CoordinatorState) => void) => store.transact(owner, fn);
	const serial = <T>(id: string, fn: () => Promise<T>) => exclusive(`${store.statePath}:${id}`, fn);
	function proposal(group: DeliveryGroup, inputs: ResultReceipt[], reason: string, evidence: CheckEvidence[] = [], intentId?: string): RemediationProposal {
		return { kind: "remediation-required", groupId: group.id, taskIds: [...group.requiredTaskIds], inputDigests: inputs.map(r => r.digest), reason, checks: evidence, ...(intentId ? { intentId } : {}) };
	}
	function block(group: DeliveryGroup, inputs: ResultReceipt[], reason: string, evidence: CheckEvidence[] = [], intentId?: string): RemediationProposal {
		const result = proposal(group, inputs, reason, evidence, intentId);
		mutate(state => {
			const d = record(state, group.id); if (deliveryFenced(d)) throw new Error("Delivery mutation fenced");
			d.phase = "blocked"; d.reason = canonicalJson(result);
			if (intentId) { const intent = state.integrations.find(i => i.id === intentId)!; intent.phase = "recovery-needed"; intent.reason = d.reason; }
		});
		return result;
	}
	function inputsFor(state: CoordinatorState, manifest: ExecutionManifest, group: DeliveryGroup): ResultReceipt[] {
		const inputs: ResultReceipt[] = [], visited = new Set<string>();
		function visit(id: string) {
			if (visited.has(id)) return; visited.add(id);
			const task = manifest.tasks.find(t => t.id === id)!;
			[...task.dependencies].sort().forEach(visit);
			const taskRecord = state.tasks.find(t => t.taskId === id && t.manifestId === manifest.id);
			const result = state.results.find(r => r.digest === taskRecord?.resultDigest && r.taskId === id);
			if (!result || taskRecord?.phase !== "succeeded" || result.taskDigest !== taskRevisionDigest(task) || result.repoId !== manifest.repo.id || result.baseCommit !== manifest.baseCommit) throw new Error(`Missing validated current result: ${id}`);
			for (const spec of task.checks) {
				const evidence = result.checks.find(c => c.checkId === spec.id);
				const attempt = state.attempts.find(a => a.id === result.attemptId)!;
				if (!evidence || !checks.validateEvidence(spec, evidence, { invocationId: evidence.invocationId, notBefore: attempt.createdAt }).valid) throw new Error(`Invalid worker check: ${id}/${spec.id}`);
			}
			if (!result.prerequisiteDigests.every(d => inputs.some(r => r.digest === d))) throw new Error(`Stale prerequisite composition: ${id}`);
			inputs.push(result);
		}
		[...group.requiredTaskIds].sort().forEach(visit); return inputs;
	}
	async function integrate(manifestId: string, groupId: string, target: WorkspaceRef): Promise<IntegrationOutcome> {
		return serial(groupId, async () => {
			let state = store.read(); const { manifest, group } = activeGroup(state, manifestId, groupId);
			const existing = state.deliveries.find(d => d.groupId === groupId);
			if (existing && deliveryFenced(existing)) return { kind: "fenced", delivery: existing };
			const foreignFence = state.deliveries.find(d => d.groupId !== groupId && workspaceExcludedByDelivery({ deliveries: [d] }, target));
			if (foreignFence) return { kind: "fenced", delivery: foreignFence };
			let inputs: ResultReceipt[];
			try { inputs = inputsFor(state, manifest, group); } catch (error) { return block(group, [], String(error)); }
			if (target.repoId !== manifest.repo.id || target.baseCommit !== manifest.baseCommit) return block(group, inputs, "Delivery workspace repository/base mismatch");
			const inputDigests = inputs.map(r => r.digest);
			const id = `integration-${digest([manifest.id, group, manifest.baseCommit, inputDigests, target])}`;
			let intent = state.integrations.find(i => i.id === id);
			if (state.integrations.some(i => i.deliveryGroupId === groupId && i.id !== id && i.phase !== "complete")) return block(group, inputs, "Prior integration writer requires explicit resolution");
			// A new delivery workspace is materialized only after this facade records
			// its integration writer reservation. Existing intents must instead be
			// inspected before any recovery decision; an unknown workspace is never
			// permission to replay a mutation.
			let inspected = intent || !workspace.prepareDelivery
				? await workspace.inspect(target)
				: { kind: "unknown" as const, reason: "Delivery workspace awaits durable provisioning" };
			if (intent) {
				if (inspected.kind !== "inspected" || !sameWorkspace(inspected.workspace, target) || !inspected.clean || inspected.inProgress) return block(group, inputs, inspected.kind === "unknown" ? inspected.reason : "Dirty, foreign, or in-progress integration workspace", [], intent.phase === "complete" ? undefined : intent.id);
				if (intent.phase === "complete") {
					const receipt = state.integrationReceipts.find(r => r.intentId === id)!;
					if (inspected.head !== receipt.afterCommit || digest(inspected.appliedDigests) !== digest(inputDigests)) return block(group, inputs, "Validated integration HEAD/ancestry changed");
					for (const spec of group.checks) {
						const evidence = receipt.checks.find(r => r.checkId === spec.id);
						if (!evidence || !checks.validateEvidence(spec, evidence, { invocationId: evidence.invocationId, notBefore: intent.createdAt }).valid) return block(group, inputs, `Validated integration check unavailable: ${spec.id}`);
					}
					mutate(draft => { const d = record(draft, groupId); d.phase = "ready"; d.integrationDigest = receipt.digest; delete d.reason; });
					return { kind: "ready", receipt };
				}
				// A persisted intent means mutation may already have happened. Absence of ancestry
				// evidence is not permission to replay even when the worktree looks clean.
				if (digest(inspected.appliedDigests) !== digest(inputDigests) || (intent.afterCommit && intent.afterCommit !== inspected.head)) return block(group, inputs, "Unproven integration ancestry; refusing replay", [], id);
			}
			let head: string;
			if (intent) {
				head = (inspected as Extract<WorkspaceInspection, { kind: "inspected" }>).head;
			} else {
				if (!workspace.prepareDelivery) {
					if (inspected.kind !== "inspected" || inspected.head !== manifest.baseCommit || inspected.appliedDigests.length) return block(group, inputs, "New integration must start at authorized clean base");
				}

				const beforeCommit = inspected.kind === "inspected" ? inspected.head : manifest.baseCommit;
				intent = { id, deliveryGroupId: groupId, inputDigests, createdAt: now(), beforeCommit, workspace: target, phase: "composing" };
				mutate(draft => {
					activeGroup(draft, manifestId, groupId);
					const d = record(draft, groupId); if (deliveryFenced(d)) throw new Error("Delivery mutation fenced");
					if (draft.deliveries.some(other => deliveryFenced(other) && other.handoff && (other.handoff.workspace.id === target.id || other.handoff.workspace.path === target.path))) throw new Error("Workspace owned by another delivery controller");
					if (draft.integrations.some(i => i.id === id)) throw new Error("Integration already reserved");
					draft.integrations.push(intent!);
					draft.reservations.push({ id: `writer-${id}`, integrationId: id, workspaceId: target.id, workspacePath: target.path, slots: 1 });
					d.phase = "integrating";
				});
				if (workspace.prepareDelivery) {
					let provisioned: WorkspaceOutcome;
					try { provisioned = await workspace.prepareDelivery({ integrationId: id, workspace: target }); }
					catch (error) { return block(group, inputs, `Delivery provisioning outcome unknown: ${String(error)}`, [], id); }
					if (provisioned.kind !== "prepared" || !sameWorkspace(provisioned.workspace, target)) return block(group, inputs, provisioned.kind === "prepared" ? "Delivery provisioning returned foreign workspace" : `Delivery provisioning ${provisioned.kind}: ${provisioned.reason}`, [], id);
					inspected = await workspace.inspect(target);
					if (inspected.kind !== "inspected" || !sameWorkspace(inspected.workspace, target) || !inspected.clean || inspected.inProgress || inspected.head !== manifest.baseCommit || inspected.appliedDigests.length) return block(group, inputs, "Provisioned delivery workspace lacks clean authorized base", [], id);
				}
				let composed;
				try { composed = await workspace.compose({ intent, receipts: inputs }); }
				catch (error) { return block(group, inputs, `Composition outcome unknown: ${String(error)}`, [], id); }
				if (composed.kind !== "prepared") return block(group, inputs, `${composed.kind}: ${composed.reason}`, [], id);
				if (!sameWorkspace(composed.workspace, target)) return block(group, inputs, "Composition returned foreign workspace", [], id);
				head = composed.head;
				inspected = await workspace.inspect(target);
				if (inspected.kind !== "inspected" || !sameWorkspace(inspected.workspace, target) || !inspected.clean || inspected.inProgress || inspected.head !== head || digest(inspected.appliedDigests) !== digest(inputDigests)) return block(group, inputs, "Composition lacks clean exact ancestry evidence", [], id);
			}
			mutate(draft => { const i = draft.integrations.find(i => i.id === id)!; i.afterCommit = head; i.phase = "validating"; });
			const evidence: CheckEvidence[] = [];
			for (const spec of group.checks) {
				const startedAt = now(), invocationId = `${id}:${spec.id}:${startedAt}`;
				try {
					const result = await checks.execute(spec, { workspace: target, invocationId, startedAt }); evidence.push(result);
					validateCheckEvidence(result);
					if (result.status !== "passed" || result.exitCode !== 0 || (spec.runner !== "command" && (!result.reportPath || !result.reportDigest)) || !checks.validateEvidence(spec, result, { invocationId, notBefore: startedAt }).valid) return block(group, inputs, `Combined gate failed: ${spec.id}`, evidence, id);
				} catch (error) { return block(group, inputs, `Combined gate unavailable: ${spec.id}: ${String(error)}`, evidence, id); }
			}
			const final = await workspace.inspect(target);
			if (final.kind !== "inspected" || !sameWorkspace(final.workspace, target) || !final.clean || final.inProgress || final.head !== head || digest(final.appliedDigests) !== digest(inputDigests)) return block(group, inputs, "Integration changed during checks", evidence, id);
			const body: Omit<IntegrationReceipt, "digest"> = { schemaVersion: 1, intentId: id, deliveryGroupId: groupId, inputDigests, beforeCommit: intent.beforeCommit, afterCommit: head, checks: evidence, validatedAt: now() };
			const receipt = { ...body, digest: receiptDigest(body) };
			mutate(draft => {
				const d = record(draft, groupId); if (deliveryFenced(d)) throw new Error("Delivery mutation fenced");
				draft.integrations.find(i => i.id === id)!.phase = "complete";
				draft.integrationReceipts.push(receipt); draft.reservations = draft.reservations.filter(r => r.integrationId !== id);
				d.phase = "ready"; d.integrationDigest = receipt.digest; delete d.reason;
			});
			return { kind: "ready", receipt };
		});
	}
	function apply(groupId: string, observation: DeliveryObservation): DeliveryRecord {
		return mutate(state => {
			const d = record(state, groupId), request = d.handoff;
			if (!request || ["merged", "closed-unmerged"].includes(d.phase)) return;
			if (observation.kind === "unknown") { d.reason = observation.reason; return; }
			if (observation.kind === "not-transferred") {
				if (d.phase === "handoff-pending") { d.phase = "ready"; d.nonTransfer = { requestId: request.id, reason: observation.reason, observedAt: now() }; }
				return;
			}
			if (!validAck(request, observation.acknowledgement) || (d.acknowledgement && digest(d.acknowledgement) !== digest(observation.acknowledgement))) { d.reason = "Controller acknowledgement identity mismatch"; return; }
			d.acknowledgement = observation.acknowledgement; d.phase = "controller-owned"; delete d.reason;
			if (observation.kind === "merged" && observation.commit && observation.url && Number.isSafeInteger(observation.observedAt) && observation.observedAt >= 0) { d.phase = "merged"; d.mergeEvidence = { commit: observation.commit, url: observation.url, observedAt: observation.observedAt }; }
			if (observation.kind === "closed-unmerged") d.phase = "closed-unmerged";
		}).deliveries.find(d => d.groupId === groupId)!;
	}
	async function observeInternal(groupId: string): Promise<DeliveryRecord> {
		const d = store.read().deliveries.find(d => d.groupId === groupId);
		if (!d) throw new Error("Missing delivery");
		if (!d.handoff || !deliveryFenced(d) || ["merged", "closed-unmerged"].includes(d.phase)) return d;
		let observation: DeliveryObservation;
		try { observation = await delivery.observe(d.handoff); } catch (error) { observation = { kind: "unknown", reason: String(error) }; }
		return apply(groupId, observation);
	}
	async function handoff(manifestId: string, groupId: string): Promise<DeliveryRecord> {
		return serial(groupId, async () => {
			const state = store.read(), { manifest, group } = activeGroup(state, manifestId, groupId);
			const d = state.deliveries.find(d => d.groupId === groupId);
			if (d && deliveryFenced(d)) return observeInternal(groupId);
			if (!d || d.phase !== "ready" || !d.integrationDigest) throw new Error("Delivery requires validated combined receipt");
			if (group.policy !== "pr") return d;
			if (!options.resolvePr) throw new Error("Authorized PR discovery port required");
			const receipt = state.integrationReceipts.find(r => r.digest === d.integrationDigest)!;
			const intent = state.integrations.find(i => i.id === receipt.intentId)!;
			const inspected = await workspace.inspect(intent.workspace);
			if (inspected.kind !== "inspected" || !sameWorkspace(inspected.workspace, intent.workspace) || !inspected.clean || inspected.inProgress || inspected.head !== receipt.afterCommit || digest(inspected.appliedDigests) !== digest(receipt.inputDigests)) throw new Error("Delivery workspace no longer matches validated receipt");
			const binding = await options.resolvePr({ manifest, group, receipt, workspace: intent.workspace });
			if (binding.kind !== "authorized") throw new Error(`PR binding ${binding.kind}: ${binding.reason}`);
			const pr = bindingKey(binding.pr);
			if (!binding.generation) throw new Error("Invalid authorized PR binding");
			const body = { deliveryGroupId: groupId, ownerId: binding.ownerId ?? group.ownerId, generation: binding.generation, ...(binding.ownerKind ? { ownerKind: binding.ownerKind } : {}), pr: { repo: `${pr.host}/${pr.owner}/${pr.repo}`, number: binding.pr.number }, workspace: intent.workspace, head: receipt.afterCommit, integrationDigest: receipt.digest };
			const request: HandoffRequest = { id: `handoff-${digest(body)}`, ...body };
			mutate(draft => {
				const current = record(draft, groupId);
				if (current.phase !== "ready" || current.integrationDigest !== receipt.digest) throw new Error("Delivery changed before handoff");
				if (draft.reservations.some(r => r.workspaceId === request.workspace.id || r.workspacePath === request.workspace.path)) throw new Error("Delivery workspace has an active writer");
				if (draft.deliveries.some(other => other.groupId !== groupId && deliveryFenced(other) && other.handoff && (other.handoff.workspace.id === request.workspace.id || other.handoff.workspace.path === request.workspace.path))) throw new Error("Workspace owned by another delivery controller");
				if (draft.deliveries.some(other => other.groupId !== groupId && other.handoff && samePrKey(bindingKey(other.handoff.pr), pr))) throw new Error("PR already mapped to another delivery group; approve one shared group");
				current.phase = "handoff-pending"; current.handoff = request; delete current.nonTransfer;
			});
			let observation: DeliveryObservation;
			try { observation = await delivery.handoff(request); } catch (error) { observation = { kind: "unknown", reason: String(error) }; }
			return apply(groupId, observation);
		});
	}
	return { integrate, handoff, observe: groupId => serial(groupId, () => observeInternal(groupId)) };
}

/** No PR driver lives here: U7 supplies the existing controller and identity mapping.
 * acknowledged reads this execution store's durable ack; only then may controller HEAD advance.
 * A missing status is unknown, never proof of non-transfer. Merge evidence is a separately
 * verified API result for the exact PR, not the controller's handoff acknowledgement. */
export type ControllerDeliveryOptions = {
	controller: Pick<ReviewController, "handoff" | "status">; controllerId: string;
	/** Optional only for the production binding, where the already-authorized
	 * request PR identity is canonicalized here after resolvePr has authorized it. */
	prKey?: (request: HandoffRequest) => PrKey;
	acknowledged: (request: HandoffRequest) => HandoffAcknowledgement | undefined;
	verifyMerge: (request: HandoffRequest) => Promise<{ commit: string; url: string; observedAt: number } | undefined>;
	now?: () => number;
};
export function createControllerDeliveryAdapter(options: ControllerDeliveryOptions): DeliveryAdapter {
	function key(request: HandoffRequest): PrKey {
		const mapped = options.prKey?.(request) ?? bindingKey(request.pr);
		const pr = parsePrKey({ ...mapped, pr: mapped.number });
		if (!pr || !samePrKey(pr, bindingKey(request.pr))) throw new Error("PR identity mapping mismatch (repo must be host/owner/repo)");
		return pr;
	}
	async function observe(request: HandoffRequest): Promise<DeliveryObservation> {
		try {
			const pr = key(request), views = options.controller.status(pr);
			const view = views.find(v => v.pr === prKeyId(pr));
			const stored = options.acknowledged(request);
			const ownerKind = request.ownerKind ?? "feature";
			if (!view || view.owner.kind !== ownerKind || view.owner.id !== request.ownerId || view.owner.generation !== request.generation || view.worktree !== request.workspace.path || (!stored && view.head !== request.head)) return { kind: "unknown", reason: "Exact controller obligation not proven" };
			const acknowledgement = stored ?? { requestId: request.id, controllerId: options.controllerId, obligationId: digest([pr, view.owner, view.worktree, request.head]), generation: request.generation, acceptedAt: (options.now ?? Date.now)() };
			if (!validAck(request, acknowledgement) || acknowledgement.controllerId !== options.controllerId) return { kind: "unknown", reason: "Stored controller acknowledgement mismatch" };
			if (view.state === "merged") {
				const evidence = await options.verifyMerge(request);
				return evidence ? { kind: "merged", acknowledgement, ...evidence } : { kind: "accepted", acknowledgement };
			}
			if (view.state === "closed_unmerged") return { kind: "closed-unmerged", acknowledgement };
			return { kind: "accepted", acknowledgement };
		} catch (error) { return { kind: "unknown", reason: String(error) }; }
	}
	return {
		observe,
		async handoff(request) {
			try {
				const pr = key(request);
				// Never refresh or overwrite a pre-existing obligation while reconciling.
				if (!options.controller.status(pr).length) options.controller.handoff({ pr, owner: { kind: request.ownerKind ?? "feature", id: request.ownerId, generation: request.generation }, worktree: request.workspace.path, head: request.head });
			} catch { /* Persistence may have succeeded before the reply was lost. */ }
			return observe(request);
		},
	};
}
