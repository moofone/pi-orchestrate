import test from "node:test";
import assert from "node:assert/strict";
import { resolveExecutionProfile } from "../src/lib/execution-policy.ts";
import { FakeAttemptRuntime } from "./fixtures/execution/fakes.ts";
const capabilities = new FakeAttemptRuntime().capabilities;
test("execution-policy preserves explicit preferences and omits resolved agent settings from overrides", () => {
 const result = resolveExecutionProfile({ explicit: { context: "fork", tools: ["read"], supervisor: true, intercom: true }, resolved: { model: "agent-model", context: "fresh" }, fallback: { model: "legacy-model", timeoutMs: 20 }, capabilities, restrictions: { tools: ["read", "grep"] } });
 assert.equal(result.kind, "resolved"); if (result.kind !== "resolved") return;
 assert.deepEqual(result.profile, { model: "agent-model", context: "fork", timeoutMs: 20, tools: ["read"], supervisor: true, intercom: true });
 assert.equal(result.overrides.model, undefined); assert.equal(result.overrides.context, "fork");
});
test("execution-policy refuses widening tools, agents, budgets, communication, and native external overrides", () => {
 for (const input of [
  { explicit: { tools: ["read", "bash"] }, restrictions: { tools: ["read"] } },
  { explicit: { agent: "worker" }, restrictions: { agents: ["planner"] } },
  { explicit: { maxTurns: 30 }, restrictions: { maxTurns: 10 } },
  { explicit: { supervisor: true }, restrictions: { supervisor: false } },
  { explicit: { context: "fork" as const }, runner: "external" as const },
 ]) assert.equal(resolveExecutionProfile({ capabilities, ...input }).kind, "conflict");
 assert.equal(resolveExecutionProfile({ explicit: { tools: ["read"] }, capabilities: { ...capabilities, callerTools: [] } }).kind, "conflict");
});
test("execution-policy concurrent independent profiles do not register ambient ceilings", async () => {
 const results = await Promise.all(["fresh", "fork"].map(context => Promise.resolve(resolveExecutionProfile({ explicit: { context: context as "fresh" | "fork", tools: ["read"] }, capabilities }))));
 assert.ok(results.every(r => r.kind === "resolved"));
});
