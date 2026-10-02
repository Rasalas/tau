# Tau on Windows

Status, 2026-09-23: the host has a Windows path everywhere it assumed a POSIX
system, and each of those paths is covered by unit tests. Those tests run on
macOS with `platform: "win32"` and `path.win32` injected. Nobody has started
Tau on a Windows machine yet. A few tests only run on Windows, against the real
`cmd.exe`, `where.exe`, PowerShell and `taskkill`; they are in the manual
workflow `.github/workflows/windows.yml`, which has not been run yet either.
Read everything below with that in mind.

Release builds for Windows (the NSIS installer) existed before this work and
were checked on 2026-09-06 by unpacking them ([RELEASE.md](RELEASE.md)), not by
running them.

## What Windows gets instead of the POSIX path

| Where | POSIX | Windows |
|---|---|---|
| PATH at startup (`src/main/shell-environment.ts`) | read from a login shell (`$SHELL -ilc`), launchctl as fallback | Windows PowerShell (`-NoProfile`) reads the registry's Machine and User PATH; the inherited PATH keeps its order and gains only what the registry added since, then per-user tool folders that exist (`%APPDATA%\npm`, Volta, pnpm, scoop, `.local\bin`, `.bun\bin`, `.cargo\bin`) |
| `findCommand`, `findExecutable` | PATH entries, execute bit | PATH entries (`;`, quotes allowed) × PATHEXT, limited to `.com .exe .bat .cmd`; the lookup `where.exe` does, in-process |
| Starting a found command (`commandInvocation`, `src/main/platform-process.ts`) | as is | a `.cmd`/`.bat` runs through `cmd.exe /d /s /c` with every argument quoted and caret-escaped; Node refuses to spawn one directly (EINVAL since the fix for CVE-2024-27980) |
| Ending a process and its children (`killProcessTree`) | signal to the process group | `taskkill /pid N /T /F` |
| Console windows | none | `windowsHide` on every console tool the host starts, since the host (Electron as Node) has no console of its own |
| Project scripts, `runOnWorktreeCreate` | `/bin/sh -c`, `/bin/sh -lc` | `cmd.exe` |
| Terminal kit's shell | `$SHELL -il` | `pwsh` on PATH, then Windows PowerShell, then `ComSpec` |
| "Open in" | `code`, Toolbox scripts, app bundles | `code.cmd` through `cmd.exe`, Toolbox's `idea.cmd` & co. under `%LOCALAPPDATA%\JetBrains\Toolbox\scripts` |
| External editor (`$VISUAL`/`$EDITOR`) | POSIX quoting, backslash escapes | backslash is a separator, only `"` quotes; `code --wait` runs through `cmd.exe` |
| Badge | `app.setBadgeCount` | a dot on the taskbar button (`setOverlayIcon`), the count in its description |
| Notifications | – | the app sets its AppUserModelID to `de.tbuck.tau`, the installer shortcut's; an update stamps it on the shortcuts it keeps (`packaging/windows/installer.nsh`) |
| Paths from a client | `relPath` is POSIX | a backslash in a `relPath` is refused, since Windows reads it as a separator |
| Preview `file://` | `/path` | `C:\path` becomes a file URL; containment compares case-insensitively |

State lives in the same places, spelled the Windows way: the window's userData
in `%APPDATA%\tau-pi-desktop-prototype`, Tau's own files in
`%USERPROFILE%\.tau`, Pi's in `%USERPROFILE%\.pi\agent`.

### Why the registry and not a PowerShell profile

A Windows GUI launch already inherits the user's registry environment through
Explorer, unlike a Dock launch on macOS. What can be missing is what an
installer added after Explorer started, and that is in the registry. A profile
script is the user's code: it can be slow, print, or wait for input, and a
`cmd.exe` or an Explorer-started tool never sees what it adds either. So Tau
reads the registry through Windows PowerShell (always present, called by its
absolute path; `pwsh` is the fallback) without the profile. The values come
back base64-encoded, so a non-ASCII profile path survives any console code
page. The cost is one PowerShell start at launch, in parallel with loading
the project list, capped at 5 s.

What this misses: PATH entries that exist only in a PowerShell profile (`fnm
env`, `conda init`). Add those folders to the user PATH in the system settings.

### Why PATHEXT in-process and not `where.exe`

`findCommand` is synchronous on the seam, and `gitExecutable` calls it on hot
paths. Starting `where.exe` per lookup would block for a process start each
time. The lookup is the same one `where.exe` makes: each PATH entry, each
PATHEXT extension in order. A test on the Windows runner compares the two.

### Arguments to a batch file

`cmd.exe` parses the `/c` line once; the batch file then sees each argument in
double quotes, whether it reads `%1` or forwards `%*` as npm's shims do. A
double quote or a line break inside an argument cannot survive both parses
safely, so `commandInvocation` refuses it for a batch file rather than guess.
None of Tau's own calls pass one: `gh` and `glab`, which take titles and
bodies, are `.exe` files.

## Verified, and how

On macOS, with Windows injected (`npm test` runs these everywhere):

- `src/main/shell-environment.test.ts`: registry output parsing (CRLF,
  non-ASCII), merge order, `Path` spelled in any case, PATHEXT lookup, only
  runnable extensions, no POSIX shell even when `SHELL` is set
- `src/main/platform-process.test.ts`: the `cmd.exe` line, the escaping
  (round-tripped through a model of `cmd.exe`'s caret handling), the
  `taskkill` call
- `src/main/host-process-supervisor.test.ts`: a token path with spaces and
  CRLF (this one was a real bug on every platform)
- `src/main/external-editor.test.ts`, `src/main/single-instance.test.ts`,
  `src/main/window-attention.test.ts`, `src/main/workspace-identity.test.ts`,
  `src/main/pi-session-dir.test.ts`
- `kits/terminal/shell.test.ts`, `kits/workspace/editors.test.ts`,
  `kits/workspace/agent-worktrees.test.ts`, `kits/workspace/host-paths.test.ts`,
  `kits/preview/host.test.ts`

Only on Windows (in the manual workflow, not yet run):

- a `.cmd` on PATH is found, and agrees with `where.exe`
- the registry PATH comes back through Windows PowerShell
- arguments with `& | < > ^ % ! ( )`, spaces and a trailing backslash pass
  through `cmd.exe` and an npm-style `%*` shim unchanged
- `taskkill /T` ends `cmd.exe` and the program it started
- `npm run build`, `smoke:remote-host` (headless host, socket, TLS, replay) and
  `smoke:extension-install` (keygen, sign, install, worker isolation, tamper
  check), which were made Windows-aware (profile-path isolation through
  `USERPROFILE`, a `git.cmd` stand-in, no POSIX mode checks)

## Untested

Everything that needs the app running on Windows: the window, the host as its
own process and its adoption through `host.json`, a thread's turn, the
terminal (node-pty's ConPTY build ships in its prebuilds), Git worktree
threads, Open in, notifications and the overlay badge, the updater, the
installed app, and an attached Pi session over its named pipe.

## Known gaps

- **Pi needs Git for Windows.** Its `bash` tool runs Git Bash (Pi's own
  `docs/windows.md` in `@earendil-works/pi-coding-agent`; `shellPath` in
  `~/.pi/agent/settings.json` names another bash).
- **`npm run dev` and `npm run start:safe`** set variables with POSIX syntax,
  which `cmd.exe` does not understand. Use `npm start`, or set the variable in
  PowerShell first (`$env:TAU_NO_EXTENSIONS = "1"; npm start`).
- **The full test suite** is not expected to pass on Windows: many tests write
  `#!/bin/sh` stand-ins or compare POSIX paths. The workflow runs the Windows
  subset; its `full-suite` input shows how far the rest gets.
- **Stopping the host by signal is a hard kill.** Windows has no SIGTERM. The
  window first asks the host over its socket to shut down, as on every
  platform; only if that fails does it terminate the process, and then
  whatever the host started may outlive it.
- **File modes are ignored.** The host token, the TLS key and the grants file
  are private only through the user profile's ACL.
- **Case.** Workspace ids are minted from `realpath`, which gives the
  canonical case. Other containment checks compare case-sensitively; a path
  spelled in another case is refused, never let through.
- **Agent SDK runtime with an npm-installed CLI.** The SDK starts its
  executable directly, which fails for the `.cmd` shim npm installs. The
  native installer's `.exe` does not have this problem.
- **Scripts run in `cmd.exe`.** Project scripts and `runOnWorktreeCreate`
  lines written for `sh` need a Windows spelling.
- **Terminal editors as `$EDITOR`** (vim, nano) cannot run: the host has no
  console to give them. Use a GUI editor that waits, e.g. `code --wait`.
- **`tau app`** finds a checkout's Electron but not an installed Tau on
  Windows; run it from a checkout (`node bin\tau.mjs app`).
- **Preview's port discovery** reads `netstat`; without `lsof` it cannot tell
  which server runs in the workspace.
- **The overlay badge** is a dot, not a number; a toast from an unpackaged
  checkout may not show, since no Start Menu shortcut carries its
  AppUserModelID.
- **Signing.** The installer is unsigned ([RELEASE.md](RELEASE.md)).

## Try it

Needs Windows 10 or 11 (x64 or arm64), Node 22, and Git for Windows.

```powershell
git clone https://github.com/Rasalas/tau.git
cd tau
npm ci
npm test -- src/main/shell-environment.test.ts src/main/platform-process.test.ts
npm run build
npm run smoke:remote-host
npm run smoke:extension-install
```

The app, isolated from your own Tau and Pi sessions:

```powershell
$env:TAU_USER_DATA = "$PWD\.tau-dev\userdata"
$env:PI_CODING_AGENT_SESSION_DIR = "$PWD\.tau-dev\pi-sessions"
npm start
```

`node scripts/dev-instance.mjs --build --fresh` does the same with every
isolation variable set and a remote-debugging port for `npm run cdp`; it has
not been tried on Windows.

Without a Windows machine, the workflow runs it on a GitHub-hosted runner
(`windows-2025`):

```bash
gh workflow run windows.yml --ref <branch>
gh workflow run windows.yml --ref <branch> -f full-suite=true
gh run watch
```

What to report from a first run: whether the window opens, whether a thread
answers, whether a console window flashes when Git runs, and the host log
under `%APPDATA%\tau-pi-desktop-prototype\logs`.

## WSL environments

The Windows desktop can list installed distributions through `wsl.exe --list
--quiet`. Adding a distribution installs Tau's signed Linux portable host for
its architecture under the distro user's `~/.local/share/tau/wsl-host`. The
Windows client downloads and checks the signed release, then the distro checks
the archive checksum again before extraction. It uses Tau's embedded runtime;
Node and npm do not need to be installed in the distribution. The archive
bootstrap follows [T3 Code's Linux archive approach](https://github.com/pingdotgg/t3code/pull/11511).

The distro owns the host's data, Linux workspace paths and provider sign-ins.
Windows credentials and Windows workspace paths are not copied into it. It
needs `wslpath`, `tar`, `openssl`, a working user systemd service manager, and
WSL localhost forwarding. A distribution without systemd must enable it and
restart WSL before adding the environment. Tau never installs WSL, enables
systemd, changes a distro's configuration, or asks for a root password.

The pairing approval channel runs inside the selected distribution and accepts
only the link made by that host. Closing the channel leaves the user host
service running. Distribution names and archive paths are process arguments;
they are never inserted into shell source.

## SnapShots on Windows and Linux

SnapShots captures one window through Electron and reads its text through the
existing [xa11y accessibility backend](https://github.com/xa11y/xa11y), which
uses Windows UI Automation or Linux AT-SPI2. Windows has no macOS permission
prompt. Protected windows can reject capture, and an unelevated app cannot
read an elevated app's accessibility tree. Tau does not elevate itself to
work around this.

On X11, foreground capture needs the session D-Bus and AT-SPI2. Wayland
uses the current compositor's native window capture when it is ready:

| Desktop | Focused window capture | Setup |
| --- | --- | --- |
| GNOME Shell 45–50 | Shell captures the focused window actor and returns app identity and frame bounds. | Choose Install helper in Settings → SnapShots. This installs and enables Tau's Shell extension. Python 3 and PyGObject, usually `python3-gi`, provide its D-Bus transport. A new extension may need a logout and login before Shell discovers it. |
| KDE Plasma 6 | The dedicated executable calls KWin ScreenShot2 v2 with a pinned window ID and receives pixels through a file descriptor. A temporary KWin script supplies identity and frame bounds, and is unloaded afterwards. | Choose Install helper to install the bundled executable and its desktop entry, which explicitly grants `org.kde.KWin.ScreenShot2`. KDE's `kbuildsycoca6` must be available. |
| Hyprland | The dedicated executable exports the exact active window through toplevel-export v2 and toplevel-mapping v1. It does not crop a desktop screenshot. | Choose Install helper. Hyprland must expose those protocols and the `locked` IPC query. Approve the compositor's screen-sharing permission if it asks on first capture. |
| Niri 25.11 or newer | IPC pins the focused window ID and waits for the completion event for Tau's own temporary path. | No helper installation. `NIRI_SOCKET` must identify this session. Niri also copies the capture to the system clipboard and may show its own screenshot notification. |

Helpers are never installed at startup. Settings explains the access before
installation and offers Remove helper. GNOME removal disables the extension
before removing its files. KDE removal deletes the dedicated binary and its
permission entry. Tau does not install system packages, enable unsafe GNOME
Shell evaluation, change compositor configuration or claim that an unavailable
global shortcut works. Native capture failures and permission denials remain
errors. They do not open another capture route automatically.

Choose a window or display in Settings remains available as the manual portal
fallback. Without a ready native backend, the shortcut uses that chooser where
the desktop supports global shortcuts. Tau captures only the source approved
in the chooser and stores no image after cancellation or denial. The portal
does not identify the app, so manual captures omit accessibility text. It needs
PipeWire, xdg-desktop-portal and the backend for your desktop. Flatpak and Snap
sessions use this manual route.

Native adapters keep screenshots in private temporary directories, reject
linked, malformed and oversized files, and remove the directory after success
or failure. They capture a window buffer at the compositor's native scale and
resize to at most 1920 pixels wide. Tau never reconstructs a window by cropping
an entire screen, so monitor scale, negative monitor coordinates and overlaps
do not select pixels from a neighbouring window. Accessibility text requires
matching process, title and compositor coordinates. Niri's local window size
cannot establish global AT-SPI coordinates, so its native captures omit text.
Changed or closed windows also lose their identity rather than receiving text
from a replacement.

The capture helpers follow the primary implementations in
[T3 Code v0.0.44](https://github.com/pingdotgg/t3code/tree/v0.0.44/apps/desktop/src/snapShot).
The KDE and Hyprland Rust helpers adapt its MIT-licensed native capture code;
the license and original copyright are included beside the distributed helpers.
The APIs were checked against the official
[Niri IPC definitions](https://github.com/YaLTeR/niri/blob/main/niri-ipc/src/lib.rs),
[KWin ScreenShot2 implementation](https://github.com/KDE/kwin/blob/master/src/plugins/screenshot/screenshotdbusinterface2.cpp),
[GNOME Shell screenshot implementation](https://github.com/GNOME/gnome-shell/blob/main/js/ui/screenshot.js)
and [Hyprland toplevel export protocol](https://github.com/hyprwm/hyprland-protocols/blob/main/protocols/hyprland-toplevel-export-v1.xml).
Electron's generic PipeWire chooser can label a selected display as a window,
so manual captures say Selected source and never infer app identity.

[Electron's Wayland shortcut portal](https://www.electronjs.org/docs/latest/api/global-shortcut#usage-on-linux)
is enabled by default in the shipped version. Tau supplies a stable
`de.tbuck.tau.desktop` identity and packages the matching desktop entry. GNOME
may ask for shortcut consent, while KDE exposes bindings in System Settings.
A source checkout without an installed matching desktop entry may have no
global shortcut; use the Settings capture controls to test that environment.

For source Linux builds, run `node scripts/build-wayland-helpers.mjs` before
building Tau, or set `TAU_BUILD_WAYLAND_HELPERS=1` on the build. This requires a
current stable Rust toolchain. Published Linux desktop releases build and ship
the helpers; a person using those releases does not need Rust. Builds without
the native binaries report the missing helper and keep the manual picker.
Managed source rebuilds retain the release's native helpers.

Missing native accessibility binaries report unavailable rather than showing
macOS permission instructions.

Verification on 2026-09-30 used injected Windows and Linux environments,
recordable window sources, accessibility trees, WSL executors and pairing
channels on macOS. Focused Wayland adapter tests covered explicit installation,
permission denial, changed window identity, negative monitor origins,
accessibility scaling, symlink rejection and temporary-file cleanup. Linux
container transport tests passed against private fake KWin D-Bus and Hyprland
Wayland servers, including real descriptor transfer and capture rejection.
No real WSL installation, Windows or Linux desktop capture, compositor helper
installation in the user's session, or system permission change was performed.

Platform verification still needs isolated desktop instances. Test ordinary,
protected and elevated Windows apps; X11 foreground capture; each Wayland
compositor's helper install, shortcut, removal and picker fallback; mixed-scale
monitors; and a window closing during capture. Check that startup and Settings
access checks never capture or open the chooser, that cancellation and denial
store no image, and that native failures leave the manual picker available.
