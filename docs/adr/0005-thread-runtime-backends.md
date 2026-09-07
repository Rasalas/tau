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

Claude Code is the first such provider, shipped as the kit `tau.claude-code`
under `kits/claude-code/` (adapter, thread backend, session store, tests), a
package Tau ships (ADR 0014) rather than a host constructor. Removing that extension leaves Pi as the only
backend; `TAU_RUNTIME_ADAPTER=claude-code` then stops the host start with a message
naming the missing extension. What the renderer needs to know about
a backend travels as runtime capabilities (`ownsModelSelection`,
`interactiveApprovals`, the skill dialect), not as a backend name; the user's
access level reaches a backend as `read-only`, `ask` or `full`, and the
backend maps it onto its own policy.

## Amendment, 2026-09-04: the seam speaks Tau, not Pi

`ThreadRuntimeBackend` had 45 members and typed three of them against the Pi
SDK (`Parameters<AgentSession["prompt"]>`, `Parameters<AgentSession["steer"]>`,
`ReturnType<AgentSession["executeBash"]>`). The interface therefore contradicted
this ADR, and a backend that is not Pi had to implement Pi-shaped operations
only to throw from them.

The seam now lives in `src/main/runtime-types.ts` and names nothing outside
Tau. A backend must answer twenty members: its identity (`kind`,
`runtimeAdapter`, `threadId`, `providerSessionId`, `cwd`, `capabilities`,
`turnReporting`), its lifecycle (`start`, `dispose`, `state`, `waitForIdle`),
its turns (`preparePrompt`, `prompt`, `abort`), its transcript (`transcript`,
`persist`, `setTitle`) and its catalog (`catalogView`, `models`,
`composerCommands`). `state()` is one cheap synchronous view — streaming, idle,
title, session file, active tools, image support, extension count — instead of
a dozen accessors. `turnReporting` says who reports run state: a streamed
runtime publishes its own events, an awaited one resolves `prompt` when the
turn ends and the host tracks the turn for it.

Everything else is a capability group under `capabilities`: `journal`, `tree`,
`fork`, `shellAction`, `compaction`, `catalogWrite`, `completions`,
`extensions`, `reload`, `events`, `transcriptPaging`, `markdownExport`,
`newThread`. The host asks for one through `requireCapability`, which raises a
single typed `UnsupportedOperationError`; there is no per-site "this runtime
cannot do that" message any more. A missing group is the whole answer: Claude
Code declares none, so every Pi-shaped operation is refused in one place rather
than in thirteen stubs.

The Pi terminal Tau attaches to is a backend of the same seam
(`AttachedThreadBackend`), not a set of branches in the host. It offers
`fork` (Pi forks itself and reports a snapshot), `compaction`, `catalogWrite`,
`reload`, `transcriptPaging`, `markdownExport` and `newThread`, and offers no
`journal`, `tree`, `shellAction` or `extensions`, which is exactly the list of
things Tau used to refuse with a hand-written message. The host keeps that
thread beside its runtime registry and resolves it like any other, so the only
questions it still asks about ownership are which runtime is active, where a
transcript snapshot comes from, and when to attach or detach.

## Amendment, 2026-09-07: the Agent SDK replaces print mode

The kit no longer runs `claude --print`. It drives the user's installed,
unmodified `claude` through `@anthropic-ai/claude-agent-sdk` `query()`: the
`claude_code` system prompt preset, the user's own setting sources (`user`,
`project`, `local`), the store's UUID as `sessionId` on the first turn and as
`resume` afterwards, and `CLAUDE_AGENT_SDK_CLIENT_APP` naming Tau. Tau sets
neither Claude Code's headers nor its prompt itself; that is the one door
Anthropic's terms leave open for a subscription
(`docs/research/subscription-and-third-party-tools.md`). The hand-maintained
`--tools` allow-lists are gone: Claude's permission modes and the user's own
rules govern tools, the way Pi's own configuration governs Pi threads. This
supersedes "installation defaults are never used" above.

Tau's access levels map onto Claude's permission modes: `read-only` is `plan`,
`ask` is `default`, `full` is `auto`. No dangerous bypass flag is ever passed.
Manual approvals are supported: the SDK's `canUseTool` and `onUserDialog`
callbacks are answered on the workbench's own dialog surface (allow, allow for
this session, deny; `AskUserQuestion` as one select per question, keyed by the
full question text; `ExitPlanMode` as a confirm; the resume-compaction question
as a select). A session allowance is rescoped to `destination: "session"` so it
never lands in a settings file. `interactiveApprovals` is therefore true.

Two routes on the seam make this possible for any backend without a host-owned
journal, not only Claude's. `HostBackendOpenContext.onEvent` carries
`ThreadRuntimeEvent`s (turn, assistant, tool, queue, notice, usage) in Tau's
vocabulary; `src/main/backend-events.ts` turns them into workbench events with
the bookkeeping the Pi path does, and `ThreadRuntime.adapterActivity` keeps one
activity entry per turn so the non-Pi snapshot carries tool folds, cost and
context like a Pi thread's. `HostBackendOpenContext.ask` puts a backend's
question on the same surface Pi's extension dialogs use; aborting the thread
answers it as cancelled. Turn observers bracket an external streamed backend's
turn too (checkpoints, the Agents kit's status); an attached Pi stays out, its
terminal owns turn and journal alike. Extension API 1.4.0.

Still open: one SDK session per thread with steering and queued follow-ups,
model and effort selection, and the kit's status page.
