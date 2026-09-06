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
- A third-party package can be installed from npm, Git or a folder, waits for a permission grant before either half runs, and its host half runs isolated in a worker thread unless it was granted `in-process` (Phase 3, Phase 2; ADR 0009, ADR 0011; see `docs/EXTENSIONS.md`).
- A window can run as a pure client of a host on another machine over an authenticated socket, with reconnect and event replay (Phase 4; ADR 0010; `TAU_HOST_URL`, `TAU_HOST_LISTEN`).
- The product is assembled from extensions in fact and not only in name: every bundled feature is a package under `kits/`, and the repository builds two artifacts — core, and the `@tau/kits` distribution the installer ships (Phase 6; ADR 0014).

This is enough to evaluate the architecture in use. What is not yet proven: a week of real, everyday use (Phase 1's own completion check, still open), a remote host reached without an SSH tunnel (TLS is follow-up work), and Tau running on Windows at all — every verification so far, including this plan's own git history, is macOS and Linux.

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
2. add a host-side extension seam so a package can own host commands and events (done: ADR 0006, `src/main/host-extensions.ts`; packages on disk with a `tau-extension.json` manifest load their host half dynamically, see README); the Git cache followed the features out of core (done: ADR 0007, project name, label and nesting come from `describeProjects`)
3. move features out by size: Git and workspace (done, now the package `kits/workspace/`), then title generation (done, now the package `kits/thread-titles/`), service tier, questionnaire and computer use (done as host extensions), project sources incl. clone (done), turn checkpoints (done: `kits/workspace/host-lifecycle.ts` owns capture, restore, recovery and ref upkeep through lifecycle hooks and a turn observer of the seam; the transcript carries no checkpoint field any more, only pinned anchors); the Claude Code backend stays a supported runtime and is its own bundled host extension behind `registerRuntimeBackend` (done: `kits/claude-code/`, ADR 0005 amendment)
4. add the renderer contribution points the moved features need (done: transcript rows, regions, status line, overlays, event subscriptions, document source, extension values; the Git orchestration left `App.tsx` with them; slash commands (done: `registerSlashCommand`, the composer menu lists them next to the runtime's own); keybindings (done: `registerKeybinding`, core only dispatches; the five chords moved to their extensions); prompt renderers (done: `registerPromptRenderer`, the questionnaire paging left App.tsx and the core prompt))
5. close the gaps to the Pi terminal: render thinking (done: collapsed blocks with a toggle command), tree/fork/clone (done: core actions `threadTree`, `navigateThreadTree`, `duplicateThread` with a tree modal; Runtime Controls adds `/tree`, `/fork`, `/clone`), map `ctx.ui` status, widget, working message and notify onto workbench slots (done: Pi UI extension; `setFooter` and component widgets need a terminal and stay reported as unsupported), honor `registerShortcut` and `keybindings.json` (done: the Keybindings kit's host entry reads both; Pi shortcuts become palette commands bound to their chord), register the hard-coded slash commands (done: `/reload` is the Runtime Controls extension's single build, extension reload and conditional app restart command)
6. make the access gate a default-on extension (done: Access Kit owns the level, the Pi gate and the composer control; approvals use Pi's `ctx.ui.confirm`, so the core approval overlay and its IPC entries are gone)
7. split the two remaining core coordinators (done: attached-Pi lifecycle, transcript projection, client-message tracking, extension questions and session-event translation left `PiHost`; layout, composer mounting and conversation activity rendering left `App.tsx`. The boundary test caps them at 3,000 and 1,800 lines.)

Host tools come from the user's machine, the way the terminal has them: at startup the main process reads the login shell's environment (`src/main/shell-environment.ts`) so `git`, `claude`, editors and Pi's own tools resolve after a Dock launch, and the seam offers `findCommand(name)`. Claude Code is the installed CLI with its own `~/.claude` login and settings; Tau sets neither `HOME` nor `CLAUDE_CONFIG_DIR`. The Review's branch scope takes the base of the current branch's pull or merge request from `gh` or `glab` when one is installed and logged in (`kits/workspace/review-request.ts`, found through `findCommand`, origin URL decides which is asked first) and falls back to the Git heuristics otherwise.

Completion check: `start:safe` shows exactly the core listed in `docs/CORE.md`; every bundled kit can be removed on both the host and the desktop side without editing core; no feature name appears in `src/shared/contracts.ts` or `src/main/index.ts`. Checked by `src/shared/core-boundary.test.ts` (names), `src/main/pi-host-safe-mode.test.ts` and `kits/kit-lifecycle.test.tsx`, all part of `npm test`. Since 2026-09-04, `npm test` and this check run on their own: `.github/workflows/ci.yml` runs lint (`oxlint`), typecheck, the full Vitest suite and a production build on every pull request and push to `main`, with `.github/workflows/performance.yml` as the separate, slower gate for build/startup/renderer budgets.

## Phase 2: load extension packages dynamically

Replace the bundled-only registry with a package loader.

Planned work:

- define a versioned desktop extension manifest (done: `tau-extension.json` names id, name, `version`, `engines` and the two entries, ADR 0008 with amendment)
- discover installed extensions without source edits (done: `~/.tau/extensions` and `<project>/.tau/extensions`, synced at start, on project change and on `/reload`)
- persist enablement and extension settings (done for enablement: the Settings toggle switches both halves and is remembered; extension settings are still each package's own business)
- report activation failures without preventing Tau from starting (done: the failure shows on the extension's settings page)
- define compatibility checks for Tau, Pi, and contribution interface versions (done: `engines.tau`, `engines.pi`, `engines.api` against the app version, the bundled Pi and `EXTENSION_API_VERSION`; a miss keeps both halves off with the reason in the Inspector)
- let one package declare both Pi and desktop entry points (done: `desktop` and `host` entries; a Pi extension entry is still registered from the host half through `registerRuntimeExtension`)
- add development tooling for applying changes and inspecting extensions (done: `/reload` builds Tau, reloads extensions and restarts when required; Settings → Inspector lists both registries, the package folders, versions, engines, errors and skips)
- install, update and remove a package without touching the disk by hand (done: `tau.packages` with `/install`, `/remove`, `/update` over `npm:`, `git:` and folder sources, a source list per scope in `packages.json`, and Settings → Packages; ADR 0011)

Completion check: a separately packaged extension can be installed, enabled, disabled, upgraded, and removed without rebuilding Tau.

## Phase 3: define trust and isolation

Dynamic code needs an explicit security model before third-party distribution. See `docs/adr/0009-extension-permissions.md`.

Work completed:

- define permissions for filesystem, process, network, credentials, projects, and host commands (done: `EXTENSION_PERMISSIONS` vocabulary in `src/shared/extension-permissions.ts`, proxy guard on `HostExtensionServices`)
- separate trusted in-process extensions from isolated extensions (done: bundled kits declare permissions, third-party packages default to none and require user grant; desktop bundles isolate IPC via `window.tau = undefined`)
- show requested permissions before activation (done: a package without a grant shows as waiting in Settings with Allow / Deny, persisted in `~/.tau/extension-grants.json`; its host entry is not compiled until it is approved, in either scope)
- isolate renderer UI and validate every host command (done: `guardedServices` validates every method/property call against declared permissions; `LazyFeatureBoundary` wraps all UI slots)
- define package provenance, update, and revocation behavior (done: `source.url` and `source.commit` manifest fields, plus an optional Ed25519 `tau-extension.sig` checked against `~/.tau/trusted-publishers.json` — a changed file refuses to load, an untrusted or missing signature only changes what the approval UI says; revoking is removing a grant, a key, or the source, ADR 0011. A hosted revocation list stays out.)
- add recovery paths for crashing or unresponsive extensions (done: 30s command timeout and 3-strike failure deactivation on the host; automatic boundary catch, deactivation, and toast notifications on the renderer)

- close the renderer's own boundary (done: desktop bundles are served over the privileged `tau-ext` scheme instead of blob URLs so the CSP drops `blob:`; the window runs sandboxed and the default session denies every permission)

- isolate a package's host half from the main process, not just from a grant on paper (done 2026-09-05: a package runs in a worker thread by default — no Electron, a 256 MB heap cap, a plain-data facade over the port — and `"isolation": "in-process"` is a privilege granted like a permission for the packages that need a live host object; `src/main/host-extension-isolation.ts`, `src/main/host-extension-worker-protocol.ts`, ADR 0009's "2026-09-05: isolated host packages" section, `npm run smoke:extension-install` activates a signed package in its own worker)

Completion check: Tau can explain what an extension may access, enforce that decision, and recover when the extension fails. Satisfied by ticket 17.

## Phase 4: make the host transportable

Turn the current Electron IPC adapter into one implementation of a client-to-host protocol. See `docs/adr/0010-host-protocol.md`.

Planned work:

- define versioned commands, events, snapshots, and capability negotiation (done: `HOST_TRANSPORT_VERSION = 1` in `src/shared/host-transport.ts`, one method table in `src/main/host-methods.ts`, capabilities in the hello reply)
- support reconnect, event replay, cancellation, and partial failure (done: pushes carry `seq`, the host buffers the last 500, `hello` with `lastSeq` replays or answers `resync`; `HostConnection` shows `connected / reconnecting / resyncing`)
- distinguish local paths from remote workspace identities (done 2026-09-05: every project the host publishes carries an opaque `workspaceId` — a truncated hash of the host's own persisted id and the workspace's canonical path — and a `displayPath`; files travel as a POSIX `relPath` the host validates before touching disk; `cwd`, `UiProject.path` and `UiSession.projectPath` stay on the wire one minor version longer as deprecated display data; recent projects and client caches key on the id, not the path; `src/shared/workspace-identity.ts`, ADR 0010's amendment, ticket 18)
- move long-running project operations behind host jobs with progress events (done for the workbench rebuild and Workspace Kit's clone: `start-job`, `job-progress`, `job-done`, `cancel-job`; a host extension marks its own long commands)
- add authentication and encrypted remote connections (done for authentication: a 32-byte token in `~/.tau/host-token` on the socket transport; a non-loopback bind is refused unless `TAU_HOST_INSECURE=1` says otherwise; encryption stays an SSH tunnel's job, TLS remains follow-up work)
- test a desktop client against Pi running on another machine (done headless: `npm run smoke:remote-host` drives `src/main/headless.ts` over the socket, including a reconnect that replays what it missed; done with a real window too, 2026-09-05: `TAU_HOST_URL` makes the Electron main process open a window with no `PiHost` and no Pi of its own, speaking the same protocol over the socket transport — ADR 0010's "a window that is only a client" amendment, `README.md`'s "Run the host on another machine")

Completion check: the desktop workbench can reconnect to a remote host and continue an existing thread without treating remote files as local paths. Satisfied 2026-09-05 for a single trusted host reached over an SSH tunnel. Two things remain before this phase is closed out for a wider setup: TLS (or another transport-level encryption) for a host reached without a tunnel, and a verification pass on Windows — the host has only run on macOS and Linux so far, and the login-shell-environment read (`src/main/shell-environment.ts`) and the `findCommand`/`git`/`npm` lookups it feeds assume a POSIX shell.

## Phase 5: add other clients

Build web or mobile clients only after the host protocol and extension capability model are stable.

Settled 2026-09-05: a web or mobile client is explicitly out of scope for now (ADR 0010's "Out of scope" list, ticket 19). The protocol amendment that made a plain Electron window a pure client of a remote host (`TAU_HOST_URL`, above) deliberately stopped there: a browser client would additionally need the host to serve its own built assets and a way to enter a token without a native dialog, and nothing does either yet. The planned work below records what such a client would still need if this is revisited, not work in progress.

Planned work:

- separate workbench state from Electron-specific behavior
- define which desktop contributions have web or mobile renderers
- adapt navigation and agent supervision for small screens
- keep host-side Pi and project extensions available when a client cannot render their desktop UI

Completion check: a second client can supervise the same host and clearly reports unsupported desktop capabilities.

## Phase 6: ship core and kits as two artifacts

Done 2026-09-06. Every bundled feature became a package under `kits/<name>/`
with a `tau-extension.json`, a host half and a desktop half, loaded through the
same code path an installed package uses: same manifest parser, same bundlers,
same registry, same `guardedServices` (ADR 0014). Core imports no kit, and a kit
reaches core through `tau`, `tau/host-extension` and `tau/host` and nothing
else; `src/shared/kits-boundary.test.ts` fails on a reach in either direction.
Fifteen kits moved across three waves: Thread Titles and Worktree Names first,
then Access, Agents, Claude Code, Computer Use, Keybindings, Packages, Pi UI,
Preview, Questionnaires, Review, Service Tier, Signals and Workspace — the last
of which took the largest store in the renderer with it and gave the kits built
on it `provideService`/`useService` instead.

The two artifacts are core (`src/`), which `npm run start:safe` runs alone, and
`@tau/kits` (`kits/`, built into `dist-kits/` by `scripts/build-kits.mjs`).
The distribution has a name, a version of its own and an `engines.api` pinned to
the `EXTENSION_API_VERSION` its kits declare; `dist-kits/manifest.json` carries
all three into the installed app, which has no `kits/` and no toolchain and so
reads kits only from there. Settings → Packages lists them as bundled under that
version, above the packages a source installed.

Completion check: the packaged app runs every kit out of its own archive, and
safe mode is still a usable window. Satisfied 2026-09-06 on a macOS arm64
build launched with an isolated `TAU_USER_DATA` — fifteen kits activated from
inside `app.asar`, a prompt round-tripped, and safe mode came up with none of
them and a working composer.

Deliberately not done: moving `kits/` to a repository of its own. Two artifacts
from one repository first; a `git subtree split` is a governance decision with
its own costs (a second release train, a version matrix between core and kits)
and no forcing need yet.

## Open decisions

These questions are intentionally unresolved:

- Does a thread always map to one Pi session, or can it coordinate several sessions and agents?
- How are project identities preserved when the same repository exists locally, remotely, or in several worktrees?
- Which workbench state belongs to the client, host, project, or extension?
- How much of the desktop extension model should be portable to web and mobile clients, if one is ever built?

Settled since: how packages are distributed. npm and Git are the index, the four verbs of `tau.packages` mirror Pi's CLI, and an optional Ed25519 signature says who built a folder (ADR 0011). A hosted registry, revocation and key rotation stay out. — Which extension code may run in-process and which must be isolated: a package's host half runs in a worker by default (no Electron, a 256 MB heap cap, a plain-data facade); `"isolation": "in-process"` is granted like a permission for the few members — a live Pi runtime, `registerRuntimeExtension`, `registerRuntimeBackend`, `presentUi` and the like — that cannot cross a message port (ADR 0009, 2026-09-05 section). — Whether to build a web or mobile client now: no, see Phase 5.

Record a new ADR when one of these decisions becomes expensive to reverse and has a real alternative.

## Current non-goals

The prototype is not trying to become a full code editor, replace Git tooling, reproduce T3 Code feature for feature, or create a new agent runtime. Those capabilities can arrive through extensions when they improve agent work and justify their maintenance cost.
