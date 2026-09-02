# Tau plan

This plan turns the direction in [VISION.md](VISION.md) into testable phases. It records intent rather than release dates.

## Current prototype

The prototype already proves several basic facts:

- Electron can host the real Pi SDK and stream agent state to a React renderer.
- Existing Pi models, credentials, sessions, tools, skills, and extensions remain available.
- The renderer can show messages, thinking, tool activity, files, Git changes, runtime state, and commands.
- A desktop extension registry can add panels, sidebar modules, project sources, commands, and tool renderers.
- Workspace Kit owns project navigation, local-folder selection, Git cloning, Files, and Changes.
- The project search modal uses persisted recent projects.
- Workspace Kit contributes the complete left sidebar, which aggregates recent Pi threads across projects and shows project, title, branch, live activity, and settled state.
- Thread Title Generator uses an independently selected model and supports automatic and manual naming without adding conversation messages.
- Safe mode starts the minimal workbench with both Pi and desktop extensions disabled and empty layout slots collapsed.

This is enough to evaluate the architecture in use. It is not enough to install untrusted third-party extensions or connect a remote client.

## Phase 1: validate the workbench model

Use the application for real agent work and fix the interaction model before stabilizing extension interfaces.

Planned work:

- test extension activation and deactivation, including removal of Workspace Kit
- add host-to-workbench bridges for generic confirm, select, and text-input interactions
- improve thread navigation, naming, creation, and session recovery
- make queued follow-up and steering messages visible and editable
- refine project search and add-project workflows through additional project-source adapters
- decide which navigation and modal rules every desktop extension must follow
- capture failure states for disconnected hosts, missing repositories, aborted runs, and extension errors

Completion check: a user can work across several projects and threads for a week without reaching for the Pi TUI for a missing core interaction, and Workspace Kit can be removed without breaking Tau core.

## Phase 1b: shrink the core

The prototype proved the desktop seam, but core still owns the behavior behind most features. [docs/CORE.md](docs/CORE.md) defines what "Pi in a window, plus threads" includes; everything else moves out in this order.

Planned work, in order:

1. write down the core (done: `docs/CORE.md`) and make safe mode the proof of it
2. add a host-side extension seam so a package can own host commands and events (done: ADR 0006, `src/main/host-extensions.ts`)
3. move features out by size: Git and workspace (done: `src/main/extensions/workspace-host-extension.ts`), then title generation (done: `src/main/extensions/thread-titles-host-extension.ts`), service tier, questionnaire and computer use (done as host extensions), project sources incl. clone (done), turn checkpoints; the Claude Code backend stays a supported runtime, keeps its ADR 0005 seam, and its implementation becomes its own package
4. add the renderer contribution points the moved features need: real keybindings, slash commands, regions next to the transcript and composer, a status line, host event subscriptions, extension state, so the orchestration in `App.tsx` can follow the views into the kits
5. close the gaps to the Pi terminal: render thinking (done: collapsed blocks with a toggle command), tree/fork/clone, map `ctx.ui` status, widget, footer and notify onto workbench slots, honor `registerShortcut` and `keybindings.json`, register the hard-coded slash commands as Pi commands
6. make the access gate a default-on extension (done: Access Kit owns the level, the Pi gate and the composer control; approvals use Pi's `ctx.ui.confirm`, so the core approval overlay and its IPC entries are gone)

Completion check: `start:safe` shows exactly the core listed in `docs/CORE.md`; every bundled kit can be removed on both the host and the desktop side without editing core; no feature name appears in `src/shared/contracts.ts` or `src/main/index.ts`.

## Phase 2: load extension packages dynamically

Replace the bundled-only registry with a package loader.

Planned work:

- define a versioned desktop extension manifest
- discover installed extensions without source edits
- persist enablement and extension settings
- report activation failures without preventing Tau from starting
- define compatibility checks for Tau, Pi, and contribution interface versions
- let one package declare both Pi and desktop entry points
- add development tooling for reloading and inspecting extensions

Completion check: a separately packaged extension can be installed, enabled, disabled, upgraded, and removed without rebuilding Tau.

## Phase 3: define trust and isolation

Dynamic code needs an explicit security model before third-party distribution.

Planned work:

- define permissions for filesystem, process, network, credentials, projects, and host commands
- separate trusted in-process extensions from isolated extensions
- show requested permissions before activation
- isolate renderer UI and validate every host command
- define package provenance, update, and revocation behavior
- add recovery paths for crashing or unresponsive extensions

Completion check: Tau can explain what an extension may access, enforce that decision, and recover when the extension fails.

## Phase 4: make the host transportable

Turn the current Electron IPC adapter into one implementation of a client-to-host protocol.

Planned work:

- define versioned commands, events, snapshots, and capability negotiation
- support reconnect, event replay, cancellation, and partial failure
- distinguish local paths from remote workspace identities
- move long-running project operations behind host jobs with progress events
- add authentication and encrypted remote connections
- test a desktop client against Pi running on another machine

Completion check: the desktop workbench can reconnect to a remote host and continue an existing thread without treating remote files as local paths.

## Phase 5: add other clients

Build web or mobile clients only after the host protocol and extension capability model are stable.

Planned work:

- separate workbench state from Electron-specific behavior
- define which desktop contributions have web or mobile renderers
- adapt navigation and agent supervision for small screens
- keep host-side Pi and project extensions available when a client cannot render their desktop UI

Completion check: a second client can supervise the same host and clearly reports unsupported desktop capabilities.

## Open decisions

These questions are intentionally unresolved:

- What is the manifest and distribution format for a package containing Pi and desktop contributions?
- Which extension code may run in-process, and which code must be isolated?
- Does a thread always map to one Pi session, or can it coordinate several sessions and agents?
- How are project identities preserved when the same repository exists locally, remotely, or in several worktrees?
- Which workbench state belongs to the client, host, project, or extension?
- How much of the desktop extension model should be portable to web and mobile clients?

Record a new ADR when one of these decisions becomes expensive to reverse and has a real alternative.

## Current non-goals

The prototype is not trying to become a full code editor, replace Git tooling, reproduce T3 Code feature for feature, or create a new agent runtime. Those capabilities can arrive through extensions when they improve agent work and justify their maintenance cost.
