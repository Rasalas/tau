export const EXTENSION_PERMISSIONS = [
  "workspace:read",
  "workspace:write",
  "workspace:switch",
  "sessions",
  "runtime:extend",
  "process",
  "network",
  "packages",
  "machines",
  "native",
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

/** Act on other machines this host holds a key for, as this machine's agents (`services.machines`, ADR 0027), and take files theirs sent here (`services.blobs`). */
export const PERMISSION_MACHINES = "machines" as const;

/**
 * Loading compiled code: a `.node` addon, `process.dlopen`, a SQLite extension,
 * the raw `process.binding` handles and V8 flags. Enforced inside a worker;
 * an `in-process` package loads addons through `loadDependency` without it.
 */
export const PERMISSION_NATIVE = "native" as const;

/** What the approval box says beside a permission whose name undersells it. */
export const PERMISSION_NOTES: Readonly<Partial<Record<ExtensionPermission, string>>> = {
  native: "loads compiled code into Tau's own process: a crash there stops Tau on that machine and every thread, and its memory is outside the worker's caps",
};

/**
 * The one line Settings shows a package that asked to run in the host process.
 * Nothing is enforced there — no interception point would hold — so the
 * phrasing says so rather than naming one permission.
 */
export const NETWORK_ADVISORY_NOTE = "runs inside Tau's own process; permissions are not enforced there";

/** Each permission in the words of what it lets a package do. */
const PERMISSION_TITLES: Readonly<Record<ExtensionPermission, string>> = {
  "workspace:read": "Read the project's files",
  "workspace:write": "Change the project's files",
  "workspace:switch": "Open another project",
  sessions: "Read and write threads",
  "runtime:extend": "Give agents new tools and behaviour",
  process: "Start programs on this machine",
  network: "Reach the network",
  packages: "Install and remove extension packages",
  machines: "Work on your other machines",
  native: "Load compiled code into Tau",
};

export function permissionTitle(permission: string): string {
  return PERMISSION_TITLES[permission as ExtensionPermission] ?? permission;
}

/** Each permission as the end of the question "May <name> …" on an approval card. */
const PERMISSION_QUESTIONS: Readonly<Record<ExtensionPermission, string>> = {
  "workspace:read": "read the files in your projects?",
  "workspace:write": "change the files in your projects?",
  "workspace:switch": "open other projects?",
  sessions: "read and write your threads?",
  "runtime:extend": "give agents new tools and change how they behave?",
  process: "start programs on this machine?",
  network: "reach the internet?",
  packages: "install and remove other Tau packages?",
  machines: "work on your other machines?",
  native: "load compiled code into Tau's own process? A crash there stops Tau.",
};

/** What a card asks about a package: what its manifest requests, and what the user allowed before, if anything. */
export interface CapabilityRequest {
  permissions: readonly string[];
  isolation: ExtensionIsolation;
  /** The package draws in Tau's window, with the host connection that window holds. */
  desktop: boolean;
  /** The package has a half that runs apart from the window. */
  host?: boolean;
  /** `desktop` and `host` are missing for a yes given before they were recorded; nothing is asked about them then. */
  previous?: { permissions: readonly string[]; isolation: ExtensionIsolation; desktop?: boolean; host?: boolean };
}

/**
 * The plain questions an approval card asks, one per capability the package
 * really requests. Once the user allowed the package, only what is new is asked,
 * including a half it did not have then.
 * A package in Tau's own process gets the one honest question, since no
 * permission holds there.
 */
export function capabilityQuestions(name: string, request: CapabilityRequest): string[] {
  const { previous } = request;
  const questions: string[] = [];
  if (request.isolation === "in-process" && previous?.isolation !== "in-process") {
    questions.push(`May ${name} run inside Tau's own process, where nothing limits what it reads, writes, reaches or starts?`);
  } else {
    for (const permission of EXTENSION_PERMISSIONS) {
      if (request.permissions.includes(permission) && !previous?.permissions.includes(permission)) questions.push(`May ${name} ${PERMISSION_QUESTIONS[permission]}`);
    }
    if (request.host && previous?.host === false) questions.push(`May ${name} run code in a process of its own?`);
  }
  if (request.desktop && (!previous || previous.desktop === false)) questions.push(`May ${name} do anything in Tau's window that you can?`);
  return questions;
}

/** What the approval box says about a package that runs in the host process. */
export const IN_PROCESS_WARNING = `It ${NETWORK_ADVISORY_NOTE}, so it can read and write files, reach the network, start programs and load compiled code whatever it asked for.`;

/** What the approval box says about a package that runs in a worker. */
export function workerDescription(permissions: readonly string[]): string {
  return "It runs in a process of its own: it reads its own files, writes only to its own data folder, and cannot reach the network, start programs or load compiled code without the matching permission."
    + (permissions.includes("process") || permissions.includes("native") ? " With the permission to start programs or load compiled code it could get around these limits." : "");
}

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
  // Limits on what a project's commands reach: a fact about the folder, read and provided alike.
  executionPolicy: "workspace:read",
  knownWorkspacePath: "workspace:read",
  admitWorkspace: "workspace:write",
  rememberProjectName: "workspace:write",
  refreshProject: "workspace:write",
  openWorkspace: "workspace:switch",
  pickDirectory: "workspace:switch",
  thread: "sessions",
  complete: "sessions",
  completionModels: "sessions",
  runtimeChoices: "runtime:extend",
  setThreadTitle: "sessions",
  attachedRuntime: "sessions",
  sessions: "sessions",
  conversations: "sessions",
  background: "sessions",
  registerThreadLifecycle: "sessions",
  registerTurnObserver: "sessions",
  pinTranscriptEntries: "sessions",
  turnAttachments: "sessions",
  registerRuntimeExtension: "runtime:extend",
  loadRuntimeExtension: "runtime:extend",
  decorateUiPrompt: "runtime:extend",
  setPermissionLevel: "runtime:extend",
  registerRuntimeBackend: "runtime:extend",
  runtimeTools: "runtime:extend",
  mcp: "runtime:extend",
  modelAuth: "runtime:extend",
  presentUi: "runtime:extend",
  noteSubprocess: "process",
  findCommand: "process",
  // The host's own listeners: a proxy in front of them and the addresses they publish.
  browserResources: "network",
  network: "network",
  listPackages: "packages",
  installPackage: "packages",
  newPackage: "packages",
  reviewPackage: "packages",
  approvePackage: "packages",
  startOwnPackage: "packages",
  stopPackage: "packages",
  globalExtensionsDirectory: "packages",
  removePackage: "packages",
  updatePackages: "packages",
  // Trusting a project lets its .tau packages load, as installing one does.
  projectTrust: "packages",
  packageBuilds: "packages",
  // Another machine's host, with the key its owner gave this machine's agents.
  machines: "machines",
  // Files those machines' agents sent here: the same work, seen from the other side.
  blobs: "machines",
  // The skill catalog is what a runtime offers a thread; the permission that
  // lets a package register a runtime backend is the one that lets it read it.
  skills: "runtime:extend",
};
