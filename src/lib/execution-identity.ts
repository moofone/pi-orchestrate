import { isAbsolute, resolve } from "node:path";

/**
 * Public pi-subagents extension-binding namespace used to carry execution
 * selection into the child.  The runtime itself supplies the authoritative
 * run id and parent session id in the child environment; this binding only
 * selects the durable attempt/workspace that those runtime facts must match.
 */
export const EXECUTION_IDENTITY_BINDING_NAMESPACE = "pi-orchestrate.execution/1";
export const PI_SUBAGENT_EXTENSION_BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";

export type ExecutionIdentityBinding = {
	attemptId: string;
	workspaceId: string;
	workspacePath: string;
	ownerSessionId: string;
};

function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value)
		&& (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Build the exact binding sent through pi-subagents' supported public API. */
export function createExecutionIdentityBinding(input: ExecutionIdentityBinding): Record<string, ExecutionIdentityBinding> {
	if (!text(input.attemptId) || !text(input.workspaceId) || !text(input.ownerSessionId)
		|| !text(input.workspacePath) || !isAbsolute(input.workspacePath) || resolve(input.workspacePath) !== input.workspacePath) {
		throw new Error("Invalid execution identity binding");
	}
	return {
		[EXECUTION_IDENTITY_BINDING_NAMESPACE]: {
			attemptId: input.attemptId,
			workspaceId: input.workspaceId,
			workspacePath: input.workspacePath,
			ownerSessionId: input.ownerSessionId,
		},
	};
}

/**
 * Decode only the binding owned by this extension.  Unknown/malformed values
 * are rejected rather than being partially trusted.  Other extension
 * namespaces may coexist, as pi-subagents supports namespaced bindings.
 */
export function readExecutionIdentityBinding(env: Record<string, string | undefined>): ExecutionIdentityBinding | undefined {
	const encoded = env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV]?.trim();
	if (!encoded) return undefined;
	try {
		const parsed: unknown = JSON.parse(encoded);
		if (!isPlainObject(parsed)) return undefined;
		const raw = parsed[EXECUTION_IDENTITY_BINDING_NAMESPACE];
		if (!isPlainObject(raw)) return undefined;
		const keys = Object.keys(raw).sort();
		if (keys.join(",") !== "attemptId,ownerSessionId,workspaceId,workspacePath") return undefined;
		if (!text(raw.attemptId) || !text(raw.workspaceId) || !text(raw.ownerSessionId)
			|| !text(raw.workspacePath) || !isAbsolute(raw.workspacePath) || resolve(raw.workspacePath) !== raw.workspacePath) return undefined;
		return {
			attemptId: raw.attemptId,
			workspaceId: raw.workspaceId,
			workspacePath: raw.workspacePath,
			ownerSessionId: raw.ownerSessionId,
		};
	} catch {
		return undefined;
	}
}
