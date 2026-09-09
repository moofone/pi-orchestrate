/**
 * Durable PR review controller.
 *
 * One owner per PR generation. Hooks call `reconcile`; they do not launch
 * writers or inject "continue fixing" into the parent. A missing Feature
 * adapter never falls back to a solo parent writer.
 *
 * waiting_review → verdict_pending → launching → fixing → validating →
 * publishing → waiting_review
 */
import {
	classifyVerdictNext,
	isGithubAuthError,
	isGithubServerError,
	launchIdempotencyKey,
	parseVerdictHead,
	prKeyId,
	sameGitHead,
	verdictIdentity,
	type PrKey,
	type VerdictKind,
} from "./pr-review-identity.ts";
import {
	emptyObligation,
	type ConsumptionReceipt,
	type Obligation,
	type ReviewOwner,
	type ReviewState,
	type ReviewStore,
	type VerdictRecord,
} from "./pr-review-store.ts";
import type {
	LaunchIntent,
	LaunchResult,
	OwnerLookup,
	PublishRequest,
	PublishResult,
	RunSnapshot,
} from "./pr-review-events.ts";

export type PrLiveState = "open" | "merged" | "closed" | "unknown";

export type WaiterHealth = {
	running: boolean;
	stale?: boolean;
	reason?: string;
};

export type IncomingObservation = {
	pr: PrKey;
	next: string;
	body?: string;
	head?: string;
	round?: string;
	observedAt?: number;
	githubStatus?: "ok" | "http_500" | "auth" | "unknown";
};

export type ObserveAck = {
	accepted: boolean;
	identity: string;
	kind: VerdictKind;
	duplicate?: boolean;
	reason?: string;
};

export type HandoffRequest = {
	pr: PrKey;
	owner: ReviewOwner;
	worktree: string;
	head?: string;
	linkedTodo?: string;
};

export type HandoffAck = {
	ok: boolean;
	state: ReviewState;
	reason?: string;
	transferred?: boolean;
};

export type ChildResult = {
	runId: string;
	ok: boolean;
	stopped?: boolean;
	handoffWritten?: boolean;
	localHead?: string;
	remoteHead?: string;
	stale?: boolean;
	disagreed?: boolean;
};

export type ObligationView = {
	pr: string;
	owner: ReviewOwner;
	worktree: string;
	head: string;
	state: ReviewState;
	pendingCount: number;
	runId?: string;
	lastProgress?: { at: number; note: string };
	retry?: Obligation["retry"];
	failureReason?: string;
	linkedTodo?: string;
};

export type ReconcileReport = {
	seen: number;
	observed: number;
	launched: number;
	published: number;
	rearmed: number;
	terminal: number;
	recovery: number;
	refused: number;
};

export type ReviewControllerDeps = {
	store: ReviewStore;
	now?: () => number;
	lookupOwner: (pr: PrKey, current?: ReviewOwner) => OwnerLookup;
	launchFixer: (intent: LaunchIntent) => Promise<LaunchResult>;
	queryRun: (key: string) => Promise<RunSnapshot | undefined>;
	publish: (req: PublishRequest) => Promise<PublishResult>;
	reawait: (pr: PrKey, worktree: string) => Promise<void>;
	prState: (pr: PrKey) => Promise<PrLiveState>;
	currentHead: (pr: PrKey, worktree?: string) => Promise<string | undefined>;
	waiterHealth: (pr: PrKey) => Promise<WaiterHealth>;
	ensureWaiter: (pr: PrKey, worktree: string) => Promise<void>;
	notifyTerminal?: (notice: {
		pr: PrKey;
		owner: ReviewOwner;
		state: "merged" | "closed_unmerged";
		linkedTodo?: string;
	}) => void;
	pid?: number;
};

export type ReviewController = {
	handoff(req: HandoffRequest): HandoffAck;
	observeVerdict(obs: IncomingObservation): ObserveAck;
	reconcile(opts?: { ownerId?: string }): Promise<ReconcileReport>;
	childFinished(result: ChildResult): Promise<void>;
	status(pr?: PrKey): ObligationView[];
	pause(pr: PrKey, reason: string): void;
	cancel(pr: PrKey, reason: string): void;
};

const FIX_RETRY_CAP = 8;
const AUTH_FAIL_CAP = 3;
const BACKOFF_MS = 1_000;

export function createReviewController(deps: ReviewControllerDeps): ReviewController {
	const now = deps.now ?? Date.now;
	const pid = deps.pid ?? process.pid;
	const store = deps.store;
	const inflight = new Map<string, Promise<void>>();
	const locked = new Set<string>();

	function save(ob: Obligation, note?: string): Obligation {
		if (note) ob.lastProgress = { at: now(), note };
		const latest = store.read(ob.pr);
		if (latest) {
			for (const v of latest.pendingVerdicts) {
				if (ob.pendingVerdicts.some((p) => p.identity === v.identity)) continue;
				if (ob.activeVerdictIds.includes(v.identity)) continue;
				if (store.hasReceipt(v.identity)) continue;
				ob.pendingVerdicts.push(v);
			}
		}
		store.write(ob);
		return ob;
	}

	function view(ob: Obligation): ObligationView {
		return {
			pr: prKeyId(ob.pr),
			owner: ob.owner,
			worktree: ob.worktree,
			head: ob.head,
			state: ob.state,
			pendingCount: ob.pendingVerdicts.length,
			runId: ob.launch?.runId,
			lastProgress: ob.lastProgress,
			retry: ob.retry,
			failureReason: ob.failureReason,
			linkedTodo: ob.linkedTodo,
		};
	}

	function ownerEligible(ob: Obligation): { ok: true; lookup: OwnerLookup } | { ok: false; reason: string; recovery?: boolean } {
		if (ob.state === "paused" || ob.state === "cancelled") {
			return { ok: false, reason: ob.state };
		}
		let lookup: OwnerLookup;
		try {
			lookup = deps.lookupOwner(ob.pr, ob.owner);
		} catch (error) {
			return { ok: false, reason: String(error), recovery: ob.owner.kind === "feature" };
		}
		if (lookup.status === "unavailable") {
			return { ok: false, reason: lookup.reason, recovery: true };
		}
		if (ob.owner.kind === "feature") {
			if (lookup.status !== "feature" || lookup.owner.id !== ob.owner.id) {
				return { ok: false, reason: "feature owner lookup failed", recovery: true };
			}
			if (lookup.owner.generation !== ob.owner.generation) {
				return { ok: false, reason: "owner generation changed" };
			}
		}
		if (ob.owner.kind === "session") {
			if (lookup.status === "feature") {
				return { ok: false, reason: "session still holds this PR; feature transfer requires release" };
			}
			if (lookup.status !== "session" || lookup.owner.id !== ob.owner.id) {
				return { ok: false, reason: "session owner mismatch" };
			}
			if (lookup.owner.generation !== ob.owner.generation) {
				return { ok: false, reason: "owner generation changed" };
			}
		}
		return { ok: true, lookup };
	}

	const controller: ReviewController = {
		handoff(req) {
			if (locked.has(prKeyId(req.pr))) {
				const existing = store.read(req.pr);
				return {
					ok: false,
					state: existing?.state ?? "waiting_review",
					reason: "reconcile in progress",
				};
			}
			if (req.owner.kind === "observer") {
				return { ok: false, state: "cancelled", reason: "observer has no mutation authority" };
			}
			const existing = store.read(req.pr);
			if (!existing) {
				const ob = emptyObligation(req);
				save(ob, "handoff");
				return { ok: true, state: ob.state };
			}
			if (existing.owner.kind === req.owner.kind && existing.owner.id === req.owner.id) {
				existing.worktree = req.worktree || existing.worktree;
				if (req.head) existing.head = req.head;
				if (req.linkedTodo) existing.linkedTodo = req.linkedTodo;
				save(existing, "handoff refresh");
				return { ok: true, state: existing.state };
			}
			const writer = store.writerFor(req.pr);
			if (existing.writer && !writer) existing.writer = undefined;
			if (writer) {
				return { ok: false, state: existing.state, reason: "writer still holds this PR" };
			}
			const sessionToFeature =
				existing.owner.kind === "session" && req.owner.kind === "feature";
			const sessionToSession =
				existing.owner.kind === "session" && req.owner.kind === "session";
			if (!sessionToFeature && !sessionToSession && existing.owner.kind !== "observer") {
				return {
					ok: false,
					state: existing.state,
					reason: `owned by ${existing.owner.kind}:${existing.owner.id}`,
				};
			}
			existing.owner = req.owner;
			existing.generation = req.owner.generation;
			existing.worktree = req.worktree;
			if (req.head) existing.head = req.head;
			if (req.linkedTodo) existing.linkedTodo = req.linkedTodo;
			save(existing, "ownership transfer");
			return { ok: true, state: existing.state, transferred: true };
		},

		observeVerdict(obs) {
			const body = obs.body ?? "";
			const head = (obs.head || parseVerdictHead(body)).trim();
			const kind = classifyVerdictNext(obs.next, body);
			const github500 = kind === "env" && (obs.githubStatus === "http_500" || isGithubServerError(body));
			const identity = verdictIdentity({
				pr: obs.pr,
				head,
				next: obs.next,
				body,
				round: obs.round,
			});
			if (store.hasReceipt(identity)) {
				return { accepted: true, identity, kind, duplicate: true, reason: "already consumed" };
			}
			const record: VerdictRecord = {
				identity,
				next: obs.next,
				head,
				body,
				round: obs.round,
				observedAt: obs.observedAt ?? now(),
				kind,
			};
			store.putInbox(record, obs.pr);
			const ob = store.read(obs.pr);
			if (!ob) {
				return {
					accepted: true,
					identity,
					kind,
					reason: "queued without owner; recovery-required until handoff",
				};
			}
			if (ob.state === "paused" || ob.state === "cancelled" || ob.state === "merged" || ob.state === "closed_unmerged") {
				return { accepted: false, identity, kind, reason: ob.state };
			}
			if (kind === "env") {
				if (
					ob.state === "launching" ||
					ob.state === "fixing" ||
					ob.state === "validating" ||
					ob.state === "publishing"
				) {
					return {
						accepted: true,
						identity,
						kind,
						reason: "env queued; fixer in flight",
					};
				}
				const auth = obs.githubStatus === "auth" || isGithubAuthError(body);
				ob.lastProgress = { at: now(), note: github500 ? "github 500" : auth ? "auth" : `env: ${obs.next}` };
				if (ob.state === "retry_scheduled" && (ob.retry?.deadline ?? 0) > now()) {
					save(ob);
					return { accepted: true, identity, kind, reason: "env retry already scheduled" };
				}
				if (auth) {
					const count = (ob.retry?.count ?? 0) + 1;
					if (count >= AUTH_FAIL_CAP) {
						ob.state = "recovery_required";
						ob.failureReason = "repeated auth/config failure";
					} else {
						ob.retry = { deadline: now() + BACKOFF_MS * 2 ** count, count, reason: "auth" };
						ob.state = "retry_scheduled";
					}
				} else {
					const count = (ob.retry?.count ?? 0) + 1;
					ob.retry = {
						deadline: now() + BACKOFF_MS * 2 ** Math.min(count - 1, 8),
						count,
						reason: github500 ? "github 500" : "env",
					};
					ob.state = "retry_scheduled";
				}
				save(ob);
				return { accepted: true, identity, kind, reason: "not a code-fixer verdict" };
			}
			if (kind === "terminal") {
				consumeRecord(ob, record, "terminal verdict");
				ob.lastProgress = { at: now(), note: `terminal ${obs.next}` };
				if (ob.state === "verdict_pending" && ob.pendingVerdicts.length === 0) {
					ob.state = "waiting_review";
				}
				save(ob, `observed terminal ${obs.next}`);
				return { accepted: true, identity, kind, reason: "terminal; not a fixer" };
			}
			if (ob.activeVerdictIds.includes(identity)) {
				return { accepted: true, identity, kind, duplicate: true };
			}
			const duplicate = ob.pendingVerdicts.some((v) => v.identity === identity);
			if (!duplicate) ob.pendingVerdicts.push(record);
			hydratePending(ob);
			if (ob.state === "waiting_review" || ob.state === "retry_scheduled") {
				ob.state = "verdict_pending";
			}
			save(ob, `observed ${kind} ${identity.slice(0, 8)}`);
			return { accepted: true, identity, kind, duplicate };
		},

		async reconcile(opts = {}) {
			const report: ReconcileReport = {
				seen: 0,
				observed: 0,
				launched: 0,
				published: 0,
				rearmed: 0,
				terminal: 0,
				recovery: 0,
				refused: 0,
			};
			const all = store.list().filter((ob) => !opts.ownerId || ob.owner.id === opts.ownerId);
			for (const ob of all) {
				report.seen += 1;
				try {
					await withPrLock(ob.pr, () => reconcileOne(ob.pr, report));
				} catch (error) {
					const latest = store.read(ob.pr);
					if (!latest) continue;
					latest.state = "recovery_required";
					latest.failureReason = String(error);
					save(latest, "reconcile threw");
					report.recovery += 1;
				}
			}
			return report;
		},

		async childFinished(result) {
			const found = store.list().find((item) => item.launch?.runId === result.runId);
			if (!found) return;
			await withPrLock(found.pr, async () => {
				const ob = store.read(found.pr);
				if (!ob) return;
				if (ob.state === "paused" || ob.state === "cancelled") {
					store.releaseWriter(ob.pr, ob.writer?.holder ?? ob.owner.id);
					ob.writer = undefined;
					save(ob, `child ${result.runId} exited while ${ob.state}`);
					return;
				}
				if (ob.state !== "fixing" && ob.state !== "launching" && ob.state !== "validating") return;
				ob.state = "validating";
				save(ob, `child ${result.runId} exited`);
				await validateAndPublish(ob, result);
			});
		},

		status(pr) {
			const items = pr ? [store.read(pr)].filter((x): x is Obligation => Boolean(x)) : store.list();
			return items.map(view);
		},

		pause(pr, reason) {
			const apply = (): void => {
				const ob = store.read(pr);
				if (!ob) return;
				ob.state = "paused";
				ob.failureReason = reason;
				store.releaseWriter(pr, ob.writer?.holder ?? ob.owner.id);
				ob.writer = undefined;
				save(ob, `paused: ${reason}`);
			};
			if (locked.has(prKeyId(pr))) {
				void withPrLock(pr, async () => apply());
				return;
			}
			apply();
		},

		cancel(pr, reason) {
			const apply = (): void => {
				const ob = store.read(pr);
				if (!ob) return;
				ob.state = "cancelled";
				ob.failureReason = reason;
				store.releaseWriter(pr, ob.writer?.holder ?? ob.owner.id);
				ob.writer = undefined;
				save(ob, `cancelled: ${reason}`);
			};
			if (locked.has(prKeyId(pr))) {
				void withPrLock(pr, async () => apply());
				return;
			}
			apply();
		},
	};

	function withPrLock(pr: PrKey, fn: () => Promise<void>): Promise<void> {
		const id = prKeyId(pr);
		const prev = inflight.get(id) ?? Promise.resolve();
		const mine = prev.then(
			async () => {
				locked.add(id);
				try {
					await fn();
				} finally {
					locked.delete(id);
				}
			},
			async () => {
				locked.add(id);
				try {
					await fn();
				} finally {
					locked.delete(id);
				}
			},
		);
		inflight.set(
			id,
			mine.then(
				() => undefined,
				() => undefined,
			),
		);
		return mine;
	}

	function hydratePending(ob: Obligation): void {
		for (const v of store.listInbox(ob.pr)) {
			if (store.hasReceipt(v.identity)) continue;
			if (v.kind !== "fix" && v.kind !== "dead_reviewers") continue;
			if (ob.pendingVerdicts.some((p) => p.identity === v.identity)) continue;
			if (ob.activeVerdictIds.includes(v.identity)) continue;
			ob.pendingVerdicts.push(v);
		}
		if (ob.pendingVerdicts.length > 0 && ob.state === "waiting_review") {
			ob.state = "verdict_pending";
		}
	}

	async function reconcileOne(pr: PrKey, report: ReconcileReport): Promise<void> {
		const ob = store.read(pr);
		if (!ob) return;
		hydratePending(ob);
		if (ob.state === "paused" || ob.state === "cancelled") return;
		if (ob.state === "merged" || ob.state === "closed_unmerged") {
			notifyOnce(ob);
			return;
		}

		const live = await deps.prState(ob.pr);
		if (live === "merged" || live === "closed") {
			finishTerminal(ob, live === "merged" ? "merged" : "closed_unmerged");
			report.terminal += 1;
			return;
		}

		const eligibility = ownerEligible(ob);
		if (!eligibility.ok) {
			if (eligibility.recovery) {
				ob.state = "recovery_required";
				ob.failureReason = eligibility.reason;
				save(ob);
				report.recovery += 1;
			}
			return;
		}

		if (ob.state === "recovery_required") return;

		if (ob.state === "retry_scheduled") {
			if ((ob.retry?.deadline ?? 0) > now()) return;
			ob.state = ob.pendingVerdicts.length ? "verdict_pending" : "waiting_review";
			save(ob, "retry due");
		}

		if (ob.state === "launching") {
			await recoverOrLaunch(ob, report);
			return;
		}

		if (ob.state === "fixing") {
			const key = ob.launch?.runId ?? ob.launch?.idempotencyKey;
			if (!key) {
				ob.state = "recovery_required";
				ob.failureReason = "fixing without launch journal";
				save(ob);
				report.recovery += 1;
				return;
			}
			const snap = await deps.queryRun(key);
			if (snap?.status === "exited") {
				ob.state = "validating";
				save(ob, "fixer exited");
				await validateAndPublish(ob, {
					runId: snap.runId,
					ok: snap.ok ?? false,
					stopped: snap.stopped,
					handoffWritten: snap.handoffWritten,
					localHead: snap.head,
				});
			}
			return;
		}

		if (ob.state === "validating" || ob.state === "publishing") {
			const key = ob.launch?.runId ?? ob.launch?.idempotencyKey;
			const snap = key ? await deps.queryRun(key) : undefined;
			if (!snap || snap.status !== "exited") return;
			await validateAndPublish(ob, {
				runId: snap.runId,
				ok: snap.ok ?? false,
				stopped: snap.stopped,
				handoffWritten: snap.handoffWritten,
				localHead: snap.head,
			});
			return;
		}

		if (ob.state === "waiting_review") {
			const health = await deps.waiterHealth(ob.pr);
			if (!health.running || health.stale) {
				try {
					await deps.ensureWaiter(ob.pr, ob.worktree);
					save(ob, health.stale ? "restarted stale waiter" : "ensured waiter");
				} catch (error) {
					scheduleWaiterRetry(ob, error);
				}
			}
			if (ob.pendingVerdicts.length > 0) ob.state = "verdict_pending";
			else return;
		}

		if (ob.state === "verdict_pending") {
			await dispatchPending(ob, report);
		}
	}

	async function dispatchPending(ob: Obligation, report: ReconcileReport): Promise<void> {
		const pendingFix = ob.pendingVerdicts.find((v) => v.kind === "fix");
		if (!pendingFix) {
			const dead = ob.pendingVerdicts.find((v) => v.kind === "dead_reviewers");
			if (dead) {
				await deps.ensureWaiter(ob.pr, ob.worktree);
				consumeRecord(ob, dead, "dead reviewers");
				ob.state = "waiting_review";
				save(ob, "re-armed waiter for dead reviewers");
				report.rearmed += 1;
				return;
			}
			const leftover = ob.pendingVerdicts.filter((v) => v.kind !== "fix" && v.kind !== "dead_reviewers");
			for (const v of leftover) consumeRecord(ob, v, v.kind === "terminal" ? "terminal verdict" : "not a fixer");
			if (leftover.some((v) => v.kind === "terminal")) report.terminal += leftover.filter((v) => v.kind === "terminal").length;
			ob.state = ob.pendingVerdicts.length ? "verdict_pending" : "waiting_review";
			save(ob, leftover.length ? "drained non-fixer verdicts" : "empty pending");
			return;
		}

		const liveHead = (await deps.currentHead(ob.pr, ob.worktree)) ?? ob.head;
		if (pendingFix.head && liveHead && !sameGitHead(pendingFix.head, liveHead)) {
			ob.lastProgress = {
				at: now(),
				note: `stale verdict against ${pendingFix.head.slice(0, 12)}; live ${liveHead.slice(0, 12)}`,
			};
			ob.head = liveHead;
			ob.pendingVerdicts = ob.pendingVerdicts.filter((v) => v.identity !== pendingFix.identity);
			store.putReceipt({
				v: 1,
				identity: pendingFix.identity,
				pr: prKeyId(ob.pr),
				ownerGeneration: ob.owner.generation,
				consumedAt: now(),
				reason: "stale head",
			});
			ob.state = "waiting_review";
			save(ob, ob.lastProgress.note);
			await armWaiter(ob);
			report.rearmed += 1;
			return;
		}

		if (store.writerFor(ob.pr) && ob.state === "fixing") {
			report.refused += 1;
			return;
		}

		const holder = `${ob.owner.kind}:${ob.owner.id}`;
		const reservation = { holder, pid, reservedAt: now() };
		if (!store.reserveWriter(ob.pr, reservation)) {
			report.refused += 1;
			return;
		}
		ob.writer = reservation;
		const ids = [pendingFix.identity];
		const key = launchIdempotencyKey({
			pr: ob.pr,
			ownerGeneration: ob.owner.generation,
			head: liveHead || pendingFix.head,
			verdictIds: ids,
			attempt: ob.retry?.count ?? 0,
		});
		ob.launch = { idempotencyKey: key, intentAt: now(), worktree: ob.worktree };
		ob.state = "launching";
		ob.head = liveHead || pendingFix.head;
		save(ob, "launch intent");
		await recoverOrLaunch(ob, report);
	}

	async function recoverOrLaunch(ob: Obligation, report: ReconcileReport): Promise<void> {
		const journal = ob.launch;
		if (!journal) {
			ob.state = "recovery_required";
			ob.failureReason = "launching without journal";
			save(ob);
			report.recovery += 1;
			return;
		}
		const existing =
			(await deps.queryRun(journal.idempotencyKey)) ??
			(journal.runId ? await deps.queryRun(journal.runId) : undefined);
		if (existing) {
			journal.runId = existing.runId;
			journal.acceptedAt = journal.acceptedAt ?? now();
			journal.worktree = journal.worktree || ob.worktree;
			ob.state = existing.status === "exited" ? "validating" : "fixing";
			if (ob.writer) {
				ob.writer.runId = existing.runId;
				store.reserveWriter(ob.pr, ob.writer);
			}
			consumeActive(ob);
			save(ob, existing.status === "exited" ? "recovered exited run" : "recovered live run");
			if (ob.state === "validating") {
				await validateAndPublish(ob, {
					runId: existing.runId,
					ok: existing.ok ?? false,
					stopped: existing.stopped,
					handoffWritten: existing.handoffWritten,
					localHead: existing.head,
				});
			} else {
				report.launched += 1;
			}
			return;
		}

		const pendingFix = ob.pendingVerdicts.find((v) => v.kind === "fix") ?? ob.pendingVerdicts[0];
		if (!pendingFix) {
			ob.state = "waiting_review";
			store.releaseWriter(ob.pr, ob.writer?.holder ?? ob.owner.id);
			ob.writer = undefined;
			ob.launch = undefined;
			save(ob, "nothing to launch");
			return;
		}
		const intent: LaunchIntent = {
			v: 1,
			idempotencyKey: journal.idempotencyKey,
			pr: ob.pr,
			owner: ob.owner,
			worktree: ob.worktree,
			expectedHead: ob.head || pendingFix.head,
			verdictIds: [pendingFix.identity],
			next: pendingFix.next,
			body: pendingFix.body,
			validation: "commit-only",
			publication: "controller",
		};
		let launched: LaunchResult;
		try {
			launched = await deps.launchFixer(intent);
		} catch (error) {
			const msg = String(error);
			store.releaseWriter(ob.pr, ob.writer?.holder ?? ob.owner.id);
			ob.writer = undefined;
			ob.launch = undefined;
			if (/refuse/i.test(msg)) {
				ob.state = "verdict_pending";
				save(ob, "adapter refused");
				report.refused += 1;
				return;
			}
			ob.state = "recovery_required";
			ob.failureReason = `launch failed: ${msg}`;
			save(ob, ob.failureReason);
			report.recovery += 1;
			return;
		}
		journal.runId = launched.runId;
		journal.acceptedAt = now();
		journal.worktree = journal.worktree || ob.worktree;
		if (ob.writer) {
			ob.writer.runId = launched.runId;
			store.reserveWriter(ob.pr, ob.writer);
		}
		consumeActive(ob);
		if (launched.completeRound) {
			store.releaseWriter(ob.pr, ob.writer?.holder ?? ob.owner.id);
			ob.writer = undefined;
			ob.launch = undefined;
			ob.state = "waiting_review";
			save(ob, launched.recovered ? "feature round recovered" : "feature adapter completed round");
			report.launched += 1;
			return;
		}
		const snap =
			(await deps.queryRun(launched.runId)) ?? (await deps.queryRun(journal.idempotencyKey));
		if (snap?.status === "exited") {
			ob.state = "validating";
			if (ob.writer) ob.writer.runId = launched.runId;
			save(ob, "fixer already exited");
			report.launched += 1;
			await validateAndPublish(ob, {
				runId: snap.runId,
				ok: snap.ok ?? false,
				stopped: snap.stopped,
				handoffWritten: snap.handoffWritten,
				localHead: snap.head,
			});
			return;
		}
		ob.state = "fixing";
		save(ob, launched.recovered ? "bound recovered run" : "fixer launched");
		report.launched += 1;
	}

	function consumeActive(ob: Obligation): void {
		const ids = ob.launch ? [ob.pendingVerdicts.find((v) => v.kind === "fix")?.identity].filter(Boolean) as string[] : [];
		for (const id of ids) {
			if (store.hasReceipt(id)) continue;
			const receipt: ConsumptionReceipt = {
				v: 1,
				identity: id,
				pr: prKeyId(ob.pr),
				ownerGeneration: ob.owner.generation,
				consumedAt: now(),
				reason: "launch accepted",
			};
			store.putReceipt(receipt);
			if (!ob.activeVerdictIds.includes(id)) ob.activeVerdictIds.push(id);
			ob.pendingVerdicts = ob.pendingVerdicts.filter((v) => v.identity !== id);
		}
	}

	function unconsume(ob: Obligation): void {
		for (const id of [...ob.activeVerdictIds]) {
			store.deleteReceipt(id);
			const rec = store.readInbox(id);
			if (rec && !ob.pendingVerdicts.some((p) => p.identity === id)) {
				ob.pendingVerdicts.unshift(rec);
			}
		}
		ob.activeVerdictIds = [];
		ob.launch = undefined;
	}

	function consumeRecord(ob: Obligation, record: VerdictRecord, reason: string): void {
		if (!store.hasReceipt(record.identity)) {
			store.putReceipt({
				v: 1,
				identity: record.identity,
				pr: prKeyId(ob.pr),
				ownerGeneration: ob.owner.generation,
				consumedAt: now(),
				reason,
			});
		}
		ob.pendingVerdicts = ob.pendingVerdicts.filter((v) => v.identity !== record.identity);
	}

	function failFix(ob: Obligation, reason: string): void {
		const count = (ob.retry?.count ?? 0) + 1;
		unconsume(ob);
		if (count >= FIX_RETRY_CAP) {
			ob.state = "recovery_required";
			ob.failureReason = `${reason} repeatedly`;
		} else {
			ob.state = "retry_scheduled";
			ob.retry = { deadline: now() + BACKOFF_MS * 2 ** count, count, reason };
		}
		store.releaseWriter(ob.pr, ob.writer?.holder ?? ob.owner.id);
		ob.writer = undefined;
		save(ob, reason);
	}

	async function validateAndPublish(ob: Obligation, result: ChildResult): Promise<void> {
		if (result.stopped) {
			ob.state = "paused";
			ob.failureReason = "fixer stopped";
			store.releaseWriter(ob.pr, ob.writer?.holder ?? ob.owner.id);
			ob.writer = undefined;
			save(ob, "fixer stopped");
			return;
		}
		if (result.stale) {
			ob.state = "waiting_review";
			store.releaseWriter(ob.pr, ob.writer?.holder ?? ob.owner.id);
			ob.writer = undefined;
			ob.launch = undefined;
			save(ob, "stale-head no-op; re-await");
			await deps.reawait(ob.pr, ob.worktree);
			return;
		}
		if (result.disagreed) {
			ob.state = "recovery_required";
			ob.failureReason = "fixer no-op on current head — disagreement";
			store.releaseWriter(ob.pr, ob.writer?.holder ?? ob.owner.id);
			ob.writer = undefined;
			save(ob);
			return;
		}
		const local = result.localHead;
		const moved = Boolean(local && local !== ob.head);
		if (!result.ok && !moved) {
			failFix(ob, "fixer failed");
			return;
		}
		if (!local) {
			failFix(ob, "fixer produced no head");
			return;
		}
		if (!moved && result.ok) {
			failFix(ob, "fixer no-op on current head");
			return;
		}

		ob.state = "publishing";
		save(ob, "publishing");
		// Only an explicit remote head is evidence of a prior push. currentHead is
		// the local worktree (git rev-parse HEAD) and matches `local` after a
		// successful fixer — that must not skip publish.
		const remoteNow = result.remoteHead;
		if (local && remoteNow && local === remoteNow) {
			await rearms(ob, local);
			return;
		}
		const published = await deps.publish({
			v: 1,
			pr: ob.pr,
			worktree: ob.worktree,
			expectedHead: ob.head,
			localHead: local,
			remoteHead: remoteNow,
		});
		if (!published.ok && !published.already) {
			store.releaseWriter(ob.pr, ob.writer?.holder ?? ob.owner.id);
			ob.writer = undefined;
			ob.state = "recovery_required";
			ob.failureReason = published.reason ?? "publish failed";
			save(ob);
			return;
		}
		await rearms(ob, published.remoteHead || local);
	}

	async function rearms(ob: Obligation, head: string): Promise<void> {
		ob.head = head;
		ob.state = "waiting_review";
		store.releaseWriter(ob.pr, ob.writer?.holder ?? ob.owner.id);
		ob.writer = undefined;
		ob.launch = undefined;
		save(ob, `published ${head.slice(0, 12)}; re-await`);
		await armWaiter(ob);
	}

	async function armWaiter(ob: Obligation): Promise<void> {
		try {
			await deps.reawait(ob.pr, ob.worktree);
		} catch (error) {
			scheduleWaiterRetry(ob, error);
		}
	}

	function scheduleWaiterRetry(ob: Obligation, error: unknown): void {
		ob.retry = {
			deadline: now() + BACKOFF_MS * 2 ** (ob.retry?.count ?? 0),
			count: (ob.retry?.count ?? 0) + 1,
			reason: `waiter: ${String(error)}`,
		};
		ob.state = "retry_scheduled";
		save(ob);
	}

	function finishTerminal(ob: Obligation, state: "merged" | "closed_unmerged"): void {
		ob.state = state;
		store.releaseWriter(ob.pr, ob.writer?.holder ?? ob.owner.id);
		ob.writer = undefined;
		save(ob, state);
		notifyOnce(ob);
	}

	function notifyOnce(ob: Obligation): void {
		if (ob.terminalNotified) return;
		ob.terminalNotified = true;
		save(ob);
		if (ob.state !== "merged" && ob.state !== "closed_unmerged") return;
		deps.notifyTerminal?.({
			pr: ob.pr,
			owner: ob.owner,
			state: ob.state,
			linkedTodo: ob.linkedTodo,
		});
	}

	return controller;
}

export function isMergeDependentComplete(view: ObligationView): boolean {
	return view.state === "merged";
}
