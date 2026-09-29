# Releasing Tau

Tau ships as an installable app built by [electron-builder](https://electron.build).
`tooling/electron-builder.yml` is the whole configuration, so every call passes
`-c tooling/electron-builder.yml` (the `dist` scripts do); `package.json` holds the
version, and the version in an installed app is what the updater compares
against the release feed.

## Two artifacts, one tag

A release carries two versioned things: the **core app** and **`@tau/kits`**,
the distribution of bundled kits it ships ([ADR 0014](adr/0014-bundled-kits-are-packages.md)).

| | version in | raise it when |
|---|---|---|
| core app | `package.json` | anything under `src/`, the host protocol or a dependency changed |
| `@tau/kits` | `kits/package.json` | a kit was added, removed, or changed enough that a user would notice |

They move independently and are shipped together: `npm run build` compiles
`kits/` into `dist-kits/`, one tag builds the installer around both, and an
installed Tau always runs the exact set its core release was built with. There
is no separate kits download today, so a kits-only change still needs a core
tag to reach anyone.

The order between them is fixed by `engines.api`. Core owns
`EXTENSION_API_VERSION` (`src/shared/extension-compat.ts`) and is the only side
that raises it; the kits declare the line they build against, in
`kits/package.json` and in every `tau-extension.json`. A kit that asks for API
this core does not have stays off on both sides with the reason in Settings →
Inspector, so API always lands in a core release first and the kits that use it
follow. `src/shared/kits-boundary.test.ts` fails when the two drift apart.

[ADR 0015](adr/0015-core-and-distribution.md) records what changes if the
distribution ever moves to its own repository — what each side would pin, and
the release order that keeps a wrong pairing from shipping.

## Cut a release

1. Land everything the release should contain on `main`.
2. Raise `version` in `package.json` and commit it. Raise the one in
   `kits/package.json` too when the shipped kits changed (above). `npm run
   build` writes it into `dist-kits/manifest.json`, and Settings → Packages
   heads the bundled list with it, which is the quickest check that the
   artifact carries the version you meant.
3. Tag the commit and push the tag:

   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```

`.github/workflows/release.yml` runs on any `v*.*.*` tag. It builds on
GitHub-hosted runners with `--publish never`: macOS arm64 and macOS x64 on a
`macos-26` runner each, signed and notarized side by side, Linux x64
(`ubuntu-24.04`), Windows x64 (`windows-2025`), and the phone apps ([Phone
apps](#phone-apps)). A `sign` job merges the two Mac builds' `latest-mac.yml`
into one and signs each platform's `latest*.yml`
with the secret `TAU_RELEASE_SIGNING_KEY` ([Update feeds](#update-feeds)), then
one job publishes every artifact, the Android APK, the `.sig` files and `LICENSE` twice. One
copy is a GitHub Release named after the tag in `Rasalas/tau`, the other the
same release in `Rasalas/tau-releases`, where installed apps look, together
with the [fixed download names](#fixed-download-names)
([Where releases are published](#where-releases-are-published)). Without the
signing secret, the publishing app's secrets or the phone apps' keys the run
fails in `preflight`, before it builds. Every secret lives in the environment
`release` ([Runners and environments](#runners-and-environments)).

The tag drives nothing but the release name. If it does not match
`package.json`, the artifacts carry the version from `package.json` and the
updater will compare against that one. Keep them equal.

4. Once the release is published, update the package managers
   ([Package managers](#package-managers)).

### How long a release takes

About a quarter of an hour from the tag to the published release; 0.7.14 took
35 minutes, 9 of them in `verify` and 23 in one Mac job that built and notarized
both apps one after the other.

| Job | When | About |
|---|---|---|
| `gate`, `preflight` | first | 1 min |
| `verify` | only when CI has not passed on the commit, beside the builds | 9 min |
| macOS arm64, macOS x64 | side by side | 12 min each, most of it Apple's notarization |
| Windows, Linux | side by side | 8 and 5 min |
| `android` | side by side | 8 min |
| `sign`, `release` | after the builds | 3 min |
| `ios` | beside the rest; the release does not wait for it | 15 min, then TestFlight's processing |
| `play` | after `release` | 1 min |

The Mac, Windows, Linux and `verify` times are those of 0.7.14; the rest are
estimates until a release has run them.

**`verify` is skipped when CI already passed on the commit.** The gate asks the
API for the runs of `ci.yml` and `performance.yml` on exactly the tagged commit
(`scripts/packaging/verified-commit.mjs`, with `actions: read`). Only a
successful `push` or `workflow_dispatch` run counts; a pull request's run
tested a merge commit, not this one. CI runs everything `verify` does and
more, so a second pass would only repeat it. The usual order gets the skip:
land on `main`, wait until CI and the performance gates are green, then tag.

When they have not passed (still running because main and the tag went up
together, red, or missing), `verify` runs as it always did: lint, typecheck
and the whole suite. It runs beside the builds, not before them, and `sign`
and `ios` wait for it, so nothing is signed, published or uploaded from a
commit that failed; only the build minutes are spent. An API error counts as
not passed.

## Build all platforms without publishing

`workflow_dispatch` runs the same build jobs on a branch, with no tag
and no release. Use it to prove all three platforms still build, which no
ordinary pull request or push to `main` does, before cutting a real release:

```bash
gh workflow run release.yml --ref my-branch -f publish=false
gh run watch                # or: gh run view --log-failed
gh run download --dir /tmp/artifacts
```

The `release` job stays skipped unless the ref is a tag starting with `v` or
`publish` is `true`, so a dispatch with `publish=false` cannot attach anything
to a GitHub Release in either repository, and never asks for a token for
`Rasalas/tau-releases`; the `tau-*` artifacts (the installers, the Android APK,
and `tau-feeds` with the merged `latest*.yml`) land as workflow run artifacts
instead, good for a day. The phone apps build too: `android` makes the App
Bundle (artifact `play-bundle`) and the APK, `ios` archives. Neither uploads to
a store; `play` runs only after a published release, and `ios` uploads only
for a tag or `publish`. The `push` trigger above only
ever delivers `v*.*.*` tags; the `v`-prefix check on `release` is what keeps a
`workflow_dispatch` run against some other tag from also publishing.

A dry run on a branch runs in the environment `release-dry-run`, which holds
no secrets: the Mac apps come out unsigned, the `sign` job warns and leaves
the feeds unsigned, the APK is named `Tau-<version>-unsigned.apk`, and the iOS
app is archived without signing. A dry run dispatched on `main` runs in
`release` like a real one: the Mac apps are signed and notarized, `sign` signs
the three feeds, checks them against the keys the commit ships, and uploads
them with their signatures as `tau-feeds`, the APK and App Bundle are signed
with the upload key, and the iOS archive is signed through the App Store
Connect key, so it also shows that the secrets are right. A missing
`latest*.yml` fails the job either way.

A build job that fails uploads a `diagnostics-<platform>` artifact
alongside it — `release/builder-debug.yml` (electron-builder's own verbose
log, enabled for every Package step via `DEBUG=electron-builder`) plus
whatever npm wrote under its cache's `_logs/`. The name keeps it out of the
`tau-*` pattern the release jobs publish. On a public repository anyone can
download it, so look at one before trusting that it holds no secret.

## Install a release on this Mac

```bash
npm run install:mac                    # the latest release
npm run install:mac -- --version v0.1.1
npm run install:mac -- --open          # and launch it
npm run install:mac -- --local         # build this checkout instead
```

`scripts/install-mac.mjs` reads the release's `latest-mac.yml` from the
public `Rasalas/tau-releases` over HTTPS, without a login, and refuses it
without Tau's release signature (`latest-mac.yml.sig`). It downloads the
`.dmg` for this machine's architecture and keeps it only when it matches the
SHA-512 the feed lists. A tag released before `tau-releases` existed (0.7.13
and older) falls back to `gh` and `Rasalas/tau-private`, which it must be able
to read (`gh auth status`). It then quits a running Tau, replaces
`/Applications/Tau.app`, and removes the `com.apple.quarantine` attribute — the mark Gatekeeper uses to
block an unsigned download, which is why an unsigned Tau otherwise needs
right-click → Open on first launch.

## Build one locally

```bash
npm run dist          # this machine's platform and architecture
npm run dist:mac      # or :linux, :win
```

Each runs `npm run build` first and writes to `release/`, which is not in Git.
Stop a running `npm run dev:instance` of the same worktree first: while it
runs, its `.tau-dev/userdata` holds dangling `Singleton*` symlinks and
electron-builder aborts on the first one it cannot `stat`.
`npm run dist:mac -- --arm64 --x64` builds both Mac apps, which the release builds on two runners.
macOS produces a `.dmg` and a `.zip`, Linux an `.AppImage` and a `.deb`,
Windows an NSIS `.exe`. Cross-building macOS from another platform is not possible; Linux and
Windows builds need their own runners for the same reason Tau ships a native
esbuild binary.

### Two Mac architectures from one `node_modules`

The arm64 runner's `npm ci` installs the optional platform packages for arm64
only: esbuild's binary, rollup's and xa11y's. Before each Mac architecture is
packed, electron-builder's `beforeBuild` hook
(`scripts/packaging/mac-architectures.mjs`) unpacks the ones npm skipped, at
the version and integrity `package-lock.json` pins, fetched through `npm pack`.
`files` in `tooling/electron-builder.yml` then drops the other architecture's platform
packages and every `prebuilds/<platform>-<arch>` folder that is not the app's
own, and the `afterPack` hook fails the build when a Mach-O file in the app
cannot run on its architecture. The x64 app therefore holds only x64 or
universal native files, and the arm64 app only arm64 or universal ones.

On Apple silicon the x64 app runs only under Rosetta, and macOS 27 warns on
launch that macOS 28 will not open it. The x64 build is for Intel Macs, which
stop at macOS 27.

## App icons

The artwork is SVG in `assets/icon/`, and every other icon file is derived from
it by one script:

```bash
node scripts/icons/generate.mjs
```

| source | what it is |
|---|---|
| `icon-light.svg`, `icon-dark.svg` | the macOS grid: an 824 squircle in 1024, the τ at its optical centre |
| `square-light.svg`, `square-dark.svg` | full bleed; iOS and the Android launcher cut their own shape |
| `android-foreground.svg` | the τ inside the adaptive icon's 66 dp safe circle |
| `mark-light.svg`, `mark-dark.svg` | the 32-unit mark: favicon, small Windows sizes, the Tau repo's own project icon (the root `t3.json`) |
| `tau-glyph.svg` | the bare τ in `currentColor` (reload curtain) |

The script writes:

- **Desktop:** `assets/tau-icon.png` (checkout window and dock icon, Linux),
  `assets/icon/tau.ico` (Windows: the mark at 16–32 px, the grid icon at
  48–256), and `assets/icon/Tau.icon`, the Icon Composer document `mac.icon`
  points at. electron-builder compiles it with `actool` into `Assets.car` (the
  light, dark, tinted and clear icons of macOS 26+) and `icon.icns` for older
  systems, so **a Mac build needs Xcode 26 or newer**. Without it, point
  `mac.icon` at `assets/tau-icon.png`: macOS 27 shows that as it is, only without
  the dark and tinted appearances.
- **Android:** vector drawables for the adaptive icon's background, foreground
  and Android 13 monochrome layer; `ic_launcher.png` and `ic_launcher_round.png`
  for launchers before Android 8; `splash.png` for light and night.
- **iOS:** the 1024 app icon for the default, dark and tinted appearances, and
  the launch image for light and dark, all without an alpha channel.
- **Web:** `src/web/public/` (favicon, touch icon, manifest icons,
  `manifest.webmanifest`), which the browser client and the phone app's web
  layer both copy to their root.

It needs `rsvg-convert` (`brew install librsvg`, `apt install librsvg2-bin`) and
nothing from npm. The outputs are committed and CI never runs the script, so the
tool is only needed on the machine that changes the artwork. Edit the SVGs, run
the script, commit both. `scripts/icons/icon-files.test.mjs` fails when a
committed text output (vectors, `Tau.icon`, asset catalogs, manifest) no longer
matches the SVGs.

## How an update reaches a user

`publish:` in `tooling/electron-builder.yml` names the GitHub repository,
`Rasalas/tau-releases`, and electron-builder writes it into
`resources/app-update.yml` inside the app. The window's updater, the host's,
the AppImage's `.deb` offer, the release notes and the `.deb`'s update helper
all read it from there (`scripts/packaging/public-feed.test.mjs` follows it
through each). From there:

1. An installed Tau asks that repository for a newer release a few seconds
   after it starts and then every hour, on the update track the config holds at
   that moment, and downloads one in the background. It stops asking while a
   downloaded version waits for a restart. A Tau running from a checkout never
   checks (`src/main/app-updates.ts`).
2. When the download finishes the window's process publishes an `app-update`
   event and the workbench offers a toast: *Tau 0.2.0 downloaded, restart to
   install*, with a Restart button that quits into the new version. A page that
   loads later asks for it (`window-action` `status`).
3. A user who ignores the toast gets the update the next time they quit Tau,
   except with the `.deb`, whose update waits for the Restart (below).
4. "Check for Updates…" in the application menu (and Check now on Settings →
   About) asks on demand and reports what it found.
5. The first start of the new version shows its release notes once: a toast,
   *Tau 0.3.0 is installed*, whose What's new opens the list; it goes after
   eight seconds unread or at the next click elsewhere
   (`src/main/release-notes.ts`, state in `<userData>/release-notes.json`). The
   notes are the ones the download brought, else the release of that
   version in `Rasalas/tau-releases`, read through the public API (the moving `nightly` tag for a
   nightly). A dev instance reads `TAU_RELEASE_NOTES_FILE` instead and fetches
   nothing; set `lastVersion` in that file to an older version to see them.

electron-updater reads the `latest-mac.yml`, `latest-linux.yml` and
`latest.yml` files the release carries. `latest-linux.yml` lists the AppImage
and the `.deb`; which one a Linux Tau takes is decided in `linuxInstall`
(`src/main/app-updates.ts`): `APPIMAGE` in the environment means the AppImage,
`/opt/Tau/tau` with `resources/package-type` = `deb` means the package, which
electron-updater's `DebUpdater` installs by running
`pkexec … dpkg -i <file> || apt-get install -f -y` (synchronously, in the
window's process) and relaunching. electron-builder writes `package-type` into
the folder both Linux targets are packed from, so an AppImage may carry it
too; Tau does not trust it alone. Anything else is a copy unpacked by hand,
which cannot replace itself and says so. The `.deb` installs on Restart only
(`installOnQuit: false`), so the password dialog never surprises a quit; with
no polkit agent (no desktop session) pkexec fails and the update waits. The
release workflow's Linux job checks the package after building it (Xvfb in
`Recommends`, the AppArmor profile and `bin/tau` inside, the feed naming it).

An AppImage that runs without Chromium's sandbox offers the `.deb` instead
(`src/main/appimage-install.ts`, before the host and the window start): when
`APPIMAGE` is set, `--no-sandbox` is on the command line (electron-builder's
`AppRun` adds it when `unshare -Ur true` fails), `unshare -Ur true` fails for
Tau too, and `dpkg` and `apt-get` exist. It reads `latest-linux.yml` of its own
release (`releases/download/v<version>/`, or `nightly/`), downloads the `.deb`
into `<userData>/package-install/` and keeps it only when size and SHA-512
match. One `pkexec` call copies it where the user cannot change it, checks the
SHA-512 again as root and runs `apt-get install -y` on it, which brings the
`Depends` and `Recommends`. Tau then exits, and a detached shell starts
`/opt/Tau/tau` once the old process is gone, with AppRun's variables and
`--no-sandbox` removed; the installed Tau offers to delete the AppImage. A
package already installed at least as new skips the download. "Later" is kept
per version in `<userData>/package-install/state.json`. Where pkexec has no
polkit agent, Tau shows `sudo apt install <the downloaded .deb>`.
`TAU_INSTALL_FEED_URL` points the offer at a local feed for tests.

The `.deb`'s maintainer scripts are electron-builder's templates with two
changes (`packaging/linux/`): `/usr/bin/tau` links to `/opt/Tau/bin/tau`, a
wrapper that runs `tau app`/`tau service` on Tau's binary as Node and starts
the app for anything else, and the AppArmor profile is written wherever
`apparmor_parser` exists (loaded only where AppArmor runs and not in a chroot),
so an image prepared in a container gets it too. An upgrade keeps both in place
instead of removing and re-adding them. A release published without them
installs fine and then never updates, which is why the workflow uploads
`release/latest*.yml` and fails when a matrix job produced no files.

Both macOS architectures build on one runner on purpose: each would otherwise
write its own `latest-mac.yml` and the second job to finish would leave the
other architecture without a feed.

### A host without a window

The steps above are the window's. A machine that runs only its host (a
server with `tau-host.service`) updates through the host process itself
(`src/main/host-updater.ts`): it reads the same `latest*.yml`, downloads and
verifies the file its install takes, and installs it when no turn runs; the
`.deb` does so through a root helper that polkit allows without a password.
Settings → About and Settings → Machines show each machine's version and
offer Update now; `tau update` and `tau machines update` do the same from a
terminal. [host-updates.md](host-updates.md) describes it, the helper, the
threat model and the release signature (`latest*.yml.sig`, Ed25519) that
both require. The Linux job's check of the `.deb` looks for the helper, the
script it runs and the three polkit files, and checks that `postinst`
installs the polkit action.

A Tau built before the move to `Rasalas/tau-releases` (0.7.13 and older)
still names `Rasalas/tau`. While that repository was private its checks failed
with a 404 (visible in `<userData>/logs/host.log` as `update.failed`, and in
the host's `host-process.log` as `host-update.check.failed`). Since the source
went public, `Rasalas/tau` answers again and carries each release from 0.7.14
on with its feeds, so such an install finds the next release there; a Mac app that was not
signed still has to be replaced by hand once, because Squirrel.Mac installs
only an update signed like the running app.

## Where releases are published

Installed apps read releases from `Rasalas/tau-releases`, a public repository
that holds nothing but releases; `publish:` in `tooling/electron-builder.yml` writes
its name into every app. It was created while the source was private, and it
stays the one place installed apps look, so the source repository can move
or be renamed without breaking an update. Every release and every nightly
goes to both repositories:

| | `Rasalas/tau` | `Rasalas/tau-releases` |
|---|---|---|
| what | tag on the built commit, notes GitHub generates from the pull requests, every file | the same files and the same notes, plus the [fixed download names](#fixed-download-names) of a stable release; the tag sits on the repository's default branch, which holds only a README |
| who reads it | people reading the source, builds of 0.7.13 and older | installed apps (window, host, Linux helper), `install:mac`, the package managers, the website |
| written with | the workflow's `GITHUB_TOKEN` | a token from the GitHub App *Tau Releases (Rasalas)*, installed on this repository only with `contents: write` |

Files in both: the installers (`.dmg`, `.zip`, `.AppImage`, `.deb`, `.exe`),
the Android APK (`Tau-<version>.apk`), their `.blockmap` files, `latest-mac.yml`, `latest.yml`, `latest-linux.yml`,
their `.sig` files, and `LICENSE`, which the AUR package installs. Releases
before 0.7.14 exist only in `Rasalas/tau-private`, the repository the source
lived in before it went public; `install:mac --version` falls back to `gh`
there for them.

The `release` job in `.github/workflows/release.yml`:

1. downloads the build artifacts and `tau-feeds` (the merged feeds with their
   signatures), and adds `LICENSE`;
2. checks every feed's signature (`release-signing.mjs check`) and that the
   folder is complete: every feed with its `.sig`, every file a feed names, a
   blockmap for each `.dmg`, `.zip` and `.exe`, and `LICENSE`
   (`scripts/packaging/publish-release.mjs check`);
3. publishes the release in `Rasalas/tau` with generated notes;
4. reads that release's notes back, since GitHub would write them for
   `tau-releases` from a history it does not have;
5. copies the installers to their fixed names and checks the folder again
   with `--stable` (`publish-release.mjs copy-stable`, then `check --stable`);
6. asks `actions/create-github-app-token` (pinned to a commit) for a token
   limited to `Rasalas/tau-releases` and `contents: write`, from the secrets
   `TAU_RELEASES_APP_ID` (the app's ID) and `TAU_RELEASES_APP_KEY` (its private
   key, PEM);
7. uploads everything to a **draft** release under the same tag in
   `Rasalas/tau-releases`, with those notes;
8. publishes the draft as the latest release only when every file is uploaded
   (`publishDraft`). Until then, installed apps keep seeing the previous
   release instead of a feed that names files not yet there.

A failed run can be re-run. The action reuses the release of the tag in
either repository, keeps a published one published, and replaces files of the
same name.

### Fixed download names

The website and the README link the newest stable installer as
`https://github.com/Rasalas/tau-releases/releases/latest/download/<name>`,
which needs a name without a version. Every stable release in
`tau-releases` carries a copy of each installer under one:

| File in the release | Fixed name |
|---|---|
| `Tau-<version>-arm64.dmg` | `Tau-mac-arm64.dmg` |
| `Tau-<version>.dmg` | `Tau-mac-x64.dmg` |
| `Tau-Setup-<version>.exe` | `Tau-windows-x64.exe` |
| `Tau_<version>_amd64.deb` | `Tau-linux-amd64.deb` |
| `Tau-<version>.AppImage` | `Tau-linux-x86_64.AppImage` |
| `Tau-<version>.apk` | `Tau-android.apk` |

`STABLE_NAMES` in `scripts/packaging/publish-release.mjs` is the list.
`check --stable` fails when a copy or the versioned file behind it is missing
(a stable release without its APK, say), or a copy's size differs from its
source, and a plain `check` fails when a nightly carries one. The feeds keep
the versioned names, so updates and the package managers are unaffected. A
nightly has none: `latest/download` never points at a prerelease.

The `nightly` job does the same under the tag `nightly` (below), with the
previous nightly removed from each repository first. The `preflight` job fails a
publishing run before it builds when the app's secrets are missing.

The GitHub App's key can upload to `Rasalas/tau-releases`, but it cannot
make an installed Tau accept an update, because hosts and the Linux helper
require the release signature ([host-updates.md](host-updates.md#release-signing)).
Rotate it in the app's settings (Generate a private key, replace the secret,
delete the old key).

### Stable and nightly

Settings → General → **Update track** writes `updates.channel` (`stable` or
`nightly`) to this machine's `~/.tau/config.json`; the row is hidden while the
window is a client of a host on another machine, because the updater reads the
file of the machine it runs on. `src/main/app-updates.ts` reads the channel
before every check, and again when the host reports a config change, so a
switch checks at once.

| | Stable | Nightly |
|---|---|---|
| feed | the GitHub provider from `app-update.yml`: the latest release, never a prerelease | `https://github.com/Rasalas/tau-releases/releases/download/nightly/latest*.yml`, read as a generic feed |
| `allowPrerelease` | off | on |
| `allowDowngrade` | on only when the running build is a nightly | off |

Nightly uses a plain URL because the GitHub provider cannot follow one moving
tag: it looks for a semver tag per build. Switching from nightly back to stable
installs the latest stable release even though it is older. With no channel in
the config, a build follows its own kind: a nightly installed by hand stays on
nightly instead of downgrading itself on the first check.

### Version skew

The window process and the host process it talks to say hello with their Tau
version. When the two differ, the workbench shows a *Version mismatch* line
above the status line, where a lost connection shows too, with both versions
and a Dismiss button. A supervised host of another version is replaced when the
window starts (ADR 0021), so in practice this shows for a window attached to a
host on another machine (`TAU_HOST_URL`) that runs a different build.

### A build replaced under an open page

The renderer loads most surfaces as hashed chunks. A browser tab keeps the
build its host served, and a window keeps the build it started with, so after
a host update or a rebuild the next chunk it asks for may be gone. The first
missing chunk reloads the page once; a marker per build in `sessionStorage`
stops a second reload of the same build. If the chunk is still missing, the
feature shows *Tau was updated. Reload to continue.* in its own place, with
*Reload window* and the failed URL under Details. A browser tab also watches
the host's version in its hello: when it changes after the page loaded, the
status line offers *Reload*.

### The move to `de.tbuck.tau`

The desktop app was `dev.tbuck.tau`, its bundle id on macOS and its
AppUserModelID on Windows. The phone app was `io.github.rasalas.tau`. Both are
`de.tbuck.tau` now, and the first release with the new id breaks the update
chain in these places:

- **macOS: install once by hand.** Squirrel.Mac installs an update only if its
  signature satisfies the running app's designated requirement, and that names
  the bundle id. A Tau with the old id downloads the release and cannot install
  it. Use `npm run install:mac`, the `.dmg`, or `brew reinstall --cask tau`;
  `brew upgrade` skips a cask that updates itself. After that:
  - macOS asks again for Screen Recording and Accessibility, which computer
    use and snapshots need, and for Notifications and Local Network. The
    entries for `dev.tbuck.tau` stay in System Settings until you remove them.
  - The saved machines' tokens live in the keychain item "Tau Safe Storage";
    a signed build asks once whether the new Tau may read it. Answer Always Allow.
  - The background service keeps its label `dev.tbuck.tau.host`, so no second
    agent runs beside it. Its LaunchAgent names the old bundle id, so
    Settings → Connections → Background says *Needs repair*. Repair, or
    `tau service install`, rewrites it in place.
  - userData `tau-pi-desktop-prototype`, `~/.tau` and `~/.pi` do not move.
    Caches and preferences under the old id stay behind; the cask's `zap`
    removes both.
- **Windows: updates itself.** `nsis.guid` stays the GUID electron-builder
  derived from `dev.tbuck.tau`, so the installer sees the same install and
  replaces it. Windows shows a toast only when the shortcut's AppUserModelID
  matches the app's, so `packaging/windows/installer.nsh` stamps the new one on
  the shortcuts an update keeps. If toasts stay silent after the update, running
  the new setup once by hand recreates the shortcuts.
- **Linux: nothing changes.** The `.deb` is still `tau`, and the desktop
  entry's name and `StartupWMClass` come from the product and executable names,
  not from the app id.
- **Phones: a new app.** iOS and Android install `de.tbuck.tau` beside the old
  app; pair it again, allow notifications again, then delete the old one. It
  needs a new App ID with Push Notifications, a profile, an App Store Connect
  record, and a Firebase Android app for the new package name with its
  `google-services.json`, see [mobile-testflight.md](mobile-testflight.md). The
  APNs key belongs to the team and stays.

For the release notes:

> Tau's app id is now `de.tbuck.tau`. On macOS this version does not arrive as
> an update. Install it once by hand with `brew reinstall --cask tau` or the
> `.dmg`, allow Screen Recording, Accessibility and Notifications again, and
> repair the background service under Settings → Connections if it asks.
> Windows and Linux update as usual. The phone app is a new app under the same
> name: install it, pair it again, and delete the old one.

## Nightly builds

`.github/workflows/release.yml` has a schedule (03:17 UTC). Its `gate` job
decides whether anything runs:

- only on `Rasalas/tau` (a fork's schedule stops there);
- only once the repository variable `NIGHTLY` is `true`;
- only when `main` moved since the commit the tag `nightly` points at.

A run that passes builds the same desktop apps as a release, without the phone apps, with
`package.json`'s version replaced by
`<next patch>-nightly.<UTC date>.<run number>` (for 0.4.0:
`0.4.1-nightly.20260922.42`, from `scripts/packaging/nightly-version.mjs`). The
`nightly` job then deletes the previous release tagged `nightly` (only if it is
a prerelease) and the tag, and publishes the new build as a prerelease under
the same tag, never marked latest. It does so in `Rasalas/tau`, whose tag the
`gate` compares with `main`, and in `Rasalas/tau-releases`, which installed
apps read; there the new nightly is a draft until every file is uploaded, and
its tag sits on the default branch, since the built commit is not in that
repository (the release text names it). The stable `release` job never runs
for a nightly.

Switch the schedule on (repository admin, once):

```bash
gh variable set NIGHTLY --repo Rasalas/tau --body true
```

or Settings → Secrets and variables → Actions → Variables → New repository
variable, `NIGHTLY` = `true`. Delete the variable to stop the schedule. Publish
one right away, even without new commits:

```bash
gh workflow run release.yml --ref main -f nightly=true
```

Before switching it on, know what it costs and needs:

- Each nightly builds on four GitHub-hosted runners, which cost nothing on a
  public repository. Days without commits cost one short gate job.
- It needs the publishing app's secrets like a release
  ([Where releases are published](#where-releases-are-published)).
- A nightly is signed like a release and fails without
  `TAU_RELEASE_SIGNING_KEY` ([Update feeds](#update-feeds)).
- The tag `nightly` must stay movable in both repositories: do not enable
  *immutable releases* for either, and do not put `nightly` under a tag
  ruleset or protection that forbids deleting it.

## Phone apps

A stable release also builds the app in `mobile/` for both phones. A nightly
does not.

| | Android | iOS |
|---|---|---|
| job | `android` (`ubuntu-24.04`, the image's JDK 21) | `ios` (`macos-26`, Xcode 26.6) |
| starts | with the desktop builds | after `preflight` and `verify` (when that runs) |
| signed with | the upload key (`ANDROID_UPLOAD_KEYSTORE`) | automatic signing through the App Store Connect key |
| goes to | the release (APK) and Play's internal testing (App Bundle, `play` job) | TestFlight |
| version | `package.json`'s | `package.json`'s |
| build number | `versionCode` = major·10000 + minor·100 + patch (0.7.15 → 715) | 100 + the run number of `release.yml` |

Both build the web layer as a release (`vite build` without the development
mode) and fail when it holds the automation bridge the simulator scripts use.

### Android

`mobile/android/app/build.gradle` signs the release build with the upload key
when `TAU_ANDROID_KEYSTORE` names a keystore; `TAU_ANDROID_KEYSTORE_PASSWORD`
is the store's password and the key's, `TAU_ANDROID_KEY_ALIAS` the alias
(`upload` by default). Without it the release build stays unsigned. The job
decodes `ANDROID_UPLOAD_KEYSTORE` (base64 of the PKCS12 file) into the
runner's temp folder, runs `./gradlew bundleRelease assembleRelease`, and
deletes it again. It then checks the APK's signature (`apksigner verify`) and
that it says `de.tbuck.tau` with the expected versionCode and versionName.

- **Push.** `ANDROID_GOOGLE_SERVICES_JSON` (base64) becomes
  `google-services.json`: the Firebase project `tau-push-e3c95`, which holds
  the Android app `de.tbuck.tau`. Google's Gradle plugin fails a build whose
  project lacks that app with an error that does not say so, so the job checks
  first. A release without the secret, or with a project lacking the app,
  fails (`preflight`, then `android`); a dry run warns and builds an app that
  cannot take pushes. The app asks Firebase for a token only after the
  user allowed notifications (`firebase_messaging_auto_init_enabled` is off in
  the manifest).
- **versionCode** is computed from the version by `build.gradle` (and
  `scripts/packaging/mobile-version.mjs android-code`, which the job compares
  with the APK): major·10000 + minor·100 + patch. It rises with every release as
  long as minor and patch stay below 100. Play takes each versionCode once, so
  a version reaches Play once; a re-run finds it there and skips the upload.
- **The APK** goes into the release as `Tau-<version>.apk` and, in
  `tau-releases`, also as `Tau-android.apk`, for sideloading
  (`releases/latest/download/Tau-android.apk`). No feed names it; a sideloaded
  app does not update itself.
- **Play.** `play` runs after `release` has published and uploads the App
  Bundle to the `internal` track with `scripts/packaging/play-upload.mjs`,
  which talks to the Google Play Developer API directly: a service account's
  JSON key in `PLAY_SERVICE_ACCOUNT_JSON`, a token for the
  `androidpublisher` scope, then one edit that uploads the bundle, sets it on
  the track and commits. The secret is set in `release` (a service account
  invited in the Play Console with release rights for the testing tracks). Without it the job says so
  and succeeds; the bundle stays in the run's `play-bundle` artifact for a day. While Play still
  treats the app as a draft (before its first release was rolled out in the
  Play Console), it takes only draft releases; the script then makes one, and
  it has to be rolled out by hand. What the Play Console needs before that:
  a developer account, the app `de.tbuck.tau`, the service account invited
  with release rights for the testing tracks.

A signed build on this Mac, for a first upload by hand (the password is read,
not typed on the command line):

```bash
cd mobile && npx vite build && npx cap sync android && cd android
export TAU_ANDROID_KEYSTORE=/path/to/android-upload-key.jks TAU_ANDROID_KEY_ALIAS=upload
read -rs TAU_ANDROID_KEYSTORE_PASSWORD && export TAU_ANDROID_KEYSTORE_PASSWORD
./gradlew --no-daemon bundleRelease assembleRelease
# app/build/outputs/bundle/release/app-release.aab, app/build/outputs/apk/release/app-release.apk
```

### iOS

`ios` archives the app with the App Store Connect key that also notarizes the
Mac apps (`APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`), for team
`V4MWQ28RZ2`:

```bash
xcodebuild archive -project mobile/ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination generic/platform=iOS -archivePath Tau.xcarchive \
  MARKETING_VERSION=<version> CURRENT_PROJECT_VERSION=<build> DEVELOPMENT_TEAM=V4MWQ28RZ2 \
  -allowProvisioningUpdates -authenticationKeyPath AuthKey_<id>.p8 \
  -authenticationKeyID <id> -authenticationKeyIssuerID <issuer>
xcodebuild -exportArchive -archivePath Tau.xcarchive -exportOptionsPlist export.plist \
  -exportPath export -allowProvisioningUpdates -authenticationKeyPath … # the same key
```

`export.plist` says `method` `app-store-connect`, `destination` `upload`,
`teamID` `V4MWQ28RZ2` and `signingStyle` `automatic`, so the export step is
the upload. Xcode creates or fetches the certificates and profiles through the
key (cloud signing); the key needs a role in App Store Connect that may manage
certificates, which Admin has. The key file lives in the runner's temp folder
for the step and is deleted when it ends.

- **When it uploads:** for a `v*` tag or a `publish` dispatch. A dispatch on
  `main` archives signed and uploads nothing; a branch's dry run, which has no
  key, archives unsigned. The release job does not wait for `ios`: TestFlight
  gets the build even if a desktop platform fails, and a failed upload leaves
  the release alone.
- **Build number:** `CFBundleVersion` is 100 plus the run number of
  `release.yml` (`scripts/packaging/mobile-version.mjs ios-build`). The builds
  up to 0.7.14 were numbered 1 to 9 by hand, so the automatic ones start above
  them, and every run counts up, dry runs and nightlies included. Gaps are
  normal. A re-run of the same run keeps its number, and App Store Connect
  refuses a number it has seen for that version: dispatch a new run instead of
  re-running `ios`.

## Package managers

`packaging/` holds a Homebrew cask, the winget manifest triple and the AUR
package `tau-bin`, all written by one command from a published release:

```bash
npm run packaging:update -- --tag v0.4.1
git add packaging && git commit -m "chore(packaging): v0.4.1"
```

It reads the release from `Rasalas/tau-releases` through GitHub's public API
(no login), takes each installer's SHA-256 from GitHub's asset `digest`, and
writes `packaging/homebrew/tau.rb`, `packaging/winget/Rasalas.Tau*.yaml`,
`packaging/aur/tau-bin/PKGBUILD` and `.SRCINFO`, plus
`packaging/release.json`, the release they were written from.
`scripts/packaging/packaging.test.mjs` renders that file again and fails when
the committed files disagree with it, so edit the scripts, never the output.
`--release-json <file>` works without network. Nightlies are not packaged.

All three download the assets anonymously, and winget's validation rejects
a URL it cannot fetch, so the installers, the homepage and `LICENSE` all
point at the release in `Rasalas/tau-releases`. Only winget's `PublisherSupportUrl` names `Rasalas/tau/issues`,
which answers once the source repository is public. The committed files still
describe 0.4.0, which exists only in `Rasalas/tau`; the next
`packaging:update` writes them for a release in `Rasalas/tau-releases`.

### Homebrew (macOS)

Homebrew only installs casks from a tap, a GitHub repository named
`homebrew-<name>`. Once:

1. Create the public repository `Rasalas/homebrew-tau` (empty, default branch
   `main`).
2. Clone it, copy the cask in and push:

   ```bash
   git clone git@github.com:Rasalas/homebrew-tau.git
   mkdir -p homebrew-tau/Casks
   cp packaging/homebrew/tau.rb homebrew-tau/Casks/tau.rb
   cd homebrew-tau && git add Casks/tau.rb && git commit -m "tau 0.4.0" && git push
   ```

3. Check it on a Mac: `brew install --cask rasalas/tau/tau`, then
   `brew uninstall --cask tau`.

After each release: `npm run packaging:update`, copy `packaging/homebrew/tau.rb`
to the tap's `Casks/tau.rb`, commit, push. Users install with:

```bash
brew install --cask rasalas/tau/tau
```

The cask sets `auto_updates true`: Tau updates itself, and `brew upgrade`
leaves it alone unless run with `--greedy`. Until the build is signed
([Signing](#signing)), macOS may refuse the first launch; the cask's caveats
say how to allow it. `brew uninstall --zap` also removes `~/.tau` and the app's
Library folders. Automating the tap update from the release workflow would need
a token with write access to the tap as a secret; that is not wired up.

### winget (Windows)

winget installs from `microsoft/winget-pkgs`, one pull request per version.

1. Fork `microsoft/winget-pkgs` on GitHub.
2. In the fork, add the three files under
   `manifests/r/Rasalas/Tau/<version>/`:

   ```bash
   mkdir -p manifests/r/Rasalas/Tau/0.4.0
   cp <tau>/packaging/winget/Rasalas.Tau*.yaml manifests/r/Rasalas/Tau/0.4.0/
   ```

3. On a Windows machine, check them: `winget validate --manifest
   manifests\r\Rasalas\Tau\0.4.0` and `winget install --manifest
   manifests\r\Rasalas\Tau\0.4.0` (the second installs Tau).
4. Open a pull request to `microsoft/winget-pkgs` titled `New package:
   Rasalas.Tau version 0.4.0`, and answer the bot's checks. The first
   submission of an unsigned installer may be held for manual review;
   SmartScreen reputation is part of it.

Later versions: the same with the new version folder (title `New version:
Rasalas.Tau version 0.4.1`), or `wingetcreate update Rasalas.Tau --version
0.4.1 --urls <installer URL> --submit` with a GitHub token, which writes the
same manifests itself. Users install with `winget install Rasalas.Tau`.

Releases up to 0.4.0 name the installer `Tau.Setup.<version>.exe`; from the next
one it is `Tau-Setup-<version>.exe`, the name `latest.yml` always used, so
Windows installs finally find their updates (`nsis.artifactName` in
`tooling/electron-builder.yml`).

### AUR (Arch Linux)

`tau-bin` repacks the release's `Tau-<version>.AppImage` into `/opt/tau-bin`,
with `/usr/bin/tau`, a desktop entry and the icons. Once:

1. Create an account on <https://aur.archlinux.org> and add an SSH public key
   to it (My Account → SSH Public Key).
2. Set the contact line you want published at the top of
   `packaging/aur/tau-bin/PKGBUILD` (`# Maintainer: …`, in
   `scripts/packaging/update-aur.mjs`).
3. On Arch Linux (a VM or container will do), build and check the package
   before the first push:

   ```bash
   cp -r packaging/aur/tau-bin /tmp/tau-bin && cd /tmp/tau-bin
   makepkg --printsrcinfo | diff - .SRCINFO   # must print nothing
   namcap PKGBUILD
   makepkg -si                                # installs it on that machine
   ```

4. Push to the AUR, which creates the package on the first push:

   ```bash
   git clone ssh://aur@aur.archlinux.org/tau-bin.git
   cp /tmp/tau-bin/PKGBUILD /tmp/tau-bin/.SRCINFO tau-bin/
   cd tau-bin && git add PKGBUILD .SRCINFO && git commit -m "tau-bin 0.4.0-1" && git push
   ```

After each release: `npm run packaging:update`, then steps 3 and 4 with the
new files. Users install with an AUR helper, e.g. `yay -S tau-bin`. The package
conflicts with `tau-editor`, which also installs `/usr/bin/tau`.

## Signing

Unsigned builds are the default and work everywhere, with the usual first-run
warning: on macOS the app has to be opened from the context menu once, and
Windows SmartScreen asks for a confirmation.

One thing an unsigned macOS build cannot do is show a notification. Since
Electron 42 notifications go through Apple's `UNNotification` API, which
refuses an ad-hoc signed app (`UNErrorDomain` error 1), so `notify` answers
`"unavailable"` there, and so does a checkout running `node_modules/electron`.
The badge on the icon is not affected. A local `npm run dist:mac` signs with
whatever Apple Development identity the keychain holds, and that build shows
notifications.

Releases from 0.7.14 on sign the Mac apps with a Developer ID and have Apple
notarize them. electron-builder turns both on by itself once the credentials
are in the environment, so there is nothing to switch on in the
configuration. The secrets live in the environment `release`:

| Secret | What it is |
|---|---|
| `CSC_LINK` | base64 of the Developer ID Application `.p12` (a hosted runner has no file to point at) |
| `CSC_KEY_PASSWORD` | its password |
| `APPLE_API_KEY_P8` | an App Store Connect API key (`.p8`) that notarizes; the workflow writes it to a file for electron-builder |
| `APPLE_API_KEY_ID` | that key's id |
| `APPLE_API_ISSUER` | its issuer id |

Only the macOS build reads them: it is the only build job in the environment,
and the Package step passes them only when the matrix entry is macOS, since
the Windows job would otherwise take the Developer ID certificate for
Authenticode. The step unsets whichever of these is empty: electron-builder
treats an empty value as "set" and would fail looking for a certificate that
is not there. Without `CSC_LINK` it also sets
`CSC_IDENTITY_AUTO_DISCOVERY=false`, so a runner never picks up a stray
keychain identity. A branch's dry run has no secrets and builds unsigned
([Build all platforms without publishing](#build-all-platforms-without-publishing)).

macOS builds ask for the hardened runtime, which needs the entitlements in
`assets/entitlements.mac.plist`: V8 compiles at runtime, and Tau loads
extension code it compiled itself.

Windows signing is not wired up, so SmartScreen may warn on the first launch
of the installer. Adding it means a `win.signtoolOptions` (or Azure Trusted
Signing) block, its secrets in `release`, and the same unset-if-empty
treatment.

### Update feeds

Separate from code signing, and not optional: every `latest*.yml` a release
publishes carries a `latest*.yml.sig`, and a host or the Linux update helper
refuses a feed without one ([host-updates.md](host-updates.md#release-signing)).

| Secret | What it is |
|---|---|
| `TAU_RELEASE_SIGNING_KEY` | the Ed25519 private key (PKCS#8 PEM) whose public key is in `src/shared/release-keys.ts` and `bin/tau-update-helper.mjs`; during a rotation, two PEM blocks |

Only the `sign` job reads it (and `preflight` checks that it is set). The job fails when the secret signs with a key
the commit does not list, so a wrong secret cannot publish feeds that every
host would refuse. How to rotate the key: [host-updates.md](host-updates.md#rotating-the-key).

## Runners and environments

Every workflow runs on GitHub-hosted runners, pinned to an image
(`ubuntu-24.04`, `macos-26` with Xcode 26.6 selected, `windows-2025`), so a
moving `-latest` label cannot change a release under it. Actions are pinned
to a full commit SHA with the version in a comment; the repository requires
that. No workflow uses `pull_request_target` or `workflow_run`, and every
checkout except the release gate's drops its credentials, so a pull request
from a fork runs with a read-only token and no secret.

| Workflow | Runs on | Jobs |
|---|---|---|
| `ci.yml` | pull requests, pushes to `main` | `checks` (lint, typecheck, build), `test (1/3)` to `test (3/3)` (the suite in three shards), `smoke` |
| `performance.yml` | pull requests, pushes to `main` | build and Git budgets and host budgets block; renderer and start timings are advisory ([PERFORMANCE.md](PERFORMANCE.md)) |
| `release.yml` | `v*.*.*` tags, the nightly schedule, dispatch | above |
| `pages.yml` | pushes to `main` that touch `site/`, `docs/` and the rest the website builds from | builds the site without write access, then deploys it to GitHub Pages |
| `windows.yml` | dispatch only | the Windows checks ([windows.md](windows.md)) |
| `cleanup-artifacts.yml` | daily | deletes artifacts older than two days |

`release.yml`'s secrets live in two environments, not in the repository:

- **`release`** holds `TAU_RELEASE_SIGNING_KEY`, `TAU_RELEASES_APP_ID`,
  `TAU_RELEASES_APP_KEY`, `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8`,
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, the phone apps' `ANDROID_UPLOAD_KEYSTORE`,
  `ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS`,
  `ANDROID_GOOGLE_SERVICES_JSON` and `PLAY_SERVICE_ACCOUNT_JSON`
  ([Phone apps](#phone-apps)). Only `main` and `v*` tags may
  deploy to it. `preflight`, the macOS builds, `android`, `ios`, `sign`,
  `release`, `nightly` and `play` run in it for a tag, a nightly, a `publish`
  dispatch, or any dispatch on `main`.
- **`release-dry-run`** holds nothing. A dispatch on any other branch runs in
  it and builds unsigned.

The gate job decides which one a run gets. The Linux and Windows builds and
`verify` never enter an environment.

The runners used to be self-hosted machines, for the minutes. A public
repository must not have self-hosted runners: a pull request can change a
workflow file and pick any runner label. How the move went is in
[scripts/open-source/cutover.md](../scripts/open-source/cutover.md).

## What ships, and what has to stay outside the archive

`files:` in `tooling/electron-builder.yml` starts from everything and names what to
leave out: sources, scripts, docs, reports, tests, and the parts of Pi and of
computer use that only another platform would use.

**The kits ship as their own artifact.** `dist-kits/` is `@tau/kits`, every kit
under `kits/` compiled by `scripts/build-kits.mjs`, with `dist-kits/manifest.json`
naming the set and its version. `npm run build` writes it and the default
`**/*` carries it into the archive; `kits/` is excluded from that runtime
archive, so `dist-kits/` is the only place the installed runtime reads a kit
from. A second copy of the sources and build dependencies ships outside the
archive as the seed for Tau's versioned, user-editable source tree. Its version lives in `kits/package.json`, moves
with the set rather than with the app, and heads the bundled list in
Settings → Packages. A release with a stale `dist-kits/` fails loudly: each
manifest's `engines.api` is checked against the running
`EXTENSION_API_VERSION`.

`assets/` is `buildResources` and stays out of the archive by
electron-builder's own default, so an installed app has no `assets/tau-icon.png`.
It wears the icon the installer baked into the bundle instead, and
`src/main/index.ts` reads that path only where it exists.

`asarUnpack:` names what cannot stay inside `app.asar`. Electron reads the
archive through its own patched `fs`, but a process it spawns and a worker
thread it starts open the file themselves and find nothing there:

- **esbuild's native binary** (`@esbuild/*`). The host compiles every extension
  with it, and esbuild spawns the binary as a child process.
  `src/main/packaged-app.ts` also points `ESBUILD_BINARY_PATH` at the unpacked
  copy, because esbuild resolves the path with `require.resolve` and would get
  the archive path back.
- **`dist-electron/main/`**, for the isolated host extension worker
  (`new Worker(...)`) and the headless host, which is started as a script.
- **Pi's image resize worker and its WebAssembly**, another worker thread.
- **Computer use's driver app**, which is launched as a program.
- **Every `*.node`**, the native addons Electron loads with `dlopen`.

electron-builder has to stay at 26.0.14 or newer. Older versions join every
unpacked file's absolute temp path into one glob, and minimatch refuses a
pattern over 64 KiB. That is how the macOS build of 0.5.1 failed with
`pattern is too long`: it had about 500 such paths under the Mac's long
`$TMPDIR`.

A hidden top-level directory needs its exclusion pattern spelled out as
`!name/**`, not just `!name`: electron-builder only auto-adds the recursive
suffix to a bare negated pattern when the pattern has no `.` in it, and a
leading dot always defeats that check, so a bare `!.name` only ever excluded
the directory entry itself, not what's in it.

The one `files:` list above is also the only place platform-conditional
exclusions can go (the computer-use driver binary, via the `${platform}`
macro). A same-shaped `files:` under `mac`/`linux`/`win` looks equivalent but
isn't: it builds a *second*, unmerged copy of this file set rooted at the same
directory, and electron-builder walks the project twice, concurrently, into
the same destination — a race that surfaces as an `EEXIST` on whichever file
loses it, and, more quietly, as every file *neither* copy of `files:`
excludes (everything not covered by the platform-only override) shipping
regardless of what the root list says.

Verified 2026-09-06 on GitHub-hosted runners (`gh workflow run release.yml
--ref feat/p5-release-dispatch -f publish=false`): all three platforms built
clean and their `app.asar` was audited (via `npx asar list`) to confirm none
of the excluded directories or `*.test.js` files leak in, and that each
archive carries only its own platform's computer-use driver binary. The Linux
`.AppImage` was also launched — `--appimage-extract`'s stub won't run under
QEMU's x86-64 emulation on Apple Silicon, so the squashfs payload was
extracted directly instead (offset from the ELF section-header table, per
`readelf -h`) — and its Electron binary came up under `xvfb-run` with a
working CDP endpoint. The Windows `.exe` was opened with `7z` down to its
inner `app-64.7z`; the file list matched the Linux/macOS audits. The macOS
`.zip` got the same `asar` audit; launching it outside Finder is blocked by
Gatekeeper for an unsigned, adhoc-signed build regardless of packaging
correctness (see Signing, above), so that one is content-verified only.

The macOS build was also *run*, 2026-09-06: `release/mac-arm64/Tau.app`'s own
binary started directly (Gatekeeper stops the extracted `.zip`, not the app
electron-builder just wrote), with `TAU_USER_DATA` and
`PI_CODING_AGENT_SESSION_DIR` pointed at a scratch directory and a
`--remote-debugging-port` to drive it. All fifteen kits loaded from inside
`app.asar`, a prompt round-tripped, and safe mode came up with none of them.
That run is what turned up the dock-icon crash: `app.dock.setIcon` pointed at
`assets/tau-icon.png`, a checkout-only path that does not exist inside
`app.asar`, and threw inside the same `whenReady` callback that creates the
window, taking the window down with it. Fixed 2026-09-06 by treating a missing
icon file as no icon instead of an error (`src/main/index.ts`); an audit of
the archive would never have found it.
