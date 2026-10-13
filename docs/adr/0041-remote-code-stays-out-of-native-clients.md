# ADR 0041: Remote code stays out of native clients

Accepted, 2026-10-13. Amends [ADR 0025](0025-a-window-follows-the-threads-machine.md)
and the trusted workbench model in [ADR 0020](0020-host-command-authority.md).

A paired machine is trusted to run its own threads, not to install code on
the device showing them. A desktop extension shares the client's realm,
connection and native bridge. Approval on a remote machine cannot grant that
code the local owner's authority.

The Electron window and native phone app accept remote desktop halves only
when their id and SHA-256 of the received module and stylesheet match a kit
included in that client's installation. The digest is computed from the
bytes, never accepted from the host's `hash`, `scope`, grant or URL. Only the
final source-map directive is omitted because it names an installation path.
On a match the client executes its own copy with its own metadata and styles,
so a remote source-map URL or stylesheet URL is never loaded. Missing local
kits, changed code, changed styles and unknown packages fail closed with a
notice that their interface was not loaded. Safe mode accepts no remote kits.
There is no per-machine override or approval for unknown code.

An attached host, including `TAU_HOST_URL` on loopback, has an empty
`client-call` allowlist. It is neither advertised nor allowed to invoke local
window halves. Only the host started or adopted by this window's supervisor
can call its registered local halves. Unsolicited calls are refused before
dispatch even if the requested half exists. The window's own renderer retains
its local clipboard, attention and machine navigation through the IPC bridge.

On the phone, access keys, connection relay credentials, push keys and relay
handles use a secure-store namespace keyed by machine identity. The host list
and push-key routing index contain metadata only. Existing secrets migrate
when read and their legacy entry is removed after the scoped write succeeds.
Android's native notification service reads the same namespace, with a legacy
fallback until registration migrates an older key. Removing a machine's
credentials leaves other machines' credentials alone.

These namespaces are data separation, not a sandbox within JavaScript.
Shipped client code remains trusted and can use the native store to connect
to multiple machines. Keeping unknown remote code out before import is what
protects those credentials. A browser workbench delivered by a host continues
to trust that host's web application; it has no native secure-store bridge.
Remote hosts can still send hostile data or disrupt their own interface, and
local packages approved on the supervised machine retain the existing trusted
workbench model. Separate realms for third-party contributions are deferred.

No extension API export or service changes. Different client and machine
versions may have different kit bytes; their unmatched interfaces stay off
until the installations agree.
