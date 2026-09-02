# ADR 0009: Extension permissions and process model

## Status

Accepted, 2026-09-02.

## Context

Tau loads third-party extension packages on both sides of the application: host code runs in Node.js within Electron's main process, and desktop code runs in the renderer's DOM. Without safeguards, an extension could read sensitive files across the workspace, make unauthorized network requests, or compromise the main process.

At the same time, full OS-level process sandboxing or separate VM sandboxes for every extension would introduce immense architectural complexity, IPC serialization latency, and memory overhead. Tau needs effective, transparent protection against abuse without a heavy sandboxing framework.

## Decision

1. **Explicit Permission Vocabulary (`src/shared/extension-permissions.ts`)**:
   Permissions are declared statically in `tau-extension.json`:
   - `workspace:read`: Access project path and read workspace file contents.
   - `workspace:write`: Modify workspace files and stage git transactions.
   - `workspace:switch`: Request switching or opening other projects.
   - `sessions`: Access session files, branch threads, run offscreen runtimes, sweep indexes.
   - `runtime:extend`: Register custom agent runtimes and background task adapters.
   - `process`: Spawn or execute tracked child processes.
   - `network`: Perform outbound HTTP/TCP requests (enforced in runtime extensions).

2. **Host Seam Enforcement via Proxy Guard**:
   When activating a package's host half in `HostExtensionRegistry`, `HostExtensionServices` is wrapped in a dynamic proxy (`guardedServices`). Every method or property access checks if the extension's declared permissions include the required capability. Access without permission throws an error (`Extension <id> lacks permission <perm>`) and logs an audit event (`host-extension.denied`). Bundled internal kits declare their permissions explicitly; packages without declared permissions default to none (`[]`).

3. **Renderer Isolation via Bundler Define**:
   When bundling desktop extensions in `bundleDesktopExtension`, `esbuild` defines `window.tau = undefined`. Third-party desktop extensions cannot invoke arbitrary Electron IPC channels on the global window. Instead, they interact solely through the scoped `DesktopExtensionContext` passed to `activate()`.

4. **User Consent Store (`~/.tau/extension-grants.json`)**:
   Extensions are tracked in `~/.tau/extension-grants.json`. When a package is first encountered, or when its requested permissions change, it remains unactivated with status `"wartet auf Freigabe"` in Settings. The user explicitly reviews requested permissions and clicks "Erlauben" (grants permissions and activates both halves) or "Ablehnen".

5. **Crash Protection and Isolation**:
   - **Host**: If a host command times out (30s default) or fails 3 consecutive times, `HostExtensionRegistry` deactivates the extension and records the failure.
   - **Renderer**: Extension contribution slots (sidebar, panels, regions, status line, composer controls, prompt renderers, transcript rows) are wrapped in `LazyFeatureBoundary`. If an extension throws a render error, the boundary catches it, automatically deactivates the extension in `ExtensionRegistry`, and surfaces a non-blocking toast notification.

Full worker-thread or out-of-process renderer isolation is deferred to Phase 4.

## Consequences

- Minimal runtime overhead while guaranteeing immediate enforcement on all host services.
- Third-party desktop extensions cannot reach raw Electron IPC, preventing elevation of privileges.
- Transparent user consent model where permissions must be granted before code executes.
- Broken or malicious extensions cannot take down the workbench shell or cause a blank white screen.
