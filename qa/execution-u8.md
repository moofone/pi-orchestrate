# U8 execution acceptance recipe

Run from the Feature worktree. This recipe uses only disposable local Git fixtures and the installed `ghl-wt` helper; it does not contact a provider, publish, push, or create a PR.

```sh
cd /Users/greg/Dev/git/pi-orchestrate-wt/feat-plan-driven-orchestration
export U8_EVIDENCE_ROOT="$PWD/qa/evidence/u8-run-001"
rtk pnpm exec tsc --noEmit
rtk pnpm exec node --experimental-strip-types --test test/task-workspaces.test.ts
for n in 1 2 3; do
  rtk pnpm exec node --experimental-strip-types --test test/execution-e2e.test.ts
 done
rtk pnpm run check
```

The E2E command must report `19/19` three times. `pnpm run check` must report `725/725` (including the E2E file). Do not add `--test-concurrency=1`; the default E2E run is the race gate.

`U8_EVIDENCE_ROOT` makes every disposable repository, workspace, provider run, PID/interval log, state snapshot, and failure artifact named and retained. New gate artifacts include AE5 before/proposed/after manifest provenance and approval evidence (including the already-approved explicit empty-dependency baseline), AE6 old-instance reply and controller restart ledgers, AE7 controller lifecycle, AE8 timestamped pre-pause/B-only-release state and receipt evidence, and AE8 duplicate/reordered notification ledgers. The collector tests cover legacy `scope: ["."]`, exact-file and trailing-directory scopes, and absolute/traversal/out-of-scope/foreign evidence. AE9 runs the real selectable legacy preset through review → TDD → QA → delivery.

If a run fails, preserve the evidence root and inspect `index.jsonl`, each run's `evidence-index.json`, `provider/children.jsonl`, `provider/rpc-events.jsonl`, `provider/git-commands.jsonl`, and `state/`. Never clean the fixture directories while diagnosing a failure.
