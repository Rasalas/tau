# ADR 0009: Extension permissions and process model

## Status

Accepted, 2026-09-02. Extended 2026-09-04 with the `tau-ext` scheme and the renderer sandbox, and 2026-09-05 with isolated host packages.

## Context

An extension package runs on both sides of the app: its host half in Electron's main process with Node available, its desktop half in the renderer's DOM. Before this ADR the only gate was Pi's project trust, which says nothing about global packages and nothing about what a package may do once it runs. A package could open another workspace, read every session, register a runtime backend and spawn processes, and a loop in a host command froze the main process.

Running each package in its own process or VM would cost an IPC hop per call, a serialisation format for `HostExtensionServices` and a lot of lifecycle code. Tau needs a gate the user can read and a failure mode that keeps the workbench usable, not a full sandbox framework.

## Decision

**A permission vocabulary in the manifest.** `src/shared/extension-permissions.ts` fixes seven names: `workspace:read`, `workspace:write`, `workspace:switch`, `sessions`, `runtime:extend`, `process`, `network`. A manifest lists what it wants under `permissions`; an unknown name is a manifest error and a missing field means none.

**The host seam enforces them.** `guardedServices` wraps `HostExtensionServices` in a proxy when the registry activates a package. Each member maps to one permission (`HOST_SERVICE_PERMISSIONS`); reaching a member without the permission throws `Extension <id> lacks permission <name>` and logs `host-extension.denied`. A bundled kit that declares nothing keeps the full facade, which is what makes it distinguishable from a package: a package always carries a list, even an empty one.

**Consent before the first run.** Grants live in `~/.tau/extension-grants.json` as `{ id, version, permissions, grantedAt }`. A package whose id or permission set does not match a grant does not start; Settings shows it as waiting with the list it asks for, and Allow writes the grant and starts both halves. Because importing a host entry already runs its top-level code, the scan stops *before* the import for an unapproved package, in the global and the project folder alike.

**Failure containment.** A host command runs under a 30 s timeout; a timeout, or three consecutive failures, deactivates the package and records the reason in `summaries()`. In the renderer every slot a package renders sits in `LazyFeatureBoundary`, which deactivates the package in `ExtensionRegistry` and raises a toast instead of blanking the workbench. A synchronous infinite loop was the case this did not catch; the worker below closes it.

**Provenance.** `source: { url, commit? }` is optional and shown in the Inspector. It records where a package came from and proves nothing on its own; [ADR 0011](0011-extension-distribution.md) adds an optional `tau-extension.sig` that does, for the folder's contents.

## 2026-09-04: the renderer boundary

**Bundles are served, not built in the page.** A desktop bundle used to be imported from a blob URL, which forced `script-src 'self' blob:` on the whole document — every script the renderer can assemble at runtime, not just extension code. The main process now registers `tau-ext` as a privileged, standard, secure scheme with fetch support before `app.whenReady` and answers `tau-ext://bundles/<extension-id>/<content-hash>.js` from the bundles it holds in memory (`src/main/extension-bundle-server.ts`). Anything else is a 404, the id is reduced to one safe path segment, and each sync clears the set so a stale hash stops resolving. The CSP is now `script-src 'self' tau-ext:`. The browser preview has no host to serve from and keeps a blob URL in the one place that decides, `importBundle` in `src/renderer/runtime-extensions.ts`.

**The renderer is sandboxed.** `webPreferences` adds `sandbox: true` alongside the existing `contextIsolation` and `nodeIntegration: false`, plus `webSecurity: true`, `allowRunningInsecureContent: false`, `webviewTag: false`, `nodeIntegrationInSubFrames: false` and `spellcheck: false`. This costs nothing: the preload is one esbuild CJS bundle whose only `require` is `electron`, and `contextBridge`/`ipcRenderer` both work under the sandbox.

**Nothing may ask for a device.** `session.defaultSession` denies every permission request and every permission check, and `will-attach-webview` is prevented on every `webContents`, so a package cannot reach a camera, a microphone, a location or a nested frame with different settings.

## 2026-09-05: isolated host packages

**A package's host half runs in a worker thread.** `isolation` in the manifest is `"worker"` (the default for a package) or `"in-process"`. For a worker, `loadHostExtensionPackages` writes the esbuild bundle to the cache and hands the path to `createWorkerHostExtension` (`src/main/host-extension-isolation.ts`) instead of importing it: nothing of the package runs in the main process, not even its top-level code. The worker entry is `src/main/host-extension-worker.ts`, shipped compiled beside the other main modules and bundled on the fly when Tau runs from source. It caps the heap with `resourceLimits` (256 MB old space) and blocks `require("electron")` through `Module._load` — the only interception point Electron's Node 22.14 has — with an error naming the way out.

**The context crosses as JSON-RPC.** Both directions carry `{ t, id, … }` messages over the worker port: the worker asks for a service and the host answers, the host calls a command or a hook and the worker answers, and both push (`emit`, `log`, `command`, `release`). Only serializable things cross, so the facade differs from the in-process one:

| Available in a worker | Not available |
| --- | --- |
| `cwd`, `log`, `safeMode` | `attachedRuntime` (a live Pi terminal) |
| `openWorkspace`, `knownWorkspacePath`, `pickDirectory` | `registerRuntimeBackend`, `registerRuntimeExtension` |
| `projectName`, `rememberProjectName`, `describeProjects` (facts answered by round trip) | `decorateUiPrompt`, `setPermissionLevel`, `presentUi` |
| `runtimeOwner`, `thread(sessionId)` as a plain snapshot, `transcript`, `setThreadTitle` | `sessions.open` returning a live `HostSessionFile`, `sessions.prepare`, `sessions.refreshIndex` |
| `noteSubprocess`, `findCommand` | a `beforeActivate` transaction (a worker hook returns nothing) |
| `sessions.list`, `sessions.read` (entries as data), `sessions.exclusive` | anything else handing out a live object |
| `registerThreadLifecycle`, `registerTurnObserver`, `setPendingWork`, `pinTranscriptEntries` (pins pushed as data) | |

Everything is asynchronous where the in-process facade is not, `exclusive(work)` is a main-side critical section around one round trip, and the two synchronous seams — `pending` and the pin provider — read data the worker pushed. A member that cannot exist throws in the worker before it sends anything, and names `"isolation": "in-process"` as the answer.

**Permissions stay on the main side.** The supervisor dispatches into the facade `guardedServices` already wrapped, so a denied member throws and logs `host-extension.denied` exactly as before; a worker cannot reach past its grant by asking differently.

**Isolation is itself a grant.** `in-process` is listed in the approval box beside the permission names and recorded in the grant, so a package that leaves the worker after it was approved has to be approved again. Bundled kits are not packages: they are constructed in the host and stay in-process, because they register runtime backends and Pi extensions, hand out session managers and take part in the activation transaction — all things the table above cannot carry.

**One activation model.** The worker-backed extension is a plain `HostExtension` the registry activates like any other, so `PiHost` and the seam never learn that a worker exists. `context.fail(reason)` is the one addition: a worker that throws, exits, exceeds its heap or misses the command timeout is terminated, its package deactivated with the reason, and the host keeps running. The Inspector and the extension page show the mode and the failure.

## Consequences

- A user sees what a package wants before any of its code runs, in either scope.
- A desktop package cannot reach raw IPC: `window.tau` is defined away at bundle time and `globalThis.__tauShared.tau` is the only bridge.
- A host package can no longer freeze the workbench with a synchronous loop, exhaust the host's heap, or crash it by exiting. It still reads files through Node directly and can still lie in its manifest: the worker bounds the blast radius, it is not an OS sandbox.
- An isolated package pays a round trip per service call and cannot hold a live host object, which is why a kit that needs one declares `in-process` — and asks the user for it.
- The CSP no longer allows arbitrary blob scripts, so an injection that can build a string can no longer turn it into a module.
