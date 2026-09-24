# Tau on your iPhone through TestFlight

The app in `mobile/` is built for the simulator by the repository's scripts and never
signed there. To use it on your own iPhone you sign it with your Apple Developer account,
upload it to App Store Connect and install it with TestFlight. Internal testing needs no
App Review; the build is available to you minutes after processing.

You need: a paid Apple Developer Program membership, Xcode 27 on this Mac, the iPhone
with the TestFlight app, and the repository with `npm ci` done at its root.

## 1. Build the web layer — a release build

```bash
cd mobile
npm install
npx vite build        # never `--mode development` for a device: that build contains the automation bridge
npx cap sync ios
grep -l tauAutomation dist/assets/*.js || echo "release build: no automation bridge"
```

The last line must print "release build: no automation bridge".

## 2. Your bundle identifier

The project uses `io.github.rasalas.tau`. A bundle identifier belongs to one team; if it
is taken, pick your own (for example `de.<you>.tau`) and change it in two places:

- `mobile/capacitor.config.json` → `appId`
- Xcode → target **App** → **Signing & Capabilities** → **Bundle Identifier**

## 3. Sign in Xcode

1. `open mobile/ios/App/App.xcodeproj`
2. Select the target **App** → **Signing & Capabilities**.
3. Turn on **Automatically manage signing** and choose your **Team**. Xcode creates the
   App ID and the provisioning profile.
4. Nothing else to add: the Keychain works without a capability, and the camera, local
   network and Bonjour texts are already in `Info.plist`. (Push, when F08 comes, adds the
   **Push Notifications** capability here.)
5. **General** → **Version** (for example `0.1.0`) and **Build** (`1`). Every upload needs
   a higher Build number.

## 4. Create the app in App Store Connect

[appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Apps** → **+** →
**New App**: platform iOS, a name (the store name must be unique across the App Store, so
"Tau" may be taken; "Tau Remote" or similar works, and the home screen still shows
"Tau"), the bundle identifier from step 2, any SKU, full access for you.

## 5. Archive and upload

1. In Xcode's toolbar pick the destination **Any iOS Device (arm64)**.
2. **Product** → **Archive**.
3. The Organizer opens: **Distribute App** → **TestFlight Internal Only** (or **App Store
   Connect** → **Upload**) → keep the defaults (automatic signing, upload symbols) →
   **Upload**.

`Info.plist` declares `ITSAppUsesNonExemptEncryption = NO` (the app uses only the
system's TLS), so App Store Connect asks no export compliance question.

The same from a terminal, if you prefer:

```bash
cd mobile/ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Release \
  -destination "generic/platform=iOS" -archivePath build/Tau.xcarchive \
  -allowProvisioningUpdates archive
cat > build/export.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>YOUR_TEAM_ID</string>
</dict></plist>
EOF
xcodebuild -exportArchive -archivePath build/Tau.xcarchive -exportOptionsPlist build/export.plist \
  -exportPath build/export -allowProvisioningUpdates
```

## 6. Install with TestFlight

1. App Store Connect → your app → **TestFlight**. The build shows "Processing" for a few
   minutes, then "Ready to Submit" or "Ready to Test".
2. **Internal Testing** → **+** → a group with yourself as tester → add the build.
3. On the iPhone, open the TestFlight invitation mail (or the TestFlight app) and tap
   **Install**.

## 7. First connection

1. On the Mac, in Tau: **Settings → Connections → Network access**, turn on **Local
   network** (home Wi-Fi) and/or **Tailscale** (on the way).
2. **Create link**. A QR code appears.
3. On the iPhone, open Tau → **+** (Add host) → **Scan QR code**. Allow the camera, and
   the local network when iOS asks.
4. The Mac's window shows "<your iPhone> wants to connect" with six digits; the phone
   shows six digits too. **Allow** only if they are the same.

On the same network the host also shows up in the app under **On this network**; a tap
asks it without a QR code, with the same digits.

Then go through `docs/mobile-device-checklist.md` once: LAN, Bonjour, QR, Tailscale,
background and reconnect, the terminal's key bar and review, on your own phone.

## When something is off

- **"None of this host's addresses can be reached from a phone"**: network access is off
  on the Mac, so the link names only the Mac's own loopback. Turn it on and create a new
  link.
- **"The host did not answer on any of its addresses"**: the phone is not on the same
  network, Tailscale is off on the phone, or the Mac sleeps (Settings → Connections →
  "Keep this machine awake while turns run").
- **Nothing under "On this network"**: iOS Settings → Privacy & Security → Local Network →
  Tau must be on.
- **"… answered with another key …"**: the Mac's key changed (its `tls/host-key.pem` was
  lost, or you switched to a certificate of your own). A renewal keeps the key and does
  not cause this. Remove the host in the app (trash icon), revoke the old device on the
  Mac, and scan a new code.
- **Signed out**: the Mac revoked the phone or it went unused past its timeout (Settings
  → Connections shows both). Open the host in the app to ask again.

## Android

There is no Play Store build yet. For your own phone: `node mobile/scripts/native-build.mjs
android` writes a debug APK (`mobile/android/app/build/outputs/apk/debug/app-debug.apk`),
which `adb install` puts on a phone with USB debugging on. A Play Store build needs your
own upload key in Android Studio (**Build → Generate Signed App Bundle**).
