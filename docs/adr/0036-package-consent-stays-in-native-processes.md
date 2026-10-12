# ADR 0036: Package consent on native and headless hosts

Accepted, 2026-10-12.

The workbench and desktop extensions share a realm and the host token, as
ADR 0020 states. A renderer can also claim an auxiliary window connection
with that token. An answer over the public host protocol therefore cannot
prove that a native confirmation dialog was shown.

Unapproved packages supply metadata only. Neither their desktop module nor
its top-level code is imported. When the host machine has a native window,
granting a package requires a dialog owned by its main process. An in-process
host calls that dialog directly. A separate host exchanges the request and
answer over a local filesystem socket in an owner-only directory, or a Windows named pipe.
Browser code cannot connect to this channel. It carries no host token and
has no public host method for answering requests. A reply is bound to the
native connection and a fresh request id.

When the host has no native window on its machine, `extension-grant` accepts
an Owner connection as defined in ADR 0024. Paired Write and Read-only devices,
and a host token over a non-local listener, cannot approve a package. The native
channel distinguishes an absent window from a refusal: cancellation, dialog
failure, timeout or disconnection during confirmation refuses that grant and
never enables this fallback. Revocation still works without confirmation.
Metadata-only loading prevents an unapproved
package from executing in the renderer in either mode.

Confirmation through a window's native uplink connection is deferred to
ticket 77 and is not part of this decision.

This channel trusts native processes running as the same OS user. It does
not sandbox already approved code or isolate desktop contributions from
their shared workbench. No extension API exports are added.
