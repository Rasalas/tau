# ADR 0036: Package consent stays in native processes

Accepted, 2026-10-12.

The workbench and desktop extensions share a realm and the host token, as
ADR 0020 states. A renderer can also claim an auxiliary window connection
with that token. An answer over the public host protocol therefore cannot
prove that a native confirmation dialog was shown.

Unapproved packages supply metadata only. Neither their desktop module nor
its top-level code is imported. Granting a package requires a native dialog
owned by the window's main process. An in-process host calls that dialog
directly. A separate host exchanges the request and answer over a local
filesystem socket in an owner-only directory, or a Windows named pipe.
Browser code cannot connect to this channel. It carries no host token and
has no public host method for answering requests. A reply is bound to the
native connection and a fresh request id. With no native window, a grant
is refused; revocation still works.

This channel trusts native processes running as the same OS user. It does
not sandbox already approved code or isolate desktop contributions from
their shared workbench. No extension API exports are added.
