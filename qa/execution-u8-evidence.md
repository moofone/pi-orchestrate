# U8 retained evidence index

Evidence is retained under the named root below. The machine-readable index contains the complete PID, workspace, interval, state-count, combined-check, and artifact records; the five crash tests also retain full before/after coordinator snapshots. The new gate records use append-only `controller-calls.jsonl` and `git-mutations.jsonl` ledgers, compared by exact entries rather than overwritten JSON requestId counts.

- Root: `/Users/greg/Dev/git/pi-orchestrate-wt/feat-plan-driven-orchestration/qa/evidence/u8-run-001`
- Index: `/Users/greg/Dev/git/pi-orchestrate-wt/feat-plan-driven-orchestration/qa/evidence/u8-run-001/index.jsonl`
- Successful default E2E run: `run-80569-*` entries (19/19); three default runs are required by `qa/execution-u8.md`.
- Per-scenario records for the retained gate-closing run: `run-80569-1` AE1, `-2` AE2, `-3` AE3, `-4` AE4, `-5` AE5 in-scope/dependency revision, `-6` AE5 separate new-feature approval, `-7` same-PID reload, `-8` same-PID pending old-instance reply, `-9` launch crash, `-10` accepted-before-ack crash, `-11` terminal-before-receipt crash, `-12` Git-mutation-before-receipt crash, `-13` controller-persistence-before-ack crash, `-14` malformed lifecycle, `-15` AE7 controller lifecycle, `-16` public pause-A, `-17` AE8 duplicate/reordered notification ledgers, `-18` AE9. Each has `evidence-index.json`, `provider/children.jsonl`, and retained disposable `repo-wt/` workspaces.

## Five crash checkpoints

Each checkpoint file records the real owner PID and `lockExists`; each paired snapshot records the complete state and counts before and after restart.

| Boundary | Owner/child PID evidence | Before → after snapshot | Count/result proof |
|---|---|---|---|
| launch intent before RPC | `run-80569-9/provider/checkpoint-launch-intent-before-rpc.json` (owner PID 22131) | `snapshot-launch-intent-before-rpc-before.json` → `...-after.json` | `launching`, reservation 1, results 0 → `recovery-needed`, reservation 1, results 0; `rpc-events.jsonl` has one/no duplicate spawn |
| accepted launch before acknowledgement | `run-80569-10/provider/checkpoint-accepted-before-ack.json` (owner PID 22820, live child PID 23310) | `snapshot-accepted-before-ack-before.json` → `...-after.json` | `launching`, reservation 1, results 0 → `recovery-needed`, reservation 1, results 0; child is live at checkpoint and its late terminal event cannot create a receipt |
| terminal before receipt | `run-80569-11/provider/checkpoint-terminal-before-receipt.json` (owner PID 23552) | `snapshot-terminal-before-receipt-before.json` → `...-after.json` | `running`, reservation 1, results 0 → `succeeded`, reservation 0, results 1; `late-old-callback` is fenced |
| Git mutation before integration receipt | `run-80569-12/provider/checkpoint-git-mutation-before-integration-receipt.json` (owner PID 24990) | `snapshot-git-mutation-before-integration-receipt-before.json` → `...-after.json` | validating/no integration receipt → complete/one receipt; append-only `git-mutations.jsonl` and `git-commands.jsonl` show cherry-pick count unchanged at 1 |
| controller persistence before local acknowledgement | `run-80569-13/provider/checkpoint-controller-persist-before-local-ack.json` (owner PID 28160) | `snapshot-controller-persist-before-local-ack-before.json` → `...-after.json` | handoff-pending/no local ack → controller-owned/one ack; `controller-calls.jsonl` has exactly 1 call, `git-mutations.jsonl` has exactly 3 entries, and `controller-state.json` retains one exact delivery HEAD |

`run-80569-10/evidence-index.json` retains the accepted child PID and its interval. `run-80569-1/evidence-index.json` retains AE1's five distinct worker PIDs, canonical workspace paths, and overlapping start/end intervals. `run-80569-15/evidence-index.json` retains AE7's blocked-A and controller B lifecycle. `run-80569-18/evidence-index.json` retains the legacy review → TDD → TDD → QA intervals and ready delivery gate.

## Five residual U8 gate artifacts

| Gate | Retained artifact | Concrete assertion |
|---|---|---|
| AE5 in-scope + explicit dependency | `run-84445-5/provider/gate-ae5-in-scope-and-explicit.json` | persisted approved revisions 1 and 2 prove beta has explicit empty dependencies before proposed revision 3; revision 3 changes beta to `[alpha]`, remains approval-fenced, and records before/proposed/after manifest provenance and authorization digests; discovered `feature-a`/`src/` task has 1 receipt while alpha stays gated |
| AE5 new feature approval | `run-80569-6/provider/gate-ae5-new-feature.json` | feature-c revision 2 has 0 pre-approval starts and 1 post-approval start while alpha remains running/gated |
| AE6 same-PID stale reply | `run-80569-8/provider/gate-ae6-old-instance-reply.json`, `pending-old-reply.json`, `released-old-reply.json` | old request is released after replacement owner; receipts remain `[]`, reservation identity/count is unchanged, and old authority is rejected |
| AE7 controller lifecycle + AE8 public pause | `run-80569-15/provider/gate-ae7-controller-lifecycle.json`; `run-84445-16/provider/gate-ae8-public-pause.json` | A is `blocked` while B traverses `handoff-pending` → `controller-owned` → `merged`; public pause records timestamped pre-pause B `running` with zero receipts, A `running` with `pause`, then B-only release/success with one receipt while A remains `running`/`pause` before A resumes |
| AE8/controller replay mutation fences | `run-80569-13/provider/gate-ae6-controller-ledgers.json`; `run-80569-17/provider/gate-ae8-ledgers.json` | controller restart: 1 call/3 Git mutations and exact HEAD unchanged; AE8 duplicate/reordered notifications: 1 call/13 Git mutations and exact HEAD unchanged |


## Race diagnosis

The prior failure was real but was not a production composition fix: `/private/var/folders/d_/yhb_23jn541gkzgzcm__0pmc0000gn/T/execution-e2e-oYqdEi/provider/checkpoint-git-mutation-before-integration-receipt.json` recorded `lockExists:false`, while the retained replacement stderr and `state/.../transaction.lock` show that the test parent yielded after publishing the checkpoint and SIGKILL arrived after an unrelated scheduler transaction had opened the short lock. The supervisor directed preserving fail-closed abandoned-lock behavior and making the injected boundary exact. `crash-owner.mjs` now synchronously self-`SIGSTOP`s immediately after checkpoint publication; the parent verifies `ps` state `T` before `SIGKILL`. No production scheduler/lock change was made.

## Commands and result

- Candidate implementation commit: `6b4c150` (current starting HEAD was `4be68c1`)
- `rtk pnpm exec tsc --noEmit` — passed
- focused collector red-first run — failed before root-scope implementation; focused collector tests then passed (3/3)
- `rtk pnpm exec node --experimental-strip-types --test --test-name-pattern='AE9' test/execution-e2e.test.ts` — passed
- `U8_EVIDENCE_ROOT=qa/evidence/u8-run-001 rtk pnpm exec node --experimental-strip-types --test test/execution-e2e.test.ts` — passed 19/19; retained as `run-80569-*`
- default E2E, repeated three times — passed 19/19 each
- `rtk pnpm run check` — passed 725/725
- live provider/network/publication verification — not run and unauthorized; controller lifecycle uses deterministic local adapter only
