# ADR 0013: An agent spawns threads, not sub-sessions

## Status

Accepted, 2026-09-06. Amended 2026-09-06: a released thread's transcript is read
from its session file (see below).

## Context

Delegation is the one thing an agent cannot do inside Tau today. Pi can nest a
run inside a run, and that is what most agent frameworks do: a sub-agent is a
private conversation the user never sees, its output a tool result. In Tau that
would hide the interesting half of the work. The user could not read the
sub-agent's transcript, could not answer a question it asks, could not steer or
abort it, and the workbench would show one thread doing something opaque for ten
minutes.

Tau already has the right object for a unit of agent work: a thread. Core owns
threads ([ADR 0003](0003-core-owns-threads-extensions-own-navigation.md)) and
gives every open one its own runtime
([ADR 0004](0004-one-pi-runtime-per-thread.md)).

## Decision

**A sub-agent is an ordinary Tau thread.** `tau_spawn_thread` creates a thread
in the caller's project, with its own Pi runtime, its own session file and its
own entry in the thread index. Nothing about it is special except a link back to
the thread that started it. It streams, it can be opened, steered, aborted, renamed,
forked and deleted like any other, and a question it asks is answered by the
user *in that thread*, because that is where its `ctx.ui` dialog belongs.

**The kit is `tau.agents`**, a bundled kit with `sessions` and `runtime:extend`
(`kits/agents/host.ts`; it was `src/main/extensions/agents-host-extension.ts` when this was decided). Its host half registers one
Pi extension into every Tau-hosted runtime, contributing four tools:
`tau_spawn_thread`, `tau_get_thread_status`, `tau_wait_for_thread` and
`tau_list_threads`. The calling thread's id is the `RuntimeSessionInfo` the seam
hands the runtime extension factory, so a thread can only ever address the
threads it spawned itself.

**One seam member was missing and was added:** `sessions.start(options)` creates
a thread for a project, indexes it and delivers its first prompt without ever
competing for the visible thread. It is plain data in and out, so it crosses the
worker boundary of [ADR 0009](0009-extension-permissions.md) as well.
`sessions.prepare` could not serve this: it takes an existing session file and
its `activate()` puts the thread on screen, which is exactly what a background
sub-agent must not do.

**Status comes from the host, not from the child's own report.** The kit derives
`pending | running | waiting | idle | completed | failed` from the thread snapshot
(`isStreaming`, `isIdle`), the turn observer's `ended`, and Pi's
`ui_prompt_start`/`ui_prompt_end` in the child's runtime. Nothing asks the
sub-agent how it is doing.

**The link lives in both session files** as custom entries
(`tau.agents/parent` on the child, `tau.agents/child` on the parent), the same
durable seam turn checkpoints use. `beforeOpen` reads them back whenever either
thread opens. That alone is too late for the navigator: it would show fifty
agent threads in the rail until the user opened one of them. So the kit also
keeps its own index, `~/.tau/agents-links.json`, written whenever a link is
created and read *before* the extension finishes activating, so the first state
the desktop half asks for already holds every link from the last run. The index
sweep prunes an entry whose thread the index no longer lists, and one whose
parent is gone — that thread is an ordinary thread again. The session entries
stay the record of truth; the file is only the fast index.

**Capacity queues, it does not refuse.** A parent runs eight children at a time
(`maxRunningAgents` in `~/.tau/agents.json`, capped at 64). A spawn beyond that
is accepted with status `pending` and starts when a slot frees, oldest first, so
`tau_spawn_thread` never fails for capacity and a model does not have to
implement its own back-off. Every other guard rail still refuses: two levels of
nesting, so a sub-agent may delegate once and its child may not; a project the
host already has open, never a new folder; the parent's model unless the caller
names one; a wait bounded at ten minutes by default and thirty at most, which
also gives up on the tool's own `AbortSignal`. A thread being waited on reports
pending work to the turn observer, so the host does not release its runtime
underneath. A queued agent has a stable handle from the moment it is accepted;
the tools take that handle or the thread id, whichever the caller has.

**Agents get their own dock panel, not the thread rail.** Fifty agents in the
left rail would bury the threads the user started, and switching to one would
lose the conversation that spawned it. The Agents panel sits in the right dock
beside the chat: a header with the counts and the total cost, then one
fixed-height row per agent — status dot, title, elapsed, one activity line
(current tool, question, result or error) and a metadata line with model and
cost. It shows the agents of the thread on screen; a thread that is itself an
agent sees its siblings and the thread above it, grouped by parent once depth 2
is in play. Clicking a row opens that thread, and that thread's transcript
header carries the way back. Rows are virtualized and elapsed time is written
into the text node rather than committed through React, because fifty rows
ticking once a second is otherwise the whole frame.

**The navigator only learns which threads are agents.** A desktop extension
publishes `setThreadLineage({ parents, workingChildren })`; the sidebar keeps
spawned threads out of the list, shows a live `N running` badge on the parent
row, and reveals them behind a "Show agent threads" toggle. Hiding is
presentation only: search, the thread index and switching to a child all still
see them, and the thread on screen is never hidden. `UiSession` gains no parent
field — lineage is an extension's claim about threads, not a fact core keeps.

## Amendment, 2026-09-06: spawning is parallel

The first ten-child run started children 2.2 s apart and never had more than
two running at once: they finished faster than the host started the next. Three
things serialised the work, and the measurement named all three.

`startThread` held the global lifecycle queue for the whole open, and the open
cost 2.1 s. Almost none of that was the Pi runtime, which took 86-149 ms with a
warm resource cache. It was `beforeOpen`: `openThread` ran the thread lifecycle
hooks for a session it was creating in the same call, and the checkpoint kit
tried to sweep orphan refs for it. The turn that called `tau_spawn_thread` holds
the workspace checkpoint lease, so every child waited the full 2 s
`MAINTENANCE_LEASE_TIMEOUT_MS` and then skipped the sweep anyway. A session
with no entries has nothing beside it, so core no longer asks: `beforeOpen`
runs for a session that already existed, not for one this call is creating.

**The queue gained a bounded background lane** rather than losing its
serialisation. `LifecycleQueue.runBackground` admits four operations at once;
every exclusive operation - switching, forking, disposing, `sessions.exclusive`
- still excludes all of them, and admission stays FIFO, so a switch waits for
the batch in flight and no longer for a chain of twenty starts. This is what
`start-thread` uses. The alternative, hoisting runtime construction out of the
queue and re-entering it only to register the thread, would have had to prove
that every extension's `beforeOpen` is safe to run concurrently with a switch;
a lane proves nothing and needs nothing proved.

**A spawn claims its own slot.** Twenty `tau_spawn_thread` calls arrive in one
turn, before any of them has a thread. The pump handed slots out one at a time
behind a single promise, so the second call waited for the first thread to
exist. A spawn now takes a free slot synchronously and starts its own agent;
the pump only drains what freed slots allow, and it starts that batch at once.
A spawn beyond the budget still returns `pending` immediately.

Measured on the same twenty-child prompt: the running count reaches the budget
of eight within about three seconds of the first spawn, where before ten
children took 22.5 s to start and one or two ran at a time.

**The link index keeps when an agent ran.** `~/.tau/agents-links.json` is
version 2 and carries `startedAt` and `endedAt`, so an agent restored after a
restart still shows its duration instead of an em dash. A version 1 file reads
as before, without the times.

## Amendment, 2026-09-06: the thread index knows a child's parent

The original decision left the link in two places, and both could be absent at
once. `beforeOpen` reads the custom entries back only when someone opens the
parent or the child, and `~/.tau/agents-links.json` is a file a user can delete.
That is what happened: the links file was gone, no parent had been reopened, and
fifty sub-agents were ordinary threads in the rail again. Nothing else on disk
said what they were.

**A spawned thread now records the link itself, before its first prompt.**
`sessions.start` takes a `parent`, and the host appends the `tau.agents/parent`
entry to the new session as the entry after its header. The thread index reads
two lines of each session file it has not answered for, so it knows the child's
parent without opening either thread and without asking any extension
(`src/main/session-lineage.ts`).

**`UiSession` gains `parentThreadId`**, reversing this ADR's own rejection of
it. The reason that rejection gave still holds - lineage is a relation an
extension creates - but the *record* of it is a fact the thread's own session
file carries, and the index reads facts off session files for a living (title,
cwd, model provider, cost). Nothing else in the workbench could hide fifty
threads on first paint from a file no one had opened. The kit's lineage still
wins where it exists; `parentThreadId` is what answers when it does not.

**Pi's own header field was the wrong seam.** `SessionHeader.parentSession`
would have been free - `SessionManager.list` already returns it as
`parentSessionPath` - but it is a path, and Pi writes it for `/new` chains and
for `createBranchedSession`, which is how Tau forks a thread. Hiding by it would
have hidden every forked thread from the rail.

**The reads are cached like the rest of the index**, keyed by session file plus
size and mtime, in `session-lineage.json` beside the usage cache. A parent never
changes, so a file that once answered is never read again. A cache this build
did not write - none at all, or one from an older version - makes the first pass
of the run read whole files instead of two lines, which is how children created
before the entry moved to the front are found once and then cached like
everything else.

**`~/.tau/agents-links.json` stays, and is no longer load-bearing.** It carries
`startedAt` and `endedAt`, which no entry written at spawn time can know, so an
agent restored after a restart still shows how long it ran. Everything else in
it the index now carries: the sweep restores a link for any indexed session with
a `parentThreadId` the book does not know, so the tools, the running budget and
the depth limit survive the file's loss as well as the rail does.

## Amendment, 2026-09-06: a sub-agent's chat is a document, not a destination

Clicking a row switched the active thread. That moved the composer to the child
and, because the rail never hides the thread on screen, put the child in the
sidebar — the two things the user reads a sub-agent to avoid. A row now calls
`WorkbenchActions.openThread(sessionId)` and the child's transcript opens as a
tab in the stage, read-only, beside the file tabs. "Take over" in that tab's
header is the deliberate switch for a user who does want to talk to it.

With that in place, the rail's exceptions go. A thread with a parent is never
listed — not in the settled shelf, not in a search, not while it is the thread
on screen after a take-over — so `visibleThreads` takes no options any more and
the "Show agent threads" toggle is gone. The Agents panel is the list of
sub-agents, and the stage is where you read one; the transcript header still
names the thread you are in and links back to its parent.

The tab reads through `transcript-page`, which at first the host answered only
for a thread it was still holding a runtime for. The fourth amendment removes
that rough edge.

## Consequences

- The user watches sub-agents work, opens them, answers their questions and
  keeps their transcripts. Nothing is hidden inside a tool result.
- A sub-agent costs a live runtime. The host keeps six, so eight busy children
  push older idle threads out; a busy or waited-on thread is never released.
  That is also why the running budget is a budget and not a hard refusal: work
  beyond it waits for a runtime rather than being lost.
- The parent's tool call returns in milliseconds and the work happens
  afterwards, so a parent that never waits simply gets threads it does not read.
- Another kit could publish lineage for something else — a fork, a retry — and
  the navigator would fold it away and count it without knowing what it is.
- Cost per row comes from `UiThreadUsage` on the thread index, so the panel
  never opens a child to price it, and every cost reads `–` until the host
  counts one.
- A deleted `agents-links.json`, a fresh machine, or a kit that never activated
  costs an elapsed time and a live status, not the fact that a thread is an
  agent's.
- A stage tab is bounded work: the tab strip already holds files, and a thread
  in it costs the same attention a file does.
- We rejected nesting Pi sessions (invisible, unanswerable, unsteerable) and
  rejected nesting agent rows in the thread rail (it does not survive fifty of
  them, and it costs the user the conversation they were reading). We rejected
  putting `parentThreadId` in `UiSession` and then reversed that; see the second
  amendment for why.

## Amendment, 2026-09-06: a transcript outlives its runtime

A thread's transcript is in its session file, not in the runtime, so refusing to
read one because no runtime holds it was a host limitation rather than a fact
about the thread. With `MAX_LIVE_THREADS` at six and fifty agents in a run, that
refusal was the common case: most open tabs read "That thread is not open any
more".

`PiHost.loadTranscript` now answers for a thread without a runtime by projecting
its session file — `SessionManager.open(path).getBranch()` through the same
projection the live path uses (`branchRecords`, `mapMessage`, `localTranscriptPage`).
Paging, cursors, task and turn-activity history, entry pins and client-message
correlation are the live path's, not a second implementation of them; the live
path itself is unchanged. `read-tool-output` follows the same fallback, so "copy
full output" works in a released thread's tab too. The tab drops its "Take over
makes it load" hint, and an error there now means the file itself is gone.

An extension's `pinTranscriptEntries` provider is therefore also called with a
thread the host has only a file for: it answers `sessionId`, `cwd`,
`sessionFile`, `parentThreadId`, `sessionName()`, `entries()` and `transcript()`,
and throws from the members that need a runtime.
