# Host protocol (v1)

The typed host boundary uses `version: 1` focused updates. A client may ignore a
message with an unknown version or type and continue using its last coherent
state; it must not reinterpret it as a `HostSnapshot`.

- `thread-index` and `thread-shell` contain navigation records only.
- `thread-detail` contains the active session's messages, run state, tools and
  usage. Extension state beside a thread (Workspace Kit's turn checkpoints, say)
  travels through the extension's own commands and events, never in the detail;
  a text-empty assistant message stays in the detail only when an extension
  pinned its entry.
- `transcript-page` contains a bounded page plus a cursor for older records and
  an optional `historyCompleteness` value. It answers for any thread the host
  knows, not only one it currently holds a runtime for: a released thread's page
  is projected from its session file, with the same cursors.
- `catalog` contains models, thinking levels, tools, and extension count.
  Legacy v1 catalogs may omit `sessionId` and the image-input capability. The
  decoder accepts both omissions; omitted capability is treated as `false`,
  while a catalog without a session id cannot change the active thread's
  capability.
- `project` contains workspace identity and an optional label an extension
  supplies (Workspace Kit: the Git branch).
- `run` contains lifecycle state for the active session.

Within the typed host/page contracts, `olderCursor` is an opaque
`HostTranscriptCursor`. The renderer and shared desktop contracts retain and
return that value but never inspect its representation or infer a numeric
position from it. The host adapter owns conversion between its local record
coordinates and a Pi bridge's raw coordinates. A host supplies
`cursorBeforeMessageId` (and, when needed, `cursorBoundaries`) so a renderer
cache can select the cursor at the oldest retained user-turn boundary without
interpreting the cursor. Other host adapters may use a different opaque
encoding while preserving the same contract.

An adapter-paged snapshot or page may mark `transcriptWindow: "bounded"`. This
marker means the records already follow the adapter's complete-turn page policy;
the host and renderer must preserve the opaque cursor instead of applying a
second local paging pass.

The Pi socket continues to encode its bridge cursor as a raw opaque string. The
desktop host wraps it at the adapter seam before it enters page state and only
unwraps it when sending a request back to that same bridge. Legacy v1 payloads
that contain the old cursor object are accepted only at the host migration seam;
they are normalized to the opaque host contract or discarded conservatively by
the renderer cache. The renderer never exposes the adapter coordinate or a
`coordinateSpace` field.

The legacy `HostSnapshot` remains a recovery shape for pre-v1 clients only. New
bootstrap responses provide `version`, detail, catalog, project metadata, and the
thread index separately; normal metadata actions return focused updates.

## Pi bridge paging negotiation

The Pi socket keeps wire version `1` for compatibility. A newer Tau host may add
`capabilities: { transcriptPaging: true }` to its `hello` frame. A bridge that
understands paging echoes that capability in the `ready`/`snapshot` payload and
returns a bounded bootstrap window with `messagesOffset`, bounded activity
history, and the `transcript_page` command.

If `hello.capabilities` is absent or does not enable `transcriptPaging`, the
bridge serves the legacy v1 snapshot shape and window, omits paging metadata,
and rejects `transcript_page`. This is the compatibility path for an older host;
the host only sends paging commands after the capability has been echoed. A new
host marks metadata-free legacy windows as `unknown`, so the workbench never
presents that bounded view as the beginning of history and reports that older
history availability cannot be determined. Unknown commands are rejected
explicitly so a client cannot mistake an unsupported extension for an empty page.

## Client-to-host transport (v1)

The updates above are the payloads; how they travel is `src/shared/host-transport.ts`,
`HOST_TRANSPORT_VERSION = 1`. A client sends `HostRequest { id, method, params }`
and receives `HostResponse { id, result? | error? { message, code } }`; the host
sends `HostPush { seq, event }`. Method names are the operations of `HostClient`
(`prompt`, `transcript-page`, `host-extension`, …) and params travel positionally,
in that method's argument order. The host implements them in one table
(`src/main/host-methods.ts`) which decodes every argument through `ipc-input.ts`;
a transport only moves frames in and out of it.

A connection opens with `hello { protocol, token?, lastSeq? }`. The reply names
the host version, its capabilities (`jobs`, `replay`, `local-files`), the pushes
the client missed, and `resync: true` when it cannot be repaired from the
buffer. The host numbers every push and keeps the latest 8 MB of them
(`HOST_PUSH_BUFFER_BYTES`, the newest push always); a client that sees a
gap in `seq` re-hellos with its `lastSeq`, applies what comes back, and on a
resync refetches the bootstrap. `HostConnection` in the renderer owns that and
reports `connected`, `reconnecting` or `resyncing`.

### Coalescing and tool output deltas

Streamed events pass `HostPushCoalescer` (`src/main/host-push-coalescer.ts`)
before they are numbered. For up to 50 ms it joins the `assistant-delta` and
`assistant-thinking` text of one message and keeps only the latest
`tool-update` of one tool; any other event pushes what waits first, so ordering
against everything else holds, and a transport pushes what waits before it
sends a response or a hello reply. A response therefore never overtakes an
event its method caused.

A running tool's output then travels as a change to the output the tool's
previous push carried:
`tool-update-delta { sessionId, id, after, keep, drop, text }` means "take the
output of push `after`, keep its first `keep` characters, drop the `drop` after
them, append `text`". Growth is `drop: 0`; the host's 128 KB tail window
(`boundedToolOutput`) keeps its marker and drops the oldest part. The host
sends the whole `tool-update` for a tool's first update, when the delta would
not be smaller than half the output, and for the next update of every running
tool after a client says hello without `lastSeq` or is told to resync. The
event exists only on the wire: `HostConnection` rebuilds the output and hands
its listeners the ordinary `tool-update`. A delta whose `after` push it never
saw (it joined later, or resynced) is dropped; the whole output follows at the
tool's next update, and `tool-end` always carries the final output.

The socket negotiates `permessage-deflate` with context takeover, the `ws`
default, so small frames compress against the ones before them. The budget
test `src/workbench/host-transfer-budget.test.ts` measures bytes on the wire,
decoded bytes and messages per turn against `hostTransfer` in
`scripts/performance-budgets.json` ([PERFORMANCE.md](PERFORMANCE.md#host-transfer-budget)).

Long operations are jobs, not long responses: `start-job { method, params }`
answers with a `jobId`, progress arrives as `job-progress { jobId, message,
fraction? }`, the outcome as `job-done { jobId, result | error }`, and
`cancel-job` stops waiting. `HostClient` awaits `job-done` internally, so its
callers keep a promise. A job failure is a partial failure: the connection
stays. Which calls are jobs is data: a host extension marks its long commands
with `registerCommand(name, handler, { long: true })` (those also skip the
command timeout), and the client asks with `job-methods`.

Two transports implement this. Electron IPC uses two channels, `tau:request` and
`tau:host-event`; `src/main/ipc-contract.test.ts` checks that the client and the
method table name the same methods. The socket transport (`ws`) serves the same
table on `TAU_HOST_LISTEN=host:port`, authenticated by the 32-byte token in
`~/.tau/host-token` that every hello repeats; a wrong token, or a request before
a hello, closes the connection. Without TLS the token is unencrypted on the
wire, so a plaintext listener refuses a non-loopback address unless
`TAU_HOST_INSECURE=1` says otherwise; with TLS (below) any interface is fine.

The token is the connection's whole trust boundary, and it is not scoped: a
client that holds it may call every method in the table, including the ones that
open a workspace. A client that still speaks paths rather than a `workspaceId`
has that path accepted as given, so a token holder can point the host at any
directory its process can read. Treat the token as "may use this host", not as
"may read these threads": keep it on loopback, behind an SSH tunnel or behind
TLS, and set `TAU_HOST_INSECURE=1` only for a network that is trusted for its
own reasons.

## TLS

A host can offer itself on a network without a tunnel. TLS changes the
transport, not the protocol: the same frames, the same token in every hello,
the same replay and resync. The web client's pairing code and the token file
are handled exactly as without TLS.

**Host side.** `TAU_HOST_TLS=1` makes the socket an HTTPS server (`wss:`),
minimum TLS 1.2. On first start the host creates a self-signed ECDSA P-256
certificate (`src/main/self-signed-certificate.ts`, `node:crypto` and a small
DER builder, no dependency) valid for 825 days, and keeps it in
`<userData>/tls/host-cert.pem` and `host-key.pem`, both 0o600 in a 0o700
directory; a headless host's userData is `~/.tau/headless` unless
`TAU_USER_DATA` moves it. A restart reuses the pair, so the fingerprint stays
the same; a week before it expires, or when the pair is unreadable, a new one
is made, and every client that pinned the old one refuses it. A certificate
of the operator's own replaces all of that: `TAU_HOST_TLS_CERT` and
`TAU_HOST_TLS_KEY` name PEM files (both or neither; the key must belong to
the certificate, and one readable by other users draws a warning). The
headless host prints `tau-host listening on wss://…` and
`tls fingerprint: SHA256 AB:CD:…`, the SHA-256 of the leaf certificate in the
form browsers and `openssl x509 -fingerprint -sha256` show. The web client
server upgrades on the same TLS port, and the pairing link becomes `https://`.

The listen rule (`src/main/host-listen.ts`): TLS may bind any interface;
plaintext may bind loopback; plaintext beyond loopback needs
`TAU_HOST_INSECURE=1`, and the host then prints a `WARNING:` line saying the
token travels in clear text. A host a window supervises (ADR 0021) stays
plaintext on loopback: the supervisor drops the three TLS variables from the
child's environment.

**Client side.** `TAU_HOST_URL=wss://machine:port` is trusted in this order
(`src/main/host-tls-trust.ts`):

1. `TAU_HOST_FINGERPRINT`, when set: that certificate and no other. Colons,
   case and a `sha256:` prefix are optional.
2. An entry for `host:port` in `<userData>/known-hosts.json` (version 1,
   `{ hosts: { "host:port": { fingerprint, trustedAt } } }`, 0o600).
3. A certificate a CA verifies for that name needs no pin (Node's CA store
   answers the probe; Chromium then verifies it as it would any site).
4. Anything else is trust on first use: the window opens, reads the
   certificate without sending anything, and asks on a sheet whether to trust
   that fingerprint. A yes is written to known-hosts; a no connects to nothing.

A pinned certificate is enforced in both of the window's connections.
Chromium's (the renderer's socket) goes through `setCertificateVerifyProc`,
which accepts exactly the pinned fingerprint for that host name and leaves
every other name to Chromium's own verification. The window process's uplink
(`ws`) connects through `pinnedTlsConnect`, which destroys the socket in its
`secureConnect` handler, before the WebSocket opens. Either way the token is
never sent to a certificate that does not match.

A mismatch is final. The workbench loads (or reloads) with `?hostRefused=`,
its `HostConnection` enters the `refused` state, every request fails at once,
nothing reconnects, and the status line shows both fingerprints and how to
repair a certificate that was replaced on purpose (update
`TAU_HOST_FINGERPRINT`, or delete the known-hosts entry). A declined or
unreadable certificate and a malformed `TAU_HOST_FINGERPRINT` end the same
way. A refused page carries no token.

The browser client has no pin of its own: it meets a self-signed host's
certificate as a browser warning, and its fingerprint is what the host
printed.

## The window is always a client

A desktop window speaks this protocol to a host in another process, which it
started and watches itself ([ADR 0021](adr/0021-host-runs-in-its-own-process.md)).
`TAU_HOST_URL=ws://machine:port` (or `wss://`, see [TLS](#tls)) points it at a
host somebody else runs;
`TAU_HOST_INPROCESS=1` restores the old in-process host for one release.

The method table has two halves. `CLIENT_SIDE_METHODS`
(`src/shared/host-transport.ts`) are the ten the client's own machine
answers — `copy-text`, `copy-image`, `read-image-preview`,
`desktop-extensions`, `rebuild-workbench`, `workbench-source`,
`relaunch-workbench`, `install-update`, and `notify` and `set-badge`, the
notification and the app icon's count the OS draws for the window — and they
travel over the window's Electron bridge (`createClientHostMethods`), which
stays installed beside the socket. Everything else goes to the host, whose
own table refuses the ten.
`createHostClient(connection, local)` in the renderer does the routing; a
window without a local side (the browser client) has one connection and sends
everything to the host. `copy-thread-markdown` answers with the text rather
than copying it, because the clipboard belongs to the client.

`desktop-extensions` is the one method both sides implement: the host compiles
the desktop halves and answers with their code, the window publishes that code
under `tau-ext:` and hands the renderer URLs. That is how a window at a host in
another process — or on another machine — loads kits at all.

The window's own process keeps a connection to the host beside its renderer's
(bundles, calls into the window, shutdown). It says hello with
`auxiliary: true`, so the host serves it without counting it as a second
client; a supervisor's liveness probe does the same.

Two methods are not part of the client surface:

- `host.shutdown` exists only in the headless host. The supervisor that started
  the process calls it before it reaches for a signal.
- `client-call-result` answers a call that went the other way. A host extension
  that needs the window's process calls `services.callClient(command, input)`;
  the host publishes a `client-call` push (`{ callId, extensionId, command,
  input }`) and the window's process runs the extension's window half and
  answers with `client-call-result [callId, result, error?]`. The renderer
  ignores the push; a client with no such half answers with an error, which is
  what a kit falls back on.

## Workspace identity

A client never addresses a workspace by a path of the host's filesystem. Every
project the host publishes — `UiProject`, `UiSession`, `HostSnapshot`, the
`project` update and the bootstrap — carries two fields:

- `workspaceId`: opaque. The host mints it from its own id (32 random bytes in
  `<userData>/host-id`, created on first run) and the workspace's canonical
  path, as a truncated SHA-256 of the two, prefixed `ws1_`. A path cannot be
  read out of it, and only the host that minted it can resolve it: an id for a
  workspace this host never published is refused, not guessed at.
- `displayPath`: what the user reads. For a local host that is the absolute
  path, shortened for display by `src/renderer/path-display.ts`.

`cwd`, `UiProject.path` and `UiSession.projectPath` stay on the wire for one
protocol minor version as deprecated display data. Host methods that took a
path (`open-project`, `remove-project`, `new-session`'s cwd,
`prepared-thread-capability`, `run-shell-action`'s expected cwd,
`desktop-extensions`, `inspect-extensions`) accept an id or, for an older
client, a path.

A file inside a workspace travels as `relPath`, a POSIX path relative to the
workspace root, beside the `workspace` id of the project it belongs to. The
host refuses an absolute path or a `..` segment before it resolves anything;
`isWorkspaceRelativePath` (`src/shared/workspace-identity.ts`) is the guard
core uses, and Workspace Kit's `assertWorkspacePath` throws when it fails.
Folder browsing
(`list-directories`, `pick-folder`, `clone`, `create-worktree`) is a host-side
operation and still deals in host paths, but it answers with a
`workspaceId`/`displayPath` pair for anything the client keeps.

The `local-files` capability says whether the host's files are files of the
machine the client runs on. Electron IPC announces it — it is in process. The
socket transport announces it only for a loopback peer and only when the host
was started with `TAU_HOST_LOCAL_FILES=1`. Without it the workbench lists no
editors and offers neither "Open in editor" nor "Copy path"; the renderer reads
it with `useHostCapabilities()`.

## Host extension channel

Host features that are not core do not get an IPC entry each. A host extension registers commands under its id, and the renderer reaches them through one call, `invokeHostExtension(extensionId, command, input)`. Input is untrusted at the host: every command re-reads its fields. A host extension publishes to its desktop counterpart with the `extension-event` global event, `{ extensionId, name, payload }`; core routes it by id and otherwise ignores it. Which commands exist is the extension package's own contract (for Workspace Kit, `kits/workspace/protocol.ts`), never part of this protocol.

## Renderer host client

The renderer never calls the desktop API directly. `src/workbench/host-client.ts`
declares `HostClient`, a transport-neutral interface grouped by concern
(threads, turns, transcript, catalog, extensions, workbench, platform).
`createHostClient(connection)` implements it over a `HostConnection`: every
method is one call of the protocol above. `createElectronHostClient(api)` builds
that connection on the preload bridge, `createSocketHostClient(url, token)` on a
socket; a new transport is a `HostTransport`, with no renderer change beyond
`main.tsx`.

`main.tsx` is the only place a renderer module reads `window.tau`. It builds
the client — from `window.tau`, or from `?host=ws://…&token=…` when a socket
host is named, or leaves it `undefined` in the browser-preview build — says
hello, and mounts `<HostClientProvider client={...}>` around `App`. Components read it with `useHostClient()`; a handful of
module-scope singletons that exist outside the component tree (Workspace
Kit's store and its host-extension client) read the same instance through
`getHostClient()`, which `main.tsx` and the test-only `renderApp` helper keep
in sync with the provider. `src/renderer/host-client-boundary.test.ts` fails
on any other renderer module touching `window.tau`.

## Persisted host state

Every JSON file the host owns on disk goes through `src/main/persisted-json.ts`
(`readPersistedJson` / `writePersistedJson`), not ad hoc `fs` calls. The rules
are the same everywhere:

- A write is `JSON.stringify({ version, ...data }, null, 2)` to a sibling temp
  file (`<name>.<uuid>.tmp`, flag `wx`, mode `0o600`), then a rename; the
  parent directory is created `0o700`. Concurrent writes to the same path are
  queued so the file on disk always ends up as the last call's value.
- A read that hits invalid JSON quarantines the file to
  `<name>.corrupt-<ISO timestamp>` and logs a warning instead of silently
  discarding it; a missing file is not an error.
- `decode(value, version)` accepts legacy shapes (no `version` field, or a
  bare array) so old files keep loading.
- A stored `version` newer than the build's `expectedVersion` is decoded
  best-effort and flagged `readOnly: true`; a mere load never writes the file
  back, so an older build never downgrades a newer one's data.

Current stores:

| File | Owner | Version |
| --- | --- | --- |
| `<userData>/projects.json` | `src/main/project-history.ts` | 2 |
| `<userData>/host-id` | `src/main/workspace-identity.ts` | plain text |
| `<userData>/known-hosts.json` | `src/main/host-tls-trust.ts` | 1 |
| `<agentDir>/tau/claude-runtime-sessions.json` | `kits/claude-code/session-store.ts` | 1 |

Two configuration files are not stores of this kind, because Pi owns one of
them and both are edited by hand as often as by Tau:

| File | Written by | Holds |
| --- | --- | --- |
| `~/.tau/config.json`, `<project>/.tau/config.json` | `HostConfigManager.update` and `clear` | the keys Tau applies itself: theme, transcript detail, costs, favourites, disabled extensions, keybindings, typography, sampling, vim mode, prewarm, the host and restart settings, and the per-extension `options` / `values` records. The two files are the host and project levels of a setting: `get-config` answers them merged, `get-config-layers` apart, and `clear-config` removes keys from one of them |
| `~/.pi/agent/settings.json`, `<project>/.pi/settings.json` | `HostConfigManager.update` and the Pi CLI | the keys Pi applies itself: startup model and thinking level, compaction, retry, steering and follow-up modes, built-in tools, shell path and command prefix, npm command, quiet startup, project trust. Pi's file wins for these, and an `update-config` patch carrying one is written there rather than to Tau's own file ([CORE.md](CORE.md)) |
