# Claude terminal results, 29 October 2026

Implemented the confirmed Claude follow-up from `t3-runtime-parity-2026-10-29.md`. Read `AGENTS.md`, `CONTEXT.md` and ADR 0005. Changes are confined to `kits/claude-code/` and this report.

## Sources

- Upstream checkout `/tmp/tau-t3code-upstream-20261029`, verified at `7a4f5b6188fed54ddc866723e39446a198b5835c`.
- [T3 #19136, commit 55a8fe9a938c61ef6e6bce718c58647ebdb4c88d](https://github.com/pingdotgg/t3code/commit/55a8fe9a938c61ef6e6bce718c58647ebdb4c88d) preserves final `API Error:` text when a result has subtype `success` and terminal reason `api_error`, including an unflagged result. Its tests also cover ordinary reply text, diagnostics, 429 and 529.
- [T3 terminal-result classification at the audited revision](https://github.com/pingdotgg/t3code/blob/7a4f5b6188fed54ddc866723e39446a198b5835c/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts) distinguishes terminal failures from completion and explicit aborts. Tau retains its own usage-limit and context-exhaustion reporting.
- Installed `@anthropic-ai/claude-agent-sdk` 0.3.263, `sdk.d.ts`, declarations `SDKResultMessage`, `SDKResultSuccess`, `SDKResultError` and `TerminalReason`. The [versioned package archive](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.263.tgz) is pinned in `package-lock.json` with integrity `sha512-0QWoHgWWlSmgXfEqZRbVYRoXT9p4tx/yKaZ4eLJ8l1MR65SIvMGR+cd5ZXUpGYZpj9RzbYiYU9LoFg90mdIjmw==`. Both result variants expose `terminal_reason`; only the success variant declares `result` and `api_error_status`. The implementation uses these installed types directly.

## Changes

`result-error.ts` owns result success classification, interruption detection and error text. `sdk-events.ts`, `runtime-adapter.ts` and `auth-failure.ts` now use it. A terminal API failure cannot produce successful assistant text, bypass a failure as a zero-turn resume handshake, or escape authentication handling because `is_error` is false. Other terminal failures declared by the installed SDK also fail. Explicit aborts remain interruptions; normal hook, deferred-tool and background handoffs keep their existing behavior.

Final `API Error:` details are trimmed and retained. Ordinary assistant text in an API-error result falls back to a provider-failure message. Listed errors take precedence, with internal `[ede_diagnostic]` entries excluded. Diagnostic-only legacy errors still mean interruption when no terminal reason is supplied; an explicit API failure takes precedence over those diagnostics.

HTTP error statuses also prevent success. HTTP 429 uses Tau's existing limit outcome, keeping a rejected window's reset when available. HTTP 529 stays a provider failure. `blocking_limit` without a rejected window and `prompt_too_long` retain the context-full hint. A terminal 401, including an explicit API-error login message without a numeric status, reaches the existing reauthentication shutdown path. HTTP 403 and permission denials retain their diagnostic text and leave the session available. Successful replies and tool output discussing login remain outside authentication detection.

The backend and session lifecycle need no production changes. Their existing result routing, turn settlement, accounting and queued-send shutdown now receive the corrected classification.

## Regression coverage and validation

- `sdk-events.test.ts`: flagged and unflagged final API errors; prior assistant text; zero-turn failures; ordinary-result fallback; SDK terminal failure reasons; normal control reasons; explicit aborts; diagnostic-only and mixed error lists; context exhaustion; rejected-window reset preservation; HTTP 429 and 529.
- `runtime-adapter.test.ts`: unflagged API failures with zero or nonzero turns; short-completion failure rather than returning earlier text; reauthentication hints; explicit interruption.
- `sdk-session.test.ts`: flagged and unflagged terminal 401s; queued sends rejected after a status-less login failure; a terminal 403 translated as failure while the session remains reusable. Existing coverage retains ordinary login discussion and tool-error exclusions.
- `thread-backend.test.ts`: the real SDK-session route rejects the prompt, publishes exactly one error settlement and records the failed attempt, then recovers on the same session.

No tests, typechecks, builds or installs were run, as requested. `git diff --check` passes for the owned changes. The parent should run the combined checks once:

```sh
npm test -- kits/claude-code/sdk-events.test.ts kits/claude-code/runtime-adapter.test.ts kits/claude-code/sdk-session.test.ts kits/claude-code/thread-backend.test.ts
npm run typecheck:kits
```

## Deferred

[T3 #25372, commit 572cf74275bc0fc4dcdaee754db64fb3d5b575c1](https://github.com/pingdotgg/t3code/commit/572cf74275bc0fc4dcdaee754db64fb3d5b575c1) retries stalled MCP registration on resumed sessions. It changes query replacement and queue teardown, with dedicated lifecycle tests. Tau currently bounds registration, reports unavailable server names and lets the prompt continue. A retry must terminate the old query and queue before resending, preserve control-channel credentials and account for live native/background work. This is deferred because it is not a small addition to terminal-result classification.
