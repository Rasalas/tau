---
status: accepted
---

# Thread-owned runtime backends

Each thread has one durable runtime backend for its entire lifecycle. Pi
threads are owned by `AgentSessionRuntime` and its `SessionManager`; Claude Code
threads are owned by the Claude adapter and its app-data session store. The host
routes lifecycle, transcript, catalog, prompt, abort, and persistence operations
through that backend. A Claude thread never obtains a Pi session as a carrier,
and a Pi session never receives Claude's prompt dialect.

Claude Code is launched through its installed CLI's non-interactive `--print`
protocol with an explicit `--permission-mode`, `--tools`, and `--allowed-tools`
policy, followed by `--` before the user prompt. Tau's `ask` mode maps to
Claude's `manual` mode, but manual approvals require an interactive terminal
that the print transport cannot surface, so Tau rejects that launch before
spawning a child. Read-only and full modes use the explicit `plan` and `auto`
policies respectively; no dangerous permission-bypass flag is ever passed.

Claude session ids and the visible normalized transcript are persisted
append-only in an atomic, permission-restricted app-data file. Launch attempts
are recorded before spawning, and a missing resumed session can recover through
one persisted create fallback. Renderer-facing messages contain only visible
user text and typed skill metadata; runtime wrappers, bodies, and filesystem
locations stay inside the host/backend boundary.

## Amendment, 2026-09-02: backends come from extensions

The host knows one backend kind, Pi. Every other kind arrives through the
seam's `registerRuntimeBackend(provider)`: the provider carries the runtime
adapter (dialect and capabilities), lists and looks up the threads it
persisted, opens a thread's backend on request and offers the composer
commands for it. Core creates, resumes, indexes and prompts such threads
through the provider and never learns which program answers; their shell
paths are virtual (`tau-thread:<kind>:<id>`).

Claude Code is the first such provider, bundled as the host extension
`tau.claude-code` under `src/main/extensions/claude-code/` (adapter, thread
backend, session store, tests). Removing that extension leaves Pi as the only
backend; `TAU_RUNTIME_ADAPTER=claude-code` then fails at the first thread with
a message naming the missing extension. What the renderer needs to know about
a backend travels as runtime capabilities (`ownsModelSelection`,
`interactiveApprovals`, the skill dialect), not as a backend name; the user's
access level reaches a backend as `read-only`, `ask` or `full`, and the
backend maps it onto its own policy.
