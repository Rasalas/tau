# ADR 0032: Runtimes are turned on or off per project

A runtime (Pi, the Agent SDK runtime, Codex, OpenCode, Cursor, Grok, Antigravity, and every instance such as `codex@work`) can be turned off for one project while it stays on for the others, and turned on for one project while it is off on the machine. T3 Code made the same move for its providers; the Providers page already read as if its switch did this.

## Where the setting lives

`runtimeEnabled` in the config files: a record from a backend kind to a boolean, in `~/.tau/config.json` (this machine) and `<project>/.tau/config.json` (the project). It is a record setting like `modelPreferences`, so Settings reads and writes `runtimeEnabled.<kind>` through the existing levels (`useSetting`, scope `both`), the "Applies to" pill, the origin popover and the reset button. A kind with no entry is on. Nothing else changes: the kit keeps running, its card, sign-in, version check and models stay reachable on every project; only starting work on it is refused. `disabledExtensions` is untouched and still turns a whole kit off.

## Precedence

The project's entry wins over the machine's, in either direction; the machine's wins over the default (on). That is the order `resolveSetting` and `HostConfigManager.merge` already apply to every key, so no new rule exists to learn or to keep in step. A thread in a linked worktree belongs to the project the worktree was made from: a project-facts provider may answer `root(cwd)` (Workspace Kit does, from the Git common directory) and the host reads that project's file; without an answer the thread's own folder is the project.

## What is refused, and where

The host refuses, not the picker. One gate (`RuntimeGate`, `src/main/runtime-gate.ts`, reached through `PromptPreparation`, which already stands for "may this caller execute this prompt") answers `kind` and folder with the effective value and, when it is off, with the one message every path shows: "Codex is turned off for <project>. Turn it on under Settings → Providers (Applies to this project)." It is checked in the host at every point that starts or wakes a turn on a runtime:

| Path | Where | What the caller sees |
| --- | --- | --- |
| New thread, first message | `PiHost.newSession` | the submission is rejected with the message; the draft stays |
| Send | `PiHost.prompt`, which every prompt reaches (the composer, a kit's `sessions.send`, a goal, a limit's resume) | the send fails with the message |
| Steer, follow-up | `TurnDelivery.queued` | the same |
| Queue (composer and kits) | `QueuedMessages.submit` (`queue-message`, `sessions.send` with `queue`), and the delivery of a queued message, which is a prompt | refused when queued; a message queued before the switch is put back and the queue is held |
| Continuation after a restart and after a usage limit | `reconcileInFlightTurns` (the thread is marked interrupted, nothing is sent), `continueThread` | no model call |
| Thread an extension starts (`sessions.start`): `tau_spawn_thread`, Scheduling, Handoff | `PiHost.startThread` | the call throws the message; a kit's worktree is removed as for any failed start |
| Fork and duplicate | `PiHost.forkThread`, `duplicateThread` | refused: the fork could not be sent to |

A turn already running when the switch flips finishes; the thread stays readable (open, search, export, transcript) and a thread of a runtime that is off in its project shows the message instead of sending. A delegated thread's result still reaches its parent: that is the parent's own runtime reading, not a start on the child's. Remote threads (`machine`) are not gated here; their own host applies its own settings.

## Clients

A client reads the merged config of the project a draft belongs to (`get-config` with its workspace) and hides the runtimes that are off there: in the runtime chip, in the model picker and in what a new thread defaults to. The phone uses the same host client. Settings keeps listing every runtime, marked off.

## Update checks

A runtime nobody uses is not asked for its version or latest release, and the automatic updater leaves its program alone: a runtime is in use when it is on for the machine or on in at least one project the host knows. The explicit Refresh and Update buttons still act.

## Consequences

- The enforcement lives in the host, so the phone, a remote window and an agent over MCP meet the same rule as the desktop picker.
- Pi can be turned off too. A project with every runtime off keeps its draft and says why on send.
- The setting is a plain file key: a team can commit `<project>/.tau/config.json` to keep a runtime out of a repository.
