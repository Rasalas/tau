# What Tau core is

Tau core is Pi in a window, plus threads. This document is the list. Anything not on it is an extension, and safe mode (`npm run start:safe`) must show exactly this list and nothing more.

## In core

Transcript

- user, assistant and notice messages, streamed
- thinking, rendered and collapsible, the way Ctrl+T works in the terminal
- tool calls with live output, elapsed time and stop; presentation of a tool is an extension concern, its existence is not
- Pi extension dialogs: select, confirm, input, editor; notifications
- bounded history paging

Composer

- text, images, queued steering and follow-up messages, abort
- Pi commands: extension commands, `/skill:` and prompt templates, as Pi reports them
- model, thinking level, context usage and compaction

Threads

- the thread index across projects, and one live runtime per open thread
- new, resume, fork, duplicate, rename, tree navigation, recovery of a broken thread
- the current project (working directory) as Pi sees it

Workbench

- the window, the two layout slots (left sidebar, right dock) and shared modals
- command palette and keybinding dispatch; the chords themselves are extension contributions
- extension lifecycle on both sides: desktop extensions in the renderer, host extensions in the host
- typed messages between renderer and host, including the one generic channel host extensions use
- the login shell's environment for everything the host spawns, and `findCommand` on the seam for extensions that need a tool from the machine
- enough persisted state to restore the workbench

## Not in core

These exist today, some still inside core files. They are extension work, and Phase 1b in [PLAN.md](../PLAN.md) moves them.

| Feature | Owner today | Belongs to |
|---|---|---|
| Git status, staging, commit, push, worktrees, file tree, file reading, editors, branch labels and repository names in the thread index | Workspace Kit on both sides: host commands, its own Git cache and the project facts it supplies through `describeProjects` (ADR 0007); core lends the title-bar region, the composer footer, the transcript footer and the document source seam for the stage | Workspace Kit |
| Turn checkpoints and restore | Workspace Kit on both sides: capture, restore, recovery and ref upkeep in `src/main/extensions/workspace-kit-lifecycle.ts` through the seam's lifecycle hooks and turn observer; cards, status and the restore dialog in `src/renderer/extensions/workspace-checkpoints.tsx`. Core keeps only what an anchor needs: a pinned text-empty assistant entry stays in the transcript | Workspace Kit |
| Review mode, diff viewer, changed-files dock | Review Kit overlay over Workspace Kit state; dock is a Workspace Kit region | Review Kit |
| Stage tabs, file viewer | tabs and placement stay core (the document area); loading, changed markers and editors come from the registered document source | core placement, Workspace Kit content |
| Thread title generation | Thread Title Generator: `src/main/extensions/thread-titles-host-extension.ts` and `src/renderer/extensions/title-generator.tsx` | Thread Title Generator |
| Access gate (read-only, ask, full) | Access Kit: `src/main/extensions/access-host-extension.ts` and `src/renderer/extensions/access-kit.tsx` | Access Kit, on by default; approvals are Pi `ctx.ui.confirm` questions |
| Service tier, questionnaire, computer use | host extensions under `src/main/extensions/`; the questionnaire pages through its questions with its own prompt renderer (`src/renderer/extensions/questionnaire-kit.tsx`) | separate packages |
| Claude Code backend | bundled host extension `tau.claude-code` (`src/main/extensions/claude-code/`) registering a runtime backend through `registerRuntimeBackend`; core knows only Pi (ADR 0005 amendment) | Claude Code extension, bundled by default |
| Project sources: folder browsing, native folder picker, Git clone | Workspace Kit host entry; core keeps the sources modal as the placement for `registerProjectSource` | Workspace Kit |
| Markdown export, clipboard, image preview | `src/main/index.ts`, `PiHost` | core (Pi has /export and /copy) |

## How to check

- `start:safe` shows the core list and nothing more. That includes no access gate: safe mode runs tools the way Pi does.
- Removing a bundled kit removes its behavior on both sides without editing core.
- `src/shared/contracts.ts` and `src/main/index.ts` name no feature. Feature commands travel through `invokeHostExtension`.
- `PiHost` delegates attached-Pi ownership, transcript projection, client-message correlation, extension questions and session-event translation to focused modules. The renderer delegates layout to `Workbench` and keeps per-thread composer data in `ComposerScopeStore`.
- Tests keep this true: `src/shared/core-boundary.test.ts` fails on a feature name in those two files outside a listed debt and caps `pi-host.ts` at 3,000 lines and `App.tsx` at 1,800. `src/main/pi-host-safe-mode.test.ts` proves safe mode loads no host or Pi extension, and `src/renderer/extensions/kit-lifecycle.test.tsx` activates and removes every bundled kit against the core slots.
