# Incident: merged icemining-devops #552 remained waiting

## Evidence (2026-09-17)

- Local `icemining-devops origin/main` contains squash `4b92a2d`, PR #552.
- Live session `01a0abbc-160c-76b3-841a-a3ae429f91de`, PID 14644, held an observed #552 latch with `lastNext: yield` and cwd `~/Dev/git/wt/icemining-devops/e6-ansible-entrypoints`.
- That worktree no longer exists. Waiter pidfile held dead PID 86329. The manual waiter file retained an already-delivered `read_comments_and_fix` verdict (round 2/2), not a terminal outcome.
- Installed runtime: `hotfix/confused-live-runtime`, commit `5e53823`. Current upstream had the same path-resolution defect.
- Direct local calls using the incident cwd: installed `referenceCheckoutFor` and `spawnCwdFor` returned undefined; `resolveQueryCwd` returned the removed directory. Fixed calls all resolve `~/Dev/git/icemining-devops`.

## Root cause and boundary

The pi-orchestrate latch recovered only legacy `<repo>-wt/<branch>` paths. Migration to `wt/<repo>/<branch>` updated other path consumers but missed `referenceCheckoutFor`. After successful cleanup, the fallback terminal query repeatedly attempted to spawn in a nonexistent directory; its caught error became `unknown`, leaving the waiting UI running. The same helper also prevented a missing waiter from being restarted from a valid reference checkout.

This is a lifecycle integration bug, not evidence that the model ignored a delivered merge notification. An independently merged PR must be discoverable even if the last local waiter verdict was actionable and already delivered. No Rust review-decision change is needed: current gh-pr-reviewer already has current-layout daemon/monitor recovery coverage. This investigation does not establish which process performed the original merge or why the old waiter was not rearmed; neither is required to reproduce the stuck latch.

## Regression and blast radius

Three new tests failed before production edits: current-layout resolution, merged wake, closed wake. They pass after the helper fix. The integration tests reproduce ENOENT for missing cwd, retain a stale delivered verdict, and require exactly one terminal wake without a fixer.

Coverage includes removed and nested branch paths, per-project containers, missing references, unrelated repositories, live-worktree precedence, and rejection of mismatched origin for daemon spawning. Existing legacy/adoption/reload/ownership/terminal tests remain intact. Resolution walks path components only; it does not search directories or infer terminal state from deletion.

Validation:
- Latch suite: 129/129 pass.
- TypeScript typecheck: pass.
- Full check: 834/855 pass; 21 failures (19 execution-e2e, one live feature-state fixture, one inherited execution-worker environment assertion).
- Untouched HEAD exported to an isolated temporary baseline reproduces representatives of all three failure groups: AE1 worker launch timeout, `planning-blocked` on-disk phase fixture, and execution-worker assertion. The full suite is therefore not claimed green; all 19 E2E cases were not rerun individually on baseline.

## Deployment

Apply only this helper change to a fresh snapshot of the installed runtime; do not overwrite the dirty reference checkout or replace the installed snapshot with unrelated upstream changes. Existing pi processes must reload extensions to execute new TypeScript. Source deployment alone is not proof that an already-running session received its merge wake.
