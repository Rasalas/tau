# Scheduling kit

Scheduling is an optional, host-only kit, `tau.scheduling`. It starts off, and
new jobs are disabled. It contributes no agent tools, hidden loop, command
palette entries, or settings form. Its public host commands are the management
interface for this first version.

Each run calls `sessions.start` with the saved local workspace, runtime backend,
name and prompt. The result is an ordinary thread titled `Scheduled: <name>`.
It has no parent link, so it remains in the ordinary thread index. Open the
thread to inspect its transcript, answer approvals, steer it, or stop it.
The kit never merges or deploys. The prompt and the runtime's normal access
policy still govern what the agent can do. Scheduling does not grant extra
access or bypass an approval.

## Commands

Use the existing host protocol method `host-extension`, with arguments
`["tau.scheduling", command, input]`. A desktop extension can use
`context.hostExtension("tau.scheduling").invoke(command, input)`.
This is a host API, not a new composer slash command.

`list` is read-only and returns `{ enabled, jobs }`. Every other command requires
the owning host's window or local host token. Paired devices, including devices
with Full access, cannot change or run jobs. Foreign host extensions receive no
command grants.

| Command | Input | Result |
| --- | --- | --- |
| `create` | Complete job configuration below | Disabled job with its ID |
| `update` | `{ id, config }` | Replaced configuration, disabled job |
| `enable` / `disable` | `{ id }` | Updated job |
| `delete` | `{ id }` | Removed job, without deleting its threads |
| `set-enabled` | `{ enabled: true \| false }` | Complete state |
| `run` | `{ id }` | New thread's job record, or a recorded refused start |
| `resolve` | `{ id, decision: "skip" \| "run", acknowledgeDuplicateRisk?: true }` | Recovery decision's job record |

A complete job configuration is:

```json
{
  "name": "Daily review",
  "workspace": "/absolute/path/to/known/local/project",
  "backend": "pi",
  "prompt": "Inspect changes and report. Do not merge or deploy.",
  "schedule": { "kind": "daily", "time": "09:00", "timezone": "UTC" }
}
```

For a one-off, replace `schedule` with
`{ "kind": "once", "at": "2026-10-04T09:00:00Z" }`. Timestamps require an
explicit `Z`, seconds, and an optional three-digit millisecond component.
Daily times are `HH:mm` in UTC only. There is no local-time or daylight-saving
conversion. `backend` is the chosen local runtime kind, including an instance
such as `codex@work`. Core refuses an unavailable backend at start; the kit
never substitutes another runtime. Models follow that runtime's host defaults.

The workspace must already be known to this host. The kit resolves it once,
stores its canonical path and host-issued workspace ID, and checks that ID
before every start. It never admits a new folder or resolves another machine's
workspace. Copying the state file to another host does not reassign its jobs.

Configuration is copied on input and output. `update` replaces the complete
configuration explicitly, clears a previous held reason and disables the job.
Running jobs cannot be updated, enabled or deleted. Disable does not abort an
existing thread. Held, failed and uncertain jobs need a recovery decision
before update or enable. Delete can remove their records without retrying work.

To schedule a job, enable it and turn scheduling on. `run` is a deliberate
manual run even for a disabled job, but scheduling must be on. A one-off is
consumed when its intent is saved. Repeating `run` after completion deliberately
creates another thread; management commands are not retry-keyed.

## Missed and uncertain work

On activation, any due occurrence is `held`, not replayed. Turning scheduling
on or enabling an overdue job also holds it. A live timer more than 60 seconds
late holds its occurrence. A smaller delay tolerates normal event-loop jitter.
A daily run that lasts beyond its next occurrence holds that occurrence when
it finishes. There is no backlog or catch-up queue.

For a held or failed job, `resolve` with `skip` discards the occurrence. A daily
job keeps its enablement and moves to the next future UTC time. A one-off stays
disabled with no next occurrence. `resolve` with `run` deliberately starts one
prompt now, with the next daily occurrence in the future.

The kit writes an atomic start intent before calling `sessions.start`. A
restart turns every `starting` or `running` record into `uncertain`, even if
its last record has a thread ID. Inspect that thread and other recently created
`Scheduled:` threads before deciding. Core supplies no durable start retry key
or lookup by intent ID, so the kit cannot prove exactly-once admission.

An uncertain retry requires `acknowledgeDuplicateRisk: true`. Resolving
uncertain work disables the job's future schedule; enabling it again is a
separate explicit action. Recovery and new runs refuse a known previous thread
that is still running or waiting. An unknown admission cannot be checked this
way. Only resolve it after inspecting the existing work.

## Storage and limits

State lives in the kit's own `services.stateDir/jobs.json`, under the owning
host's user data. An OS-held process lock prevents two schedulers from sharing
that state. JSON writes use Tau's atomic, owner-only persisted-file helper.
Malformed or newer-version state fails activation without overwriting it. A
failed write stops the kit instead of retrying automatically. Deactivation
cancels timers, removes the turn observer and waits for pending writes before
releasing the lock. Already admitted ordinary threads keep running.

There are at most 100 jobs. Prompts are at most 16,384 characters, names 120,
workspace paths 4,096, runtime kinds 128, and error details 500. The stored file
is limited to 2 MiB, with 8 KiB per job reserved for run records and JSON
formatting. Large configurations can therefore reach the limit before 100 jobs.
Mutations are serialized; a concurrent mutation gets a
bounded busy error rather than joining a queue. One pending start can block
other mutations until it returns or the kit is deactivated. Listing still works.

Only the latest run record is retained per job, with intent ID, timestamp,
thread ID when known, and outcome. Earlier ordinary threads remain inspectable
in Tau. A run command can return `running` just before a turn observer records
completion; read `list` or subscribe to the kit's `state` event for current state.

The atomic helper does not fsync the file or directory. Its process-crash
recovery does not establish a power-loss durability guarantee. Deleting or
restoring an old state file also defeats duplicate prevention. The kit offers
no remote execution, shell cron, new network service, cross-runtime migration,
automatic retry, or thread retention policy.
