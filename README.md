# pi-orchestrate

Pi extension for `/orchestrate`: Feature plan → Tasks (`tdd-worker`) → feature-qa → one Feature PR → `git pr-await` in code.

Source of truth for the files that currently live as loose auto-loads under `~/.pi/agent/extensions/` (`orchestrate.ts`, `pr-await-latch.ts`, `git-workflow-guard.ts`). Do not put a worktree lane next to those auto-loads.

## Layout

| Path | What |
| --- | --- |
| `src/orchestrate.ts` | `/orchestrate` command, Feature chain, fixer dispatch |
| `src/pr-await-latch.ts` | 0-token waiter latch; Feature-owned verdicts dispatch in code |
| `src/git-workflow-guard.ts` | Mechanical block of raw `git worktree` / `gh pr merge` / poll loops |
| `src/lib/` | Latch helpers, `ghl-pr-await` trampoline, guard classifiers |
| `test/` | Existing regression tests (copied from `~/.pi/agent/extensions/tests/`) |

## Usage

```bash
pi -e .                  # load all three extensions from package.json
npm test
```

Live Pi still auto-loads `~/.pi/agent/extensions/*.ts`. Point `-e` here when iterating; do not copy a lane into the auto-load directory.
