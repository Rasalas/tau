# ADR 0023: Clients pair for tokens of their own; the host token stays with the owner

## Status

Accepted, 2026-09-23. Amends [ADR 0010](0010-host-protocol.md) (one token was
the whole authentication of a listening host) and builds on
[ADR 0021](0021-host-runs-in-its-own-process.md) (the host is its own process;
every window is a socket client). Amended 2026-09-24: a call into a window
goes to one connection (below); this changes how ADR 0021's `client-call`
travels. Amended by [ADR 0024](0024-pairing-allowed-on-the-host.md): a link
no longer yields a token by itself; the owner allows each device on the host,
pairing travels over the socket, tokens expire unused, and devices are Full or
Read only.

## Context

A listening host knew one secret, `~/.tau/host-token`. Every client said hello
with it: the window beside the host, a window elsewhere with `TAU_HOST_URL`,
and the browser client, whose pairing link traded a single-use code for that
same token. A phone that opened the link held the owner's key for good. Nobody
could see who held it, take it back from one device, or change it without
editing a file by hand and restarting every client.

Wave F brings remote hosts and a mobile client, so more devices will hold
access, not fewer. T3 Code answers the same need with client sessions
(`ConnectionsSettings.tsx`, `apps/server/src/auth/`): pairing credentials with
an expiry, one session per paired client, revocation that ends a live
connection, and scopes per session.

## Decision

**Two kinds of credential.**

| | Host token | Client token |
|---|---|---|
| Who holds it | The owner: processes on the host's machine that can read the file, and whoever the owner deliberately gives it to | One paired client |
| Form | 64 hex characters | `tauc.<id>.<secret>`: a 12-byte id in hex, a 32-byte secret in base64url |
| Where the host keeps it | `TAU_HOST_TOKEN_FILE`, default `~/.tau/host-token`, 0o600 in a 0o700 directory | Only the SHA-256 of the secret, in `<userData>/paired-clients.json` (0o600, `writePersistedJson`) |
| Where the client keeps it | The window reads the file; a browser whose owner pasted it keeps it in `localStorage` | A browser keeps it in `localStorage` under `tau.web.host-token` |
| May manage access | Yes | No |
| Ended by | Rotation | Revocation |

`HostAccess` (`src/main/host-access.ts`) answers every hello: a token in the
client form is looked up by id and its secret compared as a hash, in constant
time; anything else is compared with the host token. A client token is never
compared with the host token and cannot be mistaken for one.

**Pairing links are single-use and expire.** The owner creates one in
Settings → Connections (optionally labelled, valid for 10 minutes, an hour or a
day; the host clamps anything else to one minute … one day), and the headless
host prints one at start. The code is 24 random bytes. The host keeps only its
SHA-256 and the expiry, in memory: a host restart voids every open link. A
redeem attempt spends the link whatever its outcome, and an expired, spent or
invented code gets the same 403. `POST /pair` stays rate-limited per source.
The code travels in the URL fragment (`#pair=`), which no server log sees, and
the page removes it from the address bar before it renders. The response is
`cache-control: no-store`. At most 20 links are open at once.

A redeemed link becomes a client: its token, a label (the link's, or the
browser and OS its user agent names), the time and address it paired from. The
record is written to disk **before** the token is answered, so a token the host
would forget on restart is never handed out.

**Revocation ends a live connection.** The socket transport registers every
authenticated connection with `HostAccess` together with a way to close it.
Revoking a client removes its record and closes each of its connections with
4401 and the reason `revoked`, before the change is written. The browser drops
its stored token and says that its access was revoked. Its next hello is
refused like any unknown token.

**Rotation replaces the host token.** `connections-rotate-host-token` writes
a new token to the file (temp file, 0o600, rename) and closes every other
connection that said hello with the old one (4401, `token-rotated`), including
auxiliary ones. The caller keeps its connection and is answered the new token:
it already held the old one, so nothing is disclosed that it could not read.
Its socket client keeps the new token for reconnects; a window writes it into
its own address so a reload connects, a browser stores it. A supervised
window's process re-reads the token file once after a 4401 and reconnects with
what it finds; the supervisor reads the file, not its start-time copy, before
it asks the host to stop. Paired clients are not affected.

**The file is the truth.** `HostTokenFile` re-reads the token when the file's
inode, size or mtime changed, so a rotation by another host that shares the
file, or a token replaced by hand, takes effect at the next hello without a
restart. A file that went missing or unreadable keeps the last good token: it
neither locks the owner out nor mints a token nobody can read.

**Only the owner manages access.** The five Connections methods
(`connections-list`, `-create-link`, `-revoke-link`, `-revoke-client`,
`-rotate-host-token`) and `host.shutdown` check the caller's principal: a
socket request carries `{ kind: "workbench-client", connection, pairedClient? }`
assigned by the transport from the hello's credential, never from request data,
and `start-job` passes it through, so a job cannot launder a paired client into
the owner. A paired client gets `forbidden`. A host without a socket listener
(`TAU_HOST_INPROCESS=1`) answers `unsupported`.

**A call into a window goes to one connection** (added 2026-09-24). Before,
the host published every `callClient` and folder-picker call as a push to all
clients and took the first `client-call-result` for its id from anyone. A
paired device saw what the host asked of the window (URLs, cookie imports,
frames) and could answer first, with a folder of its choosing, say; two
windows both ran the call; with no window the call waited for its timeout.
Now:

- A window's process names in its hello the extension ids whose window half
  it runs (`windowHalves`, read only from an auxiliary hello) and a random
  `windowId`; its renderer's hello names the same `windowId`.
- A call has one addressee. While a request runs for a connection (a kit
  command, directly or as a job), it is the caller's own window: the caller's
  connection if it runs the half, or the auxiliary connection with the same
  `windowId` **and the same credential**. Otherwise the newest window on this
  machine: loopback, host token, runs the half. A paired client's window is
  never that fallback; it is asked only for calls its own requests caused.
- The folder picker (`pick-directory`) goes only to the caller's window. A
  browser or phone that asks gets a rejection, not a dialog on the host's
  screen and its answer. A call with no caller (the host's own work) goes to
  the window on this machine.
- With no addressee the call fails at once.
- The call travels as a `client-call` frame to that connection alone, outside
  the push sequence, so no other client receives it and no replay repeats it.
- Only the addressee's `client-call-result` settles the call. Answers from any
  other connection are dropped the same way as an answer to an unknown id.
  When the addressee disconnects, its open calls fail.
- A kit may narrow the addressee (API 1.13.0, wave F): `{ window: "host" }`
  skips a caller's window on another computer, and a window id from
  `clientWindow()` pins every later call to that one window on the host's
  machine, whoever asks — the window that holds a view. A pin can only name a
  loopback window with the host token, never a paired client's, and a call to
  a pinned window that is gone fails at once. This settles where an agent's
  tool goes when no request is running: to the window that holds what the tool
  acts on, the same one every device's panel reaches.

**What is not weakened.** A plaintext listener still binds loopback only unless
`TAU_HOST_INSECURE=1`; a TLS client still pins the fingerprint and refuses a
mismatch before the hello leaves it; no method runs before a hello is
accepted; a wrong token still closes the socket with 4401. Client tokens are
sent the same way the host token is, so they need the same transport: loopback,
an SSH tunnel, or TLS.

## Consequences

- A phone or a second browser can be given access and have it taken away
  without touching the owner's key, and the owner sees who is connected, from
  where, and when each client was last active.
- A browser paired before this change holds the host token. It keeps working
  and is listed among the host-token connections; rotating the host token is
  how to cut it off.
- A client token is not a sandbox. A paired client may call every method the
  workbench uses — run a turn, open a terminal, open a project path — so it can
  do what the user can do on that machine, including reading the token file.
  What it cannot do is hand out or take away access through the protocol.
- `lastSeenAt` moves in memory on every request and is written on hello,
  goodbye, any change, and host shutdown; after a crash it may be minutes old.
- The user agent and address shown for a client are what the client and the
  network said; nothing is decided on them. Behind a proxy the address is the
  proxy's.
- Two hosts sharing one token file (the default path) share rotation: the
  other host picks up the new token at its next hello, but does not close the
  connections that used the old one.
- The caller is tracked for the duration of a command. Work a command leaves
  running (a timer, a turn's tool call) has no caller and reaches the window on
  this machine. Folder-picker calls from an isolated (worker) package also have
  no caller, because they arrive over the worker's port.

## Out of scope

The first three items below are decided in ADR 0024.

- **Scopes per client** (T3's read-only / operate / terminal / access rights).
  Every method would need a declared scope first; wave F decides whether a
  mobile client needs them.
- **Expiring client tokens** and refresh. A client token lives until it is
  revoked, like a device login.
- **Pairing a window or a native client over the socket.** Redemption is the
  browser's `POST /pair`, which exists only where the host serves the web
  client. A window with `TAU_HOST_URL` still takes a token from
  `TAU_HOST_TOKEN`; a client token works there too.
- **A window attached with `TAU_HOST_URL` learning a rotated token.** Its
  process has no path to the host's file; it is refused until it is given the
  new token.
- **Sender-constrained tokens** (T3's DPoP proof keys). A token is a bearer
  token; TLS or a tunnel keeps it off the wire.
