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

Use `/orchestrate run "path/to/plan.md"` to snapshot and interpret an ordinary Markdown plan. The command shows the manifest digest, revision, capacity, and publication boundary, then requires an explicit approval; plan text never grants execution or publication. Durable records use the versioned execution engine and are independent of legacy Feature records.

Use targeted controls without a global current-Feature pointer:

```text
/orchestrate execution status
/orchestrate execution pause <task-id>
/orchestrate execution resume <task-id>
/orchestrate execution retry <task-id>
```
