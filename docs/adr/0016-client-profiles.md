# ADR 0016: The workbench is a client, and a contribution says which clients draw it

## Status

Accepted, 2026-09-06. First half of Phase 5 in [PLAN.md](../../PLAN.md): the
platform-neutral workbench, the platform seam and client profiles. Amended
2026-09-07 (ticket 19b) with the second client that uses them: see
"Amendment" below.

## Context

ADR 0010 gave the host one versioned protocol with two transports, and the
amendment added a window that is only a client. That made a host without a
window possible. It did not make a client without Electron possible, for two
reasons.

The client state was not separable. `src/renderer/App.tsx` held the thread
index, the thread on screen, transcript pages, composer scopes, drafts, notices
and the connection as 1,114 lines of React beside `window`, `document` and
`localStorage`. The stores under it (`ThreadStore`, `ThreadViewStore`,
`TranscriptHistoryController`) were already platform-neutral, but they sat in
`src/renderer/` and reached renderer types when it was convenient — the host
event router imported `ExtensionRegistry` for three method calls and read
`document.hidden`.

And a contribution could not say what it was. `registerPanel` meant the same
thing for the Agents panel — a list of threads and their status, which reads on
any screen — and for the Preview panel, which is a `WebContentsView` the
Electron main process positions over the window. A browser client would have had
to hard-code a list of extension ids it refuses to load, which is exactly the
coupling ADR 0002 exists to prevent.

## Decision

### `src/workbench/` is the client

Everything a second client keeps lives in `src/workbench/`: the stores, the
transcript history, composer scopes and drafts, the bootstrap cache, the host
client and its connection, the host-event router, and two new pieces —
`WorkbenchStore`, which is the one place a host update becomes client state
(bootstrap, snapshot, thread index, transcript page, host update, action
result), and `ThreadCommands`, the commands that are one host call and a notice.

It imports no React, no Electron module and no browser global.
`src/workbench/workbench-boundary.test.ts` fails on any of them, including a
`.tsx` file. Where a workbench module needs something from the view side it
names a port: `applyHostEvent` asks for three registry methods, one preferences
method and `viewerHidden()`, not for the classes that have them.

`src/renderer/` is the React binding of that client: hooks over
`useSyncExternalStore`, components, and the two hooks that must be React because
they own view state (the stage a project change empties, the thread-tree modal).
`App.tsx` is bootstrap, store wiring and layout, and is capped at 700 lines.

### `Platform` is what the client needs of its machine

```ts
interface Platform {
  clipboard: { writeText(text); writeImage?(dataUrl) };
  openExternal(url): void;
  files?: { openInEditor(path) };
  storage: ClientStorage;
  importModule(url): Promise<unknown>;
}
```

Electron answers it in `src/renderer/platform-electron.ts`, which is also the
only module that builds the Electron host client and the only one that reads the
browser's own key-value store. Each member is something a client may genuinely
lack: the clipboard is the *user's*, which on a remote host is not the host's;
`files` is a getter that disappears once a hello arrives without `local-files`;
`importModule` is where a page's CSP decides whether it will evaluate an
extension bundle at all.

`ClientStorage` and `HostClient` were already this seam and were not duplicated —
they moved into the workbench and the Electron halves of them moved out.

### A contribution names its clients

Every contribution the workbench *draws* takes an optional
`profiles?: ("desktop" | "web" | "compact")[]`. The default is `["desktop"]`, so
a kit written before this ADR keeps working and keeps being honest: nothing
claims a client it was never tried on.

`ExtensionRegistry` is constructed with the active profile. A contribution the
profile does not render is **not registered** — the component never mounts, no
slot has to know about it, and no getter has to filter. What the registry keeps
instead is the record: `getUnrenderedContributions()` returns the extension, the
kind, the id and the profiles it does claim, and Settings → Inspector shows them
under "Not on this client".

Commands, keybindings, slash commands, prompt hooks and published services are
not profiled. They are not surfaces; a command works wherever the workbench
does.

### "Not on this client" is not "off"

This is the point of the whole design. A profile filters **drawing**, never
lifecycle. The extension still activates, its host half still runs, and both
halves keep doing their work: on the `web` profile Workspace Kit is active and
still recording turn checkpoints, and the desktop window across the room shows
them. `kit-lifecycle.test.tsx` asserts exactly that.

## Consequences

- `App.tsx` is 689 lines, from 1,114. `src/workbench/` is 27 modules with no
  view library in any of them.
- `?profile=web` on the Electron window shows what a smaller client would leave
  out, before a smaller client exists. That is how this was checked.
- The bundled kits declared honestly, which is the useful output of the
  exercise: transcript- and composer-shaped contributions claim all three
  profiles, Packages and Signals claim desktop and web, and Preview, Review and
  the whole of Workspace Kit's drawing stay desktop-only.
- `EXTENSION_API_VERSION` does not move. `profiles` is optional and the default
  is the old behaviour; `WorkbenchActions.openExternal` is additive.
- A kit that renders without declaring a profile set fails
  `kit-lifecycle.test.tsx`. The default stays for third-party packages, where a
  silent desktop-only claim is the safe one.

## Out of scope

- **Per-profile styling.** Kits carry one stylesheet each; a contribution that
  claims `compact` promises its own rules work there.
- **Filtering commands.** A command a client cannot usefully run (`/reload`
  without a build host) still shows. Whether a command needs a profile is a
  question for the client that finds one.

## Amendment, 2026-09-07: the second client, and what picks a profile

The web client (`src/web/`, ticket 19b) is the client this ADR was written for.
Building it settled three things the original left open.

### Two profiles, not one: what a client claims, and how wide it is

A contribution's `profiles` is a claim about a *client*, so the profile the
registry filters on is decided once, when the page loads:
`browserClientProfile(width, override)` gives `compact` below 720 px and `web`
above it, and `?profile=` or `TAU_CLIENT_PROFILE` beats both. Dragging a window
narrow afterwards must not unregister a panel — the kit's claim did not change,
and re-activating the registry to follow a resize would tear down live state
for a layout question.

The layout does follow the width, on every client:
`layoutProfileFor(profile, width)` is `compact` under 720 px, the Electron
window included, and `useLayoutProfile` writes it to `body[data-profile]`.
`src/renderer/profile-compact.css` is the whole of it, plus three conditions in
`Workbench.tsx`: no dock, no sidebar column, and a thread sheet instead. There
is no second component tree and no second stylesheet system.

### `ClientEnvironment` is what the entry point knows

`App.tsx` used to read its own profile out of the query string and construct
Electron's platform by name. Both are facts only an entry point has, so they
became `ClientEnvironment { profile, safeMode, createPlatform }`, installed by
`src/renderer/main.tsx` or `src/web/main.tsx`. `createWebPlatform` is the
browser's answer: `navigator.clipboard`, `localStorage`, `window.open`, no
`files` at all — a tab has no editor, and on a remote host the paths are not
this machine's either.

### The token reaches the browser without living in the URL

A listening host now serves `dist-web/` from an HTTP server the socket upgrades
on, so page and protocol share one origin and one port. It prints a link whose
*fragment* carries a single-use pairing code; a fragment reaches no proxy and no
access log, `takePairingCode` replaces the address before the first render, and
`POST /pair` trades the code for the token exactly once within ten minutes.
Whoever has no link pastes the token instead — it is the whole authentication of
a listening host (ADR 0010), so there is nothing else to offer. A token the host
refuses closes the socket with 4401, which now stops the transport instead of
reconnecting into a wall.

### What the profiles turned out to be worth

On the `web` profile the browser draws the transcript, the composer, Pi
dialogs, Agents, Signals, Packages and Pi UI, and Settings → Inspector lists
Workspace Kit's nine contributions, Preview's two and Review's overlay under
"Not on this client" — while the host half of Workspace Kit keeps writing turn
checkpoints that the desktop window across the room shows. That is the claim of
this ADR, observed rather than asserted.

## Still out of scope

- **A client that changes profile at runtime.** A resize changes the layout, not
  the claim; reloading is how a client changes what it draws.
- **Native apps, push, offline.** Ticket 19 excluded them and still does.

## Amendment, 2026-09-24: the compact client is a touch client

Wave F (ticket F09) gave the compact profile its own touch surface, and in doing
so settled what `compact` claims.

- **A touch screen is compact at any width.** `browserClientProfile` takes a
  third argument, whether the primary pointer is coarse; the web entry passes
  `(pointer: coarse)`. An iPad at 1024 px is a touch client, not a narrow
  desktop, and `?profile=` still beats it.
- **Compact has two forms, not two profiles.** `compactFormFor(profile, width,
  height)` is `split` for a client that claims compact and is at least
  720 × 600 px, `single` otherwise; a desktop window narrowed below 720 px is
  always single. The split keeps the thread list in a sidebar a third of the
  width wide (280–380 px), the single form makes it a screen of
  its own. This is layout, like the width rule above: nothing registers or
  unregisters when a tablet turns.
- **A panel that claims `compact` is a sheet.** The compact layout still draws
  no dock, but it no longer drops every panel: those that claim `compact` get a
  glyph in the title bar and open over the thread. Agents is the first; the
  phone's terminal and review (F10, F11) arrive by claiming it.
- **The touch surface stays out of the desktop's first paint.** Everything
  touch-shaped is in `src/renderer/touch/`, loaded by the compact layout only,
  with its own stylesheet; `profile-compact.css` keeps just the grid, the safe
  areas and the touch sizes the first compact paint needs.
- **Thread actions reach the list through a command surface.** `thread-row`
  runs a command with `{ threadId }`; core adds Settle, Pin, Mark unread and
  Stop itself. The one new API is that surface and a command's `Icon` (1.13.0).

## Amendment, 2026-09-27: a tablet is laid out as the desktop

An iPad kept switching to the phone's layout while threads ran (ticket K37).
`compactFormFor` asked for 720 × 600 px of *window*, re-read on every resize,
so anything that moved the height or the width for a moment — an on-screen
keyboard, the system resizing a backgrounded app for its snapshots, a zoomed
field — turned the tablet into a phone, bottom navigation included.

- **The device and the width decide, never the height.** `compactFormFor(profile,
  width, screenMinSide, previous)` splits when the screen's shorter side is a
  tablet's (at least 600 px; an iPad mini has 744, a phone at most about 440)
  and the layout viewport is at least 720 px wide. A phone on its side stays a
  phone because of its screen, not its window.
- **Hysteresis.** A split stays split until the width falls 40 px below the
  threshold (`LAYOUT_HYSTERESIS_PX`); `layoutProfileFor` widens a compact
  desktop window again only 40 px past 720. The hooks (`use-layout-profile.ts`)
  read `documentElement.clientWidth`, which a zoom does not change, and do not
  decide while the page is hidden.
- **The split is the desktop's arrangement.** The thread list stays the touch
  list, but the panels that claim `compact` go on the dock's rail and open
  beside the chat, or as a stage tab with the chat as the first tab where the
  centre has no room for both (the chat's minimum is 360 px, as on the desktop).
  Only the single form draws sheets and the bottom navigation. Kits that want
  their compact panel beside the chat declare it `width: "wide"` and
  `maximizable`, as on the desktop; the claim is unchanged, so nothing
  registers or unregisters when an iPad enters Split View.

