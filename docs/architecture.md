# Architecture

Tau started from one design question: can Pi remain the agent runtime while a desktop shell becomes independently extensible, the way Neovim is?

Tau embeds the real `@earendil-works/pi-coding-agent` SDK in an Electron host. The renderer does not know Pi internals; it receives a small stream of host events. A separate desktop extension registry contributes sidebar modules, project sources, panels, commands, and tool presentation.

## Core and kits

Tau is two artifacts built from one repository.

**Core** (`src/`) is Pi in a window plus threads: the transcript, the composer,
the thread index and one runtime per open thread, the command palette and the
two layout slots, the extension lifecycle on both sides, and one versioned
protocol between the window and the host. [Core and kits](CORE.md) is the
full list, and `npm run start:safe` runs exactly it: a usable window with no
sidebar, no Git, no diff review and no package manager.

**`@tau/kits`** (`kits/`) is the distribution on top: Workspace Kit (the thread
rail, projects, Files, Changes, worktrees, checkpoints), Review Kit, Agents,
Preview, Claude Code, Antigravity, Codex, Computer Use, Signals, Access, Keybindings, Packages,
Pi UI, Questionnaires, Service Tier, Thread Titles and Worktree Names. Each is
a package with its own `tau-extension.json`, permissions and build; `npm run
build` compiles them into `dist-kits/`, which is what an installer ships and
what Settings → Packages lists as bundled, headed by the version in
`kits/package.json`.

Neither half reaches into the other. A kit sees core through `tau`,
`tau/host-extension` and `tau/host` (the three modules any package gets), and
core never imports a kit; it loads them from disk the way it loads what you
installed yourself. Shipping a kit is the only thing that sets it apart: no
permission prompt, and `in-process` isolation without being asked for
([ADR 0014](adr/0014-bundled-kits-are-packages.md)).

**Ship your own.** Nothing about `@tau/kits` is privileged. Assemble the
packages you want, publish them to npm or Git, and a user installs them with
`/install` and approves their permissions once
([Writing a package](EXTENSIONS.md)); they run beside Tau's kits, or
instead of the ones switched off in Settings. A build of your own is the other
road: `dist-kits/` is a plain folder of built packages, so a fork that replaces
it ships a different product on the same core, and
[ADR 0015](adr/0015-core-and-distribution.md) draws the line between what
core owns and what a distribution owns. Safe mode is neither: it is
recovery, and loads no extension at all. The kits are Tau's opinion about what
a coding workbench should have, not a floor you build on.

## The window and the host

Tau runs as two processes. The **host** owns the threads: Pi, the runtimes, the
host halves of the kits, the session files. The **window** is a client of it
(Electron, the workbench, the kits' desktop halves), and it is the one that
starts and watches the host ([ADR 0021](adr/0021-host-runs-in-its-own-process.md)).

On start the window reads `<userData>/host.json`. If the host it names is still
alive and built from this version, the window connects to it and finds its
threads where they were; otherwise it starts `dist-electron/main/headless.js`
with Electron's own binary in Node mode, on a loopback socket with the token in
`~/.tau/host-token`, and records the new `host.json`. A host that crashes is
restarted (at most three times a minute, then a dialog with the log path);
`<userData>/logs/host-out-*.log` holds what it printed, `host-process.log` what
it logged.

One data folder has one host. A host holds `<userData>/host.lock` for as long
as it runs (an OS lock that goes with the process, however it ends), and a
second host started on the same folder leaves with exit code 75, naming the
first. A window that finds a host holding the folder without answering starts
no second one beside it; after 30 seconds it says which process owns the
folder. Pi sessions are guarded the same way across data folders: a thread
another Tau host on this machine writes opens read-only (`<session>.jsonl.lock`),
and deleting, restoring, purging or importing it is refused with the holder's
pid and data folder. Tau reads a session another process writes without Pi's
repairs on open. `pi` typed in Tau's terminal (zsh, bash, fish) loads Tau's lock
extension (`pi -e $TAU_PI_SESSION_LOCK_EXTENSION`): that Pi holds the lock of the
session it has open, so Tau shows the thread read-only while Pi has it, and Pi
does not open a session a Tau host holds. A Pi started outside Tau knows nothing
of the lock unless it is started with that flag; Tau does not change your Pi
setup to add it.

What follows from that:

- **Closing the window does not stop a turn.** The host keeps working, on every
  platform; the next window picks the threads up again, and starting Tau while
  it has no window opens one.
- **Quitting stops the host**, unless *Settings → General → "Keep the host
  running in the background"* is on, in which case it keeps going and the next
  start adopts it, or the host runs as a [system service](hosts.md#run-the-host-as-a-system-service), which a
  window never stops.
- **The window still owns its own machine.** The clipboard, image previews and
  the workbench rebuild are answered in the window process, not in the host;
  everything else is one call over the protocol.
- `TAU_HOST_INPROCESS=1` runs the old shape (host inside the window's process)
  for one release cycle, if something in the new one gets in your way.

[Hosts, machines and devices](hosts.md) covers the host as a service, on another machine, and for a browser or a phone.

## The extension seam

```text
Electron renderer                    Node host
┌──────────────────────────┐         ┌────────────────────────────┐
│ minimal workbench shell  │ events  │ Pi AgentSession SDK        │
│ + desktop extensions     │◄────────│ skills + Pi extensions     │
│ panels / commands / UI   │────────►│ tools / models / sessions  │
└──────────────────────────┘ commands└────────────────────────────┘
```

Desktop extensions implement one small interface:

```ts
interface DesktopExtension {
  id: string;
  name: string;
  activate(context: DesktopExtensionContext): void | (() => void);
}
```

The context accepts these contribution types:

```ts
context.registerPanel(...);
context.registerSidebar(...);
context.registerProjectSource(...);
context.registerCommand(...);
context.registerSlashCommand(...);   // `/name` in the composer, run in the workbench
context.registerKeybinding(...);     // "mod+k", "ctrl+shift+p", "escape" → a command id
context.registerPromptRenderer(...); // draws Pi dialogs it recognises, e.g. by a marker in `prompt.extras`
context.registerPromptHook(...);
context.registerToolRenderer(...);
context.registerOptions(...);
context.registerRegion(...);
context.registerStatusItem(...);
context.registerOverlay(...);
context.registerComposerControl(...);
context.registerTranscriptRows(...);
context.registerDocumentSource(...);
```

Every contribution is stamped with the extension that supplied it, which is what lets the palette, panel headers and settings page attribute behaviour back to its source. `registerOptions` is the whole of the settings surface: an extension declares toggles and chip rows, and Tau renders the page from that declaration. An extension with no options shows only its on/off switch.

See `src/renderer/extension-system.tsx` and the kits under `kits/` ([Core and kits](CORE.md) lists what each one owns). The left sidebar and right dock are empty core slots. Workspace Kit contributes the thread and project sidebar, local-folder and Git-clone sources, and Files. Review Kit contributes Changes and the diff review. Other bundled kits contribute Signals, thread title generation, and the runtime commands.

## Extending Tau while it runs

[Writing a package](EXTENSIONS.md) is the full reference. `tau kit new my-kit` writes a package to start from, with types for your editor; [Your first package](EXTENSIONS.md#your-first-package) has the five steps from there to a package you use. The rest of this section is the overview, with links to the details.

Tau loads desktop extensions the way Pi loads its own. Put a `.tsx` (or `.ts`) file in `~/.tau/extensions/`, or in `<project>/.tau/extensions/` for a project Pi trusts, and save it. The file default-exports a `DesktopExtension` and may import `react`, `lucide-react` and `tau` (the workbench hooks and types); the host compiles it with esbuild and the renderer binds those imports to its own copies. `examples/desktop-extensions/hello-panel.tsx` is a complete example; `tau kit types` gives a folder the types Tau ships ([Types for a package of your own](EXTENSIONS.md#types-for-a-package-of-your-own)).

An extension with a host half is a package: a folder under one of those two directories with a `tau-extension.json` manifest ([The manifest](EXTENSIONS.md#the-manifest)).

- **Edit, save, see it.** Tau watches the files it reads and reloads only what changed: one package, one theme, the keybindings, the config. A save that does not compile changes nothing. [The development loop](EXTENSIONS.md#the-development-loop) has the table of what reloads how, and how to turn watching off.
- **Install.** `/install`, `/update` and `/remove` take npm, Git and folder sources, and Settings → Packages offers the same ([The workflow](EXTENSIONS.md#3-the-workflow)). npm sources need `npm` on the login shell's PATH; Tau bundles no npm client. An install never starts a package: the grant flow still asks. An update that keeps the same permissions keeps the grant, and the new code is picked up as soon as it lands.
- **Sign.** A package may carry a `tau-extension.sig` beside its manifest, and a user trusts a publisher's key in `~/.tau/trusted-publishers.json` ([Signing](EXTENSIONS.md#4-signing)). Tau hosts no registry: npm and Git are the index, and there is no revocation list beyond removing a key ([ADR 0011](adr/0011-extension-distribution.md)).
- **Permissions.** A package names the capabilities it wants from a fixed vocabulary ([Permissions vocabulary](EXTENSIONS.md#permissions-vocabulary)). A package Tau has not seen before, or one whose permission list changed, waits in Settings → Extensions until you allow it; until then its host entry is not even compiled.
- **Isolation.** The host half of a package runs in a worker thread by default, with capped memory, no Electron, and a facade of plain-data services; a package that needs a live object declares `"isolation": "in-process"`, which is approved like a permission ([What an isolated package cannot use](EXTENSIONS.md#6-what-an-isolated-worker-package-cannot-use), [Failure model](EXTENSIONS.md#5-failure-model)). The worker entry itself ships as one CommonJS bundle, `dist-electron/main/host-extension-worker.cjs`, written by `scripts/build-host-worker.mjs`.

A desktop half cannot reach the core IPC surface: `window.tau` is replaced with `undefined` while the bundle is built, and `globalThis.__tauShared` is the only bridge. The compiled bundle is served by the main process under `tau-ext://bundles/<id>/<hash>.js` and imported from there, which is why the page's CSP allows `tau-ext:` and no longer allows `blob:`. A host command that runs longer than 30 s, or fails three times in a row, deactivates the package. Every slot a package renders sits behind an error boundary that deactivates the package and shows a toast rather than taking the workbench down. See [ADR 0009](adr/0009-extension-permissions.md) for what this does not protect against.

Settings → Inspector shows every extension both halves know (desktop registry, host registry, commands, isolation, activation failures), the package folders on disk with their versions, engines, permissions, isolation and source provenance, and the three versions the check runs against. The desktop entry is loaded like a plain desktop extension. The host entry is compiled with esbuild (Node builtins and Electron stay external, everything else is bundled) and its default export, a `HostExtension` (`{ id?, name?, activate(context) }`) or a factory returning one, is activated in the package's worker, or in the main process for an approved `in-process` package, where `context.services` is the same facade the bundled kits use ([ADR 0006](adr/0006-host-extensions-own-host-features.md)). `context.registerCommand` and `context.emit` reach the desktop half through `context.host` either way. Packages are synced when Tau starts, when the project changes, when a watched file under one of them changes and on `/reload`, so installing, updating or removing a folder never needs a rebuild. A project's packages load only where Pi trusts the project; an activation failure is shown on the extension's settings page, not thrown. The settings toggle of a package turns both halves off and on.

Tau's own source can be changed from inside Tau too: [Make a change](site/make-a-change.md#from-inside-the-installed-app).
