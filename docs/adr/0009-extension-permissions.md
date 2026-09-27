# ADR 0009: Extension permissions and process model

## Status

Accepted, 2026-09-02. Extended 2026-09-04 with the `tau-ext` scheme and the renderer sandbox, 2026-09-05 with isolated host packages, 2026-09-06 with an enforced `network`, and 2026-09-21 with an enforced `process`, an `import()` that no longer bypasses the guard, and the lifecycle hooks the seam gained beside them.

## Context

An extension package runs on both sides of the app: its host half in Electron's main process with Node available, its desktop half in the renderer's DOM. Before this ADR the only gate was Pi's project trust, which says nothing about global packages and nothing about what a package may do once it runs. A package could open another workspace, read every session, register a runtime backend and spawn processes, and a loop in a host command froze the main process.

Running each package in its own process or VM would cost an IPC hop per call, a serialisation format for `HostExtensionServices` and a lot of lifecycle code. Tau needs a gate the user can read and a failure mode that keeps the workbench usable, not a full sandbox framework.

## Decision

**A permission vocabulary in the manifest.** `src/shared/extension-permissions.ts` fixes seven names: `workspace:read`, `workspace:write`, `workspace:switch`, `sessions`, `runtime:extend`, `process`, `network`. A manifest lists what it wants under `permissions`; an unknown name is a manifest error and a missing field means none.

**The host seam enforces them.** `guardedServices` wraps `HostExtensionServices` in a proxy when the registry activates a package. Each member maps to one permission (`HOST_SERVICE_PERMISSIONS`); reaching a member without the permission throws `Extension <id> lacks permission <name>` and logs `host-extension.denied`. A bundled kit that declares nothing keeps the full facade, which is what makes it distinguishable from a package: a package always carries a list, even an empty one.

**Consent before the first run.** Grants live in `~/.tau/extension-grants.json` as `{ id, version, permissions, grantedAt }`. A package whose id or permission set does not match a grant does not start; Settings shows it as waiting with the list it asks for, and Allow writes the grant and starts both halves at once: `ExtensionPackageActivator` (`src/main/extension-package-activation.ts`) rescans, imports and activates the host half, then publishes `extension-packages-changed` so the client rebuilds and imports the desktop half. Neither half waits for a reload. Because importing a host entry already runs its top-level code, the scan stops *before* the import for an unapproved package, in the global and the project folder alike.

**Failure containment.** A host command runs under a 30 s timeout; a timeout, or three consecutive failures, deactivates the package and records the reason in `summaries()`. The registry also publishes an `extension-deactivated` event, once per deactivation, which the client shows as `Package <name> deactivated: <reason>` with the way back to Settings — a package that stops on its own is otherwise only visible in the Signals view. In the renderer every slot a package renders sits in `LazyFeatureBoundary`, which deactivates the package in `ExtensionRegistry` and raises a toast instead of blanking the workbench. A synchronous infinite loop was the case this did not catch; the worker below closes it. Since 2026-09-06 a `HostCommandError` — a command's answer to bad input, such as a path that is not a folder — is exempt from the count, so three typos cannot switch a package off.

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

## 2026-09-06: `network` is enforced in the worker

`network` was in the vocabulary and in the approval box but gated nothing: no `HostExtensionServices` member maps to it, because a package that dials out never asks the host for anything. It is the one permission the main side cannot see, so the worker enforces it for itself.

**The grant travels in the bootstrap.** `WorkerBootstrap` now carries `permissions`, the same list `createWorkerHostExtension` already had (absent means empty — an isolated extension is always a package). Nothing else changed on the wire.

**Two doors, both shut before the bundle loads.** Without `network`, `host-extension-worker.ts` replaces whichever of `fetch`, `WebSocket`, `EventSource` and `XMLHttpRequest` this Node defines on the worker global, and extends the existing `Module._load` hook to refuse `http`, `https`, `net`, `tls`, `dgram`, `http2` and `dns` — under any `node:` prefix and any submodule, so `node:dns/promises` is the same door as `dns`. Both throw `Extension <id> lacks permission network` and log `host-extension.denied` through the port, so the Inspector and Signals show a denied socket exactly like a denied service member. `child_process` is not on the list: spawning stays governed by `process`. A bundled `ws` or `undici` needs `net`/`tls` and hits the same wall.

**2026-09-10: the guardrails are not boundaries.** The `Module._load` hook does not cover `import()` (dynamic import uses a different code path in Node 22). `await import("node:https")` bypasses the hook and returns a live module. A nested `worker_threads` worker likewise runs outside the interception. `worker_threads` is not in `NETWORK_MODULES` because blocking it would also block the isolation mechanism itself. The grants remain useful as a statement of intent and as a UI guardrail, but they do not stop hostile code. [ADR 0018](0018-sandboxed-host-extensions.md) collects the options for a true boundary.

The `process` grant gates `noteSubprocess` and `findCommand`, not `child_process`. A package without the grant can still spawn processes; it just cannot tell the host about them. The documentation was updated to match.

**In-process is where it stops.** A package granted `in-process` runs with everything the host process can reach; there is no interception point that would hold there, and adding one would be theatre. `in-process` is itself the grant, and for such a package `network` is advisory — Settings says so in the approval box. Bundled kits keep the full facade as before.

## Consequences

- A user sees what a package wants before any of its code runs, in either scope.
- A desktop package cannot reach raw IPC: `window.tau` is defined away at bundle time and `globalThis.__tauShared.tau` is the only bridge.
- A host package can no longer freeze the workbench with a synchronous loop, exhaust the host's heap, or crash it by exiting. It still reads files through Node directly and can still lie in its manifest: the worker bounds the blast radius, it is not an OS sandbox.
- An isolated package pays a round trip per service call and cannot hold a live host object, which is why a kit that needs one declares `in-process` — and asks the user for it.
- A worker package that did not ask for `network` or `process` meets a guardrail that blocks `fetch`, `require("http")`, `await import("node:http")`, `child_process` and a nested worker — but not a package that puts the hooks back. A package that asked for `in-process` bypasses all of it, which is one more reason to read that line in the approval box.
- The CSP no longer allows arbitrary blob scripts, so an injection that can build a string can no longer turn it into a module.

## 2026-09-21: `process` is enforced in the worker, and `import()` is closed

The 2026-09-10 note above recorded two holes and left them open: the
`Module._load` hook did not cover dynamic `import()`, and `process` gated the
host's bookkeeping rather than the spawn. Both are closed as far as an
in-process interception can close them.

**`process` gates `child_process` in a worker.** Without the grant, the worker
refuses `child_process` under any `node:` prefix, the way `network` already
refused the socket builtins. The facade members (`noteSubprocess`,
`findCommand`) stay gated by the same permission on the main side, and the
grant still does not do the bookkeeping for the package: a package that spawns
calls `noteSubprocess` itself.

**`import()` goes through `module.registerHooks`.** Electron 36 ships Node
22.19, which has the synchronous `registerHooks` that 22.14 did not. A resolve
hook now refuses the same module names for `import()` that `Module._load`
refuses for `require`, so `await import("node:https")` no longer walks past the
guard. Both interceptions are installed, because the ESM hook does not replace
`Module._load` for every path Node takes and `Module._load` never saw
`import()`.

**A nested worker is refused while anything is left to escape.** A worker
started from inside a worker runs outside both interceptions. `worker_threads`
is therefore refused for a package that is missing `network` or `process`; a
package holding both has nothing left to gain from one, and gets it.

**It is still a guardrail.** The package holds `node:module` and can undo both
hooks; it reads and writes files either way. And for `in-process` nothing is
enforced at all — the approval box no longer names one permission there but
says "runs inside the host process; permissions are not enforced there", which
is the whole truth. A real boundary is a separate execution context:
[ADR 0018](0018-sandboxed-host-extensions.md) still holds that case.

## 2026-09-21: the thread lifecycle gained two hooks and a client observer

`HostThreadLifecycle` gained `afterWorkspaceClose(cwd, reason)` and
`threadDeleted(sessionId, cwd)`; `services.clients` (ungated) reports which
clients are attached, fed by both transports. None of them is a permission
decision — `clients` carries a count, a transport name and a client profile —
but they are part of the same facade and the worker carries all three.

## 2026-09-14: command authority and desktop trust

The desktop half runs inside the trusted workbench realm. Its declared package
permissions do not isolate its host-bridge calls from other desktop code.
Receiver-side grants govern the host handler's facade; caller command authority
is a separate decision in [ADR 0020](0020-host-command-authority.md). A request's
extension ID or callerId is never proof of an independent desktop identity.
Expected service-permission denials use HostCommandError and do not consume the
handler-crash budget in either the in-process or worker path.

## 2026-09-27: native code is a permission of its own

A worker package could load an addon itself (`process.dlopen`, a `.node`
require, a SQLite extension). That code runs outside every guard and cap of the
worker, and a crash in it stops the host with all its threads. The vocabulary
gains `native`: without it the worker refuses every way to compiled code it
has (`process.dlopen`, the `.node` handler, an `import` of one,
`DatabaseSync#loadExtension`, `process.binding`, `process._linkedBinding`,
`v8.setFlagsFromString`). The raw bindings also walked around `network` and
`process`, and so did `process.getBuiltinModule`, `cluster`, `node:test` and
`inspector`; those are closed now too. A nested worker needs all three grants.
Unlike the module hooks, the native doors cannot be put back: the worker keeps
no copy of the originals. The approval box explains `native` beside its name.
For `in-process` nothing changes: `loadDependency` needs no grant there.
