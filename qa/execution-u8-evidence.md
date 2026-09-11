# U8 retained evidence index

Evidence is retained under the named root below. The machine-readable index contains the complete PID, workspace, interval, state-count, combined-check, and artifact records; the five crash tests also retain full before/after coordinator snapshots.

- Root: `/Users/greg/Dev/git/pi-orchestrate-wt/feat-plan-driven-orchestration/qa/evidence/u8-run-001`
- Index: `/Users/greg/Dev/git/pi-orchestrate-wt/feat-plan-driven-orchestration/qa/evidence/u8-run-001/index.jsonl`
- Successful default E2E run: `run-6462-*` entries (16/16)
- Per-scenario records: `run-6462-1` AE1, `-2` AE2, `-3` AE3, `-4` AE4, `-5` AE5, `-6` same-PID reload, `-7` launch crash, `-8` accepted-before-ack crash, `-9` terminal-before-receipt crash, `-10` Git-mutation-before-receipt crash, `-11` controller-persistence-before-ack crash, `-12` malformed lifecycle, `-13` AE7, `-14` AE8, `-15` AE9. Each has `evidence-index.json`, `provider/children.jsonl`, and retained disposable `repo-wt/` workspaces.

## Five crash checkpoints

Each checkpoint file records the real owner PID and `lockExists`; each paired snapshot records the complete state and counts before and after restart.

| Boundary | Owner/child PID evidence | Before → after snapshot | Count/result proof |
|---|---|---|---|
| launch intent before RPC | `run-6462-7/provider/checkpoint-launch-intent-before-rpc.json` (owner PID 43248) | `snapshot-launch-intent-before-rpc-before.json` → `...-after.json` | `launching`, reservation 1, results 0 → `recovery-needed`, reservation 1, results 0; `rpc-events.jsonl` has one/no duplicate spawn |
| accepted launch before acknowledgement | `run-6462-8/provider/checkpoint-accepted-before-ack.json` (owner PID 43918, live child PID 44405) | `snapshot-accepted-before-ack-before.json` → `...-after.json` | `launching`, reservation 1, results 0 → `recovery-needed`, reservation 1, results 0; child is live at checkpoint and its late terminal event cannot create a receipt |
| terminal before receipt | `run-6462-9/provider/checkpoint-terminal-before-receipt.json` (owner PID 44647) | `snapshot-terminal-before-receipt-before.json` → `...-after.json` | `running`, reservation 1, results 0 → `succeeded`, reservation 0, results 1; `late-old-callback` is fenced |
| Git mutation before integration receipt | `run-6462-10/provider/checkpoint-git-mutation-before-integration-receipt.json` (owner PID 46082) | `snapshot-git-mutation-before-integration-receipt-before.json` → `...-after.json` | validating/no integration receipt → complete/one receipt; `git-commands.jsonl` shows cherry-pick count unchanged at 1 |
| controller persistence before local acknowledgement | `run-6462-11/provider/checkpoint-controller-persist-before-local-ack.json` (owner PID 49237) | `snapshot-controller-persist-before-local-ack-before.json` → `...-after.json` | handoff-pending/no local ack → controller-owned/one ack; `controller-state.json` has one request |

`run-6462-8/evidence-index.json` retains the accepted child PID and its interval. `run-6462-1/evidence-index.json` retains AE1's five distinct worker PIDs, canonical workspace paths, and overlapping start/end intervals. `run-6462-13/evidence-index.json` retains the independent combined-gate receipt and delivery states. `run-6462-15/evidence-index.json` retains the legacy review → TDD → TDD → QA intervals and ready delivery gate.

## Race diagnosis

The prior failure was real but was not a production composition fix: `/private/var/folders/d_/yhb_23jn541gkzgzcm__0pmc0000gn/T/execution-e2e-oYqdEi/provider/checkpoint-git-mutation-before-integration-receipt.json` recorded `lockExists:false`, while the retained replacement stderr and `state/.../transaction.lock` show that the test parent yielded after publishing the checkpoint and SIGKILL arrived after an unrelated scheduler transaction had opened the short lock. The supervisor directed preserving fail-closed abandoned-lock behavior and making the injected boundary exact. `crash-owner.mjs` now synchronously self-`SIGSTOP`s immediately after checkpoint publication; the parent verifies `ps` state `T` before `SIGKILL`. No production scheduler/lock change was made.

## Commands and result

- Candidate implementation commit: `6b4c150` (current starting HEAD was `4be68c1`)
- `rtk pnpm exec tsc --noEmit` — passed
- focused collector red-first run — failed before root-scope implementation; focused collector tests then passed (3/3)
- `rtk pnpm exec node --experimental-strip-types --test --test-name-pattern='AE9' test/execution-e2e.test.ts` — passed
- default E2E, repeated three times — passed 16/16 each
- `rtk pnpm run check` — passed 722/722
- live provider/network/publication verification — not run and unauthorized
