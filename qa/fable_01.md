# QA report 01 — `/orchestrate` lifecycle review

Date: 2026-09-02
Reviewer: Claude (Fable 5.1)
Scope: `src/orchestrate.ts`, `src/pr-await-latch.ts`, `src/lib/pr-await-core.ts`, `src/git-workflow-guard.ts`, the pi agent definitions under `~/.pi/agent/agents/`, `~/.grok/skills/git-workflow/SKILL.md`, the installed `ghl-pr-await` binary and its checked-in source, `ghl-monitor.sh`, and the live state under `~/orchestrator/` and `~/.local/state/ghl-await/`.
Test suite at review time: `npm test` → 239 pass, 0 fail. The uncommitted working-tree changes (fingerprint-by-round, `openFeaturePr` in code, cwd-matched adoption) were included in the review.

Note on names: the request says "odd-worker". The agent on disk is `tdd-worker` (`~/.pi/agent/agents/tdd-worker.md`). This report assumes they are the same thing.

Design contract this report measures against (restated by the owner on 2026-09-02): plan → plan review → worktree created by **our Rust git commands** (`ghl-wt`, `ghl-pr-await`, `ghl-pr-land`, `ghl-wt-rm`), invoked by orchestrator code. No agent touches git directly; the single exception is `tdd-worker`, which commits. Everything else (worktree, push, PR open, await, land, cleanup) is code calling the Rust binaries.

---

## 1. Executive summary

The chain up to the PR is mostly sound in-process. The part that is "mostly broken" is exactly the part that has **no durable owner**: once the Feature PR is open, continuing the review-fix loop depends on an in-memory latch inside whichever pi session happened to run `git pr-await`. When that session ends, reloads, or simply sits in the reference checkout, nothing on disk or on a timer picks the work back up. Meanwhile three independent actors keep respawning waiters, the waiter's file naming changed under the TypeScript, and the one code path that could notice a pending verdict reads the wrong file name.

The four root causes behind "we fix a round or two and then it stops":

| # | Root cause | Where |
|---|---|---|
| RC1 | Feature PR phase has no durable driver. Dispatch only happens from a live session that holds the latch; a reload/restart orphans the PR forever. `/orchestrate resume` cannot help because the `git pr-await` handshake always prints `next=yield`. | F1 |
| RC2 | The installed Rust waiter (built 2026-09-01) writes `manual-<repo>-<pr>.json` / `drive-<repo>-<pr>.pid`; the TypeScript still reads `manual-<pr>.json` / `drive-<pr>.pid`. Verdicts written by the handshake-spawned waiter are invisible, and "is a waiter running?" is always false. | F2 |
| RC3 | Three uncoordinated spawners (handshake, TS `ensureDriver` on every `agent_settled`, `ghl-monitor` every 5 min) → duplicate waiters → GitHub rate limiting → transient `fix_command_or_environment` verdicts. | F3 |
| RC4 | A verdict is marked delivered **before** dispatch, and dispatch can legitimately return `refuse` (chain lock held, live worker). The verdict is then consumed and never retried. | F4 |

Live evidence (all read at 2026-09-02 08:00 ADT):

- No pi process is running. Every `drive-*.pid` in `~/.local/state/ghl-await/` is dead.
- `manual-icemining-2232.json`: `lastNext=read_comments_and_fix`, `verdictDelivered=false`, all three bots reviewed head `d5ec214` at 01:35Z. Undelivered for ~9.5 h. `~/orchestrator/icemining/per-coin-mining-claim/status.md` still says `pr_round: none`, `next_action: pr-await next=yield — fixer round 0`. No `pr-fix-2232-*.md` handoff exists. Same shape for `manual-1935.json` (PR 1935) and `manual-472.json` (devops 472).
- `drive-icemining-2232.log` contains the identical round-3 verdict 25 times and 8 `github rate limited` errors; `ghl-monitor.log` shows `RESPAWNED driver for #2232` every 5 minutes, and also respawns from `pi-*.latch.json`, the extension's private latch copy.
- Four Features are still `phase: pr` although their PRs merged days ago: 2191 (Aug 29), 2158 (Aug 26), 2209 (Aug 31), 2131 (Aug 23). Several carry `next_action` strings that no longer exist in the code.
- `ice-wt/feat-per-coin-mining-claim` has 7 modified, uncommitted files while PR 2232 is under review.
- `~/orchestrator/pi-seatbelt/` holds `pending-2026-08-31T15-04-50-093Z/` (only `plan-run.md`), `seatbelt-tool-isolation/` (draft, never reviewed) and `seatbelt-tool-isolation-2/` (the one that actually ran): the planner-time folder rename race.
- `icemining/batched-auth-projection` is `phase: reviewing`, `plan_review: running` with the plan already `APPROVED`: a dead plan-reviewer that is never reconciled, and `approve` is refused forever.
- Added 2026-09-02 11:30 ADT, this repo: `~/orchestrator/pi-orchestrate/` holds `durable-pr-reconciler/` (stub: `plan.md` 354 B, empty Tasks), `durable-pr-reconciler-2/` (the real 16.3 K plan, 5 Tasks) and `pending-2026-09-02T11-13-31-967Z/` (empty `handoffs/` only). Same F15 race, reproduced while planning the fix for this report. `/orchestrate approve durable-pr-reconciler-2` then failed at worktree creation with `fatal: 'origin' does not appear to be a git repository` / `fatal: invalid reference: origin/main` (new F22), and left `plan.md` at `> Status: APPROVED` with `status.md` still `phase: planning`, `worktree: none` (F16).

---

## 2. Target lifecycle vs. what the code does today

| Step (as specified) | Today | Verdict |
|---|---|---|
| `/orchestrate <objective>` → planner writes plan.md → plan-reviewer with fresh context | Planner child → `ensureFeatureNamed` → `reviewPlan` child (`orchestrate.ts:5565-5600`) | Works, but the folder is renamed by an unrelated `agent_settled` handler while the planner is still writing (F15), and a dead reviewer wedges the Feature (F14). |
| Plan ready for approval under a dynamic name; todo created | Name from `# Feature:` title, approve card, rpiv-todo overlay | Works. Card requires `plan_review: done`, so F14 also hides the card. |
| `/orchestrate approve` → worktree via Rust `ghl-wt` → tdd-worker per Task, commit only | `ensureFeatureWorktree` (`orchestrate.ts:1028`) runs `git wt` without `--yes`, then the legacy shell script; `runFeatureChain` (`:4028`) spawns `tdd-worker` per Task | Worktree step cannot succeed as called and fails outright without `origin` (F22). Worker is told it *may* commit; code never verifies a commit; dirty trees count as "landed" (F11). |
| Auto-advance to the next Task only if the previous is green | `settleTaskOutcome` + `autoAdvanceOnLanded` default true | A Task whose gate **failed** but touched files is marked done and the chain continues (F13). |
| All Tasks done → feature-qa adds QA fix Tasks → tdd-worker fixes them, at most two QA cycles | `needsFeatureQa`, `DEFAULT_QA_PASS_CAP = 1` (`orchestrate.ts:450`) | Only **one** QA pass by default; QA fixes are never re-checked (F12). |
| PR via pr-await, wait for a full round of review bots | `landFeaturePr` → `openFeaturePr` → `drivePrAwait` → latch | Opens fine. Waiting/dispatch is RC1–RC4 (F1–F4). |
| Full round → fixer → commit → repeat until merge or disagreement | `dispatchFeaturePrVerdict` → `runReviewFixWriter` → `awaitAndDispatch` | In-process loop is right; it dies with the session (F1), misclassifies fixer outcomes (F5), has no disagreement rule (F6), and hands the fixer a skill that tells it to run `git pr-await` (F7). |
| Auto-merge closes the Feature | Only if a live latch sees the merge (`finishTerminal`) | Merged PRs leave Features live forever (F8). |

---

## 3. Findings

Severity: **S1** blocks the lifecycle / causes silent stalls; **S2** wrong result or wrong state, recoverable by hand; **S3** hygiene, determinism, cost.

### A. PR / review-fix loop (the critical part)

#### F1 (S1) — No durable owner for the PR phase; a session reload orphans the Feature

- After `drivePrAwait` returns `next=yield` it calls `armObservedLatch` (`orchestrate.ts:3428`), which sets the latch **in memory** in the current session (`pr-await-latch.ts:799-811`) and starts a 15 s `gh pr view` watch. That watch is the only thing that ever calls `checkActionable` → `onFeatureActionable` → `dispatchFeaturePrVerdictForOwner`.
- On `session_start` (`pr-await-latch.ts:813-860`) a new session id is minted on reload, the own-latch branch does not hit, and adoption bails when `reason` is `new`/`resume` (`:844`), when the cwd is a reference checkout (`:845`), or when the cwd is not byte-equal to the latch cwd (`adoptableLatch` `cwd` option, `pr-await-core.ts:730`). The orchestrator parent normally runs from `~/Dev/git/<repo>` (a reference checkout) while the latch cwd is the worktree. So **no orchestrator session can ever re-adopt a Feature PR latch after a reload.** The uncommitted diff added the cwd match to fix the #2150 hijack, which is right for solo latches and makes this strictly worse for Feature latches.
- `orchestrate.ts` registers a `session_start` handler (`:5186`) that only republishes the todo overlay. There is no reconcile of Features in `phase: pr`.
- `/orchestrate resume` → `landFeaturePr` → `drivePrAwait` → `git pr-await <pr>` — the handshake unconditionally prints `status=handed_off next=yield instruction=stop_talking` (`gh-pr-reviewer/crates/ghl-cli/src/pr_await.rs:676`). It never surfaces an already-pending verdict, so resume re-arms the latch and returns. If F2 hides the verdict file, the user sees "0 tokens, handed off" and nothing happens.
- Evidence: PR 2232 above. PR 1935 and devops 472 are the same shape (solo or Feature, the mechanism is identical).

Fix: give the orchestrator its own durable reconciler keyed on `status.md`, independent of the session latch (see Plan, step 1.1).

#### F2 (S1) — State-file naming contract drifted between the Rust waiter and the TypeScript

- TS reads `manual-${pr}.json` at `pr-await-latch.ts:559` (verdict candidates), `:295` (round chrome), `:717` (stale-round strip), `:466` (terminal cleanup); pid/log at `pr-await-core.ts:745-750` (`drive-${pr}.pid`, `drive-${pr}.log`), used by `isDriverRunning` (`:774`) and `defaultSpawnDriver` (`pr-await-latch.ts:106`).
- The installed binary (`~/.local/bin/ghl-pr-await`, built 2026-09-01 14:31) writes `manual-icemining-2232.json`, `drive-icemining-2232.pid`, `drive-icemining-2232.log`. The checked-in source at `de5095b` still writes `manual-{pr}.json` (`pr_await.rs:695`), so the binary comes from an unreleased branch. `ghl-monitor.sh:280-286` already knows both schemes; the TypeScript knows only the old one.
- Consequences: (a) `checkActionable` never sees the handshake waiter's verdicts; (b) `isDriverRunning` is always false, so every `handoff()` (every `agent_settled` while latched, `pr-await-latch.ts:897-900`) spawns another `--state pi-<id>.json --daemon` waiter; (c) `reportTerminal` cannot delete the spent manual file.
- All 72 latch tests fixture `manual-<pr>.json`, so the suite cannot notice.

Fix: one shared naming module, read both spellings, TS never writes waiter files; add a contract test against the installed binary (see Plan 1.2).

#### F3 (S1) — Three uncoordinated waiter spawners

1. `git pr-await` handshake → `spawn_handoff` writes `manual-…json` and forks a daemon.
2. TS `ensureDriver` (`pr-await-latch.ts:762`) forks another daemon with `--state pi-<session>.json` on every settle (because of F2).
3. `ghl-monitor` RESPAWN every 5 min from **every** `manual-*.json`, `pi-*.json` and `pi-*.latch.json` (`ghl-monitor.sh:290-334`; log shows `RESPAWNED driver for #1935 from pi-…latch.json`). The `.latch.json` is the extension's private copy that the comment at `pr-await-latch.ts:166-171` says must never be handed to the waiter. It now contains waiter fields (`verdictDelivered`, `round`) and its cwd was rewritten to the reference checkout.

Consequences: duplicate polling, `github rate limited` (8 occurrences in the 2232 log), transient `fix_command_or_environment` verdicts that overwrite `next_action` for a Feature-owned PR (`dispatchFeaturePrVerdict` → `notify`, `orchestrate.ts:3878-3890`).

Fix: exactly one spawner per PR and one pid lock; TS never spawns when any pid for that PR is alive; monitor excludes `*.latch.json` (see Plan 1.3).

#### F4 (S1) — Verdict consumed before dispatch; `refuse` loses it

- `checkActionable` sets `lastActionableFingerprint` and calls `markVerdictDelivered` on both candidate files (`pr-await-latch.ts:576-578`) **before** `onFeatureActionable`. `dispatchFeaturePrVerdict` then returns `refuse` when `RUNNING_CHAINS` holds the Feature or `featureWorkerLive` is true (`orchestrate.ts:3517, 3899-3901`), or `notify`, or throws.
- A chain holds the lock for the whole fixer run (30–60 min). Any verdict arriving in that window (late bot on the previous head, a `fix_command_or_environment` burst) is marked delivered and refused. The waiter will not re-emit it, and a *later* verdict for the same head has the same fingerprint and is skipped at `:576`.

Fix: mark delivered only after an accepted dispatch (`spawn_writer`, `reawait`, `land`, `archive`); on `refuse` leave the file untouched and record `pending_verdict:` in status.md so the chain drains it when the lock is released (see Plan 1.4).

#### F5 (S2) — Fixer outcome classified by `ok` + handoff presence, not by whether it pushed

- `fixerSettleAction` (`orchestrate.ts:3457-3466`): `ok` → await; `!ok && handoff` → "disagree" (stop, "merge yourself"); `!ok && !handoff` → fail.
- A fixer that pushed a commit and then hit the turn budget or timeout is `!ok` with a handoff → the chain stops and the user is told the fixer "answered without a push" (`:3796-3799`), which is false. A fixer that wrote a handoff, did not push, but was reported `ok` → re-await on the same head → the waiter's next verdict has the same fingerprint → silent stall.
- Tasks already do this correctly with `worktreeFingerprint`; the fixer path does not.

Fix: capture `origin/<branch>` head before and after the fixer; decide from that (see Plan 2.1).

#### F6 (S2) — No termination policy except merge; no "disagree" rule

- `classifyFeaturePrNext` receives `prRound` and ignores it (`orchestrate.ts:3498-3524`). PR 275 consumed 7 fixers, PR 2178 consumed 7. The spec says: loop until merge, or until the orchestrator disagrees with the reviewers. Nothing implements disagreement, so the loop either runs until the bots give up or stops for an unrelated reason (F1–F5).

Fix: (a) detect the same finding set (`brief_finding path/line/title` from the waiter body) on two consecutive heads → disagreement → stop, post one `gh pr comment` from code explaining the disagreement, mark `phase: pr`, `next_action: disagreed at <head>`; (b) hard cap (e.g. 6 rounds) with a notice; (c) let the fixer return structured `{pushed, disagreed: [...]}` (see Plan 2.2).

#### F7 (S1) — Fixer is handed the solo git-workflow skill, which tells it to run `git pr-await`

- `reviewFixLaunchParams` passes `skill`, `skills` and `reads` of `SKILL.md` (`orchestrate.ts:3546, 3576-3578`); `fixer.md` also declares `skills: git-workflow` and `defaultReads`. The skill's `next=` table (`SKILL.md:33-42`) says `read_comments_and_fix` → "fix …, one push, then `git pr-await` once". The task text says the opposite ("do NOT `git pr-await`").
- `git-workflow-guard` allowlists `git pr-await` (`lib/git-workflow-guard.ts:47-57`), so a fixer that obeys the skill spawns yet another waiter with its own state file from inside a child session. Nothing in the child role blocks it.

Fix: children never receive the skill; they get a five-line writer contract in the task text; add a child-role guard (env `ORCHESTRATE_ROLE=writer` on the spawn) that blocks `git pr-await|pr-land|wt`, `gh pr create|merge`, `git push --force` (see Plan 2.3).

#### F8 (S2) — Merged PRs never close the Feature; stale "live" Features poison every session

- Only a live latch that witnesses the merge dispatches `next=done` (`finishTerminal`, `pr-await-latch.ts:484-513`). With F1, most merges are not witnessed. Features `fail-closed-ban-issuer` (2191), `relay-keep-first-jobs` (2158), `coins-chart-y-zoom` (2209), `security-review-modes` (2131) are still `phase: pr`.
- `liveFeatureNeedsIdleParent` (`orchestrate.ts:4774-4791`) therefore returns true for `icemining` forever, and `before_agent_start` (`:5192-5204`) appends `FORBIDDEN` + "stay idle" to the system prompt of **every** pi session in that repo. Its regex `^(implement|pr|qa)$` also never matches the real phases `implementing` / `feature-qa`, so it is both over- and under-inclusive.
- `defaultFeature` / `syncLiveFeatureOverlay` become ambiguous with 15+ "live" Features in one repo.

Fix: reconcile on session start / every verb / timer: `gh pr view --json state,mergedAt` for each `phase: pr` Feature → `done`; auto-archive `done` Features after N days or immediately; drop or correctly gate the system-prompt injection (see Plan 1.1, 1.5).

#### F9 (S3) — Unbounded mutual recursion `awaitAndDispatch` ↔ `dispatchFeaturePrVerdict`

- `reawait` (`orchestrate.ts:3843-3855`) calls `awaitAndDispatch`, which calls `dispatchFeaturePrVerdict` again with no depth bound. Each hop is another `git pr-await` handshake. Unlikely today because the handshake yields, but the invariant "exactly one `git pr-await` per round" is not enforced.

Fix: pass a `depth` and stop at 2.

#### F10 (S2) — `openFeaturePr` swallows failures and can open with nothing to review

- `git push -u origin HEAD` errors are ignored (`orchestrate.ts:4648-4655`); `gh pr create` stderr is discarded and the user sees "no PR number returned" (`:4667`). If the branch has no commits ahead of `main` (because workers did not commit, F11) `gh pr create` fails with "No commits between …" and the Feature parks in `phase: pr` with no actionable message (`quiesce-identical-current-state` is parked this way, still showing the pre-refactor `pr-open.md` message).
- `--body-file plan.md` posts the whole plan, including `/Users/greg/orchestrator/...` paths and `Worker:` model lines, as the public PR body. `--base main` is hard-coded.

Fix: pre-flight (`git status --porcelain` empty, `git rev-list --count origin/<default>..HEAD > 0`), surface stderr verbatim in `next_action`, body from `## Context` + Task titles, default branch from `gh repo view --json defaultBranchRef`.

### B. Task lifecycle and commit discipline

#### F11 (S1) — Committing is optional and never verified; dirty trees count as done

- `tdd-worker.md`: "You **may** commit this Task in the Feature worktree if that matches repo conventions." The spec says the worker's only git operation is commit.
- `worktreeFingerprint` (`orchestrate.ts:3159-3171`) is `HEAD + porcelain status`, so unstaged edits are "landed" and the Task is marked `done`. The next worker starts on a dirty tree, feature-qa reviews uncommitted code, and `openFeaturePr` pushes `HEAD` only, so the work never reaches the PR.
- Evidence: `ice-wt/feat-per-coin-mining-claim` has 7 modified files (auth-backend admin) uncommitted while PR 2232 is under review; they are not referenced by that plan, i.e. leftovers polluting the single-writer worktree.

Fix: a code-owned commit gate after every writer (Task and fixer): require porcelain empty **and** HEAD advanced; if the tree is dirty, code commits deterministically (`git add -A && git commit -m "Task N — <title>"`), or blocks with an explicit reason; refuse to start Task 1 on a dirty worktree; workers commit only, **code pushes** (at PR open and after each fixer).

#### F12 (S2) — QA cycle default is 1; spec says at most 2

- `DEFAULT_QA_PASS_CAP = 1` (`orchestrate.ts:450`), `MAX_QA_PASS_CAP = 2` (`:2374`). With cap 1 the remediation Tasks added by QA are implemented and the PR opens without QA ever re-checking them.
- A failed QA child (`runFeatureQa` → -1) parks the Feature in `feature-qa` until a manual resume (`failover-catch-up-coverage`).

Fix: default cap 2 (QA → fix → QA → fix → PR); auto-retry a QA child once on transport/schema failure before parking.

#### F13 (S2) — "failed but landed" auto-advances past a red gate

- `settleTaskOutcome` returns `done_continue` for `!ok && landed && autoAdvance` (`orchestrate.ts:510-512`); `autoAdvanceOnLanded` defaults to true. A Task whose `- Command:` gate ran and **failed** is still marked done when files changed. The spec says advance only if the previous Task is green.

Fix: auto-advance only when the Task had no runnable gate (`acceptance.level === "none"`); a failed verified gate blocks. Record `gate: red|green|none` in the Task handoff line.

#### F14 (S1) — Orphaned plan-reviewer is never reconciled; approve refused forever

- `reviewPlan` writes `plan_review: running` (`orchestrate.ts:4982-4986`) and records no run id. If the session dies, `writerBlockedByPlanReview` (`:896-901`) refuses every approve/resume with "plan-reviewer still running", and `draftApproveCards` (`:728`) never shows the card. Tasks got orphan recovery (`reconcileOrphanTask`); the reviewer did not.
- Evidence: `batched-auth-projection` (`phase: reviewing`, `plan_review: running`, plan already `APPROVED`).

Fix: record `reviewer_run_id` / dir; on approve/resume apply `readRunSnapshot`: terminal-ok → `done`, terminal-fail → `failed` (re-run), non-terminal → wait like Tasks.

### C. Plan → approve

#### F15 (S1) — Folder rename race during planning

- `agent_settled` → `presentDraftApproveCards` → `ensureFeatureNamed` (`orchestrate.ts:798-816`) renames `pending-<utc>/` to `<name>/` the moment a `# Feature:` title exists, even while the planner child is still running and writing to the `pending-*` path it was given (`plannerBody`, `:4835-4838`). The planner recreates `pending-*/`, the completion path then names it again and `uniquifyName` appends `-2`.
- Evidence: `pi-seatbelt/pending-2026-08-31T15-04-50-093Z/` (only `plan-run.md`), `seatbelt-tool-isolation/` (draft, `plan_review: none`), `seatbelt-tool-isolation-2/` (ran to `done`). `pi-extensions/pending-2026-08-31T19-08-48-820Z/` likewise.
- Evidence, 2026-09-02, this repo: `pi-orchestrate/durable-pr-reconciler/` is the stub renamed from the first `# Feature:` line (354 B plan, empty Tasks table, `feature:` field split across two lines in its status.md), `durable-pr-reconciler-2/` is the real plan the planner finished writing, `pending-2026-09-02T11-13-31-967Z/` is the recreated folder with only `handoffs/`. The user-facing consequence is that `/orchestrate approve durable-pr-reconciler` (the obvious name) approves the empty stub; the real plan only exists under the `-2` name. Three folders per plan is now the normal outcome, not an edge case.

Fix: never rename from an event handler. Name the Feature only in the planner-completion path (after `runChildInPhase(planner)` resolves) and make `presentDraftApproveCards` read-only. Alternatively give the planner a stable path and store the display name in status.md instead of renaming at all.

#### F16 (S2) — `approve` writes `APPROVED` before validating

- The approve verb rewrites `> Status: APPROVED` (`orchestrate.ts:5273-5281`) and only then checks name/branch and starts the chain. A failed approve leaves the plan `APPROVED` with nothing running: `isDraft` is now false, the card is never re-offered, and `defaultFeature('approve')` no longer finds it.
- Evidence, 2026-09-02: `pi-orchestrate/durable-pr-reconciler-2/plan.md` line 3 is `> Status: APPROVED`; its `status.md` is `phase: planning`, `worktree: none`, `next_action: wait for /orchestrate approve durable-pr-reconciler-2`. The approve failed inside `ensureFeatureWorktree` (F22) after the status line was already rewritten.

Fix: validate first (name, branch, remote, worktree pre-flight), take the chain lock, write `APPROVED` last.

#### F22 (S1) — Feature worktree creation calls the Rust `ghl-wt` interactively, then silently falls back to the legacy shell script; neither survives a repo without `origin`

- `ensureFeatureWorktree` (`orchestrate.ts:1028-1031`) runs `git wt <branch>` with no `--yes`. `git wt` is the alias for the Rust binary `~/.local/bin/ghl-wt` (`wt.rs:73-84`), which prints a y/N prompt and reads stdin; under `pi.exec` stdin is empty, `should_proceed(false, "")` is false, and the binary exits with `aborted`. Before that it also runs `git config --get remote.origin.url` (`wt.rs:55`, `:173-175`), which is a hard error when no `origin` is configured. So the Rust path can never succeed from orchestrate as called today, in any repo.
- On failure the code retries with `GIT_WT = ~/glm-review/git-wt.sh` (`orchestrate.ts:88`, `:1036-1041`), the pre-Rust shell script that `ghl-wt` replaced. That script does `git ls-remote origin` and `git worktree add -b <branch> <dir> origin/main` (`git-wt.sh:13, 26, 32`). Its stderr is what the user saw: `fatal: 'origin' does not appear to be a git repository` and `fatal: invalid reference: origin/main`. The error text is attributed to "No usable worktree" with no hint that the Rust command was never given a chance.
- The shell fallback violates the design contract (worktrees come from our Rust git commands) and hides the real defect (missing `--yes`) behind a second implementation with different semantics.
- This repo (`pi-orchestrate`) has **no remote at all** (`git remote -v` is empty; only local `main` and `fix/latch-key-by-repo`). `ghl-wt` hard-codes `origin/main` as the default base (`wt.rs:47-50`) and probes `origin` for the branch (`:103`), so even with `--yes` it fails here. Nothing in `approve` checks for a remote before committing to the PR-based lifecycle, and the message the user gets is a git internals dump rather than "this repo has no origin; add one or plan cannot reach a PR".
- The existing `pi-orchestrate-wt/fix-latch-key-by-repo` worktree was created from a solo session, not through this path, so the farm looks healthy while the Feature path is broken.

Fix (in order):
1. `orchestrate.ts`: call `ghl-wt <branch> --yes` (or `git wt <branch> --yes`) from `paths.gitRoot`; delete the `GIT_WT` shell fallback and the constant; surface `ghl-wt`'s stderr verbatim. One implementation, the Rust one.
2. `ghl-wt`: when `remote.origin.url` is unset, resolve the base as the local default branch (`git symbolic-ref --short HEAD` in the reference checkout, else `main`), skip the `ls-remote` probe, and say so on stderr (`no origin; branching off local main`). Keep the current behaviour when `origin` exists. Add a `--base` flag to make the base explicit for code callers.
3. `approve` pre-flight (with F16): `git remote get-url origin` must succeed, or refuse approve with a one-line reason **before** writing `APPROVED`. A Feature cannot complete without a remote (PR open, pr-await, pr-land all need it), so refusing early is the honest answer.
4. Test: `ensureFeatureWorktree` against a tmp repo with no remote and against one with a bare `origin`; assert the Rust binary is called with `--yes`, that no shell script is invoked, and that the failure message names the missing remote.

### D. git-workflow skill placement

#### F17 (S2) — The skill is a solo-session prompt that leaks into orchestration

- `SKILL.md` is written for a human-driven session (`git wt` → `gh pr create` → `git pr-await` → act on `next=`). It is loaded globally (`~/.claude/CLAUDE.md`, pi `settings.json` skills) and now also injected by orchestrate into **every** pi session via `resources_discover` (`orchestrate.ts:5189`) and `before_agent_start` (`:5192`).
- It contains an `/orchestrate` section (`SKILL.md:48-58`) that documents extension internals (`drivePrAwait`, `armObservedLatch`), a duplicated paragraph (`:53-54`), and rules that contradict the orchestrator's writer contract (F7). A git skill is the wrong place for orchestration policy, and a prompt is the wrong enforcement mechanism for something the code already owns.

Recommendation: split into three things with three owners.
1. `git-workflow` skill: solo sessions only. Delete the `/orchestrate` section. Keep wt/await/land tables.
2. Orchestrate writer contract: five lines inlined by code into every `tdd-worker` / `fixer` task ("commit in this cwd; never push, never PR, never pr-await, never wt; stop and write the handoff on a blocker"). No skill, no `reads`.
3. Mechanical guard: `git-workflow-guard` gains a child role (env from the spawn) that blocks the whole PR lifecycle for writers. Remove `resources_discover` and `before_agent_start` from orchestrate; if a parent-side reminder is still wanted, gate it on a correctly computed "this session owns a Feature in this cwd", not on "some Feature in this repo has phase pr".

### E. Hygiene and determinism

#### F18 (S3) — Polling and process cost

- Each latched session polls `gh pr view` every 15 s (`startWatch`, `pr-await-latch.ts:515-538`) on top of the waiter and the monitor. Prefer one poller (the waiter) plus `fs.watch` on the state dir for wake-ups.

#### F19 (S3) — 30-minute handshake timeouts hold the chain lock

- `PR_AWAIT_CALL_TIMEOUT_MS` and `PR_LAND_CALL_TIMEOUT_MS` are 30 min (`orchestrate.ts:3338, 3644`). The handshake is fork+print; 60 s is plenty. A hung handshake blocks the Feature (and every latch dispatch → `refuse`, F4) for half an hour.

#### F20 (S3) — Dual-purpose files

- `persist()` seeds `pi-<id>.json` with the extension's latch (`pid`, `sessionId`) and the waiter later rewrites it wholesale (`pr-await-latch.ts:217-247`); `adoptableLatch` then reads waiter-rewritten files as session latches. The monitor writes into `*.latch.json`. Two writers per file is the source of most "wrong cwd / no pid / adopted the wrong PR" incidents in the comments. Rule: TS writes only `*.latch.json`; the waiter writes only `--state`; the monitor reads only.

#### F21 (S3) — Tests encode the stale contract

- 239 tests pass while the live system is stalled. Missing: (a) a contract test against the installed `ghl-pr-await` naming; (b) "session restarts with an undelivered verdict on disk → fixer dispatched"; (c) fixer pushed-vs-not; (d) merged-PR reconcile without a latch; (e) planner-time rename race; (f) QA cap 2 flow; (g) commit gate; (h) worktree creation via `ghl-wt --yes` with no shell fallback, in a repo with and without `origin`.

---

## 4. Remediation plan

Ordered so each phase leaves the system strictly better and can ship alone. Work on a branch; the current uncommitted diff should be committed first as its own change (it is directionally right except the adoption cwd match, which Phase 1 makes irrelevant for Features).

### Phase 0 — Unstick what is stuck today — **DONE 2026-09-02 11:36 ADT**

Executed against live state. Everything below was **moved to `archive/`, never deleted**, so each step is reversible with a `mv` back. Two items resolved themselves before the run and two changed shape; both are recorded under the step.

| # | Step | Result |
|---|---|---|
| 1 | Archive merged Features | **5 archived**, not 4. PR 2232 merged at 11:24Z, the same morning, so `per-coin-mining-claim` joined the list. Each `status.md` set to `phase: done` with the merge date before the move. |
| 2 | `batched-auth-projection` | `plan_review: running` → `done`. `handoffs/plan-review.md` (3.8 K, written 2026-09-01 21:05) is the evidence the reviewer finished. Approve is no longer refused. |
| 3 | PR 2232 pending verdict | **No action needed.** The PR merged and the waiter cleaned up: `manual-icemining-2232.json` is gone and its pid (71700) is dead. The stopgap copy-the-file trick is now moot. |
| 4 | Leftover `pending-*` folders | **16 archived** across 5 repos, far more than the 2 the review named. One was **kept**: see below. |
| 5 | Stray files in `ice-wt/feat-per-coin-mining-claim` | **Gone.** `pr-land` removed the whole worktree on merge. Nothing to commit or discard. |
| 6 | Commit the baseline | **Done**, `984894f` (fingerprint-by-round, cwd-matched adoption, `openFeaturePr`; 596 lines, 239 tests pass). The QA report itself is `bcd6617`. Adding an `origin` remote is **not done** — creating a GitHub repo is the owner's call. |
| 7 | `pi-orchestrate` folder cleanup | Stub `durable-pr-reconciler/` and `pending-…T11-13-31-967Z/` archived. `durable-pr-reconciler-2/plan.md` reset to `> Status: DRAFT`; its `next_action` now names the missing remote as the blocker. |

**One folder was kept against the review's own instruction.** `pi-extensions/pending-2026-08-31T19-08-48-820Z/` is not race debris: it holds a real 16.2 K plan titled `# Feature: Orchestrate QA remediations` with 5 Tasks, stuck at `name: pending` because the naming step never ran on it. Deleting it would have destroyed a plan. It is the *victim* of F15 rather than its residue, and it needs naming (Phase 4), not cleanup.

**Second correction to step 4.** Of the 16 archived, 10 held only a `handoffs/plan-run.md` and no `plan.md` at all — pure F15 residue. 5 more held a 363 B–1.4 K planner seed still titled `# Feature: (planning)` with zero Tasks: planners that died before writing a title. 1 was already self-marked `(superseded — not a new Feature)`. None carried recoverable work.

**Archiving the five did not clear the F8 prompt injection.** Four Features are still `phase: pr` with `pr: none` — `bind-probe-reward-scope`, `mdl-wallet-address-field`, `pearl-chart-fork-hashrate`, `quiesce-identical-current-state`. These are F10 casualties, not F8 ones: `openFeaturePr` failed and swallowed the error, so they parked in the PR phase without ever getting a PR number. `liveFeatureNeedsIdleParent` matches on `phase` alone, so it still returns true for `icemining` and every pi session in that repo still gets `FORBIDDEN` + "stay idle" appended. Phase 1.5 (gate or delete the injection) and Phase 2.5 (`openFeaturePr` pre-flight) are what actually close this; no Phase 0 move can.

**Also observed, out of Phase 0 scope.** `manual-1935.json` and `manual-472.json` still hold undelivered verdicts for PRs that are **still OPEN** (icemining#1935, icemining-devops#472). Neither is claimed by any Feature's `status.md`, so they are solo latches: F1 hits them too, but no `/orchestrate` Feature is stalled behind them and Phase 1's reconciler will not adopt them. Eight pi sessions were live during this run; every target was verified inert (`worker_run_id: none`, no in-flight Task) before it was moved.

Original steps, as written before the run:

1. Archive the four merged Features (`fail-closed-ban-issuer`, `relay-keep-first-jobs`, `coins-chart-y-zoom`, `security-review-modes`) with `/orchestrate archive <name>`.
2. `batched-auth-projection`: set `plan_review: done` (the handoff `plan-review.md` exists) or re-run `/orchestrate review batched-auth-projection`.
3. `per-coin-mining-claim` (PR 2232): after Phase 1 lands, `/orchestrate resume per-coin-mining-claim` will dispatch the pending verdict. Stopgap before that: copy `manual-icemining-2232.json` to `manual-2232.json` and run resume from a pi session; the latch will then find the verdict on its first `checkActionable`.
4. Clean the leftover `pi-seatbelt/pending-*` and `pi-extensions/pending-*` folders and the duplicate `seatbelt-tool-isolation` draft.
5. Commit or discard the 7 stray files in `ice-wt/feat-per-coin-mining-claim` before the next fixer runs there.
6. This repo, before the remediation plan can be approved (F22): give `pi-orchestrate` an `origin` (create the GitHub repo, `git remote add origin …`, `git push -u origin main`). Without it `ghl-wt`, `gh pr create` and `pr-await` all fail. Then commit the current uncommitted baseline (fingerprint-by-round, cwd-matched adoption, `openFeaturePr`) so the Feature branch is cut from a tree that has those APIs.
7. This repo, folder cleanup (F15/F16): delete the stub `durable-pr-reconciler/` and `pending-2026-09-02T11-13-31-967Z/`; set `durable-pr-reconciler-2/plan.md` back to `> Status: DRAFT` so the approve card reappears, or re-run approve directly once step 6 is done. Optionally rename `-2` to the plain name after the stub is gone (update `name:`, `dir:`, `plan:`, `branch:` in status.md together).

### Phase 1 — Durable PR phase — **DONE 2026-09-02**

Implemented as the five Tasks of `durable-pr-reconciler-2`, one commit each, TDD throughout. The suite went from 239 to 284 passing, all green, and `tsc --noEmit` is clean.

| Task | Commit | What landed |
|---|---|---|
| 1 | `78ed304` | `waiterPaths(repo, pr)` plus `waiterPidFiles` / `waiterManualFiles`. `isDriverRunning` answers for a live pid under **either** spelling. |
| 2 | `dbbf376` | Every latch read of waiter state goes through those helpers; `handoff()` no longer spawns a waiter for a Feature-owned PR. |
| 3 | `7302d29` | A verdict is spent only when dispatch **accepts** it; a refusal records a hashed `pending_verdict` instead of consuming the round. |
| 4 | `700a6c1` | New `src/lib/pr-reconcile.ts`: the durable owner, keyed on `status.md`, fully dependency-injected. |
| 5 | `aa56795` | Reconciler wired to `session_start`, every verb, a 60 s unref'd timer, and chain-lock release. Idle-parent prompt gated. |

**RC1 / F1.** `pr-reconcile.ts` is the durable owner. It asks three questions of each live `phase: pr` Feature — has the PR finished, is a verdict waiting on disk, is anyone waiting on it — and answers them from `status.md` and the waiter's own files, so no session's memory is load-bearing. It runs on `session_start` (the reload case), on every `/orchestrate` verb, on one process-wide 60 s timer armed only while some Feature is in the PR phase, and the moment a chain releases the Feature lock with a verdict queued. Latch adoption is untouched: it stays correct for solo latches and is no longer the only route for Features.

**F2.** Both naming schemes are read everywhere. The suffix match is string arithmetic rather than a regex, because `drive-.*-232` matches `drive-icemining-2232.pid`, and answering "#232 already has a waiter" because #2232 does would leave #232 with none at all. TypeScript still writes no `manual-*` or `drive-*.pid`; a test asserts the read path creates nothing.

**F3.** One spawner per PR. The latch skips `ensureDriver` when a Feature owns the PR, and the reconciler starts a waiter only when no pid is alive under any spelling. Solo latches still ensure their own waiter, which a test pins.

**F4.** The mark moved to the far side of the decision. `dispatchFeaturePrVerdict` spends the waiter files at the instant it commits to `spawn_writer`, `reawait`, `land` or `archive` — before awaiting the fixer, not after, since that writer holds the Feature for the better part of an hour. A `refuse` leaves every file undelivered and writes `pending_verdict`. The fingerprint is hashed through `fingerprintTag` because a verdict body is many lines and status.md holds one value per line; storing it raw made the duplicate-toast guard fail on the first run.

**F8 / Phase 1.5.** `liveFeatureNeedsIdleParent` had two defects: its regex `^(implement|pr|qa)$` never matched the phases actually written (`implementing`, `feature-qa`), and it asked only whether the *repo* had such a Feature. It now matches the real phase names and only when the session's cwd is that Feature's own worktree, or the repo root for a Feature that has none. Verified live: the gate returns false for `~/Dev/git/icemining`, where it returned true for days. `resources_discover` and `before_agent_start` stay registered, per the locked scope; deleting them is Phase 5 (F17).

**F21 (a), (b), (d).** `test/waiter-contract.test.ts` (10 tests) pins the naming contract. `test/pr-reconcile.test.ts` (21 tests) covers verdict dispatch with no latch in the picture, merged-PR close with every waiter dead, and the rejections: an `unknown` `gh` answer never closes a Feature, archived and non-`pr` Features are skipped, and `pi-<id>.latch.json` is never read as waiter state.

**Deliberately not done, and still open.** Two Phase 1 items live in other repositories and were scoped out by the plan: `ghl-monitor.sh` still respawns drivers from `pi-*.latch.json`, and the Rust waiter still takes no per-PR lock. Both remain as written in F3. The residual risk is a duplicate waiter started by the monitor, which the extension can no longer cause but also cannot prevent. Landing the Rust naming change in `gh-pr-reviewer` main so source and binary agree is likewise still open, and until it does both spellings must keep being read.

**One thing worth flagging.** Registering a second `session_start` handler would have silently replaced the overlay republish, since `pi.on` is not documented to chain. The two are merged into one handler.

Original plan, as written before implementation:

#### Phase 1 — Durable PR phase (fixes RC1–RC4; F1, F2, F3, F4, F8)

##### 1.1 **Feature PR reconciler in `orchestrate.ts`** (new module `src/lib/pr-reconcile.ts`).
- Trigger: `session_start`, every `/orchestrate` verb, and a 60 s timer while any Feature is in `phase: pr` (timer unref'd; one per process).
- For each live Feature with `phase: pr` and a `pr:` number: (a) `gh pr view --json state,mergedAt,headRefOid` → merged/closed → `phase: done` / `confirm`; (b) scan the state dir for **every** file whose `pr` matches (both naming schemes, `pi-*.json`, `manual-*`) with an undelivered ACTIONABLE → `dispatchFeaturePrVerdictForOwner`; (c) ensure exactly one waiter (1.3).
- Persist `pr_head`, `verdict_fingerprint`, `pending_verdict` in status.md so a restart resumes from disk.
- The latch's Feature-owned branch (`featureOwnedPr` / `onFeatureActionable`) becomes a fast path only; correctness no longer depends on it. Remove the reference-checkout / cwd bail-outs from the *Feature* path (they stay for solo latches).

1.2 **Naming contract.** One function `waiterPaths(repo, pr)` returning `{ manual: [new, old], pid: [new, old], log }`; all TS reads go through it; TS never writes those files. Add `test/waiter-contract.test.ts` that runs the installed binary with `GHL_LATCH_STATE_DIR` pointed at a tmp dir and `--once` against a fixture, or at minimum asserts the names `ghl-monitor.sh` uses. Land the Rust naming change in `gh-pr-reviewer` main so source and binary agree.

1.3 **One spawner.** TS `handoff()` checks all pid spellings and the process command line (as the monitor does) before spawning; never spawns from `agent_settled` when a Feature owns the PR (the reconciler owns it); monitor excludes `*.latch.json`. Waiter side: take a per-PR lock file and exit 0 with `status=already_waiting` when held.

1.4 **Mark-after-dispatch.** In `checkActionable` and the reconciler: dispatch first; call `markVerdictDelivered` only for `spawn_writer | reawait | land | archive`; on `refuse` write `pending_verdict: <fingerprint>` and let `runReviewFixWriter` / chain exit drain it.

1.5 **Prompt injection.** Delete `resources_discover` and `before_agent_start` from `orchestrate.ts`, or gate on a correct predicate (`phase` ∈ {`implementing`,`feature-qa`,`pr`} **and** the session cwd is that Feature's worktree or gitRoot). Fix the regex either way.

Acceptance: kill pi mid-review with a verdict pending → start pi anywhere in the repo → a fixer is spawned within 60 s; no second waiter appears; merged PR closes the Feature within 60 s with no session latch involved; `github rate limited` no longer appears in waiter logs over 24 h.

### Phase 2 — Deterministic fix loop — **DONE 2026-09-02**

Five Tasks, one commit each, TDD throughout. The suite went from 284 to 309 passing, all green; `tsc --noEmit` clean.

| Task | Commit | What landed |
|---|---|---|
| 1 | `e403fa0` | `branchHeads` + `fixerPushState`; the fixer settle is read off `origin/<branch>`, and code pushes what a fixer only committed. |
| 2 | `72b800d` | `parseBriefFindings` / `findingsTag` / `verdictHead`; `FIX_ROUND_CAP = 6`; the `disagree` action and `recordFeatureDisagreement`. |
| 3 | `182e899` | `WRITER_CONTRACT` in the task text of both writer paths; `classifyForRole` / `isWriterRole` in the guard; `fixer.md` and `tdd-worker.md` updated. |
| 4 | `1628590` | `AWAIT_DISPATCH_MAX_DEPTH = 2`; handshake timeout 30 min → 60 s; land timeout 30 min → 10 min. |
| 5 | `8fa88e0` | `openFeaturePr` pre-flight, verbatim stderr, `defaultBaseBranch`, `featurePrBody`. |

**F5 — the branch is the evidence.** `runReviewFixWriter` records `origin/<branch>` before the child and re-reads it after (with a fetch, or the comparison is against whatever the last fetch left behind). `fixerPushState` turns the pair into `pushed` / `committed` / `none` / `unknown`. A fixer that pushed and then hit its turn budget now re-awaits instead of being told it "answered without a push" — which was false, and stopped the loop on a PR that had just moved. A fixer reported `ok` that pushed nothing is a disagreement, not another identical re-await. `unknown` falls back to the old `ok` + handoff table: an unreadable head must never invent a verdict, the same rule `worktreeFingerprint` already follows on the Task path.

**F6 — the loop now ends at a disagreement.** `classifyFeaturePrNext` took `prRound` and ignored it. The reviewers' own `brief_finding` lines are parsed into a sorted, head-independent set and tagged; the same tag arriving on a head the last fixer *moved* is the disagreement the spec asks for, and `FIX_ROUND_CAP = 6` is the backstop. Either way code posts one `gh pr comment` naming the open findings and parks the Feature with `next_action: disagreed at <head>`. A Feature a writer already holds outranks both: that verdict is queued for retry, not spent on a disagreement. `disagree` joins `ACCEPTED_FEATURE_PR_ACTIONS`, or the reconciler would re-raise it every 60 seconds.

**F7 — writers commit; code does everything else.** The `skill` / `skills` / `reads` of the solo `SKILL.md` are gone from `reviewFixLaunchParams`, and `skills:` / `defaultReads:` from `fixer.md`. Both worker paths now carry `WRITER_CONTRACT` in their task text. The enforcement is mechanical: `classifyForRole(command, { writer })` blocks `git pr-await` / `pr-land` / `wt` / `wt-rm`, `gh pr create|comment|merge`, and `git push` for a writer child, while the solo session keeps every one of them.

> Implemented differently from the plan, and better: the plan said to spawn children with `env: { ORCHESTRATE_ROLE: "writer" }`. pi-subagents' async spawn takes no `env` parameter — the runner inherits `process.env` — so that flag would never have arrived. But `runs/shared/pi-args.ts` already sets `PI_SUBAGENT_CHILD_AGENT=<agent>` in every child's environment, so `isWriterRole` reads that. The role needs no cooperation from the spawn site at all, and it is correct for children this extension did not spawn. `ORCHESTRATE_ROLE=writer` is still honoured as an explicit override.

**F9 — the recursion had no bound, and it was real.** `reawait` → `awaitAndDispatch` → dispatch → `reawait` recursed forever against a waiter that keeps answering `investigate_dead_reviewers`; the test written for it hung the whole suite until the bound went in. `AWAIT_DISPATCH_MAX_DEPTH = 2` handshakes per chain, after which the waiter still owns the PR and the reconciler picks up whatever it says next — nothing is dropped. A completed fix round starts a fresh chain; what bounds *that* loop is F6's cap.

**F19, taken with F9.** The `git pr-await` handshake timeout drops from 30 minutes to 60 seconds. It forks a daemon and prints; half an hour of it only ever meant the chain lock was held while nothing happened, and a timeout is read as `yield` either way. `git pr-land` drops from 30 to 10 minutes.

**F10 — the PR open says what went wrong.** Push errors were ignored and `gh pr create` stderr was discarded, so an empty branch failed with "No commits between …" and the user was told "no PR number returned". Now: base branch from `gh repo view`, a dirty worktree refuses naming the files, a branch with nothing ahead of `origin/<base>` refuses naming the branch, and a failed push or create returns its stderr verbatim into both the toast and `next_action`. A check git cannot answer never blocks — it falls through to `gh`, whose error is now readable. The PR body is built from the plan's `## Context` plus the Task titles; `--body-file plan.md` had been posting `/Users/greg/orchestrator/…` paths and `> Worker:` model routing as the public body of a PR.

**Two stale tests were rewritten rather than worked around** (F21 in miniature). One asserted `classify("read_comments_and_fix", { prRound: 99 }) === "spawn_writer"` — "no fixer-round cap" — which is exactly the behaviour F6 exists to reverse. The other asserted the handshake timeout was 30 minutes. Both now state the new contract and say why.

**Still open after Phase 2.** The four Features parked in `phase: pr` with `pr: none` are F10 casualties from before this fix; they will not self-heal, since there is no PR for the reconciler to ask about. Clearing them is bookkeeping, not code. `git push` is now blocked for writers, so every path to `origin` runs through code: `openFeaturePr` for the first push and `pushFeatureBranch` for a fix round. If a repo needs a push from somewhere else, that path does not exist yet.

Original plan, as written before implementation:

#### Phase 2 — Deterministic fix loop (F5, F6, F7, F9, F10)

2.1 `runReviewFixWriter`: record `origin/<branch>` head before; after the child, `git fetch` and compare. `pushed` → push if the fixer only committed (code pushes), then one `git pr-await`; `!pushed && handoff` → disagreement path; neither → fail. Replace `fixerSettleAction` inputs accordingly.

2.2 Termination policy in `classifyFeaturePrNext`: parse `brief_finding` lines from the verdict body into a set; persist `last_findings` per head; identical set on two consecutive heads, or `fix_rounds >= 6` → `disagree`. `disagree` action: `gh pr comment` from code with the fixer's handoff summary, `next_action: disagreed at <head> — merge or reply on the PR`, stop. Fixer contract gains structured output `{ pushed: bool, fixed: [...], disagreed: [{finding, reason}] }`.

2.3 Writer contract and child guard: remove `skill`/`skills`/`reads` from `reviewFixLaunchParams`; remove `skills:`/`defaultReads:` from `fixer.md`; inline the five-line contract into both worker task texts; spawn children with `env: { ORCHESTRATE_ROLE: "writer" }`; `git-workflow-guard` blocks `git pr-await|pr-land|wt|wt-rm`, `gh pr create|merge|comment`, `git push` when that env is set (code pushes).

2.4 Bound `awaitAndDispatch` depth at 2; handshake timeout 60 s; land timeout 10 min.

2.5 `openFeaturePr` pre-flight and error surfacing as in F10; PR body template from plan `## Context` + Task titles; default branch from `gh repo view`.

Acceptance: a fixer that pushes then times out → re-await, not "merge yourself"; a fixer that pushes nothing → disagreement comment posted, loop stops; a fixer cannot run `git pr-await` (guard test); same-findings-twice stops the loop.

### Phase 3 — Task and QA lifecycle — **DONE 2026-09-02**

One commit, `14c2967`. The four findings all touch the same function, `runFeatureChain`, so splitting them across commits would have split single edits. The suite went from 309 to 322 passing, all green; `tsc --noEmit` clean.

| Finding | What landed |
|---|---|
| F11 | `porcelainStatus`, `firstTaskBlockedByDirtyTree`, `ensureWriterCommit`; the gate is closed after every writer, Task and fixer. |
| F12 | `DEFAULT_QA_PASS_CAP` 1 → 2; one automatic retry of a failed QA child. |
| F13 | `settleTaskOutcome` gains `gated`; `taskGateResult`; `orphanDecision` follows the same rule; `gate:` on the handoff line. |
| F14 | `reviewer_run_id` / `reviewer_run_dir` in status.md; `planReviewReconcile` + `reconcilePlanReview`. |

**F11 — the commit gate is code's, not the worker's.** A writer's only git operation is `git commit`, and it was the one they skipped most. `worktreeFingerprint` is HEAD plus porcelain, so unstaged edits counted as a land: the Task went `done`, the next worker started on a dirty tree, feature-qa reviewed uncommitted code, and `openFeaturePr` pushed a HEAD that did not contain the work. Now `ensureWriterCommit` runs after every writer — `git add -A` (a worker's new files are as much of the Task as its edits) then a deterministic `Task N — title` or `fix: review round N` — and re-reads porcelain to confirm the tree actually cleared. A commit that fails blocks the Task with git's own stderr rather than advancing over work that is not on the branch. On the fixer path the gate runs *before* `branchHeads`, or an uncommitted fix would read as `push: "none"` and F6 would post a disagreement over a round that had done its job.

Before Task 1 the rule is the opposite: `firstTaskBlockedByDirtyTree` refuses. Nothing has run yet, so uncommitted changes are not this Feature's, and committing them under a Task message would attribute a stranger's edits to this plan — which is exactly what `ice-wt/feat-per-coin-mining-claim` was accumulating. The refusal names up to eight files. Git that cannot answer is inconclusive at both ends: it never blocks the Feature and never counts as clean.

**F12 — the second QA pass is the one that checks QA's own fixes.** With cap 1, the remediation Tasks feature-qa asked for were implemented and then never looked at again; the PR opened on unreviewed fixes. Cap is now 2 — QA → fix → QA → fix → PR — still bounded by `MAX_QA_PASS_CAP`, and an explicit `qa_pass_cap: 0` still opts out. A QA child that dies in transport or misses its schema is retried once before the Feature parks; that failure mode had been costing whole Features a manual `/orchestrate resume`.

**F13 — a red gate is a fact, and facts do not auto-advance.** `failed_but_landed` was written for the 39% of Tasks with no runnable `- Command:`, where a harness failure plus a changed worktree usually means only the child's self-report failed. Applied to a Task whose gate actually ran and came back red, it marked the Task done and built the next one on top of it. `settleTaskOutcome` now takes `gated`, and a gated failure returns `blocked` / `failed_gate` regardless of what landed. `orphanDecision` takes the same flag: recovery must decide what the live chain would have decided, or it becomes the softer path. plan.md records `gate: red|green|none` on the Task's `- Handoff:` line, so the next reader does not re-derive it.

**F14 — a dead reviewer is no longer a wedge.** `reviewPlan` wrote `plan_review: running` and recorded nothing else, so a session that died mid-review left a field that `writerBlockedByPlanReview` read forever: every approve and resume refused, and the approve card hidden. It now records `reviewer_run_id` / `reviewer_run_dir`, and `reconcilePlanReview` reads that run's own `status.json` before either gate consults the field — terminal-ok → `done`, terminal-fail or no artifact at all → `failed` (review re-runs), non-terminal → wait, exactly as Tasks do. "No artifact" is safe to call dead here because this runs under the chain lock: a genuinely live review is one this process started and would have recorded.

> One thing the plan implies that this does not do: `draftApproveCards` still requires `plan_review: done`, so a wedged Feature's card stays hidden until something reconciles it. Reconciliation happens inside `beginImplementation`, under the chain lock, which is the right place for a write — doing it while rendering cards would put a status.md write on every redraw. So the recovery path for such a Feature is to type `/orchestrate approve <name>` rather than to click the card. Phase 4 rewrites that card path (F15/F16) and is where this belongs.

**Still open after Phase 3.** Everything carried forward from Phase 2 — the four Features parked at `phase: pr` with `pr: none`, the cross-repo residuals (`ghl-monitor.sh` respawn, the Rust per-PR lock, the naming change unlanded in `gh-pr-reviewer` main) — plus this repo still having no `origin`, so nothing here can exercise the PR lifecycle end to end.

Original plan, as written before implementation:

#### Phase 3 — Task and QA lifecycle (F11, F12, F13, F14)

3.1 Commit gate after every writer: porcelain empty and HEAD advanced, else code commits (`Task N — title` / `fix: review round N`) or blocks with `reason: dirty worktree`. Refuse to start Task 1 on a dirty tree. `tdd-worker.md`: "commit this Task; never push".

3.2 `DEFAULT_QA_PASS_CAP = 2`; one automatic retry of a QA child on `-1`; after the cap, go to PR even if QA added nothing.

3.3 `settleTaskOutcome`: `failed_but_landed` advances only when the Task had no verified gate; otherwise `blocked` with `gate: red` in the handoff line. Flip `autoAdvanceOnLanded` default to apply only to ungated Tasks.

3.4 `reviewPlan` records `reviewer_run_id`/`reviewer_run_dir`; `beginImplementation` reconciles it with `readRunSnapshot` before consulting `writerBlockedByPlanReview`.

Acceptance: a Task that edits but does not commit ends `done` with a code commit on the branch; a red gate never auto-advances; QA runs twice; a dead reviewer no longer blocks approve.

### Phase 4 — Plan → approve — **DONE 2026-09-02**

One commit, `a6ac0a9`. All three findings edit the same two call sites — the approve verb and `beginImplementation` — so splitting them would have split single edits, as in Phase 3. The suite went from 322 to 331 passing, all green; `tsc --noEmit` clean.

| Finding | What landed |
|---|---|
| F15 | `presentDraftApproveCards` is read-only; naming happens once, in the planner completion path, inside the chain lock. |
| F16 | Approve validates first; `> Status: APPROVED` is written by `beginImplementation` under the lock, after the worktree exists. |
| F22 | `git wt <branch> --yes`; the `GIT_WT` shell fallback and its constant are deleted; `ghl-wt`'s stderr leads the failure message. Approve pre-flights `origin`. |

**F15 — the card path renames nothing now.** `presentDraftApproveCards` ran from `agent_settled` and called `ensureFeatureNamed` on every unnamed draft with a title. That renames `pending-<utc>` to `<name>` — while the planner child is still writing to the path it was handed. The planner recreated the pending folder, the completion path named that one too, and `uniquifyName` appended `-2`. The naming call and the `bindFeature` beside it are gone; a test scrapes the function body for both, because the defect is the *presence* of a write in an event handler rather than anything about its result.

Naming now happens in exactly one place: after `runChildInPhase(planner)` resolves, inside `withChainLock`, alongside `reviewPlan`. The lock is keyed on the pre-rename `featureDir` captured in a local — `feat` is rebound by the rename, so keying on it directly would have released a lock under a name it was never taken under.

**One thing I expected to have to fix, and did not.** Removing the rename from the card path looked like it would strand a folder such as `pi-extensions/pending-2026-08-31T19-08-48-820Z` — a real plan the review found stuck at `name: pending` — behind a card that no longer appears. It does not. `draftApproveCards` takes its name from `featureIdentityName`, which derives the slug from the `# Feature:` title without writing anything, and `discoverFeatures` derives the same slug when resolving `/orchestrate approve <name>`. So the card still shows, the command still resolves, and approve does the rename at a moment when no planner is running. The test asserts precisely that: one card, name `something-real`, `dir` still the `pending-*` folder. The card renders an identity; it no longer creates one.

**F16 — the marker is the last write, not the first.** The verb rewrote `> Status: APPROVED` before checking anything, so a failure anywhere downstream left the plan approved with nothing running: `isDraft` is then false, the card is never re-offered, and `defaultFeature('approve')` stops finding the Feature — which is exactly how `durable-pr-reconciler-2` ended up unreachable. The order is now the one the finding asks for. The verb does only read-only checks and the naming call; `beginImplementation` gained an `{ approve: true }` option and writes the marker inside the chain lock, after `ensureFeatureWorktree` has returned a directory and after `taskCountError` has passed — the last point at which anything can still refuse. The DRAFT guard at the top of `beginImplementation` is skipped for that call, or it would reject the very approve about to lift it.

`markPlanApproved` is now a pure function (rewrite the `> Status:` line, else insert after the title, else prepend) rather than three inline regexes, so the branch that mattered — replacing DRAFT rather than duplicating it — is pinned by a test.

**F22 — one worktree implementation.** `ghl-wt` prints `Proceed? [y/N]` and reads stdin; under `pi.exec` stdin is empty, `should_proceed(false, "")` is false, and the binary exits `aborted`. So the Rust path had never once succeeded from orchestrate, in any repo — every worktree the extension ever made came from the `~/glm-review/git-wt.sh` fallback, whose different semantics produced the `fatal: invalid reference: origin/main` the user saw. The call passes `--yes`, and the fallback plus its constant are deleted. `worktreeFailureMessage` puts `ghl-wt`'s stderr verbatim on the second line, under a first line naming the exact command that failed; the old message led with "No usable worktree" and buried git's answer, which is why a missing remote read as an orchestrate bug.

The origin pre-flight is where the honest refusal lives. `approveRemoteRequirement` fails approve in one line — naming the repo and the missing remote, with no newline in it — when `git remote get-url origin` comes back empty, because `ghl-wt` branches off origin, `gh pr create` needs a remote and `pr-await`/`pr-land` need a PR: a Feature in such a repo could never finish, and refusing at approve is cheaper than discovering it three phases later. Host bases are exempt; they materialize a worktree by copy plus `git init` and never open a PR.

**Deliberately not done: the `ghl-wt` half of 4.3.** The no-origin base resolution and the `--base` flag are Rust, in `gh-pr-reviewer`, and landing them means a branch and a PR in a second repository. No Phase 4 acceptance criterion depends on them any more: with the origin pre-flight in place, orchestrate never hands `ghl-wt` a repo without a remote, so the no-origin path would be dead code from this caller's point of view. It remains worth doing for solo use — `git wt` in a local-only repo still fails with a git internals dump — and it is carried forward with the other cross-repo residuals rather than dropped.

**Acceptance.** No `pending-*` folder survives a completed plan and no `-2` arises from self-collision, because only one code path renames and it runs after the planner has exited. A failed approve leaves the plan `DRAFT` with the card visible, because the marker is written after the last refusal. Approve in a repo without `origin` refuses in one line and writes nothing. Approve in a repo with `origin` creates the worktree via `git wt <branch> --yes` with no shell script anywhere in the process tree — a test asserts the string `GIT_WT` no longer occurs in the source at all.

**Still open after Phase 4.** This repo still has no `origin`, which now has a visible consequence rather than a buried one: `/orchestrate approve` here refuses with the one-line reason. The four Features parked at `phase: pr` with `pr: none` are unchanged, as are the cross-repo residuals — `ghl-monitor.sh` respawning from `pi-*.latch.json`, the Rust waiter taking no per-PR lock, the naming change unlanded in `gh-pr-reviewer` main, and now the `ghl-wt` no-origin path and `--base` flag.

Original plan, as written before implementation:

#### Phase 4 — Plan → approve (F15, F16)

4.1 Move `ensureFeatureNamed` out of `presentDraftApproveCards`; name only in the planner-completion path under the chain lock; `agent_settled` only draws cards for already-named Features.

4.2 `approve`: validate → lock → `APPROVED` → chain. Validation includes `git remote get-url origin` (F22).

4.3 Worktree creation through the Rust command only (F22): `ensureFeatureWorktree` calls `ghl-wt <branch> --yes`; delete the `GIT_WT` shell fallback; `ghl-wt` gains a no-origin path (base = local default branch, no remote probe) and a `--base` flag; stderr passes through verbatim.

Acceptance: no `pending-*` folder survives a completed plan; no `-2` suffixes from self-collision; a failed approve leaves the plan `DRAFT` and the card visible; approve in a repo without `origin` refuses with a one-line reason and writes nothing; approve in a repo with `origin` creates the worktree via `ghl-wt --yes` with no shell script in the process tree.

### Phase 5 — Skill split, file ownership, tests — **DONE 2026-09-02**

Four commits, one per sub-item: they touch four disjoint areas, so unlike Phases 3 and 4 there was nothing to gain by combining them. The suite went from 331 to 348 passing, all green; `tsc --noEmit` clean.

| Sub-item | Commit | What landed |
|---|---|---|
| 5.2 / F20 | `a6d0dbd` | `waiterStatePath` + `seedWaiterState` + `isExtensionOwnedStateFile`; the shared `pi-<id>.json` is gone; `ghl-monitor.sh` no longer passes `*.latch.json` to `--state`. |
| 5.3 / F18 | `c888d51` | `fs.watch` on the state dir; `WATCH_BACKSTOP_MS = 10 min` replaces the 15 s `gh pr view` poll. |
| 5.1 / F17 | `c016790` | `SKILL.md`'s `## /orchestrate` section replaced by a `## Scope` block; `~/.claude/CLAUDE.md` reworded; both hooks kept, with the reason recorded. |
| 5.4 / F21 | `dc762cf` | `FEATURE_PHASES` / `FeaturePhase` / `LEGACY_FEATURE_PHASES`; four schema tests. |

**F20 — the shared file is gone, not merely tidied.** The extension handed `ghl-pr-await` `pi-<id>.json` as `--state`, having first seeded that same file with its own latch: `pid`, `sessionId`, `origin`. The waiter rewrites `--state` wholesale on every poll, so the seeded identity vanished on the waiter's first write and what came back was an ownerless latch — read as a session's own record on the next `session_start`, and offered to `adoptableLatch` as an unheld PR. That is the mechanism behind "a PR #11 verdict overwrote a #18 latch" and behind sessions waking about PRs they had never awaited.

The waiter now gets a file of its own. `waiterStatePath` picks an existing `manual-*.json` for the PR, or spells a new one; `seedWaiterState` writes `{pr, cwd}` and nothing else — byte for byte what `ghl-pr-await`'s own `spawn_handoff` writes before it spawns a daemon, which is *why* a seed is needed at all: the `--daemon` hop takes no positional PR and reads both fields out of that file. A file that already names this PR is left alone, because it may hold an undelivered verdict, and re-seeding over one is how a finding vanished (F4). Alongside that: the `session_start` fallback that read the shared file as a latch is deleted, `writePid`/`clearPid` are deleted (nothing called them; `drive-*.pid` is the waiter's), and `persist()` no longer removes the waiter's file when the latch is cleared.

> `stripStaleWaiterRound` had to go a different way. It existed for a real defect — a yield handoff carries no `round=`, the waiter's file still holds the previous cycle's, and the spinner stuck on r3 across a new wait — but it fixed it by deleting fields out of a file this module does not own, which is the same violation in miniature. The staleness is now recorded on the latch as `roundStale` and filtered on read. Same answer, one writer, and it self-clears the moment the waiter writes any other round.

**One write to a waiter file survives, deliberately.** `markVerdictDelivered` sets `verdictDelivered: true` on `manual-*.json`. That looked like the next thing to remove until the Rust side settled it: `pr_latch.rs` both reads that field and has its own `mark_verdict_delivered`, with the same parse-first torn-JSON guard. It is a shared protocol flag, not state — one writer per *fact*, which is what F20 is actually about. The rule in the code now says so explicitly rather than leaving the exception to be rediscovered.

**The monitor was the other writer.** `ghl-monitor.sh`'s respawn loop globs `"$LATCH_DIR"/pi-*.json`, which matches `pi-<id>.latch.json`, and then runs `ghl-pr-await --state "$f" --daemon` on it — handing the extension's private latch to the waiter to rewrite. One `case` skips it now. That script lives in `~/.local/bin` and is under no version control, so it is changed in place and recorded here rather than in a commit; it is the first of the carried cross-repo residuals to actually close.

**F18 — the waiter is the poller.** Every latched session ran `gh pr view` every 15 seconds, behind a waiter and a monitor already asking GitHub about the same PR. `startWatch` now arms `fs.watch` on the state directory: a waiter write is debounced 250 ms and drains `checkActionable`, which is local file reads only. A `gh` call is spent only when the waiter's own state already says the PR is over — `next=done`/`stop`/a land verdict, or its state file deleted, which is how the waiter reports a terminal PR by another route. The timer survives at `WATCH_BACKSTOP_MS = 10 minutes`, unref'd, for the one case an event cannot cover: a waiter that died without writing anything. Chrome keeps its 1 s tick; it never touches the network.

The tests are set up so they can only pass for the right reason: the backstop is set to ten minutes and the assertion runs after 500 ms, so nothing but `fs.watch` can have carried the verdict. A `round=` write costs no `gh` call; a terminal one does.

**F17 — the skill is a solo prompt again.** The `## /orchestrate` section documented extension internals (`drivePrAwait`, `armObservedLatch`), repeated one paragraph verbatim, and restated the writer contract in a file no writer is handed any more — Phase 2 removed `skills:` from `fixer.md` and `reviewFixLaunchParams`. It is replaced by a short `## Scope` block that says which sessions the skill is for and, for one that is not solo, that code owns the lifecycle and `git-workflow-guard` blocks the rest. Everything the deleted section claimed is asserted against `gitWorkflowBlock` instead, which is the string code actually inlines.

> **The hooks stay, and the reason is a fact rather than a judgment call.** F17 asked for `resources_discover` and `before_agent_start` to be deleted *or* gated correctly, and Phase 1 recorded the deletion as Phase 5 work. Checking `~/.pi/agent/settings.json` before doing it changed the answer: it registers only `skill-author`. That one `resources_discover` line is the only thing publishing `git-workflow` to a pi session at all, so deleting it would not stop the skill leaking into orchestration — it would take the skill away from exactly the solo sessions it was just rescoped for. It publishes a path, not prompt text, and the path no longer leads to orchestration policy. `before_agent_start` already has the narrow predicate F17's own recommendation names, from Phase 1. The reasoning is in the source and pinned by a test, so the next reader does not have to rediscover it.

**F21 — the phase schema.** `phase` is free text in a text file, matched by regexes and `Set`s in three modules, with nothing keeping the writers and readers in agreement — and they were not. `FEATURE_PHASES` declares the eight values and `upsertStatusFile`'s patch takes `FeaturePhase`, so an undeclared phase no longer compiles; that direction is closed at build time and the existing code needed no edits to satisfy it. Four tests close the other direction, which is the one F8 fell through: every literal a reader matches must be one a writer produces. `LEGACY_FEATURE_PHASES` names the read-only spellings — `qa`, still accepted by `needsPlanReview` and `featureIsActive` so a Feature parked under an older build stays visible — and a test asserts nothing writes them. A fourth pins `IDLE_PARENT_PHASES` to exactly the three phases in which a Feature owns a writer, with the reasoning for the exclusions in the failure message.

The rest of F21's list was already discharged: (a) and (d) in Phase 1, (b) by the reconciler tests, (c) by P2 F5, (f) by P3 F12, (g) by P3 F11, (e) and (h) in Phase 4.

**Acceptance.** No file in the state directory has two writers: `pi-<id>.latch.json` is written only by the extension, `manual-*.json` and `drive-*` only by the waiter apart from the two named protocol writes, and the monitor no longer touches the extension's file. A latched session makes no GitHub request until either the waiter says something or ten minutes pass. The git skill contains no `/orchestrate` section and names no extension internals. A phase value that no reader matches will not compile, and a reader that matches a phase nobody writes fails a test.

**Still open after Phase 5.** The four Features parked at `phase: pr` with `pr: none` are unchanged — bookkeeping, not code, and there is no PR for the reconciler to ask about. This repo still has no `origin`, so the PR lifecycle cannot be exercised end to end here; since Phase 4 that at least refuses loudly at approve. Cross-repo residuals: the Rust waiter still takes no per-PR lock, the naming change is still unlanded in `gh-pr-reviewer` main (so both spellings must keep being read), and `ghl-wt`'s no-origin base path and `--base` flag are still not written. The `ghl-monitor.sh` respawn is no longer among them. §5's explicit state machine is not assigned to a phase; `FEATURE_PHASES` is the first half of it — the enum exists now, and what is missing is the single `transition(paths, from, to, reason)` writer, the illegal-move refusal, and `handoffs/transitions.log`.

Original plan, as written before implementation:

#### Phase 5 — Skill split, file ownership, tests (F17, F18, F20, F21)

5.1 Split `SKILL.md` per F17; remove the `/orchestrate` section and the duplicate paragraph; update `~/.claude/CLAUDE.md` wording to "solo git operations".

5.2 File ownership rule (F20) enforced in code: TS writes `*.latch.json` only; delete the `persist()` seed of `stateFile`; the waiter's `--state` path is always its own file; monitor read-only for `*.latch.json`.

5.3 Replace per-session 15 s `gh pr view` polling with `fs.watch` on the state dir plus the reconciler timer.

5.4 Tests listed in F21, plus a `status.md` schema test (every `phase` value written is one the readers match).

---

## 5. Proposed explicit state machine

Making the phase a real enum with a transition table is the single biggest determinism win; today `phase` is free text matched by five different regexes.

```
planning ──planner ok──▶ reviewing ──reviewer ok──▶ approvable ──approve──▶ implementing
implementing ──task green (commit gate)──▶ implementing | ──all done──▶ feature-qa
feature-qa ──findings──▶ implementing | ──clean or cap──▶ pr-opening
pr-opening ──pr created + pushed──▶ pr-waiting
pr-waiting ──read_comments_and_fix──▶ pr-fixing | ──merged──▶ done | ──closed──▶ stopped
pr-fixing ──pushed──▶ pr-waiting | ──no push / same findings / cap──▶ disagreed
any ──user pause──▶ paused ──resume──▶ previous
any ──error──▶ blocked ──resume──▶ previous
```

status.md additions: `phase` (enum), `pr_head`, `fix_rounds`, `last_findings_hash`, `pending_verdict`, `disagreed_head`, `reviewer_run_id`, `reviewer_run_dir`, `gate` per Task row. Every transition is written by one function (`transition(paths, from, to, reason)`) that refuses illegal moves and logs to `handoffs/transitions.log`, which also gives a durable trace for the next QA pass.

---

## 6. Files touched by this review (for the follow-up implementer)

- `src/orchestrate.ts`: 88, 1016-1055, 3159-3171, 3338, 3365-3444, 3457-3466, 3498-3524, 3533-3585, 3704-3716, 3726-3808, 3821-3902, 4028-4302, 4636-4751, 4774-4813, 4964-5017, 5177-5297, 798-839, 1716-1750, 450, 510-512.
- `~/Dev/git/gh-pr-reviewer/crates/ghl-cli/src/bin/wt.rs`: 47-50 (default base `origin/main`), 55 (`remote.origin.url` hard error), 73-84 (y/N prompt), 103 (`ls-remote origin`), 146-162.
- `~/glm-review/git-wt.sh`: legacy fallback, to be deleted from the orchestrate path.
- `src/pr-await-latch.ts`: 166-171, 217-247, 295, 466, 515-538, 556-631, 737-782, 799-860, 897-900.
- `src/lib/pr-await-core.ts`: 648-743, 745-790.
- `src/lib/git-workflow-guard.ts`: 42-57.
- `~/.pi/agent/agents/tdd-worker.md`, `fixer.md`, `feature-qa.md`.
- `~/.grok/skills/git-workflow/SKILL.md`: 33-42, 48-58.
- `~/.local/bin/ghl-monitor.sh`: 280-334.
- `~/Dev/git/gh-pr-reviewer/crates/ghl-cli/src/pr_await.rs`: 676, 695 (naming divergence from the installed binary).
