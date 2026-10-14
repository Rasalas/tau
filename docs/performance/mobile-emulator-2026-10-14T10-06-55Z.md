# Android emulator timings, 2026-10-14T10:06:55.324Z

Source commit: `c0da75997db539bfde20593733ebf120568ccb8c` with local changes. App 0.7.42, build 74200.
APK SHA-256: `937dc0f3de93552c96c67627953038fb72d74784d459863665735258ade3e626`.
AVD: tau_play_review. API 36. Image: `google/sdk_gphone64_arm64/emu64a:16/BP22.250325.006/13344233:user/release-keys`. WebView: com.google.android.webview 154.0.8037.106.
Rounds per target: 5 + 1 warm-up. Warm-up excluded from statistics. Each target gets its own cold start.

| Thread | Metric, ms | Median | Min–max | Samples |
| --- | --- | ---: | ---: | ---: |
| short | Native TotalTime | 1184.0 | 922.0–2400.0 | 5 |
| short | WebView origin → usable list paint | 1377.2 | 1138.9–1904.7 | 5 |
| short | Launch command → list observed | 2410.6 | 2207.5–4515.5 | 5 |
| short | Cold tap → newest reply paint | 905.6 | 439.2–1535.3 | 5 |
| short | Warm tap → newest reply paint | 58.1 | 26.6–139.4 | 5 |
| long | Native TotalTime | 1051.0 | 650.0–1742.0 | 5 |
| long | WebView origin → usable list paint | 1024.4 | 977.4–5925.2 | 5 |
| long | Launch command → list observed | 2051.5 | 1551.9–8136.9 | 5 |
| long | Cold tap → newest reply paint | 1030.6 | 669.5–3103.7 | 5 |
| long | Warm tap → newest reply paint | 86.7 | 22.2–125.7 | 5 |

Load before: 12:06  up 7 days, 12:24, 2 users, load averages: 7.60 9.79 8.82
Load after: 12:08  up 7 days, 12:26, 2 users, load averages: 22.63 14.15 10.56


## Environment

- Host: Mac16,10, Apple M4 (10 cores), 16 GB, macOS 27.0.1, arm64. The emulator ran hardware-accelerated and headless (`-no-window -no-audio -no-snapshot`) next to other desktop work, and the Mac's one-minute load was 7.6 before the run. The load after the run includes the emulator's own four cores.
- Emulator 35.5.10.0, `tau_play_review`: Android 16, API 36, `google_apis_playstore` arm64-v8a image, 4 cores, 2 GB RAM, software-drawn graphics (`hw.gpu.enabled = no`), 1080 × 2400 at 420 dpi.
- App: development APK built from `308d2c4af` (the later commits change only `mobile/scripts` and docs). Paired with an isolated headless test host over `adb reverse`, no model, no login. Synthetic threads: short 3 turns, long 40 turns.
- The Play Store was disabled after boot so that no background update restarts the app. An earlier boot-time WebView update (133 to 154) had killed the app once; this run starts after it.
- Repeat run two minutes later, while Spotlight and a security scan were busy on the Mac (`mds_stores`, `XProtectRemediator` at 50 to 90 % CPU in `top` around that time). Rounds 2 and 3 have the slow samples (list up to 5.9 s, cold open up to 3.1 s); the medians stay close to the first run.

Cold means force-stop with paired storage and bundle caches retained. The host stays running; its caches can warm across rounds. Warm means reopening the same thread in the same app process.

WebView timings use performance.timeOrigin and performance.now. Paint is estimated by requestAnimationFrame followed by a task, with visibility and hit testing. Launch-to-observed includes bridge polling and transport latency and is an upper bound. These are emulator measurements, not physical device evidence.

Runbook: [mobile emulator measurement](../mobile-emulator-measurement.md). Raw samples, warm-up rounds included, are in the JSON file of the same name.
