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
- new, resume, fork, rename, tree navigation, recovery of a broken thread
- the current project (working directory) as Pi sees it

Workbench

- the window, the two layout slots (left sidebar, right dock) and shared modals
- command palette and keybinding dispatch; the chords themselves are extension contributions
- extension lifecycle on both sides: desktop extensions in the renderer, host extensions in the host
- typed messages between renderer and host, including the one generic channel host extensions use
- enough persisted state to restore the workbench

## Not in core

These exist today, some still inside core files. They are extension work, and Phase 1b in [PLAN.md](../PLAN.md) moves them.

| Feature | Owner today | Belongs to |
|---|---|---|
| Git status, staging, commit, push, worktrees, file tree, file reading, editors | Workspace Kit on both sides: host commands and `src/renderer/extensions/workspace-store.ts`; core lends the title-bar region, the composer footer, the transcript footer and the document source seam for the stage | Workspace Kit |
| Turn checkpoints and restore | wire and UI: Workspace Kit (`src/renderer/extensions/workspace-checkpoints.tsx`, host commands); lifecycle still in `PiHost` behind `services.checkpoints`, summaries still in `thread-detail` because transcript anchors depend on them | Workspace Kit |
| Review mode, diff viewer, changed-files dock | Review Kit overlay over Workspace Kit state; dock is a Workspace Kit region | Review Kit |
| Stage tabs, file viewer | tabs and placement stay core (the document area); loading, changed markers and editors come from the registered document source | core placement, Workspace Kit content |
| Thread title generation | Thread Title Generator: `src/main/extensions/thread-titles-host-extension.ts` and `src/renderer/extensions/title-generator.tsx` | Thread Title Generator |
| Access gate (read-only, ask, full) | Access Kit: `src/main/extensions/access-host-extension.ts` and `src/renderer/extensions/access-kit.tsx` | Access Kit, on by default; approvals are Pi `ctx.ui.confirm` questions |
| Service tier, questionnaire, computer use | host extensions under `src/main/extensions/`; the questionnaire pages through its questions with its own prompt renderer (`src/renderer/extensions/questionnaire-kit.tsx`) | separate packages |
| Claude Code backend | `PiHost`, runtime adapters | stays supported; its implementation becomes its own package behind the ADR 0005 seam |
| Project sources: folder browsing, native folder picker, Git clone | Workspace Kit host entry; core keeps the sources modal as the placement for `registerProjectSource` | Workspace Kit |
| Markdown export, clipboard, image preview | `src/main/index.ts`, `PiHost` | core (Pi has /export and /copy) |

## How to check

- `start:safe` shows the core list and nothing more. That includes no access gate: safe mode runs tools the way Pi does.
- Removing a bundled kit removes its behavior on both sides without editing core.
- `src/shared/contracts.ts` and `src/main/index.ts` name no feature. Feature commands travel through `invokeHostExtension`.
