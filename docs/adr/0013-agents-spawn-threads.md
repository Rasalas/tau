# ADR 0013: An agent spawns threads, not sub-sessions

## Status

Accepted, 2026-09-06.

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
(`src/main/extensions/agents-host-extension.ts`). Its host half registers one
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
- We rejected nesting Pi sessions (invisible, unanswerable, unsteerable),
  rejected putting `parentThreadId` in `UiSession` (core would then own a
  relation only an extension creates), and rejected nesting agent rows in the
  thread rail (it does not survive fifty of them, and it costs the user the
  conversation they were reading).
