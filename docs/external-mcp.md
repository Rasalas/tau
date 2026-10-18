# Read Tau from an external MCP client

Tau can grant a public OAuth client read access to selected projects on one
machine. It can list those projects, list their local threads, and read bounded
conversation text. It cannot start or steer threads, read arbitrary files,
execute tools, follow other machines or manage Tau. Conversation text can contain
anything the user or agent wrote, including sensitive information. Choose only
projects the client should be allowed to read.

## Publish an HTTPS address

Start Tau or its host service with `TAU_MCP_ORIGIN` set to a canonical HTTPS
origin, for example `https://tau.example.com`. Use Tau's TLS listener with a
trusted certificate or a local HTTPS reverse proxy. For a reverse proxy, enable
Tau's explicit loopback proxy listener, preserve the original Host header and
forward these paths to it:

- `/mcp`
- `/.well-known/oauth-protected-resource` and its `/mcp` variant
- `/.well-known/oauth-authorization-server`
- `/oauth/authorize`, `/oauth/consent`, `/oauth/token`, `/oauth/revoke`

Enabling `TAU_MCP_ORIGIN` keeps Tau's loopback proxy backend open. `tau mcp
status` shows its `proxyUrl`, which your HTTPS proxy forwards to. A host started
directly from a terminal can instead set `TAU_HOST_PROXY_LISTEN=127.0.0.1:48320`
for a dedicated backend. Ordinary plaintext loopback listeners reject the external OAuth routes.
Forwarded headers cannot turn one into a trusted HTTPS publication. Configure
your proxy to redact token request bodies and authorization response URLs in its
logs. Tau does not log those values. Configure an appropriate request limit at
the public proxy as well; Tau counts backend authorization attempts by the peer
address it actually sees, without trusting forwarded client addresses.

If a browser-based MCP client needs CORS, set `TAU_MCP_BROWSER_ORIGINS` to its
exact HTTPS page origins, separated by commas. Native and server clients may
omit Origin. Arbitrary Origins are refused; cookies do not authorize anything.

Hosted clients need a reachable address and publicly trusted TLS. Tau Connect's
current private WebSocket tunnel does not expose ordinary OAuth/MCP HTTP. Use
an actual HTTPS reverse proxy for this release. The issuer is bound to its
credential store; changing its origin requires a separate migration.

## Register and allow a client

Run the commands on the machine running Tau. `TAU_USER_DATA` selects a separate
instance when needed. A paired device or a remote access-key connection cannot
manage OAuth grants.

```sh
tau mcp status
tau mcp register --name 'My terminal client' --redirect http://127.0.0.1/callback
```

For a hosted client, register the exact HTTPS callback its setup provides.
Multiple `--redirect` options register multiple callbacks. Native loopback IP
callbacks can use an ephemeral port; scheme, IP, path and query remain fixed.
`localhost` callbacks are not accepted. Redirect URLs are never fetched by Tau.

Configure the client with its returned public client id and the resource URL
shown by `status`, `https://tau.example.com/mcp`. It must support authorization
code flow with S256 PKCE and the OAuth resource parameter. This release requires
preregistration; it does not support dynamic client registration or client
metadata URLs. A client that requires those mechanisms cannot connect yet.
Do not enter Tau's access key as the MCP bearer token.

Start the client's OAuth sign-in. Its browser waits while the owner inspects
the request:

```sh
tau mcp status
tau mcp approve <request-id> --project <project-id>
# Or refuse it:
tau mcp deny <request-id>
```

`status` shows client names, exact callbacks, pending requests, granted projects,
expiry and the available opaque project ids. Repeat `--project` to allow several.
Approval grants `tau:read` only. The browser returns the code to the client's
registered callback; the client exchanges it with its PKCE verifier. Owner
commands never print that code or bearer tokens. All command output is JSON.

## Revoke access

```sh
tau mcp revoke <grant-id>
tau mcp remove <client-id>
```

Revoking a grant stops further access immediately and cancels its active calls.
Removing a client also removes its grants and pending requests. Access tokens
last 15 minutes. Rotating refresh tokens keep an approved grant usable for up
to 30 days; reuse of a spent refresh token revokes the whole grant. Expired or
revoked access requires new owner consent. The client can also revoke its own
token through the advertised OAuth revocation endpoint.

Reads return at most 100 thread summaries per page and 32 conversation messages
with 4096 characters per message. Truncation is explicit. Attachments, thinking,
tool arguments and tool outputs are excluded. Transcript cursors select older
host pages; truncation does not provide a full export of long messages. Remote
machine proxy threads are excluded. Grants and pending requests, bodies, rates,
concurrent reads and response sizes are bounded.

The supported MCP wire version is **2025-11-25**. This is a read-access release;
runtime execution ceilings and externally controlled threads remain future work.
