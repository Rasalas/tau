# ADR 0045: External MCP clients use separate OAuth grants

Accepted, 2026-10-18. Extends [ADR 0022](0022-tau-tools-over-mcp.md).
The private loopback MCP endpoint and its thread credentials remain unchanged.

External OAuth clients are independent of workbench devices and agent threads.
The host owns their registration, consent, token lifetime and revocation, as it
owns connection authority under [ADR 0024](0024-pairing-allowed-on-the-host.md).
Only its established local owner principal manages these grants. A browser
authorization page waits for that owner; it never approves itself.

The owner configures one canonical HTTPS issuer through `TAU_MCP_ORIGIN`.
Existing TLS listeners and explicit local reverse-proxy listeners carry its
HTTP routes. Routes check the configured Host and allowed browser Origins;
they do not infer an issuer or TLS authority from forwarded headers. A local
proxy must terminate HTTPS and preserve Host. Connect's existing private
WebSocket tunnel does not publish these ordinary HTTP routes.

Public clients are preregistered with exact callbacks. Native loopback IP
callbacks may change only their listening port. Authorization uses S256 PKCE,
resource-bound opaque tokens and explicit project consent. Short access tokens
and rotated refresh tokens refer to durable grants, with hashes stored privately.
Refresh reuse revokes the grant. Every tool call checks live grant authority;
revocation cancels calls and prevents late results from reaching clients.

External tools use a dedicated read-only host interface. They do not fabricate
a runtime session, inherit a thread's tool providers, invoke generic host methods
or receive workbench owner authority. The first HTTP release exposes selected
local project names, thread summaries and bounded conversation text. Host
projection preserves shell-execution provenance so those records, including
commands excluded from model context, never become exported conversation text.
Thread
control and the `tau:threads` scope remain unavailable until their execution
ceilings can be enforced through actual runtime admission and resumed threads.

The verified MCP wire version is 2025-11-25, matching the installed SDK. OAuth
metadata is not a claim of 2026 transport support. CIMD and dynamic registration
are not implemented; preregistration supports clients that accept a client id.
Universal compatibility with hosted products requires separate interoperability
evidence. See [authorization research](../research/external-mcp-oauth-2026-10-18.md).
