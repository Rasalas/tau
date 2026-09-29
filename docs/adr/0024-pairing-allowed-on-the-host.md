# ADR 0024: A device pairs by asking, and the owner allows it on the host

## Status

Accepted, 2026-09-24. Amends [ADR 0023](0023-client-tokens-and-pairing.md):
three of its out-of-scope items are decided here (pairing over the socket,
expiring client tokens, rights per client), and redeeming a link no longer
hands out a token by itself.

## Context

Under ADR 0023 a single-use link was the whole of pairing: whoever opened it
first held a token of their own. A photographed QR code, a link forwarded by
mistake or read off a shared screen was enough: the link was the grant, and
the user named that as what they do not want. What they want instead (plan, decision 9) is what
AirDrop and Bluetooth do: in the local network the host asks "<device> wants
to connect, allow?", and both screens show a code to compare.

Wave F also brings a native app (decision 1), Bonjour discovery (F06) and
saved hosts in the desktop (F14). None of them should need the web server to
pair, all of them need every address of the host and its certificate
fingerprint (decision 2), and a device found by Bonjour arrives with no link
at all. Tokens that live until revoked do not fit a phone that can be lost:
decision 5 asks for expiry after 90 days without use, per device 30, 90, 365
days or never. Decision 6 asks for two presets per device, Full and Read only,
enforced on every call.

## Decision

**Pairing is a request the owner allows on the host.** A device asks on the
host socket, before any hello, with a `pair` frame (`src/shared/pairing.ts`,
`HostAccess.requestPairing`). It may carry a link's code; the code is spent by
the attempt whatever its outcome, and expired, spent, revoked and invented
codes get one answer, as before. It may also come without a code: anyone who
reaches the port may ask, so such requests are limited to one per address and
three at once, and an address the owner denied waits ten minutes. Five
requests may wait in all, each for two minutes. No token exists until the
owner calls `connections-approve`; `connections-deny` closes the device's
socket. A device that left before the answer gets nothing, and the record
written for it is removed again.

**Both screens show the same six digits.** A device that pinned the host's
self-signed certificate — the app with a fingerprint from a QR code or a
Bonjour record, a desktop adding a host — commits to a random nonce, the host
answers with its own, the device reveals its nonce, and both compute the
digits from the certificate fingerprint and both nonces. A relay that presents
another certificate would have to choose the host's nonce before it learned
the device's, so its two sides show different digits: one chance in a million
per attempt. A Bonjour record is unauthenticated, so this is what makes
pairing without a QR code safe. A browser cannot pin and cannot see the
certificate, so it sends no commitment and the host picks the digits; that
still binds "the request on the host" to "the device in my hand", which is
what a photographed QR code breaks.

**Pairing travels over the socket.** `POST /pair` answers 410. The browser
client pairs with `pairWithHost` (`src/workbench/host-pairing.ts`), the same
function a native client will use with a pinned socket; it takes a socket
factory, a fingerprint and a name. After `approved` the device says hello with
its token on the same socket. The hello deadline does not apply while a
request waits.

**A link carries the whole host.** `#pair=<code>&fp=<hex>&host=<id>&name=<name>&e=<url>…`
(`pairingUrl`, `parsePairingPayload`): the link's origin is the address it was
made for, `e` lists every other network address, `fp` the certificate a
device pins on each of them, `host` the id in `<userData>/host-id` that F06's
Bonjour record and F14's saved hosts name too. A browser needs only `pair`; a
native client picks the best reachable address and pins. The headless host
prints its startup link in this form.

**Tokens expire after use stops.** Each device has an idle timeout of 30, 90
(default) or 365 days, or never. A hello or a request restarts it. An open
connection counts as use: once a minute the host marks every connected device
as seen, so a phone whose app keeps its socket open in the background never
expires, and the heartbeat pings of the transport need not count on their own.
A device that stays away past its timeout is refused at its next hello and
forgotten. Settings shows the date a week ahead; only the owner can be warned,
since the device is by definition not running. Shortening the timeout counts
from the change, so it never ends a token on the spot.

**Two presets, checked on every call.** A device is Full or Read only; a link
proposes one and the owner decides when allowing. Every host method has a
class in `HOST_METHOD_ACCESS` (`src/main/host-method-access.ts`): `read`,
`write` or `owner`. `invokeHostMethod` refuses a Read-only device every
`write` method and every paired device every `owner` method, before the
handler runs; `start-job` checks the method it would start; a method missing
from the table counts as `write`, and a test fails until it is classified.
Kit commands go through one core method, so the extension registry decides
those: a Read-only device may call only commands registered with
`{ access: "read" }` (`registerCommand` option, forwarded from isolated
packages too), and a refused command does not count as a failure of it. The
transport asks for the preset on every request, so a change applies to the
next call without a reconnect; the hello reply tells a Read-only device so it
can adapt its UI. Read only narrows what a device can change, not what it can
read: it still sees every thread, diff and file the workbench shows.

**The owner can rename a device, sign out all others, and see what each did.**
`connections-update-client` changes name, preset and timeout;
`connections-revoke-others` revokes every paired device. Every change a
paired device makes, and every refusal, is recorded: the last change on its
record (the method or `<extension>/<command>`, never the input), each one in
the host log. The record reads as a person would say it ("sent a prompt in
“Fix the queue”"); what a client does on its own after a prompt, such as titling
the thread, is logged but does not replace it (0.5.1).

**Where the owner answers.** Every window that holds the host token asks as
soon as a request arrives (`PairingRequestWatcher`), with the device's name,
address, whether it came with a link, the digits and the preset, and raises
an OS notification when the window is not in front. Settings → Connections
lists waiting requests beside the devices. A host started by hand in a
terminal asks there. Only a payload-free `connections-changed` push goes to
all clients; what changed is answered to owners alone.

**Access is managed from this machine only.** Methods of class `owner` — the
Connections methods (links, requests, devices, rotation, network access,
certificate reload) and `host.shutdown` — need the host token *and* a
connection from this machine through the loopback listener (`isHostOwner`:
loopback trust and a loopback peer; the in-process window counts). The host
token over a LAN or proxy listener, or from another machine to a hand-started
host bound beyond loopback, uses the host like a Full device but manages
nothing. No paired device ever manages access, whatever its preset. A token
that leaked off the machine can then neither let further devices in, nor lock
the owner out by rotating, nor open the host to more networks. A host started
by hand on another machine is managed on its own terminal (it asks there) or
through an SSH tunnel to its loopback listener.

**The digits are bound to the listener's own certificate.** The transport reads
the certificate each socket's TLS listener presented (`getCertificate()`), so a
device that pinned the network listeners' certificate agrees with the host
even when the host's own listener is plaintext loopback. A pairing link carries
that certificate's fingerprint (network access's, else the host's own) and
names each address with its kind (`k=` for its own origin, `e=<kind>:<url>`
for the others). Behind a proxy that ends TLS itself (`tailscale serve`) there
is no certificate of the host's to bind to; a device reaching it that way
trusts the proxy's public certificate and sends no commitment.

Pairing attempts are counted per listener kind, strictly beyond loopback, and
behind a proxy by the address it forwarded, so a flood through the proxy never
locks out this machine's own browser.

**What is not weakened.** Everything ADR 0023 lists still holds: the host
token stays with the owner and only it manages access; secrets and codes are
kept as hashes; a record is written before its token leaves; revocation and
rotation close live connections at once; a plaintext listener stays on
loopback unless `TAU_HOST_INSECURE=1`; a pinning client refuses a mismatch
before the socket opens; no method runs before a hello; a call into a window
reaches one connection. F02's origin check applies to pairing sockets as to
any other.

## Consequences

- A device that holds a link is not in until someone at the host agrees, and a
  photographed code alone gets an intruder a request the owner can see and
  deny. The price is a second step for every pairing, including the owner's
  own devices.
- F06 needs no change here: Bonjour publishes the host id and fingerprint,
  the app pairs without a code and binds the digits. F07 uses `pairWithHost`
  with a pinned socket and `parsePairingPayload` for the QR code. F14 stores
  the host id, the addresses and the pin from the same payload.
- An owner who is away from the machine cannot approve a device or change
  access from a browser that holds the host token; they can use it otherwise.
- Anyone who reaches the port can put a request in front of the owner. The
  limits keep that from becoming a flood, and the port is closed to the
  network unless the owner opened it (F04).
- The declaration `access: "read"` is a kit's promise. Core cannot check that
  a command only reads, including what it asks other kits to do; a package
  the owner installed is trusted to keep it, as it is trusted with its
  grants. The bundled kits declare their state, list, diff, status and usage
  reads.
- Looking at another thread (`switch-session`) is a read, though it makes that
  thread the active one and may start its runtime; it starts no turn. Opening
  a folder as a project is a change, since it adds the folder to the host's
  projects and runs the kits' workspace hooks.
- A kit command started as a job by a Read-only device starts, then fails
  with `forbidden` before it runs: the registry is where the declaration is
  known.
- Waiting requests live in memory; a host restart ends them.
- An older build that reads the version 2 store treats every device as Full
  and forgets the timeouts once it writes the file.

## Out of scope

- **Finer scopes** than two presets (terminal, review and access scopes).
  The method table and the registry declaration are where they would go.
- **Sender-constrained tokens** (DPoP). Pinned TLS or a tunnel keeps the
  bearer token off the wire.
- **Warning the device** before its token expires: an unused device runs no
  code that could be told. F08's push could carry it later.
- **Approving from another device** than one with the host token.
