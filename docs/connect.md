# Tau Connect

Cloud hosting is deliberately deferred because keeping a host connected incurs
ongoing charges. Preparation is retained in [closed MR #4](https://github.com/Rasalas/tau/pull/4)
on `feat/cloud-connect`, outside the current product changes. No new cloud
resources were created. Neither `npm run relay:deploy` nor the existing Push
relay workflow activates Connect hosting. Use Tailscale, SSH or a direct
connection until a separate relay is needed.

Tau Connect sends the host protocol through an outbound relay connection. The
host needs no inbound firewall rule, VPN, public IP address, or router change.
Desktop, iOS, Android and browser clients support this transport. The browser
loads a separate WebAssembly adapter built with rustls and tungstenite, and
checks the host's key before sending pairing data or its paired-client token.
The adapter loads only when a browser uses Connect. Electron and the native
phone transport keep their existing TLS implementations.

The relay is a separate service from the notification push relay. It has no
access to projects, threads, model credentials, host tokens, or pairing answers.
The client establishes TLS directly with the host through the relay and pins the
host's public key from the pairing link. Normal owner approval, six verification
digits, device permissions, token revocation, heartbeats and push replay still
apply. The relay sees route ids, connection timing and ciphertext sizes.

## Deploy the relay

Tau does not include a hosted account or an already running service. An operator
needs a Linux server, Docker with Compose, a real DNS name pointing at it, TCP
ports 80 and 443 reachable for HTTPS certificate issuance, and a contact email.
No T3 Connect account or infrastructure is used.

Copy `connect-relay/` to the server, enter that directory, then run:

```sh
chmod +x setup.sh
./setup.sh connect.your-domain.example you@your-domain.example
docker compose up --build -d
docker compose logs --tail=100 relay caddy
curl --fail https://connect.your-domain.example/health
```

Replace the example domain and email with values you own. The setup command
creates a mode 0600 `.env` containing a random 256-bit administration token. Keep
it private. Caddy obtains and renews a real HTTPS certificate. The relay's plain
HTTP port is reachable only on the Compose network, with no published host port.
The named `routes` volume holds only SHA-256 hashes of route credentials. Back up
that volume and `.env`; losing the routes requires registering hosts again.

For an existing HTTPS proxy, run `npm ci --omit=dev --ignore-scripts` in
`connect-relay/`, then `npm start`. Configure `TAU_CONNECT_ADMIN_TOKEN`,
`TAU_CONNECT_STORE` and `PORT`. The default bind is `127.0.0.1`. A directly exposed
listener must set `TAU_CONNECT_TLS_CERT` and `TAU_CONNECT_TLS_KEY`. Only a listener
behind your TLS proxy may set `TAU_CONNECT_BEHIND_TLS_PROXY=1` with an external
`TAU_CONNECT_BIND`. Clients accept HTTPS/WSS and the platform's certificate
authority verification; there is no option to ignore a relay certificate.

## Register and pair

On the machine that runs the host, open Settings → Connections → Tau Connect.
Enter the relay's HTTPS address and the administration token from `.env`, then
register. The token creates one route and is discarded. Host and client route
tokens are random and separate. The host keeps its registration in
`<userData>/connect.json`, mode 0600, like its host token. It resumes the route
after a restart and reconnects after network changes or relay outages.

Copy the Tau Connect pairing link and paste it into Settings → Machines on the
other desktop, or Add host on a phone. The phone also scans a QR code containing
the link and opens `tau-connect:` links from another app. Allow the request on the host after comparing the six digits.
The link expires in two minutes. It includes the relay transport credential and
the host key; treat it as a secret. A transport credential alone cannot call
host methods. Each approved device still has its own host token and access
preset, and may be revoked in Connections. The desktop encrypts its saved
transport credential in the system keychain together with its machine record.

In a browser, open Tau's web client from an HTTPS origin, then paste the Connect
link into the sign-in form's "Host token or Tau Connect link" field. The same
form works in the compact browser client. Compare its six digits with the host
before approving it. A browser requires an HTTPS page, WebAssembly, WebCrypto
and IndexedDB. A storage or TLS initialization failure is shown before access
is saved. A saved Connect session reconnects after a reload. The compact
client's More menu offers "Forget Tau Connect" to close the connection and
delete its saved credentials.

Browser credentials are encrypted with AES-GCM in IndexedDB, using an
origin-bound, non-exportable WebCrypto key. They never enter localStorage or a
URL query. This protects a copied credential record, but scripts allowed to
run on that origin can use the key. Serve the client from a trusted origin.
The browser store provides no system keychain or protection from a compromised
client page.

The command line reaches the same owner methods:

```sh
tau connect register --relay https://connect.your-domain.example --token-file /path/to/private-token
tau connect status
tau connect status --json
tau connect link
tau connect disconnect
```

`TAU_CONNECT_ENROLLMENT_TOKEN` supplies registration when `--token-file` is
absent. Never pass a token as a command line value. Tau must be running or have
its host service installed before these commands can reach it.

Disconnect stops the local connector and asks the relay to revoke the route.
If the relay is offline, Tau reports that local disconnect succeeded but relay
revocation is pending. An operator can remove the route later with its id and
administration token:

```sh
curl --fail -X DELETE -H "Authorization: Bearer $TAU_CONNECT_ADMIN_TOKEN" \
  "https://connect.your-domain.example/v1/routes/$ROUTE_ID"
```

The phone keeps the relay credential in its Keychain or Keystore-backed store,
under a separate key from the host's paired-client token and host metadata. Each
connection creates one loopback TCP bridge. URLSession on iOS and OkHttp on
Android connect to the relay with normal CA and hostname verification and
forward binary TLS bytes. The existing pinned native WebSocket then connects
to the loopback bridge and verifies the host's SPKI or legacy certificate pin
before it sends pairing data or a hello. Relay and host credentials never share
an Authorization header. The inner host path and query survive the bridge.

Reconnects create fresh bridges. Losing the relay or the pinned socket closes
both ends. Pairing cancellation closes pending probes; host switching and page
reload close tracked native sockets and their bridges. Removing a host forgets
its relay credential as well as its host token.

Removing a machine on the client closes its local bridge and forgets its saved
keys. Revoking that device in the host's Connections removes its host access;
disconnecting the host's entire Connect registration removes the transport
route for every client.

## Protocol and limits

`POST /v1/routes` with an administration Bearer token returns `{id, hostToken,
clientToken}`. The host opens `/v1/host/<id>` with its host token. For each
authenticated `/v1/client/<id>` connection, the service sends the host an
`{type:"open", id:<connection UUID>}` control message. The host opens
`/v1/data/<route id>/<connection UUID>` with its host token. The relay pipes
binary messages in both directions with stream backpressure. Those messages
contain TLS records; the host's TLS listener retains the existing Tau protocol.
Native credentials appear only in Authorization headers, never in URL query strings.

Browser clients instead open `/v1/browser/<route id>` with the `tau-connect-v1`
subprotocol. Inside the browser's CA-verified WSS connection, their first text
frame is `{type:"authenticate", token:<client route token>}`. The relay answers
`{type:"authenticated"}` after checking the route's credential hash, then
opens the host data route. Authentication has a five-second deadline, a 1 KiB
message limit and a separate 25-socket concurrency bound. All subsequent data
is binary TLS records. Host control and native client connections still use
Bearer headers. The browser's paired-client token and pairing frames travel
only in the pinned inner TLS connection.

The service caps routes and simultaneous connections, limits binary message
size to 64 KiB, drops unanswered control heartbeats, and expires pending
connections after ten seconds. A control disconnect closes that route's data
connections; the host reconnects with backoff up to thirty seconds. Application
clients then reconnect and replay their missed pushes as usual. All relay peers
enter the host through a `proxy` listener, so a forwarded loopback address never
grants local owner or local file privileges.

The deployment is a single relay process with one persisted route store. It
does not provide multi-region routing, accounts, quota billing, or shared-store
multi-instance operation. Do not run multiple instances against the same store.

## Browser compatibility

The [WebSocket standard](https://websockets.spec.whatwg.org/#the-websocket-interface)
exposes a URL and optional subprotocols, with no caller-supplied Authorization
header, certificate callback or access to raw TCP. Browser clients use the
authenticated first-frame relay handshake above; the inner host still needs
a strict key pin.

Tau's [browser adapter](../browser-connect/src/lib.rs) uses rustls TLS 1.3 and
its ring provider. x509-parser extracts the certificate's SPKI. SHA-256 must
match the link's exact pin. A legacy certificate pin is accepted only when no
key pin exists. CA trust never replaces the inner pin. Rustls validates the
handshake signature with the pinned key, and tungstenite validates the inner
WebSocket upgrade and frames. There is no certificate bypass option.

The source, Cargo.lock, generated WASM, JavaScript bindings and upstream
license texts are checked in together. The web build checks their manifest.
`npm run build:browser-connect` rebuilds them with a Rust toolchain containing
the `wasm32-unknown-unknown` target and `llvm-tools`, plus the wasm-bindgen CLI
version named in Cargo.lock. `TAU_CONNECT_WASM_BINDGEN` can name a privately
installed CLI. The [adapter research](research/browser-connect-tls-2026-09-30.md)
records the library assessment and verification scope.
