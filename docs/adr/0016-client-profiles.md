# ADR 0016: The workbench is a client, and a contribution says which clients draw it

## Status

Accepted, 2026-09-06. First half of Phase 5 in [PLAN.md](../../PLAN.md): the
platform-neutral workbench, the platform seam and client profiles. No second
client exists yet.

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

- `App.tsx` is 684 lines, from 1,114. `src/workbench/` is 27 modules with no
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

- **The web client itself**, `vite.web.config.ts`, `dist-web/` and the host
  serving it (ticket 19b). Nothing here builds a second client; it makes one
  possible.
- **The compact layout.** `compact` is a profile a contribution may claim, but
  no client selects it from a width yet and no component reads it.
- **Per-profile styling.** Kits carry one stylesheet each; a contribution that
  claims `compact` promises its own rules work there.
- **Filtering commands.** A command a client cannot usefully run (`/reload`
  without a build host) still shows. Whether a command needs a profile is a
  question for the client that finds one.
