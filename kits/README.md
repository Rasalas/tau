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
  styles.css           optional: the kit's own rules, linked while it is active
  pi.ts                optional: the half that runs inside a Pi runtime Tau does not own
  host.test.ts         through src/main/test-support/host-kit-harness
  desktop.test.ts      through src/renderer/test-support/kit-harness
  app.test.tsx         optional: the kit in front of the real App
```

## The wall

A kit may import `tau`, `tau/host-extension`, `tau/host`, its own relative
files, another kit of this set (Agents Kit and Remote Work Kit take
`kits/workspace/agent-worktrees.ts`, the leaf that holds the Git sequences for
a spawned thread's worktree and for merging a branch back — a kit that owns a
subject owns it for the others too), and whatever it brings itself. It may not import `src/**`; `src/**` may
not import it. `src/shared/kits-boundary.test.ts` enforces both. A kit's *tests*
may additionally reach `src/main/test-support/` and `src/renderer/test-support/`.

Relative imports inside a kit use the `.js` spelling (`./protocol.js`). esbuild
and TypeScript both map it to the `.ts` file.

A folder whose name starts with `_` is not a kit but code several kits share:
it has no manifest, the loaders and `build-kits` skip it, and each kit that
imports it bundles its own copy. `kits/_acp/` is the Agent Client Protocol
client (wire, session, turn translator, approvals, the thread backend and
session store, a fake agent for tests) behind Antigravity, Cursor and Grok; `kits/_window-capture/` records one window by
its id for Computer Use's live view and SnapShots. Such a folder imports only `tau/*` and itself,
never a kit, so kits stay apart while the protocol lives once.

A kit's `pi` entry is the exception to "a kit is two halves": when a Pi TUI
owns the session and Tau is only attached, the host half cannot hand a closure
to that process. `pi.ts` default-exports `(pi, bridge) => void`, is prebuilt to
`dist-kits/<id>/pi.cjs`, and `.pi/extensions/tau-session-bridge.ts` requires it
there — so kit code never passes through jiti, where `tau/*` does not resolve.
`PiKitBridge` in `docs/EXTENSIONS.md` is what it may do; `kits/workspace/pi.ts`
is the worked example. `npm run smoke:attached` runs that case end to end
against a real `pi` TUI; `docs/agents/testing-the-app.md` explains it.

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
   `engines.api` must accept the API version used by the kit. Raise the minimum
   when the kit uses a newly added API seam; Review and Workspace use `^1.6.0`,
   while kits that only use older additive seams may retain `^1.5.0`.
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
watches it. A `styles` entry is copied there beside the two bundles and served
over `tau-ext://`. The loader prefers `dist-kits/` over `kits/`, so an edit needs the
watcher (or `npm run build:kits`) before the app sees it.

`--kits <dir>` and `--out <dir>` point the same build at a distribution that is
not in this repository — a checked-out `@tau/kits`, or the tree a
`git subtree split` produced — and compile it against this core
([ADR 0015](../docs/adr/0015-core-and-distribution.md)). Both default to the
folders here, so nothing about `npm run build` changes.

Beside the kit folders the build writes `dist-kits/manifest.json`: the name,
version and `engines` from this `package.json` plus the ids it built. The
version lives in that one index rather than being stamped into each kit's
`tau-extension.json`, because a kit's `version` is its own — the set moves as a
set, and a shipped manifest that differs from its source would be one more thing
to keep true. Settings → Packages reads the index and heads the bundled list
with it; from a checkout without `dist-kits/` the loader reads this file
instead, so the two agree.

## Versioning

`version` is the distribution's, raised when the set changes. Each
`engines.api` range states the oldest additive API line that kit needs;
`src/shared/kits-boundary.test.ts` checks that every shipped kit accepts the
current host version. Core owns `EXTENSION_API_VERSION` and is the only side
that raises it, which is why API lands in a core release before the kits that use it
([ADR 0015](../docs/adr/0015-core-and-distribution.md)).

There is no npm workspace here, deliberately. `@tau/kits` is `private` and
declares no dependencies: the kits reach core through the three API modules,
which both bundlers resolve by alias, and take React and the icons from the
renderer at runtime. A workspace would add a `node_modules` root with nothing
in it and another thing for electron-builder to prune.
