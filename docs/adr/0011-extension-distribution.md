# ADR 0011: Extension distribution follows Pi's package model

## Status

Accepted, 2026-09-05.

## Context

ADR 0008 settled what a package *is* — a folder with a `tau-extension.json` — and left distribution open: PLAN.md still listed an installer, a registry, signing and update channels as unresolved. Until now the only way to install a package was to copy a folder into `~/.tau/extensions` by hand, and Settings' "Install extension…" button said so.

The obvious move is a registry of Tau's own: a JSON document listing packages, a file of registry URLs, `add-source` and `remove-source` commands. That is a second package index to host, to moderate and to keep alive, next to two that already exist and that every extension author already publishes to.

Pi solves the same problem without one. `pi install <source>` takes `npm:<package>`, `git:<url>` or a path, records it in the `packages` array of `~/.pi/agent/settings.json` (or the project's settings with `-l`), and resolves it under `~/.pi/agent/npm` and `~/.pi/agent/git`. npm and git *are* the registry.

## Decision

**The same four verbs, on the same three source kinds.** A bundled host extension `tau.packages` registers `install`, `remove`, `update` and `list`. A source is `npm:<package>[@version]`, `git:<https or ssh url>` or a folder path. `install` and `update` are `{ long: true }`, so a client runs them as host jobs with progress lines instead of blocking a request for the length of a clone.

**Two source lists, one per scope.** `~/.tau/packages.json` holds the sources every project sees; `<project>/.tau/packages.json` holds the project's own, which is Pi's `-l`. Both are `{ "version": 1, "packages": ["npm:@acme/hello", "git:https://…", "/path/to/folder"] }`, written through `persisted-json.ts` (atomic, versioned, quarantined when unparsable). A project's list is gated on Pi's project trust exactly as `<project>/.tau/extensions` is.

**Where a source lands.** npm goes through the machine's own npm — `npm install --prefix ~/.tau/npm <package>`, found via the host seam's `findCommand`, no bundled client — and resolves to `~/.tau/npm/node_modules/<name>`. A Git source is a `git clone --depth 1` into `~/.tau/git/<host-and-path-flattened>`, and `update` is a `git pull --ff-only`. A folder path is loaded where it lies: nothing is copied, so a developer can `/install ./my-extension` and keep editing it. `assertAllowedCloneSource` (the project picker's rule) decides which Git URLs are allowed; a resolved folder that would fall outside its store is refused.

**The scan reads the lists.** `listExtensionPackages` and `loadDesktopExtensions` walk the two extension folders as before and then add whatever the two `packages.json` files name. A package installed from a source and a folder dropped in by hand look identical afterwards, which keeps ADR 0008's promise that a package installs, updates and uninstalls by moving a folder.

**Installing is not activating.** `install` records and reports; the grant flow of ADR 0009 still decides whether either half runs. An update that keeps the permission list keeps the grant, because a grant is matched on id and permissions; a changed list means the package waits again.

**Signatures are an optional layer.** A package may carry `tau-extension.sig` next to its manifest:

```json
{ "publisher": "acme", "algorithm": "ed25519", "signature": "<base64>", "files": { "host.ts": "<sha256>" } }
```

`files` covers every file of the folder except `.git` and the signature itself; the signature is over the canonical JSON of `{ files, id, version }` — keys sorted, no whitespace — so signer and verifier hash the same bytes. `~/.tau/trusted-publishers.json` maps key ids to Ed25519 public keys, PEM or raw base64. Verification runs in the scan, and only when a signature file exists, so the common unsigned package costs one failed `readFile`.

The file hashes are checked **before** the key is looked up. That order is the point: a package whose files no longer match its own signature refuses to load with the offending path in the message, whether or not anyone trusts its publisher. An unsigned package installs and says "unsigned"; one signed by a key nobody trusts installs and says "signature not trusted". `scripts/keygen-extension.mjs` and `scripts/sign-extension.mjs` are the publisher's side; `npm run smoke:extension-install` drives keygen → sign → install → list → tamper → refuse end to end.

## Consequences

- Tau hosts no index. An author publishes to npm or pushes a repository, and the source string is the whole address.
- `/install`, `/remove` and `/update` read like Pi's CLI in the composer, and Settings → Packages is the same thing with a form.
- `update` is whatever npm and git decide: `npm install` re-resolves the recorded range, `git pull --ff-only` refuses a diverged clone. There is no separate "check for updates" step, because there is nothing to check against but the network.
- A signature proves the folder is the folder the publisher signed. It does not prove the publisher is trustworthy, and Tau has no revocation list: dropping a key from `trusted-publishers.json` is the whole mechanism.
- Not solved here: a hosted registry with search and ratings, revocation and key rotation, signed npm tarballs verified before extraction (npm's own integrity check is what covers that today), and a review process for what a package may ask for.
