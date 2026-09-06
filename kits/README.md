# `kits/` — the extensions Tau ships

A kit is an extension package that happens to be in this repository. Same
manifest, same bundlers, same registry, same `guardedServices`. The only
differences are that a kit needs no grant (shipping it is the approval) and that
it is loaded from `dist-kits/` rather than from `~/.tau/extensions`
([ADR 0014](../docs/adr/0014-bundled-kits-are-packages.md)).

Together they are **`@tau/kits`**, the distribution Tau ships beside its core.
`package.json` here names it and carries its version; `files` is the shape of
`dist-kits/`, and the build fails on a file that list does not cover. Tau is
two artifacts from one repository: core, which runs alone
(`npm run start:safe`), and this set on top of it.

```
kits/<name>/
  tau-extension.json   id, name, version, engines.api, permissions, isolation, entries
  protocol.ts          ids and command shapes both halves share; no imports
  host.ts              default-exports a HostExtension (or a factory)
  desktop.tsx          default-exports a DesktopExtension
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
and TypeScript both map it to the `.ts` file, and Tau's own Pi extension reads
some kit files under NodeNext, where the extension is required.

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
4. **Unregister.** Remove the entry from `src/main/extensions/index.ts` and
   `src/renderer/extensions/index.tsx`, and add the desktop half's default export
   to `kits/kit-lifecycle.test.tsx`.
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

Beside the kit folders the build writes `dist-kits/manifest.json`: the name,
version and `engines` from this `package.json` plus the ids it built. The
version lives in that one index rather than being stamped into each kit's
`tau-extension.json`, because a kit's `version` is its own — the set moves as a
set, and a shipped manifest that differs from its source would be one more thing
to keep true. Settings → Packages reads the index and heads the bundled list
with it; from a checkout without `dist-kits/` the loader reads this file
instead, so the two agree.

## Versioning

`version` is the distribution's, raised when the set changes. `engines.api` is
the `EXTENSION_API_VERSION` line every kit builds against; `src/shared/kits-boundary.test.ts`
fails when it drifts from that constant or from a kit's own `engines.api`.

There is no npm workspace here, deliberately. `@tau/kits` is `private` and
declares no dependencies: the kits reach core through the three API modules,
which both bundlers resolve by alias, and take React and the icons from the
renderer at runtime. A workspace would add a `node_modules` root with nothing
in it and another thing for electron-builder to prune.
