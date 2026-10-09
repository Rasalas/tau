# A machine updates its own Tau

A Tau host updates the app it runs from, with or without a window: a server
running only `tau-host.service` stays current like a laptop with the app open.
Every client shows each machine's version and offers Update now; the
integrator can update a machine from the command line over the connection
that is already authenticated. This page describes the design, the Linux
update helper and the threat model. The user-facing summary is in
[Install and run](install.md#updates).

## Who checks, who installs

The host process owns the machine's update state (`src/main/host-updater.ts`).
It runs as Node (Electron's binary with `ELECTRON_RUN_AS_NODE`), so it cannot
use electron-updater, which needs Electron's `app`. It reads the same release
feed electron-builder publishes (`latest-mac.yml`, `latest.yml`,
`latest-linux*.yml`, `src/main/release-feed.ts`) on the channel in
`updates.channel` of the machine's config, from the repository the app's
`resources/app-update.yml` names, the public `Rasalas/tau-releases`
([RELEASE.md](RELEASE.md#where-releases-are-published)). Nothing needs a token.

Stable reads only the stable feed. Nightly compares the stable and nightly
feeds and takes the higher trusted version, retaining the Nightly preference
after a stable update. The selected release's source controls the download
URL and the channel passed to the Linux update helper; it does not change
`updates.channel`. A local test feed replaces both sources.

| What runs on the machine | Checks | Downloads and installs |
|---|---|---|
| A Tau window a person sees (packaged) | the window's electron-updater, as before; the host too, for the status | the window: on Restart or on quit, as before. Update now from anywhere asks the window through core's window half (`update-state`, `update-install`) |
| A host without such a window: a service (systemd, launchd, Task Scheduler), a host left running after its window quit, a host whose only window is the invisible display's | the host | the host, at a quiet moment or on request |
| A checkout (`npm start`, a dev instance) | nobody | nobody; the status says `git pull` |

One installer per machine at a time: while a window that can install is
attached on the same machine, the host never installs by itself. A window
started with `TAU_NO_NATIVE_DIALOGS` (a test instance, the invisible
display's window) cannot install, so the host does.

### Timing

- First check 2 minutes after the host starts, then every 6 hours; Check now
  at any time. Long intervals keep the checks quiet, and downloads run in the
  background so an update needs no click.
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
4. fetches that version's `latest-linux*.yml` itself from the repository
   `app-update.yml` names (`releases/download/v<version>/`, or `nightly/`) over HTTPS, and `latest-linux*.yml.sig` beside it; the feed
   needs an Ed25519 signature by one of the helper's release keys (below);
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

Every release signs its update feeds. For each `latest*.yml` it publishes
`latest*.yml.sig`: one base64 Ed25519 signature per line over the file's
exact bytes. `src/shared/release-keys.ts` and `bin/tau-update-helper.mjs` list
the public keys (raw, base64; a test keeps both lists equal). The host and the
helper fetch the `.sig` beside the feed and refuse the feed unless a line
verifies against a listed key; nothing is downloaded before that. An update
is checked against the keys of the Tau already installed, so a new key has to
ship before anything is signed with it alone.

The same key signs Tau's model catalog (`catalog/models.json`, published by
the Pages workflow as `catalog/models.json` and `.sig`, see
[Runtimes](runtimes.md#models-pi-does-not-know-yet)); a host takes a catalog
only with a line that verifies, so a rotation covers it too.

The first key (`8hB4AtWu…Smg=`) ships in 0.7.14 together with the host
updater and the helper, and 0.7.14 is the first signed release.

`scripts/packaging/release-signing.mjs` handles both sides:

```bash
# sign: every PEM private key in the variable signs; writes <file>.sig
TAU_RELEASE_SIGNING_KEY="$(cat key.pem)" node scripts/packaging/release-signing.mjs sign release/latest*.yml
# check: against the keys this checkout ships, as an installed Tau would
node scripts/packaging/release-signing.mjs check release/latest*.yml
# verify: against one key (raw base64, PEM, or a file holding either)
node scripts/packaging/release-signing.mjs verify latest.yml latest.yml.sig <public key>
# keygen: a new pair; writes the private key (0600) and prints the public one
node scripts/packaging/release-signing.mjs keygen new-release-key.pem
```

`sign` refuses a file with a byte order mark or invalid UTF-8, because the
host verifies the text it decoded, not the raw bytes.

In `.github/workflows/release.yml` each build job uploads its feed as
`feed-<platform>`; the two Mac builds each write a `latest-mac.yml` for their
own architecture, which the `sign` job merges into one first
(`scripts/packaging/merge-feeds.mjs`). It then signs `latest-mac.yml`, `latest.yml` and
`latest-linux.yml` with the secret `TAU_RELEASE_SIGNING_KEY` (the private key,
PKCS#8 PEM) from the environment `release`, runs `check`, and uploads the feeds with their `.sig` files as
`tau-feeds`. `release` and `nightly` run `check` once more on what they
downloaded, check that every feed has its `.sig` (`publish-release.mjs check`),
and publish the feeds and `.sig` files with the rest, to `Rasalas/tau` and to
`Rasalas/tau-releases`. A publishing run
without the secret fails in `preflight`, before anything is built. A dry run on
a branch has no secrets and only warns (see [RELEASE.md](RELEASE.md#build-all-platforms-without-publishing)).

A local test feed (`TAU_UPDATE_FEED_URL`) is signed with a throwaway key that
the host trusts through `TAU_UPDATE_FEED_KEY`. The variable counts only
together with the feed URL, and then the release keys do not count.
`npm run smoke:host-update` works this way. The container test
(`scripts/packaging/update-helper-container.sh`) puts its throwaway key into
the stand-in packages' helper.

### Rotating the key

The `.sig` holds one line per signing key, so during a rotation a release
can be signed with the old key and the new one:

1. `keygen` a new pair offline. Add the new public key next to the old one in
   both lists, and add the new private key to the secret after the old one
   (both PEM blocks in one value). Release N ships with both keys, signed by
   both.
2. Keep signing with both for as long as hosts from before N may still be
   running. A host that skips releases and jumps from N-1 to N+2 then still
   finds the old key's line.
3. One release later (N+1) at the earliest, remove the old public key from
   both lists and the old private key from the secret.

A leaked key goes out of both lists and the secret at once. Hosts that list
only that key cannot take the next update by themselves; update them once by
hand (`tau update` there, or the `.deb`/installer), and they trust the new key
from then on.

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
  it fetched itself from the feed root owns and whose feed carries the
  release key's signature. It cannot name a file, a URL, a package or an older version, and
  `env -i` keeps its environment out. At worst it installs the next genuine
  release early.
- **A local user outside the admin groups** is refused by polkit (checked in
  the container).
- **The network** sees only HTTPS to GitHub. Whoever can serve files as the
  project's GitHub release (or break that TLS) still cannot ship an update
  to a host or the helper without the release key (above). That includes
  whoever holds the key of the GitHub App that publishes to
  `Rasalas/tau-releases`. It can upload files there, but not sign them. A mirror in
  `/etc/tau/update-helper.json` has to serve the `.sig` files too. The
  window's own updater (electron-updater) and its AppImage-to-`.deb` offer
  (`appimage-install.ts`) do not read the `.sig`; they trust the checksum
  from HTTPS, and on macOS the code signature.
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
