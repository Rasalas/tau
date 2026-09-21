# ADR 0019: WorkbenchSession owns client state coordination

Accepted, 2026-09-14. WorkbenchSession owns the platform-neutral client state
construction graph and the ordering of host updates, delivery promotion and
navigation. App supplies renderer adapters and subscribes to the existing
stores. This follows ADR 0016 while retaining targeted subscriptions and named
operations instead of migrating to a new dispatch/select API.

The session constructs view, thread, history, composer-scope, pending-draft,
host-confirmation, turn and delivery state. SubmissionController consumes its
host and delivery ports. Connection effects, extension activation, layout,
Stage state and prompt preparation remain renderer responsibilities; no
workbench module imports renderer code. App constructs the session with ready
notification and project-change adapters, without callbacks to later-created
host coordinators.

WorkbenchStore is private to the session. It reduces a detail and returns a
delivery observation. The session immediately processes that observation before
the next host update. The delivery coordinator returns a promotion plan; the
session applies any synthetic detail without generating another observation,
then finishes the promotion. This removes the former delivery/store callback
cycle while preserving detail-before-notification and host update ordering.
A rejected recovery is distinct from an absent recovery, so stale reports cannot
fall through and promote another pending draft. Notifications are claimed
before invoking extensions, and asynchronous failures become session notices.

The session reads drafts synchronously from ComposerScopeStore when applying
navigation results. NewThreadController owns pending draft identity and its
promotion guards; TurnScopeController owns expected-turn checks and continuity
across draft promotion. HostSessionState preserves the existing monotonic host
confirmation lifetime, including reconnects. The session does not introduce
per-thread confirmation or change checkpoint ownership in Workspace Kit.

Direct session tests cover cache coldness, correlated and synthetic details,
batch ordering, stale recovery, cross-draft guards and notification failures.
Existing submission, navigation and App render-isolation tests verify the
renderer integration. The implemented boundary and validation are recorded in
`.scratch/architecture-completion/01-workbench-session.md`.

## Amendment, 2026-09-21: client state that outlives the window

Stage and dock state stay renderer responsibilities, and they are now
persisted per workspace identity rather than rebuilt empty on every start.
`src/workbench/workbench-layout-state.ts` owns the format, the validation and
the pruning rules; `src/renderer/use-workbench-layout-state.ts` owns when a
workspace is restored and when a deferred write happens. The session is not
involved: it still only tells the renderer that the project changed, and the
renderer decides that this means "start the stage over and restore the new
workspace's". A write happens only for the workspace that was last restored,
so opening a second project cannot overwrite the first one's layout.

The stored stage is deliberately generic — a tab is written as it is held and
read back when it carries `id`, `kind` and `preview` — so a tab kind a kit
contributes survives a restart without this module learning about it.
