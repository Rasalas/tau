# ADR 0010: One versioned host protocol, Electron IPC as a transport

## Status

Accepted, 2026-09-04. Amended 2026-09-05: workspace identity (step 6 of ticket 18), a client window, and a bind rule. Amended 2026-09-22: TLS with a pinned certificate. Amended 2026-09-23: a lean push stream; no repeated outputs. Amended 2026-09-23 by [ADR 0023](0023-client-tokens-and-pairing.md): the host token is the owner's; other clients pair for tokens of their own.

## Context

The renderer reached the host through about forty `tau:*` IPC channels: one `ipcMain.handle` per operation in `src/main/index.ts`, one method per operation in `src/preload/index.cts`, and one push channel for host events. The shape was Electron's, not Tau's. Three consequences followed.

Nothing else could speak it. `HostClient` (ADR-less, `docs/host-protocol.md`) already declared a transport-neutral surface, but its only implementation delegated to `window.tau`, so a host on another machine had no boundary to answer at.

Nothing could notice a loss. Pushes were unnumbered, so a client that missed events — a suspended host, a reloaded window — could not tell, and there was no way back other than restarting the app.

Long operations were plain promises. A clone or a workbench rebuild occupied one request until it finished, reported no progress, could not be cancelled, and ran against the host extension registry's 30-second command timeout.

## Decision

There is one client-to-host protocol, `HOST_TRANSPORT_VERSION = 1`, declared in `src/shared/host-transport.ts`: `HostRequest { id, method, params }`, `HostResponse { id, result? | error? { message, code } }`, `HostPush { seq, event }`, and a `hello` that carries the protocol version, an optional token and an optional `lastSeq`. Its reply names the host version, its capabilities, the pushes the client missed, and whether it must resync. Every frame has a hand-written decoder, in the style of `host-protocol.ts`; a rejected frame is never echoed back.

Method names are the former channels without `tau:` (`send-prompt` is `prompt`, `tau:transcript-page` is `transcript-page`). Params travel positionally, in the order of the matching `HostClient` method. The host implements them in one table, `src/main/host-methods.ts`, which still decodes every argument through `ipc-input.ts`; a transport only moves frames in and out of that table. `src/main/ipc-contract.test.ts` compares the method names the renderer sends with the table's keys, in both directions.

Two transports exist. Electron IPC (`host-transport-electron.ts`) uses exactly two channels: `tau:request` and `tau:host-event`. A local WebSocket (`host-transport-socket.ts`, dependency `ws`) serves the same table on `TAU_HOST_LISTEN=host:port`. The renderer picks the socket with `?host=ws://…&token=…`, otherwise the preload bridge.

Pushes are numbered by one `HostPushLog` per host and buffered (the last 500; by bytes since the 2026-09-23 amendment). `hello` with `lastSeq` answers with the missed pushes, or with `resync: true` when the gap fell out of the buffer or the host restarted. `HostConnection` in the renderer owns that: it detects a gap in the sequence, re-hellos, applies what it gets, and on a resync refetches the bootstrap and republishes it as the updates the workbench already applies. Its state (`connected`, `reconnecting`, `resyncing`) is visible in the workbench.

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

Authentication of the socket transport is a 32-byte token in `~/.tau/host-token`, written 0o600 in a 0o700 directory on first listen and repeated in every hello. A wrong or missing token closes the connection before any method runs, as does a request from a peer that never said hello. Electron IPC needs no token. It verifies that the sender is the current
workbench WebContents and its main frame before answering hello or dispatching
a method. Sandboxing by itself does not authenticate an IPC sender. See
[ADR 0020](0020-host-command-authority.md).

## Amendment, 2026-09-05: a window that is only a client

The socket transport made a host without a window possible; the other half is a window without a host. `TAU_HOST_URL=ws://machine:7788` makes the Electron main process open the window and nothing else: no `PiHost`, no Pi, no project history of its own. It passes the URL to the renderer as the `?host=` it already understands, together with a token read from `TAU_HOST_TOKEN` or from `~/.tau/host-token` on the client machine — never created there, because the secret belongs to the host.

The in-process transport is still installed, so a stray call has somewhere to land, but its method table is `createUnsupportedHostMethods`: every name of the real table, each throwing `unsupported`. That keeps `ipc-contract.test.ts` meaningful for both tables and makes a mistake say why instead of quietly answering with the client machine's clipboard or files. Its hello announces no capabilities; the socket transport's hello announces `jobs` and `replay` but not `local-files`, which is how a client learns that the paths it receives are not its own.

Because the token travels in clear text, a listener is now refused on anything but a loopback address unless `TAU_HOST_INSECURE=1` says otherwise (`host-listen.ts`). Reaching a host on another machine means forwarding the port over SSH. The page's CSP allows `ws:` and `wss:` in `connect-src`, without which a window on `file://` could not open the socket at all.

## Amendment, 2026-09-22: TLS with a pinned certificate

The socket may speak TLS (`TAU_HOST_TLS=1`, or `TAU_HOST_TLS_CERT` and `TAU_HOST_TLS_KEY`), and a TLS listener may bind any interface; the bind rule above now applies to plaintext only, and `TAU_HOST_INSECURE=1` prints a warning. The host's own certificate is self-signed and kept under its userData, so it has no CA to vouch for it. A client therefore pins the SHA-256 fingerprint of the certificate, the way SSH pins a host key: from `TAU_HOST_FINGERPRINT`, from its `known-hosts.json`, or after the user confirms the fingerprint on first use. A certificate a CA verifies needs no pin. A pinned host that presents another certificate is refused before the token leaves the client, and the window stays in a `refused` state instead of reconnecting.

We chose pinning over running a Tau CA, which would need a second secret to protect and a way to distribute its root, and over an ACME certificate, which needs a public name. Tailscale and similar networks give a stable address; the fingerprint gives the identity. Details are in `docs/host-protocol.md` under TLS.

## Amendment, 2026-09-23: a lean push stream

A turn cost a socket client about as many bytes as its tool output times the number of updates: every `tool-update` carried the whole output (up to 128 KB), every token was its own push, and nothing was compressed. A recorded one-tool turn moved 232 KB in 118 frames; a turn with a 1.1 MB tool output moved 13 MB. The buffer of 500 pushes held seconds of streaming, so a short disconnect in a long turn ended in a resync.

The host now coalesces streamed text and tool updates for up to 50 ms before it numbers them, and sends a running tool's output as a delta against the push that carried it before (`tool-update-delta`), whole again when a client starts from a snapshot. `HostConnection` rebuilds the output, so nothing above the connection sees the difference. The socket negotiates `permessage-deflate`. The push buffer is bounded by bytes (8 MB), not by count. Details are in `docs/host-protocol.md`; the transfer budget test gates the result.

We chose deltas keyed by sequence over deltas keyed by length, because a length can repeat once the tail window keeps the output at its cap, while a sequence names exactly one push. We chose a whole output on a client's arrival over one every second, because steady streaming then carries no repeated output at all.

## Amendment, 2026-09-23: no repeated outputs

After the lean stream, most of a turn's bytes were outputs a client had already received: `tool-end` carried the final output again, the settled `thread-detail` carried each tool twice (`turnActivity` and the last `turnActivityHistory` entry), and a tool writing faster than it could be read streamed every byte of it. T3 Code sends no command output at all.

Now `tool-end` refers to the push that carried the output (`tool-end-delta`), and a settled detail's `turnActivity` travels once, inside its history (`thread-detail-compact`); `HostConnection` rebuilds both. A settled output longer than 16 KB reaches clients as its size (`outputDeferred`, `outputLength`) and loads through `tool-output` when its row opens; a running one longer than 16 KB streams its last 4 KB. Unlike the two wire events, the deferred output is a change of the contract: a client that renders a tool has to load its output.

We chose to defer by size over deferring every output, because a short output costs less than a request and small results (a spawned thread's JSON, a file edit's message) are read by tool renderers. We chose a 4 KB live tail over the full 128 KB window because a running row shows five lines, and a tail keeps a flood of output from costing more than those lines.

## Amendment, 2026-09-23: answer text once

The answer then made up most of a long turn: a 151 KB answer arrived as deltas, again in `assistant-end`, and again in the settled detail's messages. Now `assistant-end` refers to the text its message streamed (`assistant-end-delta`), and a detail refers to the `assistant-end` that carried a message's text (`thread-detail-compact` with `texts`); `HostConnection` puts both back. The host sends whole texts again after a client starts from a snapshot, as it does for tool outputs.

We chose to recover a reference the client cannot resolve by starting over from the bootstrap, over asking the host for the missing text, because the host only sends references a client can resolve; the fallback covers a defect, and a resync is the path that already repairs any state the push stream left wrong.

## Amendment, 2026-09-24: links that die without a close

A client on a phone loses its socket without a close event when the phone sleeps or changes networks, and a page on another site could open a socket to a host on loopback. Both ends now check liveness: the host pings every socket at the WebSocket level and drops one that stops answering, closes a socket without a hello after 10 s (4408), and answers an application `ping` with `pong` once the hello is accepted, announced as the `heartbeat` capability, so a client never pings an older host. The browser client sends those pings, gives up a connect or a hello that hangs, and checks the link or skips the backoff when the page comes back to the foreground or the network changes; wakes come from the entry point, so a native shell supplies its own. The host refuses an upgrade whose `Origin` is neither its own, Electron's local `file://` window nor listed in `TAU_HOST_ALLOWED_ORIGINS`, with 4403, which the client treats as final. `docs/host-protocol.md` has the numbers.

## Consequences

- `src/main/index.ts` shrank from 430 to about 320 lines and holds no operation of its own: it supplies the platform (clipboard, dialogs, bundles, rebuild) and installs a transport.
- A host without a window is possible and exists: `src/main/headless.ts` runs `PiHost` with the socket transport only, which is what `npm run smoke:remote-host` drives (hello, bootstrap, prompt, disconnect, reconnect with `lastSeq`, resync).
- Recent projects and the client's caches key on the workspace id: `projects.json` is version 2 (a version 1 file's paths become ids while loading), the bootstrap cache is `tau.bootstrap-cache.v7`, and review state and project actions are stored per id.
- A failed job is a partial failure: the connection stays, other requests keep working. Cancelling a job stops the client waiting and aborts the job's `AbortSignal`, but a command that ignores the signal keeps running to completion in the host. Giving long commands a real abort is follow-up work.
- Adding a method now means one entry in the table and one call in `HostClient`; nothing in the preload changes.

## Out of scope

- **Editor and reveal actions for a remote host.** Without `local-files` those actions are hidden rather than routed back to the client's own machine. Opening a remote file in a local editor needs a file transfer this protocol does not have.
- **TLS.** Done in the 2026-09-22 amendment. Still open: rotating a self-signed certificate without every client re-pinning it, and pinning in the browser client, which only has the browser's own certificate warning.
- **Multi-user hosts.** One token means one trust level: whoever has it may do everything the desktop user may do. Per-client identity and permissions build on ticket 17's per-package rights.
- **A directory of hosts**, and web or mobile clients (ticket 19). A browser client would additionally need the host to serve the built assets and a way to enter a token without a native dialog; none of that exists.
