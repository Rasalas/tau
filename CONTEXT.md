# Tau domain language

This glossary defines the product terms used in Tau discussions and documents.

## Agent runtime

The system that executes an agent loop, selects models, invokes tools, and persists runtime state. Pi is Tau's default agent runtime; Claude Code is the second one, driven through the Agent SDK by its kit.

## Runtime backend

The owner of one thread's runtime for that thread's whole life (ADR 0005). Core knows the Pi backend; every other one arrives through `registerRuntimeBackend` and speaks to core in Tau's vocabulary: runtime events, a dialog route, an access level. A thread never changes its backend; the workbench chooses it before the first message, from the list the host publishes (`runtimeBackends`), and `TAU_RUNTIME_ADAPTER` only sets the default. A Codex thread may change its executing account between compatible accounts that share its session, while its backend remains its durable owner. A Pi model reached through a subscription login carries `login: "subscription"`; where the vendor forbids that login outside its own apps, the Subscription Login Warning kit asks once per provider and never blocks it.

## Executing account

The account whose credentials and model access a thread uses for its next turn. A compatible account change preserves the thread, its session and its runtime backend owner.

## Home machine

The machine a thread runs on: its agent, workspace, files, shells and git are
there (ADR 0030). It is chosen in the draft and never changes; a thread that
continues on another machine is a new thread there. The device in front of the
person only shows and steers the thread.

## Workbench

The interactive client in which a person manages projects, threads, agent activity, and extension-provided workflows. Tau is the workbench.

## Workbench session

The client-side coordination of a person's threads, drafts, submissions and navigation while the workbench is open. Distinct from a thread's persisted runtime session.

## Host

The process that owns an agent runtime and exposes it to a workbench client. A host may run on the same machine as the client or remotely.

## Project

A user-recognizable body of work that can contain threads. A project has a source and resolves to a workspace that a host can open. A local repository or folder is a project. Future project sources may resolve remote repositories or managed environments.

## Project source

An extension-provided way to add or resolve a project. Local folder selection, Git cloning and creation from a name are current project sources.

## Workspace

The filesystem root and execution context currently opened by a host for a project. A project is the durable user-facing concept. A workspace is the host-facing context in which tools run.

## Workspace identity

How a client names a workspace: an opaque `workspaceId` the host mints from its own persisted id and the workspace's canonical path, plus a `displayPath` for the user to read. A client stores and returns the id and never parses it, so a client on another machine never treats a host path as one of its own. Files inside a workspace are named relative to its root; the host resolves them.

## Thread

A user-facing stream of agent work, optionally grouped in a project. A thread contains conversation history and provides the place a user returns to when continuing that work.

## Subagent

Delegated agent work belonging to a parent thread. A subagent has its own execution context and visible activity, but is not a conversation the person selects in the thread rail. A runtime without native delegation may back a subagent with a hidden Tau thread.

## Projectless thread

A thread started without choosing a project. It has its own private workspace on its home machine, retained when the thread is reopened and kept out of the project list.

## Session

The persisted runtime record that backs a thread. Pi provides the sessions of Pi threads; a Claude Code thread's session is Claude's own session file plus the kit's app-data record that maps the thread to it. Thread and session are not synonyms: thread is the product concept, while session is the runtime record.

## Stage

The document area of the workbench beside the conversation. It shows workspace files as tabs, each as source or as its working-tree diff, so a person can read what the agent touches without leaving the thread. Every tool (Files, Terminal, Agents, Preview) opens as one of its tabs. Maximized, or in a centre too narrow for both, it fills the centre and the conversation folds to its spine, a narrow strip at the stage's left edge that brings it back. Each thread and each draft has its own stage: switching back to a thread shows what was left there.

## Stage tab

One open document in the stage. A preview tab comes from a single click and is replaced by the next preview; a pinned tab stays until closed. Each stage remembers the last twenty tabs closed on it; reopening one brings back a file or thread as it was, and a terminal as a new shell in the thread's folder, never the process it showed.

## Wake

A turn something other than the user started: a pull request event, a goal's next turn, a schedule. An external event waits in the thread's queue and never interrupts a turn; the transcript shows it as a wake line, not as the user's message. Stop drops the wakes that still wait and ends what would send more; the user's own queued messages stay.

## Goal

An objective a thread's runtime pursues across turns of its own until a check says it is met. The runtime keeps it; Tau shows it and offers pause, resume and end where the runtime can. A goal is met only when the runtime said so; one whose run ended without a verdict is not confirmed. Stop pauses it before the run stops where the runtime supports pausing; otherwise the goal stays set until ended.

## Automation

Saved work for a project, started at a configured time or by a signed webhook. Each run creates an ordinary thread that the user can inspect, steer or stop. Uncertain starts require a decision before repeating the work.

## Pull request watch

A thread's ongoing observation of a pull request. Changes to checks, comments, reviews or branch conflicts can wake the thread; closing or merging ends the watch. Watching does not grant permission to merge.

## Private secret request

A request for a value needed by a specific host tool in a project. The user supplies it privately; the agent receives a reference to the tool's binding, never the value itself.

## App page

A page of the app beside the sidebar, like Settings: Usage and Reviews. It takes the place of the thread and the stage while it is open, and the sidebar's foot leads with Back; on a phone it is a screen of its own. Opening a thread leaves it.

## Review

A thread's finished work as a local merge request, with an intended target branch that stays the same when the project's checkout switches branches. It is ready, in conflict, waiting on requested changes, or merged; completed work stays merged, and further work on the thread's branch opens it again.

## Extension

An installable module that contributes behavior through a declared interface and can be activated or deactivated without editing Tau core.

## Pi extension

An extension loaded into the agent runtime. It may add tools, commands, hooks, providers, or agent behavior.

## Desktop extension

An extension loaded into the workbench. It may add sidebar modules, project sources, panels, commands, tool renderers, or future desktop workflows.

## Contribution

One declared piece of behavior that a desktop extension registers with the workbench, such as a sidebar module, panel, command, prompt hook, project source, or tool renderer.

## Core

The minimum workbench and host machinery required to load extensions, run Pi, route typed messages, and provide shared placement and lifecycle. Core does not own optional product features.

## Turn checkpoint

An immutable record for one accepted Pi user turn. Its before tree is captured
immediately before that client turn is delivered to the canonical workspace,
including all pre-existing dirty tracked and non-ignored untracked files. Its
after tree is captured at that turn's final assistant boundary, after retries
and tool calls have ended. The two write-once Git tree refs are namespaced by
the sanitized session ID, client turn ID, and phase, and are validated against
that exact tuple before a diff or restore operation. A checkpoint custom entry
stores only those ref IDs, a bounded summary preview, total file count, line
totals, and the persisted assistant-entry anchor. Complete file lists and
file patches are historical lazy reads from the ref pair, never data copied
into the entry or transport snapshot. Refs remain while the session/checkpoint
is retained, are cloned into a fork's namespace with the same turn anchor, and
are garbage-collected when the owning session is actually deleted or pruned;
runtime eviction alone does not delete them. A ref counts as orphaned only when
neither the persisted session file nor a live thread of that session claims it,
and one written in the last ten minutes is kept whatever the journals say —
publishing the pair and appending its entry are two steps, and no lease spans
the gap once capture has released.

## Server target

A server a project is deployed to, reached over SSH/SFTP or FTP: a host, a
user, a port and a `remotePath` (ADR 0028). It comes from `.vscode/sftp.json`,
an SSH config alias or the user's own entry. It belongs to the project's main
checkout, so its worktrees share it. The agent works on the local copy and never
runs on the server. Not to be confused with the Tau host or a remote host.

## Mirror state

What Tau last read of a server target: the tree of its non-ignored files, kept
in a shadow repository in Tau's own data, never in the project. Pending changes
are the working tree against the mirror state; server drift is the server now
against it.

## Server drift

Changes made on a server target that the mirror state does not know, such as a
colleague's live edit. Tau commits them on a branch `server-drift/<date>` and
merges them only when the user asks.

## Deployment

One upload the user started to a server target: the files it wrote or deleted,
with the server's previous contents kept as a backup, the checkout, branch and
HEAD it came from, and its status (uploaded, verified, committed, rolled back).
It can be rolled back on its own, and a rollback is itself a deployment.
