# ADR 0017: A thread may own a worktree, and a sub-agent usually does

## Status

Accepted, 2026-09-06.

## Context

Tau could already make a worktree, from the picker under the composer: type a
name, get a checkout beside the repository. It was a project-level move made
before the work started, and it started from a hard-coded `origin/main`. Two
things it was not: a property of the thread, and something a sub-agent could
have.

The second one is the real problem. A sub-agent is an ordinary thread in the
same project ([ADR 0013](0013-agents-spawn-threads.md)), which until now meant
the *same working copy*. Two agents editing one checkout overwrite each other,
and a child gets no turn checkpoint at all while its parent's turn holds the
workspace lease — the lease is per checkout, so the child's capture times out
after a second and is skipped. Eight children in one checkout is eight writers
and no undo.

For threads the first half has a known shape. A thread is the unit: one thread,
at most one worktree, chosen in the composer before the first message and
locked after it, created as part of that first send with "Setting up worktree…"
in the timeline. Sub-agents are the open half: sharing the parent's worktree
brings back the collisions above.

## Decision

**A thread's workspace is chosen once, before its first turn, and the send
creates it.** The picker under a pending draft offers "Current checkout" and
"New worktree". With the second, the first prompt waits while the worktree is
made, the thread is created *in* the worktree, and the mode is locked because
the thread now has a project. The default comes from the project (the user's
own answer for this checkout, then `.tau/project.json`'s `workspaceMode`, then
the global setting): a global default, a per-project file, and the user's own
answer on top.

**The seam is `beforeNewThread` on a prompt hook**, not a branch in core's
submission path. A gate is handed the draft's project and the prompt and may
answer with another workspace; core moves the pending draft there and sends the
prompt to it. Core learns nothing about worktrees, and the same seam would
serve a kit that puts a thread in a container or on another machine.

**The base is resolved, not assumed.** `origin/HEAD` names the default branch,
`origin/main`/`main`/… are the fallbacks, and with "New worktrees start from
origin" (on by default, so a new worktree does not start from a stale local branch)
the remote is fetched and the worktree is
created at that *commit*, never at the moving ref. The branch records
`branch.<name>.tau-base` in the repository's own config, so a later diff,
review or pull request compares against what the worktree actually started
from instead of guessing again.

**A sub-agent gets a worktree of its own.**
`tau_spawn_thread` takes `workspace: "worktree" | "shared"`, defaulting to a
worktree whenever the project is a Git repository. The child then has its own
checkout, its own lease and therefore its own checkpoints, and two children
cannot collide.

**A child starts from the parent's state, not from origin.** It continues work
the parent is in the middle of, so the base is the parent's latest turn
checkpoint — those refs hold the tree of the working copy, uncommitted work
included — committed with `commit-tree` on top of the parent's HEAD, and HEAD
itself when there is no checkpoint. The branch is `tau/agent-<8 hex>`.

**Integration is a local merge, not only a pull request.** A worktree handed to
the user usually ends in a PR. Here the parent is an agent that has to continue:
`tau_wait_for_thread` reports the child's branch and diff, and
`tau_apply_thread_changes` takes the work back — a merge when the child
committed everything, one patch of its whole working copy otherwise. A patch
that would collide applies *nothing* and names the branch instead, so the
parent's checkout is never left half-merged. The Agents panel offers the same
two moves as "Apply changes" and "Discard"; both remove the child's worktree,
which is what ends its life.

**The name comes before the branch, not after it.** Creating a placeholder
branch and renaming it once a model has read the first message would move a
branch under a running thread. Tau has the whole first prompt in hand while the worktree is still being made, so
the Worktree Names kit names it then; `tau/<8 hex>` is the fallback when that
kit is not active. Nothing is renamed afterwards, and no worktree directory
ever has to move.

## Consequences

- A worktree is cheap to make and easy to forget. The picker gained a removal
  that first says what would be lost (uncommitted files, commits beyond the
  base) and refuses while a thread still runs there; a worktree whose folder
  vanished is recreated when it is opened.
- A child that fails to start leaves nothing behind: the worktree is made
  first, and removed again when `sessions.start` throws.
- `git worktree prune` runs when the picker lists worktrees, not on every
  project scan: a read of a project must stay a read.
- Applying a child's work reads its whole working copy through a temporary
  index — the same capture turn checkpoints use — so uncommitted work is
  applyable and its diff is exactly what the child changed.
- Agents Kit imports one module of Workspace Kit,
  `kits/workspace/agent-worktrees.ts`. Every Git sequence in Tau belongs to
  Workspace Kit, and that module is deliberately a leaf: its own runner, no
  Git cache, no checkpoint machinery. The alternative — a second Git
  implementation in Agents Kit, or a host-side service registry — was worse in
  both directions.
- Agents Kit needs the `process` permission now, because it spawns `git`.
- Tau has no thread deletion, so this ADR could not hang worktree removal on
  one. Removal is the picker's action and the panel's two; a worktree of a
  thread whose session file disappeared is left alone rather than deleted
  behind the user's back.
- A parent that never applies a child's work keeps a branch and a checkout. It
  is visible in the picker with its diff, which is the same deal a user gets
  from a worktree they made themselves.

## Amendment, 2026-09-22: worktrees are cleaned up by rules the user sets

The consequence above — "a worktree is cheap to make and easy to forget" —
now has an answer, and thread deletion exists (`threadDeleted`, ticket 12).
Workspace Kit writes down every worktree it creates and removes one when a
rule the user turned on says it is done: inactive for N days, merged into the
default branch, its last thread deleted, or no commits beyond its base. The
rules are off by default, host-wide with a per-repository override,
and Settings → Storage shows what each rule would remove before it does.

What it never does is decided here, not per rule: it removes only a worktree
it recorded itself and whose real path lies inside the repository's worktrees
folder; it goes through `git worktree remove` without `--force`, so Git refuses
anything with changes once more; it keeps the branch, so a thread can have its
checkout back (`ensure-worktree`); and uncommitted work, ignored files other
than `node_modules` (a `.env` is not reproducible, an install is), commits no
other branch or remote holds, a thread with a live runtime there and the host's
own workspace each keep a worktree. Removing one of those takes the user's
hand and a confirmation on the Storage page. Agent worktrees are not recorded
yet: Agents Kit removes its children's worktrees itself when their work is
applied or discarded.


## Amendment, 2026-09-25: a child starts from HEAD and the working copy, never a checkpoint

The decision above based a child on the parent's latest turn checkpoint,
committed on the parent's *current* HEAD. A checkpoint does not record which
HEAD it was captured on, so when the user committed between the parent's last
turn and the spawn, that base commit carried the old content on top of the new
commit: it reverted the user's commit, and merging the child's work back undid
it without a conflict (seen with a sub-agent on another machine, and true for
local worktrees as well).

A child now starts from HEAD and the parent's working copy as they are at the
spawn (`captureStartingState`: HEAD, plus a state commit on it through a
private index when anything is uncommitted). That is never less than HEAD, and
it also holds what the parent changed in the turn that spawned the child. A
sub-agent on another machine and "Continue on" send the same state through
Remote Work Kit; its `snapshotRef` input is gone. When the parent's checkout
still holds uncommitted work that the child's base carries, applying a child
that committed goes through `mergeBranchIntoCheckout` with that base, as a
remote result does, since `git merge` refuses to overwrite those files.
