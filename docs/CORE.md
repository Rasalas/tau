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
- command palette and keybindings
- extension lifecycle on both sides: desktop extensions in the renderer, host extensions in the host
- typed messages between renderer and host, including the one generic channel host extensions use
- enough persisted state to restore the workbench

## Not in core

These exist today, some still inside core files. They are extension work, and Phase 1b in [PLAN.md](../PLAN.md) moves them.

| Feature | Owner today | Belongs to |
|---|---|---|
| Git status, staging, commit, push, worktrees, file tree, file reading, editors | `src/main/extensions/workspace-host-extension.ts` on the host; orchestration still in `App.tsx` | Workspace Kit |
| Turn checkpoints and restore | `PiHost`, `host-protocol.ts`, `App.tsx` | Workspace Kit |
| Review mode, diff viewer, changed-files dock | `App.tsx` state, Review Kit views | Review Kit |
| Stage tabs, file viewer | `App.tsx` | Workspace Kit |
| Thread title generation | Thread Title Generator: `src/main/extensions/thread-titles-host-extension.ts` and `src/renderer/extensions/title-generator.tsx` | Thread Title Generator |
| Access gate (read-only, ask, full) | Access Kit: `src/main/extensions/access-host-extension.ts` and `src/renderer/extensions/access-kit.tsx` | Access Kit, on by default; approvals are Pi `ctx.ui.confirm` questions |
| Service tier, questionnaire, computer use | injected Pi extensions in `PiHost` | separate packages |
| Claude Code backend | `PiHost`, runtime adapters | stays supported; its implementation becomes its own package behind the ADR 0005 seam |
| Clone, project picker, markdown export, clipboard | `src/main/index.ts` | Workspace Kit or small packages |

## How to check

- `start:safe` shows the core list and nothing more. That includes no access gate: safe mode runs tools the way Pi does.
- Removing a bundled kit removes its behavior on both sides without editing core.
- `src/shared/contracts.ts` and `src/main/index.ts` name no feature. Feature commands travel through `invokeHostExtension`.
