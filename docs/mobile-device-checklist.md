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

1. [ ] Open the terminal (title bar icon), **New terminal**. The shell prompt appears.
2. [ ] Tap into the shell: the keyboard opens, the key bar sits directly on top of it, no
       autocorrect or capitalisation in what you type.
3. [ ] Type `sleep 30`, return, then **^C**: the command stops.
4. [ ] **ctrl**, then `r` on the keyboard: the shell's reverse search opens. **esc** leaves it.
5. [ ] Arrow keys walk the history. **tab** completes a path.
6. [ ] Copy text elsewhere, then the paste key: iOS asks once, the text lands in the shell.
7. [ ] ⋯ → A+ / A−: the font size changes on the phone only, not on the Mac.
8. [ ] Swipe up and down in the terminal: the scrollback scrolls.

## 7. Review

1. [ ] Let a turn change a file, then open Review (title bar icon). "Latest turn" lists the
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

Once push notifications ship (F08): start a turn from the phone, lock it, and check that a
notification arrives when the turn finishes, when it fails, and when the agent asks a
question; that tapping it opens that thread; and that "Title only" hides the snippet. Until
then, skip this section.

## Afterwards

- [ ] Turn **Local network** and **Tailscale** back off on the Mac unless you want them on.
- [ ] Revoke any test devices in Connections you do not keep.
- [ ] Report the numbers of the steps that did not match, with what you saw.
