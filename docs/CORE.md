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
- command palette and keybinding dispatch; the chords themselves are extension contributions — `kits/keybindings/` binds Tau's own, replaces them from `~/.pi/agent/keybindings.json` and adds one command per Pi extension shortcut
- extension lifecycle on both sides: desktop extensions in the renderer, host extensions in the host
- one versioned request/push protocol between client and host, with reconnect and replay; Electron IPC is one transport of it, and the one generic method host extensions use travels on it
- `sessions.start` on the host seam: an extension has core create a thread for a project, index it and deliver its first prompt, without ever taking the screen
- the login shell's environment for everything the host spawns, and `findCommand` on the seam for extensions that need a tool from the machine
- enough persisted state to restore the workbench

## Not in core

These exist today, some still inside core files. They are extension work, and Phase 1b in [PLAN.md](../PLAN.md) moves them.

| Feature | Owner today | Belongs to |
|---|---|---|
| Git status, staging, commit, push, worktrees, file tree, file reading, editors, branch labels and repository names in the thread index | Workspace Kit: `kits/workspace/`, a package Tau ships (ADR 0014). Host commands, its own Git cache and the project facts it supplies through `describeProjects` (ADR 0007); core lends the title-bar region, the composer footer, the transcript footer and the document source seam for the stage | Workspace Kit |
| Turn checkpoints and restore | Workspace Kit on both sides: capture, restore, recovery and ref upkeep in `kits/workspace/host-lifecycle.ts` through the seam's lifecycle hooks and turn observer; cards, status and the restore dialog in `kits/workspace/checkpoints.tsx`. The Git and lease engine it drives lives with it (`kits/workspace/workspace-git.ts`, `workspace-checkpoint-lease.ts`, `workspace-kit-checkpoints.ts`, the `turn-checkpoint-*` family), and `kits/workspace/pi.ts` is the half that captures a turn inside a Pi TUI Tau is only attached to. Core keeps only what an anchor needs: a pinned text-empty assistant entry stays in the transcript | Workspace Kit |
| Thread rail: the sidebar, its search, the settled shelf and the project switcher | Workspace Kit's `kits/workspace/navigation.tsx`, filled through `registerSidebar`. Core owns threads and draws a row with `ThreadRow` from the `tau` API; without the kit the window has no sidebar and still shows a composer and a transcript | Workspace Kit |
| Review mode, diff viewer, changed-files dock | Review Kit overlay over the store Workspace Kit publishes as `tau.workspace/store`; the Files and Changes panels and the dock are Workspace Kit's | Review Kit |
| Stage tabs, file viewer | tabs and placement stay core (the document area); loading, changed markers and editors come from the registered document source | core placement, Workspace Kit content |
| Thread title generation | Thread Title Generator: `kits/thread-titles/`, a package Tau ships (ADR 0014) | Thread Title Generator |
| Installing, updating and removing extension packages: `/install`, `/remove`, `/update` and the Settings → Packages page | Packages Kit: `kits/packages/`, a package Tau ships. The installer itself (npm, git, `packages.json`, signatures) stays core behind the `packages` permission; the kit owns the verbs, the wording and the page | Packages Kit |
| Signals: host events, live counts and the shell-run presentation | Signals: `kits/signals/`, a package Tau ships (ADR 0014); core lends the panel slot and the `useObservatory` hook it reads | Signals |
| Access gate (read-only, ask, full) | Access Kit: `kits/access/`, a package Tau ships (ADR 0014); the gate itself is the Pi extension in `kits/access/gate.ts` | Access Kit, on by default; approvals are Pi `ctx.ui.confirm` questions |
| Preview browser: the panel, the `WebContentsView` over it and the `preview_*` tools the agent drives it with | Preview Kit: `kits/preview/`, a package Tau ships (ADR 0014) — `host.ts` with `view.ts` and `page-script.ts`, `desktop.tsx` with `panel.tsx`, `store.ts` and `overlay-watch.ts`. Core lends the panel slot, one composer region, and `src/renderer/reserved-region.ts` — the rectangle a native view owns, which core's own floats keep clear of; the kit publishes it through `reserveRegion` on `tau` ([ADR 0012](adr/0012-preview-browser.md)) | Preview Kit |
| Service tier, questionnaire | Service Tier is `kits/service-tier/` and Questionnaires is `kits/questionnaire/`, packages Tau ships (ADR 0014); the questionnaire pages through its questions with its own prompt renderer over core's prompt frame | separate packages |
| Computer use: the desktop-automation tools and how a run of them reads in the transcript | Computer Use: `kits/computer-use/`, a package Tau ships (ADR 0014). The host loads the `@amaster.ai/pi-computer-use` npm package through `loadRuntimeExtension` — its driver binaries have to stay where npm put them — and the kit contributes it to every runtime unless the user configured the Pi package themselves | Computer Use |
| Spawning sub-agents | Agents Kit: `kits/agents/`, a package Tau ships (ADR 0014). Its host half contributes `tau_spawn_thread`, `tau_get_thread_status`, `tau_wait_for_thread` and `tau_list_threads` to every runtime; a sub-agent is an ordinary thread in the same project (ADR 0013). Its desktop half owns the Agents dock panel and publishes the lineage the navigator folds away and counts; the kit reads its running budget from the user's `~/.tau/agents.json` and keeps its own link index in `<userData>/kit-state/tau.agents/agents-links.json` (`services.stateDir`) so the rail hides agent threads from the first paint. Core keeps the record the index reads: `sessions.start({ parent })` writes the link entry and `src/main/session-lineage.ts` turns it into `UiSession.parentThreadId` | Agents Kit |
| What Pi extensions draw through `ctx.ui`: statuses, the working message and text widgets around the composer | Pi UI: `kits/pi-ui/`, a package Tau ships (ADR 0014); core lends the `presentUi` seam, the status line and the two composer regions | Pi UI |
| Claude Code backend | Claude Code: `kits/claude-code/`, a package Tau ships (ADR 0014), registering a runtime backend through `registerRuntimeBackend`; core knows only Pi (ADR 0005 amendment) | Claude Code kit, shipped by default |
| Project sources: folder browsing, native folder picker, Git clone | Workspace Kit host entry (`kits/workspace/host.ts`) and its two sources in `kits/workspace/navigation.tsx`; core keeps the sources modal as the placement for `registerProjectSource`, and `assertAllowedCloneSource` stays core's because the package installer clones too | Workspace Kit |
| Markdown export, clipboard, image preview | `src/main/index.ts`, `PiHost` | core (Pi has /export and /copy) |

**Runtime Controls is core, not a kit.** The Settings modal shell with its
Defaults, Keybindings and Inspector pages, and the contributions that reach
core's own actions — the command palette, `escape` to abort, `mod+n`,
`/reload`, `/tree`, `/fork`, `/clone`, "Set model…", "Set thinking level…" —
are the workbench itself. A window that cannot pick a model is not a usable
window, and safe mode has to be one. They live in `src/renderer/settings/`
(`runtimeControls`, activated through `registry.activateCore`, so it is on in
safe mode too and carries no switch) with the host entry that reads Pi's
`keybindings.json` and its extension shortcuts in
`src/main/keybindings-host-extension.ts`. They keep the id
`tau.runtime-settings`: it is the name Pi's keybindings arrive under.

The one thing safe mode loses with the kits is `/install` and the Packages
page — the package manager is a kit like any other now. Recovering from a
window that cannot install is still `npm run start` or an edit to
`~/.tau/packages.json`.

## The stylesheet

A kit that draws a surface of its own carries the rules for it: a `styles`
entry in its manifest, `kits/<name>/styles.css`, linked while the kit is active
and gone with it (see [EXTENSIONS.md](EXTENSIONS.md)). Seven kits have one —
Workspace, Agents, Preview, Signals, Packages, Questionnaires and Pi UI.

`src/renderer/styles.css` keeps the classes **core itself draws**, which is the
whole of the test: a rule stays if a core component renders the element, even
when only a kit ever mounts that component.

| Stayed in core | Why |
|---|---|
| The window and its slots: `.app-shell`, `.workbench-center`, `.instrument-dock`, `.panel-rail`, `.panel-stage`, `.panel-header`, `.panel-body`, `.dock-resizer`, `.stage*` | Core's layout and the frame a panel contribution is drawn into. Four kits fill it; none of them owns it. |
| The thread row: `.thread-row`, `.thread-main`, `.thread-title`, `.thread-branch`, `.thread-project-icon`, `.thread-activity`, `.activity-*`, `.thread-cost*`, `.thread-agent-count`, `.thread-settle`, `.provider-icon*` | `ThreadRow` is core's component, published on `tau` (ADR 0014): a thread is core's and its row is how core draws one. The rail around it is Workspace Kit's and moved. |
| The menu: `.menu`, `.menu-anchor`, `.menu-label`, `.menu-heading`, `.menu-scrim`, `.menu-hint`, `.chev` | `Menu` on `tau`; Workspace Kit, Access Kit and Service Tier all open core's menu. |
| Buttons and chips: `.chrome-button`, `.chrome-ghost`, `.icon-button`, `.text-button`, `.mini-button`, `.chip`, `.runtime-chip`, `.switch`, `.segmented`, `.primary`, `.danger`, `.accent` | The shared vocabulary of the workbench. Access Kit and Service Tier draw their composer chips entirely with it, so those two kits have no stylesheet at all. |
| The prompt frame: `.extension-prompt*`, `.extension-option*`, `.option-row` | `ExtensionPromptFrame` and `OptionRow` on `tau`. Only Questionnaires' own pager (`.extension-pager`) moved. |
| Review and diff: `.review-*`, `.diff-*`, `.changes-tree-*`, `.commit-proposal*`, `.source-*` | `ReviewMode`, `ChangesTree` and `DiffView` are core components published on `tau`; Review Kit mounts core's overlay rather than drawing one. Workspace Kit's own dock around them (`.changed-file*`, `.commit-box`) moved. |
| The Settings modal: `.settings-modal`, `.settings-nav`, `.settings-field`, `.settings-note`, `.settings-page`, `.install-extension`, `.extension-grant-box`, `.inspector-*`, `.keybinding-row` | Core keeps the modal and the three pages safe mode needs. Only `.packages-*` — the install form, its log and its actions — moved to Packages Kit. |
| The status line and the regions: `.status-line`, `.status-item`, `.status-side`, `.workbench-region`, `.region-*` | Placements core publishes. Only what Pi extensions draw inside them (`.pi-ui-*`) moved. |
| Transcript, composer, palette and modals: `.transcript*`, `.message*`, `.markdown`, `.hljs-*`, `.tool-*`, `.task-progress*`, `.composer-*`, `.command-palette`, `.model-picker`, `.approval`, `.toast`, `.reload-*`, `.project-picker`, `.project-modal`, `.thread-tree*` | Core's own surfaces, on the list above. |
| `:root` tokens, `.spinner` and the keyframes | The palette and the animations every kit's own rules refer to (`var(--ink-2)`, `blink`, `spin`). A kit stylesheet uses them and defines none. |

A handful of rules name classes nothing renders any more (`.tier-mark`,
`.title-generator-actions`, `.review-file-select`). They stayed where they were:
finding them was a by-product of the move, not its subject.

## How to check

- Settings → Packages lists the two sets apart: the kits Tau ships (`scope: "bundled"` from `inspectBundledKits`, granted by construction), headed by the distribution they came in (`@tau/kits` and its version, from `dist-kits/manifest.json`), above the packages a source installed. A rescan after an install never touches the first set — the activator only ever loads what it scanned from the package folders, and refuses a package claiming a kit's id.
- The kits Tau ships live under `kits/<name>/` with a `tau-extension.json` and load through the package loaders, from `dist-kits/` when the app was built and from the sources otherwise. There is no other door in either direction: a kit reaches core through `tau` (`src/renderer/extension-api.ts`), `tau/host-extension` (`src/main/host-extension-api.ts`) and `tau/host` (`src/main/host-extension-worker-protocol.ts`), plus the two test harnesses its own tests may use; core reaches a kit through the contributions the kit registers, never by path. `src/shared/kits-boundary.test.ts` fails on any other reach, and `src/shared/core-boundary.test.ts` fails if an `extensions/` directory reappears under `src/`. A kit that also runs inside a Pi runtime Tau does not own ships a `pi` entry, prebuilt to `dist-kits/<id>/pi.cjs`, which `.pi/extensions/tau-session-bridge.ts` loads through `PiKitBridge` — the bridge itself names no kit.
- `start:safe` shows the core list and nothing more. That includes no access gate: safe mode runs tools the way Pi does.
- Removing a bundled kit removes its behavior on both sides without editing core.
- `src/shared/contracts.ts` and `src/main/index.ts` name no feature. Feature commands travel through `invokeHostExtension`. Core operations are the method table in `src/main/host-methods.ts`; `src/main/ipc-contract.test.ts` fails when the client and the table stop naming the same methods.
- Thread lineage is an extension's claim, not a core field: a desktop extension publishes `setThreadLineage`, and the navigator hides spawned threads and counts a parent's working children from it. `UiSession` has no parent.
- `PiHost` delegates attached-Pi ownership, transcript projection, client-message correlation, extension questions and session-event translation to focused modules. A thread's runtime answers through `ThreadRuntimeBackend` (`src/main/runtime-types.ts`): twenty required members in Tau's own vocabulary plus capability groups, with `requireCapability` as the one place that refuses what a runtime cannot do. The Pi terminal Tau attaches to is one of those backends (`attached-thread-backend.ts`), its collaborators receive named ports (`host-ports.ts`), and thread lifecycle work is serialised by a reentrant `LifecycleQueue` (`lifecycle-queue.ts`). The renderer delegates layout to `Workbench` and keeps per-thread composer data in `ComposerScopeStore`.
- Tests keep this true: `src/shared/core-boundary.test.ts` fails on a feature name in those two files outside a listed debt and caps `pi-host.ts` at 3,000 lines and `App.tsx` at 1,800. `src/main/pi-host-safe-mode.test.ts` proves safe mode loads no host or Pi extension, and `kits/kit-lifecycle.test.tsx` activates and removes every kit against the core slots.
- The renderer reaches the desktop host only through `HostClient` (see "Renderer host client" in [host-protocol.md](host-protocol.md)); `src/renderer/host-client-boundary.test.ts` fails on any renderer module outside `main.tsx` touching `window.tau`.
- An extension package is not core and is not trusted: it declares `permissions`, waits for the user's grant in `~/.tau/extension-grants.json` before either half starts, and reaches host services through the proxy in `guardedServices`. `src/main/extension-packages.test.ts` proves an unapproved package is never even imported, in the global folder as much as in a project's. [docs/EXTENSIONS.md](EXTENSIONS.md) is the guide for writing one.
- The renderer's own boundary is checked, not assumed: the window runs sandboxed with `webSecurity`, no webview tag and no permission of any kind (`src/main/index.ts`), and desktop bundles arrive over the `tau-ext` scheme instead of a blob URL, so the page's CSP is `script-src 'self' tau-ext:`. `src/main/extension-bundle-server.test.ts` fails if the scheme serves anything it was not given or if `blob:` returns to the CSP.
