# Performance architecture

Tau's extension boundary does not require a performance penalty. Core must provide bounded state, lifecycle, and transport primitives. Extensions should subscribe only to the state they render. Moving the sidebar into Workspace Kit changes ownership, not the amount of work required to switch threads.

This document records measured baselines, known bottlenecks, target architecture, and release budgets. It covers Tau-owned renderer and Electron host code. Pi SDK internals and third-party extensions remain black boxes unless a trace names them.

## Measurement rules

Treat measurements as one of these two classes:

- **Observed:** reproduced in a runtime profile or build comparison.
- **Static risk:** visible in code, but its user impact still needs a benchmark or trace.

Development-machine timings are useful for finding dominant phases. They are not release benchmarks. Every performance change should use the same fixture before and after the change, report median and p95 where possible, and preserve correctness under concurrent lifecycle requests.

## Baselines

### Safe-mode lifecycle work

The first local safe-mode smoke run measured 514 ms for bootstrap and 109 ms for a cross-project switch across three indexed threads.

After splitting the thread index and adding host caches, a validation run measured:

- host bootstrap: 777 ms
- first switch to another project: 102 ms
- switch back to a catalog-cached project: 36 ms
- `SessionManager.listAll()` calls across bootstrap and both switches: 1

After moving replacement onto `AgentSessionRuntime`, serializing lifecycle mutations, and moving recent-project persistence off the critical path, a safe-mode validation run measured:

- host bootstrap: 354 ms
- first switch to another project: 56 ms
- warm return switch: 17 ms
- two concurrently requested switches, serialized safely: 55 ms total
- `SessionManager.listAll()` calls across bootstrap and all switches: 1

Warm runtime creation spent roughly 2 to 5 ms creating a fresh isolated model runtime, 11 to 21 ms rebuilding cwd-bound resources, 0 to 3 ms creating the session, under 1 ms binding extensions, and under 4 ms resolving the UI model catalog.

### Full-mode lifecycle profile

A real Electron profile with the configured extension set measured:

- runtime startup total: about 1.31 s
- startup resource discovery: about 1.23 s
- first full-mode thread switch: about 670 ms
- later full-mode switches: about 342 to 593 ms
- warm safe-mode switches in the same environment: about 21 to 86 ms

Resource discovery dominated full-mode startup and switching. This is the strongest host-side bottleneck found in the audit.

### Renderer stress profile

A temporary CDP fixture exercised the production renderer with synthetic transcripts and streaming updates:

- short histories with 10, 60, and 180 turns produced no tasks above 50 ms
- a growing 138 KB fenced-code response produced a median frame interval of 85.7 ms, p95 of 114.2 ms, and a maximum of 142.8 ms
- a growing 154 KB plain-text response produced a median frame interval of 53.3 ms and p95 of 78.2 ms
- cumulative tool output reaching about 811 KB produced a median frame interval of 16.6 ms and p95 of 36.7 ms
- typing stayed usable in the fixture, although each keystroke still rerendered the workbench root

Long active responses are the strongest renderer-side bottleneck. Short ordinary histories alone did not reproduce the same stalls.

### Build profile

The current production renderer build produced:

- JavaScript: 1,264.44 kB, 247.70 kB gzip
- CSS: about 62 kB
- source map: 2,449.21 kB
- build time: about 1.68 s

An esbuild-minified comparison reduced JavaScript to about 522 kB and CSS to about 52 kB. The renderer still shipped as one large eager chunk.

## Observed bottlenecks

### Growing Markdown is reprocessed in full

Assistant deltas are frame-batched, which prevents one React commit per token. Each commit still replaces the complete active message string. `ReactMarkdown` reparses the complete message, and Highlight.js re-highlights every fenced code block.

Cost grows with the response. The 138 KB code-stream fixture missed every 16 ms frame budget by a wide margin.

The streaming path should render a cheap mutable tail while a response is active. Settled blocks can be parsed once, cached by content and language, then moved into the normal Markdown tree.

### Transcript scrolling restarts on every update

Every message or tool update reads transcript `scrollHeight` and starts a new smooth scroll. This combines a layout read with a repeatedly restarted animation.

Scroll work should run only while the viewport is pinned to the tail. Streaming should use an immediate or coalesced tail adjustment. Smooth scrolling belongs to discrete navigation, not token delivery.

### Renderer invalidation is too broad

`App.tsx` owns composer input, messages, tools, timers, panels, notices, queue state, and workspace state. Composer input and the one-second elapsed timer rerender the workbench root. Registry accessors return freshly sorted arrays. The root keydown effect is also reinstalled on each render.

The workbench context carries unrelated transcript, tool, event, file-tree, and Git state. Inactive panels stay mounted and receive those updates even though CSS hides them.

Split state by update frequency and ownership. Composer input, elapsed labels, active message records, tool runs, panel data, and shell navigation need separate subscriptions. Hidden heavy panels should mount on demand.

### Transcript and tool state are unbounded

The renderer mounts every transcript message. Completed tool outputs remain in host and renderer memory. The renderer snapshot cache keeps complete snapshots for every visited session without an eviction policy.

Bound each layer independently:

- page old transcript turns
- virtualize the visible timeline
- collapse and truncate settled tool output
- retain only a small LRU of thread details
- keep shell metadata outside detail snapshots

### Tool output crosses IPC without backpressure

Each tool output update crosses Electron IPC immediately. The renderer maps the complete tool array and replaces the output string for each update. Large cumulative output missed the frame budget even without Markdown highlighting.

The host should coalesce output per tool. The renderer should apply at most one update per animation frame, retain a bounded tail for display, and provide explicit access to the complete artifact when one exists.

### Resource discovery dominates runtime replacement

Correct session replacement currently rebuilds cwd-bound resources. In full mode, that phase costs hundreds of milliseconds and can exceed one second at startup.

Reuse requires a fingerprint that includes cwd, extension configuration, relevant settings, and provider state. A cache hit must not allow mutable extension state to leak between runtimes. Prefetching is useful only after the cache boundary is correct.

### Bootstrap waits for unrelated global work

The host starts only after the renderer requests bootstrap. Initial detail waits for runtime creation, model discovery, the global session index, and branch resolution. The UI cannot show a cached shell and transcript while global metadata refreshes.

Start host preparation before the renderer asks for it. Return a cached shell and active detail first. Refresh catalogs, branches, and the global index independently.

### Git and process work is duplicated

Startup can launch editor discovery, changes, workspace-info, and branch subprocesses together. A single changes refresh starts multiple Git commands. Changes refresh after startup, edits, writes, run completion, review entry, and some panel transitions. Calls have no single-flight guard, cancellation, or stale-result protection.

Thread-index branch enrichment can fan out across up to 80 unique project paths. Untracked-file line counts read each file in full and do so serially.

Git state needs one project-scoped service with cached status, deduplicated in-flight work, bounded concurrency, invalidation, cancellation, and versioned results.

### Prompt completion rebuilds the global session index

After each completed prompt, Tau runs `SessionManager.listAll()`, rebuilds and sorts every thread shell, resolves branches, and publishes the complete index.

Session-file and Git invalidation events should update only changed shells. A full scan remains a recovery path, not the normal prompt-completion path.

### Metadata actions return full host snapshots

Model changes, thinking-level changes, compaction, title generation, and several workspace actions return a complete `HostSnapshot`. The payload includes messages, models, tool descriptions, and usage even when only one field changed.

Split the protocol into thread shell updates, active detail, run events, model and extension catalogs, and project metadata. IPC cost for a metadata action should stay constant as transcript length grows.

### Large diffs render in full

Tau accepts a multi-megabyte patch, parses every line into objects, and mounts every line in the DOM. A large generated file can freeze review mode.

Diff loading needs file and hunk limits, a truncated state, incremental loading, and row virtualization. The UI must keep navigation and approval controls responsive while a large file loads.

### Sidebar work is only partly bounded

Active flat lists virtualize above 80 rows. Grouped lists and the settled shelf do not. Search, sorting, grouping, and project derivation still run over the complete index when the store changes. Consumers subscribe to the whole thread store instead of individual shell records.

The sidebar should subscribe to an ordered ID list plus stable shell records. Grouped and settled views need the same bounded rendering policy as the flat list.

## Static risks awaiting focused measurement

These code paths are plausible costs, but the audit did not isolate their runtime impact:

- file-tree recursion and repeated workspace-info scans lack cache invalidation
- Git commands lack timeouts and cancellation for locks, hooks, credentials, and slow filesystems
- branch caches can remain stale after Git commands run through tools
- model and command pickers use repeated index lookups during render and do not virtualize long lists
- branch, changed-file, and model lists mount every row
- full-screen backdrop blurs add GPU composition work
- external Google Font imports add network-dependent first-paint work
- settings, review, Highlight.js, and other heavy panels load in the initial renderer chunk

Each item needs a fixture that can go red before implementation starts.

## Patterns adapted from T3 Code

The local T3 Code source provides concrete patterns for Tau.

### Shell and detail are separate

Thread shells contain the small index used by navigation. Thread details and messages load through separate state. A sidebar never subscribes to a full conversation.

Relevant modules:

- `packages/client-runtime/src/state/threadShell.ts`
- `packages/client-runtime/src/state/threadDetail.ts`
- `apps/web/src/state/entities.ts`

### Timeline work is bounded

T3 Code initially loads only the latest ten user turns, pages older history in batches, and renders the timeline through `@legendapp/list`. Stable row identities keep an active update from invalidating settled rows.

### Entities have stable identities

Atom families address individual threads. Derived arrays reuse their previous references when elements have not changed. One shell update does not invalidate every row.

### Settled work collapses aggressively

Completed work logs expose a small visible tail and explicit expansion. Settled threads also use a bounded shelf. Tau should use separate limits for active output, settled output, and archived transcript pages.

### Expensive rendering is cached or deferred

T3 Code caches syntax highlighting, applies content visibility to inactive rows, updates elapsed labels locally, and lazy-loads heavy panels. Cached data remains renderable while refresh work runs.

## Tau target model

### Thread index

Core owns a normalized thread-shell store keyed by session ID. Each shell contains only navigation data:

- project identity
- title
- branch
- modified time
- activity and unread state
- settled state

Workspace Kit subscribes to the ordered ID list and the individual shells it renders. It does not receive transcript messages, tool output bodies, file trees, or Git diffs through the same subscription.

### Active thread detail

The active transcript lives in a separate store keyed by session ID. Recently visited transcripts remain in a small LRU cache. Selecting a cached thread updates navigation and transcript immediately while the host confirms or refreshes the session.

History loads in pages. The DOM contains only a bounded viewport and overscan rather than every loaded message.

### Streaming

The host may emit deltas faster than the display refresh rate. The renderer buffers text, thinking, and tool-output deltas and flushes each record at most once per animation frame. A delta updates one active record rather than mapping the complete collection.

Active Markdown uses a cheap streaming representation. Settled content moves into cached parsed blocks.

### Host protocol

Protocol version 1 rejects malformed or unknown update types at the preload boundary. Normal runtime traffic uses the final granular contract; legacy full-snapshot messages are not part of the active IPC surface. The host separates these messages:

- thread index snapshot and incremental shell updates
- active thread detail snapshot and history pages
- streaming run events
- model and extension catalog updates
- project and Git metadata updates

Switching threads does not relist every session or model. Branch lookups, model availability, session indexes, and Git state have independent caches and invalidation rules.

### Extension interface

Desktop extensions consume selector-based stores and capability-specific events. Core remains responsible for batching, cache coherence, backpressure, cancellation, and protocol versioning. Extensions remain responsible for local derivation and rendering.

An extension that requests an entire workbench snapshot for every token is using the wrong interface. Fix the seam rather than moving the feature back into core. This preserves the ownership boundaries in ADR 0002 and ADR 0003.

## Interaction budgets

Initial local targets:

- selected-thread feedback within one 16 ms frame
- cached transcript visible within 50 ms
- local host switch confirmed within 150 ms at p95
- one transcript commit per animation frame while streaming
- 150 KB plain-text and fenced-code streams below 24 ms frame p95 after initial block parsing
- no task above 50 ms during steady-state streaming
- one tool-output commit per animation frame, with 1 MB cumulative output below 24 ms frame p95
- unchanged sidebar rows do not rerender when another row changes
- sidebar search remains responsive with 10,000 thread shells
- transcript DOM size remains bounded with 1,000 loaded turns
- metadata IPC payload size remains constant as transcript length grows
- opening cached project navigation performs no filesystem or Git work
- full-mode local thread switches stay below 150 ms at p95 after cache warm-up

Record the fixture, machine class, build mode, median, p95, and maximum with each result. Promote a budget to a release gate only after the fixture is repeatable in CI.

## Implemented baseline

- memoized Workspace Kit, thread rows, and transcript messages
- core normalized thread-shell store with stable per-thread references
- dedicated thread-store subscription separate from panel and transcript context
- streaming text and thinking flushed at most once per animation frame
- separate host bootstrap/detail and thread-index payloads
- renderer transcript snapshot cache plus a bounded persisted bootstrap cache for immediate first content
- variable-height transcript virtualization with a 1,000-turn fixture
- per-project model catalog cache
- fresh `ModelRuntime` instances per Pi runtime so extension provider state cannot leak across replacements
- `AgentSessionRuntime` ownership of replacement, shutdown, extension rebinding, and failure recovery
- serialized lifecycle mutations with stale-runtime guards and cleanup on abort, bind, or recovery failure
- phase timings for settings, model runtime, resources, session creation, extension binding, model catalog, and total replacement
- recent-project writes debounced off the switch path and flushed on shutdown
- bounded, isolated Full Mode runtime prewarming; extension startup and teardown stay extension-owned but run outside the interactive switch path
- fingerprinted reuse of immutable skills, prompts, themes, and context files without reusing extension or provider runtimes
- global session index parsed once at bootstrap, updated per active shell after prompts, and reconciled by a background recovery scan that publishes focused shell updates
- virtualized active, grouped, settled, file, change, model, command, and project rows with bounded overscan
- switch timing events and repeatable host smoke measurements
- production builds use esbuild minification, opt-in source maps, and a durable `reports/build-report.json`
- Review, Settings, optional panels, and project navigation are demand-loaded; Highlight.js language definitions are separate chunks
- first paint uses local system font stacks and opaque overlay scrims (no network font CSS or backdrop blur)
- startup fixture records paint entries, loaded resources, external requests, and overlay style measurements in `reports/start-report.json`
- project-scoped Git coordinator deduplicates status/branch/worktree reads, bounds subprocess concurrency, supports cancellation, and keeps the last valid state on timeout
- file diffs stream only the requested hunk window from Git, discard skipped hunks, and stop the subprocess at page, byte, or line ceilings
- pull requests run the type, test, build, host, renderer, and startup budgets in `.github/workflows/performance.yml`

### Build and startup budget evidence

The local budget fixture runs with `npm run build:budget` and `npm run start:budget`; these commands are intentionally separate from the ordinary `npm run build` and `npm run start` commands so CI can opt in to gating. A production run on the development machine reported:

- initial JavaScript: 469.44 kB (146.19 kB gzip), one entry chunk
- initial CSS: 54.19 kB (9.54 kB gzip)
- lazy JavaScript: 92.59 kB (36.31 kB gzip) across 22 chunks
- source maps: 0 bytes (disabled by default; `TAU_SOURCEMAP=true` is an explicit debugging opt-in)
- build time: 4.05 s
- local fixture first paint: 104 ms, two file resources, zero external requests
- overlay fallback: opaque scrims, zero measured blur composition work in the fixture

The report schema includes each asset's uncompressed and gzip size and classifies entry versus lazy chunks from `dist/index.html`. The Electron start fixture uses Chromium paint and resource timing APIs; it also reports a missing paint as a failed budget rather than silently treating it as zero.

### Renderer and host budget evidence

`npm run benchmark:renderer:check` runs a hidden production Electron renderer with warm-up and five samples per scenario. The transcript fixture mounts the full `TranscriptViewport`, including an explicit anchor at turn 8 and 128 anchored activity records; it therefore covers the same virtualized active-turn path used in the workbench rather than only `VirtualTranscript`. The current development-machine report (`reports/renderer-report.json`) records median, p95, and maximum frame, long-task, commit, and heap distributions for 150 KB highlighted and plain Markdown streams, 1 MB tool output, the 1,000-turn anchored transcript, a large diff, and 10,000-item thread, workspace, and picker fixtures. Streaming and interactive commit p95 stays below 24 ms; the one-time 1,000-turn mount has an explicit 40 ms budget. The Long Task observer was available and observed no long task, and the largest DOM count was 1,718 nodes.

`npm run benchmark:host:check` and `npm run benchmark:host:full:check` use the same persisted-session fixture in Safe and Full Mode. Branch resolution no longer blocks first content: against the same local fixture, Full Mode bootstrap fell from 2,350.7 ms to 1,601.7 ms, while the current Safe Mode bootstrap is 87.3 ms. CI rejects a critical-path branch phase and requires its duration to remain visible as background work. Full Mode cold switching now prepares a fresh isolated runtime before activation and defers retirement until after the focused response; the complete-run measurement fell from 2,175.8 ms to 1,630.4 ms without skipping Extension startup or shutdown hooks. The current report records Safe Mode warm-switch p95 at 85.9 ms and Full Mode warm-switch p95 at 19.7 ms. Full Mode prewarming took 430–1,173 ms and deferred extension retirement took 190–902 ms during the complete release run. Those extension-owned costs remain reported rather than being skipped or moved back into the interactive switch path. A focused `PI_TIMING=1` run attributed 1,404 ms of cold startup to configured Extension module imports and factories. A three-process Node compile-cache experiment measured resource phases of 1,494 ms, 1,530 ms, and 1,501 ms, so Tau does not enable that cache: it produced no repeatable improvement. Parallel imports were rejected because changing top-level Extension execution order would violate Extension ownership and can change behavior.

`npm run benchmark:git:check` measures a 1,202-file worktree, overlapping refreshes, timeout cancellation, and 20-project branch fan-out. The current report reduced the measured uncoordinated 18 subprocesses to 6, read no oversized untracked content, capped concurrency at 4, cancelled the slow command in 21.7 ms, and kept many-project branch p95 at 64.4 ms.

Run the complete release fixture with `npm run performance:ci`. Generated JSON reports are uploaded by CI for comparison with failures.

## Execution order

1. Add repeatable renderer, IPC, Git, and lifecycle fixtures for the observed failures.
2. Isolate streaming records and render an active Markdown tail without reparsing settled content.
3. Bound transcript, tool-output, diff, and sidebar rendering.
4. Split root state, workbench context, and host snapshots by update frequency.
5. Cache fingerprinted runtime resources and move global refresh work off the switch path.
6. Consolidate Git work behind deduplication, bounded concurrency, invalidation, and cancellation.
7. Minify the production build, split heavy panels, and add bundle budgets.
8. Promote stable fixtures to CI gates.

Performance work must preserve extension ownership from ADR 0002 and thread ownership from ADR 0003. The target is a fast extension system, not a fast monolith.
