# PR review controller — pinned revisions

Pinned 2026-09-08 before implementing `docs/PI_PR_REVIEW_CONTROLLER.md`.

Dirty configured checkout `/Users/greg/Dev/git/pi-orchestrate` was left untouched.

| Component | Value |
| --- | --- |
| Implementation worktree | `/Users/greg/Dev/git/pi-orchestrate-wt/feat-pr-review-controller` |
| pi-orchestrate base | `origin/main` `9c32173ea2887a89b941a359558c9a94092bccb8` |
| Dirty checkout HEAD (not used) | `a62dda705b77bec944547190e406b278b823c743` (behind 20, dirty) |
| Ported from dirty WT | `src/lib/wait-protocol.ts` (untracked there; not on origin/main) |
| gh-pr-reviewer worktree | `/Users/greg/Dev/git/gh-pr-reviewer-wt/feat-pr-review-controller` |
| gh-pr-reviewer base | `origin/main` `14c29d03d7331870fbfacde632b2b70430693712` |
| Installed Pi | `0.84.4` |
| pi-subagents package | `0.58.0` (`/Users/greg/Dev/git/pi-subagents`) |
| Waiter binary | `/Users/greg/.local/bin/ghl-pr-await` mtime 2026-09-07 12:38, 5670672 bytes |
| Waiter sha256 | `607522f3672ba7383903e8dc6ef77f7b6e0651fe378df054e63daf77a0c10da0` |

Local patch provenance: wait-protocol + ownership/delivery comments in the dirty checkout informed the design; this branch is based on current `origin/main`, not the older dirty HEAD.
