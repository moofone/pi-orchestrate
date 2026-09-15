# pi-orchestrate

Pi extension for `/orchestrate`: Feature plan → Tasks (`tdd-worker`) → feature-qa → one Feature PR → `git pr-await` in code.

Source of truth for the files that currently live as loose auto-loads under `~/.pi/agent/extensions/` (`orchestrate.ts`, `pr-await-latch.ts`, `git-workflow-guard.ts`). Do not put a worktree lane next to those auto-loads.

## Layout

| Path | What |
| --- | --- |
| `src/orchestrate.ts` | `/orchestrate` command, Feature chain, fixer dispatch |
| `src/pr-await-latch.ts` | 0-token waiter latch; Feature-owned verdicts dispatch in code |
| `src/git-workflow-guard.ts` | Mechanical block of raw `git worktree` / `gh pr merge` / poll loops |
| `src/lib/` | Latch helpers, detached `ghl-pr-await` starter, guard classifiers |
| `test/` | Existing regression tests (copied from `~/.pi/agent/extensions/tests/`) |

## Usage

```bash
pi -e .                  # load all three extensions from package.json
npm test
```

Live Pi still auto-loads `~/.pi/agent/extensions/*.ts`. Point `-e` here when iterating; do not copy a lane into the auto-load directory.

PR wait status shows `reviewers 1/2`: one of two observed reviewers has reviewed the current commit. These counts come from the waiter's legacy `round` / `round_total` fields; they are not review/fix cycle numbers or GitHub conversation counts. Reviewer progress starts over for each new commit.


## Planning and worker contracts

The planner records the fetched remote default-branch commit and reads tracked files at that commit with `git show`. The reviewer uses the actual feature worktree, created through `git wt` before the approval card. Host-only Features receive a local snapshot commit. Product implementation still starts only after approval.

Plans use the fewest coherent tasks required by the remaining delta. Existing correct behavior is recorded explicitly; several acceptance scenarios can share one worker. `Kind: implement` requires a meaningful behavioral RED; `Kind: verify` permits regression coverage that is already green.

Each task contains `Files` (JSON list of repository-relative source, test, fixture, config, lockfile and instruction inputs), `Depends on` (earlier task IDs), `Starting state`, symbol-level reads, ordered implementation steps, and executable `Checks`. A successful reviewer completion must also declare `Readiness: ready`; malformed checks, unresolved decisions, source changes during review, or changed completed-task identities prevent readiness. The reviewer records `plan-baseline.json` with the exact review commit, task recipes, worktree paths and input hashes. Before dispatch, a changed recipe, worktree, or listed input returns to the reviewer. Declared dependency edits update only the overlapping declared inputs; unrelated changes do not invalidate a task. This relies on the reviewer listing the relevant inputs completely.

Workers receive only their inline task and a bounded previous-task handoff. Code saves their final handoff; workers do not reopen the full plan. A `Needs plan refresh:` handoff returns to the stronger reviewer, with at most two automatic reconciliations per task. Existing plans without a recorded baseline go through review before the next worker. Completed task identities and statuses must survive review.

Every required check belongs in the task's fenced JSON array:

````markdown
- Checks:
```json
[
  {
    "id": "older-index",
    "cwd": "apps/workers/auth",
    "argv": ["pnpm", "exec", "vitest", "run", "test/projection_apply_gate.test.ts", "-t", "an_older_index_within_one_fence_is_refused_with_the_stored_pair"],
    "runner": "vitest",
    "tests": ["an_older_index_within_one_fence_is_refused_with_the_stored_pair"],
    "minTests": 1,
    "maxTests": 1
  },
  {
    "id": "gate-regressions",
    "cwd": "apps/workers/auth",
    "argv": ["pnpm", "exec", "vitest", "run", "test/projection_apply_gate.test.ts"],
    "runner": "vitest",
    "minTests": 1
  }
]
```
````

`cwd` is relative to the task worktree; `argv` preserves argument boundaries and contains no shell pipeline. Supported test runners are Vitest (a fresh JSON report), Node (TAP), and Cargo (normal test output). Test checks require a positive `minTests`; named selections also require `maxTests` and passed test names. This rejects empty/skipped selections and accidental full-suite runs. Do not add reporter flags: the host supplies them for Vitest and Node. Other commands use `runner: "command"` and an explicit `reason`, with exit status as their gate. `Acceptance` explains these checks; it is not a second list of unexecuted commands. Legacy `Command` parsing remains for compatibility, but new/reconciled tasks require structured Checks.

The planning role templates in `agents/` are also installed under `~/.pi/agent/agents/`. Update both when changing their contracts. Reload Pi to load extension changes; already-running children keep their launch contracts.
