// esbuild reads ESBUILD_BINARY_PATH while it loads, so this import comes first.
import { unpackedPath } from "./packaged-app.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import type { UiToolRun } from "../shared/contracts.js";
import type {
  DirectoryPickerOptions,
  HostClientObserver,
  HostExtension,
  HostExtensionContext,
  HostExtensionServices,
  HostProjectFacts,
  HostThread,
  HostThreadLifecycle,
  HostThreadStartOptions,
  HostTurnObserver,
} from "./host-extensions.js";
import {
  serializeError,
  reviveError,
  toPlain,
  type HostToWorkerMessage,
  type WorkerBootstrap,
  type WorkerSessionSnapshot,
  type WorkerThreadSnapshot,
  type WorkerToHostMessage,
} from "./host-extension-worker-protocol.js";

/**
 * Main-side supervisor of an isolated host extension. It runs the package's
 * compiled bundle in a worker thread, answers the facade calls that come back
 * over the port, and looks to the registry like any other `HostExtension`:
 * `PiHost` and the seam never learn that a worker is behind it.
 *
 * Permission enforcement stays here — the services this dispatches into are
 * the ones `guardedServices` wrapped, so a worker cannot reach past its grant.
 * `network` is the exception: nothing crosses the port when a package dials
 * out, so the grant travels in the bootstrap and the worker enforces it.
 */

export interface WorkerHostExtensionOptions {
  id: string;
  name: string;
  permissions?: readonly string[];
  /** Compiled CommonJS bundle of the package's host entry. */
  file: string;
  /** Overrides the worker entry; the default is resolved beside this module. */
  workerEntry?: string;
  /** Heap and stack caps of the worker; a package that exceeds them is deactivated. */
  resourceLimits?: { maxOldGenerationSizeMb?: number; maxYoungGenerationSizeMb?: number; stackSizeMb?: number };
  startupTimeoutMs?: number;
  /** How long the host waits for a hook it calls into the worker. */
  hookTimeoutMs?: number;
}

type OutgoingCall =
  | { t: "call"; command: string; input: unknown }
  | { t: "hook"; handle: number; hook: string; args: readonly unknown[] };

const DEFAULT_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } as const;

let entryPromise: Promise<string> | undefined;

/** Where the worker's TypeScript lives, from wherever this module runs. */
function workerSourcePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const beside = join(here, "host-extension-worker.ts");
  if (existsSync(beside)) return beside;
  const fromSource = join(here.replace(`${sep}dist-electron${sep}main`, `${sep}src${sep}main`), "host-extension-worker.ts");
  if (existsSync(fromSource)) return fromSource;
  throw new Error("The isolated extension worker is missing; run npm run build.");
}

/**
 * The worker entry: the CommonJS bundle the build writes beside this module,
 * or one built here when Tau runs from source (tests, `npm run dev`).
 */
export function workerEntryPath(): Promise<string> {
  entryPromise ??= (async () => {
    // A worker thread opens its entry itself, so this has to be a real file.
    const compiled = unpackedPath(join(dirname(fileURLToPath(import.meta.url)), "host-extension-worker.cjs"));
    if (existsSync(compiled)) return compiled;
    const result = await build({
      entryPoints: [workerSourcePath()],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      target: "node20",
      logLevel: "silent",
      external: ["electron", "node:*"],
    });
    const code = result.outputFiles.map((file) => file.text).join("\n");
    const directory = join(tmpdir(), "tau-host-extension-worker");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `${createHash("sha256").update(code).digest("hex").slice(0, 16)}.cjs`);
    if (!existsSync(file)) await writeFile(file, code, { encoding: "utf8", mode: 0o600 });
    return file;
  })();
  return entryPromise;
}

function threadSnapshot(thread: HostThread | undefined): WorkerThreadSnapshot | undefined {
  if (!thread) return undefined;
  return {
    sessionId: thread.sessionId,
    cwd: thread.cwd,
    backendKind: thread.backendKind,
    ...(thread.sessionFile ? { sessionFile: thread.sessionFile } : {}),
    ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
    ...(thread.sessionName() ? { title: thread.sessionName() as string } : {}),
    streaming: thread.isStreaming(),
    idle: thread.isIdle(),
    current: thread.isCurrent(),
    ...(thread.usage ? { usage: thread.usage } : {}),
  };
}

/** A host extension that runs its package in a worker thread. */
export function createWorkerHostExtension(options: WorkerHostExtensionOptions): HostExtension {
  return {
    id: options.id,
    name: options.name,
    permissions: options.permissions ?? [],
    isolation: "worker",
    activate: (context) => activateWorker(options, context),
  };
}

async function activateWorker(options: WorkerHostExtensionOptions, context: HostExtensionContext): Promise<() => Promise<void>> {
  const services: HostExtensionServices = context.services;
  const hookTimeoutMs = options.hookTimeoutMs ?? 30_000;
  const bootstrap: WorkerBootstrap = {
    file: options.file,
    id: options.id,
    name: options.name,
    agentDir: services.agentDir,
    sessionsDir: services.sessionsDir,
    stateDir: services.stateDir,
    themesDir: services.themesDir,
    safeMode: services.safeMode,
    invocationContextId: context.invocationContextId,
    // An isolated extension is always a package, so an absent list is an empty one.
    permissions: options.permissions ?? [],
  };
  const worker = new Worker(options.workerEntry ?? await workerEntryPath(), {
    workerData: bootstrap,
    resourceLimits: { ...DEFAULT_RESOURCE_LIMITS, ...options.resourceLimits },
  });

  let stopped = false;
  let started = false;
  /** Calls the host made into the worker (commands and hooks), by id. */
  const calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  /** Critical sections the host holds open while the worker does its work. */
  const exits = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  /** Registrations the host holds for the worker: lifecycle, observers, facts, pins. */
  const registrations = new Map<number, () => void>();
  const pendingWork = new Map<string, number>();
  const pins = new Map<number, Record<string, string[]>>();
  const commandDisposers: Array<() => void> = [];
  let pendingObserverDispose: (() => void) | undefined;
  let pinsDispose: (() => void) | undefined;
  let nextCall = 1;
  let nextHandle = 1;
  let ready: { resolve(): void; reject(error: Error): void } | undefined;

  const post = (message: HostToWorkerMessage): void => { if (!stopped) worker.postMessage(message); };

  /** The package is gone: reject what is in flight and let the registry deactivate it. */
  const fail = (reason: string): void => {
    if (stopped) return;
    stopped = true;
    const error = new Error(reason);
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(error); }
    calls.clear();
    for (const exit of exits.values()) { clearTimeout(exit.timer); exit.reject(error); }
    exits.clear();
    void worker.terminate();
    const settle = ready;
    ready = undefined;
    if (settle) settle.reject(error);
    else context.fail(reason);
  };

  const callWorker = (message: OutgoingCall): Promise<unknown> => {
    if (stopped) return Promise.reject(new Error(`Host extension ${options.name} is not running.`));
    const id = nextCall++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        calls.delete(id);
        const reason = `Host extension ${options.name} did not answer within ${hookTimeoutMs}ms`;
        fail(reason);
        reject(new Error(reason));
      }, hookTimeoutMs);
      calls.set(id, { resolve, reject, timer });
      post({ ...message, id } as HostToWorkerMessage);
    });
  };

  /** A hook of a dead or wedged worker must not wedge the host's lifecycle. */
  const hookCall = async (handle: number, hook: string, args: readonly unknown[]): Promise<unknown> => {
    if (!registrations.has(handle) || stopped) return undefined;
    try {
      return await callWorker({ t: "hook", handle, hook, args: toPlain(args) });
    } catch (error) {
      if (stopped) {
        services.log("host-extension.worker.hook-dropped", `${options.name} ${hook}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
      throw error;
    }
  };

  const readSession = (path: string): WorkerSessionSnapshot => {
    const file = services.sessions.open(path);
    return {
      path: file.path,
      sessionId: file.sessionId,
      cwd: file.cwd,
      entries: toPlain(file.entries()),
      ...(file.leafId() ? { leafId: file.leafId() as string } : {}),
    };
  };

  const lifecycleFor = (handle: number, hooks: readonly string[]): HostThreadLifecycle => {
    const has = new Set(hooks);
    const lifecycle: HostThreadLifecycle = {};
    if (has.has("beforeWorkspace")) lifecycle.beforeWorkspace = async (cwd) => { await hookCall(handle, "beforeWorkspace", [cwd]); };
    if (has.has("afterWorkspaceClose")) lifecycle.afterWorkspaceClose = async (cwd, reason) => { await hookCall(handle, "afterWorkspaceClose", [cwd, reason]); };
    if (has.has("threadDeleted")) lifecycle.threadDeleted = async (sessionId, cwd) => { await hookCall(handle, "threadDeleted", [sessionId, cwd]); };
    if (has.has("beforeOpen")) lifecycle.beforeOpen = async (session) => { await hookCall(handle, "beforeOpen", [readSession(session.path)]); };
    if (has.has("afterFork")) lifecycle.afterFork = async (source, target) => { await hookCall(handle, "afterFork", [threadSnapshot(source), readSession(target.path)]); };
    // A worker hook returns nothing, so it cannot take part in the activation transaction.
    if (has.has("beforeActivate")) lifecycle.beforeActivate = async (thread) => { await hookCall(handle, "beforeActivate", [threadSnapshot(thread)]); return undefined; };
    if (has.has("sweep")) {
      lifecycle.sweep = async (sweep) => {
        await hookCall(handle, "sweep", [{
          sessions: sweep.sessions,
          liveThreads: sweep.liveThreads.map((thread) => threadSnapshot(thread)),
          projectPaths: sweep.projectPaths,
          deleted: sweep.deleted,
        }]);
      };
    }
    return lifecycle;
  };

  const observerFor = (handle: number, hooks: readonly string[]): HostTurnObserver => {
    const has = new Set(hooks);
    const observer: HostTurnObserver = {};
    // The host does not wait for these two; they are void in the seam.
    if (has.has("accepted")) observer.accepted = (sessionId, turnId, opts) => { void hookCall(handle, "accepted", [sessionId, turnId, opts]); };
    if (has.has("toolEnded")) observer.toolEnded = (sessionId: string, tool: UiToolRun, cwd: string) => { void hookCall(handle, "toolEnded", [sessionId, tool, cwd]); };
    if (has.has("prepare")) observer.prepare = async (sessionId, turnId) => { await hookCall(handle, "prepare", [sessionId, turnId]); };
    if (has.has("cancelled")) observer.cancelled = async (sessionId, turnId) => { await hookCall(handle, "cancelled", [sessionId, turnId]); };
    if (has.has("ended")) observer.ended = async (sessionId, turnId, outcome) => { await hookCall(handle, "ended", [sessionId, turnId, outcome]); };
    if (has.has("reset")) observer.reset = async (sessionId) => { await hookCall(handle, "reset", [sessionId]); };
    if (has.has("closed")) observer.closed = async (sessionId) => { await hookCall(handle, "closed", [sessionId]); };
    return observer;
  };

  const clientObserverFor = (handle: number, hooks: readonly string[]): HostClientObserver => {
    const has = new Set(hooks);
    const observer: HostClientObserver = {};
    // The host does not wait for a client observer; a worker answers in its own time.
    if (has.has("attached")) observer.attached = (clientId, client) => { void hookCall(handle, "attached", [clientId, client]); };
    if (has.has("detached")) observer.detached = (clientId) => { void hookCall(handle, "detached", [clientId]); };
    return observer;
  };

  const factsFor = (handle: number, hooks: readonly string[]): HostProjectFacts => {
    const has = new Set(hooks);
    const facts: HostProjectFacts = {};
    if (has.has("name")) facts.name = async (cwd) => await hookCall(handle, "name", [cwd]) as string | undefined;
    if (has.has("label")) facts.label = async (cwd) => await hookCall(handle, "label", [cwd]) as string | undefined;
    if (has.has("nested")) facts.nested = async (cwd) => Boolean(await hookCall(handle, "nested", [cwd]));
    return facts;
  };

  const dispatch = async (path: string, args: readonly unknown[]): Promise<unknown> => {
    switch (path) {
      case "cwd": return services.cwd();
      case "openWorkspace": return services.openWorkspace(String(args[0]));
      case "knownWorkspacePath": return services.knownWorkspacePath(String(args[0]));
      case "workspaceRef": return services.workspaceRef(String(args[0]));
      case "admitWorkspace": return services.admitWorkspace(String(args[0]));
      case "projectName": return services.projectName(String(args[0]));
      case "rememberProjectName": return services.rememberProjectName(String(args[0]), String(args[1]));
      case "pickDirectory": return services.pickDirectory(args[0] as DirectoryPickerOptions | undefined);
      case "runtimeOwner": return services.runtimeOwner();
      case "thread": return threadSnapshot(services.thread(args[0] as string | undefined));
      case "transcript": return toPlain(await (services.thread(args[0] as string | undefined)?.transcript() ?? []));
      case "setThreadTitle": return services.setThreadTitle(String(args[0]), String(args[1]), args[2] as "generated" | "renamed");
      case "noteSubprocess": return services.noteSubprocess();
      case "findCommand": return services.findCommand(String(args[0]));
      case "skills": return services.skills(String(args[0]));
      case "refreshExtensionPackages": return services.refreshExtensionPackages();
      case "sessions.list": return services.sessions.list();
      case "sessions.read": return readSession(String(args[0]));
      case "sessions.start": return services.sessions.start(args[0] as HostThreadStartOptions);
      case "sessions.remove": return services.sessions.remove(String(args[0]));
      case "sessions.restore": return services.sessions.restore(String(args[0]));
      case "sessions.trash": return services.sessions.trash();
      case "sessions.purge": return services.sessions.purge(String(args[0]));
      case "clients.count": return services.clients.count();
      case "clients.observe": {
        const handle = nextHandle++;
        const dispose = services.clients.observe(clientObserverFor(handle, args[0] as string[]));
        registrations.set(handle, dispose);
        return handle;
      }
      case "describeProjects": {
        const handle = nextHandle++;
        const dispose = services.describeProjects(factsFor(handle, args[0] as string[]));
        registrations.set(handle, dispose);
        return handle;
      }
      case "observeConfigChanges": {
        const handle = nextHandle++;
        const dispose = services.observeConfigChanges((change) => { void hookCall(handle, "changed", [change]); });
        registrations.set(handle, dispose);
        return handle;
      }
      case "registerThreadLifecycle": {
        const handle = nextHandle++;
        const dispose = services.registerThreadLifecycle(lifecycleFor(handle, args[0] as string[]));
        registrations.set(handle, dispose);
        return handle;
      }
      case "registerTurnObserver": {
        const handle = nextHandle++;
        const dispose = services.registerTurnObserver(observerFor(handle, args[0] as string[]));
        registrations.set(handle, dispose);
        return handle;
      }
      case "setPendingWork": {
        const sessionId = String(args[0]);
        const count = Number(args[1]);
        if (count > 0) pendingWork.set(sessionId, count);
        else pendingWork.delete(sessionId);
        pendingObserverDispose ??= services.registerTurnObserver({ pending: (id) => pendingWork.get(id) ?? 0 });
        return undefined;
      }
      case "pinTranscriptEntries": {
        const handle = nextHandle++;
        pins.set(handle, args[0] as Record<string, string[]>);
        pinsDispose ??= services.pinTranscriptEntries((thread) => {
          const entries: string[] = [];
          for (const map of pins.values()) entries.push(...(map[thread.sessionId] ?? []));
          return entries;
        });
        registrations.set(handle, () => { pins.delete(handle); });
        return handle;
      }
      default:
        throw new Error(`Host extension ${options.name} asked for an unknown host service "${path}".`);
    }
  };

  const respond = (id: number, run: () => Promise<unknown> | unknown): void => {
    void (async () => {
      try {
        post({ t: "res", id, ok: true, value: await run() });
      } catch (error) {
        post({ t: "res", id, ok: false, error: serializeError(error) });
      }
    })();
  };

  worker.on("message", (message: WorkerToHostMessage) => {
    switch (message.t) {
      case "ready":
        started = true;
        ready?.resolve();
        ready = undefined;
        return;
      case "fatal": {
        fail(`${options.name}: ${reviveError(message.error).message}`);
        return;
      }
      case "command": {
        try {
          const callers = Array.isArray(message.callers) ? message.callers : [];
          commandDisposers.push(context.registerCommand(
            message.name,
            (input) => callWorker({ t: "call", command: message.name, input }),
            {
              ...(message.long ? { long: true } : {}),
              ...(callers.length > 0 ? { callers } : {}),
            },
          ));
        } catch (error) {
          fail(`${options.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      case "command-off":
        return;
      case "emit":
        context.emit(message.name, message.payload);
        return;
      case "log":
        services.log(message.label, message.detail);
        return;
      case "release": {
        registrations.get(message.handle)?.();
        registrations.delete(message.handle);
        return;
      }
      case "rpc": {
        if (message.path === "hostExtension") {
          respond(message.id, () => context.invokeHostExtension(
            String(message.args[0]),
            String(message.args[1]),
            message.args[2],
          ));
          return;
        }
        if (message.path === "sessions.exclusive") {
          respond(message.id, () => services.sessions.exclusive(() => new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              exits.delete(message.id);
              const reason = `Host extension ${options.name} held the session lock for more than ${hookTimeoutMs}ms`;
              fail(reason);
              reject(new Error(reason));
            }, hookTimeoutMs);
            exits.set(message.id, { resolve, reject, timer });
            post({ t: "enter", id: message.id });
          })));
          return;
        }
        respond(message.id, () => dispatch(message.path, message.args));
        return;
      }
      case "exit": {
        const waiting = exits.get(message.id);
        if (!waiting) return;
        exits.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.ok) waiting.resolve(message.value);
        else waiting.reject(reviveError(message.error));
        return;
      }
      case "res": {
        const call = calls.get(message.id);
        if (!call) return;
        calls.delete(message.id);
        clearTimeout(call.timer);
        if (message.ok) call.resolve(message.value);
        else call.reject(reviveError(message.error));
        return;
      }
    }
  });

  worker.on("error", (error: Error) => { fail(`${options.name}: ${error.message}`); });
  worker.on("exit", (code) => {
    if (stopped) return;
    fail(started
      ? `${options.name} left the host process (worker exit code ${code})`
      : `${options.name} exited before it started (worker exit code ${code})`);
  });

  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ready = undefined;
      stopped = true;
      void worker.terminate();
      reject(new Error(`${options.name} did not start within ${startupTimeoutMs}ms`));
    }, startupTimeoutMs);
    ready = {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    };
  });

  return async () => {
    stopped = true;
    for (const release of commandDisposers) release();
    commandDisposers.length = 0;
    for (const release of registrations.values()) release();
    registrations.clear();
    pendingObserverDispose?.();
    pinsDispose?.();
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(new Error(`Host extension ${options.name} stopped.`)); }
    calls.clear();
    for (const exit of exits.values()) { clearTimeout(exit.timer); exit.reject(new Error(`Host extension ${options.name} stopped.`)); }
    exits.clear();
    await worker.terminate();
  };
}
