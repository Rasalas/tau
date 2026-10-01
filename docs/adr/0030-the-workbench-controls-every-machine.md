# ADR 0030: The workbench controls every machine; a thread has a home machine

## Status

Accepted, 2026-10-01. Supersedes the part of
[ADR 0025](0025-a-window-follows-the-threads-machine.md) where a workbench
shows one machine and moves by reloading. ADR 0025's catalog of saved
machines, pairing and pinning stay. Builds on
[ADR 0027](0027-a-host-reaches-other-machines-for-its-agents.md): the host's
own connections to other machines become the way a device reaches them.
Spec: `.scratch/one-workbench-many-machines/spec.md`.

## Context

The user used rex for a new thread for the first time. The window reloaded
onto rex. Rex's onboarding wizard opened. The Mac's threads became external
rows that could not be settled, and the transcript followed rex's settings
instead of the user's. The user expected something else: the app in front of
them controls, and a thread only decides where it runs.

ADR 0025 chose the reload for two reasons. Every workbench store, several
module singletons and every kit assumed one host. And another machine might
run another Tau version, so its threads needed its own desktop halves, loaded
from it.

The second reason assumed the renderer talks to each machine itself. A phone
already shows everything through one host. And since ADR 0027 a host has its
own connection to every machine it was paired with, and drives threads there
(remote sub-agents, handoff) through core methods and kit commands.

## Decision

**A thread has a home machine.** It is chosen in the draft and never changes.
Its agent, workspace, files, shells, git and Preview run there. A thread that
continues elsewhere (handoff) is a new thread with its own home machine, linked
to the one it came from.

**A device talks to one host, and that host reaches the others.** The window
talks to its own host, the phone to the host it is connected to. That host
lists the threads of every machine it reaches and serves them through its
ADR 0027 connection. The window never moves.

**Another machine's thread is a thread here, owned by a "machine" runtime
backend.** The Machines Kit registers a backend (ADR 0005) whose threads are
the other machines' threads, with ids `<machineId>~<sessionId>`. The host
activates such a thread like any other, so the renderer, its stores and the
active-thread machinery stay as they are. The backend reads the transcript
there (`transcript-page`), sends and steers with `send-to-thread`, aborts with
`abort`, answers questions with `answer-extension-ui`, and turns the pushes of
that thread, which the host follows over its connection there, into runtime
events. It never calls `switch-session` or `new-session` there: the other
machine's own active thread never changes. A new thread there starts with
`start-thread`, off screen.

**Kit calls follow the thread.** A call to Workspace, Files, Terminal or
Review that names another machine's workspace, or that is made while such a
thread is active, is routed by core to that machine's kit, with the thread's
workspace named; topics such a call watches are relayed back.

**Versions may differ.** Core thread methods are the host protocol, which is
versioned and tolerant (`docs/host-protocol.md`). Kit features of a thread
(Files, Terminal, Review, a runtime's own commands) call that kit's host half
on the home machine. A machine's hello lists its kits and their versions. A
kit that is missing or too old there turns its feature off for that machine's
threads with "Update <machine>" (`docs/host-updates.md`). Chatting, steering
and settling keep working.

**Work on a machine never depends on the relaying host.** A thread runs on its
home machine. If the relaying host goes away, the work goes on; a device that
can reach the home machine directly connects there instead.

**Thread meta lives with the thread.** Pinned, settled, snooze and order are
kept on the home machine (Thread Rail's `thread-meta.json`) and pushed to every
device. Any device can change them.

**Preferences belong to the person.** Every machine keeps a copy. A change is
written to every reachable machine; on reconnect the newer value per key wins.
A device may override single keys in its own storage. Models stay a machine's
capability: favourites are shared, the picker lists what the home machine
offers.

**Setting a machine up is part of adding it.** After pairing, the add flow
compares agents here and there, runs sign-in on the new machine with its URL or
code shown here, accepts API keys in that machine’s sign-in without exporting
stored keys, and offers to import that
machine's earlier conversations. Onboarding never opens by itself for a machine
the window only shows.

## Alternatives

- **Keep the reload (ADR 0025) and patch it.** Phase 1 of the spec does this
  for the visible defects. It leaves the window moving, two kinds of row in the
  sidebar, and a reload per switch.
- **One renderer with a client per machine.** The renderer would connect to
  every machine itself. It needs desktop halves from the right version per
  machine, which is why ADR 0025 rejected it, and a phone would hold a
  connection per machine, which the ADR 0025 amendment avoids for battery.
- **One renderer per machine stacked in the window** (ADR 0025's next step).
  Switching gets fast, but threads of two machines still never sit side by side
  in one list and stage.
- **A machine that holds logins or models for the others.** Work on rex would
  stop when the Mac sleeps.

## Consequences

- ADR 0027's `MACHINE_REQUEST_METHODS` grows by `start-thread`,
  `send-to-thread`, `answer-extension-ui` and `sync-extension-ui`. The agents'
  device key on the other machine carries them; its preset limits them as
  before. A machine without that key keeps ADR 0025's moving window.
- A thread on rex followed from the Mac costs one relay hop. Transcript pages
  and pushes already travel in pieces sized for remote clients.
- The renderer's stores stay single-host: another machine's threads are this
  host's threads. Kits that keep state per workspace already tell machines
  apart, since a workspace id includes its host id.
- Attachments, renaming and changing the model of another machine's thread
  are not relayed at first.
- Window halves (folder picker, Preview's native view) still serve the own
  machine only.
- Look-in tabs and external rows go away; the external row's mark stays as the
  machine mark.

## Out of scope

- Moving a running thread between machines.
- Desktop without a host of its own.
