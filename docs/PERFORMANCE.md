# Performance architecture

An extension boundary does not require a performance penalty. Tau core must provide efficient state and lifecycle primitives, while extensions subscribe only to the state they render. Moving the sidebar into Workspace Kit changes ownership, not the amount of work required to switch threads.

## Baseline

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

Warm runtime creation spent roughly 2–5 ms creating a fresh isolated model runtime, 11–21 ms rebuilding cwd-bound resources, 0–3 ms creating the session, under 1 ms binding extensions, and under 4 ms resolving the UI model catalog. Measurements vary with filesystem caches; they are development-machine observations rather than release benchmarks.

The current renderer and host still have avoidable work:

- `App.tsx` owns active transcript arrays, although streaming commits are now frame-batched.
- Correct session replacement still rebuilds cwd-bound resources; resource discovery is now the dominant measured switch phase.
- Transcript messages are cached as complete snapshots rather than normalized entities.
- Branch and session metadata refresh after completed prompts rather than through filesystem/session change notifications.

## Patterns adapted from T3 Code

The local T3 Code source uses several patterns worth carrying into Tau:

### Shell and detail are separate

Thread shells contain the small, frequently visible index used by navigation. Thread details and messages are loaded through separate state. A sidebar does not subscribe to a full conversation.

Relevant T3 Code modules:

- `packages/client-runtime/src/state/threadShell.ts`
- `packages/client-runtime/src/state/threadDetail.ts`
- `apps/web/src/state/entities.ts`

### Entities have stable identities

T3 Code builds indexes and atom families for individual threads. Derived arrays reuse their previous references when their elements have not changed. One thread update does not need to invalidate every row.

### Rows are memoized

Sidebar draft rows, thread rows, and search rows are memoized. Expensive derived maps and sorted collections are computed with stable dependencies.

### Cached data remains renderable

Stale-while-revalidate state lets the client display cached data while refreshing it. A route can render from an existing thread shell while detail loading continues.

### Large inactive tails are bounded

Settled threads have an explicit visible tail and a show-more mechanism. Animation is applied at the list boundary rather than through per-frame application state.

## Tau target model

### Thread index

Core should own a normalized thread-shell store keyed by session ID. Each shell contains only navigation data:

- project identity
- title
- branch
- modified time
- activity and unread state
- settled state

Workspace Kit should subscribe to the ordered ID list and the individual shells it renders. It should not receive transcript messages, tool output bodies, file trees, or Git diffs through the same subscription.

### Active thread detail

The active transcript belongs in a separate store keyed by session ID. Recently visited transcripts should remain in a small LRU cache. Selecting a cached thread should update the route and transcript immediately while the host confirms or refreshes the session.

### Streaming

Host deltas may arrive faster than the display refresh rate. The renderer should buffer text and thinking deltas and flush them at most once per animation frame. A delta should update only the active message rather than map and recreate the complete message array.

### Host snapshots

The host should separate these messages:

- thread index snapshot and incremental shell updates
- active thread detail snapshot
- streaming run events
- model and extension catalog updates
- project and Git metadata updates

Switching threads should not relist every session or model. Branch lookups, model availability, and session indexes need independent caches and invalidation rules.

### Extension interface

Desktop extensions should consume selector-based stores and capability-specific events. Core remains responsible for batching, cache coherence, backpressure, cancellation, and protocol versioning. Extensions remain responsible for local derivation and rendering.

An extension that requests an entire workbench snapshot for every token is using the wrong interface. The fix belongs at the seam rather than by moving the feature back into core.

## Interaction budgets

Initial local targets:

- selected thread feedback within one 16 ms frame
- cached transcript visible within 50 ms
- local host switch confirmed within 150 ms at p95
- no more than one transcript commit per animation frame while streaming
- unchanged sidebar rows do not rerender when another row changes
- sidebar search remains responsive with 10,000 thread shells
- opening a cached project picker does not perform filesystem or Git work

Each target needs instrumentation before it becomes a release gate.

## Implemented baseline

- memoized Workspace Kit, thread rows, and transcript messages
- core normalized thread-shell store with stable per-thread references
- dedicated thread-store subscription separate from panel and transcript context
- streaming text and thinking flushed at most once per animation frame
- separate host bootstrap/detail and thread-index payloads
- renderer transcript snapshot cache with immediate optimistic selection
- per-project model catalog cache
- fresh `ModelRuntime` instances per Pi runtime so extension provider state cannot leak across replacements
- `AgentSessionRuntime` ownership of replacement, shutdown, extension rebinding, and failure recovery
- serialized lifecycle mutations with stale-runtime guards and cleanup on abort, bind, or recovery failure
- phase timings for settings, model runtime, resources, session creation, extension binding, model catalog, and total replacement
- recent-project writes debounced off the switch path and flushed on shutdown
- global session index parsed once at bootstrap and refreshed after completed prompts
- virtualized active thread rows above 80 items with six-row overscan
- switch timing events and repeatable host smoke measurements

## Next sequence

1. Normalize active messages so a delta mutates one message record rather than mapping the array.
2. Prefetch likely next sessions on hover or keyboard selection.
3. Investigate fingerprinted resource reuse without weakening cwd or extension isolation.
4. Replace prompt-completion index refreshes with session-file and Git invalidation events.
5. Add React render-count tests and host timing tests to CI.

Performance work should preserve the extension ownership recorded in ADR 0002. The intended result is a fast extension system, not a fast monolith.
