import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionUiPrompt,
  HostEvent,
  HostSnapshot,
  NewThreadRequestId,
  ThreadBackendKind,
  ThreadIndexSnapshot,
} from "../shared/contracts.js";
import { HOST_PROTOCOL_VERSION, catalogFromSnapshot, type HostActionResult, type HostUpdate, type ThreadDetail } from "../shared/host-protocol.js";
import type { ClientTurnLedger } from "./client-turn-ledger.js";
import type { AttachedSessionHost } from "./attached-pi-session.js";
import { assertRuntimeAdapter, type RuntimePermissionLevel } from "./runtime-adapters.js";
import { findExecutable } from "./shell-environment.js";
import type { WorkspaceRef } from "../shared/workspace-identity.js";
import type {
  HostAttachedRuntime,
  HostExtensionServices,
  HostPlatform,
  HostPreparedThread,
  HostProjectFacts,
  HostRuntimeBackendProvider,
  HostSessionFile,
  HostStartedThread,
  HostThread,
  HostThreadStartOptions,
  HostThreadLifecycle,
  HostTurnObserver,
  HostUiPresenter,
  RuntimeExtensionContribution,
} from "./host-extensions.js";

/**
 * The two collaborators that used to receive a record of PiHost's private
 * methods get a named contract instead: the host implements these ports once,
 * and everything the seams add on top lives here rather than in core.
 */

/** What the Pi terminal Tau attaches to may ask of the host. */
export interface AttachedSessionPort {
  readonly safeMode: boolean;
  readonly clientTurns: ClientTurnLedger;
  emit(event: HostEvent): void;
  emitUpdate(update: HostUpdate): void;
  log(label: string, detail?: string): void;
  errorMessage(error: unknown): string;
  fail(error: unknown): void;
  beginActivation(): number;
  isCurrentActivation(epoch: number): boolean;
  /** Pi is the sole writer of the file while attached; a local runtime for it is released. */
  releaseLocalThread(sessionFile: string): Promise<void>;
  clearActiveThread(): void;
  setCwd(cwd: string): void;
  /** A runtime event for the thread Pi owns. */
  onSessionEvent(event: unknown, threadId: string): void;
  snapshot(): Promise<HostSnapshot>;
  detailForSnapshot(snapshot: HostSnapshot, requestId?: NewThreadRequestId): ThreadDetail;
  lifecycleUpdates(snapshot: HostSnapshot): HostUpdate[];
  /** Re-reads the visible thread's shell after the socket came back. */
  refreshActiveThreadShell(): Promise<void>;
}

/** What the host extension seam may ask of the host. */
export interface ExtensionServicesPort {
  readonly safeMode: boolean;
  readonly platform: HostPlatform;
  cwd(): string;
  setCwd(cwd: string): void;
  log(label: string, detail?: string): void;
  openWorkspace(path: string): Promise<HostActionResult>;
  knownWorkspacePath(path: string): Promise<string>;
  workspaceRef(path: string): WorkspaceRef;
  projectName(cwd: string): Promise<string>;
  rememberProjectName(cwd: string, name: string): void;
  /** Whether Tau or an attached Pi terminal owns the visible runtime. */
  runtimeOwner(): "tau" | "pi";
  thread(sessionId?: string): HostThread | undefined;
  setThreadTitle(sessionId: string, title: string, source: "generated" | "renamed"): Promise<void>;
  attachedRuntime(sessionId?: string): HostAttachedRuntime | undefined;
  describeProjects(facts: HostProjectFacts): () => void;
  noteSubprocess(): void;
  /** Re-reads the workspace's extension packages and applies the user's grants. */
  refreshExtensionPackages(): Promise<void>;
  /** Opens a runtime for a session file an extension created; it stays off screen. */
  prepareThread(session: HostSessionFile, manager: SessionManager, options: { previousSessionFile?: string }): Promise<HostPreparedThread>;
  /** Creates a thread for a project, indexes it and delivers its first prompt, all off screen. */
  startThread(options: HostThreadStartOptions): Promise<HostStartedThread>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  refreshThreadIndex(): Promise<ThreadIndexSnapshot>;
  registerThreadLifecycle(lifecycle: HostThreadLifecycle): () => void;
  registerTurnObserver(observer: HostTurnObserver): () => void;
  pinTranscriptEntries(provider: (thread: HostThread) => Iterable<string>): () => void;
  decorateUiPrompt(decorator: (prompt: ExtensionUiPrompt) => void): () => void;
}

export function createAttachedSessionHost(port: AttachedSessionPort): AttachedSessionHost {
  return {
    safeMode: port.safeMode,
    clientTurns: port.clientTurns,
    emit: (event) => port.emit(event),
    log: (label, detail) => port.log(label, detail),
    errorMessage: (error) => port.errorMessage(error),
    fail: (error) => port.fail(error),
    beginActivation: () => port.beginActivation(),
    isCurrentActivation: (epoch) => port.isCurrentActivation(epoch),
    releaseLocalThread: (sessionFile) => port.releaseLocalThread(sessionFile),
    clearActiveThread: () => port.clearActiveThread(),
    setCwd: (cwd) => port.setCwd(cwd),
    onSessionEvent: (event, threadId) => port.onSessionEvent(event, threadId),
    onSnapshot: (requestId, stillCurrent) => {
      void port.snapshot().then((snapshot) => {
        if (!stillCurrent()) return;
        port.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: port.detailForSnapshot(snapshot, requestId) });
        port.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) });
      }).catch((error) => port.fail(error));
    },
    onReconnected: async (activationEpoch) => {
      await port.refreshActiveThreadShell();
      if (!port.isCurrentActivation(activationEpoch)) return;
      const snapshot = await port.snapshot();
      if (!port.isCurrentActivation(activationEpoch)) return;
      for (const update of port.lifecycleUpdates(snapshot)) port.emitUpdate(update);
      port.emit({ type: "event-log", label: "bridge.reconnected", detail: "Pi session bridge", timestamp: Date.now() });
    },
  };
}

/**
 * Everything host extensions contribute: the services facade plus the
 * registries behind it. The host reads those registries; only this module
 * writes them.
 */
export interface HostExtensionSeam {
  readonly services: HostExtensionServices;
  /** Runtime backends extensions registered, by kind. Pi is not one of them. */
  readonly backends: ReadonlyMap<ThreadBackendKind, HostRuntimeBackendProvider>;
  /** Pi extensions loaded into every runtime the host creates from now on. */
  readonly runtimeExtensions: readonly RuntimeExtensionContribution[];
  readonly uiPresenters: ReadonlySet<HostUiPresenter>;
  /** Entries an extension anchors rows to; a text-empty assistant stays visible for them. */
  readonly entryPins: ReadonlySet<(thread: HostThread) => Iterable<string>>;
  /** What the user lets external runtimes do. */
  permissionLevel(): RuntimePermissionLevel;
  /** Wraps a session manager for extensions; a runtime prepared for the file shares the manager. */
  sessionFile(manager: SessionManager): HostSessionFile;
}

export function createHostExtensionSeam(port: ExtensionServicesPort): HostExtensionSeam {
  const backends = new Map<ThreadBackendKind, HostRuntimeBackendProvider>();
  const runtimeExtensions: RuntimeExtensionContribution[] = [];
  const uiPresenters = new Set<HostUiPresenter>();
  const entryPins = new Set<(thread: HostThread) => Iterable<string>>();
  const sessionFileManagers = new WeakMap<HostSessionFile, SessionManager>();
  let permissionLevelProvider: (() => RuntimePermissionLevel) | undefined;

  const sessionFile = (manager: SessionManager): HostSessionFile => {
    const path = manager.getSessionFile();
    if (!path) throw new Error("This session has no file yet.");
    const file: HostSessionFile = {
      path,
      sessionId: manager.getSessionId(),
      cwd: manager.getCwd(),
      entries: () => manager.getBranch(),
      leafId: () => manager.getLeafId() ?? undefined,
      appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); },
      appendInfo: (text) => { manager.appendSessionInfo(text); },
      branch: (entryId) => {
        // createBranchedSession turns this manager into the new session.
        let branched: string | undefined;
        try { branched = manager.createBranchedSession(entryId); } catch { return undefined; }
        return branched ? sessionFile(manager) : undefined;
      },
    };
    sessionFileManagers.set(file, manager);
    return file;
  };

  const services: HostExtensionServices = {
    cwd: () => port.cwd(),
    safeMode: port.safeMode,
    log: (label, detail) => port.log(label, detail),
    openWorkspace: (path) => port.openWorkspace(path),
    knownWorkspacePath: (path) => port.knownWorkspacePath(path),
    workspaceRef: (path) => port.workspaceRef(path),
    projectName: (cwd) => port.projectName(cwd),
    rememberProjectName: (cwd, name) => port.rememberProjectName(cwd, name),
    pickDirectory: (options) => port.platform.pickDirectory
      ? port.platform.pickDirectory(options)
      : Promise.reject(new Error("This host has no folder picker.")),
    runtimeOwner: () => port.runtimeOwner(),
    thread: (sessionId) => port.thread(sessionId),
    setThreadTitle: (sessionId, title, source) => port.setThreadTitle(sessionId, title, source),
    attachedRuntime: (sessionId) => port.attachedRuntime(sessionId),
    describeProjects: (facts) => port.describeProjects(facts),
    noteSubprocess: () => port.noteSubprocess(),
    findCommand: (name) => findExecutable(name),
    refreshExtensionPackages: () => port.refreshExtensionPackages(),
    sessions: {
      list: async () => (await SessionManager.listAll()).map((info) => ({ sessionId: info.id, path: info.path, cwd: info.cwd })),
      open: (path) => {
        // Pi falls back to process.cwd() for a missing file; never hand that out.
        if (!existsSync(path)) throw new Error(`No session file at ${path}.`);
        return sessionFile(SessionManager.open(path));
      },
      prepare: (session, options = {}) => port.prepareThread(
        session,
        sessionFileManagers.get(session) ?? SessionManager.open(session.path),
        options,
      ),
      start: (options) => port.startThread(options),
      exclusive: (work) => port.exclusive(work),
      refreshIndex: async () => ({
        version: HOST_PROTOCOL_VERSION,
        type: "thread-index",
        index: await port.refreshThreadIndex(),
      }),
    },
    registerThreadLifecycle: (lifecycle) => port.registerThreadLifecycle(lifecycle),
    registerTurnObserver: (observer) => port.registerTurnObserver(observer),
    pinTranscriptEntries: (provider) => {
      entryPins.add(provider);
      return () => { entryPins.delete(provider); };
    },
    decorateUiPrompt: (decorator) => port.decorateUiPrompt(decorator),
    registerRuntimeExtension: (name, factory, options) => {
      const contribution = { name, factory, ...(options ?? {}) };
      runtimeExtensions.push(contribution);
      return () => {
        const index = runtimeExtensions.indexOf(contribution);
        if (index >= 0) runtimeExtensions.splice(index, 1);
      };
    },
    setPermissionLevel: (provider) => { permissionLevelProvider = provider; },
    registerRuntimeBackend: (provider) => {
      if (provider.kind === "pi" || !provider.kind) throw new Error(`Runtime backend kind "${provider.kind}" is reserved.`);
      if (backends.has(provider.kind)) throw new Error(`Runtime backend "${provider.kind}" is already registered.`);
      assertRuntimeAdapter(provider.adapter);
      if (provider.adapter.id !== provider.kind) throw new Error(`Runtime backend "${provider.kind}" must carry an adapter of the same kind.`);
      backends.set(provider.kind, provider);
      return () => { if (backends.get(provider.kind) === provider) backends.delete(provider.kind); };
    },
    presentUi: (presenter) => {
      uiPresenters.add(presenter);
      return () => { uiPresenters.delete(presenter); };
    },
  };

  return {
    services,
    backends,
    runtimeExtensions,
    uiPresenters,
    entryPins,
    // Without an access extension everything is allowed.
    permissionLevel: () => permissionLevelProvider?.() ?? "full",
    sessionFile,
  };
}
