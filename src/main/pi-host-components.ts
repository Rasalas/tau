import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionFactory, type SessionManager, type SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
  HostEvent,
  HostSnapshot,
  NewThreadRequestId,
  ThreadBackendKind,
  ThreadHostEvent,
  UiComposerCommand,
} from "../shared/contracts.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import { AttachedThreadBackend } from "./attached-thread-backend.js";
import { ClientMessageTracker } from "./client-message-tracker.js";
import { ClientTurnLedger } from "./client-turn-ledger.js";
import { defaultHostConfigManager } from "./host-config.js";
import { HostCompletions } from "./host-completion.js";
import {
  HostExtensionRegistry,
  HostThreadLifecycleSet,
  HostTurnObserverSet,
  type HostExtension,
  type HostPreparedThread,
  type HostRuntimeBackendProvider,
  type HostSessionFile,
  type HostStartedThread,
  type HostThread,
  type HostThreadStartOptions,
  type HostUiPresenter,
  type RuntimeSessionInfo,
} from "./host-extensions.js";
import { HostClientRegistry } from "./host-clients.js";
import { HostPublication } from "./host-publication.js";
import { HostLifecycleInstrumentation } from "./host-lifecycle.js";
import { HostReport } from "./host-report.js";
import { HostLifecycleCoordinator } from "./host-lifecycle-coordinator.js";
import {
  createAttachedSessionHost,
  createHostExtensionSeam,
  type AttachedSessionPort,
  type ExtensionServicesPort,
  type HostExtensionSeam,
} from "./host-ports.js";
import { ExtensionPackageActivator } from "./extension-package-activation.js";
import { watchingEnabled } from "./config-watcher.js";
import { WorkspaceWatch } from "./workspace-watch.js";
import { ExtensionUiCoordinator } from "./extension-ui-coordinator.js";
import { ThreadProjection } from "./thread-projection.js";
import { ThreadIndex } from "./thread-index.js";
import { ProjectFactsCache } from "./project-facts-cache.js";
import { ThreadBinding } from "./thread-binding.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { ThreadRuntimeRegistry } from "./thread-runtimes.js";
import { ThreadRuntimeLifecycle } from "./thread-runtime-lifecycle.js";
import { RuntimePrewarm } from "./runtime-prewarm.js";
import { PromptPreparation } from "./prompt-preparation.js";
import { TurnDelivery } from "./turn-delivery.js";
import { TurnsInFlight } from "./turns-in-flight.js";
import { WorkbenchReloadCoordinator } from "./workbench-reload-coordinator.js";
import { WorkspaceIdentity } from "./workspace-identity.js";
import { ProjectHistory } from "./project-history.js";
import { resolvePiSessionsDirOverride } from "./pi-session-dir.js";
import { assertRuntimeAdapter, PI_AGENT_RUNTIME_ADAPTER, type AgentRuntimeAdapter } from "./runtime-adapters.js";
import type { PiHostOptions } from "./pi-host-options.js";
import type { HostActionResult, HostUpdate } from "../shared/host-protocol.js";
import type { LiveTurnState } from "./live-turn-state.js";
import type { ThreadRuntimeEvent } from "./runtime-types.js";
import { markTauHostRuntime } from "./tau-runtime-owner.js";

/** Live Pi runtimes kept in memory; idle ones beyond this are released oldest first. */
const MAX_LIVE_THREADS = 6;

type Emit = (event: HostEvent) => void;

/**
 * The narrow surface of PiHost that the collaborator ports call back into:
 * late-bound closures plus the raw constructor inputs the wiring reads.
 */
export interface PiHostDeps {
  getCwd(): string;
  setCwd(cwd: string): void;
  readonly safeMode: boolean;
  readonly automaticPrewarm: boolean;
  readonly projectHistory: ProjectHistory;
  /** The raw emit; the returned host event emitter wraps it with the IPC recorder. */
  emit(event: HostEvent): void;
  emitUpdate(update: HostUpdate): void;
  emitForThread(thread: ThreadRuntime | undefined, event: ThreadHostEvent): void;
  log(label: string, detail?: string): void;
  logForThread(thread: ThreadRuntime, label: string, detail?: string): void;
  fail(error: unknown, sessionId?: string, thread?: ThreadRuntime): void;
  errorMessage(error: unknown): string;
  logPhase(phase: string, startedAt: number, reason: string, cwd: string, note?: string, thread?: ThreadRuntime): void;
  logRuntimePhase(phase: string, startedAt: number, reason: string, cwd: string): void;
  recordBackground(name: string, startedAt: number): void;
  publishActiveCatalog(): Promise<void>;
  publishLabel(cwd: string, label: string | undefined): void;
  setWindowTitle(title: string): void;
  abortThread(thread: ThreadRuntime): Promise<void>;
  adoptThread(thread: ThreadRuntime): Promise<void>;
  applyThreadTitle(thread: ThreadRuntime, title: string, source: "generated" | "renamed"): Promise<HostUpdate>;
  prewarmSession(path: string): Promise<void>;
  handleSessionEvent(event: unknown, thread: LiveTurnState, sessionId: string, cwd: string): void;
  handleBackendEvent(threadId: string, event: ThreadRuntimeEvent): void;
  presentUi<K extends keyof HostUiPresenter>(method: K, ...args: Parameters<NonNullable<HostUiPresenter[K]>>): boolean;
  hostThreadFor(thread: ThreadRuntime): HostThread;
  hostThread(sessionId: string | undefined): HostThread | undefined;
  threadFor(sessionId: string | undefined): ThreadRuntime | undefined;
  requireThread(sessionId: string | undefined): ThreadRuntime;
  requireBackend(kind: ThreadBackendKind): HostRuntimeBackendProvider;
  adapterFor(kind: ThreadBackendKind): AgentRuntimeAdapter;
  runtimeExtensionsFor(settingsManager: SettingsManager, session: RuntimeSessionInfo): Array<{ name: string; factory: ExtensionFactory }>;
  getActive(): ThreadRuntime | undefined;
  /** False while Pi's own terminal owns the visible thread. */
  hasLocalActive(): boolean;
  ownedByPi(thread: ThreadRuntime | undefined): boolean;
  liveThreadForPath(path: string | undefined): ThreadRuntime | undefined;
  liveThreadIds(): Set<string>;
  snapshot(): Promise<HostSnapshot>;
  detailForSnapshot(snapshot: HostSnapshot, requestId?: NewThreadRequestId): import("../shared/host-protocol.js").ThreadDetail;
  lifecycleUpdates(snapshot: HostSnapshot, requestId?: NewThreadRequestId): HostUpdate[];
  refreshActiveThreadShell(): Promise<void>;
  setWorkspace(path: string): Promise<HostActionResult>;
  knownWorkspacePath(path: string): Promise<string>;
  prepareThread(session: HostSessionFile, manager: SessionManager, options: { previousSessionFile?: string }): Promise<HostPreparedThread>;
  startThread(options: HostThreadStartOptions): Promise<HostStartedThread>;
  removeThread(sessionId: string): Promise<void>;
  pendingHostExtensions(): readonly HostExtension[] | (() => Promise<readonly HostExtension[]>);
}

/** What PiHost currently assigns in its constructor, as one construction pass. */
export interface PiHostComponents {
  readonly agentDir: string;
  readonly sessionsDirOverride: string | undefined;
  readonly completions: HostCompletions;
  readonly piAdapter: AgentRuntimeAdapter;
  readonly defaultBackendKind: ThreadBackendKind;
  readonly runtimeCommands: readonly UiComposerCommand[];
  readonly workspaces: WorkspaceIdentity;
  readonly clientTurns: ClientTurnLedger;
  readonly lifecycleMetrics: HostLifecycleInstrumentation;
  readonly report: HostReport;
  readonly emit: Emit;
  readonly threads: ThreadRuntimeRegistry<ThreadRuntime>;
  readonly lifecycle: HostLifecycleCoordinator;
  readonly workbenchReload: WorkbenchReloadCoordinator;
  readonly projects: ProjectFactsCache;
  readonly prompts: PromptPreparation;
  readonly threadLifecycle: HostThreadLifecycleSet;
  readonly turnObservers: HostTurnObserverSet;
  readonly clients: HostClientRegistry;
  readonly toolOwners: Map<string, string>;
  readonly index: ThreadIndex;
  readonly publication: HostPublication;
  readonly seam: HostExtensionSeam;
  readonly hostExtensions: HostExtensionRegistry;
  readonly packages: ExtensionPackageActivator | undefined;
  /** Follows the files the host reads; undefined in safe mode or when watching is off. */
  readonly watch: WorkspaceWatch | undefined;
  readonly attached: AttachedThreadBackend;
  readonly attachedThread: ThreadRuntime;
  readonly projection: ThreadProjection;
  readonly extensionUi: ExtensionUiCoordinator;
  readonly clientMessages: ClientMessageTracker;
  readonly binding: ThreadBinding;
  readonly runtimes: ThreadRuntimeLifecycle;
  readonly prewarm: RuntimePrewarm;
  readonly turns: TurnDelivery;
  readonly turnsInFlight: TurnsInFlight;
  /** Settings → Defaults, read fresh: the answer is wanted once, at start. */
  readonly continueThreadsAfterRestart: () => boolean;
}

export function buildPiHostComponents(options: PiHostOptions, deps: PiHostDeps): PiHostComponents {
  const { safeMode } = deps;
  const clientTurns = new ClientTurnLedger();
  /** PI_CODING_AGENT_SESSION_DIR, resolved once; undefined keeps Pi's own default sessions layout. */
  const sessionsDirOverride = resolvePiSessionsDirOverride();
  const lifecycleMetrics = new HostLifecycleInstrumentation();
  const emit: Emit = (event) => {
    lifecycleMetrics.recordIpc(event);
    deps.emit(event);
  };
  const report = new HostReport({
    emit,
    threadFor: (sessionId) => deps.threadFor(sessionId),
    ...(options.logger ? { logger: options.logger } : {}),
  }, lifecycleMetrics);
  const completions = new HostCompletions({ agentDir: getAgentDir(), cwd: () => deps.getCwd(), ...(options.createModelRuntime ? { createRuntime: options.createModelRuntime } : {}) });
  const piAdapter = assertRuntimeAdapter(safeMode ? PI_AGENT_RUNTIME_ADAPTER : options.runtimeAdapter ?? PI_AGENT_RUNTIME_ADAPTER);
  if (piAdapter.id !== "pi") throw new Error("The host's own runtime adapter must be Pi; other backends come from host extensions.");
  const defaultBackendKind: ThreadBackendKind = safeMode ? "pi" : options.defaultBackendKind ?? "pi";
  const runtimeCommands: readonly UiComposerCommand[] = options.runtimeCommands ?? [];
  const workspaces = options.workspaceIdentity ?? new WorkspaceIdentity(randomBytes(16).toString("hex"));
  const platform = options.platform ?? {};
  const kitStateDir = options.kitStateDir ?? join(tmpdir(), "tau-kit-state");
  const threadLifecycle = new HostThreadLifecycleSet();
  const turnObservers = new HostTurnObserverSet();
  // Transports report their clients into this one; a client that arrives or
  // leaves is published, so a panel never has to ask the host for the count.
  const clients = options.clients ?? new HostClientRegistry();
  clients.observe({
    attached: () => emit({ type: "client-count", count: clients.count() }),
    detached: () => emit({ type: "client-count", count: clients.count() }),
  });
  const toolOwners = new Map<string, string>();
  const threads: ThreadRuntimeRegistry<ThreadRuntime> = new ThreadRuntimeRegistry<ThreadRuntime>({
    maxLive: MAX_LIVE_THREADS,
    // A thread with work in flight, an open question, or nothing saved yet has
    // state that only its runtime holds; releasing it would lose that state.
    canEvict: (record) => record.runtime.state.idle
      && !extensionUi.hasOpen(record.threadId)
      && record.runtime.adapterPending === 0
      && !record.runtime.adapterStreaming
      && turnObservers.pending(record.threadId) === 0
      // An external runtime owns its transcript in the app-data store rather
      // than in Pi's message array. It is therefore safe to release once its
      // own visible projection has been persisted.
      && (record.runtime.state.hasMessages || (record.runtime.adapterMessages?.length ?? 0) > 0),
    dispose: (record) => runtimes.dispose(record.runtime),
  });
  /** Owns both queue admission and the epoch that guards visible activation. */
  const lifecycle = new HostLifecycleCoordinator({
    onSlow: (operation, elapsedMs) => report.log("lifecycle.slow", `${operation} · ${Math.round(elapsedMs / 100) / 10}s`),
  });
  const workbenchReload = new WorkbenchReloadCoordinator({
    runs: () => [...threads.list().map((record) => record.runtime), attachedThread]
      .filter((thread) => !thread.state.idle || thread.state.streaming || thread.adapterPending > 0 || thread.adapterStreaming)
      .map((thread) => ({ waitForIdle: () => thread.backend.waitForIdle(), abort: () => deps.abortThread(thread) })),
    serialize: (operation) => lifecycle.run("workbench-reload", operation),
  });
  /** What extensions know about projects: name, label, nesting, all cached. */
  const projects = new ProjectFactsCache({
    onLabel: (cwd, label) => deps.publishLabel(cwd, label),
    onNesting: () => index.publishSnapshotSoon(),
    recordBackground: (name, startedAt) => deps.recordBackground(name, startedAt),
    log: (label, detail) => deps.log(label, detail),
    errorMessage: (error) => deps.errorMessage(error),
  });
  /** The runtime spelling of a prompt, and the proof that a caller may execute it. */
  const prompts = new PromptPreparation({
    requireBackend: (kind) => deps.requireBackend(kind),
    permissionLevel: () => seam.permissionLevel(),
  });
  const index = new ThreadIndex({
    cwd: () => deps.getCwd(),
    safeMode,
    sessionsDir: sessionsDirOverride,
    projects,
    workspaces,
    projectHistory: deps.projectHistory,
    threadLifecycle,
    backends: () => seam.backends,
    liveThreads: () => threads.list().map((record) => record.runtime),
    hostThread: (thread) => deps.hostThreadFor(thread),
    emit: (event) => emit(event),
    emitUpdate: (update) => deps.emitUpdate(update),
    log: (label, detail) => deps.log(label, detail),
    fail: (error) => deps.fail(error),
    errorMessage: (error) => deps.errorMessage(error),
  }, {
    ...(options.sessionUsageCachePath ? { usageCachePath: options.sessionUsageCachePath } : {}),
    ...(options.sessionLineageCachePath ? { lineageCachePath: options.sessionLineageCachePath } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const publication = new HostPublication({
    index,
    workspaces,
    metrics: lifecycleMetrics,
    emitUpdate: (update) => deps.emitUpdate(update),
  });
  /** The one place the components hand their collaborators what they may ask of the host. */
  const port: AttachedSessionPort & ExtensionServicesPort = {
    safeMode,
    platform,
    stateDir: kitStateDir,
    clientTurns,
    emit: (event) => emit(event),
    emitUpdate: (update) => deps.emitUpdate(update),
    log: (label, detail) => deps.log(label, detail),
    errorMessage: (error) => deps.errorMessage(error),
    fail: (error) => deps.fail(error),
    beginActivation: () => lifecycle.beginActivation(),
    isCurrentActivation: (epoch) => lifecycle.isCurrentActivation(epoch),
    releaseLocalThread: async (sessionFile) => {
      const local = deps.liveThreadForPath(sessionFile);
      if (local) await threads.release(local.threadId);
    },
    clearActiveThread: () => threads.setActive(undefined),
    cwd: () => deps.getCwd(),
    setCwd: (cwd) => deps.setCwd(cwd),
    onSessionEvent: (event, threadId) => deps.handleSessionEvent(event, attachedThread, threadId, deps.getCwd()),
    snapshot: () => deps.snapshot(),
    detailForSnapshot: (snapshot, requestId) => deps.detailForSnapshot(snapshot, requestId),
    lifecycleUpdates: (snapshot) => deps.lifecycleUpdates(snapshot),
    refreshActiveThreadShell: () => deps.refreshActiveThreadShell(),
    openWorkspace: (path) => deps.setWorkspace(path),
    knownWorkspacePath: (path) => deps.knownWorkspacePath(path),
    workspaceRef: (path) => workspaces.ref(path),
    projectName: (cwd) => projects.loadName(cwd),
    rememberProjectName: (cwd, name) => { projects.rememberName(cwd, name); },
    runtimeOwner: () => deps.ownedByPi(deps.getActive()) ? "pi" : "tau",
    thread: (sessionId) => deps.hostThread(sessionId),
    complete: (request, model) => completions.complete(request, model),
    setThreadTitle: async (sessionId, title, source) => { await deps.applyThreadTitle(deps.requireThread(sessionId), title, source); },
    attachedRuntime: (sessionId) => deps.ownedByPi(deps.threadFor(sessionId)) ? attached.hostRuntime : undefined,
    describeProjects: (facts) => projects.add(facts),
    noteSubprocess: () => lifecycleMetrics.countSubprocess(),
    refreshExtensionPackages: () => packages?.refresh() ?? Promise.resolve(),
    prepareThread: (session, manager, prepareOptions) => deps.prepareThread(session, manager, prepareOptions),
    startThread: (startOptions) => deps.startThread(startOptions),
    removeThread: (sessionId) => deps.removeThread(sessionId),
    clients,
    exclusive: (work) => lifecycle.run("extension.exclusive", work),
    refreshThreadIndex: () => index.refresh("none").catch(() => index.snapshot()),
    registerThreadLifecycle: (hook) => threadLifecycle.add(hook),
    registerTurnObserver: (observer) => turnObservers.add(observer),
    pinTranscriptEntries: () => { throw new Error("The extension seam owns transcript pins."); },
    decorateUiPrompt: (decorator) => extensionUi.addDecorator(decorator),
  };
  const seam = createHostExtensionSeam(port);
  const hostExtensions = new HostExtensionRegistry(seam.services, (event) => emit(event));
  const loadPackages = safeMode ? undefined : options.hostExtensionPackages;
  const packages = loadPackages && new ExtensionPackageActivator({
    registry: hostExtensions,
    load: loadPackages,
    cwd: () => deps.getCwd(),
    agentDir: getAgentDir(),
    bundled: (id) => {
      const pending = deps.pendingHostExtensions();
      return Array.isArray(pending) && pending.some((extension) => extension.id === id);
    },
    log: (label, detail) => deps.log(label, detail),
    publish: (event) => emit(event),
    ...(options.grantsFilePath ? { grantsFilePath: options.grantsFilePath } : {}),
  });
  const attached = new AttachedThreadBackend(createAttachedSessionHost(port));
  const attachedThread = new ThreadRuntime(attached);
  const projection = new ThreadProjection(
    clientTurns,
    () => attached.session.snapshot,
    seam.entryPins,
    (thread) => deps.hostThreadFor(thread),
    (error) => deps.log("host-extension.pins.failed", deps.errorMessage(error)),
  );
  const extensionUi = new ExtensionUiCoordinator(
    (thread, event) => deps.emitForThread(thread, event),
    (thread, label, detail) => thread ? deps.logForThread(thread, label, detail) : deps.log(label, detail),
  );
  const clientMessages = new ClientMessageTracker(
    clientTurns,
    (thread) => knownSkillNames(projection.composerCommands(thread)),
    (thread) => projection.mapping(thread),
    (event) => emit(event),
  );
  const binding: ThreadBinding = new ThreadBinding({
    extensionUi,
    clientTurns,
    clientMessages,
    turnObservers,
    projection,
    isActive: (thread) => deps.getActive() === thread,
    isCurrent: (thread) => threads.get(thread.threadId)?.runtime === thread,
    onSessionEvent: (event, runtime, threadId, eventCwd) => deps.handleSessionEvent(event, runtime, threadId, eventCwd),
    emitForThread: (thread, event) => deps.emitForThread(thread, event),
    presentUi: (method, ...args) => deps.presentUi(method, ...args),
    setWindowTitle: (title) => deps.setWindowTitle(title),
    publishActiveCatalog: () => deps.publishActiveCatalog(),
    recordBackground: (name, startedAt) => deps.recordBackground(name, startedAt),
    logPhase: (phase, startedAt, reason, phaseCwd, thread) => deps.logPhase(phase, startedAt, reason, phaseCwd, undefined, thread),
    log: (label, detail) => deps.log(label, detail),
    logForThread: (thread, label, detail) => deps.logForThread(thread, label, detail),
    fail: (error, sessionId, thread) => deps.fail(error, sessionId, thread),
    errorMessage: (error) => deps.errorMessage(error),
  });
  const runtimes: ThreadRuntimeLifecycle = new ThreadRuntimeLifecycle({
    safeMode,
    agentDir: getAgentDir(),
    cwd: () => deps.getCwd(),
    activeSessionFile: () => deps.getActive()?.sessionFile,
    adapterFor: (kind) => deps.adapterFor(kind),
    requireBackend: (kind) => deps.requireBackend(kind),
    permissionLevel: () => seam.permissionLevel(),
    sessionFile: (manager) => seam.sessionFile(manager),
    runtimeExtensions: (settingsManager, session) => deps.runtimeExtensionsFor(settingsManager, session),
    runtimeExtensionNames: () => seam.runtimeExtensions.map((entry) => entry.name),
    threadLifecycle,
    turnObservers,
    clientTurns,
    extensionUi,
    projection,
    projects,
    binding,
    lifecycleMetrics,
    adopt: (thread) => deps.adoptThread(thread),
    currentRuntime: (threadId) => threads.get(threadId)?.runtime,
    liveThreadForPath: (path) => deps.liveThreadForPath(path),
    indexedSession: (path) => index.byPath(path),
    presentUi: (method, ...args) => deps.presentUi(method, ...args),
    releaseTool: (toolCallId) => { toolOwners.delete(toolCallId); },
    emitMessage: (threadId, message) => emit(message.role === "user"
      ? { type: "user-message", sessionId: threadId, message }
      : { type: "assistant-end", sessionId: threadId, message }),
    emitRuntimeEvent: (threadId, event) => deps.handleBackendEvent(threadId, event),
    logRuntimePhase: (phase, startedAt, reason, phaseCwd) => deps.logRuntimePhase(phase, startedAt, reason, phaseCwd),
    log: (label, detail) => deps.log(label, detail),
    errorMessage: (error) => deps.errorMessage(error),
  });
  const hostConfig = defaultHostConfigManager.readSync(deps.getCwd());
  /**
   * Edits to a package, a theme, the keybindings or the config take effect
   * where they are read, not after a reload. Safe mode watches nothing: it
   * exists so a broken extension cannot load at all.
   */
  const watch = safeMode || !watchingEnabled(hostConfig) ? undefined : new WorkspaceWatch({
    cwd: () => deps.getCwd(),
    agentDir: getAgentDir(),
    ...(options.appPath ? { appPath: options.appPath } : {}),
    refreshPackages: (ids) => packages?.refresh({ only: ids }) ?? Promise.resolve(),
    configChanged: (change) => {
      // The host re-reads nothing for anyone: it says what moved, and the kits
      // and clients that own those files decide.
      seam.notifyConfigChange({ kind: change.kind, paths: change.paths });
      emit({ type: "config-changed", kind: change.kind, paths: [...change.paths] });
    },
    log: (label, detail) => deps.log(label, detail),
  });
  const prewarmEnabled = process.env.TAU_NO_PREWARM !== "1" && hostConfig.prewarm !== false && deps.automaticPrewarm;
  const prewarm = new RuntimePrewarm({
    automatic: prewarmEnabled,
    safeMode,
    maxLiveThreads: MAX_LIVE_THREADS,
    cwd: () => deps.getCwd(),
    sessionsDir: sessionsDirOverride,
    runtimes,
    extensionUi,
    liveThreadIds: () => deps.liveThreadIds(),
    hasLocalActive: () => deps.hasLocalActive(),
    indexedSessions: () => index.list(),
    prewarmSession: (path) => deps.prewarmSession(path),
    recordBackground: (name, startedAt) => deps.recordBackground(name, startedAt),
    log: (label, detail) => deps.log(label, detail),
    fail: (error) => deps.fail(error),
    errorMessage: (error) => deps.errorMessage(error),
  });
  const turnsInFlight = new TurnsInFlight({
    ...(options.turnsInFlightPath ? { filePath: options.turnsInFlightPath } : {}),
    ...(options.logger ? { logger: { warn: (message, detail) => options.logger!.warn(message, detail) } } : {}),
  });
  const turns = new TurnDelivery({
    clientTurns,
    clientMessages,
    turnObservers,
    turnsInFlight,
    projection,
    prompts,
    binding,
    index,
    assertAvailable: () => workbenchReload.assertAvailable(),
    requireThread: (sessionId) => deps.requireThread(sessionId),
    emit: (event) => emit(event),
    fail: (error, sessionId) => deps.fail(error, sessionId),
  });
  markTauHostRuntime();
  return {
    agentDir: getAgentDir(),
    sessionsDirOverride,
    completions,
    piAdapter,
    defaultBackendKind,
    runtimeCommands,
    workspaces,
    clientTurns,
    lifecycleMetrics,
    report,
    emit,
    threads,
    lifecycle,
    workbenchReload,
    projects,
    prompts,
    threadLifecycle,
    turnObservers,
    clients,
    toolOwners,
    index,
    publication,
    seam,
    hostExtensions,
    packages,
    watch,
    attached,
    attachedThread,
    projection,
    extensionUi,
    clientMessages,
    binding,
    runtimes,
    prewarm,
    turns,
    turnsInFlight,
    continueThreadsAfterRestart: () => defaultHostConfigManager.readSync(deps.getCwd()).threads?.continueAfterRestart === true,
  };
}
