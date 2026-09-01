# Tau domain language

This glossary defines the product terms used in Tau discussions and documents.

## Agent runtime

The system that executes an agent loop, selects models, invokes tools, and persists runtime state. Pi is Tau's agent runtime.

## Workbench

The interactive client in which a person manages projects, threads, agent activity, and extension-provided workflows. Tau is the workbench.

## Host

The process that owns an agent runtime and exposes it to a workbench client. A host may run on the same machine as the client or remotely.

## Project

A user-recognizable body of work that can contain threads. A project has a source and resolves to a workspace that a host can open. A local repository or folder is a project. Future project sources may resolve remote repositories or managed environments.

## Project source

An extension-provided way to add or resolve a project. Local folder selection and Git cloning are current project sources.

## Workspace

The filesystem root and execution context currently opened by a host for a project. A project is the durable user-facing concept. A workspace is the host-facing context in which tools run.

## Thread

A user-facing stream of agent work within a project. A thread contains conversation history and provides the place a user returns to when continuing that work.

## Session

The persisted runtime record that backs a thread. Pi currently provides Tau sessions. Thread and session are not synonyms: thread is the product concept, while session is the runtime record.

## Stage

The document area of the workbench beside the conversation. It shows workspace files as tabs, each as source or as its working-tree diff, so a person can read what the agent touches without leaving the thread. The conversation is never a stage tab.

## Stage tab

One open document in the stage. A preview tab comes from a single click and is replaced by the next preview; a pinned tab stays until closed.

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
runtime eviction alone does not delete them.
