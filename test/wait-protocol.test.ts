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
			id: "goal-unrelated",
			paused: true,
			allowance: 3,
			consumed: 1,
			modelRequests: 0,
			waitIdentity: waitOutcomeIdentity("dependency", "goal-unrelated"),
		};

		function onWaitOutcome(event: WaitOutcomeNotice): void {
			if (event.identity !== goal.waitIdentity) return;
			if (goal.paused) return;
			goal.modelRequests += 1;
			goal.consumed += 1;
		}

		const prMerged = notice();
		assert.equal(claimWaitDelivery(dir, prMerged), true);
		onWaitOutcome(prMerged);
		assert.equal(goal.modelRequests, 0, "unrelated PR must not start Goal inference");
		assert.equal(goal.consumed, 1, "unrelated PR must not spend or reset Goal allowance");
		assert.equal(goal.allowance, 3);

		assert.equal(claimWaitDelivery(dir, prMerged), false);
		onWaitOutcome(prMerged);
		assert.equal(goal.modelRequests, 0, "duplicate terminal must not infer");

		const staleOwner = notice({
			owner: { kind: "feature", id: "/orch/icemining/gone" },
			generation: "stale",
		});
		assert.equal(claimWaitDelivery(dir, staleOwner), true);
		onWaitOutcome(staleOwner);
		assert.equal(goal.paused, true);
		assert.equal(goal.modelRequests, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a registered dependency owner may act on its own outcome without touching others", () => {
	const dir = mkdtempSync(join(tmpdir(), "wait-dep-"));
	try {
		const goal = { modelRequests: 0, consumed: 0 };
		const own = notice({
			owner: { kind: "dependency", id: "goal-wait-1" },
			identity: waitOutcomeIdentity("dependency", "goal-wait-1"),
			generation: "g1",
			outcome: "ready",
		});
		assert.equal(claimWaitDelivery(dir, own), true);
		if (own.owner.id === "goal-wait-1") {
			goal.modelRequests += 1;
			goal.consumed += 1;
		}
		assert.equal(goal.modelRequests, 1);
		assert.equal(claimWaitDelivery(dir, own), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
