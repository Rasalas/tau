import { existsSync } from "node:fs";
import type { PricedUsage, UsageTally } from "./usage-pricing.js";
import { join } from "node:path";
import { getAgentDir, loadSkills, ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionUiPrompt,
  HostEvent,
  TauConfig,
  HostSnapshot,
  NewThreadRequestId,
  ThreadBackendKind,
  ThreadIndexSnapshot,
  UiModel,
  UiRuntimeToolsState,
  UiPromptAttachment,
} from "../shared/contracts.js";
import { HOST_PROTOCOL_VERSION, catalogFromSnapshot, type HostActionResult, type HostUpdate, type ThreadDetail } from "../shared/host-protocol.js";
import type { CompletionRequest } from "./runtime-types.js";
import type { HostModelAuthServices } from "./model-auth.js";
import type { ClientTurnLedger } from "./client-turn-ledger.js";
import type { AttachedSessionHost } from "./attached-pi-session.js";
import { assertRuntimeAdapter, type RuntimePermissionLevel } from "./runtime-adapters.js";
import { findExecutable } from "./shell-environment.js";
import { importDependency, loadDependencyModule } from "./dependency-loader.js";
import { runtimeDriver } from "../shared/runtime-instances.js";
import {
  installExtensionSource,
  listExtensionSources,
  removeExtensionSource,
  updateExtensionSources,
  type InstallerOptions,
} from "./extension-installer.js";
import { packagesHome } from "./extension-sources.js";
import { packageBuilds } from "./package-builds.js";
import { McpEndpoint } from "./mcp-endpoint.js";
import { TurnAttachmentRegistry } from "./turn-attachments.js";
import { ExecutionPolicyRegistry, type HostExecutionPolicy } from "./host-execution-policy.js";
import { resolvePiSessionsDirOverride } from "./pi-session-dir.js";
import { isSessionHeldElsewhere, SessionHeldElsewhereError, type SessionLocks } from "./session-locks.js";
import { openSessionLocked, piRewritesOnOpen, readSessionFile } from "./session-read.js";
import { defaultGlobalThemesDir } from "./user-themes.js";
import type { WorkspaceRef } from "../shared/workspace-identity.js";
import type {
  HostAttachedRuntime,
  HostClientCallOptions,
  HostClientServices,
  HostExtensionServices,
  HostNetworkServices,
  HostMachineServices,
  HostBlobServices,
  HostExtensionSettings,
  HostMcpInstructionsProvider,
  HostMcpToolGate,
  HostMcpToolProvider,
  HostPlatform,
  HostPreparedThread,
  HostProjectFacts,
  HostRuntimeBackendProvider,
  HostSessionFile,
  HostStartedThread,
  HostThread,
  HostThreadStartOptions,
  HostThreadImportOptions,
  HostImportedThread,
  HostTrashedThread,
  HostConfigChange,
  HostThreadLifecycle,
  HostTurnObserver,
  HostUiPresenter,
  RuntimeExtensionContribution,
  RuntimeExtensionFactory,
} from "./host-extensions.js";

/**
 * A Pi extension from Tau's own dependencies. The host resolves it, so the
 * package keeps the layout npm gave it and finds the files it ships beside
 * itself — a bundled copy inside a kit would not.
 */
async function loadRuntimeExtensionPackage(packageName: string): Promise<RuntimeExtensionFactory> {
  const module = await importDependency(packageName);
  if (typeof module.default !== "function") throw new Error(`Package ${packageName} does not export a Pi extension.`);
  return module.default as RuntimeExtensionFactory;
}

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
  runtimeTools?(action: "state" | "update", input?: { kind: string }): Promise<UiRuntimeToolsState>;
  readonly safeMode: boolean;
  readonly platform: HostPlatform;
  /** Root of the per-extension state folders; the registry binds each extension's own under it. */
  readonly stateDir: string;
  cwd(): string;
  setCwd(cwd: string): void;
  log(label: string, detail?: string): void;
  openWorkspace(path: string): Promise<HostActionResult>;
  knownWorkspacePath(path: string): Promise<string>;
  workspaceRef(path: string): WorkspaceRef;
  admitWorkspace(path: string): WorkspaceRef;
  projectName(cwd: string): Promise<string>;
  rememberProjectName(cwd: string, name: string): void;
  /** Whether Tau or an attached Pi terminal owns the visible runtime. */
  runtimeOwner(): "tau" | "pi";
  thread(sessionId?: string): HostThread | undefined;
  complete(request: CompletionRequest, model?: { provider: string; id: string }): Promise<string>;
  completionModels(): Promise<UiModel[]>;
  priceUsage(tallies: readonly UsageTally[]): Promise<PricedUsage[]>;
  /** Tau's config as the levels resolve it for a project, or for this machine alone. */
  readConfig?(cwd?: string): Promise<TauConfig>;
  readonly modelAuth: HostModelAuthServices;
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
  /** Writes a session another machine made as a thread of this one and indexes it. */
  importThread(options: HostThreadImportOptions): Promise<HostImportedThread>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  refreshThreadIndex(options?: { publish?: boolean }): Promise<ThreadIndexSnapshot>;
  /** Moves a persisted thread to the trash; the `threadDeleted` hooks run when it is purged. */
  removeThread(sessionId: string): Promise<void>;
  restoreThread(sessionId: string): Promise<void>;
  purgeThread(sessionId: string): Promise<void>;
  sendToThread(sessionId: string, text: string, options: { delivery: "prompt" | "steer" | "queue"; from?: string; attachments?: UiPromptAttachment[] }): Promise<void>;
  /** Changes a thread's model by id, on or off screen. */
  setThreadModel(sessionId: string, provider: string, id: string): Promise<void>;
  /** Stops a thread's running turn; nothing happens to a thread without a runtime. */
  abortThread(sessionId: string): Promise<void>;
  trashedThreads(): Promise<HostTrashedThread[]>;
  /** The Pi sessions this host writes; a session file an extension writes through must not be another process's. */
  readonly sessionLocks: SessionLocks;
  /** The clients attached to this host, for the seam's ungated `clients` member. */
  readonly clients: HostClientServices;
  readonly network?: HostNetworkServices;
  readonly machines?: HostMachineServices;
  readonly blobs?: HostBlobServices;
  registerThreadLifecycle(lifecycle: HostThreadLifecycle): () => void;
  registerTurnObserver(observer: HostTurnObserver): () => void;
  pinTranscriptEntries(provider: (thread: HostThread) => Iterable<string>): () => void;
  decorateUiPrompt(decorator: (prompt: ExtensionUiPrompt) => void | (() => void)): () => void;
  /** A yes/no question on one thread's dialog surface; aborting `signal` cancels it as `false`. */
  confirmInThread(threadId: string, title: string, message: string, signal: AbortSignal): Promise<boolean>;
  /** A backend came or went; the host republishes what names them once it runs. */
  runtimeBackendsChanged?(): void;
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
  /** Tells every subscriber that a watched file moved; the host is the only caller. */
  notifyConfigChange(change: HostConfigChange): void;
  /** What the user lets external runtimes do. */
  permissionLevel(): RuntimePermissionLevel;
  /** Wraps a session manager for extensions; a runtime prepared for the file shares the manager. */
  sessionFile(manager: SessionManager): HostSessionFile;
  /** The local MCP endpoint the `mcp` services front; the host closes it when it stops. */
  readonly mcp: McpEndpoint;
  /** What a folder's commands may reach, as the providers of `services.executionPolicy` merge. */
  executionPolicy(cwd: string): Promise<HostExecutionPolicy>;
}

/** One extension's entries of `options` and `values`, without its id in front. */
export async function extensionSettings(port: Pick<ExtensionServicesPort, "readConfig">, extensionId: string, cwd?: string): Promise<HostExtensionSettings> {
  const config = port.readConfig ? await port.readConfig(cwd) : {};
  const prefix = `${extensionId}.`;
  const own = <T,>(record: Readonly<Record<string, T>> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
  return { options: own(config.options), values: own(config.values) };
}

/** A program's kind, and `<kind>@<instance>` for another setup of it. */
const BACKEND_KIND = /^[A-Za-z][A-Za-z0-9_.-]*(?:@[a-z][a-z0-9_-]*)?$/u;

export function createHostExtensionSeam(port: ExtensionServicesPort): HostExtensionSeam {
  const backends = new Map<ThreadBackendKind, HostRuntimeBackendProvider>();
  const runtimeExtensions: RuntimeExtensionContribution[] = [];
  const uiPresenters = new Set<HostUiPresenter>();
  const entryPins = new Set<(thread: HostThread) => Iterable<string>>();
  const configObservers = new Set<(change: HostConfigChange) => void>();
  const sessionFileManagers = new WeakMap<HostSessionFile, SessionManager>();
  let permissionLevelProvider: (() => RuntimePermissionLevel) | undefined;
  const mcpProviders = new Set<HostMcpToolProvider>();
  const mcpGates: HostMcpToolGate[] = [];
  const mcpInstructions: HostMcpInstructionsProvider[] = [];
  const mcp = new McpEndpoint({
    providers: () => mcpProviders,
    instructions: () => mcpInstructions,
    gates: () => mcpGates,
    confirm: (threadId, title, message, signal) => port.confirmInThread(threadId, title, message, signal),
    log: (label, detail) => port.log(label, detail),
  });
  // A closed runtime's process is gone; its credential goes with it.
  port.registerTurnObserver({ closed: async (threadId) => { mcp.revoke(threadId); } });
  const turnAttachments = new TurnAttachmentRegistry((label, detail) => port.log(label, detail));
  const executionPolicy = new ExecutionPolicyRegistry((label, detail) => port.log(label, detail));

  /** Files read while another process held them: read in memory, every write refused with this. */
  const readOnlyFiles = new WeakMap<HostSessionFile, SessionHeldElsewhereError>();
  const sessionFile = (manager: SessionManager, readOnly?: { path: string; refusal: SessionHeldElsewhereError }): HostSessionFile => {
    const path = readOnly?.path ?? manager.getSessionFile();
    if (!path) throw new Error("This session has no file yet.");
    // Checked at each write: another host may have opened the session since.
    const writable = () => {
      if (readOnly) throw readOnly.refusal;
      port.sessionLocks.assertWritableSync(manager.getSessionFile() ?? path);
    };
    const file: HostSessionFile = {
      path,
      sessionId: manager.getSessionId(),
      cwd: manager.getCwd(),
      entries: () => manager.getBranch(),
      leafId: () => manager.getLeafId() ?? undefined,
      appendEntry: (customType, data) => { writable(); manager.appendCustomEntry(customType, data); },
      appendInfo: (text) => { writable(); manager.appendSessionInfo(text); },
      branch: (entryId) => {
        if (readOnly) throw readOnly.refusal;
        // createBranchedSession turns this manager into the new session.
        let branched: string | undefined;
        try { branched = manager.createBranchedSession(entryId); } catch { return undefined; }
        return branched ? sessionFile(manager) : undefined;
      },
    };
    sessionFileManagers.set(file, manager);
    if (readOnly) readOnlyFiles.set(file, readOnly.refusal);
    return file;
  };

  /** Pi repairs some files as it opens them; one another process holds is read without that write. */
  const openSessionFile = (path: string): HostSessionFile => {
    if (!piRewritesOnOpen(path)) return sessionFile(SessionManager.open(path));
    try {
      port.sessionLocks.assertWritableSync(path);
    } catch (error) {
      if (!isSessionHeldElsewhere(error)) throw error;
      return sessionFile(readSessionFile(path), { path, refusal: error });
    }
    return sessionFile(SessionManager.open(path));
  };

  // The installer spawns npm and git and writes ~/.tau; the host owns it, and a
  // package reaches it only through the `packages` permission.
  const installer = (progress?: (message: string) => void): InstallerOptions => ({
    cwd: port.cwd(),
    home: packagesHome(),
    findCommand: (name) => findExecutable(name),
    ...(progress ? { progress } : {}),
  });

  const services: HostExtensionServices = {
    cwd: () => port.cwd(),
    agentDir: getAgentDir(),
    sessionsDir: resolvePiSessionsDirOverride() ?? join(getAgentDir(), "sessions"),
    stateDir: port.stateDir,
    themesDir: defaultGlobalThemesDir(),
    safeMode: port.safeMode,
    log: (label, detail) => port.log(label, detail),
    openWorkspace: (path) => port.openWorkspace(path),
    knownWorkspacePath: (path) => port.knownWorkspacePath(path),
    workspaceRef: (path) => port.workspaceRef(path),
    admitWorkspace: (path) => port.admitWorkspace(path),
    projectName: (cwd) => port.projectName(cwd),
    rememberProjectName: (cwd, name) => port.rememberProjectName(cwd, name),
    pickDirectory: (options) => port.platform.pickDirectory
      ? port.platform.pickDirectory(options)
      : Promise.reject(new Error("This host has no folder picker.")),
    runtimeOwner: () => port.runtimeOwner(),
    thread: (sessionId) => port.thread(sessionId),
    complete: (request, model) => port.complete(request, model),
    completionModels: () => port.completionModels(),
    priceUsage: (tallies) => port.priceUsage(tallies),
    modelAuth: port.modelAuth,
    setThreadTitle: (sessionId, title, source) => port.setThreadTitle(sessionId, title, source),
    attachedRuntime: (sessionId) => port.attachedRuntime(sessionId),
    describeProjects: (facts) => port.describeProjects(facts),
    noteSubprocess: () => port.noteSubprocess(),
    findCommand: (name) => findExecutable(name),
    skills: (cwd) => loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true }).skills
      .map(({ name, description }) => ({ name, ...(description ? { description } : {}) })),
    refreshExtensionPackages: () => port.refreshExtensionPackages(),
    listPackages: () => listExtensionSources(installer()),
    installPackage: (source, scope, progress) => { port.noteSubprocess(); return installExtensionSource(source, scope, installer(progress)); },
    removePackage: (source, scope) => removeExtensionSource(source, scope, installer()),
    updatePackages: (source, progress) => { port.noteSubprocess(); return updateExtensionSources(source, installer(progress)); },
    packageBuilds: {
      list: () => packageBuilds.list(),
      observe: (listener) => packageBuilds.observe(listener),
    },
    projectTrust: {
      trusted: (cwd = port.cwd()) => new ProjectTrustStore(getAgentDir()).get(cwd) === true,
      trust: (cwd = port.cwd()) => {
        new ProjectTrustStore(getAgentDir()).set(cwd, true);
        return cwd;
      },
    },
    sessions: {
      list: async () => (await SessionManager.listAll(resolvePiSessionsDirOverride())).map((info) => ({ sessionId: info.id, path: info.path, cwd: info.cwd })),
      open: (path) => {
        // Pi falls back to process.cwd() for a missing file; never hand that out.
        if (!existsSync(path)) throw new Error(`No session file at ${path}.`);
        return openSessionFile(path);
      },
      prepare: async (session, options = {}) => {
        const refused = readOnlyFiles.get(session);
        if (refused) throw new SessionHeldElsewhereError(refused.sessionFile, refused.owner, "open");
        return port.prepareThread(
          session,
          sessionFileManagers.get(session) ?? await openSessionLocked(port.sessionLocks, session.path),
          options,
        );
      },
      start: (options) => port.startThread(options),
      import: (options) => port.importThread(options),
      remove: (sessionId) => port.removeThread(sessionId),
      restore: (sessionId) => port.restoreThread(sessionId),
      trash: () => port.trashedThreads(),
      purge: (sessionId) => port.purgeThread(sessionId),
      send: (sessionId, text, sendOptions) => port.sendToThread(sessionId, text, {
        delivery: sendOptions?.delivery ?? "prompt",
        ...(sendOptions?.from ? { from: sendOptions.from } : {}),
        ...(sendOptions?.attachments ? { attachments: [...sendOptions.attachments] } : {}),
      }),
      setModel: (sessionId, provider, id) => port.setThreadModel(sessionId, provider, id),
      abort: (sessionId) => port.abortThread(sessionId),
      exclusive: (work) => port.exclusive(work),
      refreshIndex: async (options) => ({
        version: HOST_PROTOCOL_VERSION,
        type: "thread-index",
        index: await port.refreshThreadIndex(options),
      }),
    },
    clients: port.clients,
    ...(port.network ? { network: port.network } : {}),
    ...(port.machines ? { machines: port.machines } : {}),
    ...(port.blobs ? { blobs: port.blobs } : {}),
    registerThreadLifecycle: (lifecycle) => port.registerThreadLifecycle(lifecycle),
    registerTurnObserver: (observer) => port.registerTurnObserver(observer),
    pinTranscriptEntries: (provider) => {
      entryPins.add(provider);
      return () => { entryPins.delete(provider); };
    },
    observeConfigChanges: (listener) => {
      configObservers.add(listener);
      return () => { configObservers.delete(listener); };
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
    loadRuntimeExtension: (packageName) => loadRuntimeExtensionPackage(packageName),
    loadDependency: (packageName, options) => loadDependencyModule(packageName, undefined, options),
    mcp: {
      registerTools: (provider) => {
        mcpProviders.add(provider);
        return () => { mcpProviders.delete(provider); };
      },
      gate: (gate) => {
        mcpGates.push(gate);
        return () => {
          const index = mcpGates.indexOf(gate);
          if (index >= 0) mcpGates.splice(index, 1);
        };
      },
      registerInstructions: (provider) => {
        mcpInstructions.push(provider);
        return () => {
          const index = mcpInstructions.indexOf(provider);
          if (index >= 0) mcpInstructions.splice(index, 1);
        };
      },
      connect: (thread, options) => port.safeMode ? Promise.resolve(undefined) : mcp.connect(thread, options),
    },
    // `extensionServices` binds the extension id in front of these four.
    turnAttachments: turnAttachments as unknown as HostExtensionServices["turnAttachments"],
    executionPolicy: executionPolicy as unknown as HostExtensionServices["executionPolicy"],
    settings: ((extensionId: string, cwd?: string) => extensionSettings(port, extensionId, cwd)) as unknown as HostExtensionServices["settings"],
    callClient: ((extensionId: string, command: string, input?: unknown, options?: HostClientCallOptions) => port.platform.callClient
      ? port.platform.callClient(extensionId, command, input, options)
      : Promise.reject(new Error("This host has no client process that can answer."))) as unknown as HostExtensionServices["callClient"],
    clientWindow: ((extensionId: string) => port.platform.clientWindow?.(extensionId)) as unknown as HostExtensionServices["clientWindow"],
    runtimeTools: port.runtimeTools ? (action, input) => port.runtimeTools!(action, input) : undefined,
    setPermissionLevel: (provider) => { permissionLevelProvider = provider; },
    registerRuntimeBackend: (provider) => {
      if (runtimeDriver(provider.kind ?? "") === "pi" || !provider.kind) throw new Error(`Runtime backend kind "${provider.kind}" is reserved.`);
      if (!BACKEND_KIND.test(provider.kind)) throw new Error(`Runtime backend kind "${provider.kind}" is not a name: letters, digits, - and _, and at most one @ before an instance.`);
      if (backends.has(provider.kind)) throw new Error(`Runtime backend "${provider.kind}" is already registered.`);
      assertRuntimeAdapter(provider.adapter);
      if (provider.adapter.id !== provider.kind) throw new Error(`Runtime backend "${provider.kind}" must carry an adapter of the same kind.`);
      backends.set(provider.kind, provider);
      port.runtimeBackendsChanged?.();
      return () => {
        if (backends.get(provider.kind) !== provider) return;
        backends.delete(provider.kind);
        port.runtimeBackendsChanged?.();
      };
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
    notifyConfigChange: (change) => {
      for (const observer of [...configObservers]) {
        try { observer(change); } catch (error) { port.log("host-extension.config-changed.failed", error instanceof Error ? error.message : String(error)); }
      }
    },
    // Without an access extension everything is allowed.
    permissionLevel: () => permissionLevelProvider?.() ?? "full",
    sessionFile,
    mcp,
    executionPolicy: (cwd) => executionPolicy.for(cwd),
  };
}
