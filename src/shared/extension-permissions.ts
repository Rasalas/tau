export const EXTENSION_PERMISSIONS = [
  "workspace:read",
  "workspace:write",
  "workspace:switch",
  "sessions",
  "runtime:extend",
  "process",
  "network",
] as const;

export type ExtensionPermission = (typeof EXTENSION_PERMISSIONS)[number];

export const PERMISSION_WORKSPACE_READ = "workspace:read" as const;
export const PERMISSION_WORKSPACE_WRITE = "workspace:write" as const;
export const PERMISSION_WORKSPACE_SWITCH = "workspace:switch" as const;
export const PERMISSION_SESSIONS = "sessions" as const;
export const PERMISSION_RUNTIME_EXTEND = "runtime:extend" as const;
export const PERMISSION_PROCESS = "process" as const;
export const PERMISSION_NETWORK = "network" as const;

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
  rememberProjectName: "workspace:write",
  openWorkspace: "workspace:switch",
  pickDirectory: "workspace:switch",
  thread: "sessions",
  setThreadTitle: "sessions",
  attachedRuntime: "sessions",
  sessions: "sessions",
  registerThreadLifecycle: "sessions",
  registerTurnObserver: "sessions",
  pinTranscriptEntries: "sessions",
  registerRuntimeExtension: "runtime:extend",
  decorateUiPrompt: "runtime:extend",
  setPermissionLevel: "runtime:extend",
  registerRuntimeBackend: "runtime:extend",
  presentUi: "runtime:extend",
  noteSubprocess: "process",
  findCommand: "process",
};
