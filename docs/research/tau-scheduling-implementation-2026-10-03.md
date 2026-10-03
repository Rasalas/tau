# Scheduling implementation, 2026-10-03

Implemented a host-only `tau.scheduling` kit under `kits/scheduling/`.
Public commands manage opt-in jobs and create ordinary threads. Usage and
recovery decisions are in [docs/scheduling.md](../scheduling.md).

The worktree started at `c6b1de70`, Tau's spawned-thread snapshot, directly
above the requested `08c103ed` base. No existing tracked files were edited.
The owner approved an untracked `node_modules` symlink to the main checkout
because this worktree initially had no dependencies. No dependencies were
installed or changed.

## Test evidence

The confirmed seam was the public host-command API through `activateHostKit`.
Tests use temporary disk state, fake time, and host session/turn-observer
boundary stubs. They do not call private scheduling methods or production APIs.

Command: `./node_modules/.bin/vitest run kits/scheduling/host.test.ts`.

| Slice | Observed red | Green after implementation |
| --- | --- | --- |
| Disabled configuration survives activation | Missing `host.js` | 1 passed |
| Validation and explicit CRUD | Empty prompt accepted | 2 passed |
| Opt-in one-off thread and overlap | Missing `set-enabled` command | 3 passed |
| Restart recovery | Missed job remained ready; interrupted start remained starting | 5 passed |
| Fast completion and overdue enablement | Completion lost; overdue job remained ready | 8 passed |
| Exclusive scheduler ownership | Second scheduler activated | 9 passed |
| Host-pinned workspace | Copied job ran on another host | 10 passed |
| Malformed storage | Invalid job state activated | 11 passed |
| Failed intent write | Kit remained active after failed write | 14 passed |
| File budget | Oversized configurations accepted | 17 passed |

Supplemental regressions cover owner/read-only dispatch, timer shutdown, manual
held one-off recovery, failed turn outcomes, and a previous thread the user
continued. These passed when added; they were not separate red/green slices.
Final targeted result: 17 tests passed. Initial test startup was blocked by
missing dependencies before the approved symlink was created.

## Other checks and registration

The targeted TypeScript check, `tsc -p kits/scheduling/tsconfig.json --noEmit`,
is blocked by existing `src/main/mcp-endpoint.ts:5`: the shared installed
`@earendil-works/pi-ai` has no exported `JsonObject`. Scheduling's own reported
type errors were fixed; the remaining diagnostic is outside this task's scope.

`src/shared/kits-boundary.test.ts` passed 9 of 10 checks. Its existing failure
is `kits/workspace/host.ts` importing `../../src/shared/linked-file-path.js`.
Scheduling introduced no boundary offender. `git diff --check` passed.
The final in-memory esbuild host bundle measured 30,134 bytes. No full builds,
app launches, or concurrent builds ran.

No registration outside the new kit is required. Loaders discover its manifest;
the distribution's existing file globs cover the host bundle. There is no
desktop contribution to add to `kits/kit-lifecycle.test.tsx`. This version has
no settings form or command palette UI. Its management interface is the host
API, not an agent tool or composer command.

## Limits and risks

There is no durable idempotency key on `sessions.start`. Persisted intent comes
first; restart holds uncertain work for inspection and an explicit decision.
An uncertain retry needs duplicate-risk acknowledgment and disables the future
schedule. The atomic storage helper does not fsync, so power loss or restoring
an old state file can defeat duplicate prevention.

Daily schedules are UTC only. Missed occurrences are held, with no backlog.
Only the latest run is recorded per job; ordinary threads retain the work.
A pending start serializes mutations, which return busy errors while it waits.
Known active prior threads block another run. An unknown admission cannot be
checked without user inspection. Runtime defaults and normal access/approval
policy apply; this kit introduces no approval bypass or stronger agent sandbox.
