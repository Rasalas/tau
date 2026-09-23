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

Since then: one SDK session per thread, model and effort selection, and the
runtime of a new thread chosen in the workbench (`runtimeBackends` on the
snapshot, `preparePrompt(..., backendKind)`); `TAU_RUNTIME_ADAPTER` sets only
the default.

Pi's subscription logins: Pi reaches some providers through a consumer
subscription's OAuth and, for Anthropic, presents itself as Claude Code, which
that vendor's terms forbid outside its own apps. Tau does not hide those
models, because they are core Pi and Tau runs on the user's `~/.pi/agent`.
The Pi backend marks them (`UiModel.login: "subscription"`, from
`ModelRuntime.isUsingSubscription`), the workbench asks once per provider
before the first use, with the vendor's statement, and keeps a status item
while such a model is active. Sending is never blocked; `auth.json` is never
written. The Claude Code kit never sets the flag: the Agent SDK is the
sanctioned door for the same subscription.

Since 2026-09-22 the warning is a kit, `kits/subscription-login/`, and only
for the vendors that allow the login in their own apps alone (Anthropic,
Google); OpenAI allows it in third-party tools. Core keeps the flag and a
neutral tag in the picker, and lends the kit three seams any policy may use: a
composer gate before a model is chosen or a prompt is sent, a model badge in
the picker, and a region before the thread title. Switching the kit off
removes the shield, the badge and the question.


## Amendment, 2026-09-22: Codex, and the version of a runtime's program

OpenAI's Codex CLI is the third external backend, `kits/codex/`. It speaks
`codex app-server`, the JSON-RPC protocol over stdio that OpenAI's own
editor integrations use, not `codex exec --json`: the app server keeps a
thread across turns and processes (`thread/start`, `thread/resume` by Codex's
thread id), streams items and deltas, and asks its client for approvals as
requests (`item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `item/tool/requestUserInput`) that the kit
answers through `ask`. `exec` has no such channel: it would run either
unsandboxed without asking or sandboxed without a way to allow, and it
resumes only by re-running a rollout. The protocol is marked experimental and
its schema moves between releases, so the kit names the release it was built
and tested against, codex-cli 0.154.0, and refuses an older CLI with the
command that updates it. One app-server process runs per live thread; abort is
`turn/interrupt`, a steer is `turn/steer` into the running turn. Tau's access
levels map onto Codex's own policy: `read-only` is the read-only sandbox with
approvals `never`, `ask` is `untrusted` in the workspace-write sandbox (every
command outside Codex's known-safe list and every edit asks first), `full` is
`never` without a sandbox, which is what a Pi thread at full access does. The
login is the CLI's, `codex login` with a ChatGPT plan or an API key, and
`CODEX_HOME` passes through, so the sessions land where the user's Codex keeps
them. OpenAI allows the ChatGPT login in third-party tools, so no model is
marked `login: "subscription"`.

With three backends driving programs the user installs and updates, the seam
gained `version()`: a backend reports `{ tool, installed, latest?,
updateCommand }` and core asks once a day and publishes it on
`runtimeBackends`, where the picker's runtime tab and Settings → Defaults say
an update is out. The versions are the kits' to find — npm's `latest` for
Claude Code and Codex, the pinned release for Antigravity — through two leaf
helpers on `tau/host-extension` (`npmLatestVersion`, `packageUpdateCommand`).
Nothing is ever updated by Tau; the hint names the command.

The three kits' own Settings pages became one: a settings page that names a
`runtime` is that runtime's card on Settings → Providers (Claude Code, Codex,
Antigravity, in that order), each with the CLI and its version, the update, the
login and a path for the executable that the kit keeps in its state folder; an
environment variable (`TAU_CLAUDE_CODE_COMMAND`, `TAU_CODEX_COMMAND`,
`TAU_ANTIGRAVITY_ACP_COMMAND`) still wins. Pi has no card: its providers and
logins live in `~/.pi/agent` and Tau has no page for them, and Settings → Pi
is Pi's runtime configuration, not a provider's.

Still open: the kit's status page.

## Amendment, 2026-09-23: instances of a program, and a version policy

A user may run one program in several setups — two Codex accounts, each in
its own `CODEX_HOME`. Each setup is an instance and a backend of its own: the
default instance keeps the program's kind, so every thread from before stays
routable, and another one is `<kind>@<id>`. Because the thread index, the
virtual paths and the prepared prompts already key on the kind, a thread
keeps its instance without a new field in core; the kit's own store names
the instance too, which is what `listThreads` filters on. We considered one
backend per program with an instance id on each thread (T3 Code's
`providerInstances` route by instance id and keep the driver apart), and
chose the kind because core then needs no new routing at all: a registration
after start republishes the catalog and the index, and that is the whole
change to the host. The settings live with the kit
(`RuntimeInstanceSettings`, the default instance where the path override
was), the card, the dialog and the banner are one lazily loaded chunk on
`tau`.

`RuntimeToolVersion` gained `compatibility`: a kit's policy maps version
ranges to `supported`, `unsafe` or `broken`, with the release it was tested
with and the command that installs it. `broken` refuses a thread, `unsafe`
warns above the composer and on the card, and neither ever installs
anything: the command goes into a Terminal Kit shell, not run. Codex's
minimum release became the first such range. Antigravity keeps one instance:
Tau installs and pins its server, its versions are release tags no range
matches, and a second Google login would need a second profile and sign-in
flow of its own.

