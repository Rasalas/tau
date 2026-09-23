# Importing cookies from another browser

Preview Kit can copy the cookies of chosen sites from another browser into a
Preview profile, so the preview is signed in where your own browser is. Open
it with the cookie button in the Preview panel's tool row (next to the profile
picker) or with **Import cookies from a browser** in the command palette.

1. **From:** pick the browser and, if it has several, its profile. Tau lists
   Chrome, Arc, Brave, Microsoft Edge, Vivaldi, Chromium, Firefox and Safari
   when it finds them.
2. **Sites:** tick the sites whose cookies you want. The list shows site names
   and how many cookies each has; filter it by typing.
3. **Into:** pick the Preview profile. The panel's picker makes new ones.
4. **Import.** If the page in view runs in that profile, it reloads with the
   new cookies.

This is a one-time copy. Signing in or out later in either browser does not
carry over, and some sites ask you to sign in again anyway (they bind a session
to more than a cookie).

Where it works:

- **macOS:** every browser above. Chromium browsers encrypt their cookies with a
  key in your login keychain, so macOS asks before Tau may read it (see below).
  Safari's cookie file is protected by the system: Tau needs **Full Disk
  Access** (System Settings → Privacy & Security), and the dialog opens that
  page for you. You can take the access away again after the import. Only
  Safari's default profile is read.
- **Linux:** Firefox, and Chromium browsers for cookies encrypted without a
  desktop keyring (`v10`). Cookies protected by the keyring (`v11`) are skipped.
- **Windows:** Firefox. Chromium browsers bind their cookies to their own
  program there (App-Bound Encryption), so no other program can read them.

Partitioned cookies (set by a site embedded in another), cookies of Firefox
containers and private windows, and expired cookies are not imported. Quit the
source browser first when you can: a running browser writes its newest sign-ins
to disk only every so often.

## Security

The import runs in the process that owns the Tau window, on the machine the
window runs on. A host elsewhere (a remote host, the browser client) only
routes the request; it never sees a cookie value.

**What is read.** Listing the browsers reads folder names, Chromium's
`Local State` (profile names), Firefox's `profiles.ini` and whether a cookie
store exists. Nothing of a browser's cookies is read until you pick that
browser. Then Tau reads the site names and counts from its cookie store. Only
**Import** reads cookie values, and only those of the sites you ticked.

**How it is read.** The browser's SQLite store (with its journal) is copied into
a new private folder in the system's temporary directory, opened there and
deleted when the read ends, whether it succeeded or not. The browser's own file
is never opened or written. The copy holds what the browser's file holds:
Chromium values still encrypted, Firefox values in the clear (Firefox keeps
them that way). Safari's file is read in place, without a copy.

**What is decrypted.** For a Chromium browser on macOS, the key is read from the
keychain item the browser keeps (`Chrome Safe Storage` and the like) with
`/usr/bin/security`, and only when a ticked site has an encrypted cookie. macOS
shows its own prompt, which names the `security` tool. Choose **Allow**: it
answers this one request. **Always Allow** would add that tool to the item's
access list, so any program could read the key through it without asking.
The key and the decrypted values stay in memory for the length of the import
and are written nowhere but the Preview profile. A value whose host binding
(cookie stores of schema 24 and later) does not match its host is skipped, not imported.

**Where it goes.** Only into a Preview profile's own session partition
(`persist:tau-preview`, `persist:tau-preview-<name>`); the window half refuses
any other partition, so the workbench's own session can never receive a
cookie. Electron keeps the partition under Tau's user data folder, as it does
for cookies a site sets while you browse in the preview.

**What never leaves the machine.** Cookie values, the keychain secret and the
copies of the store. Nothing is sent to a host, a model or a server; the dialog
only receives counts and site names. No agent tool reads or imports cookies:
an import starts only with a click on **Import** in this dialog. A kit that
wants one (the "your turn" handover, for instance) opens the dialog through the
`tau.preview/cookie-import` service, with the site filled in; you still choose
the browser and click Import.

**Tests and test instances.** No test reads a real browser profile or the
keychain: the tests build their own stores, encrypted with their own secret,
and the keychain reader refuses to run under Vitest. An isolated instance
(`npm run dev:instance`) sets `TAU_IMPORT_ROOTS`; with it set, Tau reads
browsers only from `<root>/browsers` (laid out like a home folder) and takes
keys from `<root>/browsers/keychain.json`, never from the keychain.
`kits/preview/cookie-fixtures.ts` writes such a home.
