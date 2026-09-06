# `kits/` — the extensions Tau ships

A kit is an extension package that happens to be in this repository. Same
manifest, same bundlers, same registry, same `guardedServices`. The only
differences are that a kit needs no grant (shipping it is the approval) and that
it is loaded from `dist-kits/` rather than from `~/.tau/extensions`
([ADR 0014](../docs/adr/0014-bundled-kits-are-packages.md)).

```
kits/<name>/
  tau-extension.json   id, name, version, engines.api, permissions, isolation, entries
  protocol.ts          ids and command shapes both halves share; no imports
  host.ts              default-exports a HostExtension (or a factory)
  desktop.tsx          default-exports a DesktopExtension
  pi.ts                optional: the half that runs inside a Pi runtime Tau does not own
  host.test.ts         through src/main/test-support/host-kit-harness
  desktop.test.ts      through src/renderer/test-support/kit-harness
  app.test.tsx         optional: the kit in front of the real App
```

## The wall

A kit may import `tau`, `tau/host-extension`, `tau/host`, its own relative
files, and whatever it brings itself. It may not import `src/**`; `src/**` may
not import it. `src/shared/kits-boundary.test.ts` enforces both. A kit's *tests*
may additionally reach `src/main/test-support/` and `src/renderer/test-support/`.

Relative imports inside a kit use the `.js` spelling (`./protocol.js`). esbuild
and TypeScript both map it to the `.ts` file.

A kit's `pi` entry is the exception to "a kit is two halves": when a Pi TUI
owns the session and Tau is only attached, the host half cannot hand a closure
to that process. `pi.ts` default-exports `(pi, bridge) => void`, is prebuilt to
`dist-kits/<id>/pi.cjs`, and `.pi/extensions/tau-session-bridge.ts` requires it
there — so kit code never passes through jiti, where `tau/*` does not resolve.
`PiKitBridge` in `docs/EXTENSIONS.md` is what it may do; `kits/workspace/pi.ts`
is the worked example.

## Moving a kit here

1. **Inventory.** List everything the two halves import from `src/`. Anything
   the API does not offer becomes a named export on
   `src/renderer/extension-api.ts` or `src/main/host-extension-api.ts`, with one
   sentence in `docs/EXTENSIONS.md`. Never widen `SHARED_MODULES` with internals.
2. **Manifest.** Write `tau-extension.json`. `permissions` must name every
   `HostExtensionServices` member the host half touches
   (`HOST_SERVICE_PERMISSIONS` is the map) — a bundled kit is guarded, so a
   missing permission fails loudly in tests instead of silently working.
   `isolation` is `in-process` for a kit that holds a live host object (a thread,
   a session file, a runtime backend, a Pi extension), `worker` otherwise.
   `engines.api` is `^<EXTENSION_API_VERSION major.minor>`.
3. **Move whole.** Host half, desktop half, protocol file and tests in one
   commit, with the old files deleted in the same commit. Never duplicate.
4. **Register.** Add the desktop half's default export to
   `kits/kit-lifecycle.test.tsx`; there is no list in `src/` to edit, because
   the loader reads the manifests.
5. **Core tests that named the kit.** A core test that reached into the kit
   either moves to `kits/<name>/` (using `renderApp(client, { extensions: [...] })`
   for the App-level ones) or is rewritten against the seam it actually tests —
   a stub extension registering the same contribution.
6. **Check.** `npm run lint && npm run typecheck && npm test`,
   `npm run build:budget`, `npm run benchmark:host:check`,
   `npm run start:report -- --check`, and the real app
   (`.agents/skills/test-tau-app/SKILL.md`).

## Building

`npm run build:kits` writes `dist-kits/`; `npm run build` runs it, `npm run dev`
watches it. The loader prefers `dist-kits/` over `kits/`, so an edit needs the
watcher (or `npm run build:kits`) before the app sees it.
