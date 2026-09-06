# Releasing Tau

Tau ships as an installable app built by [electron-builder](https://electron.build).
`electron-builder.yml` is the whole configuration; `package.json` holds the
version, and the version in an installed app is what the updater compares
against the release feed.

## Cut a release

1. Land everything the release should contain on `main`.
2. Raise `version` in `package.json` and commit it.
3. Tag the commit and push the tag:

   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```

`.github/workflows/release.yml` runs on any `v*.*.*` tag. It builds on three
runners — macOS (arm64 and x64 on the same runner), Linux x64, Windows x64 —
with `--publish never`, then one job attaches every artifact to a single GitHub
Release named after the tag.

The tag drives nothing but the release name. If it does not match
`package.json`, the artifacts carry the version from `package.json` and the
updater will compare against that one. Keep them equal.

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

The `release` job stays skipped unless the ref is a `v*.*.*` tag or `publish`
is `true`, so a dispatch with `publish=false` cannot attach anything to a
GitHub Release; the three `tau-*` artifacts (and `latest*.yml`) land as
workflow run artifacts instead, good for a week.

A build job that fails uploads a `tau-<platform>-diagnostics` artifact
alongside it — `release/builder-debug.yml` (electron-builder's own verbose
log, enabled for every Package step via `DEBUG=electron-builder`) plus
whatever npm wrote under its cache's `_logs/`.

## Build one locally

```bash
npm run dist          # this machine's platform and architecture
npm run dist:mac      # or :linux, :win
```

Each runs `npm run build` first and writes to `release/`, which is not in Git.
Stop a running `npm run dev:instance` of the same worktree first: while it
runs, its `.tau-dev/userdata` holds dangling `Singleton*` symlinks and
electron-builder aborts on the first one it cannot `stat`.
macOS produces a `.dmg` and a `.zip`, Linux an `.AppImage`, Windows an NSIS
`.exe`. Cross-building macOS from another platform is not possible; Linux and
Windows builds need their own runners for the same reason Tau ships a native
esbuild binary.

## How an update reaches a user

`publish:` in `electron-builder.yml` names the GitHub repository, and
electron-builder writes it into `app-update.yml` inside the app. From there:

1. An installed Tau asks that repository for a newer release a few seconds
   after it starts, and downloads one in the background. A Tau running from a
   checkout never checks (`src/main/app-updates.ts`).
2. When the download finishes the host publishes an `app-update` event and the
   workbench offers a toast: *Tau 0.2.0 downloaded, restart to install*, with a
   Restart button that quits into the new version.
3. A user who ignores the toast gets the update the next time they quit Tau.
4. "Check for updates…" in the application menu asks on demand and reports what
   it found.

electron-updater reads the `latest-mac.yml`, `latest-linux.yml` and
`latest.yml` files the release carries. A release published without them
installs fine and then never updates, which is why the workflow uploads
`release/latest*.yml` and fails when a matrix job produced no files.

Both macOS architectures build on one runner on purpose: each would otherwise
write its own `latest-mac.yml` and the second job to finish would leave the
other architecture without a feed.

`Rasalas/tau` is private today, so the updater's request for the release feed
comes back as a 404 and every check fails with it (visible in
`<userData>/logs/host.log` as `update.failed`). Making the repository public is
the fix. Keeping it private means shipping a GitHub token to every user, which
is worse than having no updates.

## Signing

Unsigned builds are the default and work everywhere, with the usual first-run
warning: on macOS the app has to be opened from the context menu once, and
Windows SmartScreen asks for a confirmation.

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

## What ships, and what has to stay outside the archive

`files:` in `electron-builder.yml` starts from everything and names what to
leave out: sources, scripts, docs, reports, tests, and the parts of Pi and of
computer use that only another platform would use.

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
