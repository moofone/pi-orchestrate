/**
 * Plan.md Task parsing and mutation, extracted verbatim from orchestrate.ts.
 *
 * The Task seam is the parser that decides what a Task *is*: `### Task N`
 * headings separated from prose by an em dash, colon, or hyphen, the
 * `- Status:` / `- Complexity:` / `- Command:` scalars under each one, and
 * the plan-header (`> Status:`, `> Repo:`) readers the gates share.
 *
 * Move discipline: bodies are byte-equal to their orchestrate originals.
 * The invariants live in test/orchestrate.test.ts (T1, L1/L2) and
 * test/plan-tasks.test.ts; this module never imports orchestrate.ts.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Task {
  id: string;
  title: string;
  status: string;
  /** Planner/parent judgment. Most Tasks are simple. critical = extra risk. */
  complexity?: "simple" | "critical";
}

export const PENDING_TOKEN = /^(?:pending|none|tbd|todo|)$/i;

export function isPendingToken(value: string): boolean {
  return PENDING_TOKEN.test(value.trim());
}

export function planHeaderField(plan: string, name: string): string {
  const re = new RegExp(`^>\\s*${name}:\\s*(.+)$`, "im");
  return (plan.match(re)?.[1] ?? "").trim();
}

export function planHeaderStatus(plan: string): string {
  return planHeaderField(plan, "Status");
}

export function featureTitle(plan: string, fallback: string): string {
  const labeled = plan.match(/^#\s+(?:Feature|Plan):\s*(.+)$/m);
  if (labeled?.[1]) return labeled[1].trim();
  const bare = plan.match(/^#\s+(?!#{1,}|Status\b)(.+)$/m);
  return (bare?.[1] ?? fallback).trim();
}

export function isApproved(plan: string): boolean {
  const s = planHeaderStatus(plan).toLowerCase();
  return s.startsWith("approved") || s.includes("approved");
}

export function isDraft(plan: string): boolean {
  const s = planHeaderStatus(plan).toLowerCase();
  return !s || s.startsWith("draft") || s.includes("awaiting");
}

/**
 * Separator after `Task N`. The planner template uses an em dash; models
 * often write a colon (`### Task 1: title`). Hyphen, en dash, and a trailing
 * period are the other forms that have shown up. A numbered list under
 * `## Tasks` is still not a heading.
 */
export const TASK_SEP = "[—–:.-]";

export function parseTasks(plan: string): Task[] {
  const tasks: Task[] = [];
  const header = new RegExp(
    `^###\\s+(?:Task|Slice)\\s+(\\d+)\\s*${TASK_SEP}\\s*(.+)$`,
    "gim",
  );
  const headers: Array<{ id: string; title: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = header.exec(plan))) {
    headers.push({ id: match[1] ?? "", title: (match[2] ?? "").trim(), index: match.index });
  }
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    if (!header) continue;
    const start = header.index;
    const end = headers[i + 1]?.index ?? plan.length;
    const body = plan.slice(start, end);
    const st = body.match(/-\s*Status:\s*(\w+)/i);
    const cx = body.match(/-\s*Complexity:\s*(simple|critical|complex)\b/i);
    const rawCx = cx?.[1]?.toLowerCase();
    tasks.push({
      id: header.id,
      title: header.title,
      status: (st?.[1] ?? "pending").toLowerCase(),
      complexity:
        rawCx === "critical" || rawCx === "complex"
          ? "critical"
          : rawCx === "simple"
            ? "simple"
            : undefined,
    });
  }
  return tasks;
}

export function setTaskStatusInPlan(plan: string, id: string, status: string): string {
  const header = new RegExp(
    `(###\\s+(?:Task|Slice)\\s+${id}\\s*${TASK_SEP}[\\s\\S]*?-\\s*Status:\\s*)(\\w+)`,
    "i",
  );
  if (!header.test(plan)) return plan;
  return plan.replace(header, `$1${status}`);
}

/**
 * A spawn that dies before the worker starts (model parked, RPC fail) still
 * writes Status: blocked and no handoff. `/orchestrate resume` then hits the
 * blocked guard and refuses forever. No handoff = it never ran — reopen.
 */
export function reopenTasksThatNeverStarted(plan: string, handoffsDir: string): string {
  let next = plan;
  for (const task of parseTasks(plan)) {
    if (task.status !== "blocked") continue;
    if (existsSync(join(handoffsDir, `task-${task.id}.md`))) continue;
    next = setTaskStatusInPlan(next, task.id, "pending");
  }
  return next;
}

export const MAX_TASKS = 12;

export function taskCountError(n: number): string | undefined {
  if (n > MAX_TASKS) return `Plan has ${n} Tasks; cap is ${MAX_TASKS}. Split the Feature.`;
  return undefined;
}

/** The `### Task N — …` (or `### Task N: …`) block, verbatim, as the child's contract. */
export function taskSection(plan: string, id: string): string {
  const start = plan.search(
    new RegExp(`^###\\s+(?:Task|Slice)\\s+${id}\\s*${TASK_SEP}`, "im"),
  );
  if (start < 0) return "";
  const rest = plan.slice(start);
  // Search from the end of this Task's own header line: trimming a single
  // character instead would turn `### Task N` into `## Task N` and match the
  // H2 alternative immediately.
  const headerEnd = rest.indexOf("\n");
  if (headerEnd < 0) return rest.trimEnd();
  // Stop at the next Task *or* the next H2 — the last Task is followed by
  // `## Design Decisions` / `## Out of Scope`, which are not its contract.
  const next = rest
    .slice(headerEnd)
    .search(
      new RegExp(
        `^(?:###\\s+(?:Task|Slice)\\s+\\d+\\s*${TASK_SEP}|##\\s+(?!#))`,
        "im",
      ),
    );
  return (next < 0 ? rest : rest.slice(0, headerEnd + next)).trimEnd();
}

/**
 * A Task's own `- Command:` is its red/green command. It is handed to
 * pi-subagents as a runtime acceptance check, which runs it on the host under
 * `/bin/sh -c` and records the result as evidence, so green becomes a verified
 * fact instead of the worker's claim about itself.
 *
 * Planners write this field as prose at least as often as they write a command
 * ("red public curls first. Then:", "standalone gtest PearlGpuHotPath.* …").
 * Prose reaching the host fails the Task even when the work was correct, and
 * prose containing backticks is worse: the shell runs those spans as command
 * substitution. So only a value that is *entirely* one fenced code span counts
 * as a gate; everything else falls back to evidence-based acceptance.
 */
export const GATE_NOT_A_COMMAND = /[…]|\.\.\.|\*\*|^[([]|^[.…]+$/;

export function taskGateCommand(body: string): string {
  const line = body.match(/^-\s*Command:[ \t]*(.*)$/im);
  if (!line) return "";
  const raw = (line[1] ?? "").trim();
  let cmd = "";
  if (raw && !isPendingToken(raw)) {
    cmd = raw.match(/^(`+)([^`]+)\1$/)?.[2]?.trim() ?? "";
  } else {
    // Planner template: `- Command:` then a fenced block. Missing that skipped
    // the host gate and injected "Write your findings" — Luna then reread + git status.
    const after = body.slice((line.index ?? 0) + line[0].length);
    cmd = (after.match(/^\s*```[^\n]*\n([\s\S]*?)\n```/)?.[1] ?? "").trim().replace(/\n+/g, " ");
  }
  if (!cmd || cmd.includes("`")) return "";
  if (GATE_NOT_A_COMMAND.test(cmd)) return "";
  if (!/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*[A-Za-z0-9_./-]+(?:\s|$)/.test(cmd)) return "";
  return cmd;
}

/** Plan header `> Repo: coins-minimal` — not the orchestrator folder name. */
export function planRepoName(plan: string): string {
  return (plan.match(/^>\s*Repo:\s*([A-Za-z0-9._-]+)\s*$/m)?.[1] ?? "").trim();
}

export function setTaskHandoffInPlan(plan: string, id: string, handoff: string): string {
  const re = new RegExp(
    `(###\\s+(?:Task|Slice)\\s+${id}\\s*${TASK_SEP}[\\s\\S]*?-\\s*Handoff:\\s*).*$`,
    "im",
  );
  if (!re.test(plan)) return plan;
  return plan.replace(re, `$1${handoff}`);
}
