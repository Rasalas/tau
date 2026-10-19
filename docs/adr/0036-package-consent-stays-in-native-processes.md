# ADR 0036: Package consent on native and headless hosts

Accepted, 2026-10-12.

The workbench and desktop extensions share a realm and the host token, as
ADR 0020 states. A renderer can also claim an auxiliary window connection
with that token. An auxiliary hello alone therefore cannot prove that a native
confirmation dialog was shown.

Unapproved packages supply metadata only. Neither their desktop module nor
its top-level code is imported. When the host machine has a native window,
granting a package requires a dialog owned by its main process. An in-process
host calls that dialog directly. A separate host exchanges the request and
answer over a local filesystem socket in an owner-only directory, or a Windows named pipe.
Browser code cannot connect to this channel. It carries no host token and
has no public host method for answering requests. A reply is bound to the
native connection and a fresh request id.

Amended, 2026-10-13. A window showing another machine can confirm through its
own main-process uplink. Its hello opts into native package dialogs. The host
accepts that opt-in only if the authenticated WebSocket upgrade carries
`Sec-WebSocket-Tau-Native: 1` and has no `Origin` header. Browser WebSockets cannot
set this custom upgrade header, including a renderer that claims an auxiliary
connection. The desktop session strips Origin for saved machines, so an absent
Origin alone is insufficient. This trusts native processes holding the same
credential, not arbitrary claims in protocol data. Proxies must preserve the
native header and must not add it to browser upgrades.

The request goes only to the native uplink with the requesting connection's
window id and authenticated credential. The existing `client-call` mechanism
mints a fresh id and accepts a `client-call-result` only from that one connection.
Renderer replies, replies from other windows and stale ids cannot settle it.
Cancellation, a failed dialog, timeout or disconnection returns a refusal, never
an absent-window result. This narrowly permits the core consent dialog on an
attached machine; it grants no kit window-half rights under ADR 0041 and does
not authorize remote code to execute on the client.

When neither the requesting window's native uplink nor a native window on the
host machine is available, `extension-grant` accepts
an Owner connection as defined in ADR 0024. Paired Write and Read-only devices,
and a host token over a non-local listener, cannot approve a package. The native
channel distinguishes an absent window from a refusal: cancellation, dialog
failure, timeout or disconnection during confirmation refuses that grant and
never enables this fallback. Revocation still works without confirmation.
Metadata-only loading prevents an unapproved
package from executing in the renderer in either mode.

The local channel trusts native processes running as the same OS user. It does
not sandbox already approved code or isolate desktop contributions from
their shared workbench. No extension API exports are added.

Amended, 2026-10-19. A package `tau_new_package` wrote for the user is the user's
own work, and a thread at Full access already runs any command as the user. That
agent could write the grants file itself, so for it the card and the native dialog
were friction, not a boundary. In such a thread `tau_install_package` grants an own
package and starts it without either; the user sees a toast with "Turn off". The
host decides this, not the tool: it needs the host's own record that the scaffold
wrote that folder, and the level the Access Kit holds for the calling thread
(`setPermissionLevel`) to be Full access. Read-only and Ask threads keep the boundary:
the card and the native dialog, now worded as the concrete questions the manifest
raises (start programs, reach the internet, read and change project files, act in
Tau's window, run inside Tau's process), and only the new ones once the user allowed
the package before.

The record lives in an owner-only file next to the grants, keyed by package id,
real folder and the folder's inode. Nothing in a package folder can state it, a
folder made again by hand does not match it, and no connection, renderer or
package method writes it except the scaffold. A grant made for an own package is
marked as such and no longer binds the content hash, as long as the record still
matches; permissions and isolation stay bound, so a change there turns the package
off until it is allowed (Ask) or started (Full) again. A package the user turned off
stays off for Full access threads until the user turns it on. Packages from npm, Git,
hand-copied folders and anything else the host did not write are unchanged.
