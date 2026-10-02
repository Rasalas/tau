# Browser Connect TLS assessment

Date: 2026-09-30. Scope: a browser transport for Tau's existing encrypted
Connect relay, including the compact browser client. No hosted service is
required; the relay remains independently operated.

## Constraints and selected implementation

The browser WebSocket constructor accepts a URL and subprotocols, without an
Authorization-header argument or raw TCP access. Its normal TLS verification
authenticates the relay, not Tau's host behind the relay. The inner connection
therefore needs a separate TLS implementation and the host pin carried in the
pairing offer. [WebSocket interface](https://websockets.spec.whatwg.org/#the-websocket-interface).

Tau now owns a small WASM adapter over rustls 0.23.45, ring 0.17.14,
x509-parser 0.18.1 and tungstenite 0.28.0, locked in
[Cargo.lock](../../browser-connect/Cargo.lock). Rustls implements TLS records,
key exchange, encryption and transcript verification. The adapter's custom
verifier extracts the DER SubjectPublicKeyInfo using x509-parser and compares
its SHA-256 digest with the exact pairing pin. When an older offer contains
only a certificate pin, it compares the complete certificate instead.
[Rustls architecture](https://docs.rs/rustls/0.23.45/rustls/),
[certificate parser](https://docs.rs/x509-parser/0.18.1/x509_parser/).

The pin is the inner trust anchor. The verifier delegates TLS signature checks
to rustls's ring provider, so matching certificate bytes alone do not complete
authentication: the server must prove possession of the pinned key. The adapter
enables TLS 1.3 only and begins the HTTP/WebSocket handshake after rustls has
completed its handshake. There is no CA fallback or certificate bypass switch.
[ServerCertVerifier contract](https://docs.rs/rustls/0.23.45/rustls/client/danger/trait.ServerCertVerifier.html),
[ring features](https://github.com/briansmith/ring/blob/0.17.14/Cargo.toml),
[tungstenite](https://docs.rs/tungstenite/0.28.0/tungstenite/).

The outer browser WebSocket uses the browser's normal CA-verified WSS. A bounded
first-frame route authentication exchange replaces the unavailable Bearer
header. Its client route credential does not grant host permissions. Pairing
data and the approved device's host token remain inside pinned inner TLS.
The first frame is encrypted to the relay, and neither credential appears in
a URL query. See [the implemented protocol](../connect.md#protocol-and-limits).

## Alternatives inspected

| Library | Primary-source finding | Decision |
| --- | --- | --- |
| libcurl.js 0.7.4, commit `a641cdd857356db6b8ed46c5341cc8f85c4190ba` | Its documented/custom transport TLS socket does not expose peer SPKI or a pin-verification callback. Its TLS-socket constructor exports only the connection and verbosity controls. | Do not adapt its default CA trust into a claim of host pinning. [C socket](https://github.com/ading2210/libcurl.js/blob/a641cdd857356db6b8ed46c5341cc8f85c4190ba/client/libcurl/tls_socket.c), [JS socket](https://github.com/ading2210/libcurl.js/blob/a641cdd857356db6b8ed46c5341cc8f85c4190ba/client/javascript/tls_socket.js). |
| MercuryWorkshop/rustls-wasm, commit `248dac2764a72e8141339a927690d90d130fc9f2` | Its exported `connect_tls` accepts streams and a hostname, installs Mozilla roots, and leaves configurable ClientConfig as a TODO. | A custom pin still requires an adapter change; use maintained rustls directly with the required verifier. [Source](https://github.com/MercuryWorkshop/rustls-wasm/blob/248dac2764a72e8141339a927690d90d130fc9f2/src/lib.rs). |
| openziti/libcrypto.js 0.26.0, commit `5497e3a6da9284d754f3edf68350a3738291494f` | Its SSL context source comments out the verification setup. The inspected API does not offer the peer-SPKI pin interface Tau requires. | Reject its default socket configuration for this trust boundary. [SSL source](https://github.com/openziti/libcrypto.js/blob/5497e3a6da9284d754f3edf68350a3738291494f/src/c/ssl.c). |

These are findings about the inspected APIs, not claims that the upstream
libraries cannot implement pinning internally. None supplies Tau's required
browser transport unchanged.

## Build and verification

The adapter source, dependency lock, generated bindings, WASM and license texts
are committed together. The browser Vite configuration verifies their manifest
hashes and emits the license text. Only the web entry imports the adapter, and
only after a Connect offer or saved session is used. Electron and native mobile
do not include it. Rebuild instructions are in
[browser-connect/README.md](../../browser-connect/README.md).

The targeted tests run the generated WASM against a real Node TLS host. They
check wrong SPKI and certificate pins before any WebSocket upgrade, renewal
with the same pinned key, and a 300 KB message. A separate integration test
uses a real CA-verified outer WSS relay, host approval with bound verification
digits, a paired-client token, compact-profile hello, requests, reconnect and
route cleanup. Lifecycle tests cover cancellation while the WASM module loads,
pin-failure cleanup and separation of relay authentication from host frames.

Storage tests use actual WebCrypto with an in-memory IndexedDB implementation.
They verify non-exportability, encrypted round trips, authenticated corruption
failure, forgetting and simultaneous first saves. The browser's non-exportable
key does not protect against scripts already running on the same origin;
WebCrypto permits those scripts to invoke cryptographic operations with it.
Serve the page from a trusted origin. [WebCrypto key model](https://www.w3.org/TR/WebCryptoAPI/#cryptokey-interface).

These tests exercise the transport and protocol, not every browser engine or a
deployed public relay. Production browser rendering remains part of release QA.
