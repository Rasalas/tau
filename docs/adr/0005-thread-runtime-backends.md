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
backend per program with an instance id on each thread (routing by instance
id and keeping the driver apart), and
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

## Amendment, 2026-09-23: interaction modes

A thread's turns run in an interaction mode: `default`, or one its runtime
adds. The first is `plan`: explore, ask, and propose a plan without changing
anything. Like the access level, the mode reaches a backend in Tau's
vocabulary and the backend maps it onto its own policy: the capability group
`mode` (`modes`, `current`, `set`) on the backend, `modes` on the adapter's
capabilities for a thread that does not exist yet. Unlike the access level it
belongs to the thread, not the workbench, and the backend keeps it: Codex in
its record and as the collaboration mode of every turn (which needs the app
server's experimental API), the Agent SDK runtime in its record and as the
`plan` permission mode, Pi as a `tau.mode` entry in the session file that a
runtime extension reads. Pi has no plan mode of its own, so the modes a Pi
thread offers are the ones runtime extensions declare; Plan Kit declares
`plan`. However a runtime plans, the plan reaches the transcript as a reply
holding a `proposed_plan` block, which is text every backend already keeps.
Antigravity offers no mode yet.

## Amendment, 2026-09-30: Tau-managed ChatGPT plan connections

The Codex kit now offers the official open-source Sign in with ChatGPT flow
alongside CLI-owned logins. Its reusable `chatgpt-plan` modules own OAuth,
verified identity, registration storage, model discovery, token renewal and
revocation. They register no core feature and add no core authentication state.

A plan connection belongs to one runtime instance. Its issued client ID stays
bound to the verified subject after sign-out. Adding another account means
adding another instance; a thread never switches registrations. Initial plan
registration is refused on an instance with existing CLI threads because moving
its Codex home would otherwise lose access to those conversations. Removing an
instance clears its renewable session but retains its registration mapping,
just as removing an instance retains its threads for restoration with that ID.

For plan connections, Tau supplies a pinned, checksum-verified upstream Codex
package unless the user explicitly overrides its executable with a supported
release. The package includes the platform's runtime helpers. Tau owns that
installation and advertises no user CLI update command for it. When a Tau
update pins another release, the host fetches it at start without being
asked, shows the progress on the card and above the composer, and removes the
release it replaced; the user never needs a console. This supersedes the
earlier statement that the Codex kit never installs anything. CLI-owned logins
keep their account storage and use the user's executable where there is one.
An instance without an executable override and with no `codex` on the PATH
runs Tau's managed Codex once Tau has it, and its card says "Managed by Tau".

The plan connection's `CODEX_HOME` is under Tau's state, isolated from the
user's CLI account and configuration. Credentials are stored atomically with
owner-only permissions and rotating-token refreshes are serialized across host
processes. The session's access token goes only into the child process
environment. Before another turn, the kit refreshes near expiry and compares
the current token with the launched process's token. A changed token closes
that process, initializes its replacement and resumes the stored Codex thread.
It never automatically replays an interrupted or failed turn.

The kit's workbench half draws the account and usage controls through existing
sign-in commands and composer regions. The account-specific `/v1/models`
catalog limits the available model IDs; Codex's catalog contributes model
capabilities and reasoning choices. The official Responses provider disables
WebSockets and server-side response storage. Local tools remain available;
hosted connector and image-generation features are disabled. Pi integration
can reuse the OAuth modules in a separate change.


## Amendment, 2026-09-30: compatible Codex executing accounts

A Codex thread may change its executing account between idle turns without
changing its durable runtime backend owner. Its backend kind and owning
instance keep identifying the same Tau thread, transcript, tools, permissions
and canonical Codex session. This is a narrow same-driver account operation
in the Codex kit, not a general runtime migration capability.

CLI accounts are compatible only when they share a canonical session home,
use the same launch configuration and have separate auth homes. An auth
overlay links shared runtime data, including session files and MCP OAuth
locks, while auth.json and model caches remain private files. Tau never
copies credentials between accounts or overwrites conflicting overlay data.
The account must be signed in. Tau refuses switches while prompts are being
admitted, a turn runs or a session opens. It resumes the exact canonical
session under the new account before persisting the executing account; a
failed resume restores the original selection and never creates a substitute
conversation. Later resumes of switched threads keep that restriction.

Managed ChatGPT registrations keep independent credential stores and effective
homes. They may share canonical rollouts when both instances explicitly
configure the same shared home before creating their conversations. Tau
uses the same Responses provider with response storage disabled, restarts
the process with the selected registration's token, and resumes the local
Codex session. Independent managed homes and mixed CLI/managed provider
connections remain incompatible. No account ID or email is used to infer
compatibility or combine credential registrations. Model
catalogs, billing and account-limit updates follow the executing account,
while per-thread MCP credentials retain the same Tau thread and access policy.

The protocol fields were checked against `codex app-server generate-ts
--experimental` from CLI 0.159.2 with a fresh temporary home and the
[official app-server documentation](https://developers.openai.com/codex/app-server).
The compatibility and catalog behavior follows T3 Code v0.0.44's
[home layout](https://github.com/pingdotgg/t3code/blob/v0.0.44/apps/server/src/provider/Drivers/CodexHomeLayout.ts)
and [tier catalog](https://github.com/pingdotgg/t3code/blob/v0.0.44/apps/server/src/provider/Layers/CodexProvider.ts),
implemented through Tau's existing kit interfaces.

The [official account-switching guidance](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
requires distinct validated registration/client/token mappings. The
[managed app-server contract](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
supplies the selected OAuth token through the child environment and resumes
a saved thread after restarting the process. Sharing local rollouts for
stateless Responses turns is Tau's implementation choice; successfully
resuming locally does not prove the target account's inference entitlement.
