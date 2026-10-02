# Checklist: remote access on a real phone

What an agent cannot test: your phone, your Wi-Fi, your cellular network, your tailnet and
your Apple account. Run this once after installing the app through TestFlight
(`docs/mobile-testflight.md`), and again after a release that touches the host's network
code, pairing or the app. Each step says what you should see; note the step number of
anything that does not match and what you saw instead.

Everything an agent can check has already been checked on this Mac, with loopback, the test
Bonjour type, a fake `tailscale` and the iOS Simulator (`docs/agents/testing-the-app.md`,
"Remote access"). This list covers the rest.

## Before you start

- [ ] The Mac runs the Tau build under test, and the phone runs the matching TestFlight build.
- [ ] Mac and phone are on the same Wi-Fi. Tailscale is installed on both and signed in to
      the same tailnet (only needed for the Tailscale steps).
- [ ] On the Mac: Settings → Connections. Note which devices are already paired, so you can
      tell them apart from the one this test adds.

## 1. Local network, paired by QR code

1. [ ] Settings → Connections → Network access: turn on **Local network** and confirm. The
       Mac's own firewall may ask whether Tau may accept connections: allow it.
2. [ ] The endpoint list shows `LAN (en0)` (or `en1`) with the Mac's Wi-Fi address, and
       `.local`.
3. [ ] **Create link**, access **Full**. A QR code appears.
4. [ ] In the app: **Scan a pairing code**. iOS asks for the camera: allow it. Scan the code.
5. [ ] iOS asks whether Tau may find devices on the local network: allow it.
6. [ ] The app shows "Waiting for the host" with six digits. The Mac shows "<your phone>
       wants to connect" with the **same** six digits.
7. [ ] **Allow** on the Mac. The app opens the Mac's threads.
8. [ ] Connections lists the phone, with its address on the Wi-Fi and one connection.

## 2. Bonjour, without a link

1. [ ] In the app, go back to the host list and remove the Mac (trash icon, confirm).
2. [ ] Under **On this network** the Mac appears within a few seconds, by its computer name.
3. [ ] Tap it, then **Ask to connect**. The Mac shows a request "without a pairing link",
       and both sides show the same digits. **Allow**.
4. [ ] In the Mac's Connections, the old entry for the phone can now be revoked.

## 3. Prompt, and the phone in daily use

1. [ ] Open a thread, pick a cheap model in the picker (it opens as a sheet), send a short
       prompt. The reply streams in.
2. [ ] Swipe a thread row to the left: **Settle** and **Snooze** appear. Long-press a row: the
       action sheet opens.
3. [ ] Tap the composer: the keyboard opens and the composer stays above it. Return adds a
       line; the send button sends.
4. [ ] Rotate the phone. The layout follows; nothing is cut off at the notch or the home
       indicator.
5. [ ] **More** → **Files**: the project's tree in a sheet. Tap a file: it opens to read in
       the sheet (no editing on a phone); the back arrow returns to the folders as they were.
6. [ ] On an iPad with a Magic Keyboard: Return in the composer sends, Shift+Return adds a
       line. Detach it (or bring up the on-screen keyboard): Return adds a line again.
7. [ ] On an iPad: **Files** on the rail, tap a file, then **Edit file**. Type with the
       hardware keyboard, ⌘Z undoes, ⌘F searches, ⌘S saves (the dot on the tab goes).

## 4. Background and reconnect

1. [ ] With a thread open, lock the phone for about a minute. Meanwhile, rename that
       thread on the Mac.
2. [ ] Unlock. Within a few seconds the app shows the new title, without a restart. At most
       a short "Reconnecting to the host…" band.
3. [ ] Start a longer turn on the Mac, switch the phone to another app for 30 seconds,
       come back. The turn's output is complete.
4. [ ] Turn Wi-Fi off on the phone (cellular stays on). Without Tailscale: the app shows
       "Offline…" or "Reconnecting…" and stays there. Turn Wi-Fi on again: it reconnects on
       its own.
5. [ ] Quit the app completely and open it again. It opens the Mac and the last thread
       without asking to pair again.

## 5. Tailscale

1. [ ] On the Mac: turn on **Tailscale** under Network access, confirm. The endpoint list
       shows `Tailscale` (a 100.x address) and `MagicDNS`.
2. [ ] On the phone: Wi-Fi off, Tailscale on. The app reconnects over the tailnet (the Mac's
       Connections shows the phone's 100.x address as its last address).
3. [ ] Send a prompt over cellular. The reply arrives.
4. [ ] Wi-Fi on again: the app moves back to the LAN address at the next reconnect.
5. [ ] If the Tailscale HTTPS section is present in Connections (Tailscale Serve): set it up,
       then open `https://<machine>.<tailnet>.ts.net/` in Safari on the phone. The web client
       loads without a certificate warning, and pairing with a new link works there.
6. [ ] Turn Tailscale off on the Mac. The phone falls back to "Reconnecting…" while off Wi-Fi.

## 6. Terminal key bar

1. [ ] Open the terminal (title bar ⋯ More → Terminal), **New terminal**. The shell prompt appears.
2. [ ] Tap into the shell: the keyboard opens, the key bar sits directly on top of it, no
       autocorrect or capitalisation in what you type.
3. [ ] Type `sleep 30`, return, then **^C**: the command stops.
4. [ ] **ctrl**, then `r` on the keyboard: the shell's reverse search opens. **esc** leaves it.
5. [ ] Arrow keys walk the history. **tab** completes a path.
6. [ ] Copy text elsewhere, then the paste key: iOS asks once, the text lands in the shell.
7. [ ] ⋯ → A+ / A−: the font size changes on the phone only, not on the Mac.
8. [ ] Swipe up and down in the terminal: the scrollback scrolls.

## 7. Review

1. [ ] Let a turn change a file, then open Review (title bar ⋯ More → Review). "Latest turn" lists the
       file; tap it for the diff.
2. [ ] Tap one line, then another in the same file: "Comment on lines …". Write a comment,
       **Add to the composer**: the comment is in the composer's draft.
3. [ ] Leave the review sheet with a half-written comment and come back: the text is still
       there.
4. [ ] **Uncommitted changes** → Commit: a confirmation says what will happen. Cancel it
       (or commit in a test repository only).

## 8. A read-only device

1. [ ] On the Mac, set the phone to **Read only** in Connections.
2. [ ] The phone still shows threads and diffs. Review says the device is read only and
       disables Commit with a reason; a prompt from the phone does not start a turn. Set it
       back to **Full**.

## 9. Push notifications

First set up your APNs key (and for Android your Firebase project) as in
`docs/mobile-testflight.md`, section 8.

1. [ ] Open the Mac in the app; the phone asks whether Tau may send notifications: **Allow**.
       Settings → Push on the Mac lists the phone under Devices.
2. [ ] The paper-plane button in that row: a notification "Push notifications reach this
       device." arrives within seconds. If not, the row says why.
3. [ ] Start a turn from the phone ("Run sleep 240, then reply with one word"), lock the
       phone and do not touch the Mac for those four minutes. When the turn ends: a notification with the thread's
       title and the first line of the answer.
4. [ ] Tap it: the app opens that thread.
5. [ ] Ask for something the agent must ask back about (or a permission): the notification
       shows the question.
6. [ ] With the Mac's Tau window in front and in use, let a turn end: no notification on
       the phone.
7. [ ] Settings → Push → Content **Title only**, one more turn: the notification shows the
       title and "Finished", no text of the answer.
8. [ ] Revoke the phone in Connections: Settings → Push no longer lists it, and no further
       notifications arrive.

## Afterwards

- [ ] Turn **Local network** and **Tailscale** back off on the Mac unless you want them on.
- [ ] Revoke any test devices in Connections you do not keep.
- [ ] Report the numbers of the steps that did not match, with what you saw.

## Dictation and system activity

Use a test host and a signed test build. No real push is needed for local dictation.

- [ ] On an iOS 26 supported iPhone or iPad, deny microphone permission. Dictate
      reports the denial and leaves the draft unchanged.
- [ ] Without changing Settings, Dictate uses the device language, not Cantonese
      or another first entry from the supported-language list.
- [ ] In Settings → General, choose an uninstalled dictation language, download its
      model, then turn off networking. Record, pause, and stop. Finalized phrases
      appear in the draft without confirmation; provisional words and the real
      microphone level appear below the composer. Audio never reaches the host.
- [ ] Start in the middle of a draft or over a selection. Insertion uses that selection;
      no message sends until Send is tapped.
- [ ] Cancel during model download, permission request, recording and transcription.
      No late transcript or microphone recording survives cancellation. Text
      already inserted stays editable. Send stays disabled until dictation ends.
- [ ] Background the app during recording, then return. The microphone is off,
      unfinished words are discarded, and a new recording can start.
- [ ] Record to the five-minute limit. Stop and insertion still work. Try an interruption,
      such as an incoming call, and confirm the recording reports an error or stops.
- [ ] Start a fake agent turn. iOS Live Activity / Android ongoing card shows running;
      a question shows needs-input; completion shows completed. Tap opens the matching
      thread and host. Unsupported OS versions keep normal notifications.
- [ ] Start two turns on one host. The iPhone shows one Live Activity listing both,
      the Dynamic Island the question and running counts with the Tau mark uncut;
      it ends a quarter hour after the second turn finished.
- [ ] With fake APNs/FCM on loopback, capture a background activity update payload.
      The APNs topic ends in `.push-type.liveactivity`, its push type is `liveactivity`,
      and its update token is the activity's token, not the device's alert token.
- [ ] Add the Plan limits widget with two runtimes signed into one test account. Its quota
      appears once. Separate accounts remain separate. Sign out and refresh, then
      revoke/remove the host; its usage and activity disappear.
- [ ] Add Plan limits and Threads on the home screen (each size) and on the lock screen.
      Tinted and clear home-screen modes keep the bars readable. A tap on Plan limits
      opens Usage, a Threads row its thread.

## Remote iOS Live Activity starts

These steps need a signed iOS 17.2+ test phone, with iOS 26 included in the test
matrix. Use a disposable paired host. The app and `de.tbuck.tau.widgets` extension
must have separate matching signed profiles with the app group and shared
Keychain entitlement. APNs setup and a deployed relay that accepts
`purpose: "activity-start"` are prerequisites. Fake-provider tests and an unsigned
simulator build do not complete this checklist.

- [ ] Confirm the host's **Live Activities** switch starts off in the phone's
      Hosts screen. A turn from the Mac does not remotely create an activity.
- [ ] Enable the switch on the phone, then close Tau. Start a new turn on the Mac.
      A Live Activity appears with the matching title and running status. Tap it
      and verify the correct paired host and thread open.
- [ ] Start a turn while the phone is locked, including after app termination.
      Verify the app's native background registration produces update delivery
      without first opening the phone's workbench. Check both iOS 17.2 and 26.
- [ ] Ask a question, answer it on the Mac, then finish the turn. The activity
      follows needs-input, running and completed and ends. Finish a fast turn
      before the native update-token registration returns; it must still end.
- [ ] Rotate a synthetic start/update token in the native test harness. Confirm
      the host replaces the old registration and a ciphertext bound to the old
      update token fails to open. Do not record real tokens in logs or reports.
- [ ] Open the phone during a remotely started turn. It keeps one activity for
      that host, including after reconnect and an app restart.
- [ ] Turn Live Activities off in the phone's Hosts screen. Existing activities
      end and later turns do not start one. Repeat offline, reconnect/relaunch,
      and confirm the host removes start consent and update registrations.
- [ ] Disable Live Activities in iOS Settings, then revoke/remove the paired host.
      Its shared activity key, usage widget data and activities disappear.
      An already queued start never reveals private content after key removal.
- [ ] Capture synthetic provider requests only. Startup attributes contain only
      an opaque activity id and ciphertext; no host/thread/title/prompt is readable.
      Start/update/alert handle-purpose substitution and a stale start are refused.
- [ ] Trigger more than three starts in an hour on the disposable host. No extra
      start attempts are sent. Test the system's own limits without interpreting
      APNs acceptance as proof of display; normal notifications remain available.
