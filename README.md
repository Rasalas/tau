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
- [docs/RELEASE.md](docs/RELEASE.md) explains how a release is cut, how updates reach users, and how signing is enabled.

Notes and research, not kept current:

- [docs/opencode-diff-viewer-lessons.md](docs/opencode-diff-viewer-lessons.md) inspects OpenCode's two diff-review layouts.
- [docs/research/pi-remote-session.md](docs/research/pi-remote-session.md) decides whether Tau should attach to Pi through Pi's own client instead of the session bridge.
- [docs/research/model-provider-icons.md](docs/research/model-provider-icons.md) recommends a source for model-provider icons.

## Core and kits

Tau is two artifacts built from one repository.

**Core** (`src/`) is Pi in a window plus threads: the transcript, the composer,
the thread index and one runtime per open thread, the command palette and the
two layout slots, the extension lifecycle on both sides, and one versioned
protocol between the window and the host. [docs/CORE.md](docs/CORE.md) is the
full list, and `npm run start:safe` runs exactly it — a usable window with no
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
`tau/host-extension` and `tau/host` — the three modules any package gets — and
core never imports a kit; it loads them from disk the way it loads what you
installed yourself. Shipping a kit is the only thing that sets it apart: no
permission prompt, and `in-process` isolation without being asked for
([ADR 0014](docs/adr/0014-bundled-kits-are-packages.md)).

**Ship your own.** Nothing about `@tau/kits` is privileged. Assemble the
packages you want, publish them to npm or Git, and a user installs them with
`/install` and approves their permissions once
([docs/EXTENSIONS.md](docs/EXTENSIONS.md)); they run beside Tau's kits, or
instead of the ones switched off in Settings. A build of your own is the other
road: `dist-kits/` is a plain folder of built packages, so a fork that replaces
it ships a different product on the same core, and
[ADR 0015](docs/adr/0015-core-and-distribution.md) draws the line between what
core owns and what a distribution owns. Safe mode is neither — it is
recovery, and loads no extension at all. The kits are Tau's opinion about what
a coding workbench should have, not a floor you build on.

## Architecture: the window and the host

Tau runs as two processes. The **host** owns the threads: Pi, the runtimes, the
host halves of the kits, the session files. The **window** is a client of it —
Electron, the workbench, the kits' desktop halves — and it is the one that
starts and watches the host ([ADR 0021](docs/adr/0021-host-runs-in-its-own-process.md)).

On start the window reads `<userData>/host.json`. If the host it names is still
alive and built from this version, the window connects to it and finds its
threads where they were; otherwise it starts `dist-electron/main/headless.js`
with Electron's own binary in Node mode, on a loopback socket with the token in
`~/.tau/host-token`, and records the new `host.json`. A host that crashes is
restarted (at most three times a minute, then a dialog with the log path);
`<userData>/logs/host-out-*.log` holds what it printed, `host-process.log` what
it logged.

What follows from that:

- **Closing the window does not stop a turn.** The host keeps working, on every
  platform; the next window picks the threads up again, and starting Tau while
  it has no window opens one.
- **Quitting stops the host** — unless *Settings → Defaults → "Keep the host
  running in the background"* is on, in which case it keeps going and the next
  start adopts it, or the host runs as a system service (below), which a
  window never stops.
- **The window still owns its own machine.** The clipboard, image previews and
  the workbench rebuild are answered in the window process, not in the host;
  everything else is one call over the protocol.
- `TAU_HOST_INPROCESS=1` runs the old shape (host inside the window's process)
  for one release cycle, if something in the new one gets in your way.

## Install

Download the newest build for your platform from the
[releases page](https://github.com/Rasalas/tau/releases): a `.dmg` or `.zip` on
macOS (arm64 and x64), an `.AppImage` on Linux, an NSIS installer on Windows.
The builds are unsigned, so the first launch needs the usual confirmation —
open the app from Finder's context menu once on macOS, and tell Windows
SmartScreen to run it anyway.

Once the repository is public, the package managers carry it too:
`brew install --cask rasalas/tau/tau` on macOS, `winget install Rasalas.Tau` on
Windows, `yay -S tau-bin` (or any AUR helper) on Arch Linux. How each is
published is in [docs/RELEASE.md](docs/RELEASE.md#package-managers).

An installed Tau checks for a newer release shortly after it starts, downloads
one in the background, and offers a restart that installs it; "Check for
updates…" in the application menu asks on demand. Settings → Defaults →
Update track switches between stable releases and the nightly build of `main`.

To build an installer yourself:

```bash
npm install
npm run dist          # this machine's platform; also dist:mac, dist:linux, dist:win
```

The artifacts land in `release/`.

## Run

```bash
npm install
npm start
```

`npm start` performs the minified production build and opens the Electron app. For development, use `npm run dev` (Electron + Vite hot reload) or `npm run dev:web` (browser fixture preview); `npm run start:existing` opens the last production assets without rebuilding. Build and startup measurements are written to `reports/build-report.json` and `reports/start-report.json`; `npm run build:budget` and `npm run start:budget` enforce the local budgets. It uses your existing `~/.pi/agent` models, credentials, skills and extensions, and the tools of your machine (a model behind a subscription login Pi performs is marked in the picker; where the vendor allows that login only in its own apps — Anthropic, Google — the Subscription Login Warning kit asks once before its first use): at startup the main process reads your login shell's environment (PATH, SSH agent, locale, Homebrew variables), so `git`, `claude`, editors and everything Pi's tools call resolve the way they do in a terminal, also after a Dock launch. Claude Code threads drive the installed `claude` CLI through the Claude Agent SDK, with its own login (a Claude subscription's Agent SDK credit, or an API key) and `~/.claude` settings; a different executable is set on its card under Settings → Providers (or with `TAU_CLAUDE_CODE_COMMAND`, which wins). Antigravity threads drive Google's Antigravity agent through the Agent Client Protocol: Tau downloads Google's ACP server once into its own state folder (from the official registry URL, verified by size and SHA-256) or uses a server of your own named on its Providers card (or by `TAU_ANTIGRAVITY_ACP_COMMAND`), and the sign-in with your Google account happens inside that server, in your browser; Tau never sees the token. Its card under Settings → Providers installs or updates that server, shows the account and signs out. The agent runs with a Gemini home of Tau's own, so it writes nothing into yours, but your `~/.gemini` skills are linked into it and your MCP servers are passed to it. Codex threads drive the installed `codex` CLI through its app server (`codex app-server`), signed in the way the CLI is — `codex login` with your ChatGPT plan, or an API key — with your `~/.codex` (or `CODEX_HOME`) sessions and config; Tau reads no credential; a different executable is set on its card under Settings → Providers (or with `TAU_CODEX_COMMAND`). Codex's approval requests appear in the thread like any other question, and Tau's access levels become Codex's sandbox and approval policy. For Claude Code and Codex, the picker's runtime tab and Settings → Defaults say when npm has a newer release of the CLI than the one installed, with the command that updates it; for Antigravity, when Tau pins a newer server than it installed. Which runtime a new thread gets is chosen in the composer before its first message, or in Settings → Defaults; a thread keeps its runtime for life. When `gh` or `glab` is installed and logged in, the Review's branch scope diffs against the base branch of the current branch's pull or merge request and links to it; the Changes panel then commits, pushes and opens that request (title and description written by the commit-message model, filled into the repository's template, optionally as a draft), edits and merges it, and the thread's rail row shows its state and checks. Without the CLI, its login or a remote, the panel says which one is missing. Forgejo and Gitea (through `tea`, signed in with `tea login add`), Bitbucket Cloud (with an API token Git's credential helper holds for `api.bitbucket.org`) and Azure DevOps (through `az` with its DevOps extension) open, edit, merge and review requests the same way, as far as each host's tools reach; what one cannot do is hidden rather than offered. Settings → Review lists which of them this machine can reach and lets you name the provider of a self-hosted server whose host name does not say. The initial workspace is this repository; use the project picker in the left sidebar to open another folder. Recent projects persist in Electron's user-data directory.

For a UI-only browser preview with fixture data:

```bash
npm run dev:web
```

Start without Pi or desktop extensions to inspect or recover the minimal core:

```bash
npm run start:safe
```

The production renderer is minified and does not ship source maps unless `TAU_SOURCEMAP=true` is explicitly set. Review, Settings, optional panels, and Highlight.js languages are demand-loaded; their slots expose a Retry action if a chunk cannot be loaded.

`npm run lint` runs [oxlint](https://oxc.rs/docs/guide/usage/linter.html) over the whole repository except `dist/`, `dist-electron/` and `node_modules/` (config in `.oxlintrc.json`: `correctness` and `suspicious` rules as errors, `perf` as warnings); an override turns `no-await-in-loop` and `no-map-spread` off under `kits/`, `scripts/`, `src/main/` and `.pi/`, where sequential awaits and immutable per-element updates are the point, and keeps both on elsewhere. CI (`.github/workflows/ci.yml`) runs lint, typecheck, the full Vitest suite, and a production build on every pull request and push to `main`; `.github/workflows/performance.yml` stays the separate, slower gate for build/startup/renderer budgets, and `.github/workflows/release.yml` builds and publishes the artifacts of a `v*.*.*` tag ([docs/RELEASE.md](docs/RELEASE.md)).

### Windows

Tau builds for Windows and the host has a Windows path wherever it assumed a
POSIX system: PATH comes from the registry instead of a login shell, commands
resolve through PATHEXT, `.cmd` shims start through `cmd.exe`, process trees end
with `taskkill`, the terminal opens PowerShell. Nobody has used it on Windows
yet; what is verified by tests only and what is known not to work is in
[docs/windows.md](docs/windows.md), with how to try it. Pi needs Git for Windows
there (its `bash` tool runs Git Bash).

### Open a folder from a terminal

`tau app [path]` opens a folder in the Tau that is running — the current
directory without a path — with a new thread's draft on screen, and brings the
window to the front, the way `t3 app` does for T3 Code. It finds the host
through `<userData>/host.json` and speaks to it with the host's own token;
`TAU_USER_DATA` points it at another instance, as it does for the app. Without
a running Tau it starts the app on that folder. The command is `bin/tau.mjs`
(`bin` in `package.json`) and needs Node 22 or newer. Nothing puts it on your
`PATH` for you; link it yourself:

```bash
# a checkout
ln -s "$PWD/bin/tau.mjs" ~/.local/bin/tau
# an installed Tau on macOS (npm run install:mac prints this line)
ln -s /Applications/Tau.app/Contents/Resources/app.asar.unpacked/bin/tau.mjs ~/.local/bin/tau
```

`npm run smoke:cli-app` (after `npm run build`) drives it against a headless
host in temp folders.

### Run the host as a system service

The host can run as a service of the machine, so threads, terminals and paired
devices keep working with no Tau window open and after a restart of the
machine. Install it in *Settings → Connections → Background*, or from a
terminal:

| Task | Command |
|---|---|
| Install and start (again: repair) | `tau service install` |
| Where it stands, and its log | `tau service status` |
| Restart it | `tau service restart` |
| Stop it and remove it from login | `tau service uninstall` |

- **macOS:** a LaunchAgent, `~/Library/LaunchAgents/dev.tbuck.tau.host.plist`.
  It starts when you log in and stops when you log out; keep the Mac logged in
  (and, for a phone, awake) for access from elsewhere. Tau must run from
  Applications, not from the Downloads folder macOS starts it from.
- **Linux:** a systemd user unit, `~/.config/systemd/user/tau-host.service`.
  Installing turns on lingering (`loginctl enable-linger`) so it starts at
  boot and outlives your session; where that needs an administrator, the
  status says so with the command. An AppImage cannot run as a service.
- **Windows:** a Task Scheduler task, "Tau Host", that runs at your logon.

The service runs the app's own binary on the app's own userData, so a Tau
window adopts the host it finds in `host.json` like any other and never starts
a second one; quitting the window leaves it running. Installing from a window
moves that window's threads into the service host, on the same port. An
instance with its own `TAU_USER_DATA` gets a service of its own (a suffix on
the names). Network access (Settings → Connections) lives in
`<userData>/network.json`, so the service host opens the same Local network,
Tailscale and proxy listeners, on the same ports, once it has taken over.
Uninstalling leaves threads and settings where they are.

After an update the window finds the service on the old version and restarts
it once; if the unit points at another copy of Tau, it rewrites the unit for
this one and restarts it once more. A service that still answers with another
version is stopped, and the window runs its own host until the next start.
The unit restarts a host only after a crash (`KeepAlive.SuccessfulExit` false,
`Restart=on-failure`), so a window stopping it never starts a loop.

*Keep this machine awake while turns run*, beside it, holds off sleep while
any thread works: `caffeinate` on macOS, `systemd-inhibit` on Linux,
`SetThreadExecutionState` on Windows. It applies to a host in its own process,
service or not.

### First start

A Tau without a single thread opens its welcome wizard (Onboarding,
`kits/onboarding/`); `/welcome`, or "Set up Tau…" in the palette, opens it again
later. Its three steps follow T3 Code's:

1. **Agents** — Pi and how many models your Pi configuration signs in to, then
   every other runtime Tau has (the Agent SDK runtime, Codex, Antigravity, and
   any instance of them): installed or not, which version, signed in or not,
   with the vendor's install or sign-in command, or a link to its card
   under Settings → Providers. Each runtime answers through its own kit, so a
   path set there counts. Below them, marked optional, **Tools for pull
   requests**: `gh` and `glab`, which Tau needs only to open pull and merge
   requests and show their checks. With Terminal Kit on, Install and Sign in
   run the command in a terminal you see: the wizard steps aside for it (a
   button in the title bar leads back), and returns and checks again when the
   shell ends; without it the command is there to copy.
2. **Projects** — the folders those CLIs and Pi worked in, newest first, each
   with the conversations it has and when it was last used. Clones of one
   repository (the same `origin`) are one group with a checkbox for all of
   them; folders that are no repository are folded away under "Other folders".
   Linked worktrees, your home and temporary folders themselves, and anything
   in `~/Downloads`, Codex's scratch folders under `~/Documents/Codex` or Tau's
   worktrees folder are left out. Git repositories used in the last 30 days
   with three conversations or more are chosen for you; "Add a folder…" opens
   the project sources.
3. **Conversations** — the conversations those CLIs kept, grouped by folder,
   imported as threads of the runtime that ran them: the title and the visible
   text (the first prompt and the newest messages, 200 at most), no tool
   activity and no attachments. A thread continues by resuming the CLI's own
   session. Importing again skips what Tau already holds.

Each CLI's history is read from its own home (its config directory, or
`CODEX_HOME` for Codex), newest 500 sessions, files up to 16 MiB. Set
`TAU_IMPORT_ROOTS` to one or more directories laid out as
`<dir>/<backend kind>/…`, like the CLI's own home, and nothing else is read —
the dev instance sets it to `.tau-dev/import-roots`.

### Reach the host over a socket

The renderer talks to the host through one versioned protocol (`docs/adr/0010-host-protocol.md`); Electron IPC is one transport of it. Start a host that also listens on a socket with `TAU_HOST_LISTEN=127.0.0.1:7788 npm start`, and point a client at it by opening the workbench with `?host=ws://127.0.0.1:7788&token=<token>`, where the token is the line in `~/.tau/host-token` (created on the first listen, 0o600). A wrong token closes the connection. Encryption is TLS's job (`TAU_HOST_TLS=1`, below) or an SSH tunnel's.

`npm run smoke:remote-host` proves the plumbing without a window: it starts `src/main/headless.ts` in a scratch repository, says hello, fetches the bootstrap, sends a prompt, disconnects, reconnects with `lastSeq` and checks that the pushes missed in between are replayed. It runs twice: in plaintext, and over TLS with the printed fingerprint pinned, where a wrong fingerprint and a plaintext socket must be refused.

### Run the host on another machine

The host and the window need not be the same machine. The workspace, Pi, the models and every tool stay on the host; the Electron window is only a client of the protocol above.

On the host machine, start a host without a window:

```bash
npm run build
TAU_WORKSPACE=/path/to/project TAU_HOST_LISTEN=127.0.0.1:7788 node dist-electron/main/headless.js
```

It prints the URL it listens on and the path of its token. Without TLS the socket is unencrypted and repeats that token in every hello, so the host refuses to bind anything but a loopback address; `TAU_HOST_INSECURE=1` overrides that for a network you already trust, and the host prints a warning when it does. There are two ways across machines: TLS (next section) or an SSH tunnel. For the tunnel, forward the port from the client:

```bash
ssh -N -L 7788:127.0.0.1:7788 you@host-machine
```

Then copy the host's `~/.tau/host-token` to the client machine (or pass it as `TAU_HOST_TOKEN`) and start Tau as a client:

```bash
TAU_HOST_URL=ws://127.0.0.1:7788 npm run start:existing
```

The main process supervises no host of its own in that mode: it opens the window, which speaks the protocol over the socket, and the kits' code is fetched from the host and served to the renderer from here. What needs this machine — the clipboard, image previews, rebuilding the workbench — is answered in the window process rather than sent to the host. Paths in the workbench (the project's `cwd`, changed files, a tool's output) are the host's paths, so an action that hands a path to a local tool points at a directory that exists only there. The socket transport says so by leaving the `local-files` capability out of its hello, which the Electron transport announces.

#### Without a tunnel: TLS

A host with TLS may listen on any interface, such as its Tailscale address:

```bash
TAU_WORKSPACE=/path/to/project TAU_HOST_LISTEN=100.64.0.7:7788 TAU_HOST_TLS=1 node dist-electron/main/headless.js
```

On first start it creates a self-signed certificate under its userData (`~/.tau/headless/tls/`, key 0600) and keeps it across restarts. Besides the socket and token lines it prints the certificate's fingerprint:

```
tau-host listening on wss://100.64.0.7:7788
tls fingerprint: SHA256 6F:AB:DF:…:10:E9:1E (a client pins it as TAU_HOST_FINGERPRINT)
```

`TAU_HOST_TLS_CERT` and `TAU_HOST_TLS_KEY` use a certificate of your own instead. On the client, copy the token as above and pin the fingerprint:

```bash
TAU_HOST_URL=wss://100.64.0.7:7788 TAU_HOST_FINGERPRINT=6F:AB:DF:…:10:E9:1E npm run start:existing
```

Without `TAU_HOST_FINGERPRINT` the window shows the certificate's fingerprint on first connect and asks whether to trust it; compare it with the line the host printed. A yes is remembered in the client's `known-hosts.json`. A host whose certificate a CA vouches for needs neither. If the host ever presents another certificate, the window refuses it before sending the token, and the status line shows both fingerprints. If you replaced the certificate yourself, update the pin or delete the known-hosts entry. `docs/host-protocol.md` has the details.

A dropped link (a suspended machine, a restarted tunnel, a phone that slept or changed networks) is expected: the client reconnects with backoff, says hello again with the sequence it last saw and replays what it missed. Heartbeats find a link that died without a close, and coming back to the page or to a network tries again at once. A strip above the status line reads `Reconnecting to the host…` (with "Retry now" while it waits), then `Refetching the workbench state…` if the host's buffer no longer reaches back far enough. For a host on another machine, a dot in the title bar shows the link and its round trip. Nothing has to be restarted by hand.

The host accepts sockets only from pages it served itself and from clients that are not pages (the native app's sockets send no `Origin`); a proxy that changes the host name is added with `TAU_HOST_ALLOWED_ORIGINS=https://…`.

### Other machines in the same window

The easier way to work on another machine is to add it to the window you already use. On the other machine, open Settings → Connections, turn on network access and create a pairing link. On this one, open Settings → Machines and paste the link, type the other machine's address (`studio.local:7788`), or click **Find Machines** to list the ones that announce themselves on this network (the other machine needs Local network and Announce on) and **Add** one. The other machine's window asks whether to let this computer in and shows six digits; allow it if this window shows the same six. Tau keeps that machine's key encrypted in the system keychain and never saves it anywhere it cannot.

From then on the rail ends with **Other machines**: each with a dot for its status (connected with its round trip, connecting, offline since when, refused and why), and its newest threads, including the ones that are running. Clicking a thread opens this window on that machine: its threads, projects, terminals, files and kits are that machine's, and so is everything the agent does. **Run on** in a new thread's draft moves the draft, text and all, to another machine before it starts. Returning is the same click on a thread of this machine, the machine's name in the title bar, or **Back to this computer** in the command palette. When the other machine moves to another network, Tau follows its new addresses the next time it reaches it. Settings → Machines can also show the last machine again when Tau starts. Every move loads the window again, which takes a moment the first time a machine's kits are compiled. [ADR 0025](docs/adr/0025-a-window-follows-the-threads-machine.md) explains the design and what is left out: Preview and the folder picker stay with the machine the window runs on, and there is no load balancing between machines.

### The web client

A listening host also serves a browser client, so a phone or a second machine can
supervise the same threads as the desktop window. Build it once (`npm run build:web`
writes `dist-web/`), then start a host that listens:

```bash
npm run build && npm run build:web
TAU_WORKSPACE=/path/to/project TAU_HOST_LISTEN=127.0.0.1:7788 node dist-electron/main/headless.js
```

Besides the socket line, the host prints a pairing link:

```
web client: http://127.0.0.1:7788/#pair=<code>&host=<id>&name=<machine> (single use, 10 minutes; allow the device in Settings → Connections or here)
```

With `TAU_HOST_TLS=1` the page and the socket are served over HTTPS on the same port, the link starts with `https://`, and it carries the certificate's fingerprint (`fp=`). A browser shows a self-signed certificate as a warning; its fingerprint should match the one the host printed.

Open it. The code lives in the URL's fragment, so it reaches neither a proxy nor an
access log, and the page replaces the address before it renders anything. The page does
not get in by itself: it asks the host, shows six digits, and waits. The host's owner
sees "<device> wants to connect" in every Tau window that holds the host token — or, for
a host started by hand, on its terminal — with the same digits, and allows the device
only if they match (`docs/adr/0024-pairing-allowed-on-the-host.md`). The browser then
gets a token of its own, never the host token, and keeps it in `localStorage`. Without a
link, "Ask to connect" sends the same request; the host's owner can also paste the host
token — the line in `~/.tau/host-token` on the host machine. A token the host refuses,
one whose access was revoked, or one unused past its timeout, closes the socket and
brings the page back with the reason.

**Settings → Connections** in a Tau window manages who else may connect. It shows the
addresses the host listens on and its certificate fingerprint, the devices waiting to be
allowed (with their digits), and makes more pairing links (a label, 10 minutes to a day,
Full or Read only, single use; Copy link, and a QR code when the address is reachable
from another device — the link names every address and the fingerprint, for the app).
It lists the paired devices — browser, OS, address, when each was last active, the last
thing it changed, when it will be signed out unused — lets you rename one, make it Read
only (it may look, and every change is refused) or Full, pick when it is signed out
(30, 90 or 365 days unused, or never), revoke one or all others, which closes their open
connections at once. "Rotate…" replaces the host token and disconnects every other
connection that used it (a browser paired before tokens of their own, say); paired
devices keep theirs. A paired device cannot use the page: managing access takes the
host token.

**Network access** on the same page lets the app's own host take other devices, with
no environment variables and no restart. Two switches, off by default, combine:
**Local network** listens on every interface, **Tailscale** only on the machine's
Tailscale addresses, so the port stays closed on the LAN. Both use a fixed port (7788
unless you change it) and speak TLS only: the self-signed certificate, or one of your
own (**Use Own…**, a certificate and key such as `tailscale cert` writes). Tau reads
that certificate again when its files change, so a renewal needs no restart; **Reload**
does it at once. Tailscale also opens a plain listener on `127.0.0.1:7789` for a proxy
on this machine, such as `tailscale serve`; everything that arrives through it counts
as a remote device, although it comes from 127.0.0.1. The page lists every address a
device may use, labelled LAN, `.local`, Tailscale, MagicDNS or IPv6, and a pairing link
carries all of them. Turning a switch off closes its listener and every connection
that came through it. A host you start by hand opens a proxy listener with
`TAU_HOST_PROXY_LISTEN=127.0.0.1:<port>`. The installed app ships the web client.

While Local network is on, Tau also **announces itself with Bonjour** (`_tau._tcp`), so
the Tau app on a phone and other machines on the same network find it without a link.
The record carries the host's id and certificate fingerprint and nothing secret; a
device found this way still waits until you allow it with matching digits. Turn off
**Announce on this network** to be found only by link or QR code. **Find Machines…**
lists the Tau hosts nearby; it looks only when you ask. macOS may ask once whether Tau
may use the local network. Linux needs Avahi (`avahi-utils` and a running
`avahi-daemon`); Windows 10 1809 or later uses its own mDNS through PowerShell.

**Tailscale HTTPS**, in the Tailscale section below, has `tailscale serve` answer at
`https://<machine>.<tailnet>.ts.net/` in your tailnet with a certificate every browser
trusts, and forward to that proxy listener; neither switch has to be on. It needs
MagicDNS and HTTPS certificates turned on in the Tailscale admin console, and the section
says so while they are off. Before anything changes Tau asks, and says what it costs:
every certificate is written to the public Certificate Transparency logs, so the
machine's name becomes public for good. Rename the machine first if the name says too
much. Serve keeps forwarding after Tau quits (the address answers with an error then);
turning the switch off removes only Tau's path. On Linux, `tailscale serve` needs root
or an operator: run `sudo tailscale set --operator=$USER` once. Tau never runs
`tailscale funnel`, so nothing is published to the internet.

The client is the same workbench: the same transcript, composer, thread list, Pi dialogs
and Agents panel, reading the same stores over the same protocol. What differs is what it
can draw. A browser has no editor and no Electron window, so contributions that need one
are not registered there; Settings → Inspector lists them under "Not on this client",
with the extension, the contribution and the clients it does claim (`docs/adr/0016-client-profiles.md`).
Their host halves keep running: Workspace Kit still records turn checkpoints for a thread
driven from the browser, and the desktop window shows them.

Below 720 px the workbench lays itself out compactly, on any client: the thread list
becomes a sheet behind a button in the title bar, the composer sticks to the bottom edge,
the dock and the stage step aside, and the start screen becomes the list a supervisor
wants — every thread with what it is doing (running, waiting for an answer, failed, done),
a tap to open it, and a stop button that does not make you open it first. A Pi
confirm is answered in the composer, the way it is on the desktop.

Without TLS the socket is unencrypted and the page is served over plain HTTP, so the host
refuses to bind anything but a loopback address. To reach it from a phone, start the host
with `TAU_HOST_TLS=1`, or forward the port over SSH or a tunnel you trust;
`TAU_HOST_INSECURE=1` is the deliberate exception.

### The app for iOS and Android

`mobile/` is a native app built with Capacitor around the same compact client. It keeps
several hosts, finds hosts on the local network over Bonjour, and talks to each over a
socket of its own native side (URLSession on iOS, OkHttp on Android) that pins the host's
self-signed certificate — a web view cannot. Tokens live in the Keychain or behind a
Keystore key.

Add a host by scanning the QR code in Settings → Connections (or pasting its link), or
tap a host listed under "On this network". Either way the host's window asks
"<phone> wants to connect" with six digits; allow it only if the phone shows the same
ones. With a pinned certificate the digits depend on it, so something between the two
that presents another certificate cannot make them agree (ADR 0024). The link names every
address of the host; the app races them each time it connects — local network first,
then `.local`, then Tailscale — so it follows a phone from home Wi-Fi to cellular on its
own. Coming back to the foreground or to a network makes it check the link at once. More
→ Hosts in the thread list goes back to the host list. `tau://thread?host=<id>&thread=<id>`
opens a thread of a paired host (for push notifications, which are not built yet).

Building and running it in a simulator is in `mobile/README.md`; putting it on your own
iPhone through TestFlight, signed with your Apple Developer account, in
`docs/mobile-testflight.md`.

### Share a live session with Pi

Tau can attach to a Pi TUI that already owns the active session instead of opening a second `SessionManager`. Open Pi in the project first. For an already-running Pi session, run `/reload` once so Pi loads `.pi/extensions/tau-session-bridge.ts`, then start or restart Tau. Prompts, steering, aborts, assistant streaming, tool activity, model changes, thinking changes, compaction, and thread renames travel over an authenticated local socket and remain visible in both clients.

The Pi TUI is the sole writer while attached. Tau will not fall back to writing the same session if the owner is alive but unreachable. It retries a lost socket with bounded backoff and resnapshots automatically after Pi reloads or restarts the bridge. Enter `/reload` in Tau, or run “Apply changes and reload Tau” from the command palette. Tau builds its source first and then picks the shortest way to apply it: a change to kits or to the renderer reloads those and the window while every thread keeps running, so a turn in flight never notices it; a change to a kit's runtime half (`pi.cjs`) reloads Pi's resources too, and that is the only path that still offers to wait for or stop running threads; a change to the Electron main process or preload restarts Tau. Image prompts, Tau project-shell actions, Tau access-policy changes, new-session creation, and automatic title generation remain Pi-side operations in this mode. Safe mode refuses to attach because it cannot enforce safe-mode tool policy on a runtime owned by another process.

### Extend Tau while it runs

Tau loads desktop extensions the way Pi loads its own. Put a `.tsx` (or `.ts`) file in `~/.tau/extensions/`, or in `<project>/.tau/extensions/` for a project Pi trusts, and save it. The file default-exports a `DesktopExtension` and may import `react`, `lucide-react` and `tau` (the workbench hooks and types); the host compiles it with esbuild and the renderer binds those imports to its own copies. `examples/desktop-extensions/hello-panel.tsx` is a complete example; `tau.d.ts` next to it gives an editor the types.

An extension with a host half is a package: a folder under one of those two directories with a `tau-extension.json` manifest.

**Edit, save, see it.** Tau watches the files it reads — the package folders, the theme folders (`~/.tau/themes`, `<project>/.tau/themes`, and Pi's own), `~/.pi/agent/keybindings.json`, and `~/.tau/config.json` with its project twin — and reloads only what changed: one package, one theme, the keybindings, the config. The edited package's desktop module is swapped in place rather than the workbench being reloaded, so everything else keeps running; its panels remount, so their state does not survive. A save that does not compile changes nothing: the running version stays, the error is a toast and a line in Settings → Inspector, and it never counts towards deactivating the package. Turn off Settings → Defaults → Reload files when they change (`extensions.watch: false` in `~/.tau/config.json`), or set `TAU_NO_WATCH=1` in the environment, to turn watching off and go back to applying changes with `/reload`. Safe mode watches nothing. The host halves of the kits Tau ships still need `/reload`.

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

`id` is shared by both halves (lowercase, dot-separated) and must equal the id the desktop module exports; `desktop` and `host` are relative entry paths, either may be omitted. `isolation` is `worker` (the default) or `in-process`, see below. `version` is the package's own semver. `engines` names the ranges of `tau` (the app version), `pi` (the bundled Pi) and `api` (the contribution interfaces, `EXTENSION_API_VERSION` in `src/shared/extension-compat.ts`) the package runs on; ranges take `*`, `1.2.3`, `^1.2.0`, `~1.2.0`, `>=1 <2` and `||`. A package whose engines do not fit stays off on both sides and is listed with the reason in the Inspector. Both fields are optional; while Tau's own version stays pre-1.0 (see `package.json`), pin `api` rather than `tau`.

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

An install never starts a package: the grant flow below still asks. An update that keeps the same permissions keeps the grant, and the new code is picked up as soon as it lands.

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

A package names the capabilities it wants in `permissions`, from a fixed vocabulary: `workspace:read` (project paths and file contents), `workspace:write` (change files, write Git), `workspace:switch` (open or pick another project), `sessions` (session files, threads, transcript entries), `runtime:extend` (register runtimes, runtime extensions and permission levels), `process` (child processes and command lookup), `packages` (install, update and remove other extension packages) and `network`. Reaching a host service the package did not ask for throws and is logged as `host-extension.denied`. A package without the field asks for nothing; a bundled kit keeps the full facade.

A package Tau has not seen before, or one whose permission list changed, does not start. It appears in Settings as waiting for approval with the list it asks for; **Allow** writes the grant to `~/.tau/extension-grants.json` and starts both halves, **Deny** leaves it off. The grant survives a restart, and it applies to `~/.tau/extensions` exactly as it applies to `<project>/.tau/extensions` — Pi's project trust only decides whether a project's folder is read at all. Until a package is approved its host entry is not even compiled, so none of its code runs.

`source: { url, commit? }` records where a package came from and is shown in Settings → Inspector. It proves nothing on its own; a `tau-extension.sig` from a publisher you trust does.

The host half of a package runs in a worker thread by default. Its bundle is loaded there, not in the main process, so no line of it — not even its top-level code — runs beside the workbench. The worker has a 256 MB heap cap, no Electron (`import "electron"` throws with the reason), and reaches the host only through a message port: `context.registerCommand`, `context.emit` and a `services` facade whose members are all asynchronous and carry plain data. It offers `cwd`, `log`, `openWorkspace`, `knownWorkspacePath`, `pickDirectory`, `projectName`, `rememberProjectName`, `describeProjects`, `runtimeOwner`, `thread` (a snapshot), `transcript`, `setThreadTitle`, `noteSubprocess`, `findCommand`, `sessions.list`, `sessions.read`, `sessions.exclusive`, `registerThreadLifecycle`, `registerTurnObserver`, `setPendingWork` and `pinTranscriptEntries`. It does not offer what would hand out a live object: `registerRuntimeBackend`, `registerRuntimeExtension`, `loadRuntimeExtension`, `loadDependency`, `decorateUiPrompt`, `setPermissionLevel`, `presentUi`, `attachedRuntime`, `sessions.open`, `sessions.prepare`, `installPackage`, `updatePackages`, `removePackage` and `listPackages`. A package that needs one of those declares `"isolation": "in-process"`, which the approval box lists like a permission ("runs inside the host process") and the grant records — flipping it later asks the user again. `examples/desktop-extensions/hello-host.ts` is a worker host half to copy. The worker entry itself ships as one CommonJS bundle, `dist-electron/main/host-extension-worker.cjs`, written by `scripts/build-host-worker.mjs`.

Permission checks stay in the main process, on the facade the worker's calls are dispatched into, so isolation adds no way around a grant. A worker that throws, exits, exceeds its heap or does not answer a command within the timeout is terminated: the package is deactivated with the reason on its settings page, and the workbench keeps running. A synchronous infinite loop in a packaged command is survivable for the same reason.

A desktop half cannot reach the core IPC surface: `window.tau` is replaced with `undefined` while the bundle is built, and `globalThis.__tauShared` is the only bridge. The compiled bundle is served by the main process under `tau-ext://bundles/<id>/<hash>.js` and imported from there, which is why the page's CSP allows `tau-ext:` and no longer allows `blob:`. A host command that runs longer than 30 s, or fails three times in a row, deactivates the package. Every slot a package renders sits behind an error boundary that deactivates the package and shows a toast rather than taking the workbench down. See [ADR 0009](docs/adr/0009-extension-permissions.md) for what this does not protect against.

Settings → Inspector shows every extension both halves know (desktop registry, host registry, commands, isolation, activation failures), the package folders on disk with their versions, engines, permissions, isolation and source provenance, and the three versions the check runs against. The desktop entry is loaded like a plain desktop extension. The host entry is compiled with esbuild (Node builtins and Electron stay external, everything else is bundled) and its default export, a `HostExtension` (`{ id?, name?, activate(context) }`) or a factory returning one, is activated in the package's worker — or in the main process for an approved `in-process` package, where `context.services` is the same facade the bundled kits use (see `docs/adr/0006-host-extensions-own-host-features.md`). `context.registerCommand` and `context.emit` reach the desktop half through `context.host` either way. Packages are synced when Tau starts, when the project changes, when a watched file under one of them changes and on `/reload`, so installing, updating or removing a folder never needs a rebuild. A project's packages load only where Pi trusts the project; an activation failure is shown on the extension's settings page, not thrown. The settings toggle of a package turns both halves off and on.

Tau's own source can be changed from inside Tau too. A clean installation carries the editable source and build tools for its version. Run `/source` to create and open a versioned copy under Tau's user data, edit it like any other project, then run `/reload`. The installed Electron shell builds that managed copy and relaunches into its main process, renderer and bundled kits; the signed application itself stays untouched. Later reloads keep using the managed copy even while another project is open. Safe mode, or `TAU_IGNORE_WORKBENCH_SOURCE=1`, bypasses it for recovery. If threads are still running, Tau offers to wait or stop them first. An unpackaged checkout keeps building its own source directly.

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
- `@` file mentions in the composer, expanded to the file's workspace-relative path the way Pi reads it
- `!` shell commands from the composer, run through the login shell with their output styled in the transcript
- prompt history that survives a restart, plus a search over it
- open the workspace in the user's own editor (`Cmd/Ctrl+O`) or terminal (`Cmd/Ctrl+J`), and the draft prompt in the editor (`Cmd/Ctrl+E`)
- `TAU_RUNTIME_ADAPTER=pi` (default) keeps the embedded Pi runtime; `TAU_RUNTIME_ADAPTER=claude-code` or `antigravity` makes that backend, which the bundled `tau.claude-code` or `tau.antigravity` host extension registers, the default for new threads and the thread opened at startup (a name without a registered extension stops the start with an error dialog). The composer's runtime chip and Settings → Defaults override the default per client.
- model picker with provider tabs, cross-provider search and favourites
- clickable workspace bar under the composer: switch between the checkout and its worktrees, create a worktree for a new branch, and pick a ref from a searchable list
- enforced access levels: Tau's inline Pi extension gates workspace mutations and computer-control actions; read-only threads retain inspection tools, while ask-before-edits requires approval before clicks, typing, launches, shell commands, and file changes
- a Preview panel (`/preview <url>`, `Cmd/Ctrl+Shift+B`) showing a real browser view the host draws over the dock, and `preview_open/navigate/status/snapshot/screenshot/click/type/press/scroll/evaluate/wait_for/resize/set_appearance/recording_start/recording_stop` tools so the agent can read and drive the page it just changed; a floating picture of what an agent drives while the panel is hidden
- `request_takeover` for every runtime: when only the user can go on (a sign-in, a 2FA code, a captcha), a Your turn card above the composer brings the Preview, the driven app or a page in the user's own browser forward, offers to bring a signed-in session over from the user's browser, holds Computer Use, the Preview and evidence pictures, and Done hands control back
- built-in cross-platform computer use through `@amaster.ai/pi-computer-use` (Apache-2.0) and its bundled Cua Driver assets; safe mode excludes it, and an explicitly configured Pi package wins over Tau's bundled registration
- grouped command palette (`Cmd/Ctrl+K`) with arrow-key navigation, attributing every command to the extension that contributed it
- one settings page: workbench defaults, keybindings, and a click-through list of extensions rendered from the options each one declares
- Markdown rendering of messages — GFM tables, task lists, inline code, and syntax-highlighted code blocks with copy, all styled on the workbench palette; raw HTML is deliberately not enabled
- extension-provided tool renderers for reads, writes and shell commands
- thread title generation on a small model (the one the settings name, else one close to the thread's), automatic after the first prompt and manual on demand
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

See `src/renderer/extension-system.tsx` and the kits under `kits/` ([docs/CORE.md](docs/CORE.md) lists what each one owns). The left sidebar and right dock are empty core slots. Workspace Kit contributes the thread and project sidebar, local-folder and Git-clone sources, and Files. Review Kit contributes Changes and the diff review. Other bundled kits contribute Signals, thread title generation, and the runtime commands.

## What is not done yet

The prototype has proved the seams it was built to test: dynamic package loading, the extension
permission and isolation model, a host reached over a socket, a browser client of that host, and the
core/kit split into two artifacts. [PLAN.md](PLAN.md) records the completion check for each. What is
still open:

- **A week of real use.** Phase 1's own completion check — working across several projects without
  reaching for the Pi TUI for a missing interaction — has not been run.
- **Windows, run for real.** The host has a Windows path for everything it found POSIX-only (see
  [Windows](#windows)), but it is verified by tests on macOS and by a manual Windows workflow, not
  by a person using it on Windows.
- **One window showing two machines at once.** A window shows one machine's workbench at a time and
  loads again to show another ([ADR 0025](docs/adr/0025-a-window-follows-the-threads-machine.md)).
- **`kits/` in a repository of its own.** Two artifacts from one repository first; splitting them
  is a governance decision with a second release train behind it and no forcing need yet.

Not goals: a full code editor, a replacement for Git tooling, feature-for-feature parity with T3
Code, or a new agent runtime. Those arrive through extensions when they improve agent work enough to
justify their maintenance cost.
