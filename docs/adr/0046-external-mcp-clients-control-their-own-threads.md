# ADR 0046: External MCP clients control the threads they start

Accepted, 2026-10-30. Amends [ADR 0045](0045-external-mcp-clients-use-separate-oauth-grants.md);
keeps [ADR 0022](0022-tau-tools-over-mcp.md) and [ADR 0020](0020-host-command-authority.md).
The private per-thread loopback endpoint and its credentials stay unchanged.

## Decision

**What `tau:threads` allows.** A grant with `tau:threads` adds four tools to the
three read tools every grant keeps: `tau_start_thread` (project, first message,
optional title, runtime and model), `tau_send_message` (an idle thread starts a
turn; a running one is steered, or queued with `delivery: "queue"`, as the
composer does), `tau_stop_thread` (the stop button: wakes drop, queued user
messages wait for the owner) and `tau_thread_status` (idle, running or
waiting for the owner's answer, last activity). Every call takes a fresh lease
on the grant, checks the scope and the named project, and resolves thread ids
inside that project on this machine. No generic dispatcher, no fabricated
runtime session. Only `tau_thread_status` is annotated read-only.

**Only threads it started.** `src/main/external-mcp-threads.ts` records, in
`<userData>/external-mcp-threads.json`, which grant started each thread. Send
and stop require that grant; every other thread in an approved project stays
read-only for the client, whoever owns it. A fork of such a thread keeps its
ceiling but not the client's control.

**The grant's execution is a ceiling on every turn.** `read-only`, `ask`
(default for every new control grant), `auto` or `full` (only when the owner
names it). It is the Access extension's per-thread level, so the strictest of
the owner's workbench level and the ceiling applies to Pi's tool gate, to
Tau's MCP tools and, through `setPermissionLevel`, to every other runtime.
Before the first prompt (`beforePrompt`) Tau sets it, writes the
`tau.external-mcp/thread` entry into a Pi thread (other runtimes keep no
journal) and records the grant; any failure discards the thread unprompted. A
record without an entry is never dropped from the registry: when it is full of
those, new starts are refused. It is set again before every prepared
turn (a core turn observer), on every accepted steer or queued message, before
every control call and for every recorded thread once the host has started,
because the Access extension keeps levels in memory. A ceiling below `full`
that the Access extension does not confirm refuses the call or turn. Questions
an `ask` ceiling raises reach the owner in Tau, never the client.

Runtimes read the level when a turn starts: Pi's gate per tool call
(`kits/access/gate.ts`), Claude Code per prompt with `setPermissionMode` on a
live session, Codex in every `startTurn` policy, OpenCode, ACP, Grok and Cursor
before each prompt. Only those are driven below `full`, an allowlist by kind.
Antigravity has no read-only mode and asks instead, so it takes `ask` and
`auto` only; a generic ACP agent without matching session modes runs as it
likes, so it takes `full` only; a thread on another machine (`machine`) runs
under that machine's own level and is refused.

**Revocation stops the grant's turns.** Revoking a grant, a client, a token,
or refresh replay cancels its calls (the lease), then stops the running turns
of the threads it started. The threads and their ceilings stay; the owner may
continue them. Expiry only ends further calls; a running turn finishes.

**Local clients use owner-issued tokens on loopback.** Without a public origin,
`src/main/external-mcp-local.ts` serves the same tools on `127.0.0.1`. It is
off until the owner turns it on or creates the first token; its port is kept
in `<userData>/external-mcp-local.json` so client configurations survive
restarts. Like the per-thread endpoint it refuses any Host but
`127.0.0.1:<port>` or `localhost:<port>` and every request with an Origin; it
has the HTTPS resource's body, concurrency and per-grant rate limits and slows
failed tokens. Tokens are personal: a name, projects, read or control, a
ceiling and an optional expiry, shown once and stored hashed (0600) by the same
authorization store with a `local` issuer in its own file, never mixed with
OAuth grants. The SDK negotiates any protocol version it supports on loopback;
the HTTPS resource still pins 2025-11-25. `tau mcp serve` bridges stdio-only
clients to the listener with `TAU_MCP_TOKEN`.

**Owner management.** `external-mcp-manage` keeps its owner-only policy;
`local-status`, `local-create`, `local-revoke`, `local-enable` and
`local-disable` manage tokens and the listener, and Settings → Connections →
MCP clients offers them with ready Claude Code, Codex, JSON and stdio
configurations. The OAuth `approve` action now takes `scope` and `execution`,
and the metadata lists `tau:threads`; the requested scope is never granted
without the owner naming it.

## Still unavailable

Terminals, arbitrary paths, files outside conversation text, secrets and
secret requests, access management, extension installation, answering the
owner's questions, changing an existing thread's runtime, model or ceiling,
deleting threads, threads on other machines, hosted or public delivery beyond
`TAU_MCP_ORIGIN`, CIMD and dynamic client registration.

## Consequences

The ceiling survives the Access extension reloading. Core holds every recorded
ceiling itself and clamps the level every non-Pi runtime reads, with or without
the extension (`setThreadCeiling` in `host-ports.ts`); while no extension
provides a level, Tau's MCP tools refuse those threads. The moment `tau.access`
activates again, every recorded ceiling goes back in, so Pi's gate and the MCP
gate hold it before any turn is prepared. Core narrows as the host itself, not
as a kit, in a slot of its own, so a kit lifting its own narrowing never lifts
the client's; `thread-level` is owner-only for clients, so a paired device
cannot lift it either. The in-process host (`TAU_HOST_INPROCESS=1`) attaches the
same registry. Turning
the Access extension off refuses control below `full`, and the owner's own
turns in those threads.

The rail row and the thread's head mark a thread an MCP client started:
"Started by <client> · <ceiling>".
