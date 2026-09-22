import type { WorkspaceRef } from "../shared/workspace-identity.js";
import Module, { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import {
  CLIENT_HOOKS,
  FACT_HOOKS,
  CONFIG_HOOKS,
  LIFECYCLE_HOOKS,
  TURN_HOOKS,
  serializeError,
  reviveError,
  type HostToWorkerMessage,
  type SerializedError,
  type WorkerBootstrap,
  type WorkerCommandHandler,
  type WorkerHostExtension,
  type WorkerHostExtensionContext,
  type WorkerHostServices,
  type WorkerToHostMessage,
} from "./host-extension-worker-protocol.js";

/**
 * The entry an isolated host extension runs in. It loads the package's
 * compiled bundle, hands it a facade that answers by message, and holds no
 * Electron and no live host object of its own. Without the `network` grant it
 * also holds no socket, and without `process` no way to start one: the guards
 * below run before the bundle is loaded.
 */

const port = parentPort;
if (!port) throw new Error("host-extension-worker must run inside a worker thread");
const boot = workerData as WorkerBootstrap;

const send = (message: WorkerToHostMessage): void => { port.postMessage(message); };

const granted = new Set(boot.permissions);

/**
 * Node builtins that open a socket, refused without `network`. The global
 * shims below close the browser-style doors to the same place.
 */
const NETWORK_MODULES = new Set(["http", "https", "net", "tls", "dgram", "http2", "dns"]);

/** Node builtins that start a process, refused without `process`. */
const PROCESS_MODULES = new Set(["child_process"]);

/** Globals that reach the network without a `require`; only what this Node has. */
const NETWORK_GLOBALS = ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"] as const;

/** Reads like a denied service member, so the Inspector and Signals show both the same way. */
function deny(message: string, what: string): never {
  send({ t: "log", label: "host-extension.denied", detail: `${message} (${what})` });
  throw new Error(message);
}

function denyPermission(permission: string, what: string): never {
  return deny(`Extension ${boot.id} lacks permission ${permission}`, what);
}

/** `node:dns/promises` and `dns` are the same door. */
function moduleName(request: string): string {
  return (request.startsWith("node:") ? request.slice(5) : request).split("/")[0] ?? request;
}

/**
 * A module the grant does not cover, or nothing. A nested `worker_threads`
 * worker runs outside every guard installed here, so it is refused for as long
 * as one of them still has something to hold.
 */
function refuse(request: string, what: string): void {
  if (request === "electron" || request.startsWith("electron/")) {
    throw new Error(`Extension ${boot.id} runs isolated in a worker, where Electron is not available. Declare "isolation": "in-process" in its manifest if it must run in the host process.`);
  }
  const name = moduleName(request);
  if (!granted.has("network") && NETWORK_MODULES.has(name)) denyPermission("network", what);
  if (!granted.has("process") && PROCESS_MODULES.has(name)) denyPermission("process", what);
  if (name === "worker_threads" && !(granted.has("network") && granted.has("process"))) {
    deny(
      `Extension ${boot.id} may not start a worker thread: a nested worker runs outside the guards its grant is enforced by. Declare "isolation": "in-process" in its manifest if it needs one.`,
      what,
    );
  }
}

// Two interceptions, because neither covers the other. `Module._load` is what
// `require` goes through; `module.registerHooks` (Node 22.15+, and Electron's
// Node is past it) is what `import()` goes through, and it sees `require` too.
// A package can still undo both — it holds `node:module` like any Node code —
// so this is a guardrail, not a sandbox: see ADR 0009 and ADR 0018.
/* eslint-disable no-underscore-dangle */
const loader = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const load = loader._load.bind(loader);
loader._load = (request: string, parent: unknown, isMain: boolean): unknown => {
  refuse(request, `require("${request}")`);
  return load(request, parent, isMain);
};
/* eslint-enable no-underscore-dangle */

type ResolveHook = (specifier: string, context: unknown, next: (specifier: string, context: unknown) => unknown) => unknown;
const registerModuleHooks = (Module as unknown as { registerHooks?: (hooks: { resolve: ResolveHook }) => void }).registerHooks;
registerModuleHooks?.({
  resolve: (specifier, context, next) => {
    refuse(specifier, `import ${specifier}`);
    return next(specifier, context);
  },
});

// Before the bundle runs, so its top-level code cannot capture the real ones.
if (!granted.has("network")) {
  for (const name of NETWORK_GLOBALS) {
    if (!(name in globalThis)) continue;
    Object.defineProperty(globalThis, name, {
      value: function denied(): never { return denyPermission("network", name); },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

/** Facade members that would hand out a live object; a worker cannot have them (ADR 0009). */
const UNAVAILABLE = new Set([
  "attachedRuntime",
  "registerRuntimeBackend",
  "registerRuntimeExtension",
  "loadRuntimeExtension",
  "loadDependency",
  // A window half belongs to an in-process kit: an isolated one has no id the
  // window registry would trust and no way to hold the view it creates.
  "callClient",
  "decorateUiPrompt",
  "setPermissionLevel",
  "presentUi",
  // The package manager stays in the host process: installing hands a live
  // progress callback to a command that may run for minutes.
  "listPackages",
  "installPackage",
  "removePackage",
  "updatePackages",
]);

let nextId = 1;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
/** Registrations the host holds for us, by handle: hooks it may call back into. */
const handles = new Map<number, Record<string, (...args: unknown[]) => unknown>>();
/** Work waiting for the host to open its critical section, by rpc id. */
const exclusiveWork = new Map<number, () => Promise<unknown>>();
const commands = new Map<string, WorkerCommandHandler>();

function rpc(path: string, ...args: unknown[]): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ t: "rpc", id, path, args });
  });
}

function unavailable(member: string): never {
  throw new Error(`${member} is not available to an isolated host extension. Declare "isolation": "in-process" in the manifest if the package needs it.`);
}

/** Registers `hooks` with the host and answers its calls until the disposer runs. */
async function registerHooks(path: string, hooks: Record<string, unknown>, names: readonly string[]): Promise<() => void> {
  const implemented: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of names) {
    const hook = hooks[name];
    if (typeof hook === "function") implemented[name] = hook as (...args: unknown[]) => unknown;
  }
  const handle = await rpc(path, Object.keys(implemented)) as number;
  handles.set(handle, implemented);
  return () => {
    if (!handles.delete(handle)) return;
    send({ t: "release", handle });
  };
}

const services: WorkerHostServices = {
  agentDir: boot.agentDir,
  sessionsDir: boot.sessionsDir,
  stateDir: boot.stateDir,
  themesDir: boot.themesDir,
  safeMode: boot.safeMode,
  cwd: () => rpc("cwd") as Promise<string>,
  log: (label, detail) => { send({ t: "log", label, ...(detail === undefined ? {} : { detail }) }); },
  openWorkspace: (path) => rpc("openWorkspace", path) as ReturnType<WorkerHostServices["openWorkspace"]>,
  knownWorkspacePath: (path) => rpc("knownWorkspacePath", path) as Promise<string>,
  workspaceRef: (path) => rpc("workspaceRef", path) as Promise<WorkspaceRef>,
  projectName: (cwd) => rpc("projectName", cwd) as Promise<string>,
  rememberProjectName: async (cwd, name) => { await rpc("rememberProjectName", cwd, name); },
  pickDirectory: (options) => rpc("pickDirectory", options) as Promise<string | undefined>,
  runtimeOwner: () => rpc("runtimeOwner") as Promise<"tau" | "pi">,
  thread: (sessionId) => rpc("thread", sessionId) as ReturnType<WorkerHostServices["thread"]>,
  transcript: (sessionId) => rpc("transcript", sessionId) as ReturnType<WorkerHostServices["transcript"]>,
  setThreadTitle: async (sessionId, title, source) => { await rpc("setThreadTitle", sessionId, title, source); },
  noteSubprocess: async () => { await rpc("noteSubprocess"); },
  findCommand: (name) => rpc("findCommand", name) as Promise<string | undefined>,
  skills: (cwd) => rpc("skills", cwd) as ReturnType<WorkerHostServices["skills"]>,
  refreshExtensionPackages: async () => { await rpc("refreshExtensionPackages"); },
  describeProjects: (facts) => registerHooks("describeProjects", facts as Record<string, unknown>, FACT_HOOKS),
  sessions: {
    list: () => rpc("sessions.list") as ReturnType<WorkerHostServices["sessions"]["list"]>,
    read: (path) => rpc("sessions.read", path) as ReturnType<WorkerHostServices["sessions"]["read"]>,
    start: (options) => rpc("sessions.start", options) as ReturnType<WorkerHostServices["sessions"]["start"]>,
    remove: async (sessionId) => { await rpc("sessions.remove", sessionId); },
    exclusive: <T>(work: () => Promise<T> | T): Promise<T> => {
      const id = nextId++;
      exclusiveWork.set(id, async () => work());
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject });
        send({ t: "rpc", id, path: "sessions.exclusive", args: [] });
      });
    },
  },
  clients: {
    observe: (observer) => registerHooks("clients.observe", observer as Record<string, unknown>, CLIENT_HOOKS),
    count: () => rpc("clients.count") as Promise<number>,
  },
  observeConfigChanges: (listener) => registerHooks("observeConfigChanges", { changed: listener }, CONFIG_HOOKS),
  registerThreadLifecycle: (lifecycle) => registerHooks("registerThreadLifecycle", lifecycle as Record<string, unknown>, LIFECYCLE_HOOKS),
  registerTurnObserver: (observer) => registerHooks("registerTurnObserver", observer as Record<string, unknown>, TURN_HOOKS),
  setPendingWork: async (sessionId, count) => { await rpc("setPendingWork", sessionId, count); },
  pinTranscriptEntries: async (pins) => {
    const handle = await rpc("pinTranscriptEntries", pins) as number;
    handles.set(handle, {});
    return () => {
      if (!handles.delete(handle)) return;
      send({ t: "release", handle });
    };
  },
};

const context: WorkerHostExtensionContext = {
  id: boot.id,
  invocationContextId: boot.invocationContextId,
  services: new Proxy(services, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && UNAVAILABLE.has(prop)) return () => unavailable(`services.${prop}`);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }),
  invokeHostExtension: (extensionId, command, input) => rpc("hostExtension", extensionId, command, input),
  registerCommand: (name, handler, options) => {
    if (commands.has(name)) throw new Error(`Host extension ${boot.id}: command "${name}" registered twice`);
    commands.set(name, handler);
    send({ t: "command", name, long: Boolean(options?.long), callers: options?.callers ?? [] });
    return () => {
      if (commands.get(name) !== handler) return;
      commands.delete(name);
      send({ t: "command-off", name });
    };
  },
  emit: (name, payload) => { send({ t: "emit", name, payload }); },
};

function answer(id: number, run: () => unknown): void {
  void (async () => {
    try {
      send({ t: "res", id, ok: true, value: await run() });
    } catch (error) {
      send({ t: "res", id, ok: false, error: serializeError(error) });
    }
  })();
}

function settle(id: number, ok: boolean, value: unknown, error?: SerializedError): void {
  const waiting = pending.get(id);
  if (!waiting) return;
  pending.delete(id);
  if (ok) waiting.resolve(value);
  else waiting.reject(reviveError(error ?? { message: "the host gave no reason" }));
}

port.on("message", (message: HostToWorkerMessage) => {
  switch (message.t) {
    case "call": {
      const handler = commands.get(message.command);
      answer(message.id, () => {
        if (!handler) throw new Error(`Host extension ${boot.id} has no command "${message.command}".`);
        return handler(message.input);
      });
      return;
    }
    case "hook": {
      const hook = handles.get(message.handle)?.[message.hook];
      answer(message.id, () => hook?.(...message.args));
      return;
    }
    case "enter": {
      const work = exclusiveWork.get(message.id);
      exclusiveWork.delete(message.id);
      void (async () => {
        try {
          send({ t: "exit", id: message.id, ok: true, value: work ? await work() : undefined });
        } catch (error) {
          send({ t: "exit", id: message.id, ok: false, error: serializeError(error) });
        }
      })();
      return;
    }
    case "res": {
      if (message.ok) settle(message.id, true, message.value);
      else settle(message.id, false, undefined, message.error);
      return;
    }
  }
});

function resolveExtension(module: { default?: unknown; activate?: unknown }): WorkerHostExtension {
  let candidate: unknown = module.default ?? (typeof module.activate === "function" ? module : undefined);
  if (typeof candidate === "function") candidate = (candidate as () => unknown)();
  const extension = candidate as Partial<WorkerHostExtension> | null;
  if (!extension || typeof extension.activate !== "function") {
    throw new Error("the module must default-export a host extension ({ id?, name?, activate })");
  }
  return extension as WorkerHostExtension;
}

void (async () => {
  try {
    const requireModule = createRequire(boot.file);
    const extension = resolveExtension(requireModule(boot.file) as { default?: unknown; activate?: unknown });
    await extension.activate(context);
    send({ t: "ready" });
  } catch (error) {
    send({ t: "fatal", error: serializeError(error) });
  }
})();
