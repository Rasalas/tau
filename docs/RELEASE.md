# Releasing Tau

Tau ships as an installable app built by [electron-builder](https://electron.build).
`electron-builder.yml` is the whole configuration; `package.json` holds the
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

`.github/workflows/release.yml` runs on any `v*.*.*` tag. It builds on three
runners — macOS (arm64 and x64 on the same runner), Linux x64, Windows x64 —
with `--publish never`. A `sign` job signs each platform's `latest*.yml` with
the secret `TAU_RELEASE_SIGNING_KEY` ([Update feeds](#update-feeds)), then one
job attaches every artifact and the `.sig` files to a single GitHub Release
named after the tag. Without the secret the run fails before it builds.

The tag drives nothing but the release name. If it does not match
`package.json`, the artifacts carry the version from `package.json` and the
updater will compare against that one. Keep them equal.

4. Once the release is published, update the package managers
   ([Package managers](#package-managers)).

## Build all platforms without publishing

`workflow_dispatch` runs the same three build jobs on a branch, with no tag
and no release. Use it to prove Linux and Windows still build — the only
runners that never run for an ordinary PR or push to `main` — before cutting
a real release:

```bash
gh workflow run release.yml --ref my-branch -f publish=false
gh run watch                # or: gh run view --log-failed
gh run download --dir /tmp/artifacts
```

The `release` job stays skipped unless the ref is a tag starting with `v` or
`publish` is `true`, so a dispatch with `publish=false` cannot attach anything
to a GitHub Release; the three `tau-*` artifacts (and `latest*.yml`) land as
workflow run artifacts instead, good for a day. The `push` trigger above only
ever delivers `v*.*.*` tags; the `v`-prefix check on `release` is what keeps a
`workflow_dispatch` run against some other tag from also publishing.

The `sign` job runs in a dry run too. With the secret it signs the three
feeds, checks them against the keys the branch ships, and uploads
`tau-signatures`, so a dry run also shows that the secret matches the
listed key. Without the secret it warns and leaves the feeds unsigned. A
missing `latest*.yml` fails the job either way.

A build job that fails uploads a `tau-<platform>-diagnostics` artifact
alongside it — `release/builder-debug.yml` (electron-builder's own verbose
log, enabled for every Package step via `DEBUG=electron-builder`) plus
whatever npm wrote under its cache's `_logs/`.

## Install a release on this Mac

```bash
npm run install:mac                    # the latest release
npm run install:mac -- --version v0.1.1
npm run install:mac -- --open          # and launch it
```

`scripts/install-mac.mjs` downloads the `.dmg` for this machine's
architecture with `gh` (the repository is private, so `gh auth status` must
be logged in), quits a running Tau, replaces `/Applications/Tau.app`, and
removes the `com.apple.quarantine` attribute — the mark Gatekeeper uses to
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
`npm run dist:mac -- --arm64 --x64` builds both Mac apps, as the release does.
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
`files` in `electron-builder.yml` then drops the other architecture's platform
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
| `mark-light.svg`, `mark-dark.svg` | the 32-unit mark: favicon, small Windows sizes, the Tau repo's avatar (`t3.json`) |
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

`publish:` in `electron-builder.yml` names the GitHub repository, and
electron-builder writes it into `app-update.yml` inside the app. From there:

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
   notes are the ones the download brought, else the GitHub release of that
   version read through the public API (the moving `nightly` tag for a
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

`Rasalas/tau` is private today, so the updater's request for the release feed
comes back as a 404 and every check fails with it (visible in
`<userData>/logs/host.log` as `update.failed`, and in the host's
`host-process.log` as `host-update.check.failed`). Making the repository public is
the fix. Keeping it private means shipping a GitHub token to every user, which
is worse than having no updates.

### Stable and nightly

Settings → General → **Update track** writes `updates.channel` (`stable` or
`nightly`) to this machine's `~/.tau/config.json`; the row is hidden while the
window is a client of a host on another machine, because the updater reads the
file of the machine it runs on. `src/main/app-updates.ts` reads the channel
before every check, and again when the host reports a config change, so a
switch checks at once.

| | Stable | Nightly |
|---|---|---|
| feed | the GitHub provider from `app-update.yml`: the latest release, never a prerelease | `https://github.com/Rasalas/tau/releases/download/nightly/latest*.yml`, read as a generic feed |
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

A run that passes builds the same three platforms as a release, with
`package.json`'s version replaced by
`<next patch>-nightly.<UTC date>.<run number>` (for 0.4.0:
`0.4.1-nightly.20260922.42`, from `scripts/packaging/nightly-version.mjs`). The
`nightly` job then deletes the previous release tagged `nightly` (only if it is
a prerelease) and the tag, and publishes the new build as a prerelease under
the same tag, never marked latest. The stable `release` job never runs for a
nightly.

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

- Each nightly spends GitHub-hosted Linux and Windows minutes (Windows counts
  double on a private repository) plus the self-hosted `tau-linux` and
  `tau-macos` runners. Days without commits cost one short gate job.
- While `Rasalas/tau` is private, an installed Tau cannot read the nightly
  feed either (404, as for stable).
- A nightly is signed like a release and fails without
  `TAU_RELEASE_SIGNING_KEY` ([Update feeds](#update-feeds)).
- The tag `nightly` must stay movable: do not enable *immutable releases* for
  the repository, and do not put `nightly` under a tag ruleset or protection
  that forbids deleting it.

## Package managers

`packaging/` holds a Homebrew cask, the winget manifest triple and the AUR
package `tau-bin`, all written by one command from a published release:

```bash
npm run packaging:update -- --tag v0.4.1
git add packaging && git commit -m "chore(packaging): v0.4.1"
```

It reads the release with `gh api` (logged in, since the repository is
private), takes each installer's SHA-256 from GitHub's asset `digest`, and
writes `packaging/homebrew/tau.rb`, `packaging/winget/Rasalas.Tau*.yaml`,
`packaging/aur/tau-bin/PKGBUILD` and `.SRCINFO`, plus
`packaging/release.json`, the release they were written from.
`scripts/packaging/packaging.test.mjs` renders that file again and fails when
the committed files disagree with it, so edit the scripts, never the output.
`--release-json <file>` works without network. Nightlies are not packaged.

All three need the release downloadable without a login: **make
`Rasalas/tau` public first.** Homebrew, winget and makepkg download the assets
anonymously, and winget's validation rejects a URL it cannot fetch.

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
`electron-builder.yml`).

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

electron-builder turns signing on by itself once the credentials are in the
environment, so there is nothing to switch on in the configuration. Add the
repository secrets and the next tag is signed:

| Secret | What it is |
|---|---|
| `CSC_LINK` | base64 of the Developer ID `.p12`, or a path to it |
| `CSC_KEY_PASSWORD` | its password |
| `APPLE_ID` | the Apple ID that notarizes |
| `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | the team the certificate belongs to |

The workflow unsets whichever of these the repository has no secret for:
electron-builder treats an empty value as "set" and would fail looking for a
certificate that is not there. Without `CSC_LINK` it also sets
`CSC_IDENTITY_AUTO_DISCOVERY=false`, so a runner never picks up a stray
keychain identity.

macOS builds ask for the hardened runtime, which needs the entitlements in
`assets/entitlements.mac.plist`: V8 compiles at runtime, and Tau loads
extension code it compiled itself.

Windows signing is not wired up. Adding it means a `win.signtoolOptions` (or
Azure Trusted Signing) block and the same unset-if-empty treatment for its
secrets.

### Update feeds

Separate from code signing, and not optional: every `latest*.yml` a release
publishes carries a `latest*.yml.sig`, and a host or the Linux update helper
refuses a feed without one ([host-updates.md](host-updates.md#release-signing)).

| Secret | What it is |
|---|---|
| `TAU_RELEASE_SIGNING_KEY` | the Ed25519 private key (PKCS#8 PEM) whose public key is in `src/shared/release-keys.ts` and `bin/tau-update-helper.mjs`; during a rotation, two PEM blocks |

Only the `sign` job reads it. The job fails when the secret signs with a key
the commit does not list, so a wrong secret cannot publish feeds that every
host would refuse. How to rotate the key: [host-updates.md](host-updates.md#rotating-the-key).

## What ships, and what has to stay outside the archive

`files:` in `electron-builder.yml` starts from everything and names what to
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
