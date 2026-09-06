# ADR 0008: Extension packages carry a manifest

## Status

Accepted, 2026-09-02. Amended the same day: `version` and `engines` (see below).

## Context

Phase 1b split every feature into a desktop half and a host half. A package that ships both needs one identity and one place to say where its entries are, and Tau needs to find it without a source edit. Pi's own convention, a file dropped into an extensions folder, covers a single-module extension but not a two-sided package with dependencies.

The open question in PLAN.md was the manifest and distribution format. Two shapes were considered: a `package.json` field, which makes every package an npm package with a build, or a small file of Tau's own next to the entries.

## Decision

A package is a folder under `~/.tau/extensions` or `<project>/.tau/extensions` with a `tau-extension.json`:

```json
{ "id": "acme.hello", "name": "Hello", "desktop": "./desktop.tsx", "host": "./host.ts" }
```

`id` is lowercase and dot-separated and is the id both halves export; `desktop` and `host` are relative entry paths inside the folder, either may be missing. The host compiles each entry with esbuild at load time, so a package may import its dependencies from its own `node_modules` and never needs a build step. Project packages load only where Pi trusts the project. The Settings toggle of a package turns both halves off and on.

Amendment: the manifest may carry `version` (the package's own semver) and `engines`, ranges of `tau`, `pi` and `api` the package runs on. `api` is the version of the contribution interfaces (`EXTENSION_API_VERSION` in `src/shared/extension-compat.ts`); its major moves when `HostExtensionServices`, `DesktopExtension` or the `tau` hooks break, its minor when they grow. The check runs in the host's scan (`listExtensionPackages`) and in the desktop loader with the same versions, so an incompatible package is off on both sides and listed with the reason. A range Tau cannot read is a manifest error, not a silent miss. The range grammar is a deliberately small subset of npm's (`*`, exact, `^`, `~`, comparators, `||`); Tau depends on no semver library for it.

## Consequences

- A package installs, updates and uninstalls by copying, editing or deleting a folder. `/install`, `/update`, `/remove` and Allow rescan and re-bind it on the spot ([ADR 0011](0011-extension-distribution.md)); `/reload` is the fallback for a folder edited by hand.
- A bundled kit and an installed package look the same to the host and the renderer; the bundled kits are the reference for the shape.
- Distribution followed in [ADR 0011](0011-extension-distribution.md): `npm:`, `git:` and folder sources, a source list per scope, and an optional Ed25519 signature. The folder is still the unit; an installed package and a hand-copied one are indistinguishable to the scan.
