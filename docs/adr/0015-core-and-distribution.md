# ADR 0015: Core and distribution

## Status

Accepted, 2026-09-06. No split is performed. What is decided here is the
contract between a core and a distribution, and the recipe for the day `kits/`
becomes its own repository.

## Context

ADR 0014 made every bundled kit a package. Wave 3 finished the job: `kits/` is
`@tau/kits` 0.1.0, `scripts/build-kits.mjs` writes `dist-kits/manifest.json`,
and the installer ships that folder ([docs/RELEASE.md](../RELEASE.md)). Tau is
two artifacts from one repository.

The open question was governance, not code. If Tau goes public as a small core
that anyone can build a product on, the distribution Tau itself ships should be
able to live somewhere else — and the honest way to find out what that costs is
to try it. This ADR records what a rehearsal on `feat/ks-10` found and what the
two sides would owe each other.

## What the rehearsal found

`git subtree split --prefix=kits -b kits-split-rehearsal` on `feat/ks3-integration`
(1787971) walked 479 commits in about ten seconds and produced 25: nineteen
ordinary commits and six integration merges from the parallel migration
worktrees.

**Not one of those nineteen commits is kits-only.** Every single one also
touches files outside `kits/`, because a kit moved out of core in the same
commit that deleted its core files, which is what the migration asked for
(`feat(kits): move Review Kit into kits/review` is 12 files inside and 13
outside). The split history is therefore not a history; it is the kits-shaped
shadow of commits whose other half is missing. `docs(adr): record that a
bundled kit is a package Tau ships` survives the split as a one-file change to
`kits/README.md` under a subject about an ADR that is not in the repository.

**The kits' life before they were kits stays in core.** `subtree split` follows
the path, not the rename, so the split history begins at the foundation commit
and every kit's file has exactly one commit behind it. `git log --follow` in
core still finds `src/renderer/extensions/`.

**A host bundle statically inlines core.** `bundleHostExtension` resolves
`tau/host-extension` by alias and bundles it, so the shipped `host.cjs` files
contain 23 distinct compiled core modules between them — `workspace-git.js` in
fifteen of the fifteen kits, `persisted-json.js`, `session-lineage.js`,
`shell-environment.js`, the checkpoint modules. A prebuilt kit is not portable
across cores; it is a copy of one particular core's internals with a kit
wrapped around it. This is the fact that decides how a distribution is
published, below.

**The split tree does build against this core, and to the same bytes.**
`scripts/build-kits.mjs` grew `--kits <dir>` and `--out <dir>` (the smallest
option that lets it read a distribution that is not in this repository; the
defaults are unchanged). Building the checked-out split tree produced output
identical to the in-repo build except for the source paths esbuild records:
the leading comment of each module, one `__commonJS` key, and the `sources`
array of the inline sourcemap. Substituting the directory name in those three
places makes all 29 files compare equal, and the fifteen `tau-extension.json`
files were equal to begin with.

**The desktop app loads it.** The split-built `dist-kits/` was copied over the
worktree's with the distribution version marked `0.1.0-rehearsal`; Settings →
Packages headed the bundled list with `@tau/kits 0.1.0-rehearsal` and listed
all fifteen kits from `dist-kits/`, a prompt round-tripped on GPT-5.6 Luna, and
the Title generator kit named the thread. `--safe` came up with no kits.

**What the split tree does not carry.** No `tsconfig`, no Vitest config or
setup file, no lint config, no CI, no licence of its own (core is MIT; the
split tree would carry the same file). Kit *tests* import five core modules (`src/main/test-support/host-kit-harness`,
`src/renderer/test-support/{kit-harness,fake-host-client,workspace-host-stub,render-app}`)
across 52 import sites. Kit *sources* import only `tau` (59) and
`tau/host-extension` (35); `tau/host` is unused today. `kits/README.md` links
`../docs/adr/0014-…`.

## Decision

**Core is the list in [docs/CORE.md](../CORE.md).** Pi in a window plus
threads: transcript, composer, thread index and one runtime per thread, the two
layout slots, the palette and keybinding dispatch, the extension lifecycle on
both sides, the host protocol, and the three API modules a package sees (`tau`,
`tau/host-extension`, `tau/host`). Safe mode is the enforcement: whatever
`npm run start:safe` still shows is core, and anything else is a kit.

**A distribution owns its kits and two version numbers.** Each kit keeps the
`version` in its own `tau-extension.json`; the set keeps the `version` in the
distribution's `package.json`, which the build copies into
`dist-kits/manifest.json` and Settings shows above the bundled list. A
distribution also owns its own README, its licence, its kits' permission lists
and their isolation choices. It owns no part of the loader: a bundled kit and
an installed package travel the same code path, and the only difference stays
the one ADR 0014 names — shipping a kit is the approval.

**`engines.api` is the contract, and core alone moves `EXTENSION_API_VERSION`.**
The constant lives in `src/shared/extension-compat.ts`; its major moves when
`HostExtensionServices`, `WorkerHostServices`, `DesktopExtension` or the `tau`
hooks break, its minor when one of them only grows. A distribution never bumps
it and never vendors it; it declares the line it builds against
(`"engines": { "api": "^1.3.0" }`) in its `package.json` and in every kit's
manifest, and `src/shared/kits-boundary.test.ts` fails when the two drift while
the distribution is still in this repository. After a split that test becomes
the distribution's, run against the core it builds with. A kit whose
`engines.api` does not fit the running Tau stays off on both sides with the
reason in Settings → Inspector, which is the failure mode this contract is for:
a wrong pairing is visible and inert, never half-loaded.

**A distribution publishes sources; the core that runs it compiles them.**
Because a host bundle inlines core modules, a `@tau/kits` tarball of built
`host.cjs` files would ship one core's internals to every other core, and the
`engines.api` check — a runtime check by design — would have nothing left to
protect. So the published package is the `kits/` tree, and core builds it:

```bash
node scripts/build-kits.mjs --kits node_modules/@tau/kits --out dist-kits
```

`npm pack` on the distribution, `npm install` on the core side, one build step
that already exists. The `files` list in the distribution's `package.json`
describes `dist-kits/` today and would gain a second, source-shaped list (or
the build's file check moves to a `dist.files` field) — that is the one change
the split needs in the distribution.

**A distribution pins core through the API, core pins the distribution by
version.** From the kits side the pin is `engines.api`: a range on the
interfaces, not on the app, because Tau's own version is `0.0.0` and says
nothing (`engines.tau` becomes the better pin only once it does). From the core
side the pin is exact: `"@tau/kits": "0.4.1"` as a devDependency in the core's
`package.json`, so a core release is reproducible and `npm run build` picks the
same set every time. Neither side floats.

**Cadence: core ships on its tag, the distribution ships on its own.** Core
keeps `v*.*.*` and `.github/workflows/release.yml`. A distribution cuts
`kits-v*.*.*` whenever the set changes — minor for a kit added, removed or
meaningfully changed, patch for fixes, major when it drops a kit users depend
on or requires a new API major. A distribution release that needs API core has
not shipped yet cannot go out ahead of it: `engines.api` would fail on every
installed Tau. So the order is always core first, distribution second, and a
core release that wants a newer set raises its pin and re-cuts.

**The recipe, when the day comes.** From a clean core checkout:

```bash
core=$(git rev-parse HEAD)
git subtree split --prefix=kits -b kits-split          # the tree, with its file identities
git checkout --orphan kits-main kits-split             # drop the two-sided history
git commit -m "feat: import the Tau kits distribution

Split from Rasalas/tau $core with git subtree split --prefix=kits."
git push <new remote> kits-main:main
# then, on the core side:
git rm -r kits && npm install --save-dev @tau/kits@<version>
```

**The orphan commit is the point of that recipe.** The nineteen two-sided
commits are the argument against carrying the split history: they read as
half-commits under subjects about work that is not in the repository. The
complete history stays in core, where `git log --follow` still answers every
question about a kit's past, and the split branch is used for what it is good
at — carrying the tree and its file identities across. Provenance is the core
SHA in the root commit message.

**What the distribution needs on its first day.** Its own `tsconfig` with the
three `tau` path aliases (copy `tsconfig.kits.json`, drop `src`), its own Vitest
config with the same three resolve aliases, a lint config, a CI job that checks
out a core and runs *its* `scripts/build-kits.mjs --kits . --out dist-kits`
(the build script is core's and stays core's), a licence,
and a fix for the one relative link out of `kits/README.md`. The five
`test-support` modules kit tests reach for are the last real coupling: either
core publishes them (`tau/test-support`, a fourth API module, minor bump) or the
distribution takes a devDependency on a core checkout. That choice is below.

## Deliberately not decided

- **Whether the split happens, and when.** Nothing here schedules it. Two
  artifacts from one repository is cheaper and stays honest as long as the same
  people own both.
- **Where the test harnesses go.** `tau/test-support` as a fourth public API
  module is the clean answer and the expensive one — it makes five internal
  modules a versioned surface. A devDependency on a core checkout is the cheap
  answer and keeps a distribution tied to a working tree. Decide when a
  distribution outside this repository actually exists.
- **Repository name.** Core is MIT (`LICENSE`); a distribution outside this
  repository would ship the same licence, its name is not chosen.
- **Whether `@tau/kits` is published to npm at all**, or installed as a Git
  source the way `/install git:…` already installs any other package.
- **Whether core publishes `tau` as a typed npm package.** Today `tau.d.ts`
  sits beside the examples and the bundlers alias to files on disk.
- **Whether a third-party distribution becomes a first-class concept.** Today
  it is a set of packages a user installs, plus a `dist-kits/` a fork replaces;
  Settings shows one bundled distribution because there is one folder.

## Consequences

- `scripts/build-kits.mjs` takes `--kits` and `--out`. The defaults are the
  repository's own folders, so nothing about `npm run build`, `npm run dev` or
  the release changes; the options exist so that a distribution outside this
  repository can be built against this core, and so that this rehearsal can be
  repeated in one command.
- The rehearsal is repeatable and cheap: ten seconds for the split, one build,
  one instance. Re-run it before the split is ever taken seriously; the answer
  will have moved with the code.
- Prebuilt kits are not portable across cores, and that is now written down.
  Anyone tempted to publish `dist-kits/` as the artifact should read the module
  list above first.
- Nothing in this ADR changes what a user sees. Safe mode, the bundled list,
  the grant flow and `engines.api` behave exactly as ADR 0014 left them.
