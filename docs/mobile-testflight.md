# Tau on your iPhone through TestFlight

The app in `mobile/` is built for the simulator by the repository's scripts and never
signed there. Every release from 0.7.16 on uploads Tau's own build to TestFlight and
Play's internal testing by itself ([RELEASE.md](RELEASE.md#phone-apps)); this guide is
for a build of your own. To use it on your own iPhone you sign it with your Apple Developer account,
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

The project uses `de.tbuck.tau`. A bundle identifier belongs to one team; if it
is taken, pick your own (for example `com.<you>.tau`) and change it in two places:

- `mobile/capacitor.config.json` → `appId`
- Xcode → target **App** → **Signing & Capabilities** → **Bundle Identifier**

## 3. Sign in Xcode

1. `open mobile/ios/App/App.xcodeproj`
2. Select the target **App** → **Signing & Capabilities**.
3. Turn on **Automatically manage signing** and choose your **Team**. Xcode creates the
   App ID and the provisioning profile.
4. Check that **Push Notifications** is listed among the capabilities. The project
   already carries it (`App/App.entitlements`), and automatic signing turns it on for
   your App ID; if it is missing, **+ Capability** → **Push Notifications**. Nothing else
   to add: the Keychain works without a capability, and the camera, local network and
   Bonjour texts are already in `Info.plist`.
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

## 8. Push notifications

Your phone hears of a thread that finished, failed, asks you something or hands over to
you ("your turn") while you are not at Tau. There is no relay: the Mac sends them
itself, to Apple for the iPhone and to Google for Android, with keys of your own. You
set them up once.

### iPhone: an APNs key

1. [developer.apple.com/account](https://developer.apple.com/account) → **Certificates,
   Identifiers & Profiles** → **Keys** → **+**.
2. A name ("Tau push"), tick **Apple Push Notifications service (APNs)** → **Configure**:
   environment **Sandbox & Production**, restriction **Team Scoped (All Topics)** →
   **Save** → **Continue** → **Register**.
3. **Download** the `.p8` file. Apple lets you download it once; keep it somewhere safe.
   Note the **Key ID** on that page (10 characters).
4. Your **Team ID** is under **Membership details** (10 characters).
5. On the Mac, in Tau: **Settings → Push** → "iPhone: Apple Push Notification service":
   **Key ID**, **Team ID**, and the key (**Choose .p8 file…**, or paste its text) →
   **Save key**. Tau checks that the key reads and never shows it again.

The bundle identifier is not a field: the app sends its own with its token. A build from
Xcode gets sandbox tokens and a TestFlight build production tokens; Tau tries production
first and remembers which one a phone's token works with.

### Android: a Firebase project

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**
   (Google Analytics is not needed).
2. **Add app** → Android, package name `de.tbuck.tau` (or the `appId` you chose
   in step 2) → download `google-services.json` and put it at
   `mobile/android/app/google-services.json` (Git ignores it), then build the app again.
   Without that file the app does not ask for pushes at all.
3. **Project settings → Cloud Messaging**: "Firebase Cloud Messaging API (V1)" must say
   Enabled (it is, for a new project).
4. **Project settings → Service accounts** → **Generate new private key** → a JSON file.
5. On the Mac: **Settings → Push** → "Android: Firebase Cloud Messaging" → **Choose JSON
   file…** → **Save service account**.

### Then

1. Open the Mac in the app on your phone. The first time, the phone asks whether Tau may
   send notifications: **Allow**.
2. **Settings → Push → Devices** on the Mac lists the phone. The paper-plane button sends
   a test push; the row says when the last one went, or why it failed.
3. **Content**: "Title and excerpt" (the thread's title and the first line of the agent's
   last message; the reason for "your turn", the question for a question) or "Title
   only". Whatever you pick goes through Apple's or Google's servers.
4. Tapping a notification opens its thread in the app.

The keys live in Tau's user data folder, under `kit-state/tau.push/keys.json` (on macOS
`~/Library/Application Support/tau/…`; Settings → Push names the path), a file only your
user account may read. They are not
encrypted: the host runs without a window, often as a background service, where no
keychain is at hand. Remove them in Settings → Push when you stop using push. Revoking a
phone in Settings → Connections also stops its pushes.

Pushes stay quiet while you are at Tau: when a Tau window (or the app) has focus and
was used in the last three minutes, the notification appears there instead.

## When something is off

- **"None of this host's addresses can be reached from a phone"**: network access is off
  on the Mac, so the link names only the Mac's own loopback. Turn it on and create a new
  link.
- **"The host did not answer on any of its addresses"**: the phone is not on the same
  network, Tailscale is off on the phone, or the Mac sleeps (Settings → Connections →
  "Keep this machine awake while turns run").
- **Nothing under "On this network"**: iOS Settings → Privacy & Security → Local Network →
  Tau must be on.
- **"<address> answered with another key …"**: the Mac's key changed (its `tls/host-key.pem` was
  lost, or you switched to a certificate of your own). A renewal keeps the key and does
  not cause this. The app shows it even when only this address answered and the others
  were out of reach. Remove the host in the app (trash icon), revoke the old device on the
  Mac, and scan a new code.
- **"<address> showed a certificate this phone does not trust"**: an address checked by
  certificate authorities (Tailscale Serve, `*.ts.net`) presented a certificate the phone
  rejects: out of date, for another name, or from something on the network in between,
  such as a hotel Wi-Fi login page. Try another network; `tailscale serve status` on the
  Mac shows whether Serve is still on.
- **No push arrives**: Settings → Push → Devices on the Mac shows why the last one
  failed. `InvalidProviderToken`: the Key ID or Team ID does not match the key.
  `DeviceTokenNotForTopic` or `TopicDisallowed`: the key's team is not the one that signed
  the app. `BadDeviceToken` / `Unregistered`: the phone's token is gone; open the Mac in
  the app again. A device missing from the list never allowed notifications (iOS Settings
  → Notifications → Tau) or, on Android, was built without `google-services.json`.
- **Signed out**: the Mac revoked the phone or it went unused past its timeout (Settings
  → Connections shows both). Open the host in the app to ask again.

## Android

Each release carries a signed APK,
[`Tau-android.apk`](https://github.com/Rasalas/tau-releases/releases/latest/download/Tau-android.apk),
for installing without a store, and sends the App Bundle to Play's internal testing
([RELEASE.md](RELEASE.md#phone-apps)). For a build of your own:
`node mobile/scripts/native-build.mjs android` writes a debug APK
(`mobile/android/app/build/outputs/apk/debug/app-debug.apk`), which `adb install` puts on
a phone with USB debugging on; a signed release build needs an upload key of your own
(RELEASE.md, "A signed build on this Mac").
