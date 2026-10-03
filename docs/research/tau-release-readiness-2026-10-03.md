# Tau local release readiness

Audit date: 2026-10-03. Initial verification completed by 15:38:26 UTC; the authorized
follow-up completed by 15:58:44 UTC on macOS with Node v22.23.1. Worktree `tau/agent-7a58881d`, HEAD `cb3b143e`, directly above requested
`feat/t3code-parity-assessment` HEAD `08c103ed`. The extra commit carries only the
parent's assessment document. Initial worktree was clean. Core version is 0.7.38.

## Verdict

Public mobile source checks and the targeted fixtures below pass. Release evidence is
pending, not a confirmed release failure. Full repository lint fails on three errors
in untouched snapshot files; both new script files pass lint.
No signed artifact, physical phone, Windows desktop, WSL distribution or real Linux
compositor was tested in this audit. Earlier compilation and fixture results remain
historical evidence, not certification of this commit or its release artifacts.

This lane changed only this report, the mobile device checklist and new
`scripts/release-readiness*` files. The user approved the public CLI test seam before
implementation. No workflow, existing build script, package manifest, host/runtime or
kit/application source was changed. No child delegation was used.

## Initial checks performed here

The initial checks ran sequentially before dependency installation was authorized.
No full suite, dependency installation, network call, CI dispatch, signing,
provisioning, deployment or account/credit operation ran in that initial pass. No app,
simulator, emulator or host was launched in either pass, so there are no owned app PIDs
to stop. Targeted tests' process cleanup reported no surviving test processes.

| Command or check | Result and limit |
| --- | --- |
| `git status --short`, `git log -5 --oneline`, `git merge-base --is-ancestor 08c103ed HEAD` | Initially clean; requested commit is the immediate parent. |
| Initial `node --test --test-concurrency=1 scripts/release-readiness.test.mjs` | 8 passing Node CLI behavior tests before conversion to Vitest. Superseded by the 9-test Vitest suite below. Current tests run through the repository's convention, not `node --test`. |
| `node scripts/release-readiness.mjs --json` | All 6 public source assertions pass. Initial output used `releaseReady: false`; follow-up now uses `releaseReady: null`, `readiness: "evidence-pending"`. |
| `node --check scripts/release-readiness.mjs` and `node --check scripts/release-readiness.test.mjs` | Both pass. |
| `plutil -lint mobile/ios/App/App/App.entitlements mobile/ios/App/TauWidgets/TauWidgets.entitlements mobile/ios/App/App/Info.plist mobile/ios/App/TauWidgets/Info.plist` | Four public plists parse. This says nothing about signed entitlements or installed profiles. |
| Existing synthetic Python validator assertions from `scripts/packaging/ios-profiles.test.mjs`, extracted and run via `python3 -B -c` with only PATH inherited | Pass. Accepted synthetic App/widget metadata; rejected wrong ID/team/group/keychain, expired/development/ad-hoc metadata; checked the no-widget case. Only `validate()` ran, never `install()`. No profile or keychain was read. This is an ad hoc execution of the existing assertions, not a Vitest run. |
| Existing `projectWithoutWidgets()` and `entitlementsWithoutAppGroup()` on public source text in memory | Pass. No call to `stripWidgets()`, no checkout mutation. |
| Existing `androidVersionCode()` and `iosBuildNumber()` | 0.7.38 gives Android 73800; synthetic iOS run 1 gives 101. No store was queried for previously used numbers. |
| `git diff --check` | Pass after the implementation and documentation edits. |

Dependencies were absent in the initial pass. The authorized installation and fixture
runs are recorded below. Desktop/web budget builds, unsigned native compilation and
an isolated fake-runtime app check remain unrun. `--ignore-scripts` did not install an
Electron binary or perform node-pty lifecycle setup. Any further setup must remain
worktree-local and within approved authority. Any desktop instance must use
`dev:instance`, own `.tau-dev` data and fixture homes, and stop by its exact owned PID.
Never borrow another lane's instance or dependency tree.

## Executable local preflight

```sh
node scripts/release-readiness.mjs
node scripts/release-readiness.mjs --json
node scripts/release-readiness.mjs --root /path/to/checkout --json
npm test -- --maxWorkers=1 scripts/release-readiness.test.mjs
```

The CLI needs only Node built-ins; its tests use the existing Vitest dev dependency.
The script reads only six allowlisted public source
files, with a 128 KiB limit per file. It rejects links within those input paths,
special files and missing/unreadable inputs. It does not read environment variables,
credentials, provisioning profiles, local Firebase configuration, generated artifacts
or user data. It starts no subprocess and performs no network or write operation.
A caller must point `--root` at a trusted checkout, not a concurrently mutated tree.

Exit 0 means the source assertions pass. Exit 1 means a source check failed. Exit 2
means CLI usage was invalid. Pending evidence is printed even with exit 0. JSON says
`releaseReady: null` and `readiness: "evidence-pending"`; neither release success nor
failure is certified. Non-string `package.version` values fail before regex matching,
including single-element arrays JavaScript would otherwise coerce into version strings.
The script cannot accept human attestations or deploy anything. It is a stable-release source check;
prerelease versions fail the version-range assertion.

The checks catch Android version collisions from minor/patch values at or above 100,
versionCode overflow, shared App Group/keychain drift, missing widget embedding and
target identity/entitlement references, profile-validator policy marker drift and
Android app identity/signing-reference drift. These are text assertions, not complete
PBX/Groovy/Python/XML semantic validators. The iOS source-wiring assertion does not
prove target dependency graph correctness. The profile policy assertion does not
prove validator behavior; the synthetic validator run above supplies separate local
evidence. Artifact signature checks and real platform execution remain separate gates.

## Release gaps and owner actions

| Area | Public evidence at this commit | Classification and precise next action |
| --- | --- | --- |
| iOS widgets and signing | App and TauWidgets source entitlements share `group.de.tbuck.tau` and `$(AppIdentifierPrefix)de.tbuck.tau.shared`. PBX references both bundle IDs, entitlement paths and widget embedding. Release workflow sets `TAU_IOS_WIDGETS: "1"`. | Signing evidence missing. Release owner must validate two App Store profiles for `de.tbuck.tau` and `de.tbuck.tau.widgets`, team `V4MWQ28RZ2`, matching App Group and shared keychain access, unexpired and without development/ad-hoc device grants. App profile must allow production push. Do this in the approved signing environment, not on this agent's Mac. |
| iOS profile preflight | `ios-profiles.py` validates every supplied profile before installation and selects per target. Neither profile supplied permits automatic signing; one supplied with widgets enabled fails. Release `preflight` checks Apple API credentials but does not require the widget profile or distribution certificate. | Late-failure risk, not proof of unusable automatic signing. Owner must choose valid manual signing with both profiles or verify automatic signing with sufficient Apple permissions and configured App IDs/groups. Consider an early signing-mode gate in a separately authorized workflow change. This lane did not edit it. |
| Widget secret status | September 30 implementation report said `IOS_WIDGET_PROFILE` was missing. | Historical blocker only. Current secret presence and values are unknown. An authorized release administrator must verify presence and valid signing mode without posting values. No secret listing or secret read was performed here. |
| Source APNs entitlement | App source has `aps-environment` = `development`; profile validator requires `production` for store metadata. | Source is not final signed entitlement evidence. Inspect the exported signed app's entitlements and embedded profile in approved CI; verify production APNs with the signed test build. Do not infer production delivery from simulator compilation or source alone. |
| iOS device behavior | Source plist enables Live Activities, camera and microphone descriptions; September report records unsigned simulator builds. | Physical iOS 17.2+ and iOS 26 QA pending. Human runs the device checklist with signed builds, including remote starts after termination, opt-out/revocation, dictation cancellation and widget refresh. Provider acceptance is not display proof. |
| Android | Release Gradle signing is conditional on upload keystore; Firebase plugin is conditional. Workflow requires Firebase app configuration for `de.tbuck.tau`, checks signature and app metadata, builds APK/AAB. September report records Java compilation. | Signed APK/AAB, Play processing and physical device evidence absent here. Owner verifies distribution-specific certificate, package/version, matching Firebase Android app, notification consent and background delivery; runs the new Android checklist. Sideloaded APKs do not self-update. |
| Windows | NSIS packaging exists, stable installer GUID and shortcut identity wiring are configured. No Authenticode block is configured. Manual `windows.yml` runs a native subset, build and isolated smokes. | Build/archive evidence is not Windows app evidence. With approval, dispatch the Windows workflow at the candidate commit with `full-suite=false`, retain run/artifact evidence, then use a disposable Windows VM and own dev instance for terminal/ConPTY, worktrees, notifications, process cleanup, install/upgrade and attached-session checks. Unsigned installer/SmartScreen remains an explicit release policy decision. |
| WSL | September report records injected executor/pairing coverage; docs require systemd, `wslpath`, tar, OpenSSL and localhost forwarding for the signed portable Linux host. | Real WSL remains untested. Human uses a disposable WSL2 distro already configured with systemd, verifies signed bootstrap for its architecture, pairing, Linux workspace paths, restart/reconnect and removal. Do not enable WSL/systemd or mutate the user's distro as an agent check. |
| Linux | CI includes `smoke:display`; release config packages AppImage/deb, update helper/polkit and platform resources. September report records fake KWin/Hyprland transport tests, including descriptor transfer. | Real X11 and GNOME/KDE/Hyprland/Niri evidence pending. Human uses disposable supported desktop environments, tests helper consent/install/remove, mixed-scale capture identity, denial/cancellation cleanup, portal fallback and shortcuts. Separately verify AppImage/deb install/upgrade and polkit behavior. Fixtures cannot certify a compositor. |
| Desktop and portable releases | Release workflow builds macOS arm64/x64, Linux x64 and Windows x64 plus Linux arm64 portable hosts; signs release feeds and smoke-checks extracted hosts. | Candidate artifacts not built here. With separate resource approval, run nonpublishing platform CI, check exact commit and all installer/portable archives, architecture/native files, feeds/signatures and install/upgrade. A branch dry run is unsigned; a main dry run uses signing resources. Neither was dispatched here. |
| Connect | September report explicitly deferred managed public service because of cost. Existing SSH/Tailscale/self-hosted routes remain. | Operator decision, not a local release script fix. Decide whether managed service is required before provisioning or deployment. No public Connect availability claim, cloud resource creation or relay deployment in this lane. |
| Accounts and credits | Earlier implementation evidence is fixture-based; current authority excludes real switching and consumption. | Human/account-owner authorization required for any real action. Use disposable authorized test accounts and record redacted results; never spend credits to complete this audit. |

## Historical evidence, not rerun

[The September 30 report](t3-parity-implementation-2026-09-30.md) records full-suite,
mobile slow-render, host smoke, browser TLS and packaging tests; builds; fake-runtime
isolated app checks; unsigned iOS widget compilation; and Android Java compilation.
Its follow-up desktop measurement was 496,393 gzip bytes against 500,000, only 3,607
bytes of reserve. That number is not a measurement of this commit. Recheck the unchanged
budget after dependencies are approved, do not widen it to make a release pass.

[Windows documentation](../windows.md) distinguishes the September 6 installer
archive inspection from native execution, and September 30 fixtures from real
Windows/WSL/compositor tests. No current remote CI status was queried here. Claims
that a manual workflow has or has not run remain dated statements from those documents.

## Remaining risks

The new preflight is intentionally narrow. A malicious or semantically broken source
file can retain expected markers and pass. Build output may be stale, native dependencies
may target the wrong architecture, profiles may expire, store build numbers may already
be used, provider configuration may be wrong, and platform behavior may differ from
fixtures. None of those is resolved by exit 0. The human blockers must stay visible
until candidate-specific signed-artifact and device/platform evidence is recorded.
Repository lint is a concrete local failure at this snapshot, separate from pending
external evidence. Ask the owning lanes to fix the three lint errors below or verify
whether newer parent commits already fixed them.

## Authorized dependency-backed follow-up

The parent authorized `npm ci --ignore-scripts` in this worktree. Root installed 928
packages, mobile 103, with `--no-audit --no-fund`, worktree-local npm home/cache,
empty user/global configs and the public registry. The installation environment was
cleared except for PATH, isolated HOME, TMPDIR and explicit npm settings. No user npm
config/credentials or shared node_modules were used. Lifecycle scripts remain disabled.
Node v22.23.1 satisfies installed Vite/Vitest engines and the Node 22 CI convention.

Two invocation failures were reported and retried with the same tools after recording
worktree status/diff under `.tau-dev`. npm initially rejected `/dev/null` as both user
and global config before dependency resolution; distinct empty files fixed that. The
first mobile test command named nonexistent `mobile/node_modules/vitest` and ran no
tests. The corrected command uses this worktree's root runner from the mobile cwd.
No alternate protocol or foreign checkout was used.

Every test/build command below unset `ESBUILD_BINARY_PATH`. All fixture runs were
sequential with `--maxWorkers=1`. No full suite, native build, Capacitor sync, signing,
store operation or CI dispatch ran.

### Exact fixture commands and results

```sh
env -u ESBUILD_BINARY_PATH node node_modules/vitest/vitest.mjs run --maxWorkers=1 \
  scripts/release-readiness.test.mjs scripts/packaging/ios-profiles.test.mjs \
  scripts/packaging/ios-widgets.test.mjs scripts/packaging/release-workflow.test.mjs \
  scripts/packaging/mobile-version.test.mjs
```

5 files, 30 passed. This executes the existing packaging tests and the new 9-test
CLI suite, including malformed `package.version` type rejection.

```sh
env -u ESBUILD_BINARY_PATH node node_modules/vitest/vitest.mjs run --maxWorkers=1 \
  src/main/wsl-host.test.ts src/main/platform-process.test.ts \
  src/main/shell-environment.test.ts kits/snapshots/wayland.test.ts \
  kits/snapshots/wayland-foreground.test.ts kits/snapshots/niri.test.ts
```

6 files, 54 passed, 4 Windows-native tests skipped on macOS. Injected platform
behavior only, no real Windows, WSL or Linux desktop.

```sh
env -u ESBUILD_BINARY_PATH node node_modules/vitest/vitest.mjs run --maxWorkers=1 \
  kits/push/activity-start.test.ts kits/push/mobile-activity.test.ts \
  kits/push/activity-bundle.test.ts
```

3 files, 11 passed. Synthetic activity/push fixtures, no provider delivery.

```sh
cd mobile
env -u ESBUILD_BINARY_PATH TAU_TEST_SLOW_RENDERS=30 node ../node_modules/vitest/vitest.mjs \
  run --maxWorkers=1 src/activity-start.test.ts src/activities.test.ts \
  src/activity-relay.test.ts src/widgets.test.ts src/native-dictation.test.ts \
  src/push.test.ts src/push-crypto.test.ts src/native-socket.test.ts
```

8 files, 44 passed. Web/native-adapter fixtures, no physical device.
Total across these four batches is 22 files, 139 passed, 4 skipped.

### Conventions, lint and mobile web build

| Command | Result |
| --- | --- |
| `env -u ESBUILD_BINARY_PATH npm test -- --maxWorkers=1 scripts/release-readiness.test.mjs` | 1 file, 9 passed, proving normal npm/Vitest discoverability and execution. These duplicate the CLI tests above, not additional unique tests. |
| `node_modules/.bin/oxlint scripts/release-readiness.mjs scripts/release-readiness.test.mjs` | Pass, no warnings or errors. |
| `env -u ESBUILD_BINARY_PATH npm run lint` | Fails on 3 errors in untouched files: `src/renderer/workspace-resource-context.test.tsx:63`, `kits/workspace/host.test.ts:107` both `no-shadow`; `src/renderer/components/Markdown.tsx:298` `no-useless-escape`. Existing warnings remain. Not changed outside ownership. |
| `env -u ESBUILD_BINARY_PATH npm --prefix mobile run typecheck` | Pass. |
| `env -u ESBUILD_BINARY_PATH npm --prefix mobile run build` | Release web-layer build passes in 3.98 s; Vite warns about chunks over 500 kB. Not an APK or iOS archive. |
| Node built-in scan of `mobile/dist/assets/*.js` for `tauAutomation` | 105 JS assets, 0 matches. Marker check only, not full artifact security or signing. |
| `node scripts/release-readiness.mjs --json`, `git diff --check` | Six source checks pass with release evidence pending; whitespace check passes. |

Logs are retained under `.tau-dev`: `npm-ci.log`, `mobile-npm-ci.log`,
`packaging-tests.log`, `platform-tests.log`, `push-tests.log`, `mobile-tests.log`,
`cli-convention-tests.log`, `lint.log`, `mobile-typecheck.log`, `mobile-build.log` and
`release-readiness.json`.

The parent reports release PR #33 green and merged, and a nightly at `ffc3d481` in
flight. These are parent-supplied status, not queried or verified here. Neither
contains these uncommitted lane changes or certifies this older `cb3b143e` snapshot.
This audit does not assert a current missing widget secret or failed release.
