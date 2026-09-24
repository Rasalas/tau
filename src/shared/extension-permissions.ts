export const EXTENSION_PERMISSIONS = [
  "workspace:read",
  "workspace:write",
  "workspace:switch",
  "sessions",
  "runtime:extend",
  "process",
  "network",
  "packages",
] as const;

export type ExtensionPermission = (typeof EXTENSION_PERMISSIONS)[number];

export const PERMISSION_WORKSPACE_READ = "workspace:read" as const;
export const PERMISSION_WORKSPACE_WRITE = "workspace:write" as const;
export const PERMISSION_WORKSPACE_SWITCH = "workspace:switch" as const;
export const PERMISSION_SESSIONS = "sessions" as const;
export const PERMISSION_RUNTIME_EXTEND = "runtime:extend" as const;
/**
 * Starting processes, and the host-side bookkeeping for them
 * (`noteSubprocess`, `findCommand`). Inside a worker the grant is enforced:
 * `child_process` is refused without it, through both the `require` and the
 * `import()` interception. For an `in-process` package it is advisory, like
 * every other permission there.
 */
export const PERMISSION_PROCESS = "process" as const;
/**
 * Outbound network access. Enforced inside the worker a package is isolated in
 * (`fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest` and the socket
 * builtins throw without it, whether they are reached by `require` or by
 * `import()`); advisory for an `in-process` package, which by definition runs
 * with everything the host process can reach.
 */
export const PERMISSION_NETWORK = "network" as const;

/** Install, update and remove other extension packages. Tau's own Packages kit holds it. */
export const PERMISSION_PACKAGES = "packages" as const;

/**
 * The one line Settings shows a package that asked to run in the host process.
 * Nothing is enforced there — no interception point would hold — so the
 * phrasing says so rather than naming one permission.
 */
export const NETWORK_ADVISORY_NOTE = "runs inside the host process; permissions are not enforced there";

/**
 * Where a package's host half runs. `worker` is the default for packages: a
 * worker thread with a heap cap, no Electron and only the serializable facade.
 * `in-process` is a privilege the user grants like a permission.
 */
export const EXTENSION_ISOLATIONS = ["worker", "in-process"] as const;

export type ExtensionIsolation = (typeof EXTENSION_ISOLATIONS)[number];

export const DEFAULT_PACKAGE_ISOLATION: ExtensionIsolation = "worker";

export function isExtensionIsolation(value: unknown): value is ExtensionIsolation {
  return typeof value === "string" && (EXTENSION_ISOLATIONS as readonly string[]).includes(value);
}

export function isExtensionPermission(value: unknown): value is ExtensionPermission {
  return typeof value === "string" && (EXTENSION_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Maps HostExtensionServices methods and property access to the required permission.
 * Properties not present here (like safeMode, log, runtimeOwner) require no special permissions.
 */
export const HOST_SERVICE_PERMISSIONS: Readonly<Record<string, ExtensionPermission>> = {
  cwd: "workspace:read",
  projectName: "workspace:read",
  describeProjects: "workspace:read",
  knownWorkspacePath: "workspace:read",
  admitWorkspace: "workspace:write",
  rememberProjectName: "workspace:write",
  openWorkspace: "workspace:switch",
  pickDirectory: "workspace:switch",
  thread: "sessions",
  complete: "sessions",
  completionModels: "sessions",
  setThreadTitle: "sessions",
  attachedRuntime: "sessions",
  sessions: "sessions",
  registerThreadLifecycle: "sessions",
  registerTurnObserver: "sessions",
  pinTranscriptEntries: "sessions",
  turnAttachments: "sessions",
  registerRuntimeExtension: "runtime:extend",
  loadRuntimeExtension: "runtime:extend",
  decorateUiPrompt: "runtime:extend",
  setPermissionLevel: "runtime:extend",
  registerRuntimeBackend: "runtime:extend",
  mcp: "runtime:extend",
  modelAuth: "runtime:extend",
  presentUi: "runtime:extend",
  noteSubprocess: "process",
  findCommand: "process",
  // The host's own listeners: a proxy in front of them and the addresses they publish.
  network: "network",
  listPackages: "packages",
  installPackage: "packages",
  removePackage: "packages",
  updatePackages: "packages",
  // The skill catalog is what a runtime offers a thread; the permission that
  // lets a package register a runtime backend is the one that lets it read it.
  skills: "runtime:extend",
};
