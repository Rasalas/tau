# ADR 0012: An agent spawns threads, not sub-sessions

## Status

Accepted, 2026-09-06.

## Context

Delegation is the one thing an agent cannot do inside Tau today. Pi can nest a
run inside a run, and that is what most agent frameworks do: a sub-agent is a
private conversation the user never sees, its output a tool result. In Tau that
would hide the interesting half of the work. The user could not read the
sub-agent's transcript, could not answer a question it asks, could not steer or
abort it, and the sidebar would show one thread doing something opaque for ten
minutes.

Tau already has the right object for a unit of agent work: a thread. Core owns
threads ([ADR 0003](0003-core-owns-threads-extensions-own-navigation.md)) and
gives every open one its own runtime
([ADR 0004](0004-one-pi-runtime-per-thread.md)).

## Decision

**A sub-agent is an ordinary Tau thread.** `tau_spawn_thread` creates a thread
in the caller's project, with its own Pi runtime, its own session file and its
own row in the sidebar. Nothing about it is special except a link back to the
thread that started it. It streams, it can be opened, steered, aborted, renamed,
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
`running | waiting | idle | completed | failed` from the thread snapshot
(`isStreaming`, `isIdle`), the turn observer's `ended`, and Pi's
`ui_prompt_start`/`ui_prompt_end` in the child's runtime. Nothing asks the
sub-agent how it is doing.

**The link lives in both session files** as custom entries
(`tau.agents/parent` on the child, `tau.agents/child` on the parent), the same
durable seam turn checkpoints use. `beforeOpen` reads them back, so opening
either thread after a restart restores the relation. A spawned thread that has
not been opened since a restart is listed flat until it, or its parent, opens.

**Guard rails.** Eight live children per parent; two levels of nesting, so a
sub-agent may delegate once and its child may not; a project the host already
has open, never a new folder; the parent's model unless the caller names one;
a wait bounded at ten minutes by default and thirty at most, which also gives up
on the tool's own `AbortSignal`. A thread being waited on reports pending work
to the turn observer, so the host does not release its runtime underneath.

**The navigator draws the relation, core does not.** A desktop extension
publishes `setThreadLineage({ parents, markers, workingChildren })` and whichever
sidebar is active nests the rows, marks them and shows a live count of a
parent's working children. `UiSession` gains no field: lineage is an extension's
claim about threads, not a fact core keeps.

## Consequences

- The user watches sub-agents work, opens them, answers their questions and
  keeps their transcripts. Nothing is hidden inside a tool result.
- A sub-agent costs a live runtime. The host keeps six, so eight busy children
  push older idle threads out; a busy or waited-on thread is never released.
- The parent's tool call returns in milliseconds and the work happens
  afterwards, so a parent that never waits simply gets threads it does not read.
- Another kit could publish lineage for something else — a fork, a retry — and
  the sidebar would nest it without knowing what it is.
- We rejected nesting Pi sessions (invisible, unanswerable, unsteerable) and
  rejected putting `parentThreadId` in `UiSession` (core would then own a
  relation only an extension creates).
