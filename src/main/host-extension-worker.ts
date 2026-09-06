import type { WorkspaceRef } from "../shared/workspace-identity.js";
import Module, { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import {
  FACT_HOOKS,
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
 * also holds no socket: the guards below run before the bundle is loaded.
 */

const port = parentPort;
if (!port) throw new Error("host-extension-worker must run inside a worker thread");
const boot = workerData as WorkerBootstrap;

const send = (message: WorkerToHostMessage): void => { port.postMessage(message); };

const granted = new Set(boot.permissions);

/**
 * Node builtins that open a socket. `network` is the only permission the main
 * side cannot enforce for itself — nothing crosses the port when a package
 * dials out — so the worker closes these doors before the bundle is loaded.
 * `child_process` is deliberately absent: it stays governed by `process`.
 */
const NETWORK_MODULES = new Set(["http", "https", "net", "tls", "dgram", "http2", "dns"]);

/** Globals that reach the network without a `require`; only what this Node has. */
const NETWORK_GLOBALS = ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"] as const;

/** Reads like a denied service member, so the Inspector and Signals show both the same way. */
function denyNetwork(what: string): never {
  const message = `Extension ${boot.id} lacks permission network`;
  send({ t: "log", label: "host-extension.denied", detail: `${message} (${what})` });
  throw new Error(message);
}

/** `node:dns/promises` and `dns` are the same door. */
function moduleName(request: string): string {
  return (request.startsWith("node:") ? request.slice(5) : request).split("/")[0] ?? request;
}

// Electron's API only exists in the main process, and reaching it from here
// would be the hole the isolation is meant to close. `Module._load` is the one
// interception point Electron's Node (22.14) has; `module.registerHooks` needs 22.15.
/* eslint-disable no-underscore-dangle */
const loader = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const load = loader._load.bind(loader);
loader._load = (request: string, parent: unknown, isMain: boolean): unknown => {
  if (request === "electron" || request.startsWith("electron/")) {
    throw new Error(`Extension ${boot.id} runs isolated in a worker, where Electron is not available. Declare "isolation": "in-process" in its manifest if it must run in the host process.`);
  }
  if (!granted.has("network") && NETWORK_MODULES.has(moduleName(request))) denyNetwork(`require("${request}")`);
  return load(request, parent, isMain);
};
/* eslint-enable no-underscore-dangle */

// Before the bundle runs, so its top-level code cannot capture the real ones.
if (!granted.has("network")) {
  for (const name of NETWORK_GLOBALS) {
    if (!(name in globalThis)) continue;
    Object.defineProperty(globalThis, name, {
      value: function denied(): never { return denyNetwork(name); },
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
  refreshExtensionPackages: async () => { await rpc("refreshExtensionPackages"); },
  describeProjects: (facts) => registerHooks("describeProjects", facts as Record<string, unknown>, FACT_HOOKS),
  sessions: {
    list: () => rpc("sessions.list") as ReturnType<WorkerHostServices["sessions"]["list"]>,
    read: (path) => rpc("sessions.read", path) as ReturnType<WorkerHostServices["sessions"]["read"]>,
    start: (options) => rpc("sessions.start", options) as ReturnType<WorkerHostServices["sessions"]["start"]>,
    exclusive: <T>(work: () => Promise<T> | T): Promise<T> => {
      const id = nextId++;
      exclusiveWork.set(id, async () => work());
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject });
        send({ t: "rpc", id, path: "sessions.exclusive", args: [] });
      });
    },
  },
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
  services: new Proxy(services, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && UNAVAILABLE.has(prop)) return () => unavailable(`services.${prop}`);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }),
  registerCommand: (name, handler, options) => {
    if (commands.has(name)) throw new Error(`Host extension ${boot.id}: command "${name}" registered twice`);
    commands.set(name, handler);
    send({ t: "command", name, long: Boolean(options?.long) });
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
