# Host protocol (v1)

The typed host boundary uses `version: 1` focused updates. A client may ignore a
message with an unknown version or type and continue using its last coherent
state; it must not reinterpret it as a `HostSnapshot`.

- `thread-index` and `thread-shell` contain navigation records only.
- `thread-detail` contains the active session's messages, run state, tools and
  usage. Extension state beside a thread (Workspace Kit's turn checkpoints, say)
  travels through the extension's own commands and events, never in the detail;
  a text-empty assistant message stays in the detail only when an extension
  pinned its entry.
- `transcript-page` contains a bounded page plus a cursor for older records and
  an optional `historyCompleteness` value.
- `catalog` contains models, thinking levels, tools, and extension count.
  Legacy v1 catalogs may omit `sessionId` and the image-input capability. The
  decoder accepts both omissions; omitted capability is treated as `false`,
  while a catalog without a session id cannot change the active thread's
  capability.
- `project` contains workspace identity and an optional label an extension
  supplies (Workspace Kit: the Git branch).
- `run` contains lifecycle state for the active session.

Within the typed host/page contracts, `olderCursor` is an opaque
`HostTranscriptCursor`. The renderer and shared desktop contracts retain and
return that value but never inspect its representation or infer a numeric
position from it. The host adapter owns conversion between its local record
coordinates and a Pi bridge's raw coordinates. A host supplies
`cursorBeforeMessageId` (and, when needed, `cursorBoundaries`) so a renderer
cache can select the cursor at the oldest retained user-turn boundary without
interpreting the cursor. Other host adapters may use a different opaque
encoding while preserving the same contract.

An adapter-paged snapshot or page may mark `transcriptWindow: "bounded"`. This
marker means the records already follow the adapter's complete-turn page policy;
the host and renderer must preserve the opaque cursor instead of applying a
second local paging pass.

The Pi socket continues to encode its bridge cursor as a raw opaque string. The
desktop host wraps it at the adapter seam before it enters page state and only
unwraps it when sending a request back to that same bridge. Legacy v1 payloads
that contain the old cursor object are accepted only at the host migration seam;
they are normalized to the opaque host contract or discarded conservatively by
the renderer cache. The renderer never exposes the adapter coordinate or a
`coordinateSpace` field.

The legacy `HostSnapshot` remains a recovery shape for pre-v1 clients only. New
bootstrap responses provide `version`, detail, catalog, project metadata, and the
thread index separately; normal metadata actions return focused updates.

## Pi bridge paging negotiation

The Pi socket keeps wire version `1` for compatibility. A newer Tau host may add
`capabilities: { transcriptPaging: true }` to its `hello` frame. A bridge that
understands paging echoes that capability in the `ready`/`snapshot` payload and
returns a bounded bootstrap window with `messagesOffset`, bounded activity
history, and the `transcript_page` command.

If `hello.capabilities` is absent or does not enable `transcriptPaging`, the
bridge serves the legacy v1 snapshot shape and window, omits paging metadata,
and rejects `transcript_page`. This is the compatibility path for an older host;
the host only sends paging commands after the capability has been echoed. A new
host marks metadata-free legacy windows as `unknown`, so the workbench never
presents that bounded view as the beginning of history and reports that older
history availability cannot be determined. Unknown commands are rejected
explicitly so a client cannot mistake an unsupported extension for an empty page.

## Host extension channel

Host features that are not core do not get an IPC entry each. A host extension registers commands under its id, and the renderer reaches them through one call, `invokeHostExtension(extensionId, command, input)`. Input is untrusted at the host: every command re-reads its fields. A host extension publishes to its desktop counterpart with the `extension-event` global event, `{ extensionId, name, payload }`; core routes it by id and otherwise ignores it. Which commands exist is the extension package's own contract (for Workspace Kit, `src/shared/workspace-kit-protocol.ts`), never part of this protocol.

## Renderer host client

The renderer never calls the desktop API directly. `src/renderer/host-client.ts`
declares `HostClient`, a transport-neutral interface grouped by concern
(threads, turns, transcript, catalog, extensions, workbench, platform).
`createElectronHostClient(api)` adapts the Electron preload bridge
(`TauDesktopApi`) to it with no logic beyond delegation; Electron IPC is one
implementation of `HostClient`, not the renderer's only way to reach a host. A
later transport (a WebSocket client talking to a remote host) is another
implementation of the same interface, with no renderer changes beyond
`main.tsx`.

`main.tsx` is the only place a renderer module reads `window.tau`. It builds
the client (or leaves it `undefined` in the browser-preview build, where
`window.tau` does not exist) and mounts `<HostClientProvider client={...}>`
around `App`. Components read it with `useHostClient()`; a handful of
module-scope singletons that exist outside the component tree (Workspace
Kit's store and its host-extension client) read the same instance through
`getHostClient()`, which `main.tsx` and the test-only `renderApp` helper keep
in sync with the provider. `src/renderer/host-client-boundary.test.ts` fails
on any other renderer module touching `window.tau`.

## Persisted host state

Every JSON file the host owns on disk goes through `src/main/persisted-json.ts`
(`readPersistedJson` / `writePersistedJson`), not ad hoc `fs` calls. The rules
are the same everywhere:

- A write is `JSON.stringify({ version, ...data }, null, 2)` to a sibling temp
  file (`<name>.<uuid>.tmp`, flag `wx`, mode `0o600`), then a rename; the
  parent directory is created `0o700`. Concurrent writes to the same path are
  queued so the file on disk always ends up as the last call's value.
- A read that hits invalid JSON quarantines the file to
  `<name>.corrupt-<ISO timestamp>` and logs a warning instead of silently
  discarding it; a missing file is not an error.
- `decode(value, version)` accepts legacy shapes (no `version` field, or a
  bare array) so old files keep loading.
- A stored `version` newer than the build's `expectedVersion` is decoded
  best-effort and flagged `readOnly: true`; a mere load never writes the file
  back, so an older build never downgrades a newer one's data.

Current stores:

| File | Owner | Version |
| --- | --- | --- |
| `<userData>/projects.json` | `src/main/project-history.ts` | 1 |
| `<agentDir>/tau/claude-runtime-sessions.json` | `src/main/extensions/claude-code/session-store.ts` | 1 |
