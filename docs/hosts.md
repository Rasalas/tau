# Hosts, machines and devices

The host owns the threads; a window, a browser or a phone is a client of it ([The window and the host](architecture.md#the-window-and-the-host)). This page covers running the host without a window, reaching it from elsewhere, working on other machines, the web client and the mobile app. [Updates and machines](site/updates-and-machines.md) has the short version.

## Run the host as a system service

The host can run as a service of the machine, so threads, terminals and paired
devices keep working with no Tau window open and after a restart of the
machine. Install it in *Settings → Connections → Background*, or from a
terminal:

| Task | Command |
|---|---|
| Install and start (again: repair) | `tau service install` |
| Where it stands, and its log | `tau service status` |
| Restart it | `tau service restart` |
| Stop it and remove it from login | `tau service uninstall` |

- **macOS:** a LaunchAgent, `~/Library/LaunchAgents/dev.tbuck.tau.host.plist`.
  It starts when you log in and stops when you log out; keep the Mac logged in
  (and, for a phone, awake) for access from elsewhere. Tau must run from
  Applications, not from the Downloads folder macOS starts it from.
- **Linux:** a systemd user unit, `~/.config/systemd/user/tau-host.service`.
  Installing turns on lingering (`loginctl enable-linger`) so it starts at
  boot and outlives your session; where that needs an administrator, the
  status says so with the command. An AppImage cannot run as a service.
- **Windows:** a Task Scheduler task, "Tau Host", that runs at your logon.

### An invisible display on Linux

On Linux, `tau service install --display` gives the service an invisible
display: `tau-xvfb.service` runs Xvfb (no TCP, a cookie in
`<userData>/display/Xauthority`) whenever the host runs, and the host hands
its `DISPLAY` to terminals, agents' shell commands and project scripts, so
GUI apps and headed browsers run where nobody sees them. When a thread needs
the preview and no Tau window is attached, the host starts
`tau-window.service`, a Tau window on that display, and stops it after 10
minutes without use (it costs about 200–300 MB). The `.deb` brings Xvfb
along; elsewhere install your distribution's `xvfb` package first.
`tau service install --no-display` removes the display, and Settings →
Connections → Background shows, adds and removes it too.

Where the kernel restricts user namespaces (Ubuntu 24.04 and later), the
window needs an AppArmor profile that allows them for Tau's binary; it never
starts with `--no-sandbox`. The `.deb` installs that profile. For a copy
unpacked anywhere else, Tau writes one for its own path
(`/etc/apparmor.d/tau-<hash>`: that path and `userns`, like the `.deb`'s) and
loads it, with one password prompt: adding the display in Settings (or the
Add AppArmor Profile button the service status shows) asks in the system's
dialog through pkexec, `tau service install --display` asks through `sudo` in
the terminal. Tau reads its own AppArmor label and `/etc/apparmor.d` to know
whether the profile is there. The profile belongs to the path, so updates in
place need nothing more; a copy that moves needs a new one. Without a polkit
agent (an SSH login), the button says so and points to the terminal. A
profile for a folder you can write to lets whatever binary you put at that
path use user namespaces, which every program may on distributions without
the restriction.

This holds on a machine with a desktop session too: a Wayland desktop hands
`WAYLAND_DISPLAY` and `XDG_SESSION_TYPE` to every user service, so the units
unset them (with `WAYLAND_SOCKET`), the window starts with
`--ozone-platform=x11`, and the host drops them before it starts any shell.
Nothing Tau starts lands on the real screen. A unit an older Tau wrote shows
as stale in the status; install again to replace it.
macOS and Windows refuse the option: neither has a display that nobody sees.

### How a service and a window share the host

The service runs the app's own binary on the app's own userData, so a Tau
window adopts the host it finds in `host.json` like any other and never starts
a second one; quitting the window leaves it running. Installing from a window
moves that window's threads into the service host, on the same port. An
instance with its own `TAU_USER_DATA` gets a service of its own (a suffix on
the names). Network access (Settings → Connections) lives in
`<userData>/network.json`, so the service host opens the same Local network,
Tailscale and proxy listeners, on the same ports, once it has taken over.
Uninstalling leaves threads and settings where they are.

After an update the window finds the service on the old version and restarts
it once; if the unit points at another copy of Tau, it rewrites the unit for
this one and restarts it once more. A service that still answers with another
version is stopped, and the window runs its own host until the next start.
The unit restarts a host only after a crash (`KeepAlive.SuccessfulExit` false,
`Restart=on-failure`), so a window stopping it never starts a loop.

*Keep this machine awake while turns run*, beside it, holds off sleep while
any thread works: `caffeinate` on macOS, `systemd-inhibit` on Linux,
`SetThreadExecutionState` on Windows. It applies to a host in its own process,
service or not.

## Reach the host over a socket

The renderer talks to the host through one versioned protocol ([ADR 0010](adr/0010-host-protocol.md)); Electron IPC is one transport of it. Start a host that also listens on a socket with `TAU_HOST_LISTEN=127.0.0.1:7788 npm start`, and point a client at it by opening the workbench with `?host=ws://127.0.0.1:7788&token=<token>`, where the token is the line in `~/.tau/host-token` (created on the first listen, 0o600). A wrong token closes the connection. Encryption is TLS's job (`TAU_HOST_TLS=1`, below) or an SSH tunnel's.

`npm run smoke:remote-host` proves the plumbing without a window: it starts `src/main/headless.ts` in a scratch repository, says hello, fetches the bootstrap, sends a prompt, disconnects, reconnects with `lastSeq` and checks that the pushes missed in between are replayed. It runs twice: in plaintext, and over TLS with the printed fingerprint pinned, where a wrong fingerprint and a plaintext socket must be refused.

## Run the host on another machine

The host and the window need not be the same machine. The workspace, Pi, the models and every tool stay on the host; the Electron window is only a client of the protocol above.

On the host machine, start a host without a window:

```bash
npm run build
TAU_WORKSPACE=/path/to/project TAU_HOST_LISTEN=127.0.0.1:7788 node dist-electron/main/headless.js
```

It prints the URL it listens on and the path of its token. Without TLS the socket is unencrypted and repeats that token in every hello, so the host refuses to bind anything but a loopback address; `TAU_HOST_INSECURE=1` overrides that for a network you already trust, and the host prints a warning when it does. There are two ways across machines: TLS (next section) or an SSH tunnel. For the tunnel, forward the port from the client:

```bash
ssh -N -L 7788:127.0.0.1:7788 you@host-machine
```

Then copy the host's `~/.tau/host-token` to the client machine (or pass it as `TAU_HOST_TOKEN`) and start Tau as a client:

```bash
TAU_HOST_URL=ws://127.0.0.1:7788 npm run start:existing
```

The main process supervises no host of its own in that mode: it opens the window, which speaks the protocol over the socket, and the kits' code is fetched from the host and served to the renderer from here. What needs this machine (the clipboard, image previews, rebuilding the workbench) is answered in the window process rather than sent to the host. Paths in the workbench (the project's `cwd`, changed files, a tool's output) are the host's paths, so an action that hands a path to a local tool points at a directory that exists only there. The socket transport says so by leaving the `local-files` capability out of its hello, which the Electron transport announces.

### Without a tunnel: TLS

A host with TLS may listen on any interface, such as its Tailscale address:

```bash
TAU_WORKSPACE=/path/to/project TAU_HOST_LISTEN=100.64.0.7:7788 TAU_HOST_TLS=1 node dist-electron/main/headless.js
```

On first start it creates a self-signed certificate under its userData (`~/.tau/headless/tls/`, key 0600) and keeps it across restarts. When the certificate nears its end, the host renews it with the same key. Besides the socket and token lines it prints the certificate's fingerprint and its public key:

```
tau-host listening on wss://100.64.0.7:7788
tls fingerprint: SHA256 6F:AB:DF:…:10:E9:1E (browsers show it; a renewal changes it)
tls public key: SHA256 9A:38:0C:…:7D:21:B4 (a client pins it as TAU_HOST_PUBLIC_KEY; a renewal keeps it)
```

`TAU_HOST_TLS_CERT` and `TAU_HOST_TLS_KEY` use a certificate of your own instead. On the client, copy the token as above and pin the key:

```bash
TAU_HOST_URL=wss://100.64.0.7:7788 TAU_HOST_PUBLIC_KEY=9A:38:0C:…:7D:21:B4 npm run start:existing
```

`TAU_HOST_PUBLIC_KEY` also takes the `sha256/<base64>` form that curl's `--pinnedpubkey` uses, and so does `TAU_HOST_FINGERPRINT`. A hex `TAU_HOST_FINGERPRINT` still pins one certificate, and a renewal breaks that pin. Without either variable the window shows the host's key on first connect and asks whether to trust it; compare it with the line the host printed. A yes saves the key in the client's `known-hosts.json`. An entry saved before key pins holds a certificate; the first connection it lets in replaces it with that certificate's key. A host whose certificate a CA vouches for needs no pin. If the host ever presents another key (or, for a certificate pin, another certificate), the window refuses it before sending the token, and the status line shows both values. If you replaced the key yourself, update the pin or delete the known-hosts entry. [host-protocol.md](host-protocol.md) has the details.

A dropped link (a suspended machine, a restarted tunnel, a phone that slept or changed networks) is expected: the client reconnects with backoff, says hello again with the sequence it last saw and replays what it missed. Heartbeats find a link that died without a close, and coming back to the page or to a network tries again at once. A window's own host keeps its port across a restart of the app while nothing else took it, so a tab opened on it reconnects instead of asking to pair again. A strip above the status line reads `Reconnecting to the host…` (with "Retry now" while it waits), then `Refetching the workbench state…` if the host's buffer no longer reaches back far enough. For a host on another machine, a dot in the title bar shows the link and its round trip. Nothing has to be restarted by hand.

The host accepts sockets only from pages it served itself and from clients that are not pages (the native app's sockets send no `Origin`); a proxy that changes the host name is added with `TAU_HOST_ALLOWED_ORIGINS=https://…`.

## Other machines in the same window

**Desktop-managed SSH.** Choose SSH in Settings → Machines → Connection method
and enter the alias or `user@hostname` you already use in a terminal. Tau detects
Linux or macOS and x64 or arm64, downloads the official portable archive named
by that platform's signed release feed, verifies the Ed25519 signature and
SHA-512 checksum, uploads it through SSH, verifies the checksum again, and
installs a user service in `~/.local/share/tau-managed/`. Releases occupy separate
directories; `current` changes atomically. A matching live host is reused.
Changing versions repairs the managed service. Your normal Tau installation and
its data remain separate.

The remote machine needs `sh`, `tar`, `openssl`, and systemd user services on
Linux or launchd on macOS. Linux also needs the system libraries required by
Tau's Electron runtime. Tau asks for no administrator password. Linux lingering
may need `loginctl enable-linger <user>` from an administrator for the host to
survive logout. Only platform/architecture archives built and published by the
release pipeline are accepted; an unavailable release gives an error before
installation. The first release containing `latest-host-*.yml` and its signatures
must be published before this setup can use the official feed.
The workflow builds portable Linux x64/arm64 hosts, both Mac architectures,
and Windows x64. The ARM Linux archive uses GitHub's documented
[standard ARM runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
and has its own feed; it does not change desktop Linux installer updates.

Tau uses your SSH config, agent and known host keys with strict host-key checking
and password prompts disabled. Log in once in a terminal to verify an unknown
host key, and set up key authentication there. A saved machine uses a managed
loopback port forward, with automatic reconnect and a transient pairing link
approved over the SSH session. Removing it stops that forward and forgets its
paired keys. The remote service remains installed; remove it there with the
managed copy's `tau service uninstall` when you no longer want it. The forward
lives with the desktop process, so agents cannot reach an SSH-only machine after
that desktop exits. Use a direct network endpoint or Tau Connect for access
that must outlive the desktop. Windows hosts can be added through a WSL
distribution with systemd; SSH bootstrap currently targets Linux and macOS.

**Across networks.** [Tau Connect](connect.md) provides a self-hostable relay and
desktop registration, pairing, reconnect and route revocation. It needs your own
HTTPS relay deployment; Tau does not borrow T3's cloud service.

The easier way to work on another machine is to add it to the window you already use. On the other machine, open Settings → Connections, turn on network access and create a pairing link. On this one, open Settings → Machines and paste the link, type the other machine's address (`studio.local:7788`), or click **Find Machines** to list the ones that announce themselves on this network (the other machine needs Local network and Announce on) and **Add** one. The other machine's window asks whether to let this computer in and shows six digits; allow it if this window shows the same six. Tau keeps that machine's key encrypted in the system keychain and never saves it anywhere it cannot.

**From a terminal, over SSH.** If you can already `ssh rex`, one command pairs the two machines with no link to copy and no digits to compare:

```bash
tau machines add --ssh rex --agents        # --name <name>, --access read-only, --json
tau machines list                          # --json for scripts and agents
tau machines remove rex
```

Tau must run on both machines, the same version or newer on rex, and rex must accept connections from this computer (Settings → Connections → Network access). `tau machines add` runs `tau machines accept-ssh` on rex through your own `ssh` (your config, agent and known_hosts; it never asks for a password). That makes a pairing link that lives two minutes and hands it back over the SSH session only, never through a file, an argument or an environment variable. This computer asks with it, pinned to rex's key as a pasted link would be, and rex's command line allows that one request with rex's own host token. Anyone who can log in to rex over SSH could read that token anyway. This computer's window keeps rex, as Settings → Machines would. `--agents` also lets this computer's agents work there, and without a window only the agents keep it. Running the command again only checks the connection. `tau machines remove` forgets rex here; rex lists this computer until its owner revokes it in Settings → Connections there. [agents/pairing-machines.md](agents/pairing-machines.md) is the short version for agents.

From then on the rail ends with **Other machines**: each with a dot for its status (connected with its round trip, connecting, offline since when, refused and why), and its newest threads, including the ones that are running. Clicking a thread opens this window on that machine: its threads, projects, terminals, files and kits are that machine's, and so is everything the agent does. **Run on** in a new thread's draft moves the draft, text and all, to another machine before it starts, into that machine's checkout of the same repository (matched by its origin, or its first commit, not by the folder's name). A machine without one says "Tau takes <project> along": the draft stays here, and when you send it Remote Work takes the project's commits, uncommitted and untracked work into a worktree there and starts the thread in it, without moving the window. A notice says when it runs there; its work comes back as a branch from Settings → Remote work, as a handed-over thread's does. Returning is the same click on a thread of this machine, the machine's name in the title bar, or **Back to this computer** in the command palette. When the other machine moves to another network, Tau follows its new addresses the next time it reaches it. Settings → Machines can also show the last machine again when Tau starts. Every move loads the window again, which takes a moment the first time a machine's kits are compiled. [ADR 0025](adr/0025-a-window-follows-the-threads-machine.md) explains the design and what is left out: the folder picker stays with the machine the window runs on, and Preview on another machine is a live picture you can click, drawn there by a Tau window of that machine.

## Work on another machine

You can hand work to another machine (say a small Linux box called rex) and steer it from here. The thread runs there as an ordinary thread of that machine; this one keeps only a link to it. rex never has to reach this computer, so a Mac that sleeps or sits behind NAT is fine. Nothing is ever pushed to your Git remote: the project's state goes over Tau's own encrypted connection as a Git bundle, and the work comes back as a branch.

- **Let this computer's agents in.** When you pair with rex (Settings → Machines), leave **This computer's agents may work there** on. rex's owner allows one request that names two devices, this computer and its agents, and can revoke either alone. For a machine you added earlier, the same switch sits on its row. Under each machine, Settings → Machines shows its cores, CPU, free memory, running turns, and which runtimes are ready there; **Check again** asks anew. Runtimes sign in on rex itself (its Settings → Providers); Tau never copies a login.
- **Sub-agents on rex.** Settings → Agents → **Run sub-agents on** picks This computer (the default), rex, or Automatic. An agent may also name a machine for one child (`machine` on `tau_spawn_thread`) or in an agent definition (`machine:` in `.tau/agents/*.md`). A child on rex starts from the parent's state, uncommitted work included, carries a **rex** chip in the Agents panel with its status and cost, and comes back as a branch `tau/rex/<name>` that merges only when it is clean; a conflict applies nothing and keeps the branch. rex runs as many children at once as it has cores; the rest wait.
- **Continue on rex.** A thread's title menu → **Continue in…** → **On another machine** hands the thread to rex, with its history (Pi) or a summary (other runtimes), and the composer's draft as its next message. The window stays here, and the thread here stays usable. A banner above its composer shows how it is doing there, with **Open** (show rex in this window), **Look in**, **Bring back** (its branch here, and a summary of what happened there into the composer) and **Merge**.
- **Look in.** A thread on rex opens here as a read-only stage tab: from its row in the Agents panel, the eye on a thread under **Other machines** in the rail, or **Look in** on a banner or toast. The tab follows the thread live and shows rex's Preview as a small picture. When a thread on rex asks a question, a toast (and a system notification while Tau is in the background) offers **Open on rex**, where you answer it.
- **Automatic.** **Run on → Automatic** in a new thread's draft lets Tau pick where the thread starts when you send its first prompt: the machine with the most room by weight × cores × idle CPU × free memory, leaving out machines that are offline, busy (CPU at 95 % or more, 5 % memory or less, a running turn per core) or without the runtime and model ready. Settings → Machines → Automatic sets the weights (this computer 5, others 50, 0 = never), so an idle rex wins over a busy Mac. The tooltip says why. Sub-agents set to Automatic use the same choice.
- **Files you ignore in Git.** `.env` files and notes folders stay behind unless you tick them in Settings → Remote work, once per project. Tau offers small text files only, never `node_modules` or build output.
- **Out of sight on rex.** On Linux, `tau service install --display` gives rex's host an invisible display (Xvfb). Agents' GUI apps and headed browsers run there, and a Tau window on that display starts when a thread needs the preview and stops after 10 minutes without use.
- **Quiet here.** Sub-agents that stay on this computer run their commands at a lower priority (`priority` in `~/.tau/agents.json`: `low` by default, `background` or `normal`), so they yield to your own work. macOS has no invisible display: Computer Use, apps an agent opens and windows off screen stay visible here ([Core and kits](CORE.md#out-of-sight-on-this-machine)).

[ADR 0027](adr/0027-a-host-reaches-other-machines-for-its-agents.md) explains why this machine's host keeps keys of its own for rex.

## The web client

A listening host also serves a browser client, so a phone or a second machine can
supervise the same threads as the desktop window. Build it once (`npm run build:web`
writes `dist-web/`), then start a host that listens:

```bash
npm run build && npm run build:web
TAU_WORKSPACE=/path/to/project TAU_HOST_LISTEN=127.0.0.1:7788 node dist-electron/main/headless.js
```

Besides the socket line, a host started by hand prints a pairing link (a window's own host and a service do not; create their links in Settings → Connections):

```
web client: http://127.0.0.1:7788/#pair=<code>&host=<id>&name=<machine> (single use, 10 minutes; allow the device in Settings → Connections or here)
```

With `TAU_HOST_TLS=1` the page and the socket are served over HTTPS on the same port, the link starts with `https://`, and it carries the pin of the certificate's key (`pk=`). A browser shows a self-signed certificate as a warning; its fingerprint should match the `tls fingerprint` the host printed.

Open it. The code lives in the URL's fragment, so it reaches neither a proxy nor an
access log, and the page replaces the address before it renders anything. The page does
not get in by itself: it asks the host, shows six digits, and waits. The host's owner
sees "<device> wants to connect" in every Tau window that holds the host token (or, for
a host started by hand, on its terminal) with the same digits, and allows the device
only if they match ([ADR 0024](adr/0024-pairing-allowed-on-the-host.md)). The browser then
gets a token of its own, never the host token, and keeps it in `localStorage`. Without a
link, "Ask to connect" sends the same request; the host's owner can also paste the host
token, the line in `~/.tau/host-token` on the host machine. A token the host refuses,
one whose access was revoked, or one unused past its timeout, closes the socket and
brings the page back with the reason.

### Who may connect

**Settings → Connections** in a Tau window manages who else may connect. It shows the
addresses the host listens on and its certificate fingerprint, the devices waiting to be
allowed (with their digits), and makes more pairing links (a label, 10 minutes to a day,
Full or Read only, single use; Copy link, and a QR code when the address is reachable
from another device; the link names every address and the fingerprint, for the app).
It lists the paired devices (browser, OS, address, when each was last active, the last
thing it changed, when it will be signed out unused), lets you rename one, make it Read
only (it may look, and every change is refused) or Full, pick when it is signed out
(30, 90 or 365 days unused, or never), revoke one or all others, which closes their open
connections at once. "Rotate…" replaces the host token and disconnects every other
connection that used it (a browser paired before tokens of their own, say); paired
devices keep theirs. A paired device cannot use the page: managing access takes the
host token.

### Network access

**Network access** on the same page lets the app's own host take other devices, with
no environment variables and no restart. Two switches, off by default, combine:
**Local network** listens on every interface, **Tailscale** only on the machine's
Tailscale addresses, so the port stays closed on the LAN. Both use a fixed port (7788
unless you change it) and speak TLS only: the self-signed certificate, or one of your
own (**Use Own…**, a certificate and key such as `tailscale cert` writes). Tau reads
that certificate again when its files change, so a renewal needs no restart; **Reload**
does it at once. Tailscale also opens a plain listener on `127.0.0.1:7789` for a proxy
on this machine, such as `tailscale serve`; everything that arrives through it counts
as a remote device, although it comes from 127.0.0.1. The page lists every address a
device may use, labelled LAN, `.local`, Tailscale, MagicDNS or IPv6, and a pairing link
carries all of them. Turning a switch off closes its listener and every connection
that came through it. A host you start by hand opens a proxy listener with
`TAU_HOST_PROXY_LISTEN=127.0.0.1:<port>`. The installed app ships the web client.

While Local network is on, Tau also **announces itself with Bonjour** (`_tau._tcp`; Tau Dev `_tau-dev._tcp`), so
the Tau app on a phone and other machines on the same network find it without a link.
The record carries the host's id, its key and certificate fingerprints and nothing secret; a
device found this way still waits until you allow it with matching digits. Turn off
**Announce on this network** to be found only by link or QR code. **Find Machines…**
lists the Tau hosts nearby; it looks only when you ask. macOS may ask once whether Tau
may use the local network. Linux needs Avahi (`avahi-utils` and a running
`avahi-daemon`); Windows 10 1809 or later uses its own mDNS through PowerShell.

**Tailscale HTTPS**, in the Tailscale section below, has `tailscale serve` answer at
`https://<machine>.<tailnet>.ts.net/` in your tailnet with a certificate every browser
trusts, and forward to that proxy listener; neither switch has to be on. It needs
MagicDNS and HTTPS certificates turned on in the Tailscale admin console, and the section
says so while they are off. Before anything changes Tau asks, and says what it costs:
every certificate is written to the public Certificate Transparency logs, so the
machine's name becomes public for good. Rename the machine first if the name says too
much. Serve keeps forwarding after Tau quits (the address answers with an error then);
turning the switch off removes only Tau's path. On Linux, `tailscale serve` needs root
or an operator: run `sudo tailscale set --operator=$USER` once. Tau never runs
`tailscale funnel`, so nothing is published to the internet.

### What the browser shows

The client is the same workbench: the same transcript, composer, thread list, Pi dialogs
and Agents panel, reading the same stores over the same protocol. What differs is what it
can draw. A browser has no editor and no Electron window, so contributions that need one
are not registered there; Settings → Inspector lists them under "Not on this client",
with the extension, the contribution and the clients it does claim ([ADR 0016](adr/0016-client-profiles.md)).
Their host halves keep running: Workspace Kit still records turn checkpoints for a thread
driven from the browser, and the desktop window shows them.

Below 720 px the workbench lays itself out compactly, on any client: the thread list
becomes a sheet behind a button in the title bar, the composer sticks to the bottom edge,
the dock and the stage step aside, and the start screen becomes the list a supervisor
wants: every thread with what it is doing, in the desktop rail's words ("Working 2:14"
from the host's start of the run, "Question", "Failed", "Ready"), a tap to open it, and a
long press for its actions, Stop the run among them. A Pi confirm is answered in the
composer, the way it is on the desktop.

Without TLS the socket is unencrypted and the page is served over plain HTTP, so the host
refuses to bind anything but a loopback address. To reach it from a phone, start the host
with `TAU_HOST_TLS=1`, or forward the port over SSH or a tunnel you trust;
`TAU_HOST_INSECURE=1` is the deliberate exception.

## The app for iOS and Android

`mobile/` is a native app built with Capacitor around the same compact client. It keeps
several hosts, finds hosts on the local network over Bonjour, and talks to each over a
socket of its own native side (URLSession on iOS, OkHttp on Android) that pins the key of
the host's self-signed certificate, which a web view cannot. The host keeps that key when it
renews the certificate, so a renewal needs no new pairing. The Tailscale Serve address
has a certificate a public CA issued; the link marks it, and the app checks it the way a
browser would instead of pinning. Tokens live in the Keychain or behind a Keystore key.

Add a host by scanning the QR code in Settings → Connections (or pasting its link), or
tap a host listed under "On this network". Either way the host's window asks
"<phone> wants to connect" with six digits; allow it only if the phone shows the same
ones. With a pinned key the digits depend on it, so something between the two that
presents another key cannot make them agree ([ADR 0024](adr/0024-pairing-allowed-on-the-host.md), [ADR 0026](adr/0026-devices-pin-the-hosts-key.md)). The link names every
address of the host, and every connection's hello names the host's current ones, so a
host added over Bonjour becomes reachable over Tailscale too; the app races
them each time it connects (local network first,
then `.local`, then Tailscale), so it follows a phone from home Wi-Fi to cellular on its
own. Coming back to the foreground or to a network makes it check the link at once. More
→ Hosts in the thread list goes back to the host list. `tau://thread?host=<id>&thread=<id>`
opens a thread of a paired host; a tapped push notification uses it ([push.md](push.md)).

Building and running it in a simulator is in [`mobile/README.md`](../mobile/README.md); putting it on your own
iPhone through TestFlight, signed with your Apple Developer account, in
[mobile-testflight.md](mobile-testflight.md).
