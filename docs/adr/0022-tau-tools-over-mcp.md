# ADR 0022: Tau's tools reach every runtime over a local MCP endpoint

## Status

Accepted, 2026-09-23. Extends [ADR 0005](0005-thread-runtime-backends.md)
(runtime backends) and [ADR 0013](0013-agents-spawn-threads.md) (sub-agents).

## Context

Preview Kit and Agents Kit gave the agent their tools as Pi runtime
extensions (`registerRuntimeExtension`). A thread on Codex, the Agent SDK
runtime or Antigravity never saw them: the preview could not be driven and no
sub-agent could be spawned from there. Each of those programs already speaks
MCP and takes MCP servers in its own session configuration, so one MCP HTTP
server whose toolkits every provider is given closes the gap for all of them.

## Decision

**One endpoint in the host process.** `src/main/mcp-endpoint.ts` listens on
`127.0.0.1` on an ephemeral port, speaks Streamable HTTP without sessions
(a new MCP server object per request, JSON responses) and is started on the
first `connect`. The MCP SDK that was already in the dependency tree is
declared and imported on the first request only.

**A credential names a thread.** `services.mcp.connect({ sessionId, cwd })`
issues one random bearer token per thread and answers the server entry
(`name: "tau"`, `url`, `token`, `headers`). The token is the only way to a
thread: tool providers are asked with the thread the token names, so one
thread's runtime can neither list nor call another thread's tools. A turn
observer revokes the token when the thread's runtime closes, which also
aborts its calls in flight. Requests with another `Host` than the loopback
address or with an `Origin` are refused, so a page in a browser cannot use a
leaked port.

**Kits offer the tools Pi gets.** `services.mcp.registerTools(provider)`
takes Pi `ToolDefinition`s; arguments are validated with Pi's own validator,
sequential tools run one at a time per thread, and `execute` gets no
`ExtensionContext` over MCP. `services.mcp.gate(gate)` runs before every call;
a gate that throws blocks.

**Access applies alike.** Access Kit gates MCP calls with the same function
that gates Pi's `tool_call` hook, and its question is a confirm on the
thread's own dialog surface. The runtimes are told not to ask again for Tau's
tools (Codex `default_tools_approval_mode = "approve"`, the Agent SDK's
`allowedTools: ["mcp__tau"]`), so one call asks once. Taking a sub-agent's
work into the checkout (`tau_apply_thread_changes`) now asks like an edit, on
Pi as well.

**Runtime kits wire it in.** Codex passes `-c mcp_servers.tau.*` overrides
with the token in the environment (`bearer_token_env_var`), the Agent SDK
runtime an `http` entry in `mcpServers`, Antigravity an ACP `http` server on
`session/new` and `session/resume`. Without an endpoint a thread still runs,
only without Tau's tools.

## Consequences

Anything on this machine that can read a runtime's environment or arguments
can call that thread's tools while it runs; that is the same trust the
runtime's own process already has. The endpoint never binds beyond loopback,
also on a host that serves remote clients.

A tool that reads Pi's `ExtensionContext` must cope without it. A
thread-level access narrowing reaches another runtime's own tools only through
its launch policy. Agent definitions' `tools` reach Codex and the Agent SDK
runtime through `sessions.start({ tools })` and a filtered credential
(`connect(thread, { tools })`); Antigravity refuses them.
