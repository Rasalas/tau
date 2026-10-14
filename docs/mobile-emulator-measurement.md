# Android emulator measurement

`mobile/scripts/measure.mjs` times the Android app's cold start and the opening of a
thread in the `tau_play_review` emulator. It measures an already running AVD with a
paired development APK. It never boots an emulator, builds or installs an APK, pairs a
device, starts a host or sends a prompt. It force-stops and relaunches only
`de.tbuck.tau` on the selected emulator. Release APKs have no automation bridge.

Emulator numbers are not device numbers: they come from the Mac's CPU, a software-drawn
screen and loopback networking. Use them to compare builds on one machine, not to
promise anything about a phone. The dated results are in
[PERFORMANCE.md](PERFORMANCE.md#android-emulator-cold-start-and-thread-opening).

## Prerequisites

Run everything from the repository root in one shell. You need the Android SDK with
`ANDROID_HOME` set and its `emulator` and `platform-tools` on `PATH`, Java, npm
dependencies for the root and `mobile/` (`npm ci`, `(cd mobile && npm ci)`), and the
`tau_play_review` AVD (`emulator -list-avds`). Address the emulator as
`adb -s emulator-5554` every time; a real phone may be attached to the same Mac and
must stay untouched. In a fresh worktree the Android build may first need
`mkdir -p mobile/android/app/src/main/assets && (cd mobile && npx cap update android)`;
revert `mobile/android/capacitor.settings.gradle` afterwards.

Let other builds finish first and check `uptime`. The tool records the load average
before and after rather than accepting it silently. A cold-booted AVD is unusable on a
heavily loaded machine (system services die), and on a busy one the numbers mostly
measure the load.

## Prepare

Build before starting the emulator, then stop Gradle's daemon so it does not hold
memory during the run:

```sh
uptime
npm run build
(cd mobile && node scripts/native-build.mjs android --dev)
(cd mobile/android && ./gradlew --stop)
```

Seed synthetic Pi sessions through the comparison harness's `writeAgentPiThread` writer.
This writes stored history; no runtime turn runs. The short thread has 3 turns, the long
one 40, both with Markdown, tool records and a known final reply. A separate one-turn
starter is newest, so bootstrap opens that thread rather than preloading either measured
target.

```sh
node mobile/scripts/measure.mjs seed --test-host mobile-measure
node scripts/tau-test-host.mjs start --name mobile-measure --kits --no-login \
  --port 9488 --workspace "$PWD/.tau-dev/mobile-measure/workspace"
node scripts/tau-test-host.mjs status --name mobile-measure
```

This is an isolated headless Tau instance. Its data, session store, configuration and
runtime homes belong to this worktree. `--no-login` leaves it signed out and avoids
linking a real login. No desktop window is needed. Do not use `--fresh` after seeding:
that would remove the sessions. On later runs reuse the fixtures and omit the seed
command. The seeded sessions are listed in `.tau-dev/mobile-measure/sessions.json`; to
reseed, remove only those files and `.tau-dev/mobile-measure/targets.json`.

Start the automation bridge and the AVD. The PID variables belong to the processes
started here; keep the same shell for cleanup.

```sh
node mobile/scripts/sim.mjs serve > .tau-dev/mobile-measure/bridge.log 2>&1 &
tau_measure_bridge_pid=$!
emulator -avd tau_play_review -port 5554 -no-snapshot -no-boot-anim \
  -no-window -no-audio > .tau-dev/mobile-measure/emulator.log 2>&1 &
tau_measure_emulator_pid=$!
adb -s emulator-5554 wait-for-device
while [ "$(adb -s emulator-5554 shell getprop sys.boot_completed | tr -d '\r')" != 1 ]; do sleep 1; done
adb -s emulator-5554 shell pm disable-user --user 0 com.android.vending
adb -s emulator-5554 install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 reverse tcp:9488 tcp:9488
adb -s emulator-5554 shell am start -W -n de.tbuck.tau/.MainActivity
node mobile/scripts/sim.mjs wait-for 'text().length > 0' 60000
```

The image has the Play Store, which updates Chrome, Play services and the system
WebView in the background for several minutes after boot. That keeps the emulator at
several cores, and a WebView update restarts the app (`stop com.google.android.webview
due to installPackageLI` in `adb logcat`). Disabling the Play Store right after boot
prevents it. The AVD's data partition is temporary, so the change is gone at the next
boot and has to be repeated. The report names the WebView version in use.

Port 9488 is reversed so the app can reach the isolated host's loopback listener. The
automation bridge reaches the Mac at `10.0.2.2:9477`. Only one virtual app should connect
to that bridge. With another bridge port, set `TAU_AUTOMATION_PORT` for the dev APK build
and the bridge process, and pass `--bridge-port` to the measurement script.

## Pair once

The AVD keeps app data between runs. If the app shows "Restoring connection…" and has no
**Add machine** button, an older pairing with another host is still stored: run
`adb -s emulator-5554 shell pm clear de.tbuck.tau`, reverse the port again and relaunch
the app. If it is already paired with this host, skip this section.

Create and paste a single-use link through the existing helpers. This keeps the link out
of the terminal and the saved reports.

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

Compare the six digits in the app with the request labeled `Mobile measurement`. Only
when they agree, replace `REQUEST_ID` with that request's id and allow it:

```sh
node scripts/tau-mobile-cdp.mjs host connections-approve '["REQUEST_ID",{}]' --test-host=mobile-measure
node mobile/scripts/sim.mjs wait-for '!!document.querySelector(".touch-browser.home .touch-thread-open")' 60000
```

The same fixture targets work with a running `dev:instance` whose isolated session store
was seeded by `node mobile/scripts/measure.mjs seed` without `--test-host`. Pair with
that instance as described in
[testing the app](agents/testing-the-app.md#the-phone-pair-prompt-reconnect), reverse its
own host port, and omit `--test-host` when measuring. Do not wipe its session store after
seeding.

## Measure

A fresh boot, install and pairing keep the machine and the emulator busy for a few
minutes (dex optimization, bootstrap, system updates). Wait until the one-minute load is
low and the emulator is idle (`adb -s emulator-5554 shell top -b -n 1 -m 5` shows mostly
idle cores); the emulator itself adds three to four cores of load while it works, so the
load after a run is higher than before. The tool needs the app open on the thread list,
so launch it and wait for a thread row first. Then run:

```sh
adb -s emulator-5554 shell am start -W -n de.tbuck.tau/.MainActivity
node mobile/scripts/sim.mjs wait-for '!!document.querySelector(".touch-browser.home .touch-thread-open")' 60000
uptime
node mobile/scripts/measure.mjs --test-host mobile-measure --runs 5 --warmup 1
```

A run of 5 + 1 rounds takes about two minutes. Background work on the Mac (Spotlight
indexing, security scans, other apps) shows up as single slow samples, so repeat the run
and compare medians rather than trusting one.

Equivalent npm entry point: `npm --prefix mobile run measure -- --test-host
mobile-measure --runs 5 --warmup 1`. `--serial` selects another emulator serial; `--avd`
checks its AVD name. `--timeout-ms` changes the per-operation deadline. `--help`
performs no device or host calls.

Each round gives each available target its own force-stop and cold launch, then opens it
once, goes Back to threads, and opens it again in the same WebView. The default is 1
warm-up plus 5 measured rounds per target, so two targets cause 12 launches. Missing
targets are listed as skipped; zero targets is an error. Timeouts, reused native
activities, mismatched APKs and WebView reloads fail the run. Failed runs produce no
successful summary.

The tool checks the installed APK's SHA-256 against this worktree's debug APK and records
the installed versionName and versionCode, the Git commit and dirty state, the image
fingerprint, API level, Android version, model and emulator version, and `uptime` plus
numeric load averages before and after. The JSON contains every raw sample including
warm-up. The Markdown table contains measured samples only, with their median and
min/max.

For other synthetic sessions, supply `--targets file.json` with an array of
`{ "size": "short" | "long", "title": "exact list title", "text": "unique text from the
newest answer", "turns": 3 }`. Use distinct titles and final-answer text. Do not use
personal threads or put pairing payloads or tokens in reports. Without `--targets` the
tool reads `.tau-dev/mobile-measure/targets.json` if present.

## Record the results

Outputs use a UTC timestamp, so earlier runs are never overwritten:

- `reports/mobile-<timestamp>.json`
- `docs/performance/mobile-emulator-<timestamp>.md`

Inspect both files, check the load and any skipped targets, and add environmental notes
to the Markdown: host machine and CPU architecture, emulator hardware (cores, memory,
graphics mode) and competing work. `reports/` stays ignored; copy the raw JSON next to
its Markdown, then add a short dated paragraph to the phone section of
[PERFORMANCE.md](PERFORMANCE.md):

```sh
cp reports/mobile-<timestamp>.json docs/performance/mobile-emulator-<timestamp>.json
git add docs/performance/mobile-emulator-<timestamp>.* docs/PERFORMANCE.md
git commit -m "docs(perf): check in Android emulator start and thread timings"
```

## What the times mean

`TotalTime` comes from `adb shell am start -W`; it is Android's native launch metric. It
does not mean the thread list is usable.

In virtual development builds, the list observer starts before React mounts. It marks
`tau.mobile.list-painted` once a visible, enabled thread row can be hit, the reconnect
band is absent, and a frame followed by a task has passed. The script reads that mark
relative to `performance.timeOrigin` in the WebView. This is a paint estimate, not a
compositor trace. A shell navigation may create another WebView document; the value
belongs to the final document. The development bridge import completes before mount,
which adds its own overhead; production builds do not load it.

The separate launch-command-to-list-observed number includes native startup, document
changes, bridge reconnection and 100 ms polling. Treat it as an upper bound for the whole
launch. Do not add it to `TotalTime` or the WebView value.

Thread times start immediately before the bridge's touch helper dispatches the tap. They
stop after the known newest answer and composer are visible, uncovered and painted, with
the target thread id in the URL. Empty chat shells and older answers cannot satisfy the
probe.

Force-stop retains pairing, bundle caches and persistent bootstrap data. The host stays
running and can warm its own caches across rounds. These numbers measure app process cold
starts and first client opens, not a fresh installation or a host cold start. They do
not establish performance on a physical phone or over a mobile network. The IndexedDB
cache is left as it is.

## Clean up

```sh
adb -s emulator-5554 reverse --remove-all
adb -s emulator-5554 emu kill
wait "$tau_measure_emulator_pid"
kill "$tau_measure_bridge_pid"
wait "$tau_measure_bridge_pid"
node scripts/tau-test-host.mjs stop --name mobile-measure
(cd mobile/android && ./gradlew --stop)
```

The host helper validates its recorded PID before stopping it. If the emulator does not
exit after `emu kill`, signal only `$tau_measure_emulator_pid` from this shell. Keep the
fixtures for repeat runs. No broad process-kill command is needed. Afterwards check with
`ps` that no emulator, bridge, test host or Gradle daemon of yours remains.
