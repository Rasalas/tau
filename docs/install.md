# Install and run

Tau runs on macOS, Windows and Linux. [Get started](site/get-started.md) is the short version; this page has the details: every installer, Linux specifics, updates, the `tau` command, the first start, and running Tau from a checkout.

## Download

Download the newest build for your platform from the
[releases page](https://github.com/Rasalas/tau-releases/releases): a `.dmg` or `.zip` on
macOS (arm64 and x64), a `.deb` and an `.AppImage` on Linux (x64), an NSIS
installer on Windows. These links always point at the newest stable release:
[Mac with Apple silicon](https://github.com/Rasalas/tau-releases/releases/latest/download/Tau-mac-arm64.dmg),
[Mac with Intel](https://github.com/Rasalas/tau-releases/releases/latest/download/Tau-mac-x64.dmg),
[Windows](https://github.com/Rasalas/tau-releases/releases/latest/download/Tau-windows-x64.exe),
[Debian and Ubuntu](https://github.com/Rasalas/tau-releases/releases/latest/download/Tau-linux-amd64.deb),
[AppImage](https://github.com/Rasalas/tau-releases/releases/latest/download/Tau-linux-x86_64.AppImage).

From 0.7.14 on, the macOS builds are signed with an Apple Developer ID and
notarized by Apple, so they open like any other app. The Windows installer is
not signed yet: until it is, SmartScreen may warn on the first launch (More
info → Run anyway). Earlier macOS builds were unsigned and have to be opened
from Finder's context menu once. From a checkout on a Mac,
`npm run install:mac` downloads the newest one, checks it against the
release's signature and SHA-512, and puts it into `/Applications`.

## Linux

On **Ubuntu and Debian**, install the `.deb`, with your software center or
`sudo apt install ./Tau_<version>_amd64.deb`. It puts Tau into `/opt/Tau` and
the application menu, brings Xvfb (for the invisible display) and pkexec (for
password dialogs) along, and links `tau` to the [command line](#the-tau-command);
`tau` with anything else starts the app. It also installs an AppArmor profile,
`/etc/apparmor.d/tau`, that lets Tau's binary use user namespaces and nothing
more, the way Chrome and VS Code do on Ubuntu 24.04 and later: Chromium keeps
its sandbox there, and `chrome-sandbox` needs no root.

On **other distributions**, use the `.AppImage`. It needs FUSE 2 (`libfuse2`) and cannot
run as a service. Where the kernel restricts user namespaces (Ubuntu 24.04 and
later), electron-builder's launcher starts it without Chromium's sandbox; on a
system with `apt`, Tau then offers at start to install itself properly: it
downloads the `.deb` of the same release (checked against the release's
SHA-512), installs it after one password dialog, restarts from `/opt/Tau` with
your threads and settings, and offers to delete the AppImage. "Later" waits
for the next version. Without a desktop session that can show the password
dialog, it shows the one `sudo apt install` command to run instead. A copy
unpacked by hand (an extracted AppImage) runs, but cannot update itself.

## Package managers

Once they are set up, the package managers carry it too:
`brew install --cask rasalas/tau/tau` on macOS, `winget install Rasalas.Tau` on
Windows, `yay -S tau-bin` (or any AUR helper) on Arch Linux. How each is
published is in [RELEASE.md](RELEASE.md#package-managers).

## Updates

An installed Tau keeps itself current, with or without a window, from the
same releases page; no account or token is needed. Each
machine's host looks for a newer release on its update track two minutes after
it starts and then every six hours, downloads it in the background, checks it
against the release's SHA-512, and installs it once no turn has run for a
quarter of an hour; a background service then restarts into it. It never
installs while a turn runs. Settings → About shows the Tau of the machine you
are connected to, from a window, a browser or the phone: its version, whether
an update is available, downloading, waiting for turns or failed, **Update
now**, and **Automatic updates** for that machine. Settings → Machines shows
the same for every machine the window keeps, with **Update**. While a Tau
window runs on a machine, that window installs as before: it downloads on its
own and installs when you choose Restart or quit; Update now from elsewhere asks
it to. "Check for updates…" in the application menu asks on demand, and
Settings → About → Pre-release builds switches between stable releases and the
nightly build of `main`.

- **Linux `.deb`:** the package brings a small update helper and a polkit rule,
  so members of `sudo`, `admin` or `wheel` (or a group `tau-update`) update
  without a password, also on a server with no desktop session. The helper
  installs nothing but a newer `tau` package that matches the release's
  checksum. A `.deb` from before the helper needs one update by hand:
  `sudo apt install ./Tau_<version>_amd64.deb`.
- **Linux AppImage:** replaces its own file.
- **macOS:** replaces the app in place when it belongs to you (drag-installed
  into Applications); otherwise the Tau window installs it.
- **Windows:** the installer runs silently for your user.
- A copy unpacked by hand, or a checkout, says that it cannot update itself.

From a terminal, `tau update` updates this machine (`--check` only looks,
`--status` tells where it stands), and `tau machines update <name>` updates
another machine this computer keeps, over the same connection Settings →
Machines uses. The owner of a machine can stop paired devices from starting
updates there (Settings → About → Paired devices may update this machine).
[Host updates](host-updates.md) has the design, the helper and
the threat model.

## Build an installer

```bash
npm install
npm run dist          # this machine's platform; also dist:mac, dist:linux, dist:win
```

The artifacts land in `release/`.

### Tau Dev: a build of this checkout beside Tau

On a Mac, `npm run install:mac -- --local` builds this checkout for the
machine's architecture as **Tau Dev** and puts it into
`/Applications/Tau Dev.app`. It never replaces `/Applications/Tau.app`: Tau Dev
is a second app with names of its own, so both run at once.

| | Tau | Tau Dev |
|---|---|---|
| bundle id, AppUserModelID | `de.tbuck.tau` | `de.tbuck.tau.dev` |
| userData (host.json, locks, network.json, kit state) | `tau-pi-desktop-prototype` | `tau-dev` |
| home folder (config, host token, packages, themes, grants, worktrees) | `~/.tau` | `~/.tau-dev` |
| network access ports | 7788, 7789 | 7790, 7791 |
| Bonjour | `_tau._tcp` | `_tau-dev._tcp` |
| host service | `dev.tbuck.tau.host`, `tau-host.service`, `Tau Host` | `de.tbuck.tau.dev.host`, `tau-dev-host.service`, `Tau Dev Host` |
| keychain entry | `Tau Safe Storage` | `Tau Dev Safe Storage` |
| command line | `tau` | `tau-dev` |
| updates | the release feed (Stable or Nightly) | none: Settings → About says it is built from source |

`src/main/app-identity.ts` holds both. The build is Tau Dev because
`tooling/electron-builder.dev.mjs` writes `tauFlavor: "dev"` into the packaged
`package.json`; `npm start`, `npm run dev` and every release are Tau. Tau Dev
starts empty: copy `~/.tau/config.json` to `~/.tau-dev/` if you want your
settings in it. To update it, run the same command again. Nightly is not a
separate app: it is an update track of Tau (Settings → General).

Linux and Windows have no Tau Dev build yet; `npm run dist:linux` and
`npm run dist:win` build Tau.

## The `tau` command

`tau app [path]` opens a folder in the Tau that is running (the current
directory without a path) with a new thread's draft on screen, and brings the
window to the front. It finds the host through `<userData>/host.json` and
speaks to it with the host's own token;
`TAU_USER_DATA` points it at another instance, as it does for the app. Without
a running Tau it starts the app on that folder. The command is `bin/tau.mjs`
(`bin` in `package.json`) and needs Node 22 or newer. The `.deb` puts it on
your `PATH` as `tau` and runs it on Tau's own binary, so it needs no Node.
Elsewhere, link it yourself:

```bash
# a checkout
ln -s "$PWD/bin/tau.mjs" ~/.local/bin/tau
# an installed Tau on macOS (npm run install:mac prints this line)
ln -s /Applications/Tau.app/Contents/Resources/app.asar.unpacked/bin/tau.mjs ~/.local/bin/tau
# Tau Dev, beside it; this one reads Tau Dev's userData
ln -s "/Applications/Tau Dev.app/Contents/Resources/app.asar.unpacked/bin/tau.mjs" ~/.local/bin/tau-dev
```

`npm run smoke:cli-app` (after `npm run build`) drives it against a headless
host in temp folders.

The same command manages the host as a service (`tau service`, see
[Hosts, machines and devices](hosts.md#run-the-host-as-a-system-service)),
other machines (`tau machines`), updates (`tau update`) and packages of your
own (`tau kit`, see [Writing a package](EXTENSIONS.md#your-first-package)).

## First start

A Tau without a single thread opens its welcome wizard (Onboarding,
`kits/onboarding/`); `/welcome`, or "Set up Tau…" in the palette, opens it again
later. It has three steps:

1. **Agents.** Pi and how many models your Pi configuration signs in to, then
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
2. **Projects.** The folders those CLIs and Pi worked in, newest first, each
   with the conversations it has and when it was last used. Clones of one
   repository (the same `origin`) are one group with a checkbox for all of
   them; folders that are no repository are folded away under "Other folders".
   Linked worktrees, your home and temporary folders themselves, and anything
   in `~/Downloads`, Codex's scratch folders under `~/Documents/Codex` or Tau's
   worktrees folder are left out. Git repositories used in the last 30 days
   with three conversations or more are chosen for you; "Add a folder…" opens
   the project sources.
3. **Conversations.** The conversations those CLIs kept, grouped by folder,
   imported as threads of the runtime that ran them: the title and the visible
   text (the first prompt and the newest messages, 200 at most), no tool
   activity and no attachments. A thread continues by resuming the CLI's own
   session. Importing again skips what Tau already holds.

Each CLI's history is read from its own home (its config directory, or
`CODEX_HOME` for Codex), newest 500 sessions, files up to 16 MiB. Set
`TAU_IMPORT_ROOTS` to one or more directories laid out as
`<dir>/<backend kind>/…`, like the CLI's own home, and nothing else is read.
The dev instance sets it to `.tau-dev/import-roots`.

## Windows

Tau builds for Windows and the host has a Windows path wherever it assumed a
POSIX system: PATH comes from the registry instead of a login shell, commands
resolve through PATHEXT, `.cmd` shims start through `cmd.exe`, process trees end
with `taskkill`, the terminal opens PowerShell. Nobody has used it on Windows
yet; what is verified by tests only and what is known not to work is in
[windows.md](windows.md), with how to try it. Pi needs Git for Windows
there (its `bash` tool runs Git Bash).

## Run from a checkout

```bash
npm install
npm start
```

`npm start` performs the minified production build and opens the Electron app. For development, use `npm run dev` (Electron + Vite hot reload) or `npm run dev:web` (browser fixture preview); `npm run start:existing` opens the last production assets without rebuilding. Build and startup measurements are written to `reports/build-report.json` and `reports/start-report.json`; `npm run build:budget` and `npm run start:budget` enforce the local budgets. The initial workspace is this repository; use the project picker in the left sidebar to open another folder. Recent projects persist in Electron's user-data directory. What Tau takes from your machine (Pi's configuration, your shell's environment, the agent CLIs) is in [Runtimes and tools](runtimes.md).

For a UI-only browser preview with fixture data:

```bash
npm run dev:web
```

Start without Pi or desktop extensions to inspect or recover the minimal core:

```bash
npm run start:safe
```

The production renderer is minified and does not ship source maps unless `TAU_SOURCEMAP=true` is explicitly set. Review, Settings, optional panels, and Highlight.js languages are demand-loaded; their slots expose a Retry action if a chunk cannot be loaded.

`npm run lint` runs [oxlint](https://oxc.rs/docs/guide/usage/linter.html) over the whole repository except `dist/`, `dist-electron/` and `node_modules/` (config in `.oxlintrc.json`: `correctness` and `suspicious` rules as errors, `perf` as warnings); an override turns `no-await-in-loop` and `no-map-spread` off under `kits/`, `scripts/`, `src/main/` and `.pi/`, where sequential awaits and immutable per-element updates are the point, and keeps both on elsewhere. CI (`.github/workflows/ci.yml`) runs lint, typecheck, the full Vitest suite, and a production build on every pull request and push to `main`; `.github/workflows/performance.yml` stays the separate, slower gate for build/startup/renderer budgets, and `.github/workflows/release.yml` builds and publishes the artifacts of a `v*.*.*` tag ([RELEASE.md](RELEASE.md)).
