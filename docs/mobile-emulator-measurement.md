# Android emulator measurement

Ticket 62 uses the Android emulator, following the owner's 2026-10-13 decision.
The measurement tool is ready; timings are pending a run on a quiet machine.
No emulator, native app or desktop instance was started to implement it.

The script measures an already running `tau_play_review` AVD with a paired
development APK. It never boots an emulator, builds or installs an APK, pairs a
device, starts a host or sends a prompt. It force-stops and relaunches only
`de.tbuck.tau` on the selected emulator. Release APKs have no automation bridge.

## Prepare on a quiet machine

Run from this worktree's root in one shell. Prerequisites are the installed Android
SDK tools on `PATH`, Java, local npm dependencies for the root and `mobile/`, and
the existing `tau_play_review` AVD. Check `emulator -list-avds` if needed. Do not
use a physical device. Let other builds finish first and check `uptime`; prefer a
one-minute load below 4 throughout the run. The tool records load rather than
silently accepting it as quiet.

Build before starting the emulator, then allow the machine to settle:

```sh
uptime
npm run build
(cd mobile && node scripts/native-build.mjs android --dev)
```

Seed synthetic Pi sessions through the comparison harness's existing
`writeAgentPiThread` writer. This writes stored history; no runtime turn runs.
The short thread has 3 turns, the long one 40, both with Markdown, tool records
and a known final reply. A separate one-turn starter is newest, so bootstrap
opens that thread rather than preloading either measured target.

```sh
node mobile/scripts/measure.mjs seed --test-host mobile-measure
node scripts/tau-test-host.mjs start --name mobile-measure --kits --no-login \
  --port 9488 --workspace "$PWD/.tau-dev/mobile-measure/workspace"
node scripts/tau-test-host.mjs status --name mobile-measure
```

This is an isolated headless Tau instance. Its data, session store, configuration
and runtime homes belong to this worktree. `--no-login` leaves it signed out and
avoids linking a real login. No desktop window is needed. Do not use `--fresh`
after seeding: that would remove the sessions. On subsequent runs, reuse the
fixtures and omit the seed command. The paths of the seeded sessions are in
`.tau-dev/mobile-measure/sessions.json`; remove only those files and
`.tau-dev/mobile-measure/targets.json` if reseeding is necessary.

Start the automation bridge and the AVD. These PID variables belong to the
processes started here; keep the same shell for cleanup.

```sh
node mobile/scripts/sim.mjs serve > .tau-dev/mobile-measure/bridge.log 2>&1 &
tau_measure_bridge_pid=$!
emulator -avd tau_play_review -port 5554 -no-snapshot -no-boot-anim \
  -no-window -no-audio > .tau-dev/mobile-measure/emulator.log 2>&1 &
tau_measure_emulator_pid=$!
adb -s emulator-5554 wait-for-device
while [ "$(adb -s emulator-5554 shell getprop sys.boot_completed | tr -d '\r')" != 1 ]; do sleep 1; done
adb -s emulator-5554 install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 reverse tcp:9488 tcp:9488
adb -s emulator-5554 shell am start -W -n de.tbuck.tau/.MainActivity
node mobile/scripts/sim.mjs wait-for 'text().length > 0' 60000
```

Port 9488 is reversed so the app can reach the isolated host's loopback listener.
The existing automation bridge reaches the Mac at `10.0.2.2:9477`. Only one
virtual app should connect to that bridge. If using another bridge port, set
`TAU_AUTOMATION_PORT` for the Dev-APK build and bridge process, and pass
`--bridge-port` to the measurement script.

## Pair once

Create and paste a single-use link through the existing helpers. This snippet
keeps the link out of the terminal and saved reports. If the app is already
paired, skip this section and return to the Threads list.

```sh
node mobile/scripts/sim.mjs eval 'tap(document.querySelector("[aria-label=\"Add machine\"]"))'
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
const link = JSON.parse(execFileSync(process.execPath, [
  'scripts/tau-mobile-cdp.mjs', 'link', '--test-host=mobile-measure',
  '--label', 'Mobile measurement', '--via', 'http://127.0.0.1:9488',
], { encoding: 'utf8' }));
const expr = `type(document.querySelector('textarea'), ${JSON.stringify(link.url)})`;
execFileSync(process.execPath, ['mobile/scripts/sim.mjs', 'eval', expr], { stdio: 'pipe' });
NODE
node mobile/scripts/sim.mjs eval 'tap(byText("button", /^Connect$/))'
node mobile/scripts/sim.mjs wait-for 'document.querySelector("[aria-label=\"Code to compare\"]")?.textContent' 30000
node scripts/tau-mobile-cdp.mjs host connections-list --test-host=mobile-measure
```

Compare the six digits in the app with the request labeled `Mobile measurement`.
Only when they agree, replace `REQUEST_ID` below with that request's id and allow it:

```sh
node scripts/tau-mobile-cdp.mjs host connections-approve '["REQUEST_ID",{}]' --test-host=mobile-measure
node mobile/scripts/sim.mjs wait-for '!!document.querySelector(".touch-browser.home .touch-thread-open")' 60000
```

The same fixture targets work with a running `dev:instance` whose isolated
session store was seeded by `node mobile/scripts/measure.mjs seed` without
`--test-host`. Pair with that instance as described in
[testing the app](agents/testing-the-app.md#the-phone-pair-prompt-reconnect),
reverse its own host port, and omit `--test-host` when measuring. Do not wipe its
session store after seeding.

## Measure and commit the evidence

Wait until boot and build activity has settled, then run:

```sh
uptime
node mobile/scripts/measure.mjs --test-host mobile-measure --runs 5 --warmup 1
```

Equivalent npm entry point: `npm --prefix mobile run measure -- --test-host
mobile-measure --runs 5 --warmup 1`. `--serial` selects another emulator serial;
`--avd` checks its AVD name. `--timeout-ms` changes the per-operation deadline.
`--help` performs no device or host calls.

Each round gives each available target its own force-stop and cold launch, then
opens it once, goes Back to threads, and opens it again in the same WebView.
The default is 1 warm-up plus 5 measured rounds per target, so two targets cause
12 launches. Missing targets are listed as skipped; zero targets is an error.
Timeouts, reused native activities, mismatched APKs and WebView reloads fail the
run. Failed runs produce no successful summary.

The tool checks the installed APK's SHA-256 against this worktree's debug APK,
records installed versionName/versionCode, Git commit and dirty state, image
fingerprint, API level, Android/model/emulator version, and `uptime` plus numeric
load averages before and after. JSON contains every raw sample including warm-up.
The Markdown table contains measured samples only, their median and min/max.

Outputs use a UTC timestamp to avoid overwriting earlier runs:

- `reports/mobile-<timestamp>.json`
- `docs/performance/mobile-emulator-<timestamp>.md`

Inspect both files, check load and skipped targets, and record environmental
notes such as CPU architecture and competing work in the Markdown. Commit the
actual generated filenames. Reports are ignored by default, so add the chosen
JSON explicitly:

```sh
git add -f reports/mobile-<timestamp>.json
git add docs/performance/mobile-emulator-<timestamp>.md
git commit -m "docs(performance): record Android emulator timings"
```

For other synthetic sessions, supply `--targets file.json` with an array of
`{ "size": "short" | "long", "title": "exact list title", "text": "unique text
from the newest answer", "turns": 3 }`. Use distinct titles and final-answer
text. Do not use personal threads or put pairing payloads or tokens in reports.
The default targets use `.tau-dev/mobile-measure/targets.json` if present.

## What the times mean

`TotalTime` comes from `adb shell am start -W`; it is Android's native launch
metric. It does not mean the thread list is usable.

In virtual development builds, the list observer starts before React mounts.
It marks `tau.mobile.list-painted` once a visible, enabled thread row can be hit,
the reconnect band is absent, and a frame followed by a task has passed. The
script reads that mark relative to `performance.timeOrigin` in the WebView.
This remains a paint estimate, not a compositor trace. A shell navigation may
create another WebView document; this value belongs to the final document.
The development bridge import now completes before mount, which adds its own
development overhead to the measurement. Production builds do not load it.

The separate launch-command-to-list-observed number includes native startup,
document changes, bridge reconnection and 100 ms polling. Treat it as an upper
bound for the entire launch. Do not add it to `TotalTime` or the WebView value.
Thread times start immediately before the bridge's touch helper dispatches the
tap. They stop after the known newest answer and composer are visible, uncovered
and painted, with the target thread id in the URL. Empty chat shells and older
answers cannot satisfy the probe.

Force-stop retains pairing, bundle caches and persistent bootstrap data. The
host stays running and can warm its own caches across rounds. These numbers
measure app process cold starts and first client opens, not a fresh installation
or host cold start. They do not establish performance on a physical phone or
over a mobile network. The IndexedDB cache remains unchanged.

## Clean up

```sh
adb -s emulator-5554 reverse --remove-all
adb -s emulator-5554 emu kill
wait "$tau_measure_emulator_pid"
kill "$tau_measure_bridge_pid"
wait "$tau_measure_bridge_pid"
node scripts/tau-test-host.mjs stop --name mobile-measure
```

The host helper validates its recorded PID before stopping it. If the emulator
does not exit after `emu kill`, signal only `$tau_measure_emulator_pid` from this
shell. Keep the fixtures for repeat runs. No broad process-kill command is needed.
