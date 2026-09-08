/**
 * Isolated wait-outcome protocol: owner delivery, duplicate claim, and a
 * fake Goal participant that must not infer from an unrelated PR result.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	WAIT_PROTOCOL_VERSION,
	claimWaitDelivery,
	readWaitDeliveryReceipt,
	waitOutcomeIdentity,
	type WaitOutcomeNotice,
} from "../src/lib/wait-protocol.ts";

function notice(partial: Partial<WaitOutcomeNotice> = {}): WaitOutcomeNotice {
	return {
		v: WAIT_PROTOCOL_VERSION,
		owner: { kind: "feature", id: "/orch/icemining/feat-x" },
		source: "pr",
		identity: waitOutcomeIdentity("pr", "icemining#2142"),
		generation: "gen-1",
		outcome: "merged",
		deliveredAt: 1,
		...partial,
	};
}

test("claimWaitDelivery is first-writer-wins for owner+identity+generation+outcome", () => {
	const dir = mkdtempSync(join(tmpdir(), "wait-proto-"));
	try {
		const n = notice();
		assert.equal(claimWaitDelivery(dir, n), true);
		assert.equal(claimWaitDelivery(dir, n), false);
		assert.equal(claimWaitDelivery(dir, { ...n, deliveredAt: 99 }), false);
		assert.equal(claimWaitDelivery(dir, { ...n, outcome: "closed" }), true);
		assert.ok(readWaitDeliveryReceipt(dir, n));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("restart replay of the same generation does not grant another delivery", () => {
	const dir = mkdtempSync(join(tmpdir(), "wait-proto-"));
	try {
		const n = notice({ generation: "reload-gen" });
		assert.equal(claimWaitDelivery(dir, n), true);
		assert.equal(
			claimWaitDelivery(dir, notice({ generation: "reload-gen", deliveredAt: Date.now() })),
			false,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("combined Goal/latch harness: unrelated or duplicate PR outcomes do not infer", () => {
	const dir = mkdtempSync(join(tmpdir(), "wait-goal-"));
	try {
		const goal = {
			id: "goal-wait-1",
			paused: false,
			allowance: 3,
			consumed: 1,
			modelRequests: 0,
			waitIdentity: waitOutcomeIdentity("dependency", "goal-wait-1"),
		};

		function onWaitOutcome(event: WaitOutcomeNotice): void {
			if (!claimWaitDelivery(dir, event)) return;
			if (event.identity !== goal.waitIdentity) return;
			if (goal.paused) return;
			goal.modelRequests += 1;
			goal.consumed += 1;
		}

		const prMerged = notice();
		onWaitOutcome(prMerged);
		assert.equal(goal.modelRequests, 0, "unrelated PR must not start Goal inference");
		assert.equal(goal.consumed, 1, "unrelated PR must not spend or reset Goal allowance");
		assert.equal(goal.allowance, 3);

		const own = notice({
			owner: { kind: "dependency", id: goal.id },
			source: "dependency",
			identity: goal.waitIdentity,
			generation: "g1",
			outcome: "ready",
		});
		onWaitOutcome(own);
		assert.equal(goal.modelRequests, 1, "matching WaitOutcomeNotice must infer once");
		assert.equal(goal.consumed, 2);

		onWaitOutcome(own);
		assert.equal(goal.modelRequests, 1, "claimWaitDelivery must gate a duplicate matching outcome");
		onWaitOutcome(prMerged);
		assert.equal(goal.modelRequests, 1, "duplicate unrelated PR must not infer");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a registered dependency owner may act on its own outcome without touching others", () => {
	const dir = mkdtempSync(join(tmpdir(), "wait-dep-"));
	try {
		const goal = {
			id: "goal-wait-1",
			modelRequests: 0,
			consumed: 0,
			waitIdentity: waitOutcomeIdentity("dependency", "goal-wait-1"),
		};
		function onWaitOutcome(event: WaitOutcomeNotice): void {
			if (!claimWaitDelivery(dir, event)) return;
			if (event.identity !== goal.waitIdentity) return;
			goal.modelRequests += 1;
			goal.consumed += 1;
		}
		const foreign = notice();
		onWaitOutcome(foreign);
		assert.equal(goal.modelRequests, 0, "a foreign PR owner must not drive this Goal");
		const own = notice({
			owner: { kind: "dependency", id: goal.id },
			source: "dependency",
			identity: goal.waitIdentity,
			generation: "g1",
			outcome: "ready",
		});
		onWaitOutcome(own);
		assert.equal(goal.modelRequests, 1);
		onWaitOutcome(own);
		assert.equal(goal.modelRequests, 1, "duplicate own outcome is already claimed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
