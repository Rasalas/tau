# Updates and machines

## How Tau updates

You install Tau once. After that it keeps itself current, with or without a window open.

- Two minutes after it starts, and every six hours after that, Tau looks for a newer release.
- It downloads the release in the background and checks it against the release's SHA-512 checksum.
- It installs once no agent has run for a quarter of an hour, and never while one is working. With a window open, it waits until you choose **Restart** or quit.

Settings → About shows the version of the machine you're connected to, whether an update is waiting, **Update now**, **Copy diagnostics** for a bug report, and switches for **Automatic updates** and **Pre-release builds** (the nightly build instead of stable releases).

Each kind of install updates in its own way:

- **Mac:** Tau replaces itself in Applications.
- **Windows:** the installer runs silently for your user.
- **Debian and Ubuntu (`.deb`):** a small helper installs the new package. Members of `sudo`, `admin` or `wheel` need no password, also on a server without a desktop.
- **AppImage:** replaces its own file.

From a terminal, `tau update` does the same (`--check` only looks, `--status` tells where it stands). The design and the threat model are in [Host updates](../host-updates.md).

## Another computer

Pair a second Mac or a Linux box with the window you already use. Its threads show up in your list, and a new thread can start there.

**With a link.** On the other machine, open Settings → Connections, turn on network access and create a pairing link. On this one, open Settings → Machines and paste the link, type the other machine's address, or click **Find machines** to list the ones on your network. The other machine asks whether to let this computer in and shows six digits; allow it if this window shows the same six.

**Over SSH.** If you can already `ssh` to the machine, one command pairs the two:

```bash
tau machines add --ssh studio --agents
```

Tau must run on both machines. `--agents` also lets this computer's agents start work there.

Once paired:

- **Run on** under a new thread's heading picks the machine. **Automatic** picks the one with the most room when you send.
- A thread's title menu → **Continue in…** → **On another machine** hands a running thread over, with its history or a summary of it.
- Work from another machine comes back as a branch. Nothing is pushed to your Git remote on the way; the project travels over Tau's own encrypted connection.
- Settings → Machines shows every machine's cores, memory, running turns and runtimes, and updates them.

## A host without a window

On a server, or on a Mac you want to reach while no Tau window is open, Tau runs as a service: threads, terminals and paired devices keep going with no window open and after a restart.

```bash
tau service install     # install and start
tau service status      # where it stands, and its log
tau service uninstall   # stop and remove
```

Settings → Connections → Background does the same. On macOS it is a LaunchAgent, on Linux a systemd user unit, on Windows a Task Scheduler task. On Linux, `tau service install --display` adds an invisible display, so an agent's browser and GUI apps run where nobody sees them.

[Hosts, machines and devices](../hosts.md) has the details: the service, a host over a socket or TLS, work on other machines, the web client and the phone app.
