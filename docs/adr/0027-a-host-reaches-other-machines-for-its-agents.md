# ADR 0027: A host reaches other machines for its agents

## Status

Accepted, 2026-09-25. Builds on [ADR 0024](0024-pairing-allowed-on-the-host.md)
(pairing) and [ADR 0025](0025-a-window-follows-the-threads-machine.md) (a
window's machines), whose catalog stays as it is. Wave H builds remote work on
top of it.

## Context

The user wants to move work to another machine (the small Linux box "rex") and
steer it from here. A subagent starts on the host (`tau_spawn_thread` in
`kits/agents/host.ts`), but only the window knows other machines. The catalog
belongs to the window's process and keeps its tokens in `safeStorage`. A host
started as a service, or one whose window is closed, has no way to reach rex.

The user decided (plan-H, decision 1) that this machine's agents get a device
key of their own on the other machine. It comes with the window's pairing, so
the owner there allows both in one step, and each one can be revoked alone.

## Decision

**The host keeps machines of its own.** `src/main/host-machines.ts` keeps them
in `<userData>/host-machines.json`, mode 0600. An entry has the same fields as
a window's (host id, name, addresses with kinds and CA flags, the pinned key,
the token). The token is kept in the clear, like `host-token`, because the host
runs without Electron and has no keychain. The host holds one connection per
machine, the `EnvironmentMonitor` a window uses (ADR 0025). It skips the thread
index and subscribes to the topics its kits watch there.

**One approval lets in two devices.** A `pair` frame may carry
`companion: { name? }`. The owner of the other machine sees one request that
names both, "Mini" and "Mini · Agents". `connections-approve` writes two records
with their own tokens and the same preset, and answers the second token as
`companion`. The agents' record names the window's record (`companionOf`).
Connections lists them apart, the audit log tells them apart, and revoking one
leaves the other working. A host that predates this ignores the field and lets
in the window alone. The window then says that the agents were not let in.

**The window hands the key over.** `environments-pair` asks for the companion
unless its input says `agents: false`. The window saves its own token as
before and passes the agents' token to its host with `machines-add`. The
`machines-*` methods are `owner` methods, so only the host token from this
machine may call them, like `connections-*`. A saved machine gets its agents
later through `environments-set-agents [id, true]`: a pairing for the agents
alone, pinned to the saved key, with the digits shown as usual. `false` and
removing the machine take the key back from the host. The other machine keeps
listing the device until its owner revokes it, since no device manages access
there (ADR 0024). Settings → Machines has the switch per machine and one in
the add form.

**Kits reach the machines through `services.machines`.** The seam needs the
`machines` permission. It has five members:

- `list()` and `subscribe(listener)`: each machine's status, never a token.
- `call(machine, extensionId, command, input)`: a kit command there, sent as
  `host-extension`. The other machine checks it like any call of a paired
  device (preset, `access: "read"`, audit).
- `request(machine, method, params)`: only the core methods in
  `MACHINE_REQUEST_METHODS` (`src/shared/host-method-access.ts`), the thread
  reads and `abort`, `steer`, `follow-up`. Any other name is refused before it
  leaves. Access management, jobs, subscriptions and a window's methods are
  never sent.
- `watch(machine, topic, listener)`: events that kit emits there under a
  topic. The kit is the caller's own counterpart unless `extension` names
  another one.

A machine is named by its host id, or by its name when that is unique. An
offline or refused machine rejects with the reason.

Wave H added two members on the same permission: `upload(machine, source)`
sends a file there in pieces, which a kit there takes once with
`services.blobs.take`, and `self` names this host (id, name, Tau version).

## Alternatives

- **Reuse the window's key.** The host would have to read the window's
  `safeStorage`, which it cannot, and revoking the window would stop the
  agents too. The owner over there could not tell them apart either.
- **Pair the host by itself.** A second approval for the same machine, from a
  process without a screen to show the digits on. Bundling it with the
  window's request costs the owner nothing.
- **Let the window forward the agents' calls.** Then a subagent could only
  reach rex while a window is open, which is what the user wants to avoid.

## Consequences

- A host started as a service reaches rex with no window open. Remote work
  (plan-H §2 to §5) builds on `call`, `request` and `watch`.
- The agents' key sits in the clear in a 0600 file, as the host token does.
  Whoever can read the host's user data can act as its agents over there.
- A device that pairs Read only gives its agents Read only as well. The owner
  can change either preset afterwards.
- A host in the window's process (`TAU_HOST_INPROCESS=1`) keeps no machines.
  The seam is absent there and in a worker, and `machines-*` answer
  `unsupported`.

## Out of scope

- Moving files and repositories between hosts (H02, H05), readiness and load
  (H03), and threads started over there (H06). This ADR covers the connection
  only.
- A long kit command sent to another machine as a job. `call` waits up to its
  timeout (30 s by default).
- A device revoking its own key on the other machine when it is turned off
  here.
