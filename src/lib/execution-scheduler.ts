import { randomUUID } from "node:crypto";
import {
	deliveryFenced, digest, occupiesCapacity, taskRevisionDigest, transitionAttempt, validateAuthorization, workspaceExcludedByDelivery,
	type AttemptRuntime, type CheckExecutor, type CoordinatorOwner, type CoordinatorState,
	type DeliveryAdapter, type ExecutionAuthorization, type ExecutionManifest, type LaunchOutcome,
	type ResultReceipt, type TaskAttempt, type TaskRecord, type TaskSpec, type WorkspaceAdapter, type WorkspaceRef,
} from "./execution-contract.ts";
import type { ExecutionStore } from "./execution-store.ts";

export type SchedulerOptions = {
	store: ExecutionStore; owner: Omit<CoordinatorOwner, "epoch">;
	runtime: AttemptRuntime; workspaces: WorkspaceAdapter; checks: CheckExecutor; delivery: DeliveryAdapter;
	/** Pure allocation of a canonical caller-owned path; no provisioning before reservation. */
	workspace: (input: { attemptId: string; manifest: ExecutionManifest; task: TaskSpec; prerequisites: ResultReceipt[] }) => WorkspaceRef;
	/** Must verify immutable output/base/scope and checks; a terminal runtime success is not a receipt. */
	createReceipt: (input: { attempt: TaskAttempt; task: TaskSpec; checks: CheckExecutor }) => Promise<ResultReceipt>;
	/** U6 owns durable integration/handoff orchestration, including its own reservations and epoch fences. */
	reconcileDelivery?: (input: { store: ExecutionStore; owner: CoordinatorOwner; workspaces: WorkspaceAdapter; checks: CheckExecutor; delivery: DeliveryAdapter }) => Promise<void>;
	now?: () => number;
	/** Finite local wakeups after capacity deferral, never budget grants. Defaults to three. */
	maxCapacityRechecks?: number; recheckDelayMs?: number;
};
export type SchedulerControl = { targetId: string; action: "pause" | "resume" | "retry" | "cancel"; immediate?: boolean };

/** Repository-wide event-driven admission. Jobs never hold the short store transaction lock. */
export class ExecutionScheduler {
	private options: SchedulerOptions;
	private owner?: CoordinatorOwner;
	private stopped = false;
	private unsubscribe?: () => void;
	private loop?: Promise<void>;
	private dirty = false;
	private jobs = new Map<string, Promise<void>>();
	private validationJobs = new Map<string, Promise<void>>();
	private stopJobs = new Map<string, Promise<void>>();
	private deliveryJob?: Promise<void>;
	private listeners = new Set<(state: CoordinatorState) => void>();
	private lastFeature = "";
	private timer?: ReturnType<typeof setTimeout>;
	private rechecks = 0;
	private deferred = new Set<string>();
	private lastError?: string;
	constructor(options: SchedulerOptions) { this.options = options; }
	/** Lease identity for adapters created after start; callers cannot mutate it. */
	currentOwner(): CoordinatorOwner | undefined { return this.owner ? structuredClone(this.owner) : undefined; }
	observe(): CoordinatorState { return this.options.store.read(); }
	progress(): { state: CoordinatorState; error?: string } { return { state: this.observe(), ...(this.lastError ? { error: this.lastError } : {}) }; }
	subscribe(listener: (state: CoordinatorState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	private now(): number { return (this.options.now ?? Date.now)(); }
	private live(owner: CoordinatorOwner): boolean { const current = this.observe().owner; return !this.stopped && current?.instanceId === owner.instanceId && current.epoch === owner.epoch; }
	private change(update: (state: CoordinatorState) => void): void {
		if (!this.owner || !this.live(this.owner)) throw new Error("Scheduler is not the active coordinator");
		const state = this.options.store.transact(this.owner, update);
		for (const listener of this.listeners) { try { listener(structuredClone(state)); } catch { /* Observers do not control admission. */ } }
	}
	private wake(): void { if (!this.stopped) void this.reconcile().catch(error => { this.lastError = String(error); }); }
	async start(): Promise<void> {
		if (this.owner || this.stopped) throw new Error("Scheduler already started or shut down");
		this.owner = this.options.store.acquire(this.options.owner);
		this.unsubscribe = this.options.runtime.subscribe(() => { this.deferred.clear(); this.wake(); });
		// No admission until every persisted attempt has been observed or conservatively fenced.
		await this.recover();
		if (!this.live(this.owner)) return;
		this.options.store.markReconciled(this.owner);
		await this.reconcile();
	}
	/** Capacity is an explicit repository authorization, never added from a feature request. */
	authorizeCapacity(capacity: number): void { this.change(state => { state.capacity = capacity; }); this.wake(); }
	admit(manifest: ExecutionManifest, authorization: ExecutionAuthorization): void { this.install(manifest, authorization, false); }
	revise(manifest: ExecutionManifest, authorization: ExecutionAuthorization): void { this.install(manifest, authorization, true); }
	private install(manifest: ExecutionManifest, authorization: ExecutionAuthorization, revision: boolean): void {
		validateAuthorization(manifest, authorization);
		this.change(state => {
			const previous = state.activeRevisions[manifest.id];
			if (revision ? previous === undefined || manifest.revision !== previous + 1 : previous !== undefined) throw new Error("Invalid admission/revision order");
			if (manifest.repo.id !== state.repo.id) throw new Error("Foreign repository");
			if (manifest.deliveryGroups.some(g => state.deliveries.some(d => d.groupId === g.id && deliveryFenced(d)))) throw new Error("Delivery ownership is fenced");
			const stored = state.manifests.find(m => m.id === manifest.id && m.revision === manifest.revision);
			if (stored && digest(stored) !== digest(manifest)) throw new Error("Persisted manifest revision mismatch");
			if (!stored) state.manifests.push(structuredClone(manifest));
			const approved = state.authorizations.find(a => a.id === authorization.id);
			if (approved && digest(approved) !== digest(authorization)) throw new Error("Persisted authorization mismatch");
			if (!approved) state.authorizations.push(structuredClone(authorization));
			state.activeRevisions[manifest.id] = manifest.revision;
			for (const task of manifest.tasks) {
				const record = state.tasks.find(t => t.taskId === task.id);
				if (!record) state.tasks.push({ taskId: task.id, manifestId: manifest.id, phase: "pending", intent: "none", attemptIds: [] });
				else if (!state.attempts.some(a => a.taskId === task.id && occupiesCapacity(a))) {
					const receipt = this.result(state, manifest, task);
					record.phase = receipt ? "succeeded" : "pending";
					if (receipt) record.resultDigest = receipt.digest; else delete record.resultDigest;
					delete record.reason;
				}
			}
			for (const group of manifest.deliveryGroups) if (!state.deliveries.some(d => d.groupId === group.id)) state.deliveries.push({ groupId: group.id, phase: "pending" });
		});
		this.wake();
	}
	async control(control: SchedulerControl): Promise<void> { await this.applyControl(control); await this.reconcile(); }
	private async applyControl(control: SchedulerControl, manifestId?: string): Promise<void> {
		const stops: TaskAttempt[] = [];
		this.change(state => {
			const matches = state.tasks.filter(record => {
				const manifest = state.manifests.find(m => m.id === record.manifestId && m.revision === state.activeRevisions[m.id]);
				const task = manifest?.tasks.find(t => t.id === record.taskId);
				return task && (!manifestId || manifest!.id === manifestId) && [task.id, task.featureId, manifest!.id].includes(control.targetId);
			});
			if (!matches.length) throw new Error("Unknown control target");
			for (const record of matches) {
				const active = state.attempts.find(a => a.taskId === record.taskId && occupiesCapacity(a));
				if (control.action === "retry") {
					if (active) throw new Error("Cannot retry a reserved writer");
					const groups = state.parallelLaunchSets.filter(g => g.instruction === "unmet" && g.attemptIds.some(id => record.attemptIds.includes(id)));
					if (groups.length) throw new Error("Unmet parallel instruction requires an approved manifest revision");
					if (record.phase === "succeeded") throw new Error("Cannot retry a completed task without revision");
					record.phase = "pending"; delete record.reason; this.deferred.delete(record.taskId);
				}
				record.intent = control.action === "pause" ? "pause" : control.action === "cancel" ? "cancel" : "none";
				if (active) { active.intent = control.action === "pause" && control.immediate ? "stop" : record.intent; if ((control.action === "pause" && control.immediate) || control.action === "cancel") stops.push(structuredClone(active)); }
			}
		});
		for (const attempt of stops) this.scheduleStop(attempt);
	}
	private scheduleStop(attempt: TaskAttempt): void {
		if (!attempt.run || !this.owner || !occupiesCapacity(attempt) || attempt.terminal || !["stop", "cancel"].includes(attempt.intent)) return;
		const owner = this.owner, run = attempt.run;
		const key = digest([owner.epoch, attempt.id, run]);
		if (this.stopJobs.has(key)) return;
		// The persisted intent survives restart; retain completed jobs to avoid repeated RPCs
		// on every observation. A new coordinator can safely redispatch the stop.
		const job = Promise.resolve().then(async () => {
			if (!this.live(owner)) return;
			const outcome = await this.options.runtime.control(run, "stop", owner.sessionFile);
			if (!this.live(owner)) return;
			if (outcome.kind !== "acknowledged") throw new Error(outcome.reason);
			this.change(state => {
				const current = state.attempts.find(a => a.id === attempt.id)!;
				if (!occupiesCapacity(current) || current.terminal || digest(current.run) !== digest(run)) return;
				if (["running", "recovery-needed"].includes(current.phase)) this.move(state, current, "stopping");
			});
		}).catch(error => {
			if (!this.live(owner)) return;
			this.lastError = `Stop ${attempt.id}: ${String(error)}`;
			this.change(state => {
				const current = state.attempts.find(a => a.id === attempt.id)!;
				if (occupiesCapacity(current) && !current.terminal && digest(current.run) === digest(run)) current.reason = String(error);
			});
		});
		this.stopJobs.set(key, job);
	}

	async shutdown(): Promise<void> {
		this.stopped = true; this.unsubscribe?.(); if (this.timer) clearTimeout(this.timer);
		// Do not wait for missing RPC acknowledgements and do not release child reservations.
		if (this.owner) this.options.store.relinquish(this.owner);
	}
	reconcile(): Promise<void> {
		if (this.stopped || !this.owner) return Promise.resolve();
		this.dirty = true;
		if (!this.loop) this.loop = Promise.resolve().then(() => this.drain()).finally(() => { this.loop = undefined; });
		return this.loop;
	}
	private async drain(): Promise<void> {
		while (this.dirty && !this.stopped) {
			this.dirty = false;
			await this.consumeIntents();
			await this.recover();
			if (this.stopped || this.observe().reconciledEpoch !== this.owner!.epoch) continue;
			await this.admission();
			this.scheduleDelivery();
		}
	}
	private scheduleDelivery(): void {
		const reconcile = this.options.reconcileDelivery, owner = this.owner!;
		if (!reconcile || this.deliveryJob || this.stopped) return;
		const projection = () => { const s = this.observe(); return digest([s.deliveries, s.integrations, s.integrationReceipts]); };
		const before = projection();
		this.deliveryJob = Promise.resolve().then(() => {
			if (this.live(owner)) return reconcile({ store: this.options.store, owner, workspaces: this.options.workspaces, checks: this.options.checks, delivery: this.options.delivery });
		}).catch(error => { this.lastError = String(error); }).finally(() => {
			this.deliveryJob = undefined;
			if (this.live(owner) && projection() !== before) this.wake();
		});
	}
	/** Cross-session writers submit data only. U7 must first persist the exact manifest and
	 * caller-approved authorization using the owning lease; an ID by itself grants nothing.
	 * Rejected intents are consumed independently and surfaced through progress().error.
	 */
	private async consumeIntents(): Promise<void> {
		for (const intent of this.observe().intents.filter(i => i.consumedAt === undefined)) {
			if (this.stopped) return;
			try {
				const state = this.observe();
				const authorization = state.authorizations.find(a => a.id === intent.authorizationId);
				if (!authorization) throw new Error("Unknown intent authorization");
				const manifest = state.manifests.find(m => m.id === authorization.manifestId && m.revision === authorization.revision);
				if (!manifest) throw new Error("Missing authorized manifest");
				validateAuthorization(manifest, authorization);
				if (manifest.repo.id !== state.repo.id) throw new Error("Foreign intent repository");
				if (intent.kind === "admit" || intent.kind === "revision") {
					if (!intent.manifest || digest(intent.manifest) !== digest(manifest) || intent.targetId !== manifest.id) throw new Error("Mismatched intent manifest/target");
					this.install(manifest, authorization, intent.kind === "revision");
				} else {
					if (state.activeRevisions[manifest.id] !== manifest.revision) throw new Error("Stale intent authorization");
					if (![manifest.id, ...manifest.features.map(f => f.id), ...manifest.tasks.map(t => t.id)].includes(intent.targetId)) throw new Error("Mismatched intent target");
					await this.applyControl({ targetId: intent.targetId, action: intent.kind, ...(intent.immediate === undefined ? {} : { immediate: intent.immediate }) }, manifest.id);
				}
			} catch (error) { this.lastError = `Intent ${intent.id} rejected: ${String(error)}`; }
			if (!this.stopped) this.change(state => { state.intents.find(i => i.id === intent.id)!.consumedAt = this.now(); });
		}
	}
	private task(state: CoordinatorState, attempt: TaskAttempt): TaskSpec { return state.manifests.find(m => m.id === attempt.manifestId && m.revision === attempt.manifestRevision)!.tasks.find(t => t.id === attempt.taskId)!; }
	private result(state: CoordinatorState, manifest: ExecutionManifest, task: TaskSpec): ResultReceipt | undefined {
		return state.results.find(r => r.taskId === task.id && r.taskDigest === taskRevisionDigest(task) && r.baseCommit === manifest.baseCommit && r.repoId === manifest.repo.id
			&& task.dependencies.every(id => { const dependency = this.result(state, manifest, manifest.tasks.find(t => t.id === id)!); return dependency && r.prerequisiteDigests.includes(dependency.digest); })
			&& r.prerequisiteDigests.every(d => { const input = state.results.find(r => r.digest === d); const spec = manifest.tasks.find(t => t.id === input?.taskId); return spec && this.result(state, manifest, spec)?.digest === d; }));
	}
	private inputs(state: CoordinatorState, manifest: ExecutionManifest, task: TaskSpec): ResultReceipt[] | undefined {
		const receipts: ResultReceipt[] = []; const seen = new Set<string>();
		const visit = (id: string): boolean => {
			if (seen.has(id)) return true;
			const spec = manifest.tasks.find(t => t.id === id)!; const record = state.tasks.find(t => t.taskId === id);
			if (record?.intent !== "none") return false;
			const result = this.result(state, manifest, spec); if (!result || !spec.dependencies.every(visit)) return false;
			seen.add(id); receipts.push(result); return true;
		};
		return task.dependencies.every(visit) ? receipts : undefined;
	}
	private move(state: CoordinatorState, attempt: TaskAttempt, phase: TaskAttempt["phase"], extra: Partial<Pick<TaskAttempt, "terminal" | "nonStart" | "resultDigest" | "reason">> = {}): void {
		Object.assign(attempt, transitionAttempt(attempt, phase, { at: Math.max(this.now(), attempt.updatedAt), ...extra }));
		const record = state.tasks.find(t => t.taskId === attempt.taskId)!;
		if (record.attemptIds.at(-1) === attempt.id) { record.phase = phase; if (extra.reason) record.reason = extra.reason; }
	}
	private launchJob(id: string, job: () => Promise<void>, jobs = this.jobs): void {
		if (jobs.has(id)) return;
		const promise = Promise.resolve().then(job).catch(error => {
			this.lastError = String(error);
			if (!this.stopped && this.owner && this.live(this.owner)) this.change(state => { const a = state.attempts.find(a => a.id === id); if (a && occupiesCapacity(a)) this.move(state, a, "recovery-needed", { reason: String(error) }); });
		}).finally(() => { jobs.delete(id); this.wake(); });
		jobs.set(id, promise);
	}
	private async recover(): Promise<void> {
		const owner = this.owner!;
		await Promise.all(this.observe().attempts.filter(a => occupiesCapacity(a) && !(a.phase === "preparing" && this.jobs.has(a.id))).map(async attempt => {
			if (attempt.terminal?.outcome === "succeeded") { if (attempt.phase === "validating") this.launchJob(attempt.id, () => this.validate(attempt.id), this.validationJobs); return; }
			if (attempt.phase === "preparing") this.change(s => { this.move(s, s.attempts.find(a => a.id === attempt.id)!, "recovery-needed", { reason: "Interrupted workspace preparation; inspect before replacement" }); });
			let outcome: LaunchOutcome;
			try {
				const lookup = !attempt.run && attempt.operationId && this.options.runtime.lookupOperation && (await this.options.runtime.probe()).durableOperationLookup;
				outcome = lookup && attempt.operationId && this.options.runtime.lookupOperation
					? await this.options.runtime.lookupOperation(attempt.operationId, attempt.ownerSessionFile)
					: await this.options.runtime.observe(attempt);
			} catch (error) { outcome = { kind: "unknown", reason: String(error) }; }
			if (this.live(owner) && !(this.jobs.has(attempt.id) && outcome.kind === "unknown")) await this.outcome(attempt.id, outcome);
		}));
	}
	private scheduleRecheck(taskId: string): void {
		this.deferred.add(taskId);
		if (this.timer || this.rechecks >= (this.options.maxCapacityRechecks ?? 3)) return;
		this.rechecks++;
		this.timer = setTimeout(() => { this.timer = undefined; this.deferred.clear(); this.wake(); }, this.options.recheckDelayMs ?? 1000);
		this.timer.unref?.();
	}
	private async admission(): Promise<void> {
		const owner = this.owner!; const caps = await this.options.runtime.probe();
		if (!this.live(owner)) return;
		if (!caps.available || caps.remainingBudget === 0) {
			this.change(state => { for (const t of state.tasks.filter(t => ["pending", "ready", "dependency-blocked"].includes(t.phase))) t.reason = caps.reason ?? (caps.remainingBudget === 0 ? "Runtime budget exhausted; user action required" : "Runtime unavailable"); }); return;
		}
		const selected: string[] = [];
		this.change(state => {
			let free = Math.min(state.capacity - state.reservations.reduce((n, r) => n + r.slots, 0), caps.capacity);
			const manifests = state.manifests.filter(m => state.activeRevisions[m.id] === m.revision);
			const candidates: { manifest: ExecutionManifest; task: TaskSpec; record: TaskRecord }[] = [];
			for (const manifest of manifests) for (const task of manifest.tasks) {
				const record = state.tasks.find(t => t.taskId === task.id)!;
				if (record.intent !== "none" || !["pending", "ready", "dependency-blocked"].includes(record.phase) || this.deferred.has(task.id) || state.attempts.some(a => a.taskId === task.id && occupiesCapacity(a))) continue;
				if (state.deliveries.some(d => d.groupId === task.deliveryGroupId && deliveryFenced(d))) continue;
				const inputs = this.inputs(state, manifest, task);
				record.phase = inputs ? "ready" : "dependency-blocked";
				if (!inputs) { record.reason = "Required matching-base receipts unavailable or dependency paused"; continue; }
				delete record.reason; candidates.push({ manifest, task, record });
			}
			while (candidates.length) {
				const features = [...new Set(candidates.map(c => c.task.featureId))];
				const feature = features[(features.indexOf(this.lastFeature) + 1) % features.length]!;
				const candidate = candidates.find(c => c.task.featureId === feature)!; this.lastFeature = feature;
				const { manifest, task } = candidate;
				const group = manifest.constraints.parallelGroups.find(g => g.taskIds.includes(task.id));
				const members = group ? candidates.filter(c => c.manifest.id === manifest.id && group.taskIds.includes(c.task.id)) : [candidate];
				for (const member of members) candidates.splice(candidates.indexOf(member), 1);
				const previousSet = group && state.parallelLaunchSets.find(s => s.groupId === group.id && s.attemptIds.some(id => state.attempts.some(a => a.id === id && a.manifestId === manifest.id && a.manifestRevision === manifest.revision)));
				if (previousSet || (group && members.length !== group.simultaneous)) { for (const m of members) m.record.reason = previousSet ? "Parallel instruction already attempted; approval/revision required" : "Parallel group prerequisites are not all ready"; continue; }
				if (members.length > free) { for (const m of members) m.record.reason = `Capacity conflict: requires ${members.length} simultaneous slots, ${free} available`; continue; }
				const allocations = members.map(member => {
					const id = randomUUID(), prerequisites = this.inputs(state, manifest, member.task)!;
					const workspace = this.options.workspace({ attemptId: id, manifest: structuredClone(manifest), task: structuredClone(member.task), prerequisites: structuredClone(prerequisites) });
					return { member, id, prerequisites, workspace };
				});
				if (allocations.some(({ workspace }) => workspaceExcludedByDelivery(state, workspace))) {
					for (const member of members) member.record.reason = "Workspace reserved by pending/controller-owned delivery";
					continue;
				}
				const ids: string[] = [];
				for (const { member, id, prerequisites, workspace } of allocations) {
					const attempt: TaskAttempt = { schemaVersion: 1, id, taskId: member.task.id, manifestId: manifest.id, manifestRevision: manifest.revision, taskDigest: taskRevisionDigest(member.task), ownerSessionFile: owner.sessionFile, launchDigest: digest([id, member.task, workspace]), operationId: id, workspace, baseCommit: manifest.baseCommit, prerequisiteDigests: prerequisites.map(r => r.digest), phase: "preparing", intent: "none", createdAt: this.now(), updatedAt: this.now() };
					state.attempts.push(attempt); member.record.attemptIds.push(id); member.record.phase = "preparing";
					state.reservations.push({ id: `reservation-${id}`, attemptId: id, workspaceId: workspace.id, workspacePath: workspace.path, slots: 1, ...(group ? { parallelGroupId: group.id } : {}) });
					ids.push(id); selected.push(id); free--;
				}
				if (group) state.parallelLaunchSets.push({ id: randomUUID(), groupId: group.id, attemptIds: ids, instruction: "reserved" });
			}
		});
		for (const id of selected) this.launchJob(id, () => this.launch(id));
	}
	private async launch(id: string): Promise<void> {
		const owner = this.owner!, state = this.observe(), attempt = state.attempts.find(a => a.id === id)!;
		const prepared = await this.options.workspaces.prepare({ attemptId: id, workspace: attempt.workspace, prerequisites: attempt.prerequisiteDigests.map(d => state.results.find(r => r.digest === d)!) });
		if (!this.live(owner)) return;
		if (prepared.kind !== "prepared") {
			this.change(s => { const a = s.attempts.find(a => a.id === id)!; this.move(s, a, "recovery-needed", { reason: prepared.reason }); this.groupOutcome(s, id, true); }); return;
		}
		if (digest(prepared.workspace) !== digest(attempt.workspace)) throw new Error("Prepared workspace differs from reservation");
		this.change(s => {
			const currentAttempt = s.attempts.find(a => a.id === id)!;
			currentAttempt.preparedHead = prepared.head;
			this.move(s, currentAttempt, "launching");
		});
		const current = this.observe().attempts.find(a => a.id === id)!;
		if (current.intent !== "none") {
			await this.outcome(id, { kind: "rejected-before-start", category: "policy", reason: "Paused/cancelled before launch", evidence: { kind: "not-started", launchDigest: current.launchDigest, reason: "No RPC issued" } }); return;
		}
		const task = this.task(state, attempt), authorization = state.authorizations.find(a => a.manifestId === attempt.manifestId && a.revision === attempt.manifestRevision)!;
		let outcome: LaunchOutcome;
		try { outcome = await this.options.runtime.launch({ attempt: current, task, profile: task.profile, authorization }); }
		catch (error) { outcome = { kind: "unknown", reason: String(error) }; }
		if (this.live(owner)) {
			const current = this.observe().attempts.find(a => a.id === id)!;
			// Exact observation outranks a delayed launch acknowledgement.
			if (!current.terminal && (!current.run || outcome.kind === "known-terminal")) await this.outcome(id, outcome);
		}
	}
	private groupOutcome(state: CoordinatorState, id: string, unmet: boolean): void {
		const set = state.parallelLaunchSets.find(s => s.attemptIds.includes(id)); if (!set) return;
		if (unmet) { set.instruction = "unmet"; set.reason = "Partial/uncertain parallel admission; approved revision required, missing members will not serialize"; }
		else if (set.instruction === "reserved" && set.attemptIds.every(id => state.attempts.find(a => a.id === id)?.run)) set.instruction = "met";
	}
	private async outcome(id: string, outcome: LaunchOutcome): Promise<void> {
		let validate = false, deferred = false;
		this.change(state => {
			const attempt = state.attempts.find(a => a.id === id)!; if (!occupiesCapacity(attempt) || attempt.terminal) return;
			if (outcome.kind === "known-running" || outcome.kind === "known-terminal") {
				attempt.run = outcome.kind === "known-running" ? outcome.run : outcome.evidence.run;
				if (outcome.kind === "known-terminal") {
					validate = outcome.evidence.outcome === "succeeded";
					this.move(state, attempt, validate ? "validating" : "failed", { terminal: outcome.evidence });
					if (!validate) {
						state.reservations = state.reservations.filter(r => r.attemptId !== id);
						const manifest = state.manifests.find(m => m.id === attempt.manifestId && m.revision === state.activeRevisions[m.id]);
						const spec = manifest?.tasks.find(t => t.id === attempt.taskId);
						const inputs = manifest && spec ? this.inputs(state, manifest, spec) : undefined;
						if (manifest && spec && manifest.revision !== attempt.manifestRevision && (taskRevisionDigest(spec) !== attempt.taskDigest || manifest.baseCommit !== attempt.baseCommit || !inputs || digest(inputs.map(r => r.digest)) !== digest(attempt.prerequisiteDigests))) {
							const record = state.tasks.find(t => t.taskId === attempt.taskId)!;
							record.phase = "pending"; delete record.resultDigest; delete record.reason;
						}
					}
				} else if (attempt.phase !== "stopping") this.move(state, attempt, "running");
				this.groupOutcome(state, id, false);
			} else if (outcome.kind === "unknown") { this.move(state, attempt, "recovery-needed", { reason: outcome.reason }); this.groupOutcome(state, id, true); }
			else {
				deferred = outcome.kind === "capacity-deferred";
				this.move(state, attempt, deferred ? "ready" : "failed", { nonStart: outcome.evidence, reason: outcome.reason });
				state.reservations = state.reservations.filter(r => r.attemptId !== id); this.groupOutcome(state, id, true);
				if (!deferred) { const record = state.tasks.find(t => t.taskId === attempt.taskId)!; record.phase = "recovery-needed"; record.reason = `Admission blocked (no child started): ${outcome.reason}`; }
			}
		});
		if (deferred) this.scheduleRecheck(this.observe().attempts.find(a => a.id === id)!.taskId);
		if (validate) this.launchJob(id, () => this.validate(id), this.validationJobs);
		this.scheduleStop(this.observe().attempts.find(a => a.id === id)!);
	}
	private async validate(id: string): Promise<void> {
		const owner = this.owner!, state = this.observe(), attempt = state.attempts.find(a => a.id === id)!;
		const receipt = await this.options.createReceipt({ attempt, task: this.task(state, attempt), checks: this.options.checks });
		if (!this.live(owner)) return;
		this.change(s => {
			const current = s.attempts.find(a => a.id === id)!;
			if (current.phase === "succeeded") return;
			s.results.push(receipt); this.move(s, current, "succeeded", { resultDigest: receipt.digest });
			s.reservations = s.reservations.filter(r => r.attemptId !== id);
			const record = s.tasks.find(t => t.taskId === current.taskId)!;
			const manifest = s.manifests.find(m => m.id === current.manifestId && m.revision === s.activeRevisions[m.id])!;
			const spec = manifest.tasks.find(t => t.id === current.taskId);
			if (spec && this.result(s, manifest, spec)?.digest === receipt.digest) record.resultDigest = receipt.digest;
			else { record.phase = "pending"; delete record.resultDigest; record.reason = "Previous revision settled; current contract awaits admission"; }
		});
	}
}
