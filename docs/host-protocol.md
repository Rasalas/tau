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
  supplies (Workspace Kit: the Git branch). Its `sessionId` names the thread
  the project belongs to: every client receives it, but a client applies it
  only to that thread, or once that thread's detail arrives. Another client
  opening a project moves the host, not this client's thread. An update
  without `sessionId` (an older host) applies to the thread on screen.
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

A bootstrap's thread index also carries `runs`: the threads running on the host
and when each run began, by the host's clock. A client that starts or resyncs
takes it over its own run state, so a phone that connects mid-run, or after an
automatic retry started the run again, shows it with the same start as the
window that watched it begin. Live, `agent-status` with `running: true` carries
that start as `startedAt`; a retry keeps the first one. Index pushes leave it
out, and a client keeps its run state through them.

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

A connection opens with `hello { protocol, token?, lastSeq?, subscription? }`. The reply names
the host version, its capabilities (`jobs`, `replay`, `local-files`, `heartbeat`, `subscriptions`), the pushes
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
  ping and sent nothing since, not even part of a frame, so a vanished client
  stops counting while one uploading a large frame slowly does not. A socket that has not said hello
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
client that is not a browser page (the window's own process, the native app's
pinned sockets, the smokes) and passes. A page passes when its origin is the listener's
own (the `Host` it was reached by), when it is Electron's `file://` window on
loopback, or when it is listed in `TAU_HOST_ALLOWED_ORIGINS` (comma-separated,
for a native shell's scheme or a proxy that rewrites `Host`); a development
window's `TAU_DEV_SERVER_URL` is added by itself. The token in the hello stays
the real gate; the check keeps a page on another site, or an opaque `null`
origin, from trying one. The socket client stops on 4403 as it does on 4401 and
shows why.

### Which pushes a client receives

Before subscriptions every push went to every client, so a phone showing one
thread was sent the tool output of every other thread and every terminal's
bytes. Now a socket client can say what it shows (`HostSubscription`,
`src/shared/host-transport.ts`):

```ts
{ threads: string[]; topics: string[]; requests?: string[] }
```

- **Everyone** still gets whatever is not about one thread's stream: the
  thread index and shells, `agent-status`, `run`, catalogs and projects,
  questions (`extension-ui-prompt`), delivery outcomes
  (`new-thread-delivery-settled`, `user-message-failed`,
  `prompt-without-user-turn`), job progress, `event-log` without a thread and
  extension events without a topic.
- **Only the threads it names**: `assistant-*`, `user-message`, `tool-*`,
  `queue`, `notice` and a thread's `error` and `event-log`, the pushed
  `thread-detail` and the wire events that stand for them
  (`src/main/host-push-scope.ts`).
- **Only the topics it names**: an extension event published with a topic,
  keyed `<extensionId>/<topic>`.
- **`requests`** are new-thread request ids the client awaits. The detail the
  host pushes for such a request names the thread before the client knows
  its id; from that detail on the connection follows the thread (it stays
  followed after the request is gone, until the client lists or drops it).

Questions are the host's: it keeps the open ones, pushes
`extension-ui-prompt` and `extension-ui-resolved` for every thread to every
client, and a client applies both whatever thread it shows.
`sync-extension-ui` pushes every open question again and answers the list; a
client calls it at start and each time its link is back, and drops the
questions it held before the call that the list no longer names (answered on
another device while it was away). A host from before the list answers
nothing, and the client keeps what it holds.

A hello without `subscription`, and any client of a host that does not
announce `subscriptions`, receives every push as before. The `subscribe`
method (`[HostSubscription | null]`, `null` for every push) replaces the
subscription and is answered at once, before any push that waited: pushes
before the answer were filtered by the old one, pushes after it by the new
one. The first push a connection is sent after skipped ones carries
`prev`, the last push it was sent, so the client does not count a gap.

A replay is filtered by the hello's `subscription`, and `resync` is asked for
only when a push that subscription admits fell out of the buffer, so a phone
whose own thread was quiet reconnects cheaply however much another thread
streamed. A thread that a `subscribe` adds makes the coalescer send that
thread's outputs and texts whole again (below), as a client's first hello
does for all of them.

`HostConnection` (`src/workbench/host-connection.ts`) keeps ref-counted
watches: `watchThread`, `watchNewThread`, `watchTopic`. After
`limitToWatched()` it sends the subscription when the watches change, batched
per microtask and always before its next request, so a thread watched before
its detail is fetched misses nothing in between. A replay says hello with the
subscription the host last confirmed (an unanswered `subscribe` may never have
arrived) and sends the current one after the replay; when the replay cannot
be repaired it starts over without a subscription, refetches the bootstrap,
and subscribes again. The workbench limits pushes once its bootstrap is
applied (`followShownThread`, `src/workbench/shown-thread.ts`), follows the
active thread, holds the target of a switch while it runs and the request id
of a `new-session` call. The window's own process subscribes to nothing. The
Electron IPC transport ignores all of this.

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
one closes the connection with 4401. A frame the host cannot read closes it with
4400 `malformed frame`, a request before a hello with 4400 `hello first`. Without TLS
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
→ { type: "pair", id, pair: { code?, name?, commitment?, binding?, companion?: { name? } } }
← { type: "pair-reply", id, reply: { state: "challenge", requestId, hostNonce } }   // only with a commitment
→ { type: "pair-reveal", id, nonce }
← { type: "pair-reply", id, reply: { state: "waiting", requestId, verification, expiresAt } }
← { type: "pair-reply", id, reply: { state: "approved", token, clientId, access, companion?: { token, clientId } } }   // or denied / expired
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

A device that pinned the host's key sends `commitment`, the SHA-256 (hex) of
a random 32-byte nonce, and `binding: "key"`, and reveals the nonce after the
host's challenge. Both sides then compute the digits from the key's SPKI hash
and both nonces (`pairingVerificationCode`, `src/shared/pairing.ts`,
`tau-pair-v2`), and the device shows its own. The host takes the key from the
certificate the socket's own listener presented, so it matches what the
device pinned on any TLS listener; through a proxy that ends TLS it is empty
on both sides. A relay presenting another key cannot make the two screens
agree, since it had to pick the host's nonce before it learned the device's.
A device from before key pins sends no `binding` and binds the digits to the
certificate fingerprint instead (`tau-pair-v1`); the host follows it
([ADR 0026](adr/0026-devices-pin-the-hosts-key.md)). A device that cannot pin (a browser) sends no
commitment, and the host picks the digits. The device-side client is
`pairWithHost` in `src/workbench/host-pairing.ts`.

Limits: 20 open links; five requests waiting at once; without a link, one per
address and three in all, and an address the owner denied waits ten minutes;
per address, five attempts (twenty from this machine on the loopback
listener), then a backoff doubling up to a minute. Each listener kind counts
apart, and behind a proxy the address is the one it forwarded.

`POST /pair` of the web client's server answers 410.

**A second device under the same approval** ([ADR 0027](adr/0027-a-host-reaches-other-machines-for-its-agents.md)).
A window asking for itself and for its machine's agents sends `companion`
(with the name the agents' device goes by, `<name> · Agents` by default). The
owner sees one request naming both; `connections-approve` then writes two
records, each with its own token and the same preset, and answers the second
token as `companion`. The agents' record carries `companionOf` (the window's
record id) in `connections-list`, and each is revoked on its own. A host older
than this ignores the field and answers one token.

### Pairing links

`https://<address>:<port>/#pair=<code>&k=<kind>&pk=<hex>&host=<id>&name=<machine name>&e=<kind>:<url>…&ca=<url>…`
(`pairingUrl`, `parsePairingPayload` in `src/shared/connections.ts`). The origin
is the address the link was made for and `k` its kind; `e` names the best
other network address of each kind (`lan`, `mdns`, `tailscale`, `magicdns`;
IPv6 only for a kind without IPv4; `linkEndpoints` in
`src/main/host-endpoints.ts`), so a device picks one it reaches and learns the
rest from the hello once it paired; `pk` is the SHA-256 of the public key
(SPKI) of the certificate the network listeners present (network access's,
else the host's own listener's; absent in plaintext), which a device pins on
every address not named by a `ca`; `fp`, that certificate's own SHA-256, is
written only when there is no key (links before 0.7.1 carried both). Readers
from 0.7.1 also take `pk`/`fp` as 43 characters of base64url, which hosts do
not write yet: apps before it read hex only. Each
`ca` names an address (the link's own too) where a proxy answers with a
certificate a CA vouches for (Tailscale Serve), which a device checks by chain
and name instead, and only on a DNS name outside `.local`; `host` is the id in
`<userData>/host-id` and `name` the machine's name as the hello reply gives
it. Values are form-encoded except `:` and `/`, which stay as they are to keep
the QR code small (links before escaped them; both read the same). Addresses
on container and VM bridges (`docker*`, `br-*`, `veth*`, `virbr*`, `cni*`,
`flannel*`, `podman*`) are never endpoints of a wildcard bind. A link made
for loopback names no other address. The page takes the fragment out of the
address bar before it renders.

### Where a paired device reaches the host

Every hello reply names the host's network addresses (`host.endpoints`, see
[Several machines in one window](#several-machines-in-one-window)), each with
its kind and `trustedCertificate` as a link carries them, never loopback. The
app and a desktop window take them after every hello (`refreshEndpoints`), so
a device paired over Bonjour learns the Tailscale and Serve addresses and a
host that moved is not lost.

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
device carries `access: "read-only"`, and every hello reply says `owner: true`
or `owner: false`: whether the connection may call the `owner` methods (API
1.13.0; absent from an older host), so a window that is not the owner never
asks for the Connections list only to be refused. Every change a paired device makes, and
every refusal, is recorded: the last one on its record, each one in the host log
(`access.action`, `access.refused`). `lastAction` in `connections-list` carries
`action` (the method or `<extension>/<command>`), `label` (how it reads: "sent a
prompt"; absent from records written before 0.5.1) and `thread` (the current
title of the thread the call named), never the input. A call the client sends
on its own after something the user did (`prepare-prompt`, a thread's title
after its prompt) is logged with `automatic: true` and leaves the last change as
it was. The labels of core methods live in `src/main/host-method-access.ts`.

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

Only a 4401 with one of those three reasons refuses a token
(`tokenRefused`, `src/shared/host-transport.ts`), and only then does a browser
or the app forget the token it stored. A 4400 is the frame's fault, not the
token's: a proxy, a bad link or a client bug can garble a frame. Every client
treats it as a drop, keeps its token and reconnects with backoff; an open
socket does not reset the backoff, only an answered hello does, so a host that
closes every hello is not hammered. Across versions:

- Hosts up to 0.7.13 closed a malformed frame, and a request before a hello,
  with 4401 `malformed frame` and 4401 `unauthorized`. Clients from 0.7.14 read
  4401 `malformed frame`, and a 4401 with any reason not listed above, as a
  drop. They never send a request before their hello.
- Clients up to 0.7.13 stop on every 4401 and reconnect on any other code, so
  they meet a newer host's 4400 as a drop and keep their token.

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
TLS; a link then starts with `https://` and carries the key and the fingerprint.

**Host side.** `TAU_HOST_TLS=1` makes the socket an HTTPS server (`wss:`),
minimum TLS 1.2. On first start the host creates a self-signed ECDSA P-256
certificate (`src/main/self-signed-certificate.ts`, `node:crypto` and a small
DER builder, no dependency) valid for 825 days, and keeps it in
`<userData>/tls/host-cert.pem` and `host-key.pem`, both 0o600 in a 0o700
directory; a headless host's userData is `~/.tau/headless` unless
`TAU_USER_DATA` moves it. A restart reuses the pair, so the fingerprint stays
the same; a week before it expires, or when the certificate is unreadable, a
new certificate is made for the same key, so a device that pins the key keeps
working and one that pinned the old certificate refuses it. Only an
unreadable key file makes a new key, and then every device must pair again. A certificate
of the operator's own replaces all of that: `TAU_HOST_TLS_CERT` and
`TAU_HOST_TLS_KEY` name PEM files (both or neither; the key must belong to
the certificate, and one readable by other users draws a warning). The
headless host prints `tau-host listening on wss://…` and
`tls fingerprint: SHA256 AB:CD:…`, the SHA-256 of the leaf certificate in the
form browsers and `openssl x509 -fingerprint -sha256` show, and
`tls public key: SHA256 AB:CD:…`, the SHA-256 of its SubjectPublicKeyInfo,
which the app, saved machines and `TAU_HOST_PUBLIC_KEY` pin. The web client
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

1. `TAU_HOST_PUBLIC_KEY`, when set: that key and no other, whatever
   certificate carries it, so a renewal keeps working. Colons, case and a
   `sha256:` prefix are optional; `sha256/<base64>` (curl's
   `--pinnedpubkey` form) works too.
2. `TAU_HOST_FINGERPRINT`, when set: that certificate and no other. A
   `sha256/<base64>` value there names the key instead, as in 1. A key from
   1 wins over a certificate from here.
3. An entry for `host:port` in `<userData>/known-hosts.json` (version 1,
   `{ hosts: { "host:port": { publicKey, trustedAt } } }`, 0o600). An entry
   written before key pins holds `fingerprint` instead; it is read as a
   certificate pin, and once a hello succeeds on a connection that pin let
   in, the entry is rewritten with that certificate's key. An environment
   pin never migrates: it is the operator's.
4. A certificate a CA verifies for that name needs no pin (Node's CA store
   answers the probe; Chromium then verifies it as it would any site).
5. Anything else is trust on first use: the window opens, reads the
   certificate without sending anything, and asks on a sheet whether to trust
   that key. A yes writes the key to known-hosts; a no connects to nothing.

A pin is enforced in both of the window's connections. Chromium's (the
renderer's socket) goes through `setCertificateVerifyProc`, which accepts
exactly the pinned key (or certificate) for that host name and leaves every
other name to Chromium's own verification. The window process's uplink (`ws`)
connects through `pinnedTlsConnect`, which destroys the socket in its
`secureConnect` handler, before the WebSocket opens. Either way the token is
never sent to a certificate that does not match. A migration applies to both
at once, so a renewal later in the same session is kept too.

A mismatch is final. The workbench loads (or reloads) with `?hostRefused=`,
its `HostConnection` enters the `refused` state, every request fails at once,
nothing reconnects, and the status line shows both keys (or fingerprints) and
how to repair a key that was replaced on purpose (update
`TAU_HOST_PUBLIC_KEY` or `TAU_HOST_FINGERPRINT`, or delete the known-hosts
entry). A declined or unreadable certificate and a malformed pin variable end
the same way. A refused page carries no token.

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
| Tailscale, or a package's hold | `127.0.0.1:<proxyPort>`, for a reverse proxy such as `tailscale serve` | plain HTTP |

`port` (default 7788) and `proxyPort` (default 7789; 7790 and 7791 in Tau Dev) are fixed, so a paired
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
  `X-Forwarded-For` hop, the one the proxy added. `Tailscale-User-Login`,
  which Tailscale Serve sets (Q-encoded outside ASCII) and strips from what a
  client sent, is read here alone and listed as the client's `proxyUser` in
  Connections: shown, never a login.

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
| Type | `_tau._tcp`, `_tau-dev._tcp` in Tau Dev (`TAU_BONJOUR_SERVICE_TYPE` overrides it; isolated instances use `_tau-test._tcp`) |
| Instance | the machine's host name without `.local`; the network may suffix it after a clash |
| Port | the Local network listener's, TLS |
| TXT | `v=1`, `id=<host id>`, `fp=<SHA-256 of the certificate, 64 hex>`, `pk=<SHA-256 of its public key, 64 hex>` |

Nothing in it is secret: the id, the fingerprint and the key are in every
pairing link too. A device that found the host pins `pk` (a record from before
key pins: `fp`), asks to pair over the socket
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
`NSLocalNetworkUsageDescription` and `NSBonjourServices` (`tooling/electron-builder.yml`).

**Endpoints.** `connections-list` names every URL a device may use, best
first, each with a `kind` a device can choose by: `lan` (with its
`interface`, IPv4 before IPv6), `mdns` (`<name>.local`: macOS's
LocalHostName, else the host name), `magicdns`, `tailscale` and `loopback`.
Link-local addresses are left out. The MagicDNS name comes from a reverse
lookup of the machine's own Tailscale address at 100.100.100.100, so nothing
runs the Tailscale CLI; names are looked up only once a listener is beyond
loopback. A pairing link carries one URL per endpoint.

A package adds endpoints the host cannot see and may hold the proxy listener
open without either switch (`services.network`, [EXTENSIONS.md](EXTENSIONS.md)).
A package may also keep the proxy listener across restarts
(`<userData>/network-kept.json`): the host then opens it at start, before any
package runs, which a service host with no client yet (and so no packages
started) needs as much as a window's. Tailscale (`kits/tailscale/`) does all
three while `tailscale serve` forwards
`https://<machine>.<tailnet>.ts.net/` to the proxy listener: that endpoint has
`kind: "magicdns"` and `trustedCertificate: true`, ranks first, and a client
does not pin the host's key for it, because Serve answers with its own
Let's Encrypt certificate: pairing links name it with `ca=`, and the app and
a desktop window check it by chain and name. Serve keeps the `Host` header and sets
`X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Forwarded-For` afresh, so a page
opened there passes the origin check either way.

The direct Tailscale listener stays beside Serve: it needs no HTTPS
certificates in the tailnet and publishes no name, and a client that pins the
key (the native app, another desktop) reaches it, under its MagicDNS name too. A browser on a
phone wants Serve's certificate.

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
another process — or on another machine — loads kits at all. The host answers
it while it is still starting: the bundles are files, and a workspace the
starting host already knows needs nothing else. A shipped kit's code carries a
`file:` link to its source map rather than the map itself. A host that a
window spawned starts as soon as it listens, instead of at that window's first
`bootstrap`, so the window loads its kits while the host starts.

A browser or the phone app gets the code inline and keeps it. Its fourth
parameter names the digests of the bundles the client holds (32 hex
characters each; `src/web/bundle-cache.ts` keeps them in IndexedDB). With it,
the host names every bundle's digest of code and stylesheet (`hash`) and sends
the ones the client holds without them (`code: ""`, no `styles`,
`cached: true`); a client that lost one asks for it again by id, holding
nothing. Without the parameter (a window, an older client) nothing changes.

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

### Several machines in one window

A window beside a supervised host also knows the machines the user paired it
with ([ADR 0025](adr/0025-a-window-follows-the-threads-machine.md)). Its page
still speaks to one host at a time, the one it was loaded for; the window's
process keeps the rest:

- **The catalog**, `<userData>/environments.json` (0600): per machine its host
  id, name, addresses with their kinds and CA flags, the pinned key (a machine
  saved before key pins: its certificate fingerprint, until its next hello)
  and the client token, encrypted with `safeStorage`.
- **One connection per machine and one to its own host**: an auxiliary hello
  with `subscription: { threads: [], topics: [] }`, a `bootstrap` for the thread
  index, then only `thread-index` and `agent-status` pushes, and `ping` every
  20 seconds where the host offers `heartbeat`. Nothing arriving within 10 s of
  a ping drops the link, unless a large frame of its own is still draining
  (`bufferedAmount` shrank since the last check): the ping waits behind it. Its addresses are tried in turn,
  the one that answered last first, then loopback, LAN, `.local`, Tailscale and
  MagicDNS; an unreachable machine is tried after 1, 2, 5, 10, then every 30 s.
  A refused token (4401, see above) is final, and so is a key
  other than the pinned one. Each address is trusted on its own: pinned to the
  key, or checked by chain and name where the host flagged a CA. After a hello
  that a certificate pin let in, that pin becomes a key pin.
- **Pairing** through [Pairing over the socket](#pairing-over-the-socket): with a
  link's code and key, from a bare address with the key it presents pinned
  for the attempt, or without a link from a machine a [Bonjour](#bonjour)
  search found, pinned to its record's `pk` (a record from before key pins:
  `fp`; `environments-discover` runs `connections-discover` on the window's own
  host, then `environments-pair [{ nearby: <host id> }]`). The digits are bound
  to that key either way; an address the link names with `ca=` is checked by a
  CA and binds none.
- **Moving the page**: `environments-open [id, target?]` attaches a second
  `WindowHost` (uplink only, no window halves) to the machine and loads the page
  with `?host=<its socket>&token=<its client token>&environment=<id>`; `target`
  (`{ thread: { path } }` or `{ newThread: { draft?, workspaceId? } }`) waits for
  `environments-take-arrival`. `desktop-extensions` then goes to that machine.
  Back to the own machine is the same call with its id.

The page reads the list with `environments-list` and hears every change as the
`environments` push of its local connection (forwarded like `app-update` and
`window-shell`). These methods are client-side; a host refuses all of them with
`unsupported`. For the page's own sockets the window's session accepts a saved
machine's pinned key for its host names only, leaves a name the machine flagged
for a CA to Chromium's own verification, and drops `Origin` on
sockets to saved machines, because a host lets a `file://` page in over loopback
only.

A hello reply now names the machine: `host: { id, name, endpoints? }`, its
`<userData>/host-id`, the machine's name (the Mac's Computer Name, elsewhere
the host name without its domain; the same name Bonjour and a pairing link
carry), and the addresses its network listeners have
now (`{ url, kind, trustedCertificate? }`, nothing on loopback; refreshed with
the minute's network poll; the flag counts only on a DNS name outside `.local`). A client that saved the machine knows it again whatever address reached
it, and follows it: the saved LAN addresses become the ones named, while names,
Tailscale addresses, typed ones and the one that just answered stay. A Bonjour
record with the pinned key (or, for an old pin, fingerprint) does the same.

`environments-set-preferences [{ reopenShown }]` keeps whether the window shows
the machine it showed last again at start; the catalog remembers which one.

**Looking in on a thread there** (API 1.15.0) needs no move. `environments-watch-thread
[machine, sessionId, on]` starts or renews a lease (the page renews every 20 s,
the window drops one a minute after its last renewal) and answers the thread's
`UiEnvironmentThreadView`; `on: false` ends it. While a lease lasts, the window's
connection to that machine subscribes to the thread (`subscribe` with its id in
`threads`), and every push of the thread's scope, its `agent-status`, its
`thread-shell`, a whole `thread-index`, a dialog it opens or closes, and a change
of the connection move the view's `revision`; the page hears the view as the
`environment-thread` push of its local connection, at most every 300 ms.
When a watch begins, and when the connection comes back while one lasts, the
window calls `sync-extension-ui` there, so a dialog asked before is heard again.
`environments-transcript-page [machine, sessionId, cursor?]` is `transcript-page`
sent on that connection, with the window's key there.
`environments-extension-read [machine, extensionId, command, input?]` (`read`)
is `host-extension` sent on that connection, for a command that machine's
`host-extensions` lists in `readCommands` only; the window refuses any other,
since its key there could change things. A look-in tab reads another machine's
Preview this way. `environments-open [id,
{ threadId }]` opens a thread by its id, found in that machine's index.

### A host that reaches other machines for its agents

A host keeps machines of its own too, so its agents can work on another
machine while no window is open ([ADR 0027](adr/0027-a-host-reaches-other-machines-for-its-agents.md)).
`environments-pair` asks for the agents as a `companion` unless its input says
`agents: false`, and the window's process hands the second token to its own
host; `environments-set-agents [id, on]` pairs the agents alone for a saved
machine (the same digits as `pairing`), or takes their key back. It answers
`{ state: "on" | "off" | "denied" | "expired" | "cancelled" }` or
`{ state: "failed", message }`.

The host keeps the keys in `<userData>/host-machines.json` (0600, in the clear
like `host-token`: a host has no keychain) and holds the same kind of connection
per machine as a window, without the `bootstrap`, subscribed to the topics its
kits watch there. Its methods are the owner's alone:

| Method | Params | Result |
|---|---|---|
| `machines-list` | – | `{ machines }`: id, name, status, detail, round trip, address, version, `readOnly`; never a token |
| `machines-add` | `{ id, name, endpoints, publicKey?, fingerprint?, token, lastUrl?, readOnly? }` | `{ added }`; replaces a machine with the same id |
| `machines-remove` | `id` | `{ removed }`; the other machine lists the device until its owner revokes it |
| `machines-overview` | – | `{ window, machines }`: one entry per machine with `window` and `agents` states (status, detail, round trip, address, `readOnly`, version); `window: false` when no Tau window on this machine keeps machines |
| `machines-pair` | `{ link, agents?, name?, id? }` | Pairs with a pairing link: through the window on this machine when one runs (for itself and, with `agents`, its agents, as Settings → Machines does), else this host pairs its agents alone as `<name> · Agents`. `{ state: "added", machine, window, agents? }`, `{ state: "known", machine }` when nothing is missing, or `denied`/`expired`/`cancelled`/`failed` |
| `machines-forget` | name or id | `{ id, name, window, agents }`: forgets the machine in the window and the agents' key |

`tau machines` (`bin/tau-machines.mjs`) uses the last three. The window half
of core (`window`) answers `environments` (the saved machines without keys or
threads; `null` for a window attached to a host by address),
`pair-environment` and `remove-environment` for them; the host asks it only
when `ClientCalls.hasLocalWindow` finds one and never starts one to ask.

A host in the window's process keeps no machines and answers `unsupported`.
Kits reach the machines through `services.machines`: a kit command there goes
as `host-extension`, and `request` sends only the methods in
`MACHINE_REQUEST_METHODS` (`src/shared/host-method-access.ts`:
`transcript-page`, `thread-tree`, `tool-output`, `abort`, `steer`,
`follow-up`, `host-resources`, `readiness`); every other name is refused before
it leaves. Named by the host's own id, a `read` method of that list is answered
by the host itself.

### How busy a machine is, and what it could run

Two `read` methods, answered only when asked; nothing is pushed or polled.

| Method | Params | Result |
|---|---|---|
| `host-resources` | – | `HostResources`: `cpuCount`, `cpuUtilization?` (0–1), `totalMemory`, `availableMemory`, `runningTurns`, `onBattery?`, `sampledAt`. A reading needs two looks at the CPU counters: the previous answer when it is at most 30 s old, otherwise 5 s apart; answers within 5 s are the same. A host in the window's process answers `unsupported`. |
| `readiness` | – | `HostReadiness`: `runtimes` (`kind`, `label`, `state`: `ready`, `sign-in-required`, `not-installed`, `unavailable`, `checking`; `version?`, `account?`, `models?`, `note?`), `git` (`version?`, `mergeTree`: Git ≥ 2.38), `disk` (`path`, `free?`, `total?`, `error?`), `display` (`kind`: `screen`, `x11`, `wayland`, `invisible`, `none`; `name?`), `checkedAt`. |

A runtime's state comes from the runtime catalogs (`runtime-catalogs`) and
from `sign-in-state` of the kit that registered the backend (with `target` for
an instance), which adds `account` and marks a signed-out program
`sign-in-required` where its catalog could not tell. A Read-only device, which
may not call `sign-in-state`, gets no `account`. A catalog or a report not
on hand within 5 s is left out: the runtime is then `checking`. `invisible` is an X display whose server (the pid in
`/tmp/.X<n>-lock`) is `Xvfb`.

### A machine's own Tau

`update-status` and `update-check` (`read`), `update-install` and
`update-settings` (`write`), the push `{ type: "update-status", status }`,
the window's `environments-update` and the command line's `machines-update`
(owner) carry a machine's own Tau update (K103).
[host-updates.md](host-updates.md#protocol) lists them with their params and
results, and what an older host or client does with them.

### Files between hosts

`services.machines.upload` sends a file over the same connection, and the
receiving host keeps it for a kit there (`services.blobs.take`,
`src/main/host-blobs.ts`). All three methods are `write`, so a Read-only
device is refused; each device only reaches its own blobs, and another
device's id reads as missing.

| Method | Params | Result |
|---|---|---|
| `blob-put` | `id`, `index`, `data` | `{ received }`, the bytes so far. `id`: 16–64 of `[A-Za-z0-9_-]`, chosen by the sender. `index` 0 starts the blob; pieces come in order, each base64 of at most 8 MB (`BLOB_PIECE_BYTES`), and only piece 0 may be empty |
| `blob-commit` | `id`, `sha256` (hex), `size` | `{ id, size, sha256 }` once size and sum match what arrived; otherwise nothing is kept and it fails with both sums |
| `blob-abort` | `id` | `{ aborted }`; what arrived is deleted |

The sender sends one piece at a time and `blob-put` frames without
per-message deflate: base64 of compressed or random data shrinks by a quarter
at about 150 ms per piece, slower than sending it on any fast link.

The host keeps blobs in `<userData>/blobs/` (0700, files 0600) and empties it
at start. A blob is at most 2 GB (`BLOB_MAX_BYTES`); a device keeps at most
4 GB there until its blobs are taken (`BLOB_DEVICE_QUOTA_BYTES`) and sends at
most four at once; a piece that would leave less than 512 MB free on the disk
is refused. A refusal for size, quota or disk drops the whole blob. An upload
with no piece for an hour, and a committed blob nobody took within an hour
(`BLOB_TTL_MS`), are deleted by a sweep every minute. A kit takes a blob once;
the file is deleted when its callback settles. Pieces are not written to the
Connections audit one by one: `blob-commit` records "sent a file", a refused
piece is recorded like any refusal. Pieces are not rate-limited: the only
limiter (`src/main/host-rate-limit.ts`) counts pairing attempts.

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

`environments-person-preferences []` and `environments-set-person-preferences [patch]` read and write the person's look (theme, transcript detail, costs, typography, vim mode, keybindings; `src/shared/person-preferences.ts`) on the window's own machine, over its connection there, and pass no other key. A page that shows another machine has that machine take them over once and sends a change made there back (ADR 0030).

`environments-extension-invoke [machine, extensionId, command, input?, options?]` forwards an explicit kit action to another connected host over the window's authenticated connection. It is classified as `write` on the originating host; the destination applies the kit command's own access policy again. `PlatformEnvironments.invokeExtension` exposes this route to desktop kits. Read-only clients cannot use it. Use `readExtension` for look-ins, which continue to require an explicitly read-only command. `options.timeoutMs` extends the default 30-second wait for a long command, up to ten minutes.

`environments-extension-follow [machine, extensionId, on]` registers or removes interest in a machine's kit events. While any interest remains, the window forwards that kit's events from its existing monitor connection as `environment-extension-event`, with `{ machine, extensionId, name, payload }`. `PlatformEnvironments.onExtensionEvent` shares one registration among listeners of the same machine and kit and removes it when the last listener leaves. It does not subscribe to kit topics.
