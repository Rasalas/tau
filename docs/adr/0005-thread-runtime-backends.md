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
