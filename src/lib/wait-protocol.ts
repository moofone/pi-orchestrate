/**
 * Extension-neutral wait-outcome protocol v1.
 *
 * A terminal wait result belongs to one owner. Delivery is claimed once per
 * owner + identity + generation + outcome. Other sessions may observe the
 * event; only the owner is entitled to inference.
 *
 * No participant imports another extension. Standalone behavior is unchanged
 * when no other listener is present.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WAIT_OUTCOME_EVENT = "pi.wait.outcome";
export const WAIT_PROTOCOL_VERSION = 1 as const;

export type WaitOwnerKind = "feature" | "session" | "dependency";

export type WaitOwner = {
	kind: WaitOwnerKind;
	id: string;
};

export type WaitOutcomeNotice = {
	v: typeof WAIT_PROTOCOL_VERSION;
	owner: WaitOwner;
	source: string;
	identity: string;
	generation: string;
	outcome: string;
	deliveredAt: number;
};

export function waitOutcomeIdentity(source: string, key: string): string {
	return `${source}:${key}`;
}

export function waitDeliveryKey(
	notice: Pick<WaitOutcomeNotice, "owner" | "identity" | "generation" | "outcome">,
): string {
	return [
		notice.owner.kind,
		notice.owner.id,
		notice.identity,
		notice.generation,
		notice.outcome,
	].join("\0");
}

export function waitDeliveryReceiptPath(dir: string, key: string): string {
	const digest = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 24);
	return join(dir, `wait-delivered-${digest}.json`);
}

export function readWaitDeliveryReceipt(
	dir: string,
	notice: Pick<WaitOutcomeNotice, "owner" | "identity" | "generation" | "outcome">,
): WaitOutcomeNotice | undefined {
	try {
		const raw = JSON.parse(readFileSync(waitDeliveryReceiptPath(dir, waitDeliveryKey(notice)), "utf8"));
		if (!raw || raw.v !== WAIT_PROTOCOL_VERSION) return undefined;
		if (typeof raw.identity !== "string" || typeof raw.outcome !== "string") return undefined;
		return raw as WaitOutcomeNotice;
	} catch {
		return undefined;
	}
}

/**
 * First writer wins. Returns true when this process owns the delivery and
 * should emit / infer. Returns false for duplicates and restart replays.
 */
export function claimWaitDelivery(dir: string, notice: WaitOutcomeNotice): boolean {
	mkdirSync(dir, { recursive: true });
	const path = waitDeliveryReceiptPath(dir, waitDeliveryKey(notice));
	if (existsSync(path)) return false;
	try {
		writeFileSync(path, `${JSON.stringify(notice)}\n`, { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}
