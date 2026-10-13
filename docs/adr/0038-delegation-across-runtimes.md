# ADR 0038: Delegation across runtimes

Every runtime can delegate work through Agents Kit. A Tau child belongs to
its parent, appears in the Agents panel with its runtime icon, and has an
isolated worktree by default in a Git project. Outside Git it shares the
folder. Selecting `workspace: shared` remains an explicit choice.

## Native rule

On a runtime with native subagents, the server refuses `tau_spawn_thread`
when the effective runtime instance and model equal the parent's. The error
asks for native subagents or another runtime/model. Explicitly repeating the
parent's settings does not bypass this rule. A different model on the same
runtime, or a different runtime instance, starts a Tau child. Definitions and
the panel follow the same rule. A panel definition on the parent's settings
asks the parent to delegate natively.

The request's `runtime` and `model` override a definition's. The runtime
otherwise inherits. The model inherits only on the same runtime; another
runtime selects its own default when omitted. Explicit choices use the
composer catalog, including runtime instances, with the existing sign-in
readiness and project gate from ADR 0033. Unknown models are refused even
when a runtime reports an empty catalog. Bare model ids must match exactly
one catalog entry. Errors include runtime states and known model ids; no
catalog tool call is required before spawning.

The generic in-process `HostExtensionServices.runtimeChoices(cwd, kind?)`
service and `HostRuntimeChoice` type are API 1.60.0. The published API
constant remains unchanged by this decision. The service uses the
host's existing catalogs and gate, without adding delegation to core.

## Comparison with T3

The reference checkout's `delegate_task` and delegation service informed
this decision. Its children inherit the parent's checkout, so concurrent
writers can collide. Tau retains worktrees as its default. T3 describes
the native/model rule in a long prompt and asks callers to discover models
through `orchestrator_capabilities`. Tau checks the effective choice on the
server and keeps the instruction short.

T3 lists unavailable providers with constraints and refuses them at start;
Tau also checks readiness. T3's capability flags use provider constraints;
project enablement is checked separately when selecting and starting work.
The flags can therefore advertise a provider the current project disables.
Tau includes effective project enablement in each choice.

T3 validates requested models only if the provider
advertises at least one model. Tau rejects unknown models with an empty
catalog too. T3's top-level `t3_thread_launch` has no retry key; its delegated
tasks do have `clientRequestId`. Tau retains its existing spawn retry key,
including persisted pending intents.

T3's instructions prescribe direct MCP attempts and a terminal transport
fallback. Tau keeps one registered tool path. T3 wakes parents after child
completion and acknowledges consumed results; Tau retains its existing
durable notices, bounded result excerpts and MCP parent wakes. T3 workflow
stop cascades into delegated work. Tau's ordinary parent Stop leaves children
running; explicit child cancellation stops the subtree. This ticket preserves
that existing behavior.

## Verification limits

Host tests cover native parents, cross-runtime and same-runtime model choices,
definition starts, invalid choices and tool availability. A live cross-runtime
end-to-end run remains required; the review wave forbids starting the app.
