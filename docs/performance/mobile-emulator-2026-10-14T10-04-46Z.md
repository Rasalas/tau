# Android emulator timings, 2026-10-14T10:04:46.150Z

Source commit: `c0da75997db539bfde20593733ebf120568ccb8c`. App 0.7.42, build 74200.
APK SHA-256: `937dc0f3de93552c96c67627953038fb72d74784d459863665735258ade3e626`.
AVD: tau_play_review. API 36. Image: `google/sdk_gphone64_arm64/emu64a:16/BP22.250325.006/13344233:user/release-keys`. WebView: com.google.android.webview 154.0.8037.106.
Rounds per target: 5 + 1 warm-up. Warm-up excluded from statistics. Each target gets its own cold start.

| Thread | Metric, ms | Median | Min–max | Samples |
| --- | --- | ---: | ---: | ---: |
| short | Native TotalTime | 1078.0 | 1004.0–1406.0 | 5 |
| short | WebView origin → usable list paint | 1140.4 | 929.1–1148.6 | 5 |
| short | Launch command → list observed | 2351.5 | 2064.9–2675.7 | 5 |
| short | Cold tap → newest reply paint | 931.0 | 741.1–2369.3 | 5 |
| short | Warm tap → newest reply paint | 31.2 | 22.0–46.0 | 5 |
| long | Native TotalTime | 917.0 | 804.0–1740.0 | 5 |
| long | WebView origin → usable list paint | 1100.0 | 948.5–1632.3 | 5 |
| long | Launch command → list observed | 2081.4 | 1755.2–3850.6 | 5 |
| long | Cold tap → newest reply paint | 1004.4 | 969.3–1362.4 | 5 |
| long | Warm tap → newest reply paint | 48.6 | 35.3–80.2 | 5 |

Load before: 12:04  up 7 days, 12:22, 2 users, load averages: 8.17 9.44 8.46
Load after: 12:05  up 7 days, 12:23, 2 users, load averages: 15.39 11.38 9.24


## Environment

- Host: Mac16,10, Apple M4 (10 cores), 16 GB, macOS 27.0.1, arm64. The emulator ran hardware-accelerated and headless (`-no-window -no-audio -no-snapshot`) next to other desktop work, and the Mac's one-minute load was 8.2 before the run. The load after the run includes the emulator's own four cores.
- Emulator 35.5.10.0, `tau_play_review`: Android 16, API 36, `google_apis_playstore` arm64-v8a image, 4 cores, 2 GB RAM, software-drawn graphics (`hw.gpu.enabled = no`), 1080 × 2400 at 420 dpi.
- App: development APK built from `308d2c4af` (the later commits change only `mobile/scripts` and docs). Paired with an isolated headless test host over `adb reverse`, no model, no login. Synthetic threads: short 3 turns, long 40 turns.
- The Play Store was disabled after boot so that no background update restarts the app. An earlier boot-time WebView update (133 to 154) had killed the app once; this run starts after it.
- First run, the quieter one. The single slow cold open of the short thread (2369 ms) fell in round 3, the same round as the slowest native start of the long thread (1740 ms); medians are not affected.

Cold means force-stop with paired storage and bundle caches retained. The host stays running; its caches can warm across rounds. Warm means reopening the same thread in the same app process.

WebView timings use performance.timeOrigin and performance.now. Paint is estimated by requestAnimationFrame followed by a task, with visibility and hit testing. Launch-to-observed includes bridge polling and transport latency and is an upper bound. These are emulator measurements, not physical device evidence.

Runbook: [mobile emulator measurement](../mobile-emulator-measurement.md). Raw samples, warm-up rounds included, are in the JSON file of the same name.
