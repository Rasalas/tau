# ADR 0008: Extension packages carry a manifest

## Status

Accepted, 2026-09-02.

## Context

Phase 1b split every feature into a desktop half and a host half. A package that ships both needs one identity and one place to say where its entries are, and Tau needs to find it without a source edit. Pi's own convention, a file dropped into an extensions folder, covers a single-module extension but not a two-sided package with dependencies.

The open question in PLAN.md was the manifest and distribution format. Two shapes were considered: a `package.json` field, which makes every package an npm package with a build, or a small file of Tau's own next to the entries.

## Decision

A package is a folder under `~/.tau/extensions` or `<project>/.tau/extensions` with a `tau-extension.json`:

```json
{ "id": "acme.hello", "name": "Hello", "desktop": "./desktop.tsx", "host": "./host.ts" }
```

`id` is lowercase and dot-separated and is the id both halves export; `desktop` and `host` are relative entry paths inside the folder, either may be missing. The host compiles each entry with esbuild at load time, so a package may import its dependencies from its own `node_modules` and never needs a build step. Project packages load only where Pi trusts the project. The Settings toggle of a package turns both halves off and on.

The manifest carries no version. Tau and the contribution interfaces are still moving; a version field would promise a compatibility check that does not exist yet. Phase 2 adds the field together with the check.

## Consequences

- A package installs, updates and uninstalls by copying, editing or deleting a folder, then `/reload`.
- A bundled kit and an installed package look the same to the host and the renderer; the bundled kits are the reference for the shape.
- Nothing is distributed yet: no registry, no signing, no update channel. Those belong to Phase 2 and Phase 3 and are listed as open in PLAN.md.
