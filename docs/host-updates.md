# A machine updates its own Tau

A Tau host updates the app it runs from, with or without a window: a server
running only `tau-host.service` stays current like a laptop with the app open.
Every client shows each machine's version and offers Update now; the
integrator can update a machine from the command line over the connection
that is already authenticated. This page describes the design, the Linux
update helper and the threat model. The user-facing summary is in the
README's *Install* section.

## Who checks, who installs

The host process owns the machine's update state (`src/main/host-updater.ts`).
It runs as Node (Electron's binary with `ELECTRON_RUN_AS_NODE`), so it cannot
use electron-updater, which needs Electron's `app`. It reads the same release
feed electron-builder publishes (`latest-mac.yml`, `latest.yml`,
`latest-linux*.yml`, `src/main/release-feed.ts`) on the channel in
`updates.channel` of the machine's config.

| What runs on the machine | Checks | Downloads and installs |
|---|---|---|
| A Tau window a person sees (packaged) | the window's electron-updater, as before; the host too, for the status | the window: on Restart or on quit, as before. Update now from anywhere asks the window through core's window half (`update-state`, `update-install`) |
| A host without such a window: a service (systemd, launchd, Task Scheduler), a host left running after its window quit, a host whose only window is the invisible display's | the host | the host, at a quiet moment or on request |
| A checkout (`npm start`, a dev instance) | nobody | nobody; the status says `git pull` |

One installer per machine at a time: while a window that can install is
attached on the same machine, the host never installs by itself. A window
started with `TAU_NO_NATIVE_DIALOGS` (a test instance, the invisible
display's window) cannot install, so the host does.

### Timing, as in T3 Code and as asked

- First check 2 minutes after the host starts, then every 6 hours; Check now
  at any time. (T3 Code's desktop checks 15 s after start and every 4 minutes
  and downloads only on a click; the ticket asked for large intervals and
  background downloads.)
- With **Automatic updates** on (the default, per machine, in
  `<userData>/updates/settings.json`), a newer release downloads at once and
  installs once no turn has run for 15 minutes.
- **Update now** downloads if needed and installs as soon as no turn runs.
  While turns run the status is `waiting` with their count; the install
  follows the end of the last one. It never interrupts a turn.
- A failed install is not retried on its own; asking again retries.
- After an install, a service host answers the request and leaves with exit
  code 75 1.5 s later; systemd (`Restart=on-failure`) and launchd
  (`KeepAlive.SuccessfulExit = false`) start it again on the new version. A
  host that is not a service keeps running and the next start runs the new
  version. A window of the new version replaces an older supervised or
  service host as before (ADR 0021).

### Per platform

| Install | How the host installs | Needs |
|---|---|---|
| Linux `.deb` | `pkexec /opt/Tau/bin/tau-update-helper install --version <v> --channel <c>` with the downloaded package on standard input (below) | the helper and its polkit grant, from the `.deb` of this version on; a user in `sudo`, `admin`, `wheel` or `tau-update` |
| Linux AppImage | copies the new AppImage beside the old one, `chmod 755`, renames it over `$APPIMAGE` | write access to that file and its folder |
| macOS | unpacks the release's zip beside the app with `ditto`, checks bundle id and version, and, when the running app is signed, a valid signature by the same team (`codesign`); swaps the bundles, as Squirrel.Mac would after a quit | the user owns the app and its folder |
| Windows | runs the NSIS installer detached, `/S --updated`, then `schtasks /Run` for the host's task | a per-user install (writable folder) |

Where root or an administrator is needed and not granted, the status says so
(`reason`) and the machine's Tau window installs through its own password
dialog on Restart, as before.

## The Linux update helper

`packaging/linux/tau-update-helper` (installed as `/opt/Tau/bin/tau-update-helper`,
root's, 0755) runs `bin/tau-update-helper.mjs` on `/opt/Tau/tau` as Node with
`env -i`, so nothing from the caller's environment reaches it (no
`NODE_OPTIONS`, no `PATH`). Its only form is

```
tau-update-helper install --version <x.y.z[-nightly.YYYYMMDD.N]> [--channel stable|nightly] < package.deb
```

Anything else ends with exit 64. It takes no path and no URL. It:

1. runs only as root;
2. reads the release feed from `/opt/Tau/resources/app-update.yml` (root's,
   written by dpkg), or from `feedUrl` in `/etc/tau/update-helper.json` (root's,
   for a mirror or a test);
3. refuses a version that is not newer than the installed `tau` (exit 66): it
   never goes back, so an old signed release cannot be replayed;
4. fetches that version's `latest-linux*.yml` itself (`releases/download/v<version>/`,
   or `nightly/`) over HTTPS; with release keys in the helper it also fetches
   `latest-linux*.yml.sig` and requires an Ed25519 signature by one of them;
5. reads standard input into a root-only temporary folder, at most the size
   the release names, and compares size and SHA-512 with the release's entry
   for `Tau_<version>_<arch>.deb` (exit 65 otherwise);
6. checks the package's own fields with `dpkg-deb`: `Package: tau`, the
   machine's architecture, and exactly `Version: <version>` (with `~` for `-`);
7. installs it with `apt-get install -y --no-install-recommends`, which
   brings new dependencies (exit 70 when that fails).

The `.deb` installs the polkit action `de.tbuck.tau.update`
(`/usr/share/polkit-1/actions/de.tbuck.tau.update.policy`, exec path the
helper, default `auth_admin_keep`) and grants it without a password to the
groups `sudo`, `admin`, `wheel` and `tau-update`, for any session including
none: a `.rules` file for polkit 0.106 and later
(`/usr/share/polkit-1/rules.d/50-tau-update.rules`) and a `.pkla` for 0.105
(`/var/lib/polkit-1/localauthority/10-vendor.d/50-tau-update.pkla`, Ubuntu
22.04, Debian 11). `after-install.tpl` writes them, `after-remove.tpl`
removes them on a real removal. An administrator who wants the grant for a
user outside those groups adds the user to a group `tau-update`.

The host asks `pkcheck --action-id de.tbuck.tau.update --process <pid>`
before it downloads; when polkit would ask for a password (a user outside the
groups, or a `.deb` from before the helper) the status says so and nothing is
downloaded.

`scripts/packaging/update-helper-container.sh` checks all of it in a
throwaway container: it builds stand-in `tau` packages (with the real helper,
wrapper, polkit files and maintainer scripts; `/opt/Tau/tau` is Node there),
serves a feed on loopback, and installs, refuses and removes as a user in
`sudo` without a session and as one outside it. It passed on Debian 12
(polkit 122), Ubuntu 24.04 (124) and Ubuntu 22.04 (0.105).

## Release signing

Today a release carries no signature of its own: the checksums in
`latest*.yml` are trusted as far as HTTPS to the project's own release URL is
(the same trust electron-updater has). `src/shared/release-keys.ts` and
`bin/tau-update-helper.mjs` hold the list of release keys (empty now; a test
keeps both lists equal). Once a key is listed, both the host and the helper
refuse a feed without a valid `.sig`.

What the release workflow needs for that (not done here):

1. An Ed25519 key pair made once, offline:
   `node -e "const {generateKeyPairSync}=require('crypto');const k=generateKeyPairSync('ed25519');console.log(k.privateKey.export({type:'pkcs8',format:'pem'}));console.log(k.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64'))"`.
   The private key goes into a repository secret, say `TAU_RELEASE_SIGNING_KEY`;
   the raw public key (base64) into both lists above, in a release before the
   first signed one.
2. In the `release` and `nightly` jobs, after the artifacts are downloaded and
   before they are published: for each `artifacts/latest*.yml`, write
   `<file>.sig` = base64 of `crypto.sign(null, <file bytes>, privateKey)` and
   publish it with the rest. The bytes signed are exactly the published file.
3. A second key can be listed beside the first before the first is retired.

## Protocol

| Method | Access | Params | Result |
|---|---|---|---|
| `update-status` | read | – | `HostUpdateStatus` |
| `update-check` | read | – | `HostUpdateStatus` after asking the feed (downloads at once when automatic) |
| `update-install` | write | – | `HostUpdateStatus`; refused (`forbidden`) to a paired device while the owner turned *Paired devices may update this machine* off |
| `update-settings` | write | `{ automatic?, devicesMayInstall? }` | `HostUpdateStatus`; `devicesMayInstall` only with the host token on this machine |
| `environments-update` | write (window) | machine, `status` \| `check` \| `install` \| `{ automatic }` | the machine's `HostUpdateStatus`, over the window's own connection there |
| `machines-update` | owner | machine, `status` \| `check` \| `install` | `{ id, name, update }`, through the window on this machine |

Push event `{ type: "update-status", status }` at every change.
`HostUpdateStatus` (`src/shared/host-updates.ts`): `version`, `phase`
(`unsupported`, `idle`, `checking`, `current`, `available`, `downloading`,
`ready`, `waiting`, `installing`, `installed`, `failed`), `latest?`,
`channel`, `automatic`, `installer` (`host`, `window`, `none`), `method?`
(`deb`, `appimage`, `mac`, `windows`), `reason?`, `progress?`,
`runningTurns?`, `checkedAt?`, `devicesMayInstall`. Core's window half answers
`update-state` (`{ installs, downloaded? }`) and `update-install`
(`{ started, reason? }`) to its own machine's host.

Old and new: a client ignores an event type it does not know, and an older
host answers `update-status` with an unknown-method error; the About page then
keeps the window's own check, the Machines page says the machine must be
updated there once, and a machine is still marked behind when its version is
older than the window's.

## Threat model

What an attacker could want: code of their choosing run as root, or as the
user, through the update path; an older vulnerable Tau; a restart at a bad
moment.

- **A local process of the user** (malware, a compromised tool) can already
  do anything the user can. Through the helper it gains nothing: the helper
  installs only a newer `tau` package whose size and SHA-512 match the release
  it fetched itself from the feed root owns (and, with keys, whose feed is
  signed). It cannot name a file, a URL, a package or an older version, and
  `env -i` keeps its environment out. At worst it installs the next genuine
  release early.
- **A local user outside the admin groups** is refused by polkit (checked in
  the container).
- **The network** sees only HTTPS to GitHub. Without release keys, whoever can
  serve files as the project's GitHub release (or break that TLS) can ship an
  update, as with electron-updater today; release signing (above) removes
  that. A mirror in `/etc/tau/update-helper.json` is an administrator's
  choice and should be used with release keys.
- **A paired device** reaches `update-install` only over its authenticated
  connection (its token, TLS with a pinned key off loopback) and only with
  Full access, which the owner granted at pairing. A Full-access device can
  already run shell commands through a thread as the user, which is more
  than installing a genuine newer Tau; the owner can still turn device
  installs off per machine (`devicesMayInstall`, host token only). Read-only
  devices are refused. Every install a device starts is in the machine's
  Connections audit ("started a Tau update").
- **Availability**: an install never starts while a turn runs; automatic
  installs wait for 15 quiet minutes; a failed install is not repeated on its
  own. A restart drops open terminals of Terminal Kit (their shells end with
  the host).
- **macOS and Windows** run no privileged helper. On macOS a signed Tau
  accepts only the same team's valid signature; an unsigned build (today's)
  relies on the checksum. On Windows the NSIS installer runs as the user.
