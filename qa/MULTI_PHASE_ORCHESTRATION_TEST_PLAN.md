# Multi-phase / multi-feature orchestration remediation and verification plan

Reviewed 2026-09-06. Status: **not ready for an unattended GRAPH_FABLE_QA phases 3+4 run**.

User requirement added during review: the **todo tool** must work with orchestration, and the user must always see clear status: what is done, what remains, and which Feature is active. This is a release requirement, not optional UI polish. Retain a useful completion summary; earlier tests expecting an empty board at Program completion must be revised to this requested behavior.

**Implementation handoff:** sections 1–4 and 7 record the reviewed baseline; sections 5–6 specify test scenarios and readiness; **sections 8–12 settle the design, migration, implementation order, and final acceptance**. Follow all of them. New requirements in sections 8–12 supersede implementation alternatives in the earlier review. This document is a plan to implement and verify fixes, not evidence that the fixes already exist. No implementation task is complete yet.

## 1. Scope and version evidence

This review covers serial phase execution, multiple child Features, multiple Programs, and multiple Pi processes. It does not launch agents, PRs, deployments, or purges. All diagnostic mutations were in temporary directories; existing dirty source files were preserved.

| Location | Observed state | Capability |
| --- | --- | --- |
| `/Users/greg/Dev/git/pi-orchestrate` | `main`, HEAD `a62dda705b77bec944547190e406b278b823c743`, substantial pre-existing dirty changes | Single-Feature chains; no Program module or Program command |
| `/Users/greg/Dev/git/pi-orchestrate-wt/feat-close-then-next-feature` | Clean at `3a5b2293e48a6bffd5e1dec11d96a1e95c5364d7` | Program parser, durable child table, subset, serial stepper, draft planning/review, archive |
| `~/.pi/agent/settings.json` | Package entry `../../Dev/git/pi-orchestrate` | Configured package points at the first checkout, not the Program branch |

An already-running session can have other launch arguments or loaded code; its actual module provenance was not inspected. Do not equate the feature branch with the configured or running extension. The README's loose-autoload description is stale here: `~/.pi/agent/extensions/orchestrate.ts` does not exist.

All source references below, unless marked main, refer to the **Program branch at the SHA above**. Do not apply a patch based on main's older monolithic file to that branch, or copy its entire diff back over dirty main. Recheck the implementation base before starting this plan.

## 2. What is implemented

- Tasks within one Feature run serially, followed by Feature QA and one Feature PR.
- Programs persist a child table and cursor. Markdown `### Phase N — ...` headings become Features. `phases 3+4` is recognized and stored as `3,4`.
- A Program waits while its current child is in `pr`; it proposes the next child after `done`. This is a serial scheduler, not a dependency DAG or parallel-phase executor.
- A pre-approved Program drives DRAFT children through planner → plan-reviewer → implementation. Existing APPROVED children take a shorter path.
- `RUNNING_CHAINS` plus `DRAFT_STARTS` exclude another chain in the same module/process. Session start, command handling, and a 60-second timer can step Programs discovered on disk.
- There is no demonstrated cross-process execution claim. Multiple Programs are walked in sorted order and share one process's execution capacity; fairness and competing-session ownership are not established.

These are useful foundations, but the current integration breaks important contracts below.

## 3. Validation run

Commands run in each checkout:

```sh
rtk npm run check
```

Actual executions redirected the complete output to `/tmp/pi-orchestrate-main-check.log` and `/tmp/pi-orchestrate-program-check.log`.

| Gate | Result |
| --- | --- |
| Main typecheck + suite | Typecheck passed; **449 passed, 0 failed, 0 cancelled** |
| Program branch typecheck | Passed |
| Program branch full suite | **221 passed, 0 assertion failures, 244 cancelled**, 465 total; not green |
| Program branch selected legacy + Program tests below | **48 passed, 0 failed, 0 cancelled** |
| Program branch selected overlay / C3 tests | **15 passed, 0 failed, 0 cancelled**; overlaps the 48-test selection |

```sh
rtk proxy node --experimental-strip-types --test --test-name-pattern='^(C[0-9]:|D[0-9]+:|E:|F:|H2:)' test/orchestrate.test.ts test/program-state.test.ts
```

Selected output: `/tmp/pi-orchestrate-program-targeted.log`. These 48 include legacy PR dispatch tests as well as Program tests; they are not 48 end-to-end Program scenarios.

The first cancellation is `M2: an unrelated early completion is still ignored` (`test/orchestrate.test.ts:253`), with `Promise resolution is still pending but the event loop has already resolved`. The test awaits a timeout via `withDeadline`, whose timer is unref'd (`:167`). Later tests in that file are cancelled, including Program tests. The test harness must hold its own deadline alive and settle/clean up the outstanding fake run.

Overlay selection command: `rtk proxy node --experimental-strip-types --test --test-name-pattern='^(overlay:|C3:)' test/orchestrate.test.ts`; complete output at `/tmp/pi-orchestrate-todo-targeted.log`.

Existing coverage includes Program status round-trips, child ordering, ownership refusal between differently named Programs, legal transitions, pure step decisions, in-process writer exclusion, APPROVED start, DRAFT planner/reviewer delegation, missing-base rejection, all-children-done archive, parser grammar and heading-shaped seeding, alert deduplication, and overlay mapping.

Coverage is insufficient because several integration tests replace `runChain`, `ensureWorktree`, `reconcileOrphan`, or `beginImpl` with hooks. D2 proves delegation to a stubbed `beginImpl`, not that a real newly named child remains addressable. D0 calls the stepper directly and checks source text for lifecycle wiring; it is not a process-restart test. The fixture explicitly contains placeholder bodies, not the real phase requirements.

## 4. Findings

### MP-01 — Program child naming breaks durable membership (P0, reproduced)

`startDraftProgramChild` calls real `beginImplementation`, which calls `ensureFeatureNamed` (`src/orchestrate.ts:6389`). The planner is explicitly told to produce a new short title and leave Name/Branch pending (`:6148`). `applyFeatureIdentity` / `promoteLiveFolder` rename the seeded Feature (`:1900`, `:462`). Neither updates the Program child table. `listProgramChildren` resolves paths using the old table name (`src/lib/program-state.ts:469`).

Probe: seed the real document with subset `3+4`; name phase 3 from a planner-shaped plan titled `Daemon parity implementation`. The directory moves to `daemon-parity-implementation`; the old directory no longer exists; the Program still resolves the original `the-daemon-is-the-derivation-parity-p3` row with no phase. The stepper can treat that missing child as unstarted. The current D2 test stubs precisely the naming/implementation boundary that would expose this.

### MP-02 — Selected-subset completion archives unfinished, unselected phases (P0, reproduced)

Seeding creates **all eight** phase Features, even for `3+4` (`src/orchestrate.ts:7324`). The pure stepper finishes after the subset, but `archiveProgramNow` loops over **all** children (`:7012`).

Probe: leave 0,1,2,5,6,7 in planning; mark only 3 and 4 done, cursor 4, Program running; step once. All eight child folders and the Program move to archive. Unselected work is not deleted, but it disappears from live discovery and the Program is terminal. This prevents straightforward continuation into later phases. Existing D4 only covers a Program whose entire child set is done.

### MP-03 — Multiple Pi processes can drive the same Program (P0 for concurrent sessions, reproduced primitive + source reachability)

`withChainLock` is an in-memory Set (`src/orchestrate.ts:4918`). `stepProgramNow` scans every live Program; `session_start` invokes it without filtering execution by `parent_session_id` (`:6829`, `:7575`). That field is used for overlay selection, not a durable execution lease. DRAFT planner start has no cross-process claim.

Probe: hold `withChainLock('/same/feature')` in one Node process; import the same module in a second process and request the same lock. The second returns `true` while the first still holds it. This proves the primitive does not provide cross-process exclusion; a complete two-session DRAFT-start test is still required. Task orphan snapshots provide some separate protection after task startup and do not repair the initial claim race.

### MP-04 — The real phase requirements are not reliably delivered (P0, reproduced)

`parseProgramPhases` collects at most eight nonempty lines and truncates the note to 400 characters (`src/orchestrate.ts:7216`). The DRAFT planner objective contains only Program name, child index and slug (`:6766`). The Program stores the full source path, but the child prompt does not explicitly direct the planner to that source, its full phase section, global rules, or decisions.

Probe on `/Users/greg/plan/GRAPH_FABLE_QA.md`: phase 4's seeded plan has neither item 4.6 nor its explicit go-ahead constraint; the planner prompt has no absolute source document path. A model could discover the document indirectly, but the orchestration contract does not ensure it. Phase 3's later requirements likewise exceed the excerpt. The heading-only fixture cannot catch this.

### MP-05 — Changing the subset leaves the old cursor runnable (P1, reproduced)

`setProgramSubset` writes only `subset` (`src/orchestrate.ts:7444`); `stepProgram` prefers an existing cursor even when it is outside the new subset (`src/lib/program-state.ts:674`). Probe: cursor 3 in planning, change subset to `4`; setter returns success, next decision is `run_child`, cursor `3`. Define an explicit refusal or cursor reconciliation policy, including changes during active work.

### MP-06 — PR completion is not a proven phase dependency gate (P0 for phases 3→4, source-established gaps)

`childMergeSha` uses `merge_commit`, otherwise `pr_head`, otherwise waiter verdict head (`src/orchestrate.ts:6637`). The source's PR-state query asks for `headRefOid`, not `mergeCommit` (`:4763`). `baseHasChildMerge` returns success without a git call for an empty SHA (`:6680`). A PR head is not generally the squash/rebase merge commit. A missing predecessor record can bypass the check; a squash merge can fail it incorrectly. Predecessor selection is by lower numeric index, not actual subset execution order (`:6794`, `:7129`).

The stepper gates on child phase `done`, not the document's measurable phase exit gate. GRAPH Phase 3 includes code parity plus a devnet check explicitly deferred until Phase 7; that dependency needs an explicit split into code-completion and later validation obligations. Do not let a PR merge silently certify the whole phase exit gate. Closure without merge, missing evidence, stale remote refs, and actual phase acceptance must be covered together.

### MP-07 — Pause, recovery, and retries are not tested through actual lifecycle triggers (P0/P1, source risks; not all reproduced)

- Every command fires `stepProgramNow` **before** interpreting pause/subset commands (`src/orchestrate.ts:7666`). A runnable child can start before pause is persisted.
- DRAFT start does not recheck Program pause after planner/reviewer awaits. Program `pause now` tries only `worker_run_id`, while the planner has no persisted ID on this path and review uses separate reviewer fields (`:6739`, `:7808`).
- A failed planner blocks the Program but can leave the child planning. The pure stepper deliberately permits blocked Programs to progress based on the child; the next tick can retry the planner without an explicit retry budget. Preserve legitimate recovery after a child is manually completed without introducing unlimited failing planner retries.
- `stepProgramNow` swallows exceptions; several start refusals return without a durable reason. Archive writes done before sequential moves and excludes done Programs from future discovery, so interrupted archive recovery needs proof.

### MP-08 — Multi-repository and Program identity boundaries are incomplete (P0 for the real phase 4, source-established)

The real phase 4 includes `icemining` changes, `icemining-devops` playbook/runbook work, and an operational purge. Tasks can select another repository (`src/orchestrate.ts:3242`, `:5077`), but a Feature still lands one PR using its primary worktree (`:5865`). A phase-to-one-Feature mapping does not track completion of both repositories' PRs and the operational gate.

Program discovery/selection and `blockProgramForChild` match basename across repository roots (`:6585`, `:6980`). Two repositories can have Programs with the same slug. A block or command must not act on whichever sorted directory matches first. Child join also needs tests for wrong-repository links, replacement of a seeded row, duplicate index/child, and disagreement between table membership and the child's join fields.

### MP-09 — Todo does not consistently show Program truth (P0 under the user's status requirement, reproduced + integration risks)

The installed `@juicesharp/rpiv-todo` reports version **2.8.0**. Its actual tool and `/todos` read per-session state from `state/store.ts`; its lifecycle handlers replay session snapshots on start/compact/tree (`todo.ts:78`, `:114`, `index.ts:180`). The orchestrator imports that store and also paints the `rpiv-todos` widget directly (`src/orchestrate.ts:2139–2194`). The source itself notes that extension loading can create a second Map. A successful widget paint therefore does not prove that `todo(action: list)` or `/todos` sees the same state. Actual loader/store identity and replay ordering need an integration test; this review did not claim a live runtime mismatch.

Two concrete projection/publishing failures were reproduced:

1. `upsertStatusFile` ends in `syncOverlayTodosFromPaths`, which projects only the child Feature (`src/orchestrate.ts:2161`, `:2542`), bypassing the session's Program projection. With a real seeded Program and a recording sink, a child update publishes only `Planner`, `Plan reviewer`, `Approve`; the Program and phase-3 row disappear. The Program projection is restored only by another path calling `syncLiveFeatureOverlay`; regular timer stepping does not itself guarantee a board refresh.
2. `overlayTodosFromProgram` hardcodes the Program and cursor child to `in_progress`, ignores the subset in its child rows, and emits `[]` for done (`src/lib/overlay.ts:333`). A paused Program with subset `3,4` displays Program and phase 3 as in progress, phase 0 as pending, and a generic `Todos (1/12)` count that mixes headings, phases, and planner/reviewer rows. It cannot answer “how many selected Features are done?” accurately. No pause reason, blocked reason, or selection distinction is projected on those rows.

Further source risks: the first Program matching a session is selected even if it has several; publication prefers the sink's foreground session instead of an explicit owner; task IDs are reused when cursor Features change; after archive the lookup may return no row without explicitly replacing stale content. Existing C3 tests check IDs and basic projection, not tool/list/widget equality or continuous status through updates and completion.

Required user-facing status contract:

| Information | Required presentation |
| --- | --- |
| Current scope | Program name, repository, selected phases `3 → 4` |
| Feature progress | Selected Features completed / total, separate from current Feature's Tasks completed / total; headings and QA rows must not inflate Task counts |
| Active work | Phase number, full Feature title, current stage, active Task title; show planning/review/QA/fixer explicitly |
| Done work | Completed Feature title, completion state and PR/repo; completed Tasks remain inspectable |
| Remaining work | Ordered selected Features and Tasks; out-of-scope phases explicitly marked not selected, not counted as remaining in this run |
| Waiting/blocked | Distinguish waiting for PR, approval, dependency, paused, blocked and runnable; show concrete reason and next action |
| Completion | Persistent selected-run summary plus deferred/out-of-scope work, including operational gates; no unexplained blank board |
| Multiple Programs | Unambiguous active Program selection plus other active/waiting Programs; no arbitrary first-match display |

Example during the second selected phase (illustrative counts):

```text
GRAPH FABLE QA · icemining · phases 3 → 4 · Features 1/2 complete
✓ Phase 3 — Daemon derivation/parity · PR #… merged
◐ Phase 4 — Evict the poison safely · Tasks 2/5 complete · implementing
  ✓ Validate purge bounds
  ✓ Preserve raw rows on failure
  ◐ Add live-service interlock
  ○ Devops playbook and runbook · icemining-devops
  ○ Verify purge results · waiting for operational approval
Not selected: phases 0, 1, 2, 5, 6, 7
```

This is a semantic contract, not a mandate to flatten every Task onto a huge widget. A compact summary may expand into details, but the active Feature, progress and wait reason must remain visible. `/todos` and the todo tool must expose the same truth.

## 5. Test implementation plan

Implement against the Program-capable integration base selected by R0 in section 10, preserving current work. The following are **planned** tests, not claimed existing tests or completed RED runs. For every new test record: base SHA + dirty diff identity, command, nonzero execution count, exact baseline failure, why it is a product failure, and later GREEN output. A cancelled test or a selector matching nothing is not RED evidence.

Use temporary orchestrator/waiter/session roots; inject all root paths consistently before import. Fake the extension event bus, subagent RPC transport, GitHub/waiter responses and clock. Run real command handlers, naming, status writes, task sequencing, and terminal handling. Use disposable local git repositories where real merge ancestry matters. Never call live git helpers, agents, SSH, Ansible, or GitHub from these tests.

### T0 — Restore the baseline harness (first)

- Location: `test/orchestrate.test.ts`, shared fake RPC/clock helpers.
- Reproduce the M2 cancellation with the full runner. Keep the test deadline referenced, cancel it when settled, and explicitly finish/stop the fake child so it leaves no watchdog/listeners.
- GREEN: both selected tests and the full `npm run check` finish with zero failures/cancellations and all intended tests executed. Do not merely exclude the failing selector or add a global keepalive that hides leaks.

### T1 — Complete document and scope contract (MP-04, MP-08)

- Location: `test/program-input.test.ts`, `test/fixtures/graph-fable-qa.md` or a new bounded rich fixture.
- Fixture: all phases 0–7, long sections, the full structural requirements of 3.1–3.7 and 4.1–4.6, global RED/exit rules, cross-repo item, deferred validation, explicit production approval. Pin source provenance/hash; normal CI must not read the user's live plan.
- Action: invoke the real seed command with `phases 3+4`, approve, capture the actual planner requests.
- GREEN: requests identify the correct source/section and preserve all requirements and constraints, including the late approval clause. No unrelated phase starts. Invalid/duplicate headings, malformed subset, and path errors leave no partial live Program. Model-generated plans cannot silently drop required phase acceptance.
- Baseline: the current 400-character stub omits the late requirements. Capture that assertion as RED.

### T2 — Real DRAFT child identity and phase handoff (MP-01)

- Location: `test/program-lifecycle.test.ts`.
- Action: a fake planner writes a valid newly titled plan with pending Name/Branch and runnable Tasks; complete real review and real `beginImplementation`, using faked git/RPC boundaries. Do not stub `beginImpl` or `runChain`.
- GREEN: the immutable child identity/path remains addressable after the planner changes its display title; persisted join fields and overlay match; Tasks execute once per authorized attempt; after its merged PR the next selected child starts once. Repeated ticks and a fresh module/process never recreate the old folder or replan the completed child. Legacy already-renamed children are recovered through the migration in section 9.
- Baseline: old table name loses its status after naming, as reproduced in MP-01.

### T3 — Durable execution ownership (MP-03, MP-08)

- Location: `test/program-concurrency.test.ts`, subprocess helper under `test/helpers/`.
- Action: use a barrier to start two actual processes over the same DRAFT Program before either records a child run; hold planner RPC until both have attempted admission. Repeat during review, implementation, QA and PR-fixer dispatch. Also test separate Programs, a standalone Feature competing with a Program, and same-slug Programs in two repos.
- GREEN: one owner/spawn per authorized attempt; explicit busy/refusal for contenders; unrelated state untouched. Crash the owner before/after run-ID persistence and prove takeover reconciles existing live work rather than duplicating it. Test stale-owner callbacks after takeover. Implement the transactional claim, operation identity and generation checks in section 8.3; a module Set is insufficient.
- Baseline: both processes can acquire the current lock. The complete multi-session race RED must be established, not assumed from the primitive probe.

### T4 — Subset, membership and archive recovery (MP-02, MP-05, MP-08)

- Location: `test/program-state.test.ts`, `test/program-lifecycle.test.ts`.
- Action: seed 0–7, run only 3+4, leave other children pending. Change subset before start, while a child is active, and after selected work completes. Exercise nonnumeric order if supported (e.g. 4,3), already-done entries, duplicate membership, replacement links, and wrong-repo links.
- GREEN: unselected work remains reachable and runnable later; selected completion is reported accurately without claiming all phases done. Subset edits follow section 8.4: refuse during active work, otherwise create a new selection revision and derive the cursor from it. Membership is unambiguous. Simulate failure after each archive move and restart; archive converges without losing children or stranding an unrepairable terminal Program.
- Baseline: current completion archives all eight; current subset edit to 4 leaves cursor 3 runnable.

### T5 — Phase dependency, merge evidence and per-repo PRs (MP-06, MP-08)

- Location: `test/program-dependencies.test.ts`, `test/pr-reconcile.test.ts`.
- Action: use local git histories for merge commit, squash and rebase; fake the PR API with distinct head/merge OIDs. Cover stale refs, failed fetch, missing SHA, closed-unmerged, repeated terminal events and reversed subset order. Hold one of phase 4's repo PRs open while completing the other.
- GREEN: phase 4 starts only when the approved phase-3 prerequisite gates are proven on the correct base; use actual merge evidence for merged PRs. Missing evidence parks with an actionable reason. Completion accounts for every required repository PR and explicitly deferred/operational obligations. Cross-repo phases **must be decomposed into tracked Features**, as specified in section 8.5; refusing all cross-repo work does not satisfy this plan.
- Baseline: missing SHA bypass and head-vs-merge mismatch are source-established; build and record executable REDs. Do not fabricate a successful devnet exit from a mocked PR merge.

### T6 — Pause, restart, retry limits and scheduler events (MP-07)

- Location: `test/program-lifecycle.test.ts`, `test/program-concurrency.test.ts`.
- Action: register the real extension and fire session_start/commands/timer events. Pause before admission and during planner, reviewer, worker, QA, fixer and next-phase transition; deliver late or duplicate completions. Kill/restart at each persistence boundary, with both live and terminal child snapshots. Exercise planner/reviewer failure across repeated ticks and restarts.
- GREEN: pause is persisted before new admission; pause-now cancels the actual owned run; no later stage launches after pause; resume is precise. Retries have a durable bounded policy and block visibly when exhausted. No lost wakeup after approve/seed, no repeated model work on quiet ticks, no ownership leak, and no starvation caused by one stuck Program scan. Child completion events from other runs are ignored.
- Baseline: source identifies race windows; deterministic barriers must establish the specific RED failures. Include an exception-injected start and prove a durable block/retry reason, rather than silence.

### T7 — Acceptance scenario for GRAPH phases 3→4 (last gate, after T8)

- Location: `test/program-graph-fable.e2e.test.ts`.
- Drive the real extension from the phases-3+4 command to selected-work completion: seed → approve → planner → reviewer → naming → task RED/GREEN evidence → Feature QA/remediation → PR wait/fix/merge → predecessor verification → phase 4. Reuse rich fixture and transport fakes from T1–T6.
- Interleave a second session and another Program; interrupt once during draft planning and once at the 3→4 boundary. Assert one launch per authorized attempt and correct ownership after recovery; ambiguous external outcomes must park for reconciliation rather than be blindly replayed.
- Assert phase-4 code/devops PR accounting and a durable operational approval gate. Program approval must not substitute for the document's separate explicit production go-ahead. Faked production mutation calls remain zero until that gate is explicitly satisfied in the fixture. Phase-7-dependent checks remain visibly deferred.
- At **every durable transition**, compare actual `todo(action: list)`, `/todos`, visible widget, and disk state. Assert the Program overview stays visible while a child updates, completed phase 3 stays visible throughout phase 4, and active Feature/Task and wait reasons are correct. Include foreground session switches and an unrelated todo-tool call between transitions.
- Assert only 3 and 4 execute, other phases remain reachable, a persistent completion summary reflects actual selected scope, and a fresh process re-derives the same state without extra agent launches.
- This is currently missing coverage, not a claimed observed full-run RED. T1–T6 and T8 must be green first; then this scenario and the entire suite must pass.

### T8 — Real todo-tool, status and widget integration (MP-09; mandatory before T7)

- Locations: `test/program-todo.test.ts`, `test/program-todo-loading.test.ts`, shared runtime harness under `test/helpers/`. Pin the real todo package and compatible Pi loader in the test environment; do not depend on an unversioned user-home installation in CI.
- Load **both extensions through the actual extension-loading path**, including isolated module caches, in both registration orders. Capture the registered todo tool and `/todos` command and invoke them with real session contexts. A fake `setOverlayTodoSink` alone is not this gate.
- Lifecycle matrix: seed, approve, planner progress, review, naming, Task start/done/block, QA remediation, PR wait/fix/merge, 3→4 handoff, pause/resume, error, selected completion/archive. At each point assert the user-facing contract above across tool/list/widget/disk. Use event/barrier completion rather than sleeping 60 seconds; status publication follows the durable write without waiting for a model turn or poll tick.
- Verify Program projection on **every child write**, not just session start. Keep done Feature rows while the next child expands; show completed Tasks and remaining Tasks accurately. Distinguish inactive/not-selected/paused/blocked/waiting; never present a stopped Program as actively executing.
- Exercise session_start, compaction, tree navigation, reload and shutdown in both extension handler orders, including stale contexts and late child events. Replay must not erase the authoritative Program view or resurrect old task states. After final archive/restart, the selected completion summary remains available and visible without a misleading active spinner.
- Two sessions / two Programs: background updates cannot overwrite the foreground Program, and foreground selection cannot redirect a background publication to the wrong state slot. Two Programs in one session must be selectable or aggregated clearly, including same-slug Programs in different repos.
- Tool mutation contract: orchestration status is derived from durable execution state. Generic todo mutations targeting orchestration-owned rows must be rejected with a clear reason and the appropriate `/orchestrate` command. They cannot certify work, restart work, or corrupt membership. Preserve unrelated user todos using the owned projection namespace in section 8.7. Stable IDs/metadata must prevent an old “Task 1” action from targeting Task 1 in the next Feature.
- Validate narrow terminal widths and long Feature titles: active identity and wait reason remain accessible; expanded details show everything. Progress counts measure actual Features/Tasks, not every decorative/pipeline row. Verify no stale-board fallback when no active Feature remains.
- Baseline REDs already demonstrated: child update drops Program overview; paused Program/cursor projected in progress; unselected phases projected as pending. Real loader identity, replay, foreground races and generic mutation tests still need executable RED evidence. Existing empty-board completion assertions conflict with the user's explicit visibility requirement and must change intentionally.

Run each new file explicitly during development, for example:

```sh
rtk proxy node --experimental-strip-types --test test/program-lifecycle.test.ts
rtk proxy node --experimental-strip-types --test test/program-concurrency.test.ts
rtk proxy node --experimental-strip-types --test test/program-todo.test.ts test/program-todo-loading.test.ts
rtk proxy node --experimental-strip-types --test test/program-graph-fable.e2e.test.ts
rtk npm run check
```

Require nonzero executed tests, zero cancellations, and exact expected scenario coverage. Do not use source-regex checks as acceptance for lifecycle behavior.

## 6. Readiness for the user's real run

Do not use the current configured main checkout for a Program command: it has no such capability. Do not promote the Program branch merely because its selected tests pass. Close the P0 findings (including todo/status integration) and full-suite cancellation, then record the exact loaded extension and todo-package revisions in a disposable smoke session. Confirm the real todo tool, `/todos`, and widget agree during a phase handoff and after reload before starting the real work.

Once all implementation, verification and activation gates in this document pass, the intended command shape, from the correct target repository, is:

```text
/orchestrate program /Users/greg/plan/GRAPH_FABLE_QA.md phases 3+4
```

This is a future test recipe, not a command executed by this review. Confirm phases 0–2 prerequisites and the source document's unresolved decisions against then-current evidence; this review did not verify their completion. Separate phase-3 code acceptance from its Phase-7-dependent live check. Track phase-4 icemining and devops work separately, and preserve its operational approval requirement. The first live exercise should validate orchestration and code gates without treating seed/Program approval as authorization for production purging.

## 7. Diagnostic reproduction notes

The temporary probe `/tmp/pi-multiphase-probe.mjs` imported the pinned Program branch and used a fresh temporary root; it did not invoke real agents or git. Reproduce its contracts as permanent tests in T1–T4:

| Probe | Setup/action | Observed baseline |
| --- | --- | --- |
| Context | Seed real document 3+4; inspect phase-4 stub and actual plannerLaunchParams | `has46=false`, `hasExplicitApproval=false`, `promptHasSource=false` |
| Identity | Run ensureFeatureNamed with new title and pending headers on seeded child 3 | Old path absent; Program row still old name and has no phase |
| Archive | Mark 3+4 done, cursor 4; stepProgramNow with fake exec | All eight child folders plus Program archived |
| Subset | Cursor 3 planning; setProgramSubset to 4; stepProgram | Setter succeeds; action run_child cursor 3 |
| Process ownership | Hold same feature lock in parent while second process requests it | Child acquires true, exit 0 |
| Paused todo | Seed 3+4; set cursor 3, Program paused; project Program board | Program and phase 3 in_progress; unselected phase 0 pending; mixed count 1/12 |
| Child publication | Set recording sink; upsert a Program child's next action | Only Planner/Plan reviewer/Approve published; Program and other Feature rows absent |

These are diagnostics of current behavior, not a completed permanent regression suite. No product fixes were made by this review.

## 8. Chosen implementation contract

### 8.1 Supported scope and success definition

V1 supports an ordered set of Features, document phases containing one or more Features, multiple queued Programs, and multiple local Pi sessions connected to the same canonical orchestrator root. **Only one orchestration agent or other mutating orchestration operation may execute at a time across that root.** This includes standalone Feature planners, reviewers, workers, QA, fixers, worktree creation and PR mutations. Read-only status and PR observation may run concurrently; a PR waiting for review releases execution capacity so another eligible Program can progress. A Program never bypasses its own unmet dependency to use that capacity.

This is serial multi-feature execution with safe multi-session coordination, not parallel implementation within a Program. Arbitrary parallel DAG execution and sharing the control database across hosts/network filesystems are out of scope. Different roots must not operate the same Feature/worktree; detect overlapping canonical worktree ownership and refuse. Remote build/QA commands remain supported through the existing explicit host routing; they are owned operations, not a second scheduler.

The required acceptance workloads are: (a) two existing Features run in order; (b) two independent queued Programs served without duplicate execution or starvation; (c) GRAPH phases 3+4, including multiple repositories and visible external gates. Passing only the GRAPH-shaped parser fixture does not satisfy (a) or (b).

### 8.2 Durable identity and state authority

Introduce `src/lib/program-store.ts` and a versioned **local SQLite control database** at `<canonical-orchestrator-root>/.control/state.sqlite`. Use `node:sqlite`, transactions, foreign keys, WAL and full synchronous durability. Pin/test the supported Node runtime in `package.json` and CI; the review environment is Node `v24.10.0` with `node:sqlite` available (SQLite `3.50.4`). This is a deliberate new persistence dependency. No silent fallback to independent Markdown writers if the database is unavailable, busy beyond a bounded wait, corrupt or has a newer schema.

Use short transactions with a bounded busy timeout (default 2 seconds); never hold a database transaction across RPC, git, child execution or UI calls. The control directory must be excluded from Feature discovery. Canonicalize the root before opening it so symlink spellings cannot create independent ownership domains.

Persist these entities with explicit schema versions and revision numbers:

| Entity | Required fields/invariants |
| --- | --- |
| Program | Immutable UUID, owning repo identity, display name, source snapshot hash, manifest revision, approved manifest revision, phase/state, selection revision, control revision |
| Phase | Stable ID, source heading/index, ordered Feature IDs, prerequisite gate IDs, required completion gate IDs |
| Feature | Immutable UUID, immutable directory and storage slug, display title, canonical repo/worktree identity, branch, lifecycle state, plan hash/revision, current attempt |
| Membership | Program ID + phase ID + Feature ID + order; unique ownership, validated repo mapping, no basename lookup |
| Selection/run | Immutable run ID and revision, ordered selected phase/Feature IDs, cursor by ID, status and completed/pending/deferred counts |
| Operation | Unique operation ID, owner generation, Feature ID, stage, attempt, request hash, spawn intent/run ID, lifecycle, deadlines, evidence references |
| Gate | ID, kind, required revision, prerequisites, state, evidence artifact hash and provenance; approval is distinct from passing evidence |
| Claim | Root execution slot, owner session/process nonce, generation, current operation ID, diagnostic heartbeat and recovery state |
| Events/projections | Monotonic committed revision, transition/event ID, projection-outbox state; consumers deduplicate by revision/event ID |

Program-managed Feature paths are frozen at creation (e.g. `<repo>/<initial-slug>-<short-id>/`); planner title changes update the display title only. Keep branch identity stable once allocated. `ensureFeatureNamed` must not rename Program children. Link/migration may retain existing paths. Never infer ownership from title, PR number alone, or directory basename.

The database is authoritative for controller state, membership, claims, gates and completion. `status.md`, `program.md`, transition logs and todo are projections. Keep `plan.md` as an editable planning artifact, imported with its hash/revision after planner/reviewer completion; validate its structure and requirement mappings before execution. Agent-written `Status: done` is a claim, not acceptance evidence. Migrate every Program-managed controller write/read through the store and update compatibility adapters used by the latch and Feature chain. Do not leave two writable authorities.

Commit state plus a projection-outbox entry atomically. Write Markdown projections using temporary files and atomic replacement. A projection failure records lag and is retried from the outbox after restart; it never starts work twice. If external edits disagree with the recorded plan/control revision, block with an explicit reconciliation action; never quietly overwrite user changes or ingest an edited Markdown status as approval/completion. Keep public single-Feature behavior through adapters and tests.

### 8.3 Admission, side effects and crash recovery

Create `src/lib/execution-owner.ts` and route **all** orchestration entry points through it: manual verbs, automatic draft/approved starts, standalone chains, PR fixer/land paths, recovery and timers.

1. In one transaction validate current manifest approval, selection/control revision, pause state, prerequisites and root capacity; reserve an operation ID and increment/record the owner generation **before any side effect**.
2. Persist a spawn/command intent keyed by that operation ID. Subagent launch must support idempotent request IDs and lookup by operation ID. Verify the existing transport; if absent, add the minimal protocol/adapter support in the maintained `pi-subagents` source and test both sides. Do not retry an ambiguous spawn as a new request. Preserve successful spawn identity across lost replies and parent death.
3. Record run ID/stage for planner, reviewer, worker, QA and fixer alike. A completion must match operation ID, run ID, generation and the admitted work/plan revision before it changes state. Duplicate completion is a no-op. A pause may change the control revision while valid current work finishes: accept that attempt's evidence, then honor the latest pause/control state for further admission. Every controller mutation and subsequent launch verifies the claim again.
4. Retain ownership until the operation is terminal. A timeout, heartbeat expiry or disappearing parent alone does **not** prove a child or git process stopped. On restart reconcile by operation ID and actual process/run evidence. Resume observation of a live child; take over execution only after the prior controller and all owned side effects are proven terminal. Uncertain liveness enters `recovery_required` with no new launch. Heartbeat is diagnostic, not permission to steal.
5. Persist an outbox for PR mutations, notifications and other retryable effects. PR create recovers by canonical repo/branch/operation identity; PR land rechecks terminal state. After an uncertain non-idempotent command outcome, reconcile evidence or park; never replay it blindly. A stale generation cannot clear a newer claim or publish completion.

Because independent agents can write files outside the controller, database fencing alone cannot make overlapping workers safe. The no-takeover-until-terminal rule and idempotent spawn lookup are mandatory. The guarantee is one launch per authorized attempt, with explicit recovery when execution outcome is unknowable—not a claim of universal exactly-once external effects.

Choose the next eligible Program by persisted round-robin position at operation/stage boundaries; skip paused, blocked and dependency-waiting Programs. Store a single coalesced wake request per scope. Command handlers apply pause/selection/approval mutations **before** requesting a step. Timers/session start enqueue a wake; they do not run a second scheduler loop. PR wait does not hold the root slot. A cancelled/blocked Program must not monopolize scans of other Programs.

### 8.4 Selection, pause, retry and archive policy

- Separate `Program`, `selection run`, `phase`, `Feature`, and `operation` state. Program state is `planning | ready | running | waiting | paused | blocked | completed | archived`. Selection state is `ready | running | waiting | paused | blocked | completed | cancelled`. A selection may complete while the Program remains ready with unselected work. Extend transition tests rather than forcing these states into the existing Feature phase vocabulary.
- Selection order is explicit and preserved. Validate every selected ID and prerequisite. A reverse order violating dependencies is rejected; independent Features may be ordered freely. Done Features are retained as satisfied dependencies and never rerun implicitly. No implicit “skip” or reopening completed work.
- Refuse subset/link/manifest edits while an owned operation is active. When idle/paused, a valid edit creates a new selection revision and recomputes the first unfinished eligible child from that selection; never retain an excluded cursor. Previous completed selections stay in history. Resuming remaining phases does not reseed or clobber existing Features.
- `pause` prevents admission of another stage immediately; the current operation may finish and its valid completion is recorded without launching the next. `pause now` requests cancellation of the actual stage/run and remains `stopping` in operation status until termination is confirmed. No reviewer→worker or Feature→Feature handoff after pause. Resume rechecks gates and ownership; it never resets retry counters silently.
- Default each planner/reviewer/worker/QA invocation to one initial attempt plus **one** automatic retry only for transport failure proven to precede work. Persist counts before launch. Failed gates, substantive failed plans, repeated unchanged findings and ambiguous outcomes block without automatic replay. Preserve any stricter existing caps; retain the existing bounded QA passes and fixer rounds. Add a persisted per-selection automatic agent-launch ceiling of **100**; every planner/reviewer/worker/QA/fixer attempt counts, including recovery retries. The manifest shows this ceiling at approval. Reaching any limit blocks visibly; only an explicit retry/budget extension records a new grant. Idle ticks, reloads and resume do not replenish it.
- Existing per-child time/turn limits continue to apply. Quiet waits launch no model work. Missing run identity, malformed output and thrown exceptions become explicit durable failure/recovery states with an actionable reason.
- No automatic archival on selected-subset completion. Keep a compact persistent completion summary and all unfinished phases reachable. Full Program completion requires every non-excluded requirement/gate; archiving is a separate explicit operation allowed only when no live operation or incomplete owned work remains. Journal each archive move, resume after partial failure, and commit `archived` only when all moves are verified. Retain indexed summaries/todo history after archival.

Required state outcomes: all selected required gates passed → selection `completed`; selected code merged but required external evidence absent → selection `waiting` with `code complete, verification pending`; completed selection plus unfinished unselected phases → Program `ready`; all Program requirements passed → Program `completed`; explicit successful journaled archive → Program `archived`. `paused` or `blocked` never becomes runnable solely because a timer fired. A matching external completion may update evidence while paused, but launching more work still requires resume. Errors in one Program do not mark another Program blocked.

### 8.5 Full-source manifest, repositories and dependencies

Add `src/lib/program-manifest.ts`. Seed copies the **entire** source document into an immutable content-hashed snapshot under the Program directory; retain original path and capture time. Each child planner receives the snapshot path/hash, its exact section boundaries, relevant global rules/decisions and stable requirement IDs. Do not silently truncate requirements. Read the snapshot in chunks when necessary; verify its hash at planning/review. A changed original document does not silently change approved work; an explicit refresh creates a reviewed manifest revision.

Compile a persisted, reviewed manifest before implementation. The planner may propose it, but structural validation checks unique IDs, complete requirement mapping, repo identities, known gate kinds, dependency cycles and approval scope. Plan review checks semantic coverage. Every requirement is mapped to one or more Features/gates or an explicit reasoned exclusion; a missing mapping blocks. The presence of an ID alone does not prove its implementation: acceptance evidence is still required. Program approval binds the manifest hash/revision and selected scope; material scope changes require renewed approval.

One implementation Feature owns one repository, one branch and one PR. **A phase can own multiple Features across repositories.** Remove cross-repo writer escape paths for a Program Feature: expand the manifest into additional Features instead of writing a second repository with no tracked PR. A phase is complete only when all its required Features and gates pass.

For the real GRAPH document, the mandatory decomposition is:

| Unit | Repo / kind | Scope and prerequisite |
| --- | --- | --- |
| Phase 3 code Feature(s) | `icemining` | Requirements 3.1–3.7; split into ordered same-repo Features if the existing Task cap requires it; every required code gate and PR must pass |
| Phase 3 deferred verification gate | External evidence | The explicitly Phase-7-dependent devnet parity check remains pending and visible; never mark it passed from a code PR |
| Phase 4 purge-safety Feature(s) | `icemining` | 4.1, 4.2, 4.3, 4.5; depends on the approved phase-3 code prerequisites |
| Phase 4 playbook Feature | `icemining-devops` | 4.4 and runbook; depends on the supported purge CLI/interface being merged |
| Phase 4 operational gates | External evidence | 4.6 devnet, then production with separate explicit go-ahead; both stores, bounded dates, measured result; no automatic production purge from Program approval |

The source has both “do not start next phase until its exit gate holds” and a phase-3 check deferred until Phase 7. Preserve that conflict as a manifest decision: propose the code/deferred split above, display it at approval, and require acceptance of that explicit dependency interpretation before phase 4 can start. If unresolved, remain waiting; do not silently waive the source rule. The orchestrator capability can pass its tests while the real workload is legitimately waiting for this decision/evidence.

Gate kinds are `command`, `pr_merged`, `external_evidence`, and `approval`. Each carries owner, target repo/environment, scope, prerequisites and required revision. External operational work is represented as a durable gate with a concrete runbook/evidence request, not a generic agent instructed to purge production. A manually performed operation must supply evidence; a scoped approval alone is not success. Record approver/session, scope hash, environment and evidence identity; edits invalidate incompatible approval. No operational command is executed by a timer merely because a Program is approved.

Thus unattended **code execution** may finish while the real GRAPH selection waits for external verification. That is correct and must be displayed plainly; silently passing the gate to achieve a fully automatic run is not an acceptable fix.

For a `pr_merged` gate persist canonical remote repository identity, PR number, base ref, verified merged state, **merge commit OID**, verified head and fetched base OID. Check the merge commit on the correct fetched base; do not substitute PR head for squash/rebase merges. Missing merge identity or failed fetch parks. A first Feature with no predecessor legitimately requires no predecessor merge; a Feature declaring a predecessor with missing evidence does not. Closed-unmerged never satisfies the gate. Feature QA and command evidence must match the accepted work revision; changed work invalidates stale acceptance. Record the branch/base relationship when creating the worktree and verify it after creation, not only before `git wt`.

### 8.6 Commands and transparent controls

Preserve existing Feature commands and add/test these Program operations with a proper argument parser (quoted/space-containing paths must work):

```text
/orchestrate program <path.md> phases 3+4
/orchestrate program create <name> --features <repo/feature>,<repo/feature>
/orchestrate program link <repo/program> <phase-id> <repo/feature>
/orchestrate approve <repo/program>
/orchestrate pause [now] <repo/program>
/orchestrate resume <repo/program>
/orchestrate <repo/program> phases <selection>
/orchestrate retry <repo/program> --operation <id>
/orchestrate evidence <repo/program> <gate-id> <artifact-path>
/orchestrate approve-gate <repo/program> <gate-id>
/orchestrate status [repo/program]
/orchestrate focus <repo/program>
/orchestrate archive <repo/program>
```

These are planned interfaces, not currently available commands. Resolve qualified names to immutable IDs; accept a bare name only if unique, otherwise return choices without mutation. `create --features` establishes ordered feature dependencies, preserving existing completed work. Link may claim an unowned Feature or idempotently retain the same membership; replacement requires an idle manifest revision and releases the old join transactionally. A Feature already owned elsewhere cannot be stolen. Retry records the named stage/attempt and allowance without reopening already-completed work. `approve-gate` displays and binds the exact scope; its command invocation is the user's explicit approval, not text manufactured by a planner. Evidence import validates the artifact and prerequisite revision before satisfying a gate.

### 8.7 Todo integration is a shared owned projection

Add a versioned event-bus request/reply bridge implemented by the **loaded rpiv-todo extension**. The orchestrator must not import private store Maps or independently compete for the `rpiv-todos` widget. Proposed protocol `orchestrate:todo:v1` supports capability negotiation, `replaceProjection`, `getProjection`, `clearProjection`, and replies with request ID plus accepted revision. Include owner session ID, Program ID, selection ID, committed store revision and projection namespace; never derive the destination from the foreground render pointer.

Implement this bridge in the maintained rpiv-todo source, not by editing installed npm cache files. R0 locates or obtains that source, pins its revision and includes its release/load configuration in the deliverable. The namespace lives alongside normal todos in the tool's canonical per-session state. Generic mutations of orchestration-owned rows return a clear refusal; normal user todos remain editable and are not erased. The loaded todo extension owns composition and rendering for the tool, `/todos` and widget, so module isolation cannot split their truth.

Allocate numeric todo IDs from the store's shared collision-free allocator and persist the mapping from `(Program ID, Feature ID, task/stage/gate ID)`; never reuse an old Feature's task ID for the next Feature. Rows carry typed ownership metadata, display state, stage, wait reason and completion evidence; map states to the existing todo enum only at the presentation boundary while preserving meaning in metadata/text. Feature/Task counts are computed from typed entities, not raw row count.

Publish one Program projection after every committed relevant transition through the outbox; child writes cannot publish a standalone replacement. Publish background updates only to their owning session's namespace. `focus` changes the selected view without redirecting writes. Multiple Programs appear in a compact fleet summary plus the focused Program's detail. Completed runs retain a summary; details remain inspectable. Session replay preserves the namespace and requests a fresh revision; late/out-of-order updates cannot overwrite newer truth. Debounce only duplicate revisions, never drop a distinct state transition needed for history.

If the bridge is absent/incompatible, show an explicit integration error and keep `status` available; mark the installation not ready and refuse unattended Program approval. Do not claim todo integration because a fallback widget happens to paint. With the bridge available, a missing acknowledgement retries projection delivery without rerunning work. On session reattachment use a persisted explicit focus/attachment mapping; execution ownership is independent from view ownership.

## 9. Existing-state migration and compatibility

Add `src/lib/program-migration.ts`, a dry-run command/report, and `test/program-migration.test.ts`. Migration is versioned and rerunnable, never an implicit best-effort directory sweep on startup.

1. R0 records the active extensions, roots, Feature/Program inventory and live run/waiter IDs. Stop admitting legacy work before migration. All legacy Pi processes that can write this root must be quiescent; require verified terminal owned agents/commands. A new database lock does not protect against an old writer that ignores it. If liveness is uncertain, report the exact owner and defer migration without changing files.
2. Produce a dry-run mapping from canonical repo + existing folder to immutable IDs, phase/Feature membership, cursor/selection and state. Preserve directory locations, PRs, branches, handoffs, pause/blocked reasons, review/QA history and completed/unselected work. Look for already-renamed children by exact persisted join fields and source identity across the repo; repair only a unique proven match. Ambiguous, missing, duplicate or cross-owned records are reported and block that Program, never guessed away or treated as new work.
3. Snapshot the original files byte-for-byte into a timestamped migration backup; include file hashes and schema/runtime revision. Under a migration claim, import each Program atomically with an inventory hash. Retrying after interruption reuses IDs and continues; unrelated clean Programs may migrate independently. Never partially enable a malformed Program.
4. Preserve historical `done` Features as historical records. They satisfy future dependency gates only after merge/acceptance evidence is reconciled. Legacy `done` Programs that archived unfinished phases must be reported and reconstructed from uniquely matched archive records by an explicit migration action, not silently assumed complete. Previously absent retry/approval counters are initialized conservatively; active ambiguous attempts remain recovery-required.
5. Write projections after the transaction; repair them from the outbox if interrupted. Compare before/after inventory counts, membership and state. Activate v2 only after this verification and the tests below pass. Existing non-Program Features retain their semantics, but every legacy manual/automatic launch in the upgraded extension must acquire the new root claim.
6. Rollback is **disable execution and retain the new DB plus original backups**. A v1 extension must not resume the migrated root; older code cannot safely interpret new ownership and gate state. Provide a documented export/recovery path. Do not erase the DB or blindly restore old files while any new operation may be live.

Migration tests must include clean legacy import, renamed child repair, duplicate candidates, two repos with identical slugs, active planner/reviewer/worker, terminal PR with missing merge OID, partial previous archive, already-done selections, mid-transaction crash, projection crash, rerun idempotence and newer-schema refusal. Assert no live directory deletion, no lost user plan bytes, no child spawn during dry-run and no migration past unknown liveness.

## 10. Ordered remediation work packages

Each package delivers code plus its tests; do not implement only the tests and mark the capability ready. Keep the reviewed MP IDs attached to evidence. Proposed module paths below are ownership boundaries, not permission for an unrelated wholesale refactor of `orchestrate.ts`.

| Order | Concrete deliverable and primary locations | Required tests / depends on |
| --- | --- | --- |
| R0 | Record current SHAs/diffs/config and make a reviewed integration base from the Program-capable branch. Compare dirty main fixes individually, preserving newer module extraction and latch ownership guards. Locate maintained rpiv-todo and pi-subagents source and pin revisions. Add `qa/multiple-feature-evidence.md` with runtime/module provenance and baseline output. Use the applicable git-workflow skill for worktree/PR actions. | Baseline checks in every affected repo; no source overwrite; first establish which version will ship |
| R1 | Fix the referenced-deadline cancellation and create deterministic runtime, fake RPC, clock, temp-root and subprocess-barrier helpers. Add a scenario manifest and machine-readable evidence runner; forbid live external commands in test transports. | T0; failing harness test then full baseline executes without cancellations |
| R2 | Implement transactional store, immutable IDs, state transitions, outbox and migration; adapt Program-managed Feature state consumers and discovery. Add manifest/schema revision guards. | T2 identity, T4 membership, T9 store/migration; R1 |
| R3 | Implement root admission/generation checks and durable operation records for every stage/entry point; add transport idempotency/lookup support where missing. Reconcile crash windows and old-owner completions. | T3 and T9 ownership/side-effect matrix, single-Feature regressions; R2 |
| R4 | Implement source snapshots, validated requirement manifest, multiple Features per phase/repo, explicit gates and merge evidence. Add existing-Feature Program creation and qualified selection. | T1, T5, T9 command/plain-Feature scenarios; R2–R3 |
| R5 | Implement serial round-robin scheduler, coalesced wakes, control-before-step ordering, pause/cancel, bounded retries/launch ceiling, selection history and journaled explicit archive. | T4, T6, T9 fairness/budget matrix; R3–R4 |
| R6 | Implement the loaded todo-extension bridge and owned namespace in rpiv-todo; implement orchestration projection/outbox adapter and typed status/view model. Remove private store import and competing direct widget ownership once bridge tests pass. | T8 plus todo package's own mutation/replay/render regressions; R2–R5; changes span both maintained repos |
| R7 | Complete real command-handler integration, rich GRAPH scenario, plain ordered Features, two queued Programs, cross-repo PR gates, migration-to-run and runtime load tests. | T7 and all T9 cases; R0–R6. Do not stub the internal control flow under test |
| R8 | Integrate approved changes through the repo's git workflow, pin all runtime dependencies, update README/help/config/migration docs and validate the configured load path. Produce isolated runtime smoke artifacts and final gate report in section 12. | Complete checks for affected repos, runtime smoke, no pending P0/P1 correctness issue |

Implementation sequence is **R0 → R1 → R2 → R3 → R4 → R5 → R6 → R7 → R8**. Test labels T0–T9 organize contracts, not chronology: T8 must pass before T7. R0's version/diff review is required even if branch names and line numbers still look familiar. This review reconfirmed Program HEAD `3a5b2293e48a6bffd5e1dec11d96a1e95c5364d7`; future runs must recheck it.

No extra approval is needed for local implementation/tests within an authorized implementation task. Publishing, migration of live state and replacing active package configuration must follow the user's authorization and applicable workflow; prepare concrete artifacts first. This document itself does not authorize running production workload operations.

## 11. Required additional tests and objective pass criteria

### T9 — Persistence, commands, compatibility and bounded execution

Add the following **named** scenarios, grouped in the indicated files. Names are new acceptance targets, not claims that selectors already exist. A baseline that lacks an API must first get the minimal test seam; report missing capability separately from an observed behavioral assertion failure. Never label an import/setup error as product RED.

| Scenario ID / location | Setup and action | Required result |
| --- | --- | --- |
| STORE-01 `test/program-store.test.ts` | Two processes transactionally contend for one root operation; retry via alternate symlink path | One claim/operation; same canonical root; loser no side effect |
| STORE-02 same | Crash after state commit before Markdown/todo publish; restart | One committed transition; both projections repair; no agent relaunch |
| STORE-03 same | Corrupt/newer schema, DB busy, external conflicting plan edit | Bounded visible refusal; no fallback writer; original artifacts preserved |
| STORE-04 same | Exercise every legal state transition and randomized duplicate/out-of-order events with fixed seeds | No terminal resurrection, invalid cursor, negative counters or duplicate operation; report seed on failure |
| MIG-01 `test/program-migration.test.ts` | Run every migration case in section 9, including crash/retry | Stable IDs and identical inventory on repeat; ambiguous Programs disabled; no lost bytes or live run |
| OWN-01 `test/program-concurrency.test.ts` | Parent dies before spawn, after child launch before reply, after reply before record, after completion before projection | Operation-ID lookup recovers each case; no duplicate launch; uncertain execution parks |
| OWN-02 same | Owner heartbeat expires while child lives; PID is reused; old completion arrives after takeover | No unsafe takeover; nonce/generation checks reject stale events |
| OWN-03 same | Concurrent manual approve/implement/qa/pr, automatic Program starts and pending fixer verdict | Every path uses root admission; no mutation before refusal; existing Feature semantics preserved |
| OWN-04 same | Command timeout while git/helper process still running; cancellation fails | Capacity remains held/recovery-required until terminal proof; no overlapping writer |
| SIDE-01 `test/program-side-effects.test.ts` | Lose PR-create/land reply and restart; replay notifications and terminal events | Correct repo/branch PR recovered; no duplicate mutation/notification; unrelated same-number PR untouched |
| SCHED-01 `test/program-lifecycle.test.ts` | Two eligible Programs plus one stuck/paused Program; advance deterministic stage boundaries | Persisted round-robin service; stuck Program does not starve eligible work; one live operation |
| SCHED-02 same | Race pause/subset command against an enqueued wake; complete current planner/reviewer late | Control transaction wins subsequent admission; zero unauthorized next-stage spawns |
| BUDGET-01 `test/program-budgets.test.ts` | Repeated pre-work transport failures, failed plan/gate, restart/resume | Only allowed retry; no reset across reload; substantive failure blocks without model churn |
| BUDGET-02 same | Set test launch ceiling 3; fourth request attempted across Features/processes/recovery | Exactly 3 launches total; persisted budget block; explicit new grant required |
| INPUT-01 `test/program-input.test.ts` | Quoted source path, long phase, source edit after approval, requirement omitted by planner, cycle | Exact pinned scope preserved; invalid/changed manifest cannot execute |
| CMD-01 `test/program-commands.test.ts` | Invoke every section-8.6 command through registered handler; ambiguous names and stale revisions | Intended transition or explicit no-mutation refusal; no accidental objective/Feature creation |
| FLOW-01 `test/program-features.e2e.test.ts` | Create Program from two ordinary existing Features without phase headings; first PR merges | First completes then second runs; no forced document parser; todo shows correct Feature identity |
| FLOW-02 same | Two Programs, one Feature already done; PR review wait frees capacity; restart owner | Other Program progresses; completed Feature never reruns; correct owner/focus preserved |
| GRAPH-01 `test/program-graph-fable.e2e.test.ts` | Full section-8.5 decomposition, two repos, gate wait, restarts and duplicate events | All requirements accounted for; no phase/PR skipped; production remains external gated work |
| GRAPH-02 same | Source exit-gate/deferred-check conflict not resolved in approved manifest | Phase 4 does not start; precise decision shown in status/todo |
| TODO-01 `test/program-todo-loading.test.ts` | Real loader, both extension orders, real tool/list/widget, module isolation | One canonical owned projection, same content/revision across all three surfaces |
| TODO-02 `test/program-todo.test.ts` | Foreground/background swap, replay, duplicate delivery, renamed title, Task-1 ID from prior Feature | No cross-session overwrite, stale action or replay regression; manual todos intact |
| TODO-03 same | Pause/block/approval wait/subset done/full done/archive, narrow render | Accurate state/counts and reasons; completion summary persists, active identity accessible |
| COMPAT-01 `test/program-compatibility.test.ts` | Standalone Feature chain, PR latch, task gates, writer models, dirty-tree checks, orphan tasks | Existing contracts pass under new admission/store adapters; no latch ownership or cost-cap regression |

The runtime harness must use real public registration/dispatch and internal state transitions. Only external boundaries may be replaced: fake subagent runtime/transport with durable run lookup, fake GitHub/waiter response service, explicit clock, and disposable git repositories. Store/claim tests use real SQLite and real processes. Todo-loader tests load the actual pinned todo implementation. Assert listener/timer/claim cleanup and fail on an unexpected exec/RPC. Do not hide whole lifecycle calls behind hooks in end-to-end tests.

Add package scripts and checked-in runner `scripts/verify-multiple-features.mjs`:

```sh
rtk npm run typecheck
rtk npm run test:multiple-features
rtk npm run test:multiple-features:runtime
rtk npm run check
```

`test:multiple-features` runs all T0–T9 relevant regression files; `:runtime` runs registered-extension/real-loader and subprocess scenarios. Use `--test-reporter` machine-readable output and the checked-in scenario manifest to verify every mandatory scenario ID was executed and passed. Zero matched tests, skips/cancellations of required cases, runner timeouts, leaked subprocesses and missing scenario IDs all fail the gate. A whole-file wrapper is not a scenario. Record per-stage launch counts and forbidden external-call count (must be zero in isolated tests).

For each regression keep RED → fix → GREEN evidence; run focused tests during development, then the complete affected-repo checks and scenario runner after integration. Acceptance requires deterministic race barriers and a reproducible fixed-seed property run, not repeated timing-sensitive sleeps until something passes. Evidence artifacts live under `qa/evidence/multiple-features/<UTC>-<sha>/` (or an ignored artifact directory linked from the evidence ledger), not only `/tmp`.

## 12. Activation and final definition of done

Maintain `qa/multiple-feature-evidence.md` as the implementing agent's checklist with status `not started | RED captured | implemented | verified | blocked`, commit/diff identity, commands, assertion/result and artifact link for **each R package, MP finding and required scenario**. Keep code/test evidence distinct from live workload evidence. An unresolved choice or skipped gate is not “verified.”

Release sequence:

1. Finish R0–R7 on the integration branch; run complete tests in pi-orchestrate and every changed companion repo (todo/subagents). Review compatibility changes against dirty main and reconcile intentionally. Do not bulk-replace one checkout with another.
2. Build a disposable runtime profile using a temporary orchestrator root, temporary session/waiter roots, pinned extensions and local fixture repositories. Load through the actual Pi extension loader with the fake external transport. Exercise `program create`, the GRAPH command, approval, pause, restart and a Feature handoff; invoke the real todo tool and `/todos`, capture the rendered status. This smoke is mandatory and must not contact real GitHub, spawn paid agents, run SSH or mutate live Program state.
3. Record the **loaded** module realpaths, content hashes/commit identities, Node version, database schema and negotiated todo/subagent protocol versions. Package settings alone are not proof of loaded code. Test duplicate extension loading explicitly; two registrations must not create two owners or conflicting widgets. Absence/incompatibility must be visible and block unattended admission.
4. Prepare the live migration dry-run and concrete package/config update, with backup paths and stop/recovery instructions. Apply only within the user's authorization, after old controllers and their children are quiescent. Restart the intended session and verify loaded provenance, migration inventory, no stale claims and todo agreement. Never automatically switch a running session's extension underneath its active work.
5. Before the actual GRAPH run, refresh phase-0–2 prerequisites, source hash and unresolved decisions. Approve the manifest's explicit code/deferred dependency split if accepted by the user; otherwise show waiting. Start only the selected scope. Operational gates remain pending until the required separate action/approval/evidence occurs.

Final required checklist:

- [ ] Every MP-01–MP-09 root cause is fixed and has a permanent regression; P1 subset/recovery correctness is not deferred merely because P0s passed.
- [ ] All R0–R8 deliverables are complete, migration/recovery documented and all mandatory T0–T9 scenarios executed without failure/cancellation/skip.
- [ ] Ordinary multi-Feature Programs, multiple queued Programs and GRAPH 3+4 all pass the full runtime scenarios; cross-repo decomposition is implemented, not replaced with refusal.
- [ ] Exactly one admitted operation per root; duplicate/lost completions, process death and ambiguous side effects cannot start an overlapping agent or silently certify work.
- [ ] Retry/launch ceilings persist across restarts and are proven at the spawn boundary.
- [ ] Todo tool, `/todos`, widget and disk/control state agree through every lifecycle transition, session switch and restart; done/remaining/current Feature and wait reasons are clear.
- [ ] Source requirements, approval scopes, merge evidence and deferred/operational gates remain traceable; no PR merge is mistaken for full operational completion.
- [ ] The isolated real-loader smoke passes and exact loaded versions are recorded.
- [ ] The intended live installation is either verified after authorized activation, or explicitly reported **ready in isolated tests; activation pending**. Do not label it “ready in your session” before activation evidence exists.

Passing these gates demonstrates the intended **serial multi-feature capability** and recovery/status contracts. It does not prove that the product changes in GRAPH themselves are correct or that its live purge/verification has completed; those remain workload-specific acceptance gates. Report that distinction explicitly at handoff.
