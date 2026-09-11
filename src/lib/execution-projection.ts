import { digest, occupiesCapacity, type CoordinatorState, type ExecutionManifest } from "./execution-contract.ts";
import type { ExecutionPreview } from "./execution-bridge.ts";
import type { OverlayTodo } from "./overlay.ts";

/** Read-only projections of the one durable scheduler store. */
export function executionPreviewSummary(preview: ExecutionPreview): string {
 const m = preview.manifest;
 return [
  `Manifest ${m.id} revision ${m.revision} preset=${m.preset}`,
  `source ${m.source.digest}\nmanifest ${digest(m)}\nrepo ${m.repo.id}\nbase ${m.baseCommit}`,
  `publication ${preview.boundary.publication ? (preview.boundary.publicationRepository ?? "unavailable") : "not authorized by plan"}`,
  `Approval token ${preview.token}`,
  `Repository capacity ${preview.boundary.capacity}; requested shape ${m.constraints.capacity}; publication requires separate confirmation`,
  `Scope: ${m.scope}`,
  ...m.features.map(f => `Feature ${f.id}: ${f.title} scope=${f.scope}`),
  ...m.tasks.map(t => `Task ${t.id}: ${t.text}\n  feature=${t.featureId} mode=${t.mode} deps=${t.dependencies.join(",") || "none"} scope=${t.scope.join(",")} agent=${t.profile.agent ?? "runtime default"} profile=${JSON.stringify(t.profile)} delivery=${t.deliveryGroupId}\n  choices: ${t.provenance.map(p => `${p.field}=${p.origin}${p.reason ? ` (${p.reason})` : ""}`).join("; ")}`),
  ...m.deliveryGroups.map(g => `Delivery ${g.id}: features=${g.featureIds.join(",")} required=${g.requiredTaskIds.join(",")} ${g.policy}/${g.completion} owner=${g.ownerId}`),
  ...m.constraints.parallelGroups.map(g => `Parallel ${g.id}: simultaneous=${g.simultaneous} tasks=${g.taskIds.join(",")} ${g.provenance.origin}`),
  `Choices: ${[...m.provenance, ...m.constraints.provenance].map(p => `${p.field}=${p.origin}${p.reason ? ` (${p.reason})` : ""}`).join("; ")}`,
 ].join("\n");
}
export function executionManifestsForTarget(state: CoordinatorState, target?: string): ExecutionManifest[] {
 return state.manifests.filter(m => m.revision === state.activeRevisions[m.id] && (!target || [m.id, m.source.path, ...m.features.map(f => f.id), ...m.tasks.map(t => t.id), ...m.deliveryGroups.map(g => g.id)].includes(target)));
}
export function executionProgressSummary(progress: { state: CoordinatorState; error?: string }, target?: string): string {
 const { state } = progress, manifests = executionManifestsForTarget(state, target);
 if (target && !manifests.length) return `No execution target ${target}`;
 const occupancy = state.reservations.reduce((sum, r) => sum + r.slots, 0);
 const lines = [`engine=plan-driven-v1 epoch=${state.epoch} occupancy=${occupancy}/${state.capacity} active=${state.attempts.filter(occupiesCapacity).length}${progress.error ? ` error=${progress.error}` : ""}`];
 for (const m of manifests) {
  lines.push(`Manifest ${m.id} revision=${m.revision} preset=${m.preset}`);
  for (const f of m.features) lines.push(`Feature ${f.id}: ${f.title}`);
  for (const t of m.tasks) {
   if (target && m.tasks.some(item => item.id === target) && t.id !== target) continue;
   const record = state.tasks.find(r => r.manifestId === m.id && r.taskId === t.id);
   const attempt = state.attempts.find(a => a.id === record?.attemptIds.at(-1));
   const deps = t.dependencies.filter(id => state.tasks.find(r => r.taskId === id)?.phase !== "succeeded");
   lines.push(`Task ${t.id} feature=${t.featureId} phase=${record?.phase ?? "pending"} intent=${record?.intent ?? "none"} delivery=${t.deliveryGroupId}${deps.length ? ` dependencies=${deps.join(",")}` : ""}${record?.reason || attempt?.reason ? ` reason=${record?.reason ?? attempt?.reason}` : ""}${!attempt && occupancy >= state.capacity ? " blocker=repository capacity" : ""}`);
  }
  for (const g of m.deliveryGroups) { const d = state.deliveries.find(item => item.groupId === g.id); lines.push(`Delivery ${g.id} phase=${d?.phase ?? "pending"}${d?.reason ? ` reason=${d.reason}` : ""}`); }
 }
 return lines.join("\n");
}

/** Project durable plan-driven records into the existing rpiv-todo overlay.
 * Numeric IDs are intentionally in a disjoint range from legacy Task IDs. The
 * durable IDs remain in each subject/metadata, so a display ID never becomes
 * an authority or a replacement for execution-store target validation. */
export function executionOverlayTodos(state: CoordinatorState): OverlayTodo[] {
 const todos: OverlayTodo[] = [];
 let next = 20_000;
 for (const manifest of state.manifests.filter(m => state.activeRevisions[m.id] === m.revision).sort((a, b) => a.id.localeCompare(b.id))) {
  const records = manifest.tasks.map(task => state.tasks.find(record => record.manifestId === manifest.id && record.taskId === task.id));
  const phases = records.map(record => record?.phase ?? "pending");
  const featureStatus = phases.length > 0 && phases.every(phase => phase === "succeeded") ? "completed" : phases.some(phase => ["preparing", "launching", "running", "stopping", "validating", "recovery-needed"].includes(phase)) ? "in_progress" : "pending";
  const featureId = next++;
  todos.push({ id: featureId, subject: `Execution Feature ${manifest.id}`, status: featureStatus, activeForm: featureStatus === "in_progress" ? "running plan-driven execution" : undefined, metadata: { kind: "execution-feature", taskId: manifest.id } });
  const taskIds = new Map<string, number>();
  for (const task of manifest.tasks) taskIds.set(task.id, next++);
  for (const task of manifest.tasks) {
   const record = state.tasks.find(item => item.manifestId === manifest.id && item.taskId === task.id);
   const phase = record?.phase ?? "pending";
   const status = phase === "succeeded" ? "completed" : ["preparing", "launching", "running", "stopping", "validating", "recovery-needed"].includes(phase) ? "in_progress" : "pending";
   const todo: OverlayTodo = { id: taskIds.get(task.id)!, subject: `Execution Task ${task.id} — ${task.text}`, status, metadata: { kind: "execution-task", taskId: task.id } };
   const blocked = task.dependencies.map(id => taskIds.get(id)).filter((id): id is number => id !== undefined);
   if (blocked.length) todo.blockedBy = blocked;
   if (status === "in_progress") todo.activeForm = `phase=${phase}`;
   todos.push(todo);
  }
  for (const group of manifest.deliveryGroups) {
   const delivery = state.deliveries.find(item => item.groupId === group.id);
   // Merge-dependent work completes only after a verified merge. `merged` is
   // the sole terminal success; `closed-unmerged` is terminal WITHOUT merge
   // evidence and must stay visibly unsuccessful (its phase remains in the
   // row subject). A `local` delivery that validated keeps its established
   // completion semantics without a merge.
   const status = delivery?.phase === "merged" || (group.policy === "local" && delivery?.phase === "ready") ? "completed" : ["integrating", "handoff-pending", "controller-owned"].includes(delivery?.phase ?? "") ? "in_progress" : "pending";
   const todo: OverlayTodo = { id: next++, subject: `Execution Delivery ${group.id} — ${delivery?.phase ?? "pending"}`, status, metadata: { kind: "execution-delivery", taskId: group.id } };
   if (status === "in_progress") todo.activeForm = delivery?.reason ? `blocked: ${delivery.reason}` : "reconciling delivery";
   todos.push(todo);
  }
 }
 return todos;
}
