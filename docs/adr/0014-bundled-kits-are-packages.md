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

## Amendment, 2026-09-06: a kit's own state is a kit's own

Moving Workspace Kit forced the question `context.workspaceStore` had been
avoiding: the largest kit's store sat on `DesktopExtensionContext` and on
`RendererServices`, so core constructed a kit's state and handed it to every
extension. Nothing in core read it.

**The kit owns the store.** It creates it in `activate`, binds it to its own
components through a React context it owns (`withWorkspaceStore`), and
publishes it for the kits built on it with two new members of the context:

```ts
provideService<T>(id: string, value: T): () => void;
useService<T>(id: string, use: (value: T) => (() => void) | void): () => void;
```

Core routes them by id and never looks inside. `useService` runs its callback
whenever the value exists — before or after the user's own activation — and
disposes whatever the callback returned when the provider withdraws, so
activation order does not matter and a withdrawn kit takes the contributions
built on it with it. Workspace Kit publishes `tau.workspace/store`; Worktree
Names fills its worktree-namer offer, Review Kit its commit-message offer and
its review overlay.

**`ThreadRow` became API, not the kit's own component.** It draws provider
icons from `@lobehub/icons-static-svg` and a PNG through Vite's asset
pipeline; neither bundler a package goes through (`bundleDesktopExtension`,
`bundleHostExtension`) has a loader for those files. A thread is core's (ADR
0003) and its row is how core draws one, so the row is published from `tau`
and any navigator kit gets the same one.

**The Git and checkpoint engine stayed in core.** `workspace-git.ts`,
`workspace-checkpoint-lease.ts`, `workspace-kit-checkpoints.ts` and
`pi-turn-checkpoint-extension.ts` are read by `.pi/extensions/tau-session-bridge.ts`
under jiti, exactly as `host-text.ts` is, so they are published through
`tau/host-extension` instead of moving. The one file the bridge and the kit
share, `kits/workspace/checkpoint-protocol.ts`, names only `tau/host-extension`
— the specifier NodeNext and jiti both resolve — and `protocol.ts` re-exports
it. Ticket 09 splits the bridge and folds both back in.

## Amendment, 2026-09-06: a kit reaches the Pi runtime it does not own

The paragraph above was the transition. Ticket 09a split the bridge, so it is
no longer true.

`.pi/extensions/tau-session-bridge.ts` is Tau's own Pi extension, loaded by
jiti inside a Pi TUI that owns a session Tau attaches to. It carried Workspace
Kit's checkpoint feature and the title generator, and therefore imported both
kits and the core modules behind them. It now owns only what core owns — turn
ledger, transcript paging, skill prompts, prompt attachments, runtime
ownership — and lends a kit a seam (`PiKitBridge`): register a command,
publish an event, refresh the snapshot, pin entries, observe accepted turns,
read the projected transcript, open another session.

**A kit's Pi half is delivered prebuilt, not as source.** The manifest gains a
`pi` entry; `scripts/build-kits.mjs` compiles it into `dist-kits/<id>/pi.cjs`
with the host bundler (Pi external), and the bridge requires that file. So a
kit's Pi code never passes through jiti and never needs a `tau/*` specifier to
resolve inside Pi. The runtime-extension factory a host half registers stays
what it is: the same feature, in the runtime Tau owns.

With the bridge no longer reading them, `workspace-git.ts`,
`workspace-checkpoint-lease.ts`, `workspace-kit-checkpoints.ts`,
`pi-turn-checkpoint-extension.ts`, `git-coordinator.ts`, `file-content.ts` and
the `turn-checkpoint-*` family moved into `kits/workspace/`,
`checkpoint-protocol.ts` folded back into `protocol.ts`, and
`tau/host-extension` stopped re-exporting them (1.3.0 published them for one
wave and never shipped). Core kept `workspace-kit-types.ts`, because the stage
renders changed files and diffs itself, and `clone-source.ts`, because the
package installer clones too.

## Consequences

- `EXTENSION_API_VERSION` is 1.2.0. What a kit needs and cannot get is now an
  API decision with a version attached, not a reachable import.
- The two core lists shrank by one entry per migrated kit and reached zero;
  `src/main/extensions/index.ts` and `src/renderer/extensions/index.tsx` were the
  transition, not the design, and are gone.
- A kit's tests live with the kit and may reach exactly two core modules:
  `src/main/test-support/host-kit-harness.ts` and
  `src/renderer/test-support/kit-harness.tsx`. `RendererServices.extensions` lets
  a kit put its own desktop half in front of the real `App`, which is how the
  App-level tests of a moved kit travel with it.
- Text projections core and the title kit share (`src/main/host-text.ts`) stay
  in core because core titles threads too, and are published through
  `tau/host-extension`. The bridge no longer reads them (see the amendment
  above); the kit's Pi half gets them bundled, like any other API value.
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
