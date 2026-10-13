# ADR 0040: The owner may read the access key, and nobody else

## Status

Accepted, 2026-10-13. Adds a method to [ADR 0024](0024-pairing-allowed-on-the-host.md)'s
owner class; nothing there is weakened.

## Context

A browser signs in with a pairing link, by asking to connect, or with the access
key (the host token). The first two need a window on the machine that can allow
them. A machine the owner reaches without one, such as a server, needs the key,
and the only place it was written down was the token file, found from the docs
with a console.

## Decision

`connections-host-token` (API 1.61.0) answers `{ token }`: the key itself. It is
an `owner` method like the other Connections methods, so `isHostOwner` decides,
and nothing else does: a connection with the host token, from this machine,
through the loopback listener, or the in-process window. Refused:

- every paired device, Full or Read only;
- the host token over a LAN, proxy or Connect listener;
- a call inside a job. A job's result is pushed to every client and kept in the
  push log for replay, so `start-job` refuses this method and the rotation,
  which answers the new key the same way.

Settings → Connections → This machine → Access key shows the key hidden. The
page does not read it: Show and Copy do, and neither keeps it past the press
unless the key is shown. Hiding, leaving the page or rotating drops it. Copy
writes to the client's own clipboard (the page's, in a browser). The row says what the key is worth: whoever has it can use this machine
as the owner does.

The key is in no list, bootstrap, snapshot or push. The audit never records an
answer, and the owner's calls are not audited.

## Weighing

- The owner could already hold a valid key: rotating answers the new one to the
  caller. Reading it adds no authority; it removes the need to sign every other
  window out first, and the need for a console.
- A key on screen can be photographed, and one on the clipboard can be pasted
  by mistake. Hidden by default, one press to show, and a notice that names who
  may have it are the limits; the key stays what it was, a secret the owner
  carries to their own devices.
- The window's page is the one desktop extensions share (ADR 0020). One that is
  turned on can ask as the window does, as it could already rotate the key. This
  is not a new boundary.
- A paired device that needs more asks to connect or opens a link; it never
  needs the owner's key, and a leaked key off the machine still cannot manage
  access (ADR 0024).

## Consequences

- An older host answers `unknown-method`; the row says its Tau is older.
- A key rotated in another window is stale on screen only until the page is
  left or the row is hidden; the host always answers the file's current key.
