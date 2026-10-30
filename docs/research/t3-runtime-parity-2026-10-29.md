# T3 runtime parity, 29 October 2026

Compared the current Tau worktree, based on `4df3128d4`, with official T3 Code through `7a4f5b6188fed54ddc866723e39446a198b5835c`. Read `AGENTS.md`, `CONTEXT.md`, ADRs 0005, 0013, 0020, 0033 and 0038, the previous audit, recent Tau runtime history, and upstream diffs. Changes stay inside `kits/codex`; no core or Agents Kit changes.

## Implemented

- Share Codex thread writer locks between account overlays, and keep `auth.lock` private alongside `auth.json`. Previously an overlay could create a separate lock directory for the same canonical rollout, while a canonical auth lock could become an unwanted shared entry. `home-layout.ts` now precreates and links `thread-writer-locks`, excludes `auth.lock` from shared entries, and refuses linked auth locks. Regression tests cover shared lock visibility, private auth locks and preservation of conflicting local writer locks. Source: [T3 #26286](https://github.com/pingdotgg/t3code/commit/c4606e564d562a3aab978952fb28dd97bcb1ed57).
- Ignore unchanged Codex quota windows repeated by a live process. Previously a token tick could overwrite a newer account probe, including a reset, with the process's cached primary/secondary windows. `codexSnapshotUpdate` publishes only changed windows; the backend keeps a merged main-bucket snapshot for reset calculations and clears it when opening a replacement process. Tests cover a newer account read followed by a stale primary plus a changed secondary, reset changes, null windows, plan changes, foreign buckets, and backend restart. Source: [T3 #26331](https://github.com/pingdotgg/t3code/commit/c3f5e363e59371d292f4a7e27008d2c5d1260725).
- Classify explicit `rateLimitExceeded` and retry exhaustion with HTTP 429 as usage limits. Tau already has the usage-limit settlement and resume path; these Codex errors now reach it. HTTP 500, unknown exhaustion status and internal errors remain ordinary failures. Source: [T3 #17501](https://github.com/pingdotgg/t3code/commit/58b48274ff7db9361ab904d90c76b968e9a9228f).

Changed files:

- `kits/codex/home-layout.ts`, `home-layout.test.ts`
- `kits/codex/limits.ts`, `limits.test.ts`
- `kits/codex/events.ts`, `events.test.ts`
- `kits/codex/thread-backend.ts`, `thread-backend.test.ts`
- `kits/codex/fixtures/stub-app-server.mjs`

## Already present

The earlier audit's Claude MCP-token control-channel change, Codex originator/tier handling, actual cache-lifetime compaction, per-agent stop and restored subagent identity are already implemented. Current Claude native-agent code preserves a child's model through synthetic error frames and maps resumed agent handles back to one row. The current Codex backend replaces dead processes and resumes its persisted thread.

Latest [T3 #20145](https://github.com/pingdotgg/t3code/commit/5eebf77b373b719ca4456985340707afa267310e) is already covered by Tau's `f569b7007`. `kits/claude-code/approvals.ts` puts the complete command first, ahead of the description; `approvals.test.ts` checks whitespace and commands longer than 600 characters. No duplicate approval change was needed.

## Validation for the integrating parent

No tests, typechecks, builds or installs were run, as requested. `git diff --check` passes for the owned code changes. Run the combined checks once after integration, including:

```sh
npm test -- kits/codex/home-layout.test.ts kits/codex/limits.test.ts kits/codex/events.test.ts kits/codex/thread-backend.test.ts kits/codex/account-continuity.test.ts kits/codex/host.test.ts
npm run typecheck:kits
```

The new backend test uses the existing subprocess stub and temporary homes. No user app data was opened or changed.

## Limits and deferred gaps

- Existing overlay-local writer-lock directories remain conflicts under Tau's existing preservation policy. This patch refuses them rather than deleting potentially live locks. T3 migrates local runtime lock directories when it finds no thread lock. Automatic legacy-overlay migration needs a separate decision because ADR 0005 promises not to overwrite conflicting overlay data. Linked legacy `auth.lock` entries are also refused rather than silently reused.
- Differential quota updates cannot prove freshness of the first snapshot after a process starts. They prevent subsequent unchanged replays from undoing a newer probe, matching the bounded upstream fix.
- [T3 #19136](https://github.com/pingdotgg/t3code/commit/55a8fe9a938c61ef6e6bce718c58647ebdb4c88d) handles final Claude frames whose `subtype` is `success` but `terminal_reason` is `api_error`. Tau's `sdk-events.ts`, `runtime-adapter.ts` and `auth-failure.ts` still primarily classify results through `subtype` and `is_error`. This is a concrete follow-up requiring consistent classification across all three paths and SDK-session regression coverage.
- [T3 #25372](https://github.com/pingdotgg/t3code/commit/572cf74275bc0fc4dcdaee754db64fb3d5b575c1) retries stalled resumed-Claude MCP registration. Tau's `sdk-session.ts` currently bounds registration, reports unavailable servers and allows the prompt to continue. A retry needs its own lifecycle tests so it cannot duplicate a turn or register credentials on the command line.

No cross-scope edit is required for the implemented fixes.
