# What Tau core is

Tau core is Pi in a window, plus threads. This document is the list. Anything not on it is an extension, and safe mode (`npm run start:safe`) must show exactly this list and nothing more.

## In core

Transcript

- user, assistant and notice messages, streamed
- **how much of a turn's work is shown**: `transcriptDetail`, one of `focused`, `detailed` and `everything`. `focused` reads a settled turn as prose — one "Worked for 2m 14s" row that opens in place, one self-replacing line while it runs, and a sentence per run of tools ("Read 3 files and ran 2 commands"); `detailed` stops folding, opens every group and shows thinking; `everything` adds full tool output, arguments and timestamps. The default is a preference (Settings → Defaults); the palette sets it, ⇧⌘T cycles it, and a level set from the palette belongs to the thread on screen until another thread takes the override. `showThinking` migrated to `detailed`
- thinking, rendered and collapsible, the way Ctrl+T works in the terminal, from `detailed` upwards
- tool calls with live output, elapsed time and stop; presentation of a tool is an extension concern, its existence is not, and so is which rows fold: a failure never folds, and a batch a tool card claims (`registerToolCard`) is never folded, grouped or hidden
- Pi extension dialogs: select, confirm, input, editor; notifications
- bounded history paging
- **a thread whose runtime does not start still opens**: when a backend's `open` fails (its CLI is missing, say), the thread opens read-only from what its provider keeps (`src/main/unavailable-thread-backend.ts`), its index entry carries `runtimeError`, and a banner above the transcript says why, with Try again (the next switch tries the runtime again) and Providers
- **a failed turn says so where it happened**: the host keeps why a thread's last turn failed (`turnError` on its index entry, from Pi's error stop or a backend's `turn-settled` error) until the next prompt; the transcript ends with that error line and the rail row reads "Failed", beside the toast

What a turn's rows are is derived, not decided in a component:
`src/workbench/transcript-folding.ts` turns one turn's tool records into fold,
live, group and card rows and holds every rule about them — the fold's label
and duration, the trailing-tool exemption, the action classes a summary counts,
the tense the live line speaks in. `WorkRows.tsx` draws those rows and owns
only what a reader toggled.

Composer

- text, images, queued steering and follow-up messages, abort. A message sent during a run waits at the end of the transcript as a dashed bubble (`QueuedMessages.tsx`): the arrow sends it now, the X returns it to the composer, Stop returns the whole queue, `thread.steerQueuedMessage` sends the oldest
- **the interaction mode a thread's turns run in**: `default` or one its runtime offers (`plan`), a capability of the backend (`mode`) like the thinking level; the catalog carries `mode` and `modes`, `set-mode` changes it, a draft keeps the one its thread starts in. What a mode means and how it is shown are kits' (Plan Kit)
- Edit from here under a prompt of the user's, where the runtime keeps a tree: the conversation goes back to before it and the prompt returns to the composer
- **which chord sends**: `sendShortcut`, one of ↵, ⌘↵ once the draft has several lines, and ⌘↵, a preference of this client (Settings → Defaults → Send with). It is core because safe mode has to be able to send; what the send chord does while a turn runs (queue or steer) is a prompt hook's answer (`streamingDelivery`), queueing when nobody answers
- the slot inside the input frame that extensions fill with typed context (`registerComposerInline`), and file attachments beside images for a runtime whose adapter declares them
- Pi commands: extension commands, `/skill:` and prompt templates, as Pi reports them
- model, thinking level, context usage and compaction; what the thread has spent so far

Threads

- the thread index across projects, and one live runtime per open thread
- new, resume, fork, duplicate, rename, tree navigation, recovery of a broken thread
- **deleting a thread is reversible for a while**: `sessions.remove` moves it
  into the host's trash (`src/main/thread-trash.ts`, `<userData>/thread-trash/`)
  — a Pi session file moves there, a thread of another backend leaves the
  shell record its provider hands over (`removeThread`), never the CLI's own
  history — and the index drops it. `sessions.restore` puts it back; the host
  purges an entry after 30 days (`TAU_THREAD_TRASH_RETENTION_MS` for a test
  instance) or on `sessions.purge`, touches nothing outside the trash, and runs
  `threadDeleted` only then. What a thread is called, where it sits in the rail
  and whether it is archived are a kit's (Thread Rail)
- the current project (working directory) as Pi sees it
- **which threads were mid-turn when the host stopped**: the host writes one
  marker per thread to `<userData>/turns-in-flight.json` when it accepts a
  prompt (`{ sessionId, cwd, turnId, backend, startedAt, prompt }`, atomically,
  never into the session file, which is the runtime's) and drops it when the
  turn ends or is cancelled. At the next start each marker is dropped before
  its thread is touched, so nothing is ever continued twice, and then: with
  **Continue threads after restarts** on (Settings → Defaults,
  `threads.continueAfterRestart`, **off** by default) the thread is reopened
  off screen, its dangling tool calls are closed and it is sent "Continue the
  interrupted work…"; with the setting off it is repaired, told so in its own
  transcript, and marked `interrupted` in the index until its next prompt. What
  "continue" means is the runtime's answer: the `resume` capability says
  whether the continuation can be delivered without reading as the user's own
  message, and a runtime without that capability is only marked. An external
  shell a kit owns is always interrupted; the kit says so through its own
  `closed` hook

Workbench

- the window, its one 52 px top bar (traffic lights, project / thread breadcrumb, kit actions, panel toggles) and the layout slots: the left sidebar (256 px, dragged or keyed between 208 px and the window less 640 px, kept per client), the right dock, a drawer below the conversation (280 px, kept per client), and shared modals. A panel moves between its dock or drawer and a stage tab without remounting (`src/renderer/use-panel-layout.ts`, `components/PanelHosts.tsx`)
- **the order of runtimes**: Pi, then backends by the provider's `order`; the host's `runtimeBackends` list is the one every picker, Providers and onboarding follow
- **which token set the window paints with**: `system`, `dark` or `light`, applied as `data-theme` on `<html>`; a theme package may replace the values, never the mechanism
- the **client profile** the window draws for (`desktop`, `web`, `compact`): a contribution declares which clients render it, and the workbench leaves out what this one cannot draw ([ADR 0016](adr/0016-client-profiles.md))
- the stage: the document area beside the conversation, whose tabs hold files, threads, maximized panels and the surfaces kits register kinds for
- **the UI primitives everything else draws with** (`src/renderer/components/ui/`, on `tau` since API 1.11.0): `Menu` with arrows, Home/End, typeahead, submenus and focus back to its trigger; one `TooltipLayer` for every `data-tooltip` element (600 ms rest, instant within a 400 ms group, keyboard focus); the toast stack (`ToastStore` in `src/workbench/toast-store.ts`: top right, three visible, five seconds of being seen, held while the pointer or focus is on it or the window is hidden, type icons, actions, copy; F6 moves focus into it), which every notice and the update restart use; `Dialog` and `Popover` with focus trap and return; `Skeleton`, `Empty` and `Spinner` sizes; and `useContextMenu`, the OS's menu where the platform has one. They are Tau's own code rather than `@base-ui/react` for size ([PERFORMANCE.md](PERFORMANCE.md#ui-primitives-in-core)); the palette, the model picker and the project picker give focus back when they close, the palette to the composer when nothing had it
- command palette and keybinding dispatch, with `when` clauses read from focus contexts the page marks (`src/renderer/keybinding-when.ts`, `keybinding-context.ts`) and `editableFocus`, which holds while any text field has the keyboard; the chords themselves are contributions — Runtime Controls binds core's own, each kit its own, `kits/keybindings/` replaces them from `~/.pi/agent/keybindings.json` and adds one command per Pi extension shortcut. The defaults are in `docs/keybindings.md`
- **what the palette finds besides commands**: sources extensions register (`registerPaletteSource`), asked per keystroke with the thread index and a signal that aborts when the query moves on, and core's own Settings rows. The merge is `src/renderer/palette-results.ts`: label matches among the commands, then the sources in order, then the Settings rows, then commands that matched only by their group
- **Settings as a page of its own** (`src/renderer/settings/SettingsScreen.tsx`): it covers the whole window the way T3 Code's settings route does — the section column with the search and Back on the left, a bar with `Settings / <page> / <scope>`, the page at a readable width built from sections of rows (`settings-layout.tsx`: `SettingsSection`, `SettingRow`, `useSetting`, on `tau`). Escape, Back and `mod+,` return; the workbench stays mounted underneath, `inert`. `openSettings(page)` opens a page by id
- **Settings search**: a field at the top of the Settings column over core's rows (a row it finds is scrolled to and marked), the pages extensions added (by label and `keywords`), each extension's page and every live keybinding; arrows walk the results, `/` focuses it. The index and its ranking are `src/renderer/settings/settings-search.ts`, and the palette reads the same one
- **the levels a setting is read from**: the built-in default, the host (`~/.tau/config.json`) and the project (`<project>/.tau/config.json`), first set wins from the project down. `HostConfigManager.readLayers` and `clear` (host methods `get-config-layers`, `clear-config`) keep the two files apart, `src/shared/config-layers.ts` resolves a key's value and origin, and `src/workbench/config-layers-store.ts` is the client's copy that writes to the level being edited. A row shows where its value comes from and resets or overrides it; a page with `scope` "project" or "both" offers the project in its breadcrumb. Pi's own keys stay Pi's: they have Pi's global and project files
- extension lifecycle on both sides: desktop extensions in the renderer, host extensions in the host
- one versioned request/push protocol between client and host, with reconnect and replay; Electron IPC is one transport of it, and the one generic method host extensions use travels on it
- **which clients are attached**: every transport reports its clients to one registry, so the host knows how many there are and what each claims to be; the count is published, and `services.clients` on the host seam is where a kit reads it
- `sessions.start` on the host seam: an extension has core create a thread for a project, index it and deliver its first prompt, without ever taking the screen
- **Tau's tools for every runtime** ([ADR 0022](adr/0022-tau-tools-over-mcp.md)): a local MCP endpoint in the host process (`src/main/mcp-endpoint.ts`, Streamable HTTP on `127.0.0.1`, stateless) where kits offer the same Pi tool definitions they give Pi (`services.mcp.registerTools`) and gate every call (`services.mcp.gate`). A runtime backend asks `services.mcp.connect` for a thread's server entry — one bearer credential per thread, revoked when that thread's runtime closes — and puts it into its own MCP configuration; the credential decides which thread a call belongs to, so no tool reaches across threads
- the login shell's environment for everything the host spawns (on Windows the registry's PATH instead, [docs/windows.md](windows.md)), and `findCommand` on the seam for extensions that need a tool from the machine
- **watching the files the host itself reads** — the package folders, the theme folders, `keybindings.json`, `config.json` — and reloading only what changed: the one package that was edited, the themes, the config. Core re-reads nothing on anyone else's behalf: `observeConfigChanges` on the seam and a `config-changed` push say what moved, and whoever owns those files decides. Off under `extensions.watch: false`, `TAU_NO_WATCH=1` and safe mode (`src/main/config-watcher.ts`, `src/main/workspace-watch.ts`)
- enough persisted state to restore the workbench: the window puts the stage
  and the dock back the way the workspace was left (`tau.stage.v1:<workspace>`
  and `tau.dock.v1:<workspace>` in `src/workbench/storage-keys.ts`, written
  through `src/workbench/workbench-layout-state.ts`). Tabs are stored as they
  are held, so a tab kind a kit adds round-trips and one that cannot be read
  is dropped; a file of another project and a thread the index has forgotten
  are dropped silently
- **applying a rebuild**: `reloadExtensions()` loads kits and packages again
  and the client reloads its page, without touching a single runtime and
  without waiting for anything, while `reloadRuntime()` is the heavier path
  that rediscovers Pi's resources and is the only one that asks about running
  threads. The build result chooses: a kit's runtime half (`pi.cjs`) takes the
  runtime path, the main process or preload takes a restart, everything else
  takes the light one. A package refresh never replaces the runtime extensions
  of a runtime that is already built — `registerRuntimeExtension` applies to
  every runtime from then on — so a turn in flight keeps the code it started
  with while host commands and panels change at once

### The workbench and its client

The workbench is always a client of a host in another process. The window
starts that host, watches it and connects the renderer to its socket; the
threads belong to the host, so the window may close, crash or reload without
stopping one ([ADR 0021](adr/0021-host-runs-in-its-own-process.md)). Twelve
methods stay on this side — clipboard, image preview, a workspace file shared
with the page by URL (`tau-ext://files/…`, `src/main/shared-files.ts`: PDFs,
images, audio and video inside the open workspace, with byte ranges), the kit
bundles the renderer imports, the workbench rebuild, relaunch and update, a system
notification, the app icon's badge and a right-click menu the OS draws — and a kit that
needs the window's process for a native view ships a `window` half the host
calls with `callClient`.

`src/workbench/` is Tau's client without a window: the thread index, the thread
on screen, transcript pages, composer scopes and drafts, notices and the host
connection, plus `WorkbenchStore` — the one place a host update becomes client
state — and `ThreadCommands`, everything the workbench does to a thread that is
one host call and a notice. It imports no React, no Electron and no browser
global, and `src/workbench/workbench-boundary.test.ts` fails on any of them.
Where it needs the view side it names a port, never a class.

`src/renderer/` is the React binding of that client, and `Platform`
(`src/workbench/platform.ts`) is what the client needs of the machine it runs
on: clipboard, `openExternal`, `files` (only where the host's paths are this
machine's), storage, `importModule`, `attention` — a notification the OS
draws and a count on the app's icon, absent where the client has neither —
and `contextMenu`, a right-click menu the OS draws at a point of the page
(`src/main/window-context-menu.ts`: `Menu.popup` in the window's process);
without it, or when it refuses, the page draws its own.
Electron answers it in
`src/renderer/platform-electron.ts` and a browser tab in
`src/web/platform-web.ts`. The sandboxed Electron renderer holds no permission
to notify, so its `attention` asks the window's own process
(`src/main/window-attention.ts`: `Notification`, `app.setBadgeCount`); a tab
uses the page's Notification API and draws the count into its icon. `App.tsx` is bootstrap, store wiring and layout; the
three facts it cannot work out for itself — which client this is, whether kits
were left out, and how to build the platform — arrive as a `ClientEnvironment`
from the entry point.

There are two such entry points. `src/renderer/main.tsx` is the Electron window;
`src/web/` is the browser client a listening host serves, which reuses every
component and adds only its entry, its platform and the token handling. Below
720 px either of them lays itself out compactly — the thread list as a sheet,
the composer at the bottom edge, agent supervision as the start screen — through
`body[data-profile]` and `src/renderer/profile-compact.css`, not a second
component tree.

The model picker (`src/renderer/components/ModelPicker.tsx`) keys everything on
what the catalog says: a rail with Pi's catalog split by model provider and
every other runtime the host offers — each instance of one included — as one
tab of its own (`model-picker-rail.ts`), a search across the catalog on hand, favourites
reachable with ⌘1–9, and per tab one fold for legacy generations. Another
runtime's tab says what choosing it means: a new thread's draft switches to
it, and a thread that exists offers a new thread on it, because a thread keeps
its runtime. A draft bound for a runtime other than the thread on screen
chooses from that runtime's own catalog (`runtime-catalog`, which a backend
answers through `newThreadCatalog` without opening a thread): the composer's
model and thinking pickers work as they do for Pi, the draft keeps the choice
with the runtime it was made for (`src/workbench/runtime-catalog-store.ts`),
and `newSession` hands model and level to the new thread through
`catalogWrite` before its first prompt. A runtime that can only name its
models inside a session (Antigravity before its first one) says so, and the
thread starts on its default. Pi
is the default and wears no mark: the rail, the rows, the composer chip and the
thread rows draw a runtime's logo beside the model provider's only when the
runtime is not Pi (`providerMarks` in `src/renderer/runtime-marks.ts`). What the
catalog does not say — which generations are legacy, which model wears a "new"
badge for a while — lives in `src/renderer/model-manifest.ts`, hand maintained
and dated; an unmatched model is current. A model behind a subscription login
the runtime performs (`UiModel.login`) is tagged "subscription login"; whether
that is worth a warning is a policy, and policies reach the picker and the
composer through `registerModelBadge` and `registerComposerGate`. In a new
thread's picker, Shift-click hands the model to the set an extension keeps
(`registerModelSelection`) instead of choosing it; without one it chooses.

### The stage

The stage is the column beside the conversation. Core owns the tab strip, the
placement, the preview and pin rules and the strip's own gestures — double-click
pins a preview, the middle button and Escape close, `mod+w` closes the active
tab, `ctrl+tab` and `ctrl+shift+tab` move through them, and the right-click menu
offers close, close others, close to the right and pin/unpin. Two kinds of tab
are core's own, and a third belongs to whoever registered it.

A **file** tab shows source or the working-tree diff; core owns the tab strip
and the placement, and whoever registered the document source loads the
content. `openFile(path, { line })` opens the source scrolled to a line and
marks it; the tab keeps the line with a request count, so asking for it again
scrolls there again. The header draws the commands extensions offer on the
`file-tab` surface (Files Kit's "Edit file"); they read the tab from
`actions.activeStageTab()`. A **thread** tab shows another thread's transcript, read-only, drawn
with the same `VirtualTranscript` the conversation uses and headed by the title,
status and cost the thread index carries. It exists so a sub-agent's chat can be
read without becoming the thread the composer talks to; "Take over" is the one
button that does switch — and even then the child stays out of the rail, which
never lists a thread with a parent. It reloads when the index republishes that thread's
entry — which is what the host does when a background turn settles — and polls
every two seconds only while the index says the thread is streaming. A tab whose
session the index no longer knows shows an empty state rather than an error.
`WorkbenchActions.openThread(sessionId)` is how an extension opens one; the
Agents Kit panel is the caller that motivated it. It reads whether or not a
runtime holds the thread: a released Pi thread is projected from its session
file, a thread of another backend from the shell that backend keeps for the
index, and neither opens a runtime.

An **extension** tab is a kind a desktop extension registered with
`registerStageTab`: the kind supplies the title, the glyph and the content,
core everything else. The tab is `{ id, kind: "extension", tabKind, params,
title }` with `params` plain JSON, so it is the same tab whatever draws it and
it survives being written to storage; the content talks back through a handle
(`setTitle`, `setDirty`, `onClose`), and `StageTabController`
(`src/renderer/stage-tab-controller.ts`) is the one door that closes a tab of
any kind — it asks about unsaved work, runs that tab's listeners and forgets
its handle. A kit that goes away takes its tabs with it. Terminal Kit's "open
as tab" is the shipped caller; `docs/EXTENSIONS.md` is the guide.

## Not in core

These were extension work still inside core files when Phase 1b in [PLAN.md](../PLAN.md) started the move; Phase 6 finished it, and each row below names the kit under `kits/` that owns it now.

| Feature | Owner today | Belongs to |
|---|---|---|
| Git status, staging, commit, push, worktrees, file tree, file reading, editors, branch labels and repository names in the thread index | Workspace Kit: `kits/workspace/`, a package Tau ships (ADR 0014). Host commands, its own Git cache and the project facts it supplies through `describeProjects` (ADR 0007); core lends the title-bar region, the composer footer, the transcript footer and the document source seam for the stage. A thread's own worktree is the kit's too: the picker chooses the mode before the first turn and the kit creates it through core's `beforeNewThread` gate, which knows nothing of Git ([ADR 0017](adr/0017-worktrees-for-threads-and-agents.md)) | Workspace Kit |
| Turn checkpoints and restore | Workspace Kit on both sides: capture, restore, recovery and ref upkeep in `kits/workspace/host-lifecycle.ts` through the seam's lifecycle hooks and turn observer; cards, status and the restore dialog in `kits/workspace/checkpoints.tsx`. The Git and lease engine it drives lives with it (`kits/workspace/workspace-git.ts`, `workspace-checkpoint-lease.ts`, `workspace-kit-checkpoints.ts`, the `turn-checkpoint-*` family), and `kits/workspace/pi.ts` is the half that captures a turn inside a Pi TUI Tau is only attached to. Core keeps only what an anchor needs: a pinned text-empty assistant entry stays in the transcript | Workspace Kit |
| Thread rail: the sidebar, its search, the settled shelf and the project switcher | Workspace Kit's `kits/workspace/navigation.tsx`, filled through `registerSidebar`. Core owns threads and draws a row with `ThreadRow` from the `tau` API; a thread nobody has written to is a draft and gets no row until it runs; without the kit the window has no sidebar and still shows a composer and a transcript. The store's `registerThreadRailOrganizer` lets another kit decide the sections, the row menu and what a drag does (Thread Rail, below) | Workspace Kit |
| Review mode, diff viewer, changed-files dock | Review Kit overlay over the store Workspace Kit publishes as `tau.workspace/store`; the Files and Changes panels and the dock are Workspace Kit's | Review Kit |
| Stage tabs, file viewer | tabs and placement stay core (the document area); loading, changed markers and editors come from the registered document source. A thread tab is core's own content: it reads the transcript through `transcript-page` and draws it with core's `VirtualTranscript`. Any other content is a kit's: `registerStageTab` is the seam, and core never learns what a kind draws | core placement, Workspace Kit file content, kits for their own kinds |
| Thread title generation | Thread Title Generator: `kits/thread-titles/`, a package Tau ships (ADR 0014) | Thread Title Generator |
| Installing, updating and removing extension packages: `/install`, `/remove`, `/update` and the Settings → Packages page | Packages Kit: `kits/packages/`, a package Tau ships. The installer itself (npm, git, `packages.json`, signatures) stays core behind the `packages` permission; the kit owns the verbs, the wording and the page | Packages Kit |
| Signals: host events, live counts and the shell-run presentation | Signals: `kits/signals/`, a package Tau ships (ADR 0014); core lends the panel slot and the `useObservatory` hook it reads | Signals |
| Access gate (read-only, ask, full) | Access Kit: `kits/access/`, a package Tau ships (ADR 0014); the gate itself is the Pi extension in `kits/access/gate.ts`, and its `thread-level` command, which only Agents Kit may call, narrows one thread below the workbench's level. The same decision (`gateToolCall`) gates Tau's tools over MCP (`services.mcp.gate`), so a tool asks alike whichever runtime calls it; `tau_apply_thread_changes` asks like an edit | Access Kit, on by default; approvals are Pi `ctx.ui.confirm` questions, over MCP the same confirm in the thread |
| Preview browser: the panel, the `WebContentsView` over it and the `preview_*` tools the agent drives it with | Preview Kit: `kits/preview/`, a package Tau ships (ADR 0014) — `host.ts` with `view.ts` and `page-script.ts`, `desktop.tsx` with `panel.tsx`, `store.ts` and `overlay-watch.ts`. Core lends the panel slot, one composer region, and `src/renderer/reserved-region.ts` — the rectangle a native view owns, which core's own floats keep clear of; the kit publishes it through `reserveRegion` on `tau` ([ADR 0012](adr/0012-preview-browser.md)). The panel's tool row picks an element (`page-overlay.ts`, run in an isolated world: selector, tag, text, box, trimmed markup and a cut-out image) or annotates the page (numbered rectangles, arrows and notes, sent as the page with them drawn and a numbered list); both land in the composer as a `text-excerpt` chip through Composer Context's chip service with the image beside the draft's images. It records the view to webm under the kit's `stateDir` (`recorder.ts`: a hidden page asks for display media and the session hands it the preview's frame; one-second chunks, 10 minutes or 500 MB at most) and attaches the file as a chip. Named profiles each get their own partition (`persist:tau-preview-<name>`; the default keeps `persist:tau-preview`), and the host suggests local dev servers under the address bar (`ports.ts`: `lsof`, else `netstat`, through `findCommand`; listeners under the workspace, on dev ports or run by dev programs, probed over HTTP). `mod+shift+j` toggles the panel, as in T3 Code. The `preview_*` tools reach Codex, Agent SDK and Antigravity threads over the host's MCP endpoint too (ADR 0022) | Preview Kit |
| Service tier, questionnaire | Service Tier is `kits/service-tier/` and Questionnaires is `kits/questionnaire/`, packages Tau ships (ADR 0014); the questionnaire pages through its questions with its own prompt renderer over core's prompt frame | separate packages |
| Computer use: the desktop-automation tools and how a run of them reads in the transcript | Computer Use: `kits/computer-use/`, a package Tau ships (ADR 0014). The host loads the `@amaster.ai/pi-computer-use` npm package through `loadRuntimeExtension` — its driver binaries have to stay where npm put them — and the kit contributes it to every runtime unless the user configured the Pi package themselves | Computer Use |
| Spawning sub-agents | Agents Kit: `kits/agents/`, a package Tau ships (ADR 0014). Its host half contributes `tau_spawn_thread`, `tau_get_thread_status`, `tau_wait_for_thread`, `tau_apply_thread_changes` and `tau_list_threads` to every runtime — to Pi as a runtime extension, to the others over the host's MCP endpoint (ADR 0022); a spawned thread works in a worktree of its own, branched from the parent's state, and the parent takes that work back with one apply (ADR 0017), through the one Workspace Kit module the kit imports; a sub-agent is an ordinary thread in the same project (ADR 0013). Its desktop half owns the Agents dock panel, the spawn card the transcript shows for a `tau_spawn_thread` batch (through `registerToolCard`), and publishes the lineage the navigator folds away and counts; the kit reads its running budget from the user's `~/.tau/agents.json` and keeps its own link index in `<userData>/kit-state/tau.agents/agents-links.json` (`services.stateDir`) so the rail hides agent threads from the first paint. Core keeps the record the index reads: `sessions.start({ parent })` writes the link entry and `src/main/session-lineage.ts` turns it into `UiSession.parentThreadId`. A project's agent definitions (`.tau/agents/*.md`, [agent-definitions.md](agent-definitions.md)) are the kit's too: it reads them, lists them in the panel and in the Inspector, and starts a thread from one with its system prompt, model, tools, access and workspace — on another runtime through `sessions.start({ backend })` | Agents Kit |
| What Pi extensions draw through `ctx.ui`: statuses, the working message and text widgets around the composer | Pi UI: `kits/pi-ui/`, a package Tau ships (ADR 0014); core lends the `presentUi` seam, the status line and the two composer regions | Pi UI |
| Claude Code backend | Claude Code: `kits/claude-code/`, a package Tau ships (ADR 0014), registering a runtime backend through `registerRuntimeBackend` and driving the installed `claude` through the Agent SDK; core knows only Pi and offers the backend-neutral routes `onEvent` and `ask` (ADR 0005 amendments) | Claude Code kit, shipped by default |
| Model for a kit's small job | `HostExtensionServices.complete` (`src/main/host-completion.ts`): one short answer on the user's own `~/.pi/agent` model configuration, for a title, a branch name or a commit message. Core neither writes those prompts nor picks the model; the kit names one (`smallCompletionModel` picks a small one) or takes the user's default | Title generator, Worktree Names, Review Kit |
| Antigravity backend | Gemini through Google's own agent: `kits/antigravity/` registers a runtime backend that downloads Google's Antigravity ACP server from the official registry URL (or takes `TAU_ANTIGRAVITY_ACP_COMMAND`), speaks the Agent Client Protocol to it over stdio, lets the user sign in with Google inside that server, forwards the user's own MCP servers and skills, and fills its card on Settings → Providers; the same `onEvent` and `ask` routes | Antigravity kit, shipped by default |
| Project sources: folder browsing, native folder picker, Git clone | Workspace Kit host entry (`kits/workspace/host.ts`) and its two sources in `kits/workspace/navigation.tsx`; core keeps the sources modal as the placement for `registerProjectSource`, and `assertAllowedCloneSource` stays core's because the package installer clones too | Workspace Kit |
| Terminals: a shell per workspace or thread, in the dock, on desktop and web | Terminal Kit: `kits/terminal/`, a package Tau ships (ADR 0014). Its host half holds one `node-pty` session per terminal (`kits/terminal/host.ts`), loaded through `loadDependency` so the native addon stays where npm put it, filed under the workspace the host has open and, when a thread asked, started in that thread's worktree; input and resize are commands, output and exit are pushes with byte offsets, so a reloaded client replays without drawing twice. Each shell keeps its last 5,000 lines for a client that reattaches, and the host names a program running in its foreground so closing can ask first. Terminals die with the workspace (`afterWorkspaceClose`) or the kit, never with the window. Its desktop half is the Terminal dock panel over xterm.js: tabs of split panes (`kits/terminal/layout.ts`, kept in client storage and reconciled with the host's shells), grouped by the thread on screen; a shell that belongs to another thread is marked, not killed. "Open as tab" moves a shell to the stage through `registerStageTab` and closing the tab gives it back, never ending it. T3 Code's terminal chords (`mod+d`, `mod+shift+d`, `mod+n`, `mod+w`, `mod+]`, `mod+[`) are keybindings under `terminalFocus`, so they reach the command before the shell and can be rebound; `mod+j` toggles the panel. A selection goes to the composer as an excerpt through Composer Context's chip service, a `localhost` URL opens in the Preview through Preview Kit's service, and the font follows the kit's settings, else the user's Ghostty config (read only), else the platform's monospace faces | Terminal Kit |
| Markdown export, clipboard, image preview | `src/main/index.ts`, `PiHost` | core (Pi has /export and /copy) |
| Project scripts: quick actions a repository checks in, the worktree setup, a script's preview | Project Scripts: `kits/project-scripts/`, a package Tau ships (ADR 0014). Its host half reads `.tau/project.json` per checkout ([project-file.md](project-file.md), schema in `docs/schemas/`), runs a script with `/bin/sh -c` as a job whose output and exit code are pushes, runs the `runOnWorktreeCreate` scripts Workspace Kit asks for (`worktree-created`, callers `tau.workspace`) and watches the file itself, because core watches only what the host reads. Its desktop half is the bar above the composer with run cards, one `script.<id>.run` command and chord per script, problems through `setProblems`, the preview through Preview Kit's `tau.preview/browser` service and "run in a terminal" through Terminal Kit's host commands | Project Scripts |
| Pull and merge requests: create (generated title and body, draft, template), edit, merge, status and checks on the rail row | Review Kit: `kits/review/requests-host.ts` drives `gh` or `glab`, found with `findCommand`; the Git it needs (push with upstream, branch context, template from the base tree, the request detector) is Workspace Kit's, reached through commands that name `tau.review` as caller (ADR 0020). The desktop half fills the Changes section and the rail-row mark Workspace Kit's store lends; core lends only `ThreadRow`'s `accessory` | Review Kit |
| Chips in the composer — files by `@`, pull requests by `#`, excerpts other kits hand over — file attachments of any type, and large pastes folded into a text file | Composer Context: `kits/composer-context/`, a package Tau ships (ADR 0014). Its desktop half fills core's inline slot (`registerComposerInline`) and publishes the chip service `tau.composer-context/chips` for the kits that have context to give; its host half stores attachments in `<userData>/kit-state/tau.composer-context/attachments/<thread>/` and drops a thread's folder when the host purges the thread (`threadDeleted`), reads what a file chip points at and lists files and pull requests (`gh`, `glab` through `findCommand`). A chip becomes text before the prompt when it is sent; an attachment goes as a file to a runtime that opens files and as text or a path to one that does not | Composer Context |
| Usage overview: what the threads Tau ran have used, by period, project, runtime and model | Usage: `kits/usage/`, a package Tau ships (ADR 0014). Its host half runs in a worker and reads only what runtimes wrote down: every response in Pi's session files under `services.sessionsDir` (a response a fork copied counts once), cached per file by size and mtime in `services.stateDir`, and the running total per thread that Claude Code and Antigravity keep, through a `usage` command each of them grants to `tau.usage` (ADR 0020). A backend that does not answer is shown as not available. No provider is asked. Its desktop half is the Settings → Usage page and the "Show usage" command. Core lends nothing new | Usage |
| Organising the rail: pinned, active, snoozed and settled threads, dragging them between sections and within one, snooze until a time, auto-settle rules (quiet for N days, request merged or closed), archiving and deleting threads with an undo notice, the thread commands and chords, starting a new thread in the background (⌘↵) and one prompt to several models | Thread Rail: `kits/thread-rail/`, a package Tau ships (ADR 0014). Its host half keeps the meta per thread in `<userData>/kit-state/tau.thread-rail/thread-meta.json`, pushes each change and sweeps every five minutes, while no window is open too: a snooze that ran out wakes, and an idle thread settles by the rules in its Settings page, the request state asked of Review Kit's `pr-status` (callers `tau.thread-rail`) for a thread that has its worktree to itself. Its desktop half is the organizer Workspace Kit's rail lends (`registerThreadRailOrganizer`), claims a new thread's prompt through `claimNewThread` for ⌘↵ and for a model set built with `registerModelSelection`, starts those threads with `services.sessions.start` in worktrees `prepareThreadWorktree` makes, and publishes the sibling groups as `tau.thread-rail/siblings` for the Agents panel. Core's old pin and settle lists in the preferences are handed over once and then mirrored, so the title menu's Pin and Settle keep working. Archive and Delete, after T3 Code's, sit in the row menu and the title menu (the row menu is the OS's own where the client has one, `useContextMenu`, with the snooze presets in a submenu): an archived thread (`archivedAt` in the meta; a running one is refused, new work brings it back) leaves the rail and is listed under Settings → Archived by project, and Delete sends the thread to core's trash (`sessions.remove`), leaving the thread on screen for the newest other thread of its project first. Unpin, settle, snooze, archive and delete leave a toast with Undo on core's stack for five seconds (`undo.ts`: consecutive actions of one kind are one notice and are undone together; a later action of the kind, or the opposite by hand, spends the earlier undo); `thread.undo` takes the group back and is bound to `mod+z` under `!terminalFocus && !editableFocus`. Settings → Archived also lists the threads in core's trash, to restore or delete for good | Thread Rail |
| Prompt tools: stashing a draft, recalling earlier prompts, citing a reply, queue or steer while a turn runs | Prompt Tools: `kits/prompt-tools/`, a package Tau ships (ADR 0014). Its desktop half binds `mod+s` to "Stash the draft" and draws the Stash control with its count in the composer toolbar: an entry keeps the text, Composer Context's chips (through `tau.composer-context/chips`) and the images, per project, twenty at most, and restoring one stashes what the composer held first. ↑ in an empty composer recalls the thread's prompts, then the project's other threads' (`keyDown` on `registerComposerInline`); "Cite" on an assistant reply (`registerMessageAction`) puts the selection, or the reply, into the composer as a quote chip, or as a `>` block without Composer Context; its "While a turn runs" option answers `streamingDelivery`. Its host half runs in a worker and keeps the stash in `<userData>/kit-state/tau.prompt-tools/stash/`, and reads the project's prompts from the session files `sessions.list` names. Core lends those three seams, `actions` for a composer control and a draft's images (`composerImages`, `setComposerImages`) | Prompt Tools |
| Line comments on a diff as context for the next prompt, split or unified diffs, hidden whitespace, files that start collapsed; rewinding to a checkpoint with or without its files | Review Kit fills the seams core's `ReviewMode` lends (`lines`, `layout`, `ignoreWhitespace`, `filesStartCollapsed`, `toolbar`, `aside`; `DiffView` takes the same line seam): a comment opens under the line its gutter button belongs to, the kit keeps them per workspace in client storage, lists them beside the diffs and hands them to Composer Context's chip service as `text-excerpt` chips — as text in the draft when that kit is off. Core draws the gutter button and the row under a line and knows no comment; its own review notes are gone, and the kit takes over the ones a user left once. Workspace Kit answers `ignoreWhitespace` with `git diff --ignore-all-space`, and its checkpoint card asks how to rewind: "Keep changes" branches the conversation at the checkpoint's answer through its own `rewind` command and touches no file, "Revert files too" is the restore above, backup thread first | Review Kit, Workspace Kit |
| The warning before a subscription login a vendor forbids outside its own apps (Anthropic, Google) | Subscription Login Warning: `kits/subscription-login/`, a package Tau ships (ADR 0014) with a desktop half and no host half. A shield before the thread title (`thread-title` region), a badge and a line in the model picker (`registerModelBadge`), and one question per provider before such a model is first chosen or sent to (`registerComposerGate`); the acknowledgements are the kit's own preference value. Core keeps only the `UiModel.login` fact and the neutral "subscription login" tag | Subscription Login Warning |
| Search: the project's files by content, a file by name, threads and projects from the palette | Search: `kits/search/`, a package Tau ships (ADR 0014). Its host half runs in a worker: ⇧⌘F's content search runs the machine's `rg` found with `findCommand` (`--json`, `.gitignore` honoured in a Git checkout or not, hidden files but never `.git`, 500 hits) and stops the running search when the next query arrives, and without ripgrep it walks the project itself, reading each folder's `.gitignore`; ⌘P ranks the project's file list, cached per project and forgotten when Workspace Kit's store reports a new Git status, with its own fuzzy scorer; the palette's thread search reads the user and assistant text of the newest session files, and the thread on screen through `services.transcript` when it has none. Its desktop half draws both dialogs from a title-bar region over the window, opens a hit with `openFile(path, { line })`, and registers three palette sources: threads by title, threads by what was said in them, projects. Core lends `registerPaletteSource`, the settings `keywords` and the file tab's line | Search |
| Notifications: a system notification, a sound and the app icon's badge when a thread finishes, fails or asks something while nobody looks at it | Notifications: `kits/notifications/`, a package Tau ships (ADR 0014). Its host half follows turns through the turn observer and questions through `decorateUiPrompt` (so `runtime:extend`, in-process), skips sub-agents, and keeps the threads with unseen news in memory (`attention.ts`); each client reports whether its window has focus and which thread it shows, a thread on screen in a focused window counts nothing, and otherwise one client hears of it — the one that had focus last. News that finds no client waits for the first one to report; a thread's second piece of news within five seconds notifies nobody. Its desktop half draws it through `context.attention` (core's `Platform.attention`), synthesises its two sounds with Web Audio, toasts above the composer when opted in and owns Settings → Notifications; the choices are the client's | Notifications |
| Codex backend, and a runtime's CLI version | Codex: `kits/codex/`, a package Tau ships (ADR 0014), registering a runtime backend that drives the installed `codex` through `codex app-server` over stdio (JSON-RPC, one process per live thread): threads start and resume by Codex's own thread id, text, reasoning and commands, file changes, MCP calls and web searches stream as runtime events, Codex's approval requests and questions go through `ask`, Tau's access levels become Codex's approval policy and sandbox, models and reasoning efforts come from `model/list`. It refuses a CLI its version policy calls broken — every release older than the protocol it was built against — and warns about one it calls unsafe, keeps its store beside Pi's sessions, answers Usage Kit's `usage` and fills its card on Settings → Providers, where Claude Code and Antigravity have theirs: a settings page that names a `runtime` is drawn as that runtime's card there, with the CLI, its version and update, the login and a path override, instead of a nav entry of its own. Any backend may report the program it drives through `version()` on `registerRuntimeBackend`; core asks once a day, publishes the answer on `runtimeBackends` and says in the picker's runtime tab and in Settings → Defaults when an update is out — Claude Code and Codex compare with npm (`npmLatestVersion`, cached a day), Antigravity with the release it pins. Codex and the Agent SDK runtime run several instances of their CLI — each with its own executable, home, environment and launch arguments, registered as a backend of its own (`codex@work`), so a thread keeps its instance and the picker shows one tab per instance; `RuntimeInstanceSettings`, the version policy and the lazily loaded instance setup, dialog and banner are the seams they share | Codex kit, shipped by default |
| A thread's pull or merge request on the stage: summary, timeline, code with review threads, checks, reviewers and labels, editing the title and description, viewed files, replies and new line comments | Review Kit: `kits/review/pull-request-host.ts` reads and writes one request by its URL through `gh` or `glab`, found with `findCommand` — `gh pr view --json`, `gh pr diff`, one GraphQL query for review threads and viewed marks, `markFileAsViewed`, `addPullRequestReviewThreadReply`, the REST line comment, `gh pr comment` and `gh pr edit`, bodies on stdin; GitLab through `glab api` with JSON on stdin. Reads are cached for a minute per request and dropped by any write; GitLab keeps no viewed marks, so the kit stores them in its `stateDir` with a fingerprint of each file's change. The desktop half registers the `review.pull-request` stage-tab kind (`registerStageTab`), opened from the Changes section's `PR #n` or "Open the thread's pull request"; it draws the diff with `DiffView` and its line seam and the text with `Markdown`, polls only while the tab is on screen, hands comments to Composer Context's chip service and feeds what it read back to the rail row's mark | Review Kit |
| Editing a workspace file on the stage: save, a dot for unsaved work, a change on disk as a conflict; Markdown, HTML and CSV/TSV rendered or as source; PDFs, images, audio and video | Files: `kits/files/`, a package Tau ships (ADR 0014). Its desktop half registers the stage tab kind `tau.files.editor`, opened by "Edit file" on a file tab (the `file-tab` command surface), by a double-click in the Files panel (`registerFileEditor` on Workspace Kit's store) and restored with the stage. The editor is CodeMirror 6 in the kit's own bundle (`code-editor.tsx`, `editor-view.ts`), which `scripts/build-kits.mjs` builds into `dist-kits/` and the renderer's budgets do not count; it is evaluated on the first open of a file, and each language mode (`languages.ts`: TS/JS/JSX/TSX, JSON, CSS, HTML, Markdown, Python, Rust, Go, YAML, shell, TOML) on the first file that needs it. It has line numbers, folding, bracket matching, several cursors, search and replace on `mod+f`, and a soft-wrap switch in the header that is also the kit's `wordWrap` option; its colours are Tau's tokens (`editor-theme.ts`). The buffer lives in the kit (`document.ts`), so a background tab keeps unsaved work; `mod+s` is "Save file" under `editorFocus` and stays Prompt Tools' stash everywhere else; the tab on screen asks the disk every two seconds, on window focus and after the agent's edit, write and bash tools — a clean buffer reloads, a dirty one shows "Reload from disk" or "Keep my version", and a save that names a stale mtime is refused as a conflict. Autosave after a second is an option, off by default. Markdown renders with core's `Markdown`, HTML in a `sandbox=""` frame from `srcdoc`, CSV/TSV as a table of 100 rows and 30 columns; the choice is kept per kind on the client. PDFs, images, audio and video load from `actions.shareFile`. "Open in" lists every editor Workspace Kit found and reveals in Finder, Explorer or Files. Its host half runs in a worker and only forwards `read`, `stat` and `write` to Workspace Kit's `read-file`, `file-stat` and `write-file`, which name `tau.files` as caller (ADR 0020) and check every path | Files |
| Worktree operations: cleanup rules, Settings → Storage, the setup of a new thread's worktree step by step, `tau app <path>` from a terminal | Workspace Kit and Project Scripts. Workspace Kit writes every worktree it creates to `<userData>/kit-state/tau.workspace/worktrees.json` (`worktree-storage.ts`) and sweeps them hourly, soon after a thread deletion a rule answers (`threadDeleted`) and on "Clean up now": four rules after T3 Code — inactive for N days, merged into the default branch, the last thread deleted (a thread in the host's trash still counts), no commits beyond the base — host-wide or per repository (Inherit/Off/Custom) in `cleanup-policy.json` beside it. It removes only a recorded worktree inside the repository's worktrees folder, through `git worktree remove` without `--force`, keeps the branch, and never one with uncommitted or ignored files other than `node_modules`, unpushed commits, an open thread or the host's own workspace (`worktree-cleanup.ts` is that judgement, and the Storage page shows it as the dry run: size, age, threads, what the next cleanup does, Remove by hand with a confirmation). Project Scripts tracks a worktree's setup (`setup.ts`): Workspace Kit reports fetching the base and creating the checkout (`worktree-setup-begin`/`-step`/`-failed`, callers `tau.workspace`), every `runOnWorktreeCreate` script is a step with its last four lines, and the card under the transcript (`setup-card.tsx`, after T3 Code's) cancels the scripts or starts the thread now. `bin/tau.mjs app [path]` reads `<userData>/host.json`, says hello with the host's token as an auxiliary client and asks Workspace Kit's `app-open`: an attached window opens the project with a new thread's draft (`newSession({ workspace })`) and the kit's `window` half brings it to the front; without a window the request waits for the app the command line starts | Workspace Kit, Project Scripts |
| Appearance: a theme for the light and the dark scheme, density, contrast, the interface, prompt and code faces, the timestamp format, a theme editor and VS Code theme import | Appearance Kit: `kits/appearance/`, a package Tau ships (ADR 0014). Its desktop half is Settings → Appearance (`scope: "both"`, so density can be a project's own) and applies the values to `<html>`: `data-density` (its stylesheet turns it into `--density`), `data-timestamps`, the `--prompt-font-*` and `--code-font-*` properties core's rules read, and one stylesheet with the chosen user themes per scheme and the contrast (hairlines and quiet inks mixed toward `--ink` on `<body>`, from the tokens `<html>` keeps under another name). The theme editor floats over the window from a title-bar region and paints its draft there: three colours derive a palette (`palette.ts`), every token can be set on its own, and Save writes `<themesDir>/<id>.css` through the host half (a worker, `save-theme`), which Tau then lists like any user theme. A VS Code colour theme is read as JSONC and mapped onto the tokens with fallbacks (`vscode-import.ts`). Core lends `themesDir`, `userThemes`, the rows and the font properties | Appearance Kit |
| First start: which runtimes (every registered runtime backend, instances included) and, as an optional group, which pull-request CLIs the machine has, adding the folders the agent CLIs worked in as projects, importing their earlier conversations as threads | Onboarding: `kits/onboarding/`, a package Tau ships (ADR 0014). Its host half runs in a worker: it finds `gh` and `glab` with `findCommand` and asks their version and login, asks each backend kit for the sessions its CLI kept (`import-scan`) and hands an import on in batches of ten (`import-sessions`, callers `tau.onboarding`), pushing progress; reading a CLI's files, checking a path against its home and writing the threads are the backend kit's. A runtime's own state comes from its kit's `status` (`tau.<kind>`, `{ instance }` for a `<kind>@<id>` backend; `probe` when `status` has no login), so a path override counts. Its desktop half is a wizard overlay (`registerOverlay`) laid out as T3 Code's — Agents, Projects, Conversations — which an empty title-bar region opens on a first start (no thread, setup never finished) and `/welcome` or "Set up Tau…" opens again; a chosen folder is admitted with `services.workspaceRef` and opened with `actions.openWorkspace`, and "Add a folder…" is the project sources. Core lends nothing new | Onboarding |
| Plan mode: the Build/Plan chip, a proposed plan as a card, Plan ready with Implement | Plan Kit: `kits/plan/`, a package Tau ships (ADR 0014). Its host half gives Pi threads the `plan` mode through a runtime extension (`registerRuntimeExtension(…, { modes })`): while a thread plans, its system prompt asks for exploration and a `proposed_plan` block and `edit` and `write` are refused; it also starts the thread "Implement in a new thread" hands a plan to (`sessions.start`). Its desktop half draws the chip where the runtime offers the mode, draws `proposed_plan` blocks as cards (`registerMessageBlock`) and shows Plan ready above the composer once a plan-mode turn settled on a plan; Implement switches the thread back to `default` (`actions.setMode`) and sends the plan (`actions.submitPrompt`). Codex and the Agent SDK runtime implement the mode in their own kits. Core lends the mode itself: the `mode` capability, the catalog's `mode` and `modes`, `set-mode` and the new-thread configuration's `mode` | Plan Kit |

**Runtime Controls is core, not a kit.** The Settings screen with its
Defaults, Pi, Keybindings and Inspector pages and its search field, and the contributions that reach
core's own actions — the command palette, `mod+,` for Settings, `escape` to abort, `mod+n`,
`/reload`, `/tree`, `/fork`, `/clone`, "Set model…", "Set thinking level…" —
are the workbench itself. A window that cannot pick a model is not a usable
window, and safe mode has to be one. They live in `src/renderer/settings/`
(`runtimeControls`, activated through `registry.activateCore`, so it is on in
safe mode too and carries no switch). The host entry that reads Pi's
`keybindings.json` and its extension shortcuts is the Keybindings kit's
`kits/keybindings/host.ts`, not core; Runtime Controls only keeps the id
`tau.runtime-settings`, the name Pi's keybindings arrive under.

The **Pi page** draws the settings Pi owns. `HostConfigManager` splits an
`update-config` patch: the keys Tau applies itself go to `~/.tau/config.json`,
and the keys Pi reads and applies go to Pi's own `~/.pi/agent/settings.json`
(or the project's `.pi/settings.json`), merging into what is already there. A
value in Tau's file that Pi owns is therefore never accepted, persisted and
then ignored — Pi's file is the one authority for those, and `read` lets it
win. The names differ on one point: Tau calls a model `provider/modelId` in
`models.default`, Pi wants `defaultProvider` and `defaultModel` apart.

The one thing safe mode loses with the kits is `/install` and the Packages
page — the package manager is a kit like any other now. Recovering from a
window that cannot install is still `npm run start` or an edit to
`~/.tau/packages.json`.

## The stylesheet

`src/renderer/tokens.css` is the palette, and it is a contract: every colour,
font, radius, elevation and motion value Tau draws with is named there and
nowhere else, in two sets — `light-dark(light, dark)`, chosen by the
`color-scheme` that `data-theme` on `<html>` sets. The theme preference
(`system`, `dark`, `light`; `system` is the default and follows
`prefers-color-scheme`) is core's, in Settings → Defaults and in the palette,
and the client writes it onto `<html>`: no component in the workbench knows a
colour. `index.html` links the file rather than importing it, so the first
paint is already themed.

Spacing is a token scale too: `--space-1` to `--space-8` (2 to 32 px), each
multiplied by `--density`, which is `1` unless a client sets it on `<html>`.
The structural spacing — the thread rail, the thread row, the transcript, the
headers, the composer, the Settings screen — reads the scale; detail rules keep
their pixels until a visual pass moves them. Core applies no density of its
own: Appearance Kit sets it.

The table of those names is in [EXTENSIONS.md](EXTENSIONS.md) §8, because it is
what a **theme package** — a manifest with `styles` and no code — may set. A
theme's stylesheet is linked after core's tokens and after every kit, so its
names win on order alone. Nothing about a layout class is API.

A kit that draws a surface of its own carries the rules for it: a `styles`
entry in its manifest, `kits/<name>/styles.css`, linked while the kit is active
and gone with it (see [EXTENSIONS.md](EXTENSIONS.md)). Workspace, Agents,
Preview, Signals, Packages, Questionnaires, Pi UI and Review have one. They
name tokens like everything else and define no colour of their own.

`src/renderer/styles.css` keeps the classes **core itself draws**, which is the
whole of the test: a rule stays if a core component renders the element, even
when only a kit ever mounts that component.

| Stayed in core | Why |
|---|---|
| The window and its slots: `.app-shell`, `.workbench-center`, `.instrument-dock`, `.panel-rail`, `.panel-stage`, `.panel-header`, `.panel-body`, `.dock-resizer`, `.stage*`, `.thread-document` | Core's layout and the frame a panel contribution is drawn into. Four kits fill it; none of them owns it. |
| The thread row: `.thread-row`, `.thread-main`, `.thread-title`, `.thread-branch`, `.thread-project-icon`, `.activity-*`, `.thread-cost*`, `.thread-agent-count`, `.thread-row-actions`, `.thread-settle`, `.provider-icon*` | `ThreadRow` is core's component, published on `tau` (ADR 0014): a thread is core's and its row is how core draws one. The rail around it is Workspace Kit's and moved. |
| The menu: `.menu`, `.menu-anchor`, `.menu-label`, `.menu-heading`, `.menu-scrim`, `.menu-hint`, `.menu-sub-anchor`, `.chev` | `Menu` on `tau`; Workspace Kit, Access Kit and Service Tier all open core's menu. |
| The other primitives: `.tooltip`, `.popover`, `.skeleton`, `.empty-state*`, `.spinner-*` | Drawn by `TooltipLayer`, `Popover`, `Skeleton`, `Empty` and `Spinner` on `tau`. The toast stack's rules (`.toast-stack`, `.toast-*`) are the one exception to this file: they live in `src/renderer/components/ui/toasts.css` and load with the stack's chunk on the first toast, because the initial stylesheet budget had no room for them. |
| Buttons and chips: `.chrome-button`, `.chrome-ghost`, `.icon-button`, `.text-button`, `.mini-button`, `.chip`, `.runtime-chip`, `.switch`, `.segmented`, `.primary`, `.danger`, `.accent` | The shared vocabulary of the workbench. Access Kit and Service Tier draw their composer chips entirely with it, so those two kits have no stylesheet at all. |
| The prompt frame: `.extension-prompt*`, `.extension-option*`, `.option-row` | `ExtensionPromptFrame` and `OptionRow` on `tau`. Only Questionnaires' own pager (`.extension-pager`) moved. |
| Review and diff: `.review-*`, `.diff-*`, `.changes-tree-*`, `.commit-proposal*`, `.source-*`, `.stat-add`, `.stat-del` | `ReviewMode`, `ChangesTree` and `DiffView` are core components published on `tau`; Review Kit mounts core's overlay rather than drawing one. Workspace Kit's own dock around them (`.changed-file*`, `.commit-box`) moved, including the rules that resize core's `.stat-add`/`.stat-del` inside it, and so did what Review Kit draws into the line seam (`.review-comment-*`, `.review-comments`). |
| Settings: `.settings-screen`, `.settings-nav*`, `.settings-topbar`, `.settings-crumb*`, `.settings-scope`, `.settings-content`, `.settings-section*`, `.settings-group*`, `.settings-row*`, `.setting-origin*`, `.setting-reset`, `.settings-search-*`, `.settings-field`, `.settings-input`, `.settings-select`, `.settings-filter`, `.settings-label`, `.settings-note`, `.settings-page`, `.install-extension`, `.extension-grant-box`, `.inspector-*`, `.keybinding-row`, `.provider-card*` | Core keeps the Settings screen, its rows (which kits build their pages from) and the pages safe mode needs. Only `.packages-*` — the install form, its log and its actions — moved to Packages Kit. |
| Terminal Kit's `.terminal-*` and the xterm.js rules under `.terminal-view` | Terminal Kit's own panel and the stylesheet xterm.js needs, scoped under the kit's surface; its colors come from the tokens (`--sunken`, `--ink`) so a theme reaches the shell too. |
| The status line and the regions: `.status-line`, `.status-item`, `.status-side`, `.workbench-region`, `.region-*` | Placements core publishes. Only what Pi extensions draw inside them (`.pi-ui-*`) moved. |
| Transcript, composer, palette and modals: `.transcript*`, `.message*`, `.markdown`, `.hljs-*`, `.tool-*`, `.work-fold*`, `.work-live*`, `.task-progress*`, `.composer-*`, `.command-palette`, `.model-picker`, `.approval`, `.reload-*`, `.project-picker`, `.project-modal`, `.thread-tree*` | Core's own surfaces, on the list above. |
| The tokens (now `tokens.css`), `.spinner` and the keyframes | The palette and the animations every kit's own rules refer to (`var(--ink-2)`, `blink`, `spin`). A kit stylesheet uses them and defines none. |

The rules for classes nothing renders any more are gone (`.approval-mark`,
`.image-placeholder`, `.palette-group`, `.reasoning-toggle`, `.reasoning-body`,
`.typing-mark`, `.thread-virtual-spacer`, `.tool-group-header`,
`.turn-activity-stack`, `.title-auto-toggle`, `.review-file-read`,
`.review-files-virtual`, `.tier-mark`, `.title-generator-actions`,
`.review-file-select`, `.review-comment-composer`, `.review-notes`).

## How to check

- Every colour is a token: `src/renderer/tokens.test.ts` fails on one written outside `tokens.css`, on a `var()` naming a token nothing defines, and on a text token that misses WCAG AA in either scheme. A package that brings only a stylesheet is a theme — no grant, loaded last, marked "Theme" in Settings → Packages.
- Settings → Packages lists the two sets apart: the kits Tau ships (`scope: "bundled"` from `inspectBundledKits`, granted by construction), headed by the distribution they came in (`@tau/kits` and its version, from `dist-kits/manifest.json`), above the packages a source installed. A rescan after an install never touches the first set — the activator only ever loads what it scanned from the package folders, and refuses a package claiming a kit's id.
- The kits Tau ships live under `kits/<name>/` with a `tau-extension.json` and load through the package loaders, from `dist-kits/` when the app was built and from the sources otherwise. There is no other door in either direction: a kit reaches core through `tau` (`src/renderer/extension-api.ts`), `tau/host-extension` (`src/main/host-extension-api.ts`) and `tau/host` (`src/main/host-extension-worker-protocol.ts`), plus the two test harnesses its own tests may use; core reaches a kit through the contributions the kit registers, never by path. `src/shared/kits-boundary.test.ts` fails on any other reach, and `src/shared/core-boundary.test.ts` fails if an `extensions/` directory reappears under `src/`. A kit that also runs inside a Pi runtime Tau does not own ships a `pi` entry, prebuilt to `dist-kits/<id>/pi.cjs`, which `.pi/extensions/tau-session-bridge.ts` loads through `PiKitBridge` — the bridge itself names no kit.
- `start:safe` shows the core list and nothing more. That includes no access gate: safe mode runs tools the way Pi does.
- Removing a bundled kit removes its behavior on both sides without editing core.
- `src/shared/contracts.ts` and `src/main/index.ts` name no feature. Feature commands travel through `invokeHostExtension`. Core operations are the method table in `src/main/host-methods.ts`; `src/main/ipc-contract.test.ts` fails when the client and the table stop naming the same methods.
- Thread lineage is an extension's claim, not a core field: a desktop extension publishes `setThreadLineage`, and the navigator hides spawned threads and counts a parent's working children from it. `UiSession` has no parent.
- `PiHost` orchestrates and owns almost nothing itself. Attached-Pi ownership, transcript projection, client-message correlation, extension questions and session-event translation delegate to focused modules, and so do the project facts a provider answers with (`project-facts-cache.ts`), the thread index and its shells (`thread-index.ts`), extension binding (`thread-binding.ts`), a runtime from build to teardown (`thread-runtime-lifecycle.ts`), the spare runtime and thread prewarming (`runtime-prewarm.ts`), a prompt's runtime spelling and its guards (`prompt-preparation.ts`) and steering, follow-up and adapter turns (`turn-delivery.ts`). What is left in `pi-host.ts` is the sequencing: activation epochs, the lifecycle queue and what each operation publishes. A thread's runtime answers through `ThreadRuntimeBackend` (`src/main/runtime-types.ts`): twenty required members in Tau's own vocabulary plus capability groups, with `requireCapability` as the one place that refuses what a runtime cannot do. The Pi terminal Tau attaches to is one of those backends (`attached-thread-backend.ts`), its collaborators receive named ports (`host-ports.ts`), and thread lifecycle work is serialised by a reentrant `LifecycleQueue` (`lifecycle-queue.ts`). The renderer delegates layout to `Workbench`, its client state to `src/workbench/`, and keeps per-thread composer data in `ComposerScopeStore`.
- Tests keep this true: `src/shared/core-boundary.test.ts` fails on a feature name in those two files outside a listed debt and caps `pi-host.ts` at 2,300 lines and `App.tsx` at 700; `src/workbench/workbench-boundary.test.ts` fails on React, Electron or a browser global inside the client. `src/main/pi-host-safe-mode.test.ts` proves safe mode loads no host or Pi extension, and `kits/kit-lifecycle.test.tsx` activates and removes every kit against the core slots.
- The client reaches the desktop host only through `HostClient` (see "Renderer host client" in [host-protocol.md](host-protocol.md)) and the machine only through `Platform`; `src/renderer/host-client-boundary.test.ts` fails on any module outside `main.tsx` touching the preload bridge, and `client-storage-boundary.test.ts` on any outside `platform-electron.ts` reading the browser's own store.
- An extension package is not core and is not trusted: it declares `permissions`, waits for the user's grant in `~/.tau/extension-grants.json` before either half starts, and reaches host services through the proxy in `guardedServices`. `src/main/extension-packages.test.ts` proves an unapproved package is never even imported, in the global folder as much as in a project's. [docs/EXTENSIONS.md](EXTENSIONS.md) is the guide for writing one.
- The renderer's own boundary is checked, not assumed: the window runs sandboxed with `webSecurity`, no webview tag and no permission of any kind (`src/main/index.ts`), and desktop bundles arrive over the `tau-ext` scheme instead of a blob URL, so the page's CSP is `script-src 'self' tau-ext:`. `src/main/extension-bundle-server.test.ts` fails if the scheme serves anything it was not given or if `blob:` returns to the CSP.
