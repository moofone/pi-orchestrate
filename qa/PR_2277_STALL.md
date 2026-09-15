# PR #2277: review arrived, orchestration did not advance

Investigated 2026-09-05 against HEAD `a62dda705b77bec944547190e406b278b823c743` plus the existing dirty checkout. Existing changes were preserved. This report describes the additional fix in this session, not the entire uncommitted diff.

## Incident evidence

- Parent session: `~/.pi/agent/sessions/--Users-greg-Dev-git-icemining--/2026-09-04T18-18-06-348Z_01a06da4-688c-7627-ad11-f2015d99afb2.jsonl`.
- At 02:55:18 UTC the parent's recorded status had `phase: pr`, no worker, no fixer round, and `next_action: pr-await next=yield`. At 02:55:22 it promised to wake on CI/review. No later parent message appears in that session file.
- Codex review comments were created at 02:57:44 UTC. `~/.local/state/ghl-await/drive-icemining-2277.log` records `next=read_comments_and_fix`, round 2, head `b03af89329f85c84e6417132282f82afcec3c3ad`, and both findings. Its initial actionable block has `cycle_start=1788576905`, `elapsed_seconds=1451` (03:19:16 UTC).
- The findings concern failed `KnownKeys` asks becoming empty history and a fresh `FillingWarnState` on every relay assembly. The review was received by the waiter; this was not a missing-review problem.
- No original-parent `.latch.json` was present when inspected. This is consistent with the broken arm route below; absence alone does not prove its historical cause.
- At 12:48:10 UTC another Pi session launched fixer `0314ed5a-ba11-4888-875a-8f454a467397`. Its run artifact names the pi-orchestrate session `01a06dbe-4525-7dc4-a374-6b1ba7cf0a79`, not the original parent. It was actively reading the affected code during investigation. The current queued-behind-writer message therefore does not describe the overnight stall. No competing fixer was launched by this investigation.
- BrowserOS was signed out of GitHub. Review evidence above comes from local session/waiter artifacts, not a claimed live GitHub inspection.

## Why previous tests passed

Both the installed Pi loader and the development dependency create a separate Jiti loader for each extension with `moduleCache: false`. The old `pr-await-core.ts` used module-local `latchArm` and `latchTerminal` variables as if all extensions shared one module instance.

The orchestrator writes one copy; the latch registers callbacks in another. `armObservedLatch()` silently does nothing. Tests used native ESM imports, which share a module cache and therefore concealed the failure. A reproduction using Pi's Jiti options reported `{sameModule:false, armCalls:0, expected:1}`.

The reverse route had the same architectural flaw: the latch dynamically imported `orchestrate.ts` to dispatch a fixer. That can produce another copy of `RUNNING_CHAINS`, separate from the registered orchestrator's lock and release hook.

Two additional failure paths were reproduced:

1. Recovery was armed on session/command entry only. If no PR existed yet, the timer was absent; creating the first PR later did not arm it. A missing latch then had no periodic backstop in that process.
2. After awaiting a complete fixer round, the latch acknowledged every current waiter file without checking its verdict. If another review arrived during that await, the old completion marked the new review delivered. That can silently lose a later fixer round even after initial arming works.

## Implemented correction

- Latch arm, terminal notification, and Feature dispatch now cross the runtime's `pi.events` bus. No module-local callback registry or dynamic orchestrator import remains on these routes. Pi tracks and disposes bus subscriptions with its extension runtime.
- The registered orchestrator handles dispatch, so its actual chain lock controls the writer. A missing dispatcher rejects explicitly and leaves the verdict pending. Different runtime buses cannot deliver into each other's latch.
- Entering the yielded PR wait arms the 60-second recovery timer. Shutdown clears it.
- Delayed acknowledgments compare the current verdict fingerprint with the dispatched fingerprint. A newer review remains pending.
- Existing dirty-checkout typecheck errors were corrected by naming unused parameters accordingly, using the exported overlay kind type in the test fixture, and removing a redundant assertion after type narrowing.

## Regression evidence

`test/pr-extension-loading.test.ts` loads independent module copies with Pi's Jiti settings. It verifies:

- Cross-extension arm and terminal delivery, with runtime isolation.
- Production orchestrator/latch factories, real waiter-directory `fs.watch`, a ten-minute polling backstop, two fake child completions, two fixer rounds, and exactly three `git pr-await` calls. No parent model turn and no live child/provider/GitHub operation is used.
- A latch request sees the registered orchestrator's held chain lock and produces no writer side effects.
- Opening the first PR arms recovery without any latch subscriber.

`test/pr-await-latch.test.ts` also reproduces a new verdict arriving while the previous dispatch is outstanding. It verifies that completing the old dispatch does not consume the new verdict.

Before the respective fixes, the loader-arm assertion failed `0 !== 1`, the first-PR timer assertion failed `[]` versus `[60000]`, and the delayed-ack assertion failed `true !== false`. These were behavior failures, not setup failures.

Validation: `rtk proxy npm run check` (typecheck plus the full test suite), and `rtk proxy git diff --check`. The targeted two-round test proves the integration under the production loader model; it does not prove an already-running Pi process has reloaded this code.

## Activation

Pi settings reference this checkout directly. New/reloaded extension runtimes use these changes; already-running processes retain their loaded code. Reload the affected parent to activate the corrected routes. The existing live fixer should not be replaced or duplicated merely to demonstrate activation. No live PR merge, review comment, or Feature-state repair was performed here.
