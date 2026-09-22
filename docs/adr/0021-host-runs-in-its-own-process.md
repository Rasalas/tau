# ADR 0021: The host runs in its own process; the window is a client

## Status

Accepted, 2026-09-21. Amends [ADR 0001](0001-embed-pi-behind-a-desktop-host.md)
(the host was embedded in the Electron main process) and
[ADR 0010](0010-host-protocol.md) (the socket was the exception, not the rule).

## Context

`PiHost` lived in the Electron main process. Everything the user's threads were
followed from the window's lifetime: closing the last window on Linux or
Windows quit the app and killed every running turn; a crash of the window took
the runtimes with it; a workbench rebuild could not restart the window without
stopping the work it was doing. The window and the host were one process
because the first version had no reason to split them, not because anything
about the host needs a window.

Everything needed for the split was already there. `headless.ts` is the same
host without a window, reachable over the socket transport with a token,
replay and reconnect (ADR 0010). `TAU_HOST_URL` already makes a window a pure
client. What was missing was the mode where both are the normal case, and the
three things a window still owes its user when the host is somewhere else: its
clipboard, the kit code its renderer imports, and a native view over a panel.

T3 Code arrived at the same shape from the other side: its desktop app spawns
`apps/server` as a supervised child, and `t3 service install` keeps that server
alive as a system service.

## Decision

**The host is a child process of the window's process.**
`HostProcessSupervisor` (`src/main/host-process-supervisor.ts`) starts
`dist-electron/main/headless.js` with `process.execPath` and
`ELECTRON_RUN_AS_NODE=1` — Electron's own binary as plain Node, so native
modules (node-pty) and module resolution are exactly the window's. The child
gets the window's `TAU_USER_DATA`, its `TAU_WORKSPACE`,
`TAU_HOST_LISTEN=127.0.0.1:0` and `TAU_HOST_LOCAL_FILES=1`; the supervisor
reads the `tau-host listening on …` and `token: …` lines it prints and records
`<userData>/host.json` (`{ pid, url, tokenPath, startedAt, version }`). Its
stdout and stderr go to `<userData>/logs/host-out-<timestamp>.log`, five kept;
the host's own log is `host-process.log` beside the window's `host.log`.

**A host that is already running is adopted, not duplicated.** On start the
supervisor reads `host.json`, checks the pid, says hello with the token and
compares `hostVersion`. Same version: the window becomes that host's client and
its threads keep running. Another version: the old host is asked to stop with
`host.shutdown` — a method only a supervisor calls, present in the headless
host, not in the client method table — and a current one starts.

**A crash restarts the host.** Up to three restarts per minute, with a growing
delay; a restart asks for the port that was bound before, so the window's
client keeps its URL. Beyond that the window shows an error dialog with the log
path. If a restart had to take another port, the window is pointed at the new
one and the renderer's own reconnect takes over from there.

**The window is a protocol client, and so is its renderer.** The renderer is
given `?host=ws://…&token=…`, the path it already understood, so reconnect,
replay and the `reconnecting` / `resyncing` states are the ones ADR 0010 built
— no second implementation. The method table splits in two
(`CLIENT_SIDE_METHODS` in `src/shared/host-transport.ts`): the eight methods
the client's own machine answers (`copy-text`, `copy-image`,
`read-image-preview`, `desktop-extensions`, `rebuild-workbench`,
`workbench-source`, `relaunch-workbench`, `install-update`) travel over the
Electron bridge that is still there beside the socket, everything else to the
host. `createHostClient(connection, local)` does that routing;
`copy-thread-markdown` now answers with the text instead of copying it, because
the clipboard is the client's.

The alternative — the main process proxying every renderer call to the socket —
was rejected: it would duplicate reconnect and replay in a second place and
hide a host restart from the state the workbench already shows.

**Kits reach a socket client.** The host compiles the desktop halves and
answers `desktop-extensions` with their code; the window publishes that code
under `tau-ext:` and hands the renderer URLs. `DesktopBundleStore` became a
cache of what the host sent. This is why a window at a host on another machine
can load kits at all, which it could not before.

**A kit may keep a half in the window's process.** A `WebContentsView` over a
panel belongs to a window, and the host has none. `tau-extension.json` takes a
`window` entry beside `host` and `desktop`; the window process compiles and
loads it (`src/main/window-extensions.ts`), and a host extension reaches its
own half with `services.callClient(command, input)`. That call travels as the
`client-call` push and comes back as the `client-call-result` method
(`src/main/client-calls.ts`). The id is bound by the registry, so no kit can
drive another kit's half, and an isolated (worker) kit cannot use it at all.
Preview Kit is the first user: `view.ts` is its window half, and its host half
drives the view through a remote surface that caches the state the window
reports.

Core uses the same channel once for itself: a host with no window has no
folder picker, so `pickDirectory` is a call to the window's own half
(`WINDOW_SERVICES_ID`). The window process's connection says hello with
`auxiliary: true`, so the host counts one client per window, not two.

**Lifetime.** Closing the window leaves the host running, on every platform;
the next window adopts it through `host.json`, and starting Tau again while it
has no window opens one. Quitting the app stops the host — `host.shutdown`,
ten seconds, then SIGTERM — unless "Keep the host running in the background"
(Settings → Defaults, `hostBackground`, off by default) says otherwise.

**The way back.** `TAU_HOST_INPROCESS=1` keeps the old shape — `PiHost` in the
window's process, the full method table over Electron IPC, no socket — for one
release cycle.

## Consequences

- The host process owns what ticket 10 and 13 put into the host: it gets
  `turnsInFlightPath` and `appPath`, so in-flight markers are frozen by its own
  `dispose()` when the window's quit asks it to stop, and the config watcher
  runs there.
- A turn survives the window. Closing, crashing or reloading the window does
  not stop a running thread; the host keeps going and the next client picks up
  the transcript where the push log left it.
- Two processes mean two logs and two lifetimes. `<userData>/host.json`,
  `host-process.log` and `host-out-*.log` are the places to look; a stale
  `host.json` whose pid is gone is simply replaced.
- An abandoned host is possible: with the background setting on, or after a
  window closed on Linux/Windows, a host with no client keeps running until the
  next start adopts it or the user stops it.
- `desktop-extensions` now moves compiled kit code over the socket. It is a
  local loopback connection with a 64 MB frame limit, but this is the largest
  message the protocol carries.
- Startup grew a process spawn. The host reports its socket in about a second
  on a warm machine; the window waits for that line before it loads the
  workbench, so the renderer never opens without a host to talk to.
- A kit with a window half is not portable to a client that has no such
  process (the browser client). `callClient` rejects there, and a kit has to
  say so — Preview does.

## Out of scope

- **Restarting a host on another machine.** `TAU_HOST_URL` still attaches to a
  host somebody else runs; nothing supervises it from here.
- **A system service.** T3's `service install` (launchd/systemd) is a separate
  step; the background setting is the smaller version of it.
- **Several windows on one host.** The protocol allows it and the host serves
  every client it has, but the window process assumes one workbench window.
- **Turn resume across a host restart.** A restarted host keeps its sessions on
  disk, but an interrupted turn is not continued; that is ticket 10.
