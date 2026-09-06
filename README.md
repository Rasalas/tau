# Tau: throwaway Pi desktop prototype

> **PROTOTYPE, not production.** This repository answers one design question: can Pi remain the agent runtime while a desktop shell becomes independently extensible like Neovim?

Tau embeds the real `@earendil-works/pi-coding-agent` SDK in an Electron host. The renderer does not know Pi internals; it receives a small stream of host events. A separate desktop extension registry contributes sidebar modules, project sources, panels, commands, and tool presentation.

## Project documents

- [VISION.md](VISION.md) explains the product goal and guiding principles.
- [CONTEXT.md](CONTEXT.md) defines the product language used in code and discussions.
- [PLAN.md](PLAN.md) records the phased roadmap and open decisions.
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md) records performance budgets and the optimization plan adapted from T3 Code.
- [docs/EXTENSIONS.md](docs/EXTENSIONS.md) is the entry document for writing a Tau package: manifest, permissions, isolation, signing, and the install/approve/reload workflow.
- [ADR 0001](docs/adr/0001-embed-pi-behind-a-desktop-host.md) records why Pi runs behind a desktop host.
- [ADR 0002](docs/adr/0002-core-owns-placement-extensions-own-features.md) records why core owns placement while extensions own features.
- [ADR 0003](docs/adr/0003-core-owns-threads-extensions-own-navigation.md) records why thread semantics stay in core while navigation remains replaceable.
- [ADR 0004](docs/adr/0004-one-pi-runtime-per-thread.md) records why every open thread keeps its own Pi runtime.
- [ADR 0011](docs/adr/0011-extension-distribution.md) records why packages are distributed through npm and Git instead of a registry of Tau's own.
- [ADR 0012](docs/adr/0012-preview-browser.md) records why the preview is a host-owned browser view drawn over the panel.

## Run

```bash
npm install
npm start
```

`npm start` performs the minified production build and opens the Electron app. For development, use `npm run dev` (Electron + Vite hot reload) or `npm run dev:web` (browser fixture preview); `npm run start:existing` opens the last production assets without rebuilding. Build and startup measurements are written to `reports/build-report.json` and `reports/start-report.json`; `npm run build:budget` and `npm run start:budget` enforce the local budgets. It uses your existing `~/.pi/agent` models, credentials, skills and extensions, and the tools of your machine: at startup the main process reads your login shell's environment (PATH, SSH agent, locale, Homebrew variables), so `git`, `claude`, editors and everything Pi's tools call resolve the way they do in a terminal, also after a Dock launch. Claude Code threads run the installed `claude` CLI with its own login and `~/.claude` settings; `TAU_CLAUDE_CODE_COMMAND` names a different executable. When `gh` or `glab` is installed and logged in, the Review's branch scope diffs against the base branch of the current branch's pull or merge request and links to it. The initial workspace is this repository; use the project picker in the left sidebar to open another folder. Recent projects persist in Electron's user-data directory.

For a UI-only browser preview with fixture data:

```bash
npm run dev:web
```

Start without Pi or desktop extensions to inspect or recover the minimal core:

```bash
npm run start:safe
```

The production renderer is minified and does not ship source maps unless `TAU_SOURCEMAP=true` is explicitly set. Review, Settings, optional panels, and Highlight.js languages are demand-loaded; their slots expose a Retry action if a chunk cannot be loaded.

`npm run lint` runs [oxlint](https://oxc.rs/docs/guide/usage/linter.html) over `src/`, `.pi/` and `scripts/` (config in `.oxlintrc.json`: `correctness` and `suspicious` rules as errors, `perf` as warnings). CI (`.github/workflows/ci.yml`) runs lint, typecheck, the full Vitest suite, and a production build on every pull request and push to `main`; `.github/workflows/performance.yml` stays the separate, slower gate for build/startup/renderer budgets.

### Reach the host over a socket

The renderer talks to the host through one versioned protocol (`docs/adr/0010-host-protocol.md`); Electron IPC is one transport of it. Start a host that also listens on a socket with `TAU_HOST_LISTEN=127.0.0.1:7788 npm start`, and point a client at it by opening the workbench with `?host=ws://127.0.0.1:7788&token=<token>`, where the token is the line in `~/.tau/host-token` (created on the first listen, 0o600). A wrong token closes the connection. Encryption is an SSH tunnel's job.

`npm run smoke:remote-host` proves the plumbing without a window: it starts `src/main/headless.ts` in a scratch repository, says hello, fetches the bootstrap, sends a prompt, disconnects, reconnects with `lastSeq` and checks that the pushes missed in between are replayed.

### Run the host on another machine

The host and the window need not be the same machine. The workspace, Pi, the models and every tool stay on the host; the Electron window is only a client of the protocol above.

On the host machine, start a host without a window:

```bash
npm run build
TAU_WORKSPACE=/path/to/project TAU_HOST_LISTEN=127.0.0.1:7788 node dist-electron/main/headless.js
```

It prints the URL it listens on and the path of its token. The socket is unencrypted and repeats that token in every hello, so the host refuses to bind anything but a loopback address; `TAU_HOST_INSECURE=1` overrides that for a network you already trust. Across machines, forward the port over SSH from the client:

```bash
ssh -N -L 7788:127.0.0.1:7788 you@host-machine
```

Then copy the host's `~/.tau/host-token` to the client machine (or pass it as `TAU_HOST_TOKEN`) and start Tau as a client:

```bash
TAU_HOST_URL=ws://127.0.0.1:7788 npm run start:existing
```

The main process starts no `PiHost` and no Pi in that mode: it opens the window, which speaks the protocol over the socket. Everything that needs this machine — the clipboard, image previews, rebuilding the workbench — answers with an `unsupported` error, because the state it would touch lives on the host. Paths in the workbench (the project's `cwd`, changed files, a tool's output) are the host's paths, so an action that hands a path to a local tool points at a directory that exists only there. The socket transport says so by leaving the `local-files` capability out of its hello, which the Electron transport announces.

A dropped link (a suspended machine, a restarted tunnel) is expected: the client reconnects with backoff, says hello again with the sequence it last saw and replays what it missed. A strip above the status line reads `Reconnecting to the host…`, then `Refetching the workbench state…` if the host's buffer no longer reaches back far enough. Nothing has to be restarted by hand.

### Share a live session with Pi

Tau can attach to a Pi TUI that already owns the active session instead of opening a second `SessionManager`. Open Pi in the project first. For an already-running Pi session, run `/reload` once so Pi loads `.pi/extensions/tau-session-bridge.ts`, then start or restart Tau. Prompts, steering, aborts, assistant streaming, tool activity, model changes, thinking changes, compaction, and thread renames travel over an authenticated local socket and remain visible in both clients.

The Pi TUI is the sole writer while attached. Tau will not fall back to writing the same session if the owner is alive but unreachable. It retries a lost socket with bounded backoff and resnapshots automatically after Pi reloads or restarts the bridge. Enter `/reload` in Tau, or run “Apply changes and reload Tau” from the command palette. Tau builds its source, reloads Pi resources and desktop extensions, then restarts itself only when the Electron main process or preload changed. Image prompts, Tau project-shell actions, Tau access-policy changes, new-session creation, and automatic title generation remain Pi-side operations in this mode. Safe mode refuses to attach because it cannot enforce safe-mode tool policy on a runtime owned by another process.

### Extend Tau while it runs

Tau loads desktop extensions the way Pi loads its own. Put a `.tsx` (or `.ts`) file in `~/.tau/extensions/`, or in `<project>/.tau/extensions/` for a project Pi trusts, and run `/reload`. The file default-exports a `DesktopExtension` and may import `react`, `lucide-react` and `tau` (the workbench hooks and types); the host compiles it with esbuild and the renderer binds those imports to its own copies. `examples/desktop-extensions/hello-panel.tsx` is a complete example; `tau.d.ts` next to it gives an editor the types.

An extension with a host half is a package: a folder under one of those two directories with a `tau-extension.json` manifest.

```json
{
  "id": "acme.hello",
  "name": "Hello",
  "version": "1.0.0",
  "engines": { "api": "^1.0.0", "pi": ">=0.84" },
  "permissions": ["workspace:read", "process"],
  "isolation": "worker",
  "source": { "url": "https://github.com/acme/hello", "commit": "0123456789abcdef" },
  "desktop": "./desktop.tsx",
  "host": "./host.ts"
}
```

`id` is shared by both halves (lowercase, dot-separated) and must equal the id the desktop module exports; `desktop` and `host` are relative entry paths, either may be omitted. `isolation` is `worker` (the default) or `in-process`, see below. `version` is the package's own semver. `engines` names the ranges of `tau` (the app version), `pi` (the bundled Pi) and `api` (the contribution interfaces, `EXTENSION_API_VERSION` in `src/shared/extension-compat.ts`) the package runs on; ranges take `*`, `1.2.3`, `^1.2.0`, `~1.2.0`, `>=1 <2` and `||`. A package whose engines do not fit stays off on both sides and is listed with the reason in the Inspector. Both fields are optional; while Tau's own version is `0.0.0`, pin `api` rather than `tau`.

#### Install a package

Tau installs packages the way Pi does. `tau.packages`, a bundled host extension, takes three kinds of source:

```
/install npm:@acme/hello          # the machine's own npm, into ~/.tau/npm
/install git:https://example.com/acme/hello.git   # a shallow clone into ~/.tau/git
/install ./extensions/hello -l    # a folder, loaded where it lies; -l is this project only
/update                           # every installed source, or name one
/remove npm:@acme/hello
```

The same four verbs sit in Settings → Packages, with a source field, a global/project switch, the progress lines of the running job, and Update and Remove per package. `install` and `update` are long commands, so they run as host jobs and never block the rest of the workbench.

The list of sources is `~/.tau/packages.json` for every project, `<project>/.tau/packages.json` for one (Pi's `-l`), both `{ "version": 1, "packages": ["npm:@acme/hello", "git:https://…", "/path/to/folder"] }`. npm sources need `npm` on the login shell's PATH; Tau bundles no npm client. A project's list loads only where Pi trusts the project. Nothing is copied for a folder source, so `/install ./my-extension` is also the way to develop one.

An install never starts a package: the grant flow below still asks. An update that keeps the same permissions keeps the grant; `/reload` picks the new code up.

#### Sign a package

A package may carry a `tau-extension.sig` beside its manifest:

```json
{
  "publisher": "acme",
  "algorithm": "ed25519",
  "signature": "<base64>",
  "files": { "tau-extension.json": "<sha256>", "host.ts": "<sha256>" }
}
```

`files` covers every file of the folder except `.git` and the signature itself, and the signature is over the canonical JSON of `{ files, id, version }`. A publisher makes a key with `node scripts/keygen-extension.mjs acme ~/keys` and signs with `node scripts/sign-extension.mjs ./hello ~/keys/acme.private.pem acme`; a user trusts the key by putting it in `~/.tau/trusted-publishers.json`:

```json
{ "version": 1, "publishers": [{ "id": "acme", "name": "ACME", "key": "-----BEGIN PUBLIC KEY-----…" }] }
```

Settings then shows the package as *signed by ACME*. An unsigned package installs and says **unsigned**; one signed by a key nobody trusts installs and says **signature not trusted**. A file whose hash no longer matches the signature refuses to load at all, with the offending path in the error — that check runs before the key is looked up, so it holds for untrusted publishers too. `npm run smoke:extension-install` drives the whole path: keygen, sign, install from a folder and from a Git source into a temp home, list, tamper, refuse.

Tau hosts no registry: npm and Git are the index, and there is no revocation list beyond removing a key.

#### Permissions, provenance and isolation

A package names the capabilities it wants in `permissions`, from a fixed vocabulary: `workspace:read` (project paths and file contents), `workspace:write` (change files, write Git), `workspace:switch` (open or pick another project), `sessions` (session files, threads, transcript entries), `runtime:extend` (register runtimes, runtime extensions and permission levels), `process` (child processes and command lookup) and `network`. Reaching a host service the package did not ask for throws and is logged as `host-extension.denied`. A package without the field asks for nothing; a bundled kit keeps the full facade.

A package Tau has not seen before, or one whose permission list changed, does not start. It appears in Settings as waiting for approval with the list it asks for; **Allow** writes the grant to `~/.tau/extension-grants.json` and starts both halves, **Deny** leaves it off. The grant survives a restart, and it applies to `~/.tau/extensions` exactly as it applies to `<project>/.tau/extensions` — Pi's project trust only decides whether a project's folder is read at all. Until a package is approved its host entry is not even compiled, so none of its code runs.

`source: { url, commit? }` records where a package came from and is shown in Settings → Inspector. It proves nothing on its own; a `tau-extension.sig` from a publisher you trust does.

The host half of a package runs in a worker thread by default. Its bundle is loaded there, not in the main process, so no line of it — not even its top-level code — runs beside the workbench. The worker has a 256 MB heap cap, no Electron (`import "electron"` throws with the reason), and reaches the host only through a message port: `context.registerCommand`, `context.emit` and a `services` facade whose members are all asynchronous and carry plain data. It offers `cwd`, `log`, `openWorkspace`, `knownWorkspacePath`, `pickDirectory`, `projectName`, `rememberProjectName`, `describeProjects`, `runtimeOwner`, `thread` (a snapshot), `transcript`, `setThreadTitle`, `noteSubprocess`, `findCommand`, `sessions.list`, `sessions.read`, `sessions.exclusive`, `registerThreadLifecycle`, `registerTurnObserver`, `setPendingWork` and `pinTranscriptEntries`. It does not offer what would hand out a live object: `registerRuntimeBackend`, `registerRuntimeExtension`, `decorateUiPrompt`, `setPermissionLevel`, `presentUi`, `attachedRuntime`, `sessions.open` and `sessions.prepare`. A package that needs one of those declares `"isolation": "in-process"`, which the approval box lists like a permission ("runs inside the host process") and the grant records — flipping it later asks the user again. `examples/desktop-extensions/hello-host.ts` is a worker host half to copy. The worker entry itself ships as one CommonJS bundle, `dist-electron/main/host-extension-worker.cjs`, written by `scripts/build-host-worker.mjs`.

Permission checks stay in the main process, on the facade the worker's calls are dispatched into, so isolation adds no way around a grant. A worker that throws, exits, exceeds its heap or does not answer a command within the timeout is terminated: the package is deactivated with the reason on its settings page, and the workbench keeps running. A synchronous infinite loop in a packaged command is survivable for the same reason.

A desktop half cannot reach the core IPC surface: `window.tau` is replaced with `undefined` while the bundle is built, and `globalThis.__tauShared` is the only bridge. The compiled bundle is served by the main process under `tau-ext://bundles/<id>/<hash>.js` and imported from there, which is why the page's CSP allows `tau-ext:` and no longer allows `blob:`. A host command that runs longer than 30 s, or fails three times in a row, deactivates the package. Every slot a package renders sits behind an error boundary that deactivates the package and shows a toast rather than taking the workbench down. See [ADR 0009](docs/adr/0009-extension-permissions.md) for what this does not protect against.

Settings → Inspector shows every extension both halves know (desktop registry, host registry, commands, isolation, activation failures), the package folders on disk with their versions, engines, permissions, isolation and source provenance, and the three versions the check runs against. The desktop entry is loaded like a plain desktop extension. The host entry is compiled with esbuild (Node builtins and Electron stay external, everything else is bundled) and its default export, a `HostExtension` (`{ id?, name?, activate(context) }`) or a factory returning one, is activated in the package's worker — or in the main process for an approved `in-process` package, where `context.services` is the same facade the bundled kits use (see `docs/adr/0006-host-extensions-own-host-features.md`). `context.registerCommand` and `context.emit` reach the desktop half through `context.host` either way. Packages are synced when Tau starts, when the project changes and on `/reload`, so installing, updating or removing a folder never needs a rebuild. A project's packages load only where Pi trusts the project; an activation failure is shown on the extension's settings page, not thrown. The settings toggle of a package turns both halves off and on.

Tau's own source can be changed from inside Tau too. `/reload` is the single apply-changes command for Tau source, Pi resources and desktop extensions. If threads are still running, Tau offers to wait or stop them first. It reloads the renderer after a successful build, or relaunches the app when the main process or preload changed.

## Prototype surface

- real Pi SDK session with streamed text, thinking and tool events
- recent Pi threads across projects, including project identity, the Git branch Workspace Kit supplies, live activity, and a settled shelf
- searchable recent-project modal (`Cmd/Ctrl+P`) and extension-provided add-project sources
- working local-folder and Git-clone project flows, plus thread search (`/`)
- file index marked with the working tree's changes, and a Signals event stream
- full-window diff review (`Cmd/Ctrl+Shift+D`) with unified and split views, driven by a real `git diff`
- commit and push from the review, with the message editable before it runs
- composer-level model, thinking and access controls, plus a context dial wired to Pi's own usage and manual compaction
- composer autocomplete for Pi skills, prompt templates, and extension commands; skills are searchable as `$skill` or `/skill`, and the selected runtime adapter resolves the shorthand to its supported invocation form when sent
- `TAU_RUNTIME_ADAPTER=pi` (default) keeps the embedded Pi runtime; `TAU_RUNTIME_ADAPTER=claude-code` gives new threads the Claude Code backend, which the bundled `tau.claude-code` host extension registers (a name without a registered extension stops the start with an error dialog).
- model picker with provider tabs, cross-provider search and favourites
- clickable workspace bar under the composer: switch between the checkout and its worktrees, create a worktree for a new branch, and pick a ref from a searchable list
- enforced access levels: Tau's inline Pi extension gates workspace mutations and computer-control actions; read-only threads retain inspection tools, while ask-before-edits requires approval before clicks, typing, launches, shell commands, and file changes
- a Preview panel (`/preview <url>`, `Cmd/Ctrl+Shift+B`) showing a real browser view the host draws over the dock, and `preview_open/navigate/status/snapshot/screenshot/click/type/press/scroll/evaluate/wait_for` tools so the agent can read and drive the page it just changed
- built-in cross-platform computer use through `@amaster.ai/pi-computer-use` (Apache-2.0) and its bundled Cua Driver assets; safe mode excludes it, and an explicitly configured Pi package wins over Tau's bundled registration
- grouped command palette (`Cmd/Ctrl+K`) with arrow-key navigation, attributing every command to the extension that contributed it
- one settings page: workbench defaults, keybindings, and a click-through list of extensions rendered from the options each one declares
- Markdown rendering of messages — GFM tables, task lists, inline code, and syntax-highlighted code blocks with copy, all styled on the workbench palette; raw HTML is deliberately not enabled
- extension-provided tool renderers for reads, writes and shell commands
- thread title generation using the thread's own model, automatic after the first prompt and manual on demand
- extension-free safe mode with empty layout slots collapsed

## The seam under test

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

Every contribution is stamped with the extension that supplied it, which is what lets the palette, panel headers and settings page attribute behaviour back to its source. `registerOptions` is the whole of the settings surface: an extension declares toggles and chip rows, and Tau renders the page from that declaration — an extension with no options shows only its on/off switch.

See `src/renderer/extension-system.tsx` and `src/renderer/extensions/index.tsx`. The left sidebar and right dock are empty core slots. Workspace Kit contributes the thread and project sidebar, local-folder and Git-clone sources, and Files. Review Kit contributes Changes and the diff review. Other bundled extensions contribute Signals, thread title generation, and the runtime commands.

## Deliberately missing

This prototype does not yet prove dynamic third-party package loading, extension UI dialogs, session tree navigation, editor/file mutation UI, mobile rendering or secure remote access. Those should only be built if the host/UI seam feels right in use.
