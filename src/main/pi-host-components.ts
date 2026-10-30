import { RuntimeSwitches } from "./runtime-switches.js";
import { PromptImageFiles } from "./prompt-image-files.js";
import { TurnEvents } from "./turn-events.js";
import { handleRuntimeSessionEvent } from "./session-events.js";
import { handleBackendRuntimeEvent } from "./backend-events.js";
import { HostPreparationQueue } from "./host-preparation-queue.js";
import { AgentSessionControl } from "./agent-session-control.js";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, type SessionManager, type SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
  ClientTurnIdentity,
  HostEvent,
  HostSnapshot,
  UiToolRun,
  ThreadBackendKind,
  ThreadHostEvent,
  UiComposerCommand,
  UiPromptAttachment,
  UiWake,
} from "../shared/contracts.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import { AttachedThreadBackend } from "./attached-thread-backend.js";
import { ClientMessageTracker } from "./client-message-tracker.js";
import { ThreadControls, publishedBackground } from "./thread-stop.js";
import { backgroundWorkTool, BACKGROUND_WORK_INSTRUCTIONS } from "./background-work-tools.js";
import { ThreadBackgroundWork } from "./thread-background-work.js";
import { ClientTurnLedger } from "./client-turn-ledger.js";
import { defaultHostConfigManager } from "./host-config.js";
import { HostCompletions } from "./host-completion.js";
import {
  HostExtensionRegistry,
  runtimeBackendOwner,
  HostThreadLifecycleSet,
  HostTurnObserverSet,
  runtimeExtensionModes,
  sortByRuntimeOrder,
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
import { ownPackagesFilePath, recordOwnPackage } from "./own-packages.js";
import { watchingEnabled } from "./config-watcher.js";
import { WorkspaceWatch } from "./workspace-watch.js";
import { ExtensionUiCoordinator } from "./extension-ui-coordinator.js";
import type { PersistedTranscriptReader } from "./persisted-transcript-reader.js";
import { ThreadProjection } from "./thread-projection.js";
import { ThreadIndex } from "./thread-index.js";
import { ProjectFactsCache } from "./project-facts-cache.js";
import { ThreadBinding } from "./thread-binding.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { ThreadRuntimeRegistry } from "./thread-runtimes.js";
import { ThreadRuntimeLifecycle, type SessionRuntimeExtension } from "./thread-runtime-lifecycle.js";
import { RuntimePrewarm } from "./runtime-prewarm.js";
import { PromptPreparation } from "./prompt-preparation.js";
import { TurnDelivery } from "./turn-delivery.js";
import { TurnsInFlight } from "./turns-in-flight.js";
import { ThreadTrash } from "./thread-trash.js";
import { WorkbenchReloadCoordinator } from "./workbench-reload-coordinator.js";
import { WorkspaceIdentity } from "./workspace-identity.js";
import type { WorkspaceRef } from "../shared/workspace-identity.js";
import { ProjectHistory } from "./project-history.js";
import { resolvePiSessionsDirOverride } from "./pi-session-dir.js";
import { importSessionFile } from "./session-import.js";
import { assertRuntimeAdapter, PI_AGENT_RUNTIME_ADAPTER, type AgentRuntimeAdapter } from "./runtime-adapters.js";
import type { PiHostOptions } from "./pi-host-options.js";
import { SessionLocks } from "./session-locks.js";
import type { HostActionResult, HostUpdate } from "../shared/host-protocol.js";
import type { LiveTurnState } from "./live-turn-state.js";
import { requireCapability, type ThreadRuntimeEvent } from "./runtime-types.js";
import { markTauHostRuntime } from "./tau-runtime-owner.js";
import { QueuedMessages, markWake, type QueuedMessage } from "./queued-messages.js";
import { LIMIT_CONTINUATION_PROMPT, ThreadLimits } from "./thread-limits.js";
import { TurnSettlement } from "./turn-settlement.js";
import { ModelPriceBook, piNewThreadCatalog } from "./model-price-book.js";
import { createModelAuth } from "./model-auth.js";
import { modelReleaseDate, useModelCatalog } from "./pi-model-runtime.js";
import { SignedModelCatalog, modelCatalogKeys } from "./model-catalog.js";
import { RELEASE_PUBLIC_KEYS } from "../shared/release-keys.js";
import { runtimeChoices } from "./host-resources.js";
import { RuntimeCatalogs, type RuntimeCatalogSource } from "./runtime-catalogs.js";
import { RuntimeGate } from "./runtime-gate.js";
import { RuntimeToolUpdates } from "./runtime-tool-updates.js";
import { UsagePricing, type UsageTally } from "./usage-pricing.js";
import { ThreadRunClock } from "./thread-run-clock.js";
import { backgroundHoldsRun } from "../shared/background-work.js";
import { readModelPrices } from "../shared/model-prices.js";

/** Pi's model data is read this long after the first price is asked for, clear of the start. */
const PRICING_LOAD_DELAY_MS = 2_000;
/** Otherwise read this long after start, beside the runtime catalogs' own first read. */
const PRICING_START_DELAY_MS = 5_000;

/** Live Pi runtimes kept in memory; idle ones beyond this are released oldest first. */
const MAX_LIVE_THREADS = 6;
/** A runtime nobody used for this long is released; its thread reopens from the session file. */
const RUNTIME_IDLE_RELEASE_MS = 10 * 60_000;

type Emit = (event: HostEvent) => void;

/**
 * The narrow surface of PiHost that the collaborator ports call back into:
 * late-bound closures plus the raw constructor inputs the wiring reads.
 */
export interface PiHostDeps {
  readonly persistedTranscripts: PersistedTranscriptReader;
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
  setWindowTitle(title: string): void;
  windowTitle(): string | undefined;
  activateThread(thread: ThreadRuntime, epoch: number): Promise<boolean>;
  staleActivationResult(): Promise<HostActionResult>;
  setExtensionCount(count: number): void;
  /** Sends a turn the way the composer does. */
  promptThread(threadId: string, text: string, hidden?: boolean): Promise<void>;
  applyThreadTitle(thread: ThreadRuntime, title: string, source: "generated" | "renamed"): Promise<HostUpdate>;
  prewarmSession(path: string): Promise<void>;
  presentUi<K extends keyof HostUiPresenter>(method: K, ...args: Parameters<NonNullable<HostUiPresenter[K]>>): boolean;
  hostThreadFor(thread: ThreadRuntime): HostThread;
  hostThread(sessionId: string | undefined): HostThread | undefined;
  threadFor(sessionId: string | undefined): ThreadRuntime | undefined;
  requireThread(sessionId: string | undefined): ThreadRuntime;
  requireBackend(kind: ThreadBackendKind): HostRuntimeBackendProvider;
  adapterFor(kind: ThreadBackendKind): AgentRuntimeAdapter;
  runtimeExtensionsFor(settingsManager: SettingsManager, session: RuntimeSessionInfo): SessionRuntimeExtension[];
  getActive(): ThreadRuntime | undefined;
  /** False while Pi's own terminal owns the visible thread. */
  hasLocalActive(): boolean;
  ownedByPi(thread: ThreadRuntime | undefined): boolean;
  /** Extensions of the runtime on screen, as the catalog counts them. */
  extensionCount(): number;
  refreshActiveThreadShell(): Promise<void>;
  setWorkspace(path: string): Promise<HostActionResult>;
  knownWorkspacePath(path: string): Promise<string>;
  admitWorkspace(path: string): WorkspaceRef;
  prepareThread(session: HostSessionFile, manager: SessionManager, options: { previousSessionFile?: string }): Promise<HostPreparedThread>;
  startThread(options: HostThreadStartOptions): Promise<HostStartedThread>;
  switchThreadRuntime?(id: string, kind: string): Promise<void>;
  removeThread(sessionId: string): Promise<void>;
  restoreThread(sessionId: string): Promise<void>;
  purgeThread(sessionId: string): Promise<void>;
  pendingHostExtensions(): readonly HostExtension[] | (() => Promise<readonly HostExtension[]>);
  /** Sends a queued message as the prompt it stands for. */
  deliverQueued(sessionId: string, message: QueuedMessage): Promise<void>;
  /** An extension's message to a thread; a released runtime is reopened off screen first. */
  sendToThread(sessionId: string, text: string, delivery: "prompt" | "steer" | "queue", from?: string, attachments?: UiPromptAttachment[], wake?: UiWake, identity?: ClientTurnIdentity): Promise<void>;
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
  readonly events: {
    session(event: unknown, thread: LiveTurnState, sessionId: string, cwd: string): void;
    backend(threadId: string, event: ThreadRuntimeEvent): void;
  };
  readonly index: ThreadIndex;
  readonly runtimeSwitches: RuntimeSwitches;
  /** Deleted threads until their retention runs out. */
  readonly trash: ThreadTrash;
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
  /** The composer's queue, kept by the host across windows and restarts. */
  readonly queue: QueuedMessages;
  /** Stop and goals: the window's Stop, a kit's `sessions.abort`, the goal methods. */
  readonly controls: ThreadControls;
  /** Threads a provider limit stopped, and the resumes scheduled for their reset. */
  readonly limits: ThreadLimits;
  readonly settlement: TurnSettlement;
  /** What every runtime offers a new thread, kept across runs. */
  readonly catalogs: RuntimeCatalogs;
  /** Keeps the agent CLIs current (Settings → Runtimes). */
  readonly toolUpdates: RuntimeToolUpdates;
  /** What threads cost: the user's prices, the runtimes', a subscription's value. */
  readonly pricing: UsagePricing;
  /** Stop, restart, repair and interrupted-turn recovery. */
  readonly sessionControl: AgentSessionControl;
}

export function buildPiHostComponents(options: PiHostOptions, deps: PiHostDeps): PiHostComponents {
  const { safeMode } = deps;
  const clientTurns = new ClientTurnLedger();
  /** PI_CODING_AGENT_SESSION_DIR, resolved once; undefined keeps Pi's own default sessions layout. */
  const sessionsDirOverride = resolvePiSessionsDirOverride();
  const lifecycleMetrics = new HostLifecycleInstrumentation();
  let toolUpdates: RuntimeToolUpdates | undefined;
  const forward = (stamped: HostEvent): void => {
    if (stamped.type === "agent-status" && !stamped.running) toolUpdates?.turnEnded();
    lifecycleMetrics.recordIpc(stamped);
    deps.emit(stamped);
  };
  // A turn's end waits while the next one is on its way: an open prompt or the composer's queue.
  const runClock = new ThreadRunClock(Date.now, {
    continues: (sessionId) => turnObservers.hasOpenTurn(sessionId) || queue.continues(sessionId),
    forward,
    ended: (sessionId) => turnObservers.runEnded(sessionId),
    waits: (sessionId) => backgroundHoldsRun(index.background(sessionId)),
  });
  const emit: Emit = (event) => {
    const stamped = runClock.stamp(event);
    if (stamped) forward(stamped);
  };
  const report = new HostReport({
    emit,
    threadFor: (sessionId) => deps.threadFor(sessionId),
    ...(options.logger ? { logger: options.logger } : {}),
  }, lifecycleMetrics);
  const completions = new HostCompletions({
    agentDir: getAgentDir(),
    cwd: () => deps.getCwd(),
    ...(options.createModelRuntime ? { createRuntime: options.createModelRuntime } : {}),
    // Asked only after start-up, once `catalogs` exists; Pi's own catalog is what gets narrowed.
    reports: async () => (await catalogs.onHand()).filter((catalog) => catalog.kind !== "pi"),
  });
  /**
   * What threads cost. Pi's model data loads a moment after start, off the
   * start path; totals published before that are worked out again.
   */
  const pricing = new UsagePricing({
    load: async () => {
      const data = await completions.catalogData();
      const book = new ModelPriceBook(data.known, modelReleaseDate);
      return { apiPrice: (provider, model) => book.lookup(provider ?? "", model)?.price, subscription: data.subscription };
    },
    readPrices: () => readModelPrices(defaultHostConfigManager.readSync().modelPrices),
    onChange: () => {
      if (!index.scanned) return;
      index.repriceAll();
      void publication.publishActiveCatalog().catch((error: unknown) => deps.log("usage-pricing.publish-failed", deps.errorMessage(error)));
    },
    log: (label, detail) => deps.log(label, detail),
  });
  let pricingScheduled = false;
  const schedulePricing = (delay: number) => {
    if (pricingScheduled) return;
    pricingScheduled = true;
    setTimeout(() => void pricing.ready(), delay).unref?.();
  };
  // Before the first thread needs a price, as the runtime catalogs do; a price asked for sooner brings it forward.
  if (!safeMode) setTimeout(() => schedulePricing(0), PRICING_START_DELAY_MS).unref?.();
  const priceUsage = (tallies: readonly UsageTally[]) => {
    schedulePricing(PRICING_LOAD_DELAY_MS);
    return pricing.threadUsage(tallies);
  };
  const piAdapter = assertRuntimeAdapter(safeMode ? PI_AGENT_RUNTIME_ADAPTER : options.runtimeAdapter ?? PI_AGENT_RUNTIME_ADAPTER);
  if (piAdapter.id !== "pi") throw new Error("The host's own runtime adapter must be Pi; other backends come from host extensions.");
  const defaultBackendKind: ThreadBackendKind = safeMode ? "pi" : options.defaultBackendKind ?? "pi";
  const runtimeCommands: readonly UiComposerCommand[] = options.runtimeCommands ?? [];
  const workspaces = options.workspaceIdentity ?? new WorkspaceIdentity(randomBytes(16).toString("hex"));
  const platform = options.platform ?? {};
  const kitStateDir = options.kitStateDir ?? join(tmpdir(), "tau-kit-state");
  const threadLifecycle = new HostThreadLifecycleSet();
  const turnObservers = new HostTurnObserverSet((sessionId) => runClock.recheck(sessionId));
  // Transports report their clients into this one; a client that arrives or
  // leaves is published, so a panel never has to ask the host for the count.
  const clients = options.clients ?? new HostClientRegistry();
  clients.observe({
    attached: () => {
      emit({ type: "client-count", count: clients.count() });
      const title = deps.windowTitle();
      if (title !== undefined) emit({ type: "window-title", title });
    },
    detached: () => emit({ type: "client-count", count: clients.count() }),
  });
  // Late-bound collaborators are initialized before a runtime can deliver events.
  const eventServices = {
    clientTurns,
    emit,
    emitUpdate: (update: HostUpdate) => deps.emitUpdate(update),
    log: (label: string, detail?: string) => deps.log(label, detail),
    fail: (error: unknown, owner: string) => deps.fail(error, owner),
    settledSnapshot: () => publication.snapshot(),
    detailForSnapshot: (snapshot: HostSnapshot) => publication.detailForSnapshot(snapshot),
    toolEnded: (owner: string, tool: UiToolRun, cwd: string) => turnObservers.toolEnded(owner, tool, cwd),
    turnSettled: (owner: string, error: string | undefined, limit?: { resetsAt?: number }) => settlement.settled(owner, error, limit),
  };
  const turnEvents = new TurnEvents(eventServices);
  const events: PiHostComponents["events"] = {
    session: (event, thread, sessionId, cwd) => handleRuntimeSessionEvent(event, thread, sessionId, cwd, {
      ...eventServices,
      turns: turnEvents,
      trackedClientMessageIds: (runtime) => clientMessages.trackedIds(runtime),
      failClientMessageIfUnpersisted: (runtime, id, owner) => { clientMessages.failIfUnpersisted(runtime, id, owner); },
      correlateUserMessageStart: (runtime, message, owner) => clientMessages.correlateStart(runtime, message, owner),
      decorateUserEvent: (runtime, message) => clientMessages.decorateUserEvent(runtime, message),
      messageMappingOptions: (runtime) => projection.mapping(runtime),
      pinnedEntries: (runtime) => projection.pinnedEntries(runtime),
    }),
    backend: (id, event) => {
      const thread = threads.get(id)?.runtime;
      if (!thread) return;
      handleBackendRuntimeEvent(event, thread, {
        ...eventServices,
        turns: turnEvents,
        turnObservers,
        refreshShell: (runtime, touch) => index.refreshShell(runtime, touch),
        publishUsage: (runtime) => index.publishUsage(runtime),
        controls,
      });
    },
  };
  const backgrounds = new ThreadBackgroundWork((id) => deps.threadFor(id)?.backend.capabilities.background, (id) => {
    index.setBackground(id, publishedBackground(backgrounds.forThread(id)));
    runClock.recheck(id);
  });
  const threads: ThreadRuntimeRegistry<ThreadRuntime> = new ThreadRuntimeRegistry<ThreadRuntime>({
    maxLive: MAX_LIVE_THREADS,
    // A thread with work in flight, an open question, or nothing saved yet has
    // state that only its runtime holds; releasing it would lose that state.
    canEvict: (record) => record.runtime.state.idle
      && !extensionUi.hasOpen(record.threadId)
      && record.runtime.adapterPending === 0
      && !record.runtime.adapterStreaming
      && turnObservers.pending(record.threadId) === 0
      // A prompt still preparing leaves Pi idle, but its turn is already open.
      && !turnObservers.hasOpenTurn(record.threadId)
      // Releasing the runtime would end its background shells and monitors.
      && !backgrounds.forThread(record.threadId)?.current().length
      // An external runtime owns its transcript in the app-data store rather
      // than in Pi's message array. It is therefore safe to release once its
      // own visible projection has been persisted.
      && (record.runtime.state.hasMessages || (record.runtime.adapterMessages?.length ?? 0) > 0),
    dispose: (record) => runtimes.dispose(record.runtime),
    onDisposeTimeout: (record) => {
      runtimes.discard(record.runtime);
      deps.logForThread(record.runtime, "runtime.dispose.timeout", "30 s");
    },
  });
  /** Owns both queue admission and the epoch that guards visible activation. */
  const lifecycle = new HostLifecycleCoordinator({
    onSlow: (operation, elapsedMs) => report.log("lifecycle.slow", `${operation} · ${Math.round(elapsedMs / 100) / 10}s`),
  });
  const workbenchReload = new WorkbenchReloadCoordinator({
    runs: () => [...threads.list().map((record) => record.runtime), attachedThread]
      .filter((thread) => !thread.state.idle || thread.state.streaming || thread.adapterPending > 0 || thread.adapterStreaming)
      .map((thread) => ({ waitForIdle: () => thread.backend.waitForIdle(), abort: () => sessionControl.abort(thread) })),
    serialize: (operation) => lifecycle.run("workbench-reload", operation),
  });
  const runtimeIdleMs = options.runtimeIdleReleaseMs ?? RUNTIME_IDLE_RELEASE_MS;
  if (runtimeIdleMs > 0) {
    threads.startIdleRelease({
      idleMs: runtimeIdleMs,
      serialize: (operation) => lifecycle.run("release-idle-runtimes", operation),
      onReleased: (threadIds) => deps.log("runtime.idle.released", threadIds.map((id) => id.slice(0, 8)).join(", ")),
      onError: (error) => deps.log("runtime.idle.release-failed", deps.errorMessage(error)),
    });
  }
  // A turn that starts or ends is use, so a background thread keeps its runtime a while after.
  turnObservers.add({
    accepted: (threadId) => threads.touch(threadId),
    ended: async (threadId) => { threads.touch(threadId); },
  });
  /** What extensions know about projects: name, label, nesting, all cached. */
  const projects = new ProjectFactsCache({
    onLabel: (cwd, label) => publication.publishLabel(cwd, label),
    onName: (cwd, name) => index.publishName(cwd, name),
    onNesting: (cwd) => {
      index.publishSnapshotSoon();
      // Older builds saved worktrees as projects; they filled the 24 slots. A missing folder stays: its drive may be unmounted.
      if (!projects.isRoot(cwd)) void projects.owner(cwd).then((owner) => { if (owner !== cwd) deps.projectHistory.forget(cwd); });
    },
    recordBackground: (name, startedAt) => deps.recordBackground(name, startedAt),
    log: (label, detail) => deps.log(label, detail),
    errorMessage: (error) => deps.errorMessage(error),
  });
  /** Whether a runtime may start work in a folder (ADR 0033). */
  const runtimeGate = new RuntimeGate({
    config: (path) => defaultHostConfigManager.readSync(path),
    owner: (cwd) => projects.owner(cwd),
    label: (kind) => kind === "pi" ? "Pi" : seam.backends.get(kind)?.label ?? kind,
    projectName: (path) => projects.name(path),
    projectPaths: () => deps.projectHistory.list().map((project) => project.path),
  });
  /** The runtime spelling of a prompt, and the proof that a caller may execute it. */
  const prompts = new PromptPreparation({
    requireBackend: (kind) => deps.requireBackend(kind),
    permissionLevel: (sessionId) => seam.permissionLevel(sessionId),
    runtimeGate,
    ownedByPi: (thread) => deps.ownedByPi(thread),
  });
  /** The Pi sessions this host writes; every write to a session file goes through them. */
  const sessionLocks = new SessionLocks(options.dataFolder ? { dataFolder: options.dataFolder } : {});
  const trash = new ThreadTrash({
    backend: (kind) => seam.backends.get(kind),
    threadDeleted: (sessionId, cwd) => lifecycle.run("purge-thread", () => threadLifecycle.threadDeleted(sessionId, cwd)),
    log: (label, detail) => deps.log(label, detail),
    holdSession: (path, action, work) => sessionLocks.hold(path, action, work),
  }, {
    // Without a userData folder (tests), a trash of this run only.
    dir: options.threadTrashDir ?? join(tmpdir(), `tau-thread-trash-${randomBytes(6).toString("hex")}`),
    ...(options.logger ? { logger: { warn: (message, detail) => options.logger!.warn(message, detail) } } : {}),
  });
  const runtimeSwitches = new RuntimeSwitches(options.dataFolder ? join(options.dataFolder, "runtime-switches.json") : undefined);
  // Images sent with a prompt are kept as files on this machine too, so its agents can use them.
  const promptImageFiles = new PromptImageFiles(join(options.dataFolder ?? join(tmpdir(), "tau-host"), "prompt-images"));
  const index = new ThreadIndex({
    canonicalSession: session => safeMode ? session : runtimeSwitches.shell(session),
    inTrash: (sessionId) => trash.has(sessionId),
    cwd: () => deps.getCwd(),
    safeMode,
    sessionsDir: sessionsDirOverride,
    projects,
    workspaces,
    projectHistory: deps.projectHistory,
    threadLifecycle,
    backends: () => seam.backends,
    liveThreads: () => threads.list().map((record) => record.runtime),
    priceUsage,
    hostThread: (thread) => deps.hostThreadFor(thread),
    emit: (event) => emit(event),
    emitUpdate: (update) => deps.emitUpdate(update),
    log: (label, detail) => deps.log(label, detail),
    fail: (error) => deps.fail(error),
    errorMessage: (error) => deps.errorMessage(error),
  }, {
    ...(options.sessionUsageCachePath ? { usageCachePath: options.sessionUsageCachePath, infoCachePath: join(dirname(options.sessionUsageCachePath), "session-info-cache.json") } : {}),
    ...(options.sessionLineageCachePath ? {
      lineageCachePath: options.sessionLineageCachePath,
      parentLinksPath: join(dirname(options.sessionLineageCachePath), "thread-parents.json"),
      legacyParentLinksPath: join(kitStateDir, "tau.agents", "agents-links.json"),
    } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const extensionUi = new ExtensionUiCoordinator(
    (thread, event) => deps.emitForThread(thread, event),
    (thread, label, detail) => thread ? deps.logForThread(thread, label, detail) : deps.log(label, detail),
  );
  let backendsChangePending = false;
  /** The one place the components hand their collaborators what they may ask of the host. */
  const port: AttachedSessionPort & ExtensionServicesPort = {
    background: backgrounds,
    safeMode,
    platform,
    stateDir: kitStateDir,
    clientTurns,
    // An attached Pi terminal publishes its own questions; the coordinator lists them for reconnecting clients.
    emit: (event) => { extensionUi.observe(event); emit(event); },
    emitUpdate: (update) => deps.emitUpdate(update),
    log: (label, detail) => deps.log(label, detail),
    errorMessage: (error) => deps.errorMessage(error),
    fail: (error) => deps.fail(error),
    beginActivation: () => lifecycle.beginActivation(),
    isCurrentActivation: (epoch) => lifecycle.isCurrentActivation(epoch),
    releaseLocalThread: async (sessionFile) => {
      const local = runtimes.liveForPath(sessionFile);
      if (local) await threads.release(local.threadId);
    },
    clearActiveThread: () => threads.setActive(undefined),
    cwd: () => deps.getCwd(),
    setCwd: (cwd) => deps.setCwd(cwd),
    onSessionEvent: (event, threadId) => events.session(event, attachedThread, threadId, deps.getCwd()),
    snapshot: () => publication.snapshot(),
    detailForSnapshot: (snapshot, requestId) => publication.detailForSnapshot(snapshot, requestId),
    lifecycleUpdates: (snapshot) => publication.lifecycleUpdates(snapshot),
    refreshActiveThreadShell: () => deps.refreshActiveThreadShell(),
    openWorkspace: (path) => deps.setWorkspace(path),
    knownWorkspacePath: (path) => deps.knownWorkspacePath(path),
    workspaceRef: (path) => workspaces.ref(path),
    admitWorkspace: (path) => deps.admitWorkspace(path),
    projectName: (cwd) => projects.loadName(cwd),
    rememberProjectName: (cwd, name) => { projects.rememberName(cwd, name); },
    runtimeTools: (action, input) => {
      if (!toolUpdates) return Promise.reject(new Error("Agent tools are not ready."));
      return toolUpdates.act(action, input);
    },
    runtimeOwner: () => deps.ownedByPi(deps.getActive()) ? "pi" : "tau",
    thread: (sessionId) => deps.hostThread(sessionId),
    reopenThread: async (sessionId) => { await runtimes.reopen(sessionId); return deps.hostThread(sessionId); },
    complete: (request, model) => completions.complete(request, model),
    completionModels: () => completions.models(),
    runtimeChoices: (cwd, kind) => runtimeChoices({
      runtimeBackends: () => publication.runtimeBackends(),
      runtimeCatalogs: () => catalogs.list(),
      runtimeCatalog: (backend) => catalogs.get(backend),
      runtimeBackendOwner: (backend) => { const provider = seam.backends.get(backend); return provider && runtimeBackendOwner(provider); },
      invokeHostExtension: (id, command, input) => hostExtensions.invoke(id, command, input),
    }, (backend) => runtimeGate.enabled(backend, cwd), kind),
    priceUsage: async (tallies) => {
      await pricing.ready();
      return tallies.map((tally) => pricing.price(tally));
    },
    readConfig: (cwd) => defaultHostConfigManager.read(cwd),
    modelAuth: createModelAuth({
      runtime: () => completions.modelRuntime(),
      changed: () => {
        catalogs.recheck("pi");
        publication.credentialsChanged();
      },
    }),
    // A rename may reach a released thread (another machine renaming); a generated title never reopens one.
    setThreadTitle: async (sessionId, title, source) => { await deps.applyThreadTitle(source === "renamed" ? await runtimes.reopen(sessionId) : deps.requireThread(sessionId), title, source); },
    attachedRuntime: (sessionId) => deps.ownedByPi(deps.threadFor(sessionId)) ? attached.hostRuntime : undefined,
    describeProjects: (facts) => projects.add(facts),
    noteSubprocess: () => lifecycleMetrics.countSubprocess(),
    refreshExtensionPackages: () => packages?.refresh() ?? Promise.resolve(),
    reviewExtensionPackage: (path) => packages?.review(path) ?? Promise.reject(new Error("Extension packages are off in safe mode.")),
    approveExtensionPackage: (path, fingerprint, owner) => packages?.approve(path, fingerprint, owner) ?? Promise.reject(new Error("Extension packages are off in safe mode.")),
    startOwnExtensionPackage: (path, fingerprint, level, threadId) => packages?.startOwn(path, fingerprint, level, threadId) ?? Promise.reject(new Error("Extension packages are off in safe mode.")),
    stopExtensionPackage: (id, owner) => packages?.stop(id, owner) ?? Promise.reject(new Error("Extension packages are off in safe mode.")),
    recordOwnExtensionPackage: (made) => recordOwnPackage(ownPackagesFilePath(options.grantsFilePath), made),
    prepareThread: (session, manager, prepareOptions) => deps.prepareThread(session, manager, prepareOptions),
    startThread: (startOptions) => deps.startThread(startOptions),
    switchThreadRuntime: (id, kind) => deps.switchThreadRuntime?.(id, kind) ?? Promise.reject(new Error("Runtime switching is unavailable.")),
    importThread: async (request) => {
      const imported = await importSessionFile(request, {
        sessionsDir: sessionsDirOverride,
        holdSession: (path, work) => sessionLocks.hold(path, "import", work),
      });
      deps.log("thread.imported", `${imported.sessionId.slice(0, 8)} · from ${request.origin.hostId}`);
      await index.refresh("changes");
      return imported;
    },
    removeThread: (sessionId) => deps.removeThread(sessionId),
    restoreThread: (sessionId) => deps.restoreThread(sessionId),
    purgeThread: (sessionId) => deps.purgeThread(sessionId),
    sendToThread: async (sessionId, text, sendOptions) => {
      // A wake steers into a running turn unless the user wants wakes queued; a held queue keeps it.
      const { wake } = sendOptions;
      if (wake && wake.source !== "background" && sendOptions.delivery === "queue" && (defaultHostConfigManager.readSync(deps.getCwd()).threads?.wakeDelivery ?? "steer") === "steer" && deps.hostThread(sessionId)?.isIdle() === false && !queue.isHeld(sessionId)) {
        try { return await deps.sendToThread(sessionId, markWake(text, wake).text, "steer", sendOptions.from, sendOptions.attachments); } catch { /* the turn ended meanwhile: queue it */ }
      }
      return deps.sendToThread(sessionId, text, sendOptions.delivery, sendOptions.from, sendOptions.attachments, wake, sendOptions.identity);
    },
    setThreadModel: async (sessionId, provider, id) => {
      const thread = await runtimes.reopen(sessionId);
      await requireCapability(thread.backend, "catalogWrite").setModel(provider, id);
      if (threads.get(thread.threadId)?.runtime === thread) await index.publishModelProvider(thread);
      if (thread === deps.getActive()) await publication.publishActiveCatalog();
      deps.log("model.changed", `${provider}/${id}`);
    },
    abortThread: async (sessionId) => {
      const thread = deps.threadFor(sessionId);
      if (thread && sessionId) await controls.stop(thread);
    },
    trashedThreads: async () => { await trash.load(); return trash.list(); },
    sessionLocks,
    clients,
    ...(options.browserResources ? { browserResources: options.browserResources } : {}),
    ...(options.network ? { network: options.network } : {}),
    ...(options.machines ? { machines: options.machines } : {}),
    ...(options.blobs ? { blobs: options.blobs } : {}),
    exclusive: (work) => lifecycle.run("extension.exclusive", work),
    refreshThreadIndex: async (refreshOptions) => {
      const snapshot = await index.refresh(refreshOptions?.publish ? "changed-index" : "none").catch((error: unknown) => {
        if (refreshOptions?.requireComplete) throw error;
        return index.snapshot();
      });
      if (refreshOptions?.requireComplete && (snapshot.complete !== true || snapshot.unavailableBackends?.length)) {
        throw new Error(`The thread index is incomplete${snapshot.unavailableBackends?.length ? `: ${snapshot.unavailableBackends.join(", ")}` : ""}.`);
      }
      return snapshot;
    },
    // Before the first scan the start publishes both anyway.
    runtimeBackendsChanged: () => {
      catalogs.sourcesChanged();
      if (!index.scanned || backendsChangePending) return;
      backendsChangePending = true;
      queueMicrotask(() => {
        backendsChangePending = false;
        void publication.publishActiveCatalog().catch((error: unknown) => deps.log("runtime-backends.publish-failed", deps.errorMessage(error)));
        void index.refresh("changes").catch((error: unknown) => deps.log("runtime-backends.index-failed", deps.errorMessage(error)));
      });
    },
    registerThreadLifecycle: (hook) => threadLifecycle.add(hook),
    registerTurnObserver: (observer) => turnObservers.add(observer),
    pinTranscriptEntries: () => { throw new Error("The extension seam owns transcript pins."); },
    decorateUiPrompt: (decorator) => extensionUi.addDecorator(decorator),
    confirmInThread: async (threadId, title, message, signal) => {
      if (signal.aborted) return false;
      const id = `mcp-${randomBytes(6).toString("hex")}`;
      const cancel = () => extensionUi.answer(id, { cancelled: true });
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const answer = await extensionUi.ask({ id, sessionId: threadId, kind: "confirm", title, message }, threads.get(threadId)?.runtime);
        return "confirmed" in answer && answer.confirmed;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  };
  const seam = createHostExtensionSeam(port);
  // Register before a runtime connects, and resolve its capability only at call time.
  const backgroundAvailable = (session: RuntimeSessionInfo) => backgrounds.available || session.nativeCapabilities?.includes("background-work") || Boolean(backgrounds.forThread(session.sessionId));
  seam.services.mcp.registerTools((session) => backgroundAvailable(session) ? [backgroundWorkTool(() => backgrounds.forThread(session.sessionId))] : []);
  seam.services.mcp.registerInstructions?.((session) => backgroundAvailable(session) ? BACKGROUND_WORK_INSTRUCTIONS : undefined);
  if (!safeMode) seam.services.registerRuntimeExtension("tau-background-work", (pi, session) => {
    if (!backgroundAvailable(session)) return;
    pi.registerTool(backgroundWorkTool(() => backgrounds.forThread(session.sessionId)));
    pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${BACKGROUND_WORK_INSTRUCTIONS}` }));
  });
  const preparation = new HostPreparationQueue(() => index.scanned && !lifecycle.currentOperation
    && !threads.list().some(({ runtime }) => runtime && (runtime.state.streaming || runtime.adapterStreaming || runtime.adapterPending > 0
      || runtime.compactionPending || runtime.pendingClientMessageIds.length > 0 || runtime.inFlightClientMessageIds.size > 0
      || turnsInFlight.get(runtime.threadId)?.writer?.pid === process.pid)));
  const catalogs = runtimeCatalogs(options, deps, completions, piAdapter, () => seam.backends.values(), emit, (kind) => void publication.recheckVersion(kind), preparation);
  // `disabledExtensions` is the one list every client follows; the host's halves follow it too.
  const hostExtensions = new HostExtensionRegistry(seam.services, (event) => emit(event), {
    disabled: () => {
      const list: unknown = defaultHostConfigManager.readSync(deps.getCwd()).disabledExtensions;
      return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
    },
  });
  seam.services.observeConfigChanges((change) => {
    if (change.kind !== "config") return;
    void hostExtensions.followChoices().catch((error: unknown) => deps.log("host-extension.follow.failed", error instanceof Error ? error.message : String(error)));
  });
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
    ...(platform.confirmExtensionGrant ? { confirmGrant: (pkg) => platform.confirmExtensionGrant!(pkg) } : {}),
    ...(options.grantsFilePath ? { grantsFilePath: options.grantsFilePath } : {}),
    // A thread that is gone no longer vouches for the package it built.
    threadLevel: (threadId) => deps.hostThread(threadId) ? seam.permissionLevel(threadId) : undefined,
  });
  const attached = new AttachedThreadBackend(createAttachedSessionHost(port));
  const attachedThread = new ThreadRuntime(attached);
  const projection = new ThreadProjection(
    clientTurns,
    () => attached.session.snapshot,
    seam.entryPins,
    (thread) => deps.hostThreadFor(thread),
    (error) => deps.log("host-extension.pins.failed", deps.errorMessage(error)),
    deps.persistedTranscripts,
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
    onSessionEvent: (event, runtime, threadId, eventCwd) => events.session(event, runtime, threadId, eventCwd),
    emitForThread: (thread, event) => deps.emitForThread(thread, event),
    presentUi: (method, ...args) => deps.presentUi(method, ...args),
    setWindowTitle: (title) => deps.setWindowTitle(title),
    publishActiveCatalog: () => publication.publishActiveCatalog(),
    recordBackground: (name, startedAt) => deps.recordBackground(name, startedAt),
    logPhase: (phase, startedAt, reason, phaseCwd, thread) => deps.logPhase(phase, startedAt, reason, phaseCwd, undefined, thread),
    log: (label, detail) => deps.log(label, detail),
    logForThread: (thread, label, detail) => deps.logForThread(thread, label, detail),
    fail: (error, sessionId, thread) => deps.fail(error, sessionId, thread),
    errorMessage: (error) => deps.errorMessage(error),
    discard: (thread) => {
      runtimes.discard(thread);
      if (threads.get(thread.threadId)?.runtime === thread) {
        void threads.release(thread.threadId).catch((error: unknown) => deps.logForThread(thread, "runtime.dispose.failed", deps.errorMessage(error)));
      }
    },
  });
  const runtimes: ThreadRuntimeLifecycle = new ThreadRuntimeLifecycle({
    decorateBackend: backend => runtimeSwitches.wrap(promptImageFiles.wrap(backend)),
    canonicalPath: path => safeMode ? undefined : runtimeSwitches.canonicalPath(path),
    safeMode,
    agentDir: getAgentDir(),
    cwd: () => deps.getCwd(),
    activeSessionFile: () => deps.getActive()?.sessionFile,
    adapterFor: (kind) => deps.adapterFor(kind),
    requireBackend: (kind) => deps.requireBackend(kind),
    permissionLevel: (sessionId) => seam.permissionLevel(sessionId),
    sessionFile: (manager) => seam.sessionFile(manager),
    runtimeExtensions: (settingsManager, session) => deps.runtimeExtensionsFor(settingsManager, session),
    runtimeExtensionNames: () => seam.runtimeExtensions.map((entry) => entry.name),
    replacedPiPackages: () => seam.runtimeExtensions.flatMap((entry) => entry.replacesPiPackage ?? []),
    runtimeModes: () => runtimeExtensionModes(seam.runtimeExtensions),
    priceUsage,
    executionPolicy: (cwd) => seam.executionPolicy(cwd),
    threadLifecycle,
    turnObservers,
    clientTurns,
    extensionUi,
    projection,
    projects,
    binding,
    lifecycleMetrics,
    adopt: (thread) => threads.adopt({ threadId: thread.threadId, cwd: thread.cwd, runtime: thread, isolation: "in-process" }),
    currentRuntime: (threadId) => threads.get(threadId)?.runtime,
    liveThreads: () => threads.list().map((record) => record.runtime),
    indexedSession: (path) => index.byPath(path),
    findSession: (sessionId) => index.find(sessionId),
    presentUi: (method, ...args) => deps.presentUi(method, ...args),
    releaseTool: (toolCallId) => turnEvents.releaseTool(toolCallId),
    emitMessage: (threadId, message) => emit(message.role === "user"
      ? { type: "user-message", sessionId: threadId, message }
      : { type: "assistant-end", sessionId: threadId, message }),
    emitRuntimeEvent: (threadId, event) => events.backend(threadId, event),
    logRuntimePhase: (phase, startedAt, reason, phaseCwd) => deps.logRuntimePhase(phase, startedAt, reason, phaseCwd),
    log: (label, detail) => deps.log(label, detail),
    errorMessage: (error) => deps.errorMessage(error),
    runtimeUnavailable: (threadId, reason) => index.setRuntimeError(threadId, reason),
    sessionLocks,
  });
  const publication = new HostPublication({
    index,
    workspaces,
    metrics: lifecycleMetrics,
    emitUpdate: (update) => deps.emitUpdate(update),
    view: { active: () => deps.getActive(), cwd: () => deps.getCwd(), extensionCount: () => deps.extensionCount() },
    projection,
    projects,
    completions,
    modelsKey: (cwd) => runtimes.fingerprint(cwd),
    backends: () => seam.backends.values(),
    piModes: () => runtimeExtensionModes(seam.runtimeExtensions),
    defaultBackendKind,
    isCurrentActivation: (epoch) => lifecycle.isCurrentActivation(epoch),
    log: (label, detail) => deps.log(label, detail),
    errorMessage: (error) => deps.errorMessage(error),
    fail: (error, sessionId) => deps.fail(error, sessionId),
    runs: () => runClock.runs(),
    toolUpdates: (kind) => toolUpdates?.updatesFor(kind),
    runtimeInUse: (kind) => runtimeGate.inUse(kind),
    prepareToolUpdates: async (kind) => { await toolUpdates?.ensure(kind); },
  });
  let refreshModelCatalog: (() => Promise<void>) | undefined;
  toolUpdates = new RuntimeToolUpdates({
    backends: () => seam.backends.values(),
    inUse: (kind) => runtimeGate.inUse(kind),
    busy: () => new Set(Object.keys(runClock.runs()).map((threadId) => index.byId(threadId)?.backendKind ?? "pi")),
    recheck: async (kind) => { await Promise.all([publication.recheckVersion(kind), catalogs.recheck(kind)]); },
    changed: () => void publication.publishActiveCatalog().catch(() => undefined),
    ...(options.runtimeCatalogsPath ? { file: join(dirname(options.runtimeCatalogsPath), "runtime-tool-updates.json") } : {}),
    refresh: async () => {
      await refreshModelCatalog?.();
      const kinds = ["pi", ...[...seam.backends.values()].map((provider) => provider.kind)];
      await Promise.all(kinds.map((kind) => Promise.all([publication.recheckVersion(kind), catalogs.recheck(kind)])));
    },
    automatic: options.warmRuntimeCatalogs === true,
    safeMode,
    log: (label, detail) => deps.log(label, detail),
  });
  if (options.warmRuntimeCatalogs === true && options.runtimeCatalogsPath && !safeMode) {
    refreshModelCatalog = followModelCatalog(join(dirname(options.runtimeCatalogsPath), "model-catalog.json"), getAgentDir(), (label, detail) => deps.log(label, detail), () => {
      publication.credentialsChanged();
      void catalogs.recheck("pi");
    });
  }
  const hostConfig = defaultHostConfigManager.readSync(deps.getCwd());
  /**
   * Edits to a package, a theme, the keybindings or the config take effect
   * where they are read, not after a reload. Safe mode watches nothing: it
   * exists so a broken extension cannot load at all.
   */
  const watch = safeMode || !watchingEnabled({}) ? undefined : new WorkspaceWatch({
    cwd: () => deps.getCwd(),
    enabled: () => watchingEnabled(defaultHostConfigManager.readSync(deps.getCwd())),
    agentDir: getAgentDir(),
    ...(options.appPath ? { appPath: options.appPath } : {}),
    refreshPackages: (ids) => packages?.refresh({ only: ids }) ?? Promise.resolve(),
    configChanged: (change) => {
      // The host re-reads nothing for anyone: it says what moved, and the kits
      // and clients that own those files decide.
      seam.notifyConfigChange({ kind: change.kind, paths: change.paths });
      // A hand edit may have turned watching off.
      if (change.kind === "config") void watch?.retarget().catch(() => undefined);
      pricing.reloadPrices();
      emit({ type: "config-changed", kind: change.kind, paths: [...change.paths] });
    },
    log: (label, detail) => deps.log(label, detail),
  });
  const prewarmEnabled = process.env.TAU_NO_PREWARM !== "1" && hostConfig.prewarm !== false && deps.automaticPrewarm;
  const prewarm = new RuntimePrewarm({
    preparation,
    automatic: prewarmEnabled,
    safeMode,
    maxLiveThreads: MAX_LIVE_THREADS,
    cwd: () => deps.getCwd(),
    isDirectory: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false,
    sessionsDir: sessionsDirOverride,
    runtimes,
    extensionUi,
    liveThreadIds: () => new Set(threads.list().map((record) => record.threadId)),
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
  extensionUi.addDecorator((prompt) => {
    turnsInFlight.setWaitingForAnswer(prompt.sessionId, true);
    return () => turnsInFlight.setWaitingForAnswer(prompt.sessionId, extensionUi.hasOpen(prompt.sessionId));
  });
  const persistedLogger = options.logger ? { logger: { warn: (message: string, detail?: unknown) => options.logger!.warn(message, detail) } } : {};
  const queue = new QueuedMessages({
    busy: (sessionId) => {
      const thread = deps.threadFor(sessionId);
      // Runtime idle also includes native children. They must not keep a
      // settled parent's next turn, including background results, in the queue.
      if (thread && (thread.compactionPending || thread.state.streaming || thread.adapterStreaming || thread.adapterPending > 0 || extensionUi.hasOpen(sessionId))) return true;
      // A thread waiting for its limit's scheduled resume keeps what is queued until then: sent now, it would hit the limit again.
      return limits.awaitsResume(sessionId);
    },
    waitForIdle: async (sessionId) => { await deps.threadFor(sessionId)?.backend.waitForIdle(); },
    admit: async (sessionId) => { const thread = deps.threadFor(sessionId); if (thread) await prompts.assertRuntimeOn(thread); },
    deliver: (sessionId, message) => deps.deliverQueued(sessionId, message),
    publish: (sessionId, view) => { index.setQueue(sessionId, view); runClock.recheck(sessionId); },
    delivered: (sessionId) => runClock.recheck(sessionId),
    log: (label, detail) => deps.log(label, detail),
  }, { ...(options.queuedMessagesPath ? { filePath: options.queuedMessagesPath } : {}), ...persistedLogger });
  const controls = new ThreadControls({
    background: (id) => backgrounds.forThread(id),
    queue,
    turnObservers,
    abortThread: (thread) => sessionControl.abort(thread),
    reopenThread: (sessionId) => runtimes.reopen(sessionId),
    prompt: (threadId, text) => deps.promptThread(threadId, text),
    publishDetail: async (thread) => { if (deps.getActive() === thread) await publication.publishDetail(); },
    emitForThread: (thread, event) => deps.emitForThread(thread, event),
    setGoal: (threadId, goal) => index.setGoal(threadId, goal),
    setBackground: (threadId, tasks) => { index.setBackground(threadId, tasks); runClock.recheck(threadId); },
    log: (label, detail) => deps.log(label, detail),
  });
  const limits: ThreadLimits = new ThreadLimits({
    publish: (sessionId, limit) => index.setLimit(sessionId, limit),
    resume: async (sessionId, limitedAt): Promise<void> => {
      // What the user wrote while the thread waited continues it in place of the
      // continuation prompt; follow-ups queued before the limit wait for that prompt.
      const waiting = queue.list(sessionId).filter((message) => !message.wake && message.deliverAt === undefined);
      if (limitedAt === undefined || waiting.length === 0 || waiting.some((message) => message.queuedAt <= limitedAt)) {
        return sessionControl.continue(sessionId, LIMIT_CONTINUATION_PROMPT);
      }
      queue.started(sessionId);
      await queue.pump(sessionId);
      // A refused delivery puts the message back and holds the queue again.
      if (queue.isHeld(sessionId)) throw new Error("The thread did not take the queued message.");
    },
    log: (label, detail) => deps.log(label, detail),
  }, { ...(options.threadLimitsPath ? { filePath: options.threadLimitsPath } : {}), ...persistedLogger });
  const settlement = new TurnSettlement({
    setTurnError: (sessionId, error) => index.setTurnError(sessionId, error),
    setInterrupted: (sessionId, interrupted) => index.setInterrupted(sessionId, interrupted),
    queue,
    limits,
  });
  // A released runtime ended its background work with it.
  turnObservers.add({ closed: async (sessionId) => { index.setBackground(sessionId, undefined); runClock.recheck(sessionId); } });
  // A thread gone for good takes what waited for it along.
  threadLifecycle.add({ threadDeleted: async (sessionId) => { queue.forget(sessionId); limits.forget(sessionId); await promptImageFiles.forget(sessionId); const switched = runtimeSwitches.get(sessionId); if (switched) await runtimeSwitches.set(sessionId, { ...switched, deleted: true }); } });
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
  const sessionControl: AgentSessionControl = new AgentSessionControl({
    stopped: (thread) => { events.backend(thread.threadId, { type: "turn-settled", status: "interrupted" }); turnsInFlight.clear(thread.threadId); },
    activationEpoch: () => lifecycle.currentActivationEpoch,
    extensionUi, queue, turnsInFlight, limits, prompts,
    continueAfterRestart: () => defaultHostConfigManager.readSync(deps.getCwd()).threads?.continueAfterRestart === true,
    markInterrupted: (sessionId) => index.setInterrupted(sessionId, true),
    prompt: (threadId, text, hidden) => deps.promptThread(threadId, text, hidden),
    thread: (id) => deps.requireThread(id), active: () => deps.getActive(),
    isAttached: (thread) => deps.ownedByPi(thread), pending: (id) => turnObservers.pending(id),
    hasQuestion: (id) => extensionUi.hasOpen(id), path: (id) => index.byId(id)?.path,
    publication: () => publication, runtimes: () => runtimes,
    prewarm: () => prewarm, threads: () => threads,
    activate: (thread, epoch) => deps.activateThread(thread, epoch),
    staleResult: () => deps.staleActivationResult(), cwd: () => deps.getCwd(),
    extensionCount: (count) => deps.setExtensionCount(count),
    refreshPackages: async () => { await packages?.refresh({ force: true }); },
    log: (event, detail) => deps.log(event, detail), errorMessage: (error) => deps.errorMessage(error),
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
    events,
    index,
    runtimeSwitches,
    trash,
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
    queue,
    controls,
    limits,
    settlement,
    catalogs,
    toolUpdates,
    pricing,
    sessionControl,
  };
}

/** Pi's catalog from the user's own configuration, and one per backend that can name its models before a thread. */
function runtimeCatalogs(
  options: PiHostOptions,
  deps: PiHostDeps,
  completions: HostCompletions,
  piAdapter: AgentRuntimeAdapter,
  backends: () => Iterable<HostRuntimeBackendProvider>,
  emit: Emit,
  programChanged: (kind: ThreadBackendKind) => void,
  preparation: HostPreparationQueue,
): RuntimeCatalogs {
  let book: Promise<ModelPriceBook | undefined> | undefined;
  const priceBook = () => book ??= completions.catalogData().then((data) => new ModelPriceBook(data.known, modelReleaseDate), () => {
    book = undefined;
    return undefined;
  });
  const pi: RuntimeCatalogSource = {
    kind: "pi",
    owner: completions,
    capabilities: piAdapter.capabilities,
    complete: true,
    load: async () => {
      const data = await completions.catalogData();
      return piNewThreadCatalog({ ...data, book: await priceBook() ?? new ModelPriceBook(data.known, modelReleaseDate) });
    },
  };
  return new RuntimeCatalogs({
    preparation,
    sources: () => [pi, ...sortByRuntimeOrder([...backends()]).flatMap((provider): RuntimeCatalogSource[] => provider.newThreadCatalog
      ? [{
        kind: provider.kind,
        owner: provider,
        capabilities: provider.adapter.capabilities,
        load: () => provider.newThreadCatalog!(),
        ...(provider.programKey ? { programKey: () => provider.programKey!() } : {}),
      }]
      : [])],
    priceBook,
    publish: (catalog) => emit({ type: "runtime-catalog", catalog }),
    automatic: options.warmRuntimeCatalogs === true && !deps.safeMode,
    log: (label, detail) => deps.log(label, detail),
    programChanged,
    ...(options.runtimeCatalogsPath ? { file: options.runtimeCatalogsPath } : {}),
    ...(options.logger ? { logger: { warn: (message, detail) => options.logger!.warn(message, detail) } } : {}),
  });
}

/** How long start-up has the network to itself before the catalog is fetched. */
const MODEL_CATALOG_DELAY_MS = 30_000;
const MODEL_CATALOG_EVERY_MS = 6 * 60 * 60_000;

/**
 * Tau's signed model catalog for Pi: the last good one from disk at once, a
 * newer one from the website once a day (`TAU_MODEL_CATALOG_URL` and
 * `TAU_MODEL_CATALOG_KEY` point a test host at its own; `TAU_NO_MODEL_CATALOG=1`
 * and `PI_OFFLINE` keep it off the network).
 */
function followModelCatalog(file: string, agentDir: string, log: (label: string, detail?: string) => void, changed: () => void): () => Promise<void> {
  const env = process.env;
  const url = env.TAU_MODEL_CATALOG_URL?.trim();
  const feed = new SignedModelCatalog({ file, keys: modelCatalogKeys(env, RELEASE_PUBLIC_KEYS), ...(url ? { url } : {}), log });
  void feed.load().then(() => { if (feed.current()) { useModelCatalog(feed.current(), agentDir); changed(); } });
  const offline = env.TAU_NO_MODEL_CATALOG === "1" || env.PI_OFFLINE !== undefined;
  // The Refresh button: asked now, however fresh the held one is.
  const now = async () => {
    if (offline || !await feed.refresh(true)) return;
    useModelCatalog(feed.current(), agentDir);
    changed();
  };
  if (offline) return now;
  const check = () => {
    void feed.refresh().then((newer) => {
      if (!newer) return;
      useModelCatalog(feed.current(), agentDir);
      changed();
    }).finally(() => { setTimeout(check, MODEL_CATALOG_EVERY_MS).unref?.(); });
  };
  setTimeout(check, MODEL_CATALOG_DELAY_MS).unref?.();
  return now;
}
