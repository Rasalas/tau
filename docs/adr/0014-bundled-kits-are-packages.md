# ADR 0014: A bundled kit is a package Tau ships

## Status

Accepted, 2026-09-06.

## Context

ADR 0008 promised that "a bundled kit and an installed package look the same to
the host and the renderer". They did not. A bundled kit was a function call in
`src/main/extensions/index.ts` and an entry in a `bundledExtensions` array the
renderer imported statically; it had no manifest, no permission list the seam
could enforce, no engines, and no build of its own. Its desktop half imported
renderer internals directly — 29 of 30 files did — so "deactivating a kit
removes its behaviour without editing core" was true of the registry and false
of the bundle.

VISION.md wants a small core with the product assembled from extensions. That
claim is only honest once the kits build against the same API a third party
gets, and load through the same code path.

## Decision

**A kit is a folder under `kits/<name>/` with a `tau-extension.json`.** The same
manifest schema, the same parser (`parseExtensionManifest`), the same
`permissions`, `isolation` and `engines.api` an installed package carries. Kit
ids keep their values (`tau.thread-titles`, …), so grants, settings pages and
preferences survive the move.

**A kit reaches core through three modules and nothing else.** `tau`
(`src/renderer/extension-api.ts`) for the desktop half, `tau/host-extension`
(`src/main/host-extension-api.ts`) for an in-process host half, `tau/host`
(`src/main/host-extension-worker-protocol.ts`) for a worker-isolated one. The
host bundler resolves the first two by alias, so a package never ships a copy of
them; the renderer already published `tau` through `globalThis.__tauShared`.
`src/shared/kits-boundary.test.ts` fails on any other reach in either direction.

**Kits are prebuilt.** `scripts/build-kits.mjs` compiles every kit into
`dist-kits/<id>/{host.cjs,desktop.js,tau-extension.json}` with the same esbuild
options the runtime loaders use — it imports the loaders themselves, so there is
one implementation. `npm run build` runs it and `npm run dev` watches it. From a
checkout without `dist-kits`, `loadBundledKitHostHalves` compiles `kits/*` on the
fly through the package bundler and its content-hash cache. The installed app has
neither `kits/` nor a toolchain, so it only ever reads `dist-kits/`.

**Trust is the only difference, and it is one line.** A bundled kit is granted by
construction: no prompt, no entry in `~/.tau/extension-grants.json`, and
`in-process` allowed without approval — shipping the kit *is* the approval.
Everything else stays: the registry activates it with `guardedServices`, so a
kit that reaches a service its manifest did not ask for is denied and logged
exactly like a package, and Settings shows it with its permissions under
`bundled` rather than under waiting packages.

**Desktop halves are served, not linked in.** They arrive over `tau-ext://` like
a package's, through the same `importBundle` and the same activation in
`RuntimeExtensions.sync`. First paint was measured before and after (see below);
serving them costs nothing, so the alternative — same-origin modules from a
build-time manifest — was not needed. The renderer's initial chunk shrinks by
whatever the kits used to weigh.

## Consequences

- `EXTENSION_API_VERSION` is 1.2.0. What a kit needs and cannot get is now an
  API decision with a version attached, not a reachable import.
- The two core lists shrink by one entry per migrated kit and reach zero in
  ticket 09; `src/main/extensions/index.ts` and `src/renderer/extensions/index.tsx`
  are the transition, not the design.
- A kit's tests live with the kit and may reach exactly two core modules:
  `src/main/test-support/host-kit-harness.ts` and
  `src/renderer/test-support/kit-harness.tsx`. `RendererServices.extensions` lets
  a kit put its own desktop half in front of the real `App`, which is how the
  App-level tests of a moved kit travel with it.
- Text projections core and the title kit share (`src/main/host-text.ts`) stayed
  in core, because Tau's own Pi extension (`.pi/extensions/tau-session-bridge.ts`)
  reads them and runs inside Pi, where jiti resolves no `tau/` specifier. Splitting
  that bridge is ticket 09's job and the moment to move them.
- Nothing here makes a kit removable at runtime that was not before, and nothing
  makes it optional: safe mode still loads no kit at all, on either side.

## Measured

`npm run start:report -- --check`, four runs each, same machine:

| | first paint (ms) |
|---|---|
| before | 196 (cold), 108, 112, 96 |
| after | 140 (cold), 84, 92, 92 |

Initial renderer JavaScript went from 733,233 B (224,898 B gzip) to 731,628 B
(224,451 B gzip). `npm run benchmark:renderer -- --check` and
`npm run benchmark:host:check` stayed inside their budgets.
