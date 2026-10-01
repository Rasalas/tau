# ADR 0025: A window knows several machines and follows the thread's

## Status

Accepted, 2026-09-24. Partly superseded by
[ADR 0030](0030-the-workbench-controls-every-machine.md) (2026-10-01): a
workbench keeps threads of connected agents machines in one list and stays on
its own host. This ADR's catalog, pairing, address selection and window
navigation remain for machines this computer's agents may not reach, and for
explicit `tau machines open` commands. Amends [ADR 0021](0021-host-runs-in-its-own-process.md),
where a window is the client of exactly one host for its whole life. Builds on
[ADR 0024](0024-pairing-allowed-on-the-host.md) for pairing.

## Context

The user wants "environments" (plan, decision 8): the own machine and saved
other machines side by side in one window, and the machine chosen per new
thread. There should be no switcher. Until now a window had one host: its
supervised child process, or the one `TAU_HOST_URL` named at start. Reaching a
second machine meant a second app started with other environment variables.

The usual shape is one connection per machine in a single web client. Every
store is keyed by a machine id, thread and project ids are scoped refs
(`machineId:threadId`), and every call names its machine. Terminal, diff and
file calls follow the thread's machine, and the sidebar is one flat list with a
machine icon on remote threads.

Tau is built differently in three ways:

- **Kits come from the host.** A window loads the desktop halves its host
  compiles (`desktop-extensions`, ADR 0021). Another machine may run another
  Tau version with other packages, so its threads need its own kits.
- **Every workbench store is single-host.** Thread store, view store, drafts,
  the bootstrap cache, the runtime catalog and the kits' own stores all assume
  one host. So do several module-scope singletons (`setHostClient`,
  `setPlatform`, shared kit modules) and the host's own idea of an active
  thread.
- **Some kits act on the window's machine.** Preview puts a native view over a
  panel, and core's folder picker is a dialog of the window's process. Both
  are called by the host through `callClient`.

## Decision

**The window keeps a catalog of saved machines.** Its process owns
`<userData>/environments.json`, mode 0600. Each entry holds:

- the host id (`<userData>/host-id` of that machine, from the pairing payload);
- a name;
- every address the host published, each with its kind;
- the certificate fingerprint;
- the client token, encrypted with Electron's `safeStorage`;
- when the machine was added and last reached.

If `safeStorage` cannot encrypt, the machine is not saved, and the user reads
why. The own machine is not in the file: it is always the window's
own host. The catalog is the window's, not the host's: the machines belong to
the person at this screen, and a host serves devices it does not know about.

**A machine is added through ADR 0024.** The window's process pairs with
`pairWithHost` over `ws`:

- **From a pairing link or QR text:** it pins the fingerprint the link carries
  and binds the digits to it.
- **From a bare address:** it reads the certificate the host presents, pins
  that one for this attempt, and binds the digits to it. Both screens then
  show the same six digits only if nothing in between swapped the
  certificate, so comparing them is what makes trust on first use safe.

The owner allows the machine on the other host as they allow any device. Only
then does a token exist, and only then is the machine saved. Bonjour (F06)
will fill the same address field.

**Each saved machine has one small connection of its own, in the window's
process.** The connection:

- tries the machine's addresses in a fixed order (the one that last worked,
  then loopback, LAN, `.local`, Tailscale, MagicDNS);
- pins the certificate;
- says hello as an auxiliary connection that subscribes to no thread and no
  topic (F12), so it receives only what every client gets;
- reads the thread index once, then follows `thread-index` and `agent-status`
  pushes;
- pings (F02) to notice a machine that went away.

This connection is how the window knows each machine's status (connecting,
connected with round trip, offline since, refused with reason) and its recent
threads, including which of them are running. The own machine gets the same
kind of connection over loopback, so it can be listed from a workbench that
shows another machine.

**A workbench shows one machine; the thread list shows all.** The renderer
stays a client of one host at a time, the host it was loaded for, exactly as
ADR 0021 built it: its kits, stores, drafts and panels are that host's.
Environments add one step. Opening a thread of another machine, or starting a
new thread there, points the window at that machine: the window's process
attaches a `WindowHost` to it (pinned, with the saved token), and the page
loads again with that host's address, token and `environment=<id>`. The
target travels with it:

- For a thread, its path.
- For a new thread, the draft's text and that machine's most recent project.

The workbench on arrival switches to the thread, or opens the draft. The own
machine's host keeps running meanwhile, and returning to it is the same step.

Nothing in the UI switches machines as such. The thread list shows every
machine's threads with its status, and the draft of a new thread has a "Run
on" choice. The machine follows the thread the user opens, which is what
decision 8 asks for.

**What the workbench shows lives per machine.** The client storage keys that
describe a host's state (bootstrap cache, composer drafts, the pending new
thread, the turn activity cache) carry the machine's id when the page shows a
machine other than the own one. Preferences, window layout and keybindings
stay shared. Stage and dock state are already keyed by workspace id, and a
workspace id includes its host's id.

**Kits follow the machine the workbench shows.** Every desktop half comes from
that machine's host, so Files, Terminal, Review, Workspace and the runtimes
act on that machine's files, shells and checkouts. That is correct by
construction.

What is local stays local:

- **`local-files`.** A host on another machine has no `local-files`, so
  "open in editor", "reveal" and served workspace files stay off. This was
  already the case for `TAU_HOST_URL`.
- **Window halves.** They are offered only to the own machine's host.
  Another machine's host gets none: no folder picker (a path picked here
  means nothing there), and no Preview views, since a view in this window
  would load `localhost` of this machine.
- **The kit list.** The window's process serves only the bundles of the host
  it points at. Another machine's `desktop-extensions` travel over its
  uplink, as for any remote host.

**A machine's certificate is pinned for Chromium too.** The page's socket
runs in Chromium. One certificate verifier in the window's process accepts,
for a host name, the fingerprints the saved machines pinned for it, and
leaves every other name to Chromium. Chromium does not report the port, so
two saved machines behind the same name accept each other's certificate.
That is no weaker than pinning either one, since both are the user's.

**The page's socket to another machine sends no `Origin`.** F02 lets
Electron's `file://` page in only over loopback. The window's process drops
the header on the workbench page's own sockets to saved machines, and only
there, so such a socket reads as a non-browser client. The client token
stays the gate, as ADR 0023 has it.

## Alternatives

- **Every store keyed by machine, one renderer.** This would mean
  scoping every core store, draft, cache and module singleton by machine, and
  every kit's state too. Every kit would also have to load once per machine
  (another version may be running there). That is a rewrite of the workbench
  and of every kit, and it cannot be done in one step.
- **One renderer per machine, stacked in the window
  (`WebContentsView`).** Switching back to a machine seen before would be
  instant. But the Electron bridge, window events, menus, zoom, the quit
  shortcut, context menus and Preview's native views all assume one page per
  window, and each would need routing per view. This is the natural next
  step if the reload proves too slow, and nothing decided here blocks it.
- **Load balancing (a weight per machine: prefer, normal, less often, manual
  only).** It would pick the machine for a new thread by free CPU and memory,
  and only for projects that exist on several machines. Tau has no host resource
  sample and no cross-machine project identity. The choice stays explicit.

## Consequences

- Moving to another machine reloads the page. That costs a workbench start,
  plus loading kits from the remote host the first time (then the host's
  compile cache). Returning is the same cost. A draft carries its text, not
  its attachments.
- A remote machine's threads run and continue with everything its host
  offers, including a Tau version other than the window's. Only what needs
  this window's machine is missing: Preview, and picking a folder in a
  dialog. Such kits say so, as they already do for a web client.
- The window holds one extra connection per saved machine, and one to its
  own host. None of them subscribes to a thread, so a busy thread elsewhere
  costs only index and status pushes (F12).
- If the shown machine becomes unreachable, the workbench shows F02's
  reconnect band, and the thread list offers the other machines.
- A machine whose token was revoked or expired is shown as refused, with the
  reason. Removing it deletes the token. Pairing again gives a new one.
- A window started with `TAU_HOST_URL` or `TAU_HOST_INPROCESS=1` shows its
  one host as before. The catalog works beside the supervised host only.
- The way back does not depend on the shown machine's kits: while the page
  shows another machine, core offers "Back to this computer" in the palette
  (the page's address says so before any list loads). The Machines Kit adds
  the same step to its title-bar chip.
- Addresses follow the machine without pairing again: its hello names the
  addresses its network listeners have, and a Bonjour record with the pinned
  fingerprint does too. Only LAN addresses are replaced; names, Tailscale
  addresses and typed ones stay, since a machine reached one way may not list
  the others at that moment.
- The window may show the machine it showed last again at start (a setting,
  off by default). It waits 2.5 s for that machine before the first page
  loads, so the page never loads twice; a machine that does not answer in
  time leaves the window on this one.

## Out of scope

- **Desktop without a host of its own** (the own machine switched off).
- **SSH-managed machines** and relays (plan, decision 3).
- **Moving a thread between machines**, or one thread visible on two at once.
  [ADR 0027](0027-a-host-reaches-other-machines-for-its-agents.md) later let a
  host reach other machines for its agents, and wave H builds on it: a thread
  *continues* on another machine as an ordinary thread there, a fork whose
  original stays here, and comes back as a branch; a thread there can be
  looked in on without moving the window. The thread itself still never moves.
- **Port forwarding** so Preview can show a remote machine's `localhost`.

## Amendment: the phone app (K106, 2026-09-29)

The phone app keeps the same model: it shows one host at a time and moves by
loading afresh on another host, and every host it paired with is one
connection of its own, with its own token. A phone differs from a window in
two ways, so it keeps no standing connection to the hosts it does not show:

- **Battery and data.** A connection per host that stays open wakes the radio
  for every push. The phone reads the other hosts in short visits instead: an
  auxiliary hello that follows no thread and no topic, at start, every two
  minutes while the app is in front, when it comes back to the front and on
  Retry. A visit sends the last push it saw (`lastSeq`) and applies what the
  host replays; only a gap the host cannot replay costs a `bootstrap`. The
  link stays open 20 s for a kit's read (`readExtension`), then closes, and
  every link closes when the app goes to the background.
- **Busy hosts are visited more often.** While the app is in front and a host
  the phone does not show has a thread that runs or waits for an answer (as
  far as the last visit saw), the next visit comes after 30 s instead of two
  minutes; once the visits find nothing running or asking, the interval goes
  back to two minutes. In the background there are no visits at all. 30 s
  with the 20 s linger keeps a link open about two thirds of the time only
  while there is work to watch, and a quiet host costs one short visit every
  two minutes.
- **Reloads.** Every machine switch reloads the app, so what each visit found
  (threads, running ones, open questions, the last sequence, reached or not)
  is kept per host and shown at once on the next page.

Questions count as host-wide pushes (`extension-ui-prompt`,
`extension-ui-resolved`), so a visit replays them like the run state, and a
thread asking there shows as "Question" in the phone's list. A visit that
takes a `bootstrap` also asks for the open set (`sync-extension-ui`), because
the snapshot does not carry questions; the host re-announces them to its
clients, which drop repeats. The list's search looks at every thread the
visits kept (up to 80 per host); the hosts have no search method, so it
matches titles, projects and branches on the phone.

So on a phone "connected" means "reached at the last visit", and a host's
running threads are as current as that visit (30 s while something runs
there). The shown host is live.
