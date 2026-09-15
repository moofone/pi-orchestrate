# Latch bugs — `/orchestrate` does not wake the parent on merge

Date: 2026-09-02
Reviewer: Codex (this session); verified and revised by Claude against code, tests, live state, and the Rust waiter source.
Scope: `src/pr-await-latch.ts`, `src/lib/pr-await-core.ts`, `src/lib/pr-reconcile.ts`, `src/orchestrate.ts` (`dispatchFeaturePrVerdict` archive / `reconcileLiveFeaturePrs`), `test/pr-await-latch.test.ts`, live state for icemining PR **#2242** (`~/orchestrator/icemining/release-build-timing-record/`, `~/.local/state/ghl-await/`), `gh-pr-reviewer/crates/ghl-cli/src/pr_await.rs`.
Incident: Feature **Release Build Timing Record** opened PR #2242, yielded, the PR merged, `status.md` became `phase: done` / `next_action: landed`, and the parent session never spoke.

This is not F1 (no durable owner). The Feature *was* closed on disk. The parent turn that is supposed to follow a merge never happened.

**The git lifecycle itself worked.** Review rounds, fixer dispatch, land, remote branch delete, worktree removal, and `status.md` all completed correctly. The only failure was the parent's chat turn. This is a notification bug, not a git bug.

---

## 1. What #2242 actually did

| Clock (UTC) | What happened |
|---|---|
| 22:00:03 | `feature-qa` → `pr`. Handshake `git pr-await` printed `next=yield`. |
| 22:00:18 | `~/.local/bin/ghl-pr-await` rebuilt (includes ghl `ddc9ec1`, "persist lastNext=done after auto-land"). |
| parent | Reported https://github.com/moofone/icemining/pull/2242 and **stopped**: “Waiting on review; I will not talk until the latch wakes.” |
| user | Sent that same URL as a real user `input` (source `interactive`, not `extension`). |
| parent | `gh pr view` (still `OPEN`), yielded again. |
| 22:38:55 | `drive-icemining-2242.pid` rewritten: a new daemon (new binary) took over after a fixer round (`kill: 21510: No such process`). |
| 22:43:38 | Waiter appended `status=landed` / `next=done` / `pr_state=MERGED` to `drive-icemining-2242.log`. Worktree removed. |
| 22:44:11 | `status.md` → `phase: done`, `next_action: landed`. `transitions.log`: `pr → done landed`. |
| parent | **Never spoke.** |

The four session copies (`pi-*.latch.json`) still say `lastNext=read_comments_and_fix`. Those are the extension's private files; the waiter never writes them, so they say nothing about what the waiter recorded.

There is no `manual-icemining-2242.json`. Terminal state exists only in the log. **Why that file is absent is not explained** — see §3 L2.

So: merge was applied to the Feature (~33s). The injection `pr-latch: icemining#2242 merged. Continue…` never arrived. The model had promised to wait for that injection, so the chat stayed dead.

---

## 2. Why the last fix is not enough

Uncommitted / `feat/orchestrate-post-extract-ux` added `waiterLogSaysTerminal()`:

> The waiter writes terminal `next=` into `drive-*.log`, not `lastNext` on the JSON `--state` file. Watching only the JSON is how a merged PR left the parent silent and status.md on `next=yield`.

That is a **sensor** patch. It is not the wake.

The latch already has a sensor the earlier draft of this document missed: the backstop timer (`WATCH_BACKSTOP_MS`, 10 min) calls `checkTerminal` → `gh pr view` **unconditionally**, not only when the waiter says terminal. So with every sensor bug unfixed, the parent would still have been woken within ten minutes of the merge — if the wake had not been switched off. Detection was never what kept #2242 silent.

Tests that currently pass never exercise the production path:

| Test | What it actually does | What production does |
|---|---|---|
| `merge after handoff wakes the live parent` | `watchMs: 20`, polls `gh pr view` | backstop is **10 minutes**; wake is `fs.watch` |
| `P5 F18: a waiter that says the PR is over` | writes `lastNext: "done"` into JSON | current waiter does this too (ghl `ddc9ec1`); the log-only shape is untested |
| `a Feature-owned merge dispatches next=done and still wakes` | same 20ms `gh` poll | Feature-owned `handoff` does not seed a waiter file |

Even with the log sensor, **#2242 would still have stayed silent.** Detection already happened (`status.md` updated). `wakeParent` no-op’d.

---

## 3. Findings

### L1 (S1) — Any user `input` cancels the merge wake (`deferralActive`) — **root cause, sufficient on its own**

```ts
pi.on("input", async (event) => {
  const source = /* event.source */;
  // Our own merge/ACTIONABLE injection is source "extension". A real user
  // prompt means this session has moved on; toast on merge, do not hijack.
  if (source !== "extension") deferralActive = false;
});

function wakeParent(ctx, text) {
  if (!deferralActive) return;
  // pi.sendUserMessage(...)
}
```

Pi’s `input` event fires for typed / rpc text **after** extension commands are checked. `/orchestrate status` never hits this handler. A raw URL does.

`setLatch` re-arms `deferralActive` only when the PR **number changes** (`src/pr-await-latch.ts:313`). A re-handoff of the same PR never restores it.

#2242 sequence:

1. `armObservedLatch` / `setLatch` with `origin: "observed"` → `deferralActive = true`.
2. User pastes the PR URL → `source === "interactive"` → `deferralActive = false`.
3. Model answers, yields. `agent_settled` re-handoffs the **same** PR, so `setLatch` does not re-arm `deferralActive`.
4. Merge → `finishTerminal` → `dispatch next=done` (status.md) → `reportTerminal` toasts → `wakeParent` returns immediately.

From here on, every detection route ends in the same dead call: `fs.watch` + log sensor, the ten-minute backstop, and a reconciler-triggered close all funnel into `wakeParent`.

This is load-bearing for solo hijacks (`#2150`) and is **explicitly tested**:

`a later user prompt cancels the deferred-work wake`

It is wrong for any `observed` latch, Feature-owned or solo. The session that ran `git pr-await` is the session that deferred work. Pasting the PR URL, asking “is it merged?”, or any other line during the wait is not “moved on.” The flag encodes a guess about user intent; the wake must be a function of disk state, not chat history.

`#2150` itself was an **adopted** latch into a reference-checkout chat that never ran `pr-await`. That is already refused by `adoptableLatch` / `isReferenceCheckout` (same repo, owning pi process gone, not a reference checkout). The input cancel is a second, blunter guard that also kills the session that actually owns the wait. The explicit, deterministic cancel already exists: `/pr-latch clear`.

Do **not** re-arm `deferralActive` on every `agent_settled`. Delete the input cancel for `observed` instead.

### L2 (S2) — `waiterSaysTerminal` treats a file that never existed as “PR is over” — **cost and latency, not the wake**

```ts
function waiterSaysTerminal(): boolean {
  const own = waiterState();
  if (own && !existsSync(own)) return true; // vanished == landed
  // JSON lastNext in {done, stop, mechanical}?
  return latch ? waiterLogSaysTerminal(latch.pr) : false;
}
```

The comment is right for a file the waiter **deleted after land**. Feature-owned `handoff` refuses to spawn/seed a waiter (F3). `waiterState()` then points at `manual-icemining-<pr>.json` that this session never created.

`!existsSync(own)` is then true from the first `fs.watch` event:

- every log append spends a `gh pr view` (undoes F18), or
- if the watch never fires, land is invisible until the 10-minute backstop / 60s reconciler.

**Stale claim corrected.** The earlier draft said the real waiter does not put terminal `next=` on JSON. Since ghl `ddc9ec1` (2026-09-02 19:10 UTC) `record_latch_verdict_locked` writes `lastNext: "done"` after auto-land, reading `cwd` off the existing file so the deleted worktree does not abort the persist. The daemon that landed #2242 started at 22:38:55 UTC with the 22:00:18 binary, so it **should have written that file**.

**Open question.** Nothing in TypeScript deletes a waiter JSON for an `observed` latch (`reportTerminal` only removes it when `source === "manual"`), and nothing in the Rust crate removes `manual-*.json` (`pr_land.rs:700` removes the land state under the git common dir, a different file). Yet `manual-icemining-2242.json` is absent. Until the deleter or the alternate `--state` path is identified, the “seen, then vanished” rule in §5 B has nothing to anchor to, and an undelivered ACTIONABLE in that file would be lost the same way (F4).

### L3 (S2) — Reconciler archives without waking anyone — **latency, not silence**

`reconcileLiveFeaturePrs` (session_start, every `/orchestrate` verb, 60s timer while `phase: pr`) asks GitHub, dispatches `next=done`, writes `phase: done`. It never calls `sendUserMessage` (`src/lib/pr-reconcile.ts:144`, archive branch of `dispatchFeaturePrVerdict`).

On its own this is not a silent parent. `findFeatureOwningPr` does not filter by phase, so when the latch later fires (`fs.watch`, log, or the 10-minute backstop) it still finds the owner, dispatches `next=done` again (archive is idempotent), and reaches `reportTerminal` → `wakeParent`. Worst case is a ten-minute wake, not none.

It becomes silence only combined with L1. That combination is #2242: reconciler closed the Feature at 22:44, and the latch's later wake was already switched off.

`finishTerminal` already dispatches **and** wakes. The reconciler is the backup that only does the first half. Two closers with different behaviour is the design smell; the fix is one closer.

### L4 (S2) — Tests encode the production lie

Production wake is: `fs.watch` on `~/.local/state/ghl-await` + local file reads, `gh pr view` only when the waiter already says the PR is over, backstop 10 minutes.

The suite:

- sets `watchMs: 20` so `checkTerminal` polls GitHub anyway
- writes `lastNext: "done"` into JSON only; never the log-only shape
- never appends `status=landed` to `drive-*.log`
- never pastes a URL into an observed latch and then lands
- never exercises the backstop timer at its production value

Until those are green against the real waiter artifacts, this will keep looking fixed in unit tests and dead in the orchestrate parent.

### L5 (S1) — The wake depends on a prose promise

The parent's “I will not talk until the latch wakes” is an instruction the model follows probabilistically. Pi has no blocking Stop hook: `agent_settled` and `agent_end` are observe-only events with no return value. The mechanical equivalent of a Stop hook is exactly what the latch already does — on settle, ensure a waiter; when disk state says a turn is owed, `sendUserMessage`. That design is correct. It is then defeated by L1, and the model is asked to paper over the gap with a promise. The guarantee has to live in code: **every terminal or undelivered ACTIONABLE state on disk produces exactly one injected turn in the owning live session, or the Feature is closed in code.** The orchestrator instructions should shrink to “after `pr-await`, stop; code injects the next message.” Nothing should depend on the model having read the `git-workflow` skill. `git-workflow-guard` already blocks `git pr-land` / `git wt-rm` mechanically.

---

## 4. Intended vs actual wake

Contract already written in `pr-await-latch.ts`:

> Terminal PR: a Feature-owned one updates status.md in code (`next=done` / `stop`) so `/orchestrate` is not stuck on `pr-await next=yield` after the waiter has already landed. **The parent is still woken on merge/close — the no-wake exception is ACTIONABLE verdicts only.**

| Path | Detect merge | Update status.md | `sendUserMessage` |
|---|---|---|---|
| Solo observed, no later input | yes (JSON / log / backstop `gh`) | n/a | yes |
| Solo observed, later user input | yes | n/a | **no** (L1; tested, and wrong) |
| Feature-owned observed, no later input | yes (L2 costs `gh` calls; backstop ≤10 min) | yes (`archive`) | yes |
| Feature-owned observed, user pasted URL (#2242) | yes (~33s) | **yes** | **no** (L1) |
| Reconciler only, latch still armed | yes (`gh`) | **yes** | yes, on the latch's next tick (≤10 min) |
| Reconciler only, L1 tripped | yes (`gh`) | **yes** | **never** |

ACTIONABLE on a Feature PR correctly does not wake the parent (writer is dispatched in code). Merge is not ACTIONABLE.

---

## 5. Fix

Keep the `#2150` adoption guards. Do not bundle this with the uncommitted approve-overlay / model-pin / process-wide `RUNNING_CHAINS` pile.

**Ship A alone first.** It is a two-line policy change and it is the whole incident.

### A. Wake policy — wake is a function of disk state

In `wakeParent` / the `input` handler:

- `origin === "observed"` (solo **or** Feature-owned) → always `sendUserMessage` on merge/close, even if the user typed. The only cancel is `/pr-latch clear`.
- `adopted` / `discovered` → keep the input cancel; those are guesses about successorship and a later prompt is real evidence.

This flips `a later user prompt cancels the deferred-work wake`. Rewrite that test as the #2242 reproduction (§6 test 1); its solo-hijack concern is already covered by the adoption tests.

Wake text for Feature-owned must not say “Continue the work you deferred.” Code already archived. The parent is not the lander:

```
pr-latch: icemining#2242 merged (https://github.com/moofone/icemining/pull/2242).
Feature release-build-timing-record is complete. Confirm to the user.
Do not run git pr-land or git wt-rm.
```

### B. Sensor

Keep `waiterLogSaysTerminal`. Fix the missing-file rule:

| Signal | Terminal? |
|---|---|
| JSON `lastNext` in `{done, stop}` or mechanical | yes |
| `drive-*.log` has `status=landed` / `next=done\|stop` / `pr_state=MERGED\|CLOSED` | yes |
| waiter state file **was seen**, then vanished | yes |
| waiter state file **never existed** | **no** |

Before relying on the third row, answer the L2 open question: find what removed `manual-icemining-2242.json`, or which `--state` path the 22:38 daemon was actually given.

### C. One closer, one wake

Make `finishTerminal` the only path that ends a latch. The reconciler's archive must reach the live latch: add a `registerLatchWake` beside `registerLatchArm` in `pr-await-core.ts` so `orchestrate.ts` can wake the session holding the latch without importing the latch. Cheaper fallback: the latch treats `status.md` `phase: done` for the Feature it owns as terminal, so reconciler and latch cannot diverge. Either way the once-only guard (`terminalWoken`) must hold across both routes.

Do **not** re-arm on every `agent_settled`.

### D. Orchestrator instructions

Reduce the parent's PR-phase instruction to: after `git pr-await` prints `next=yield`, stop; the next user message is injected by code. Remove every “I will not talk until” style promise from prompts and skills the parent reads. The `next=` table in the `git-workflow` skill is solo policy and must not be a dependency of the `/orchestrate` wake.

---

## 6. Tests that would have caught #2242

All with **production** `watchMs` (0 or 10 min, faked timers where the backstop is under test), `watchStateDir: true`, real waiter artifact shapes:

1. Observed Feature-owned latch + user input of the PR URL + append `status=landed` to `drive-*.log`, **no** JSON `lastNext: "done"` → **exactly one** wake, dispatch `next=done`. (#2242 reproduction; replaces `a later user prompt cancels the deferred-work wake`.)
2. Same without user input → still one wake (log is enough).
3. Same, but the waiter writes `lastNext: "done"` to JSON and nothing to the log (ghl `ddc9ec1` shape) → one wake.
4. Solo observed + unrelated prompt + log write → **one wake** (policy A), toast as well.
5. Adopted latch + unrelated prompt + log write → no wake, toast only (`#2150` stays).
6. Never-created manual file + log of `next=read_comments_and_fix` (not landed) → **zero** `gh pr view`.
7. Reconciler archives while an observed Feature latch is live → parent wakes **exactly once**, whether the latch or the reconciler detects first.
8. No `fs.watch` event, no log, no JSON; backstop fires at production interval under faked timers → one `gh pr view`, one wake.

(1) is the #2242 reproduction. Until it is green, do not call merge-wake fixed.
