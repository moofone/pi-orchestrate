# Compatible live-runtime hotfix for PR533's confused-state stall

2026-09-15. Operator selected **Isolated live hotfix** after being told that the upstream patch could not replace the dirty live package safely.

## Preservation

- Source: `/Users/greg/Dev/git/pi-orchestrate`, canonical checkout left unchanged.
- Destination: `/Users/greg/Dev/git/wt/pi-orchestrate/hotfix-confused-live-runtime`.
- Intentionally retained base `a62dda7` (70 commits behind fetched origin/main); no upstream architecture upgrade in this runtime.
- Snapshot commit `c7fa06e` preserves all 35 non-ignored source files, including existing uncommitted changes. `qa/CONFUSED_LIVE_SNAPSHOT.json` records their SHA-256 hashes. All source hashes were rechecked before rollout and matched.
- Validation uses the same existing dependencies through an ignored `node_modules` symlink. It does not install/update packages or mutate canonical dependencies.

## Minimal runtime changes

1. Capture documented `rtk git -C <worktree> pr-await <N>` calls and retain their worktree.
2. Extract actual Pi text result blocks so escaped JSON newlines cannot hide `next=yield`.
3. On explicit successful same-PR re-handoff, clear the prior attempt's actionable suppression; ordinary clock-only updates still deduplicate.
4. Deliver an actionable wake before marking the waiter verdict delivered. Failed submission retains it for retry; concurrent wake submissions are bounded per slot. A late wake cannot acknowledge a different handoff generation.
5. Say `reviewer failed — recovery required`, not `waiting for reviewers`, for `investigate_dead_reviewers`.
6. Direct recovery to investigate the failed reviewer, not blindly restart the waiter or post another retry comment.

Existing session-slot isolation, Feature ownership, waiter handoff, and terminal-delivery behavior are preserved. No production/deployment authority is added. The underlying reason Grok's reviewer worker failed is not diagnosed or claimed fixed by this latch patch.

## TDD and acceptance

Before implementation, four PR533-specific tests failed: missing -C parsing, misleading recovery directive, misleading waiting chrome, and rejected-wake handling. They now pass, including first confused wake → same-head retry → repeated confused wake, with no clock-update wake storm.

Final exact-runtime acceptance:

- `npm run typecheck`: pass.
- `npm test`: **470 tests passed, 0 failed, 0 skipped**.
- `git diff --check`: pass.
- Full suite includes production-style isolated-jiti extension loading and two review/fix rounds.

One pre-existing test assertion was corrected to accept either `<PR>` or the current documented `<N>` placeholder while still requiring `git pr-await` **once**. No policy, skill, live fixture, or test was disabled.

Logs: `/tmp/confused-live-red.log`, `/tmp/confused-live-final.log`.

## Controlled activation

Global settings backup before changing the single package path:

`/Users/greg/.pi/agent/backups/settings.before-confused-hotfix.20260915T103113Z.json`

Backup SHA-256: `0b1fbff75851a7d7ef93ef3b5af12077bd810bce8105959384c43470aafaf158`.

Replace only `../../Dev/git/pi-orchestrate` in `~/.pi/agent/settings.json` with the destination above. Compare parsed settings against the backup to prove that only this package entry changed. No project override was found in the stalled session's cwd.

The package-path change affects new sessions and the next resource reload; **it does not rewrite code already loaded in a running Pi process**. In the stalled PR533 tab, run `/reload` once. Same-session reload should see the undelivered reviewer-failure verdict and wake recovery. Do not create another waiter or retry comment as the reload procedure. Live activation is not verified until that session reloads and emits the recovery wake/new failure label.

Rollback: change only that package entry back to the original canonical path and reload the intended session. Do not overwrite the entire settings file from backup; other sessions may change unrelated preferences after this snapshot. Preserve all PR/waiter state and both worktrees.

## Alerting plan

The separate plan is in the upstream-based worktree:

`/Users/greg/Dev/git/wt/pi-orchestrate/fix-confused-reviewer-rearm/docs/plans/2026-09-15-confused-reviewer-alerting.md`

Recommendation: native Mac notification plus a private Telegram bot chat for free iPhone pushes. Detection/outbox independent of the model/latch, bounded reminders, acknowledgement distinct from resolution, redacted payloads, and real Mac/iPhone acceptance tests. No alert channel has been installed or enrolled yet.
