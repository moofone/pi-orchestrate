import type { ExecutionProfile, RuntimeCapabilities } from "./execution-contract.ts";

export type ProfilePolicyOptions = {
 explicit: ExecutionProfile; resolved?: ExecutionProfile; fallback?: ExecutionProfile;
 capabilities: RuntimeCapabilities; runner?: "native" | "external";
 restrictions?: { tools?: string[]; agents?: string[]; maxTurns?: number; timeoutMs?: number; supervisor?: boolean; intercom?: boolean };
};
export type ProfileResolution = { kind: "resolved"; profile: ExecutionProfile; overrides: ExecutionProfile } | { kind: "conflict"; reasons: string[] };
/** Overrides omit runtime-resolved fields: preset defaults must not overwrite agent configuration. */
export function resolveExecutionProfile(options: ProfilePolicyOptions): ProfileResolution {
 const { explicit, resolved = {}, fallback = {}, capabilities: caps, restrictions = {} } = options;
 const profile: ExecutionProfile = {}, overrides: ExecutionProfile = {};
 for (const key of Object.keys({ ...fallback, ...resolved, ...explicit }) as (keyof ExecutionProfile)[]) {
  const value = explicit[key] ?? resolved[key] ?? fallback[key];
  if (value === undefined) continue;
  Object.assign(profile, { [key]: value });
  if (explicit[key] !== undefined || resolved[key] === undefined) Object.assign(overrides, { [key]: value });
 }
 const reasons: string[] = [];
 for (const ceiling of [caps.callerTools, restrictions.tools]) if (ceiling && profile.tools?.some(t => !ceiling.includes(t))) reasons.push("Requested tools exceed caller ceiling");
 for (const ceiling of [caps.callerAgents, restrictions.agents]) if (ceiling && profile.agent && !ceiling.includes(profile.agent)) reasons.push("Requested agent exceeds caller ceiling");
 for (const key of ["maxTurns", "timeoutMs"] as const) if (restrictions[key] !== undefined && profile[key] !== undefined && profile[key]! > restrictions[key]!) reasons.push(`${key} exceeds hard limit`);
 for (const key of ["supervisor", "intercom"] as const) if (restrictions[key] === false && profile[key] === true) reasons.push(`${key} forbidden by caller`);
 for (const key of Object.keys(overrides) as (keyof ExecutionProfile)[]) {
  if (!caps.profiles.includes(key)) reasons.push(`Runtime cannot override ${key}`);
  if (options.runner === "external" && ["tools", "context", "supervisor", "intercom", "thinking", "maxTurns"].includes(key)) reasons.push(`External runner cannot apply native ${key} override`);
 }
 if (profile.tools?.includes("orchestrate")) reasons.push("Nested orchestrators are forbidden");
 return reasons.length ? { kind: "conflict", reasons } : { kind: "resolved", profile: structuredClone(profile), overrides: structuredClone(overrides) };
}
