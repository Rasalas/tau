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
- model, thinking level, context usage and compaction; what the thread has spent so far

Threads

- the thread index across projects, and one live runtime per open thread
- new, resume, fork, duplicate, rename, tree navigation, recovery of a broken thread
- the current project (working directory) as Pi sees it

Workbench

- the window, the two layout slots (left sidebar, right dock) and shared modals
- command palette and keybinding dispatch; the chords themselves are extension contributions
- extension lifecycle on both sides: desktop extensions in the renderer, host extensions in the host
- one versioned request/push protocol between client and host, with reconnect and replay; Electron IPC is one transport of it, and the one generic method host extensions use travels on it
- `sessions.start` on the host seam: an extension has core create a thread for a project, index it and deliver its first prompt, without ever taking the screen
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
| Thread title generation | Thread Title Generator: `kits/thread-titles/`, a package Tau ships (ADR 0014) | Thread Title Generator |
| Signals: host events, live counts and the shell-run presentation | Signals: `kits/signals/`, a package Tau ships (ADR 0014); core lends the panel slot and the `useObservatory` hook it reads | Signals |
| Access gate (read-only, ask, full) | Access Kit: `src/main/extensions/access-host-extension.ts` and `src/renderer/extensions/access-kit.tsx` | Access Kit, on by default; approvals are Pi `ctx.ui.confirm` questions |
| Preview browser: the panel, the `WebContentsView` over it and the `preview_*` tools the agent drives it with | Preview Kit: `src/main/extensions/preview-host-extension.ts` with `preview-view.ts` and `preview-page-script.ts`, and `src/renderer/extensions/preview-panel.tsx` with `preview-store.ts` and `overlay-watch.ts`; core lends the panel slot, one composer region, and `src/renderer/reserved-region.ts` — the rectangle a native view owns, which core's own floats keep clear of ([ADR 0012](adr/0012-preview-browser.md)) | Preview Kit |
| Service tier, questionnaire | host extensions under `src/main/extensions/`; the questionnaire pages through its questions with its own prompt renderer (`src/renderer/extensions/questionnaire-kit.tsx`) | separate packages |
| Computer use: the desktop-automation tools and how a run of them reads in the transcript | Computer Use: `kits/computer-use/`, a package Tau ships (ADR 0014). The host loads the `@amaster.ai/pi-computer-use` npm package through `loadRuntimeExtension` — its driver binaries have to stay where npm put them — and the kit contributes it to every runtime unless the user configured the Pi package themselves | Computer Use |
| Spawning sub-agents | Agents Kit: `src/main/extensions/agents-host-extension.ts` contributes `tau_spawn_thread`, `tau_get_thread_status`, `tau_wait_for_thread` and `tau_list_threads` to every runtime; a sub-agent is an ordinary thread in the same project (ADR 0013). `src/renderer/extensions/agents-kit.tsx` owns the Agents dock panel and publishes the lineage the navigator folds away and counts; the kit keeps its own link index in `~/.tau/agents-links.json` so the rail hides agent threads from the first paint | Agents Kit |
| Claude Code backend | bundled host extension `tau.claude-code` (`src/main/extensions/claude-code/`) registering a runtime backend through `registerRuntimeBackend`; core knows only Pi (ADR 0005 amendment) | Claude Code extension, bundled by default |
| Project sources: folder browsing, native folder picker, Git clone | Workspace Kit host entry; core keeps the sources modal as the placement for `registerProjectSource` | Workspace Kit |
| Markdown export, clipboard, image preview | `src/main/index.ts`, `PiHost` | core (Pi has /export and /copy) |

## How to check

- The kits Tau ships live under `kits/<name>/` with a `tau-extension.json` and load through the package loaders, from `dist-kits/` when the app was built and from the sources otherwise. `src/shared/kits-boundary.test.ts` fails when a kit reaches into `src/**` outside `tau`, `tau/host-extension` and `tau/host`, or when `src/**` reaches into a kit. `src/main/extensions/index.ts` and `src/renderer/extensions/index.tsx` hold what has not moved yet.
- `start:safe` shows the core list and nothing more. That includes no access gate: safe mode runs tools the way Pi does.
- Removing a bundled kit removes its behavior on both sides without editing core.
- `src/shared/contracts.ts` and `src/main/index.ts` name no feature. Feature commands travel through `invokeHostExtension`. Core operations are the method table in `src/main/host-methods.ts`; `src/main/ipc-contract.test.ts` fails when the client and the table stop naming the same methods.
- Thread lineage is an extension's claim, not a core field: a desktop extension publishes `setThreadLineage`, and the navigator hides spawned threads and counts a parent's working children from it. `UiSession` has no parent.
- `PiHost` delegates attached-Pi ownership, transcript projection, client-message correlation, extension questions and session-event translation to focused modules. A thread's runtime answers through `ThreadRuntimeBackend` (`src/main/runtime-types.ts`): twenty required members in Tau's own vocabulary plus capability groups, with `requireCapability` as the one place that refuses what a runtime cannot do. The Pi terminal Tau attaches to is one of those backends (`attached-thread-backend.ts`), its collaborators receive named ports (`host-ports.ts`), and thread lifecycle work is serialised by a reentrant `LifecycleQueue` (`lifecycle-queue.ts`). The renderer delegates layout to `Workbench` and keeps per-thread composer data in `ComposerScopeStore`.
- Tests keep this true: `src/shared/core-boundary.test.ts` fails on a feature name in those two files outside a listed debt and caps `pi-host.ts` at 3,000 lines and `App.tsx` at 1,800. `src/main/pi-host-safe-mode.test.ts` proves safe mode loads no host or Pi extension, and `src/renderer/extensions/kit-lifecycle.test.tsx` and `kits/kit-lifecycle.test.tsx` activate and remove every kit against the core slots.
- The renderer reaches the desktop host only through `HostClient` (see "Renderer host client" in [host-protocol.md](host-protocol.md)); `src/renderer/host-client-boundary.test.ts` fails on any renderer module outside `main.tsx` touching `window.tau`.
- An extension package is not core and is not trusted: it declares `permissions`, waits for the user's grant in `~/.tau/extension-grants.json` before either half starts, and reaches host services through the proxy in `guardedServices`. `src/main/extension-packages.test.ts` proves an unapproved package is never even imported, in the global folder as much as in a project's. [docs/EXTENSIONS.md](EXTENSIONS.md) is the guide for writing one.
- The renderer's own boundary is checked, not assumed: the window runs sandboxed with `webSecurity`, no webview tag and no permission of any kind (`src/main/index.ts`), and desktop bundles arrive over the `tau-ext` scheme instead of a blob URL, so the page's CSP is `script-src 'self' tau-ext:`. `src/main/extension-bundle-server.test.ts` fails if the scheme serves anything it was not given or if `blob:` returns to the CSP.
