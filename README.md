# pi-orchestrate

Pi extension for `/orchestrate`: Feature plan → Tasks (`tdd-worker`) → feature-qa → one Feature PR → `git pr-await` in code.

Source of truth for the files that currently live as loose auto-loads under `~/.pi/agent/extensions/` (`orchestrate.ts`, `pr-await-latch.ts`, `git-workflow-guard.ts`). Do not put a worktree lane next to those auto-loads.

## Layout

| Path | What |
| --- | --- |
| `src/orchestrate.ts` | `/orchestrate` command, Feature chain, fixer dispatch |
| `src/pr-await-latch.ts` | 0-token waiter latch; Feature-owned verdicts dispatch in code |
| `src/git-workflow-guard.ts` | Mechanical block of raw `git worktree` / `gh pr merge` / poll loops |
| `src/lib/` | Latch helpers, `ghl-pr-await` trampoline, execution coordinator, guard classifiers |
| `test/` | Existing regression tests (copied from `~/.pi/agent/extensions/tests/`) |

## Usage

```bash
pi -e .                  # load all three extensions from package.json
npm test
```

Live Pi still auto-loads `~/.pi/agent/extensions/*.ts`. Point `-e` here when iterating; do not copy a lane into the auto-load directory.

## Plan-driven execution

Use `/orchestrate run "path/to/plan.md"` to snapshot and interpret an ordinary Markdown plan. The command shows the complete feature/task/dependency/profile/delivery interpretation plus its immutable approval token, repository capacity boundary, and publication boundary, then requires explicit approval; plan text never grants execution or publication. Durable records use the versioned execution engine and are independent of legacy Feature records.

The selectable legacy preset is configured with `executionPreset: "legacy"` in `src/orchestrate.json`. It compiles only a newly approved run into the sequential worker/reviewer/QA shape; it does not migrate or rewrite existing legacy Feature records. Restore `"plan-driven"` for ordinary Markdown interpretation. Repository capacity is shared and is never silently replaced by a plan's requested shape; capacity changes must be separately authorized.

Plan-driven PR delivery reuses the existing `pr-await-latch` controller. An exact live Feature owner/PR/generation and validated delivery workspace are required; missing or ambiguous mappings remain fenced rather than creating a second controller or guessed PR.

Use targeted controls without a global current-Feature pointer:

```text
/orchestrate execution status
/orchestrate execution pause <task-id>
/orchestrate execution resume <task-id>
/orchestrate execution retry <task-id>
```
