# ADR 0006: Host extensions own host features

## Status

Accepted, 2026-09-02.

## Context

ADR 0002 gave desktop extensions the views of a feature, but the behavior behind those views stayed in core: `PiHost` carried Git, checkpoints, title generation and editors as public methods, and every one of them had its own IPC channel mirrored in `src/shared/contracts.ts`, `src/preload/index.cts` and `src/main/index.ts`. Deactivating Workspace Kit removed its panels and left its host code, its IPC entries and its orchestration in `App.tsx` in place. Nothing could really be removed, and nothing outside the repository could add host behavior.

Pi solves the same problem for the agent runtime with one extension API. Tau needs the equivalent on the host.

## Decision

The host gets an extension registry (`src/main/host-extensions.ts`). A host extension is `{ id, name, activate(context) }`. Its context offers `registerCommand(name, handler)`, `emit(name, payload)` and a narrow `services` facade: the current workspace, project identity, the shared Git cache, logging and `openWorkspace`.

The renderer reaches every host extension through one desktop API call, `invokeHostExtension(extensionId, command, input)`, and receives from it through one global event, `extension-event`. A desktop extension sees its own host entry as `context.host` with `invoke` and `onEvent`, scoped to its id. Core routes by id and validates nothing about the payload; a host extension treats its input as untrusted.

A feature package therefore has up to three entries: a Pi extension (agent behavior), a host extension (host behavior) and a desktop extension (views). They share a contract file the package owns, such as `kits/workspace/protocol.ts`. Core never imports it.

Workspace Kit's Git and file commands are the first host extension. Safe mode starts the host with no host extensions.

## Consequences

- `PiHost` and the IPC table shrink by one method per moved feature and grow by nothing when a new feature arrives.
- The services facade is the new place where core leaks: what a host extension may ask for is an explicit list, and adding to it is a design decision.
- Features that live beside sessions get generic hooks rather than core code: `registerThreadLifecycle` (before a workspace or session opens, after a fork, around activation, the index sweep), `registerTurnObserver` (accept, prepare, cancel and end of a prompt), `pinTranscriptEntries` (entries a row anchors to) and `sessions` (open a session file, prepare a runtime off screen). Turn checkpoints were the feature that needed them; core no longer knows they exist.
- The shared Git cache stays in core for now because the thread index shows branches. That is the next thing to question.
- `App.tsx` still orchestrates the moved commands through the kit's typed client. Moving that orchestration needs the renderer contribution points listed in PLAN.md, Phase 1b, step 4.
- Dynamic loading of host extensions from disk follows the desktop extension loader once the trust model (Phase 3) exists; until then host extensions are bundled.
