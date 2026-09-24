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
the host version, its capabilities (`jobs`, `replay`, `local-files`, `heartbeat`), the pushes
the client missed, and `resync: true` when it cannot be repaired from the
buffer. The host numbers every push and keeps the latest 8 MB of them
(`HOST_PUSH_BUFFER_BYTES`, the newest push always); a client that sees a
gap in `seq` re-hellos with its `lastSeq`, applies what comes back, and on a
resync refetches the bootstrap. `HostConnection` in the renderer owns that and
reports `connected`, `reconnecting` or `resyncing`.

### A link that dies without a close

A phone that sleeps or moves from Wi-Fi to mobile data leaves its socket
half-open: nothing reports a close, and both ends would wait forever. Each end
checks for itself.

- **The host** pings every socket at the WebSocket level every 30 s
  (`SOCKET_PING_INTERVAL_MS`) and drops one that did not answer the previous
  ping, so a vanished client stops counting. A socket that has not said hello
  10 s after it opened is closed with 4408 (`SOCKET_HELLO_TIMEOUT_MS`).
- **The client** cannot see WebSocket pings in a browser, so it sends its own:
  `{ type: "ping", id }` after its hello, answered by `{ type: "pong", id }`,
  and only to a host whose hello reply announced the `heartbeat` capability.
  `createSocketHostTransport` (`src/workbench/host-connection-socket.ts`)
  pings every 15 s and gives up on a socket that delivered nothing within 10 s
  of a ping; any frame counts, not only the pong. A connect that has not opened
  after 10 s and a hello unanswered after 15 s are given up the same way. A
  timer that fires far too late means the page was frozen, not the link, so it
  asks again instead of dropping.
- **Wakes.** The entry point hands the transport a `HostWakeSource`
  (`src/workbench/host-link.ts`): `foreground`, `online`, `offline`,
  `network-change`. A page uses `browserWakeSource()`
  (`src/renderer/browser-wakes.ts`: `visibilitychange`, `resume`, `pageshow`,
  `online`/`offline`, `navigator.connection`); a native shell passes its own
  app-state and network events. A wake while the transport waits for its next
  attempt tries at once; on an open socket it sends a ping with a 3 s deadline;
  a handshake still pending when the network changes is abandoned. While the
  device reports no network the backoff stretches to 15 s.

Dropping a socket costs little: the next hello carries `lastSeq` and the host
replays what was missed. The transport's own state is a `HostLink`
(`open`, `connecting`, `waiting`, `offline`, `closed`, the last round trip and
the next attempt), which `HostClient.getConnectionLink()` exposes and the
title bar shows as a dot for a host on another machine (hidden when the host
has `local-files`). A click on it, or "Retry now" in the reconnecting strip,
calls `reconnectNow()`.

### Which pages may open a socket

The host looks at the `Origin` header of the upgrade before anything else and
closes a refused socket with 4403 (`src/main/host-origin.ts`). No `Origin` is a
client that is not a browser page (the window's own process, a native HTTP
stack, the smokes) and passes. A page passes when its origin is the listener's
own (the `Host` it was reached by), when it is Electron's `file://` window on
loopback, or when it is listed in `TAU_HOST_ALLOWED_ORIGINS` (comma-separated,
for a native shell's scheme or a proxy that rewrites `Host`); a development
window's `TAU_DEV_SERVER_URL` is added by itself. The token in the hello stays
the real gate; the check keeps a page on another site, or an opaque `null`
origin, from trying one. The socket client stops on 4403 as it does on 4401 and
shows why.

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
them, append `text`". Growth is `drop: 0`; a sliding tail keeps its marker and
drops the oldest part. The host sends the whole `tool-update` for a tool's
first update, when the delta would not be smaller than half the output, and for
the next update of every running tool after a client says hello without
`lastSeq` or is told to resync. The event exists only on the wire:
`HostConnection` rebuilds the output and hands its listeners the ordinary
`tool-update`. A delta whose `after` push it never saw (it joined later, or
resynced) is dropped; the whole output follows at the tool's next update.

A client receives a running tool's output whole while it is at most 16 KB
(`INLINE_TOOL_OUTPUT_CHARS`, `src/main/client-tool-output.ts`). Past that it
receives the last 4 KB from a line start, behind the line
`[Earlier output is not sent while the tool runs.]`: enough for the live tail a
running row shows, and a delta against it stays small however fast the tool
writes.

A tool's end refers to the output the client already has:
`tool-end-delta { sessionId, tool, after, length, keep, drop, text }` is the
`tool-end` whose `tool` lacks `output`, which is the output of push `after`
with the change applied (usually none). The host sends it when the tool
streamed and its final output is at most 16 KB, and a whole `tool-end`
otherwise. A client that never saw push `after` ends the tool with its output
deferred (below), `length` characters long.

A settled tool whose output is longer than 16 KB reaches clients without it,
in every event, thread detail and transcript page: `outputDeferred: true` and
`outputLength` (characters) take the place of `output`. The workbench shows the
size on the row and asks for the output when the row opens:
`tool-output [sessionId, toolCallId]` answers
`{ toolCallId, output, outputTruncated?, fullOutputAvailable? }`, the output as
the transcript would have carried it (the host's 128 KB tail of the result).
It reads the thread's session file for Pi and the turn activity a streamed
backend keeps; it answers `undefined` for a tool the host no longer has.
`read-tool-output` still reads the complete result for "copy full output".

A settled `thread-detail` repeats its turn's tools: `turnActivity` is the last
entry of `turnActivityHistory`. The push leaves it out,
`thread-detail-compact { update, activityFromHistory: true }`, and
`HostConnection` puts it back from that entry. A detail whose `turnActivity`
differs (a running tool's live output) keeps it.

### Answer text travels once

A message's text streams as `assistant-delta` and `assistant-thinking`, and
its end refers to that:
`assistant-end-delta { sessionId, message, after, text, thinking? }` is the
`assistant-end` whose `message` lacks `text` and `thinking`. `text` (and
`thinking`, when the message has it) is a change to what the message streamed
as of push `after`, its `assistant-start` or its last delta, in the shape of a
tool output delta; usually it keeps everything and adds nothing. A thread
detail then refers to the push that ended a message:
`thread-detail-compact { update, texts: { [messageId]: seq } }` sends each
named message with an empty `text` and without `thinking`, which are those of
the `assistant-end` numbered `seq`. After an `assistant-anchor` the host
names that message by its persisted entry id too, which is the id a Pi
detail uses. Both sides forget a thread's ended messages when its next run
starts, and the host keeps the latest 64 (`REMEMBERED_ENDED_MESSAGES`).

The host sends the whole `assistant-end`, and the whole text in a detail, for
a message that streamed nothing, for one shorter than 64 characters (a
reference would cost as much), and for every message that streamed or ended
before a client said hello without `lastSeq` or was told to resync. A client
therefore only meets references it can resolve. If it meets one anyway (a
push it could not decode, say), `HostConnection` drops the push, says hello
again without `lastSeq` and refetches the bootstrap: a resync, which also makes
the host send whole texts again.

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
table on `TAU_HOST_LISTEN=host:port`; every hello repeats a token, and a wrong
one, or a request before a hello, closes the connection with 4401. Without TLS
the token is unencrypted on the wire, so a plaintext listener refuses a
non-loopback address unless `TAU_HOST_INSECURE=1` says otherwise; with TLS
(below) any interface is fine.

## Tokens and pairing

Two kinds of token open a socket ([ADR 0023](adr/0023-client-tokens-and-pairing.md),
[ADR 0024](adr/0024-pairing-allowed-on-the-host.md), `src/main/host-access.ts`):

- **The host token**, 32 random bytes as hex in `TAU_HOST_TOKEN_FILE`
  (default `~/.tau/host-token`, 0o600 in a 0o700 directory). It belongs to the
  owner: the window beside the host reads the file, a window elsewhere gets it
  as `TAU_HOST_TOKEN`. The host re-reads the file when it changes on disk.
- **A client token**, `tauc.<24 hex id>.<43 base64url secret>`, one per paired
  device. The host keeps the id, a label, the device its user agent named, when
  and from where it paired and was last seen, its preset (`full` or
  `read-only`), its idle timeout (30, 90 or 365 days, or never), its last
  change, and only the SHA-256 of the secret, in `<userData>/paired-clients.json`
  (version 2; version 1 records read as Full with 90 days).

A token unused for its idle timeout stops working and its record is dropped.
A hello or a request is a use, and so is being connected: the host marks every
connected device as seen once a minute, so a phone whose app sits open in the
background does not expire. Heartbeat pings (below) do not count on their own.

### Pairing over the socket

A device without a token asks on the socket, before any hello:

```
→ { type: "pair", id, pair: { code?, name?, commitment? } }
← { type: "pair-reply", id, reply: { state: "challenge", requestId, hostNonce } }   // only with a commitment
→ { type: "pair-reveal", id, nonce }
← { type: "pair-reply", id, reply: { state: "waiting", requestId, verification, expiresAt } }
← { type: "pair-reply", id, reply: { state: "approved", token, clientId, access } }   // or denied / expired
```

`code` comes from a pairing link and is spent by the attempt; without one the
owner is asked all the same. `name` is how the device calls itself. Nobody gets
a token before the owner allows the request on the host
(`connections-approve`), after comparing the six digits of `verification`
with the device's. The request waits two minutes. A refusal before anyone is
asked is `{ state: "refused", reason }`: `unknown-code` (expired, spent,
revoked and invented codes alike), `busy`, `rate-limited` (with
`retryAfterMs`) or `invalid`. After `approved` the device says hello with the
token on the same socket; every other end closes the socket (1000, the state).
A socket that asked is kept past the hello deadline until its request ends,
and gets a new deadline once it is let in.

A device that pinned the host's self-signed certificate sends `commitment`,
the SHA-256 (hex) of a random 32-byte nonce, and reveals the nonce after the
host's challenge. Both sides then compute the digits from the certificate's
fingerprint and both nonces (`pairingVerificationCode`, `src/shared/pairing.ts`),
and the device shows its own. The host takes the fingerprint from the
certificate the socket's own listener presented, so it matches what the
device pinned on any TLS listener. A relay presenting another certificate cannot
make the two screens agree, since it had to pick the host's nonce before it
learned the device's. A device that cannot pin (a browser) sends no
commitment, and the host picks the digits. The device-side client is
`pairWithHost` in `src/workbench/host-pairing.ts`.

Limits: 20 open links; five requests waiting at once; without a link, one per
address and three in all, and an address the owner denied waits ten minutes;
per address, five attempts (twenty from this machine on the loopback
listener), then a backoff doubling up to a minute. Each listener kind counts
apart, and behind a proxy the address is the one it forwarded.

`POST /pair` of the web client's server answers 410.

### Pairing links

`https://<address>:<port>/#pair=<code>&k=<kind>&fp=<hex>&host=<id>&name=<host name>&e=<kind>:<url>…`
(`pairingUrl`, `parsePairingPayload` in `src/shared/connections.ts`). The origin
is the address the link was made for and `k` its kind; `e` repeats every other
network address with its kind (`lan`, `mdns`, `tailscale`, `magicdns`), so a
device picks one it reaches; `fp` is the SHA-256 of the certificate the
network listeners present (network access's, else the host's own listener's;
absent in plaintext), which a device pins on each address that presents it;
`host` is the id in `<userData>/host-id`. A link made for loopback names no
other address. The page takes the fragment out of the address bar before it
renders.

### Presets

A request's principal is `{ kind: "workbench-client", connection,
pairedClient?, readOnly?, audit? }`, assigned by the transport per request and
carried into jobs, so a new preset applies to the next call. Every method has
an access class in `HOST_METHOD_ACCESS` (`src/main/host-method-access.ts`):

- `read`: a Read-only device may call it.
- `write`: it changes something, runs something, or reaches the host
  machine's own screen or clipboard. A Read-only device gets `forbidden`.
  A method missing from the table counts as `write`.
- `owner`: the Connections methods (including `connections-set-network` and
  `connections-reload-certificate`) and `host.shutdown`. They need the host
  token on a connection from this machine through the loopback listener; every
  paired device, and the host token over a LAN or proxy listener, gets
  `forbidden`.

`host-extension` is `read` at this level; the extension registry then refuses a
Read-only device every command not registered with `{ access: "read" }`.
`start-job` checks the method it would run. The hello reply of a Read-only
device carries `access: "read-only"`. Every change a paired device makes, and
every refusal, is recorded: the last one on its record (`lastAction`: the
method or `<extension>/<command>`, never the input), each one in the host log
(`access.action`, `access.refused`).

### Connections methods

Only the owner's connections may call these; a paired device gets `forbidden`:

| Method | Params | Result |
|---|---|---|
| `connections-list` | – | `UiConnections`: host id, endpoints, TLS fingerprint, token path, open links, waiting requests, paired devices, host-token connections (`src/shared/connections.ts`) |
| `connections-create-link` | `{ label?, lifetimeMs?, access? }` | `{ link, code, urls }`; the code is answered this once |
| `connections-revoke-link` | `id` | `{ revoked }` |
| `connections-approve` | `id, { access?, label? }` | `{ approved }`; false when the device stopped waiting |
| `connections-deny` | `id` | `{ denied }` |
| `connections-update-client` | `id, { label?, access?, idleTimeoutDays? }` | `{ updated }`; a new timeout counts from now |
| `connections-revoke-client` | `id` | `{ revoked }`; its open connections close with 4401 `revoked` |
| `connections-revoke-others` | – | `{ revoked }`: how many devices were signed out |
| `connections-rotate-host-token` | – | `{ token }`; every other host-token connection closes with 4401 `token-rotated` |
| `connections-set-network` | `{ lan?, tailscale?, announce?, port?, proxyPort?, certificate?: { certPath, keyPath } \| null }` | `UiNetworkAccess`; opens and closes the listeners of [network access](#network-access) in the running host, and its [Bonjour](#bonjour) announcement |
| `connections-discover` | `{ timeoutMs? }` (default 3000, 500–10000) | `UiDiscoveredHosts`: `{ hosts, serviceType, problem? }`, the Tau hosts that answered while this host looked ([Bonjour](#bonjour)) |
| `connections-reload-certificate` | – | `{ changed }`; every listener re-reads its certificate |

A host without a socket answers them with `unsupported`. Any change to
requests, devices or links pushes `{ type: "connections-changed" }` without
details; an owner's window asks `connections-list` what changed.

The 4401 close carries a reason: `unauthorized` (a token nobody knows, or one
that expired unused), `revoked`, `token-rotated`. The socket client hands it
to `onUnauthorized` and stops reconnecting. A window's own process re-reads its
supervised host's token file once after a 4401 and tries again, which is how
it follows a rotation.

A Full token is not a sandbox: a device that holds one may call every method a
workbench uses, including the ones that open a workspace or a terminal. A client
that still speaks paths rather than a `workspaceId` has that path accepted as
given, so a token holder can point the host at any directory its process can
read. Read only narrows what it can change, not what it can read. Keep tokens
on loopback, behind an SSH tunnel or behind TLS, and set `TAU_HOST_INSECURE=1`
only for a network that is trusted for its own reasons.

## TLS

A host can offer itself on a network without a tunnel. TLS changes the
transport, not the protocol: the same frames, the same token in every hello,
the same replay and resync. Pairing and tokens are handled exactly as without
TLS; a link then starts with `https://` and carries the fingerprint.

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
plaintext on loopback: the supervisor drops the three TLS variables and
`TAU_HOST_PROXY_LISTEN` from the child's environment. Listeners beyond it are
[network access](#network-access), which the host reads from its own settings.

**Renewal.** A running host re-reads its certificate when the files change on
disk (checked every minute) and on `connections-reload-certificate`, and swaps
it into its listeners without closing a connection (`HostTlsReloader`). A pair
that does not load leaves the old certificate in place and is not tried again
until the files change once more. A self-signed certificate due for renewal is
renewed the same way. A certificate of the operator's own draws a warning two
weeks before it runs out; `tailscale cert`, for one, lasts 90 days.

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

## Network access

Settings → Connections → Network access opens listeners beside the host's own
(`src/main/host-network.ts`). The host reads the settings from
`<userData>/network.json` (0o600) and applies a change at once: a listener
opens or closes in the running process, and closing one closes every
connection that came through it. Nothing restarts. Both switches are off by
default and combine:

| Switch | Listens on | Speaks |
|---|---|---|
| Local network | `[::]:<port>`, dual-stack; `0.0.0.0` on a machine without IPv6 | TLS |
| Tailscale | each Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48) on `<port>`, so the LAN sees no open port; not needed while Local network covers them | TLS |
| Tailscale | `127.0.0.1:<proxyPort>`, for a reverse proxy such as `tailscale serve` | plain HTTP |

`port` (default 7788) and `proxyPort` (default 7789) are fixed, so a paired
device and a `tailscale serve --bg` mapping find the host again after a
restart. The TLS certificate is the self-signed one of [TLS](#tls) or one of
the user's own (`certificate`); a pair that does not load is refused before
it is kept. A listener that cannot open (a port in use, a certificate that
does not load, no Tailscale address yet) is reported in `problems`, never
replaced by a plaintext one. The host looks again every minute, so a
Tailscale address that appears later is served then.

**Listener trust** (`src/main/host-local-files.ts`). Every listener tells
the transport what it may conclude about a peer:

- `loopback`, the host's own listener: a 127.0.0.1 peer is this machine. It
  alone may be told `local-files` (with `TAU_HOST_LOCAL_FILES=1`), counts as
  a local window for `callClient`, and gets the larger pairing burst.
- `network`: nothing is local, whatever the address.
- `proxy`: bound on loopback, yet every peer is remote, because a proxy
  delivers them all from 127.0.0.1. No `local-files`, no local window, a
  strict pairing limit of its own, and the peer's address is the last
  `X-Forwarded-For` hop, the one the proxy added.

The origin check at the upgrade follows the same trust. `file://` counts as
a window on this machine only on the loopback listener. A proxy listener also
accepts a page whose origin is the host the proxy was reached at, the last
`X-Forwarded-Host` hop, because `tailscale serve` may hand the request on
with `Host: 127.0.0.1:<proxyPort>`. The origin of every published endpoint
(LAN address, `.local`, MagicDNS) is allowed too; the host recomputes the list
when network access changes and every minute.

A hand-started host opens a proxy listener of its own with
`TAU_HOST_PROXY_LISTEN=127.0.0.1:<port>` (loopback only) and prints
`tau-host proxy listener on http://…`.

### Bonjour

While the Local network listener is open and `announce` is on (the default),
the host announces it as a DNS-SD service (`src/main/host-discovery.ts`):

| Field | Value |
|---|---|
| Type | `_tau._tcp` (`TAU_BONJOUR_SERVICE_TYPE` overrides it; isolated instances use `_tau-test._tcp`) |
| Instance | the machine's host name without `.local`; the network may suffix it after a clash |
| Port | the Local network listener's, TLS |
| TXT | `v=1`, `id=<host id>`, `fp=<SHA-256 of the certificate, 64 hex>` |

Nothing in it is secret: the id and the fingerprint are in every pairing link
too. A device that found the host pins `fp`, asks to pair over the socket
without a code, and waits for the owner like any other request (`pairWithHost`,
[Pairing over the socket](#pairing-over-the-socket)). `readTauServiceTxt`,
`discoveredHosts` and `discoveredEndpoints` in `src/shared/discovery.ts` read a
record the same way on every client.

The host uses the system's responder, never a multicast socket of its own:
`dns-sd -R` on macOS, `avahi-publish -s` on Linux (it needs `avahi-daemon`; without
Avahi the state is `unavailable`), and `DnsServiceRegister` of `dnsapi.dll`
through Windows PowerShell on Windows 10 1809 and later. On POSIX the tool runs
under a small `sh` wrapper that ends it when its stdin closes, so the
announcement goes when the host stops or dies. A changed port or certificate
withdraws the old announcement before the new one goes up; one that stopped
is started again at the next minute's look. `UiNetworkAccess.announcement`
reports `starting`, `announced` (with the name the network settled on),
`failed` or `unavailable`, and a change pushes `connections-changed`.

Registering and browsing are local network operations that macOS 15 and later
asks the user about once per app (Apple TN3179). The question comes when the
owner turns on Local network or presses **Find Machines…**, never at start: a
`network.json` written before Bonjour existed reads `announce` as off, and
browsing runs only on `connections-discover`. It lists for three seconds with
`dns-sd -Z` (then looks up the `.local` name's addresses), `avahi-browse
--parsable --resolve --terminate`, or `DnsServiceBrowse` and `DnsServiceResolve`,
and marks the host's own record `self`. The macOS app declares
`NSLocalNetworkUsageDescription` and `NSBonjourServices` (`electron-builder.yml`).

**Endpoints.** `connections-list` names every URL a device may use, best
first, each with a `kind` a device can choose by: `lan` (with its
`interface`, IPv4 before IPv6), `mdns` (`<name>.local`: macOS's
LocalHostName, else the host name), `magicdns`, `tailscale` and `loopback`.
Link-local addresses are left out. The MagicDNS name comes from a reverse
lookup of the machine's own Tailscale address at 100.100.100.100, so nothing
runs the Tailscale CLI; names are looked up only once a listener is beyond
loopback. A pairing link carries one URL per endpoint.

## The window is always a client

A desktop window speaks this protocol to a host in another process, which it
started and watches itself ([ADR 0021](adr/0021-host-runs-in-its-own-process.md)).
`TAU_HOST_URL=ws://machine:port` (or `wss://`, see [TLS](#tls)) points it at a
host somebody else runs;
`TAU_HOST_INPROCESS=1` restores the old in-process host for one release.

The method table has two halves. `CLIENT_SIDE_METHODS`
(`src/shared/host-transport.ts`) are the ones the client's own machine
answers — `copy-text`, `copy-image`, `read-image-preview`, `share-file`,
`desktop-extensions`, `rebuild-workbench`, `workbench-source`,
`relaunch-workbench`, `install-update`, `notify` and `set-badge`, the
notification and the app icon's count the OS draws for the window, and
`context-menu`, a right-click menu the OS draws at a point of the page
(`Menu.popup`; the answer is `{ id }` of the chosen item, or `{}`), and
`window-action`, the page's side of the app around it
(`src/shared/window-shell.ts`: Paste as Text, the answer to a quit, the
downloaded update and release notes on load, Check for Updates) — and they
travel over the window's Electron bridge (`createClientHostMethods`), which
stays installed beside the socket. Everything else goes to the host, whose
own table refuses them.
The window's process speaks to its page with pushes on the same bridge:
`app-update` and `window-shell` (a menu item the page carries out, the quit
shortcut's hint, a quit waiting for `answer-quit`). The client forwards those
two types from its local connection beside the host's pushes and nothing
else; a quit whose page does not answer within two seconds goes ahead.
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
client; a supervisor's liveness probe does the same. Its hello also carries
`windowHalves` (the extension ids whose window half it runs, `window` for
core's folder picker) and a random `windowId`; the renderer's hello repeats
the `windowId` (the window passes it as `?windowId=`). The host reads
`windowHalves` only from an auxiliary hello, and says hello again whenever the
window has loaded its halves.

Two methods are not part of the client surface:

- `host.shutdown` exists only in the headless host. The supervisor that started
  the process calls it before it reaches for a signal.
- `client-call-result` answers a call that went the other way. A host extension
  that needs the window's process calls `services.callClient(command, input)`;
  the host sends a `client-call` frame (`{ type: "client-call", call: { callId,
  extensionId, command, input } }`) to **one** connection, and that window's
  process runs the extension's window half and answers with
  `client-call-result [callId, result, error?]`. The frame is not a push: it
  has no sequence number, is not buffered and is never replayed. The addressee
  is the caller's own window (the connection whose request is running, or the
  auxiliary connection with the same `windowId` and the same credential), else
  the newest host-token window on loopback that named the half. A paired
  client's window is asked only for calls its own requests caused.
  `pick-directory` goes only to the caller's window when there is a caller.
  With no addressee the call fails at once. An answer counts only from the
  connection the call was sent to; any other is dropped without a reply that
  would tell it apart from an unknown id. When the addressee disconnects, its
  open calls fail.

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
| `<userData>/paired-clients.json` | `src/main/host-access.ts` | 2 |
| `<agentDir>/tau/claude-runtime-sessions.json` | `kits/claude-code/session-store.ts` | 1 |

Two configuration files are not stores of this kind, because Pi owns one of
them and both are edited by hand as often as by Tau:

| File | Written by | Holds |
| --- | --- | --- |
| `~/.tau/config.json`, `<project>/.tau/config.json` | `HostConfigManager.update` and `clear` | the keys Tau applies itself: theme, transcript detail, costs, favourites, disabled extensions, keybindings, typography, sampling, vim mode, prewarm, the host and restart settings, and the per-extension `options` / `values` records. The two files are the host and project levels of a setting: `get-config` answers them merged, `get-config-layers` apart, and `clear-config` removes keys from one of them |
| `~/.pi/agent/settings.json`, `<project>/.pi/settings.json` | `HostConfigManager.update` and the Pi CLI | the keys Pi applies itself: startup model and thinking level, compaction, retry, steering and follow-up modes, built-in tools, shell path and command prefix, npm command, quiet startup, project trust. Pi's file wins for these, and an `update-config` patch carrying one is written there rather than to Tau's own file ([CORE.md](CORE.md)) |
