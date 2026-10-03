# Tau reconnect and Preview regressions

## Scope and decisions

Worktree HEAD at entry was `5106befa`, a descendant of the approved `08c103ed` assessment state. Changes are confined to `src/workbench/host-connection*`, `kits/preview`, and this report. No delegation, core changes, package changes, scheduling changes, or full builds.

The agreed seams were the public socket Client and Preview operations. During implementation the user additionally approved an explicit-destination download operation, rather than guessing whether a download belonged to automation or a human. The user also approved recording the unrelated broader typecheck failures rather than changing dependencies or core.

Read AGENTS.md, CONTEXT.md, ADRs 0009, 0010, 0012, 0019 and 0021, the isolated-app skill, testing-the-app.md, and the TDD skill with tests.md and mocking.md. The implementation follows Tau's WebContentsView and CDP architecture, not T3's webview architecture.

## Upstream scenarios and evidence limits

The assessment and task named these upstream regression candidates:

- https://github.com/pingdotgg/t3code/pull/15008
- https://github.com/pingdotgg/t3code/pull/14573
- https://github.com/pingdotgg/t3code/pull/14897

Used the requested reconnect, browser-focus and download scenarios, not upstream patches. Three `web_explore` passes failed to retrieve the exact PR descriptions. Results were unrelated repository docs and listings. Consequently this report does not claim an individually verified title, root cause, or download policy for any of those PRs. The Tau failures below come from local tests and real Electron execution.

## Red before green

| Slice | Observed failure before fix | Change |
| --- | --- | --- |
| Stale socket callbacks | A replaced socket delivered the event `stale`; its late close could retire the current socket. | Ignore open, message and close callbacks unless they belong to the current, non-closed transport. |
| Rejected queued prompt | After a failed reconnect handshake, a rejected `sendPrompt` was still emitted on the next socket. | Clear queued writes when their pending requests are rejected on connection loss. |
| Retry jitter | The new public link-state test expected a dispersed retry, but observed exactly 250 ms for every random sample. | Apply bounded jitter to the exponential ladder, retaining the 250 ms floor and 3 s online / 15 s offline caps. This is requested behavior coverage, not evidence of an observed fleet outage. |
| Hidden agent key | Real Electron left the field at `agent`, not `agentx`, after `pressKey("x")`. | Enable CDP focus emulation before agent DOM operations can focus a field; deliver keys through CDP and await delivery through the window, remote surface and agent tool. No native contents.focus call. |
| Concurrent Preview clicks | Two concurrent public input calls produced one browser click. | Serialize complete input operations so their pressed/released events cannot interleave. A rejected input does not poison the queue. |
| Explicit download | The new real-Electron test failed because the public operation did not exist. | Add the approved `preview_download` tool and host/window/surface operation. |

The existing test files were inspected and run before changes. The initial socket and view set passed 35 tests. Existing coverage already exercised suspended clocks, heartbeat loss, wake deadlines, offline/online recovery, replay, refused tokens, connect/hello deadlines and growing backoff. Kept those tests and added the missing behavior slices rather than replacing them with implementation tests.

A separate real loopback WebSocket test exercises the public Client. The fixture accepts a prompt, drops its acknowledgement, then replays an event after offline/online recovery. The host observes exactly one prompt. Socket-boundary tests also verify that an in-flight prompt is never automatically resent.

## Download behavior

`preview_download` takes an http(s) URL and an explicit new destination in the Preview window's workspace. Its parent directory must already exist. It returns the saved path or an error.

Each explicit download uses a separate, never-shown WebContentsView in the Preview profile's session. Its will-download handler checks the sender identity. It does not change another page's DownloadItem or destination. It saves to a temporary file, then publishes with an atomic hard link. Existing files, including files a human creates while the response is arriving, are not replaced. A cancelled or interrupted download fails; waiting is bounded at 20 seconds. The owned listener, sender and temporary directory are cleaned up.

Real fixture coverage verifies completed file bytes, existing-file refusal, concurrent human file creation, externally cancelled DownloadItems, invalid URL schemes, workspace escape refusal and a concurrent ordinary page download with a separately chosen destination. The ordinary page response is held open until the explicit download completes, so this is actual overlap, not two sequential downloads.

This is not a blanket interception policy for downloads from arbitrary page scripts or agent clicks. A regular `preview_click` on a download link still follows native page-download behavior and may open Save UI without another handler. The new tool tells agents to use the explicit operation instead. Automatic attribution and suppression of delayed script downloads remain unresolved; silently cancelling human downloads would be worse than documenting that gap.

## Commands and results

Dependencies were absent in this worktree. A gitignored `node_modules` link points at the existing local Tau checkout's dependencies. No dependency installation or package edits were made.

Final targeted run, 11 files and 157 passing tests:

```sh
TAU_TEST_SLOW_RENDERS=30 ./node_modules/.bin/vitest run \
  src/workbench/host-connection.test.ts \
  src/workbench/host-connection-socket.test.ts \
  src/workbench/host-connection-runtime.test.ts \
  kits/preview/view.test.ts kits/preview/host.test.ts \
  kits/preview/host-extras.test.ts kits/preview/remote-input.test.ts \
  kits/preview/page-script.test.ts kits/preview/panel.test.tsx \
  kits/preview/agent-cursor.test.tsx kits/preview/remote-view.test.tsx
```

Real Electron fixture, rerunnable without building the whole app:

```sh
mkdir -p .tau-dev/preview-automation
./node_modules/.bin/esbuild kits/preview/automation.electron.ts \
  --bundle --platform=node --external:electron \
  --outfile=.tau-dev/preview-automation/probe.cjs
env -u ELECTRON_RUN_AS_NODE TAU_NO_FOCUS=1 \
  ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  .tau-dev/preview-automation/probe.cjs
```

Observed runtime was macOS arm64, Electron 44.4.4, Chromium 152.0.7977.130 and Electron's Node 24.21.0. The terminal test runner used Node 22.23.1. The Electron version matches package.json's declared range. Electron printed a sandbox-extension warning but exited zero and passed all assertions.

The fixture uses its own `.tau-dev/preview-automation/userData`, an in-memory Preview session, local HTTP responses and temporary download files. It does not launch the user's Tau, read credentials, send model prompts, or use their session store. It runs as a macOS accessory application, shows inactive, and never calls app.focus. The final native window-focus assertions were false, and `lsappinfo front` was unchanged before and after the probe.

The probe verifies actual browser DOM changes for hidden click/type/key, two concurrent clicks, a failed element lookup, simultaneous CDP composer typing, shown background views and a hidden owning window. The workbench stand-in retains its composer focus and draft. Human typing is represented by trusted CDP input, not a physical keyboard or a genuine person's intervention. A complete Tau workbench was not built or launched.

Targeted oxlint exited zero. Its no-await-in-loop warnings include existing sequential reconnect tests and the new sequential backoff test. `git diff --check` passed.

Broader compiler gates did not pass:

```sh
./node_modules/.bin/tsc -p tooling/tsconfig.kits.json --noEmit
./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

Both report `JsonObject` missing from pi-ai in src/main/mcp-endpoint.ts and `getAllModels` missing in src/main/model-catalog.ts and src/main/opencode-catalog.ts. The kits gate also reports `ExtensionToolContext` missing in kits/computer-use/vision.test.ts. No compiler errors were reported in the edited Preview or host-connection files. Those unrelated gates were not repaired under this task's authority.

Local logs are under `.tau-dev/preview-automation/`: runtime.log, tests.log, lint.log, typecheck.log and workbench-typecheck.log. They are gitignored, not durable report attachments.

## Cleanup and residual gaps

The final Electron probe reported PID 72181, then quit. `ps -p 72181` returned no process; no Electron command referencing this probe directory remained. Every probe invocation was foreground and bounded, and its own main process exited. The loopback socket fixture terminates its owned clients and closes its server in finally. No Tau instance or background host was started.

Remaining limits:

- No physical sleep, real network interface transition, actual human keyboard intervention, native Save-dialog interaction, full Tau composer smoke, or Windows/Linux Electron run. Suspended-clock and offline transitions are simulated at the public transport boundary.
- The explicit operation does not solve implicit agent-link downloads, delayed page downloads, or attribution of mixed human/agent page activity.
- A remote Preview destination belongs to the window machine's accessible workspace. It is not an automatic transfer back to a remote host. A missing workspace or destination parent fails explicitly.
- Tool cancellation is not a new cross-process download-cancel protocol. DownloadItem cancellation is tested, and the operation has its own deadline.
- DevTools detach/re-attach and concurrent human editing of the same Preview field are not covered. The tests cover independent composer typing while automation works in Preview.
- The exact upstream PR contents and the broader TypeScript gates remain unverified or blocked as described above.
