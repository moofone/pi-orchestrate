/**
 * The deterministic rpiv-todo mapper, extracted verbatim from orchestrate.ts.
 *
 * plan.md + status.md in, todo-board rows out: the reserved pipeline prefix
 * (planner 1001, plan-reviewer 1002), then Task N at id N, then the owed
 * feature-qa passes at maxTask+i. The same plan and status always project the
 * same snapshot — no clocks, no prompts. The sink binding that publishes it
 * (rpiv-todo store, extension events) stays in orchestrate.ts because it
 * needs the extension API; this module never imports orchestrate.ts.
 *
 * Move discipline: bodies are byte-equal to their orchestrate originals.
 * The invariants live in test/orchestrate.test.ts (overlay region) and
 * test/overlay.test.ts.
 */

import { statusField } from "./feature-state.ts";
import { planReviewState, qaPassState, type PlanReviewState } from "./lifecycle.ts";
import {
  isApproved,
  isPendingToken,
  parseTasks,
  planHeaderField,
  type Task,
} from "./plan-tasks.ts";

export type OverlayTodoStatus = "pending" | "in_progress" | "completed";
export type OverlayTodoKind = "planner" | "plan-reviewer" | "approve" | "task" | "qa";

/** Reserved overlay ids so Task N keeps id N. */
export const OVERLAY_PLANNER_ID = 1001;
export const OVERLAY_REVIEWER_ID = 1002;
export const OVERLAY_APPROVE_ID = 1003;

export interface OverlayTodo {
  id: number;
  subject: string;
  status: OverlayTodoStatus;
  activeForm?: string;
  blockedBy?: number[];
  metadata?: { kind: OverlayTodoKind; taskId?: string; qaPass?: number };
}

export interface OverlayTodoState {
  tasks: OverlayTodo[];
  nextId: number;
}

function planStatusToOverlay(status: string): OverlayTodoStatus {
  if (status === "done") return "completed";
  if (status === "in_progress") return "in_progress";
  return "pending";
}

function plannerOverlayStatus(
  plan: string,
  status: string,
  tasks: Task[],
  review: PlanReviewState,
  phase: string,
): OverlayTodoStatus {
  if (review !== "none") return "completed";
  if (
    phase === "reviewing" ||
    phase === "implementing" ||
    phase === "feature-qa" ||
    phase === "pr" ||
    phase === "blocked" ||
    phase === "paused"
  ) {
    return "completed";
  }
  if (isApproved(plan)) return "completed";
  if (tasks.length > 0) return "completed";
  const name = planHeaderField(plan, "Name") || statusField(status, "name");
  if (!isPendingToken(name)) return "completed";
  if (phase === "planning" || phase === "") return "in_progress";
  return "pending";
}

function reviewerOverlayStatus(
  plan: string,
  tasks: Task[],
  review: PlanReviewState,
  phase: string,
): OverlayTodoStatus {
  if (review === "done") return "completed";
  if (review === "running") return "in_progress";
  if (review === "failed") return "pending";
  if (phase === "reviewing") return "in_progress";
  if (isApproved(plan)) return "completed";
  if (
    phase === "implementing" ||
    phase === "feature-qa" ||
    phase === "pr" ||
    phase === "blocked" ||
    phase === "paused"
  ) {
    return "completed";
  }
  if (tasks.some((t) => t.status === "done" || t.status === "in_progress")) return "completed";
  return "pending";
}

function approveOverlayStatus(
  plan: string,
  tasks: Task[],
  review: PlanReviewState,
  phase: string,
): OverlayTodoStatus {
  if (isApproved(plan)) return "completed";
  if (
    phase === "implementing" ||
    phase === "feature-qa" ||
    phase === "pr" ||
    phase === "blocked" ||
    phase === "paused" ||
    phase === "done"
  ) {
    return "completed";
  }
  if (tasks.some((t) => t.status === "done" || t.status === "in_progress")) return "completed";
  if (review === "done") return "in_progress";
  return "pending";
}

/**
 * Deterministic rpiv-todo snapshot from plan.md + status.md.
 * Pipeline prefix: planner (1001), plan-reviewer (1002), approve (1003).
 * Task N keeps id N; feature-qa pass i is max(task id)+i. No clocks, no prompts.
 */
export function overlayTodosFromFeature(plan: string, status: string): OverlayTodo[] {
  const todos: OverlayTodo[] = [];
  const used = new Set<number>();
  const phase = statusField(status, "phase").toLowerCase();
  const review = planReviewState(status);
  const tasks = parseTasks(plan);
  const hasFeature = plan.trim().length > 0;

  if (hasFeature) {
    const plannerStatus = plannerOverlayStatus(plan, status, tasks, review, phase);
    const planner: OverlayTodo = {
      id: OVERLAY_PLANNER_ID,
      subject: "Planner",
      status: plannerStatus,
      metadata: { kind: "planner" },
    };
    if (plannerStatus === "in_progress") planner.activeForm = "writing Feature plan";
    todos.push(planner);
    used.add(OVERLAY_PLANNER_ID);

    const reviewerStatus = reviewerOverlayStatus(plan, tasks, review, phase);
    const reviewer: OverlayTodo = {
      id: OVERLAY_REVIEWER_ID,
      subject: "Plan reviewer",
      status: reviewerStatus,
      blockedBy: [OVERLAY_PLANNER_ID],
      metadata: { kind: "plan-reviewer" },
    };
    if (reviewerStatus === "in_progress") reviewer.activeForm = "reviewing Feature plan";
    todos.push(reviewer);
    used.add(OVERLAY_REVIEWER_ID);

    const approveStatus = approveOverlayStatus(plan, tasks, review, phase);
    const approve: OverlayTodo = {
      id: OVERLAY_APPROVE_ID,
      subject: "Approve",
      status: approveStatus,
      blockedBy: [OVERLAY_REVIEWER_ID],
      metadata: { kind: "approve" },
    };
    if (approveStatus === "in_progress") approve.activeForm = "waiting for /orchestrate approve";
    todos.push(approve);
    used.add(OVERLAY_APPROVE_ID);
  }

  let prevId: number | undefined = hasFeature ? OVERLAY_APPROVE_ID : undefined;
  let anyTaskInProgress = false;
  const showWork =
    review === "done" ||
    isApproved(plan) ||
    phase === "implementing" ||
    phase === "feature-qa" ||
    phase === "pr" ||
    phase === "blocked" ||
    phase === "paused" ||
    phase === "done" ||
    tasks.some((t) => t.status === "done" || t.status === "in_progress");
  if (!showWork) return todos;

  for (const task of tasks) {
    const id = Number.parseInt(task.id, 10);
    if (!Number.isInteger(id) || id < 1 || used.has(id)) continue;
    used.add(id);
    const overlayStatus = planStatusToOverlay(task.status);
    if (overlayStatus === "in_progress") anyTaskInProgress = true;
    const todo: OverlayTodo = {
      id,
      subject: `Task ${task.id} — ${task.title}`,
      status: overlayStatus,
      metadata: { kind: "task", taskId: task.id },
    };
    if (overlayStatus === "in_progress") todo.activeForm = `implementing Task ${task.id}`;
    if (prevId !== undefined) todo.blockedBy = [prevId];
    todos.push(todo);
    prevId = id;
  }

  const { pass, cap } = qaPassState(status);
  const maxTaskId = tasks.reduce((max, task) => {
    const id = Number.parseInt(task.id, 10);
    return Number.isInteger(id) && id > max ? id : max;
  }, 0);
  let qaPrev = prevId;
  for (let i = 1; i <= cap; i++) {
    const id = maxTaskId + i;
    if (used.has(id)) continue;
    used.add(id);
    let overlayStatus: OverlayTodoStatus = "pending";
    if (pass >= i) overlayStatus = "completed";
    else if (!anyTaskInProgress && phase === "feature-qa" && pass + 1 === i) {
      overlayStatus = "in_progress";
    }
    const label = cap === 1 ? "feature-qa" : `feature-qa ${i}/${cap}`;
    const todo: OverlayTodo = {
      id,
      subject: label,
      status: overlayStatus,
      metadata: { kind: "qa", qaPass: i },
    };
    if (overlayStatus === "in_progress") {
      todo.activeForm = cap === 1 ? "running feature-qa" : `running feature-qa ${i}/${cap}`;
    }
    if (qaPrev !== undefined) todo.blockedBy = [qaPrev];
    todos.push(todo);
    qaPrev = id;
  }
  return todos;
}

export function projectOverlayTodos(plan: string, status: string): OverlayTodoState {
  const tasks = overlayTodosFromFeature(plan, status);
  const maxId = tasks.reduce((max, todo) => Math.max(max, todo.id), 0);
  return { tasks, nextId: maxId + 1 };
}
