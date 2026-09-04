# ADR 0009: Extension permissions and process model

## Status

Accepted, 2026-09-02. Extended 2026-09-04 with the `tau-ext` scheme and the renderer sandbox.

## Context

An extension package runs on both sides of the app: its host half in Electron's main process with Node available, its desktop half in the renderer's DOM. Before this ADR the only gate was Pi's project trust, which says nothing about global packages and nothing about what a package may do once it runs. A package could open another workspace, read every session, register a runtime backend and spawn processes, and a loop in a host command froze the main process.

Running each package in its own process or VM would cost an IPC hop per call, a serialisation format for `HostExtensionServices` and a lot of lifecycle code. Tau needs a gate the user can read and a failure mode that keeps the workbench usable, not a full sandbox framework.

## Decision

**A permission vocabulary in the manifest.** `src/shared/extension-permissions.ts` fixes seven names: `workspace:read`, `workspace:write`, `workspace:switch`, `sessions`, `runtime:extend`, `process`, `network`. A manifest lists what it wants under `permissions`; an unknown name is a manifest error and a missing field means none.

**The host seam enforces them.** `guardedServices` wraps `HostExtensionServices` in a proxy when the registry activates a package. Each member maps to one permission (`HOST_SERVICE_PERMISSIONS`); reaching a member without the permission throws `Extension <id> lacks permission <name>` and logs `host-extension.denied`. A bundled kit that declares nothing keeps the full facade, which is what makes it distinguishable from a package: a package always carries a list, even an empty one.

**Consent before the first run.** Grants live in `~/.tau/extension-grants.json` as `{ id, version, permissions, grantedAt }`. A package whose id or permission set does not match a grant does not start; Settings shows it as waiting with the list it asks for, and Allow writes the grant and starts both halves. Because importing a host entry already runs its top-level code, the scan stops *before* the import for an unapproved package, in the global and the project folder alike.

**Failure containment.** A host command runs under a 30 s timeout; a timeout, or three consecutive failures, deactivates the package and records the reason in `summaries()`. This does not catch a synchronous infinite loop — that needs a worker thread, which is Phase 4 work. In the renderer every slot a package renders sits in `LazyFeatureBoundary`, which deactivates the package in `ExtensionRegistry` and raises a toast instead of blanking the workbench.

**Provenance.** `source: { url, commit? }` is optional and shown in the Inspector. It records where a package came from; it proves nothing, because nothing is signed.

## 2026-09-04: the renderer boundary

**Bundles are served, not built in the page.** A desktop bundle used to be imported from a blob URL, which forced `script-src 'self' blob:` on the whole document — every script the renderer can assemble at runtime, not just extension code. The main process now registers `tau-ext` as a privileged, standard, secure scheme with fetch support before `app.whenReady` and answers `tau-ext://bundles/<extension-id>/<content-hash>.js` from the bundles it holds in memory (`src/main/extension-bundle-server.ts`). Anything else is a 404, the id is reduced to one safe path segment, and each sync clears the set so a stale hash stops resolving. The CSP is now `script-src 'self' tau-ext:`. The browser preview has no host to serve from and keeps a blob URL in the one place that decides, `importBundle` in `src/renderer/runtime-extensions.ts`.

**The renderer is sandboxed.** `webPreferences` adds `sandbox: true` alongside the existing `contextIsolation` and `nodeIntegration: false`, plus `webSecurity: true`, `allowRunningInsecureContent: false`, `webviewTag: false`, `nodeIntegrationInSubFrames: false` and `spellcheck: false`. This costs nothing: the preload is one esbuild CJS bundle whose only `require` is `electron`, and `contextBridge`/`ipcRenderer` both work under the sandbox.

**Nothing may ask for a device.** `session.defaultSession` denies every permission request and every permission check, and `will-attach-webview` is prevented on every `webContents`, so a package cannot reach a camera, a microphone, a location or a nested frame with different settings.

## Consequences

- A user sees what a package wants before any of its code runs, in either scope.
- A desktop package cannot reach raw IPC: `window.tau` is defined away at bundle time and `globalThis.__tauShared.tau` is the only bridge.
- Nothing keeps a host package from a synchronous loop, from reading files through Node directly, or from lying in its manifest. The permission list is a statement of intent that the service facade enforces, not a sandbox.
- The CSP no longer allows arbitrary blob scripts, so an injection that can build a string can no longer turn it into a module.
