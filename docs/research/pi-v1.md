# Pi 1.0 and Tau

Research note, 2026-10-03. Tau pinned `@earendil-works/pi-coding-agent` to `0.85.1` at the start of this investigation. The upgrade is tracked in [issue #26](https://github.com/Rasalas/tau/issues/26) and [PR #27](https://github.com/Rasalas/tau/pull/27).

## Release and meaning

Pi 1.0.0 shipped on October 1, 2026. GitHub marks it as the latest release, published at 19:20:55 UTC. The npm registry also reports `1.0.0` as latest for `pi-coding-agent`, `pi-ai`, `pi-agent-core`, and `pi-durable` under `@earendil-works`. Sources: [release](https://github.com/earendil-works/pi/releases/tag/v1.0.0), [coding-agent registry](https://registry.npmjs.org/@earendil-works/pi-coding-agent), [ai registry](https://registry.npmjs.org/@earendil-works/pi-ai), [agent-core registry](https://registry.npmjs.org/@earendil-works/pi-agent-core), [durable registry](https://registry.npmjs.org/@earendil-works/pi-durable).

Earendil presents 1.0 as the stable milestone for the existing Pi toolkit. It also launched Pi Durable, a separate experimental framework for long-running conversations, crash recovery, multiple clients, and multiple humans. Durable does not replace the coding agent. Sources: [announcement](https://earendil.com/posts/pi-1-0/), [Pi Durable](https://earendil.com/posts/pi-durable/).

Native MCP, sandboxed JavaScript tool orchestration through codemode, deferred tool discovery, virtual models, and ChatGPT login through the OpenAI provider arrived in 0.99.0. Version 1.0 improves codemode, adds image generation there, hardens MCP OAuth, and makes the terminal fullscreen by default. Sources: [0.99.0 release](https://github.com/earendil-works/pi/releases/tag/v0.99.0), [1.0.0 release](https://github.com/earendil-works/pi/releases/tag/v1.0.0).

## Relevant changes since Tau's 0.85.1

The upgrade crosses several documented breaking changes before reaching 1.0:

- In 0.86, provider streams receive `TranscriptContext`; custom providers read system prompts and tools from transcript messages. Tool-call arguments and tool-result details must be JSON-compatible. Source: [pi-ai changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/CHANGELOG.md#0860---2026-09-19).
- In 0.87, `SessionManager` becomes canonical for request history. Mutating `session.agent.state.messages` no longer changes future request context. New `context_edit` entries and extension boundary event shapes affect exhaustive switches and constructed events. `shouldStopAfterTurn` becomes `finishTurn`. Source: [coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/CHANGELOG.md#0870---2026-09-21).
- In 0.99, the separate image-model collection and plural image-model types disappear. Chat-only model access remains compatible. Source: [pi-ai changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/CHANGELOG.md#0990---2026-09-29).
- In 1.0, `pi-agent-core` removes the experimental harness, durable runtime, pico3, and related subpath exports. The ordinary `Agent` and agent loop remain. Durable consumers move to `pi-durable`. Source: [agent-core changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/agent/CHANGELOG.md#100---2026-10-01).

Tau uses the coding-agent session SDK, including `createAgentSessionServices`, `createAgentSessionFromServices`, `createAgentSessionRuntime`, and `ModelRuntime`. The local inspection found no use of `AgentHarness` or `shouldStopAfterTurn` in `src/main` or `kits`. The documented Durable extraction therefore does not itself require Tau to change harnesses. Tool details typed as `unknown` or containing `undefined`, session-history handling, and extension events deserve checks during an upgrade. This is a compatibility assessment, not a completed compilation against 1.0.

## Recommendation

Plan an ordinary dependency upgrade to Pi 1.0, with type checking, focused session and extension tests, and an isolated Tau run. Provider fixes, context handling, and the new tool facilities make staying current worthwhile. The reviewed announcements and release notes impose no migration deadline; they do not establish a support guarantee for 0.85.1 either.

Treat adopting Pi Durable as a separate architecture decision. Its crash recovery and shared conversations could be useful, but it is explicitly experimental and replacing Tau's existing session runtime would need its own evaluation. A 1.0 dependency upgrade does not require that replacement.

## Update policy for Tau

Keep the embedded SDK pinned and deliver tested SDK updates with Tau releases. Tau imports Pi's session, model, and extension APIs directly, so replacing the library independently of Tau would bypass compatibility checks. The prompt admission and mixed-model catalog adaptations in this upgrade are concrete examples.

Automatically detecting new releases and proposing dependency PRs would reduce maintenance delay while keeping those checks. Moving Pi behind its subprocess RPC protocol could allow independent runtime updates, but it would require evaluating the protocol against Tau's session lifecycle and extension integrations. That is a separate change to [ADR 0001](../adr/0001-embed-pi-behind-a-desktop-host.md), not a prerequisite for 1.0. Pi's published [RPC documentation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/rpc.md) describes the subprocess interface.

[Dependabot](../../.github/dependabot.yml) checks the two direct Pi SDK dependencies in the root project and package example on weekdays at 09:00 Europe/Berlin. Updates are grouped as `pi-sdk`, with one open version-update PR at a time, including major releases. Exact version pins remain exact. The existing pull-request CI runs lint, type checks, tests, build, and smoke checks; updates require review and merge before shipping with Tau. This configuration takes effect after it reaches the default branch. Configuration options: [GitHub documentation](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).

## Implementation findings

- Updated the Pi SDK and package example to 1.0.0.
- `AgentSession.prompt()` now calls `preflightResult` with `started`, `queued`, or `handled` after acceptance. Rejections throw without that callback. Tau maps those accepted dispositions onto its existing admission callback and preserves rejection errors. Source: [SDK source](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/core/agent-session.ts).
- MCP arguments prepared by host tools are checked as JSON objects before Pi schema validation, gating, or execution.
- Provider wrappers now augment both `getModels()` and `getAllModels()`. Pi's provider composition reads the mixed model collection when applying `models.json` overrides; overriding only the chat list loses Tau's additions there. Source: [provider composition](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/core/provider-composer.ts).
- Model-catalog tests use a fictional future model so a new builtin model does not invalidate their premise.
