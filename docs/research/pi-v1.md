# Pi 1.0 and Tau

Research note, 2026-10-03. Tau currently pins `@earendil-works/pi-coding-agent` to `0.85.1` in `package.json`.

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
