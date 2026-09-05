# ADR 0010: One versioned host protocol, Electron IPC as a transport

## Status

Accepted, 2026-09-04. Amended 2026-09-05 with workspace identity (step 6 of ticket 18).

## Context

The renderer reached the host through about forty `tau:*` IPC channels: one `ipcMain.handle` per operation in `src/main/index.ts`, one method per operation in `src/preload/index.cts`, and one push channel for host events. The shape was Electron's, not Tau's. Three consequences followed.

Nothing else could speak it. `HostClient` (ADR-less, `docs/host-protocol.md`) already declared a transport-neutral surface, but its only implementation delegated to `window.tau`, so a host on another machine had no boundary to answer at.

Nothing could notice a loss. Pushes were unnumbered, so a client that missed events — a suspended host, a reloaded window — could not tell, and there was no way back other than restarting the app.

Long operations were plain promises. A clone or a workbench rebuild occupied one request until it finished, reported no progress, could not be cancelled, and ran against the host extension registry's 30-second command timeout.

## Decision

There is one client-to-host protocol, `HOST_TRANSPORT_VERSION = 1`, declared in `src/shared/host-transport.ts`: `HostRequest { id, method, params }`, `HostResponse { id, result? | error? { message, code } }`, `HostPush { seq, event }`, and a `hello` that carries the protocol version, an optional token and an optional `lastSeq`. Its reply names the host version, its capabilities, the pushes the client missed, and whether it must resync. Every frame has a hand-written decoder, in the style of `host-protocol.ts`; a rejected frame is never echoed back.

Method names are the former channels without `tau:` (`send-prompt` is `prompt`, `tau:transcript-page` is `transcript-page`). Params travel positionally, in the order of the matching `HostClient` method. The host implements them in one table, `src/main/host-methods.ts`, which still decodes every argument through `ipc-input.ts`; a transport only moves frames in and out of that table. `src/main/ipc-contract.test.ts` compares the method names the renderer sends with the table's keys, in both directions.

Two transports exist. Electron IPC (`host-transport-electron.ts`) uses exactly two channels: `tau:request` and `tau:host-event`. A local WebSocket (`host-transport-socket.ts`, dependency `ws`) serves the same table on `TAU_HOST_LISTEN=host:port`. The renderer picks the socket with `?host=ws://…&token=…`, otherwise the preload bridge.

Pushes are numbered by one `HostPushLog` per host and buffered (500). `hello` with `lastSeq` answers with the missed pushes, or with `resync: true` when the gap fell out of the buffer or the host restarted. `HostConnection` in the renderer owns that: it detects a gap in the sequence, re-hellos, applies what it gets, and on a resync refetches the bootstrap and republishes it as the updates the workbench already applies. Its state (`connected`, `reconnecting`, `resyncing`) is visible in the workbench.

Long operations are host jobs: `start-job` answers with a `jobId`, progress and the result arrive as `job-progress`/`job-done` pushes, `cancel-job` stops waiting. `HostClient` keeps the promise shape by awaiting `job-done` internally. Which calls are jobs is data, not core knowledge: a host extension marks its own long commands with `registerCommand(name, handler, { long: true })` — those also skip the command timeout — and the client asks for the list with `job-methods`. Today that is the workbench rebuild and Workspace Kit's clone.

A workspace is named by identity, not by path. Every project the host publishes
carries a `workspaceId` — `ws1_` plus a truncated SHA-256 of the host's own
persisted id (`<userData>/host-id`) and the workspace's canonical path — and a
`displayPath` for the user to read. The encoding is one-way, so a client cannot
recover a path from an id, and a host resolves only ids it minted itself; an
unknown one is refused. Files inside a workspace travel as `relPath`, POSIX and
relative to its root, and the host refuses an absolute path or a `..` segment
before `assertWorkspacePath` ever runs. `cwd`, `UiProject.path` and
`UiSession.projectPath` remain on the wire for one minor version as deprecated
display data, and methods that took a path accept either.

Whether the host's files are the client's files is the `local-files`
capability. Electron IPC announces it because it is in process; the socket
transport announces it only for a loopback peer whose host was started with
`TAU_HOST_LOCAL_FILES=1`. The renderer reads it and offers no editor list, no
"Open in editor" and no "Copy path" without it.

Authentication of the socket transport is a 32-byte token in `~/.tau/host-token`, written 0o600 in a 0o700 directory on first listen and repeated in every hello. A wrong or missing token closes the connection before any method runs, as does a request from a peer that never said hello. Electron IPC needs no token: it is in-process and already sandboxed.

## Consequences

- `src/main/index.ts` shrank from 430 to about 320 lines and holds no operation of its own: it supplies the platform (clipboard, dialogs, bundles, rebuild) and installs a transport.
- A host without a window is possible and exists: `src/main/headless.ts` runs `PiHost` with the socket transport only, which is what `npm run smoke:remote-host` drives (hello, bootstrap, prompt, disconnect, reconnect with `lastSeq`, resync).
- Recent projects and the client's caches key on the workspace id: `projects.json` is version 2 (a version 1 file's paths become ids while loading), the bootstrap cache is `tau.bootstrap-cache.v7`, and review state and project actions are stored per id.
- A failed job is a partial failure: the connection stays, other requests keep working. Cancelling a job stops the client waiting and aborts the job's `AbortSignal`, but a command that ignores the signal keeps running to completion in the host. Giving long commands a real abort is follow-up work.
- Adding a method now means one entry in the table and one call in `HostClient`; nothing in the preload changes.

## Out of scope

- **Editor and reveal actions for a remote host.** Without `local-files` those actions are hidden rather than routed back to the client's own machine. Opening a remote file in a local editor needs a file transfer this protocol does not have.
- **TLS.** The socket listens on loopback and is meant to be reached through an SSH tunnel. Certificates, and a host that listens on a public interface, are separate work.
- **Multi-user hosts.** One token means one trust level: whoever has it may do everything the desktop user may do. Per-client identity and permissions build on ticket 17's per-package rights.
- **A directory of hosts**, and web or mobile clients (ticket 19).
