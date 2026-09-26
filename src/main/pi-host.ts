import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager, type SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionUiAnswer,
  HostBootstrap,
  HostEvent,
  HostExtensionSummary,
  ThreadHostEvent,
  HostSnapshot,
  PreparedThreadCapability,
  ShellActionResult,
  UiComposerCommand,
  UiModel,
  UiRuntimeCatalog,
  UiPromptAttachment,
  UiRuntimeBackend,
  SubmissionResult,
  UiSkillDraft,
  NewThreadConfiguration,
  NewThreadRequestId,
  ThreadBackendKind,
  PreparedPrompt,
  ThreadTreeNavigationResult,
  UiThreadTree,
  CustomProviderConfig,
  CustomProviderInput,
  SystemPromptInspection,
  UiToolOutputPreview,
} from "../shared/contracts.js";
import { addModelProvider, loadModelsConfig } from "./models-config.js";
import { discoverPromptOverrides } from "./system-prompt-resolver.js";
import { createNewThreadRequestId } from "../shared/contracts.js";
import type { HostCompletions } from "./host-completion.js";
import {
  HOST_PROTOCOL_VERSION,
  catalogFromSnapshot,
  type HostActionResult,
  type HostCatalog,
  type HostUpdate,
  type NewThreadResult,
  type ProjectMetadata,
  type ThreadDetail,
  type TranscriptPage,
} from "../shared/host-protocol.js";
import { formatChatTranscript } from "../shared/chat-transcript.js";
import { taskProgressHistoryFromMessages } from "../shared/task-progress.js";
import { ThreadDetailStore } from "../shared/thread-detail-store.js";
import type { HostLifecycleInstrumentation } from "./host-lifecycle.js";
import type { HostReport } from "./host-report.js";
import type { HostLifecycleCoordinator } from "./host-lifecycle-coordinator.js";
import { ThreadActivation, type VisibleThreadState } from "./thread-activation.js";
import { HOST_CORE_PRINCIPAL, type HostInvocationPrincipal } from "./host-invocation.js";
import type { HostPublication } from "./host-publication.js";
import { RuntimeResourceCache } from "./runtime-resource-cache.js";
import type { ExtensionPackageActivator } from "./extension-package-activation.js";
import type { WorkspaceWatch } from "./workspace-watch.js";
import { findDanglingToolCalls } from "./dangling-tool-calls.js";
import { reconcileInFlightTurns, type ReconcilableThread } from "./turn-reconciliation.js";
import type { TurnsInFlight } from "./turns-in-flight.js";
import type { QueuedMessage, QueuedMessages } from "./queued-messages.js";
import type { ThreadLimits } from "./thread-limits.js";
import type { TurnSettlement } from "./turn-settlement.js";
import type { ThreadRuntimeRegistry } from "./thread-runtimes.js";
import type {
  HostExtensionRegistry,
  HostThreadLifecycleSet,
  HostTurnObserverSet,
  HostExtension,
  HostPreparedThread,
  HostRuntimeBackendProvider,
  HostSessionFile,
  HostStartedThread,
  HostThread,
  HostThreadStartOptions,
  HostUiPresenter,
  HostWorkspaceCloseReason,
  RuntimeSessionInfo,
} from "./host-extensions.js";
import { runtimeBackendOwner, runtimeExtensionModes, sortByRuntimeOrder } from "./host-extensions.js";
import { ProjectHistory } from "./project-history.js";
import type { ProjectFactsCache } from "./project-facts-cache.js";
import type { ThreadIndex } from "./thread-index.js";
import type { ThreadTrash } from "./thread-trash.js";
import type { ThreadBinding } from "./thread-binding.js";
import type { SessionRuntimeExtension, ThreadRuntimeLifecycle } from "./thread-runtime-lifecycle.js";
import type { RuntimePrewarm } from "./runtime-prewarm.js";
import type { PromptPreparation } from "./prompt-preparation.js";
import type { TurnDelivery } from "./turn-delivery.js";
import type { AttachedThreadBackend } from "./attached-thread-backend.js";
import type { HostExtensionSeam } from "./host-ports.js";
import { findPiBridge } from "./pi-bridge-client.js";
import { composerCommandsForAdapter } from "./bridge-snapshot.js";
import type { LiveTurnState } from "./live-turn-state.js";
import { ThreadRuntime, isLocalPiRuntime, isPiBackend, threadBackendKind } from "./thread-runtime.js";
import { requireCapability } from "./runtime-types.js";
import { localTranscriptPage, readLocalToolOutput } from "./host-transcript.js";
import { clientTranscript } from "./client-tool-output.js";
import { PersistedThreadTranscript, shellTranscriptPage } from "./persisted-transcript.js";
import { handleRuntimeSessionEvent } from "./session-events.js";
import { handleBackendRuntimeEvent } from "./backend-events.js";
import { isUnavailableBackend } from "./unavailable-thread-backend.js";
import { isSessionHeldElsewhere } from "./session-locks.js";
import type { ThreadRuntimeEvent } from "./runtime-types.js";
import type { ClientMessageTracker } from "./client-message-tracker.js";
import type { ThreadProjection } from "./thread-projection.js";
import type { ExtensionUiCoordinator } from "./extension-ui-coordinator.js";
import type { PiHostOptions } from "./pi-host-options.js";
import { buildPiHostComponents, type PiHostComponents } from "./pi-host-components.js";
import { RuntimeVersions } from "./runtime-versions.js";
import { PhaseTimer, promptRebindForThread, clientIdentityForRequest, externalThreadFromPath, externalThreadPath, findKnownWorkspacePath, processIsAlive, samePath, type ClientTurnRequest } from "./pi-host-support.js";
export type { PiHostOptions } from "./pi-host-options.js";
export { workspaceLabel } from "./pi-host-support.js";
import type { WorkspaceIdentity } from "./workspace-identity.js";
import type { WorkspaceRef } from "../shared/workspace-identity.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import type { ClientTurnLedger } from "./client-turn-ledger.js";
import { skillMessagePresentation } from "./skill-invocation.js";
import type { WorkbenchReloadCoordinator } from "./workbench-reload-coordinator.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import {
  textFromContent,
  turnActivityHistoryFromMessages,
  firstSentence,
  visibleTitleText,
  safeSessionTitle,
  boundedToolOutput,
} from "./host-messages.js";
type Emit = (event: HostEvent) => void;
interface PromptPreflightResult {
  accepted: boolean;
  error?: unknown;
}
type PromptPreflight = (result: PromptPreflightResult) => void;
type PromptPreflightState = "pending" | "accepted" | "rejected";

export class PiHost {
  private currentCwd: string;
  /** The open workspace. Writing it re-points whatever follows the project's own files. */
  private get cwd(): string { return this.currentCwd; }
  private set cwd(value: string) {
    if (value === this.currentCwd) return;
    this.currentCwd = value;
    void this.watch?.retarget().catch((error: unknown) => this.log("watch.retarget.failed", this.errorMessage(error)));
  }
  /** Pi is the built-in backend; every other kind comes from a registered provider. */
  private readonly piAdapter: AgentRuntimeAdapter;
  private readonly defaultBackendKind: ThreadBackendKind;
  private readonly runtimeCommands: readonly UiComposerCommand[];
  private emit: Emit;
  /** Correlates raw Pi user-message events with renderer sends. */
  private readonly clientTurns: ClientTurnLedger;
  private readonly clientMessages: ClientMessageTracker;
  private readonly projection: ThreadProjection;
  private readonly extensionUi: ExtensionUiCoordinator;
  /**
   * The thread a Pi terminal owns while Tau follows it, and its runtime record.
   * That record lives beside the registry, because Pi owns it and Tau does not.
   */
  private readonly attached: AttachedThreadBackend;
  private readonly attachedThread: ThreadRuntime;
  private readonly agentDir: string;
  /** PI_CODING_AGENT_SESSION_DIR, resolved once; undefined keeps Pi's own default sessions layout. */
  private readonly sessionsDirOverride: string | undefined;
  private extensionCount = 0;
  private readonly completions: HostCompletions;
  private completionModels?: UiModel[];
  private completionModelsPending = false;
  private readonly runtimeVersions: RuntimeVersions;
  private readonly catalogs: PiHostComponents["catalogs"];
  private readonly pricing: PiHostComponents["pricing"];
  private readonly lifecycleMetrics: HostLifecycleInstrumentation;
  /** Everything host extensions contribute; only the seam writes those registries. */
  private readonly seam: HostExtensionSeam;
  private readonly hostExtensions: HostExtensionRegistry;
  /** Resolved on the first activation when it arrived as a thunk. */
  private pendingHostExtensions: readonly HostExtension[] | (() => Promise<readonly HostExtension[]>);

  /** The unresolved form of the above, so the kits Tau ships can be read again. */
  private readonly hostExtensionSource: readonly HostExtension[] | (() => Promise<readonly HostExtension[]>);
  /** The host halves of installed packages; absent in safe mode, where no package loads. */
  private readonly packages?: ExtensionPackageActivator;
  /** Follows the files the host reads, so an edit needs no reload; absent when watching is off. */
  private readonly watch?: WorkspaceWatch;
  /** Mints and resolves the ids clients name workspaces by. */
  private readonly workspaces: WorkspaceIdentity;
  /** Folders a host extension made for a thread that does not exist yet (a worktree). */
  private readonly admittedWorkspaces = new Set<string>();
  private readonly report: HostReport;
  private readonly modelCatalogCache = new RuntimeResourceCache<UiModel[]>({ maxEntries: 8, ttlMs: 5 * 60_000 });
  private readonly threads: ThreadRuntimeRegistry<ThreadRuntime>;
  private preparedThreadCapabilityGeneration = 0;
  /** Serialises thread lifecycle work; reentrant, so a hook of one operation cannot wait for it. */
  private readonly lifecycle: HostLifecycleCoordinator;
  private readonly workbenchReload: WorkbenchReloadCoordinator;
  private readonly activation: ThreadActivation;
  /** CAS token for the visible pointer; stale rollback may not win after a newer promotion. */
  private visibleActivationGeneration = 0;
  /** Compatibility read for the existing activation call sites; ownership lives in the coordinator. */
  private get activationEpoch(): number { return this.lifecycle.currentActivationEpoch; }
  private readonly publication: HostPublication;
  get detailStore(): ThreadDetailStore { return this.publication.detailStore; }
  private projectLabel?: string;
  /** What extensions know about projects: name, label, nesting, all cached. */
  private readonly projects: ProjectFactsCache;
  /** Every persisted thread, the shell it is drawn as, and the publication of both. */
  private readonly index: ThreadIndex;
  /** Deleted threads, restorable until their retention runs out. */
  private readonly trash: ThreadTrash;
  /** Tau's dialog surface inside a runtime's extensions, and the events it lets through. */
  private readonly binding: ThreadBinding;
  /** A thread's runtime from build to teardown. */
  private readonly runtimes: ThreadRuntimeLifecycle;
  /** Runtimes built before anyone asks for them: the spare, and the neighbours of the thread on screen. */
  private readonly prewarm: RuntimePrewarm;
  /** The runtime spelling of a prompt, and the proof that a caller may execute it. */
  private readonly prompts: PromptPreparation;
  /** Steering, follow-up, and every turn of a runtime that keeps no host journal. */
  private readonly turns: TurnDelivery;

  private readonly turnsInFlight: TurnsInFlight;
  /** The composer's queue and the limit marks, kept by the host so both outlive a restart. */
  readonly queue: QueuedMessages;
  readonly limits: ThreadLimits;
  private readonly settlement: TurnSettlement;

  private readonly continueThreadsAfterRestart: () => boolean;
  /** The last title a Pi extension gave the window, for a client that attaches later. */
  private windowTitle?: string;
  private readonly toolOwners: Map<string, string>;
  /** Extensions stepping into thread opening, forking, activation and the index sweep. */
  private readonly threadLifecycle: HostThreadLifecycleSet;
  private readonly turnObservers: HostTurnObserverSet;
  constructor(
    cwd: string,
    emit: Emit,
    private readonly projectHistory: ProjectHistory,
    private readonly safeMode = false,
    private readonly automaticPrewarm = true,
    options: PiHostOptions = {},
  ) {
    this.currentCwd = cwd;
    const components = buildPiHostComponents(options, {
      getCwd: () => this.cwd,
      setCwd: (value) => { this.cwd = value; },
      safeMode: this.safeMode,
      automaticPrewarm: this.automaticPrewarm,
      projectHistory: this.projectHistory,
      emit: (event) => emit(event),
      emitUpdate: (update) => this.emitUpdate(update),
      emitForThread: (thread, event) => this.emitForThread(thread, event),
      log: (label, detail) => this.log(label, detail),
      logForThread: (thread, label, detail) => this.logForThread(thread, label, detail),
      fail: (error, sessionId, thread) => this.fail(error, sessionId, thread),
      errorMessage: (error) => this.errorMessage(error),
      logPhase: (phase, startedAt, reason, phaseCwd, note, thread) => this.logPhaseEvent(phase, startedAt, reason, phaseCwd, note, thread),
      logRuntimePhase: (phase, startedAt, reason, phaseCwd) => this.logRuntimePhase(phase, startedAt, reason, phaseCwd),
      recordBackground: (name, startedAt) => this.recordBackgroundLifecycle(name, startedAt),
      publishActiveCatalog: () => this.publishActiveCatalog(),
      publishLabel: (labelCwd, label) => this.publishLabel(labelCwd, label),
      setWindowTitle: (title) => this.publishWindowTitle(title),
      windowTitle: () => this.windowTitle,
      abortThread: (thread) => this.abortThread(thread),
      adoptThread: (thread) => this.adoptThread(thread),
      applyThreadTitle: (thread, title, source) => this.applyThreadTitle(thread, title, source),
      prewarmSession: (path) => this.prewarmSession(path),
      handleSessionEvent: (event, thread, sessionId, eventCwd) => this.handleSessionEvent(event, thread, sessionId, eventCwd),
      handleBackendEvent: (threadId, event) => this.handleBackendEvent(threadId, event),
      presentUi: (method, ...args) => this.presentUi(method, ...args),
      hostThreadFor: (thread) => this.hostThreadFor(thread),
      hostThread: (sessionId) => this.hostThread(sessionId),
      threadFor: (sessionId) => this.threadFor(sessionId),
      requireThread: (sessionId) => this.requireThread(sessionId),
      requireBackend: (kind) => this.requireBackend(kind),
      adapterFor: (kind) => this.adapterFor(kind),
      runtimeExtensionsFor: (settingsManager, session) => this.runtimeExtensionsFor(settingsManager, session),
      getActive: () => this.active,
      hasLocalActive: () => Boolean(this.localActive),
      ownedByPi: (thread) => this.ownedByPi(thread),
      liveThreadForPath: (path) => this.liveThreadForPath(path),
      liveThreadIds: () => this.liveThreadIds(),
      snapshot: () => this.snapshot(),
      detailForSnapshot: (snapshot, requestId) => this.detailForSnapshot(snapshot, requestId),
      lifecycleUpdates: (snapshot, requestId) => this.lifecycleUpdates(snapshot, requestId),
      refreshActiveThreadShell: () => this.refreshActiveThreadIndex(false),
      setWorkspace: (path) => this.setWorkspace(path),
      knownWorkspacePath: (path) => this.knownWorkspacePath(path),
      admitWorkspace: (path) => this.admitWorkspace(path),
      prepareThread: (session, manager, prepareOptions) => this.prepareThread(session, manager, prepareOptions),
      startThread: (startOptions) => this.startThread(startOptions),
      removeThread: (sessionId) => this.removeThread(sessionId),
      restoreThread: (sessionId) => this.restoreThread(sessionId),
      purgeThread: (sessionId) => this.purgeThread(sessionId),
      pendingHostExtensions: () => this.pendingHostExtensions,
      deliverQueued: (sessionId, message) => this.deliverQueued(sessionId, message),
      sendToThread: (sessionId, text, delivery, from) => this.sendToThread(sessionId, text, delivery, from),
      continueThread: async (sessionId, text) => {
        const thread = await this.reopenThread(sessionId);
        await this.prompt(text, [], thread.threadId, undefined, undefined, { hidden: thread.backend.capabilities.resume?.hiddenPrompt === true });
      },
      modelCredentialsChanged: () => {
        this.modelCatalogCache.invalidate();
        this.completionModels = undefined;
        this.completionModelsPending = false;
        this.ensureCompletionModels();
      },
    });
    this.agentDir = components.agentDir;
    this.sessionsDirOverride = components.sessionsDirOverride;
    this.completions = components.completions;
    this.piAdapter = components.piAdapter;
    this.defaultBackendKind = components.defaultBackendKind;
    this.runtimeCommands = components.runtimeCommands;
    this.pendingHostExtensions = this.safeMode ? [] : options.hostExtensions ?? [];
    this.hostExtensionSource = this.pendingHostExtensions;
    this.workspaces = components.workspaces;
    this.report = components.report;
    this.clientTurns = components.clientTurns;
    this.lifecycleMetrics = components.lifecycleMetrics;
    this.threads = components.threads;
    this.lifecycle = components.lifecycle;
    this.workbenchReload = components.workbenchReload;
    this.projects = components.projects;
    this.index = components.index;
    this.trash = components.trash;
    this.publication = components.publication;
    this.seam = components.seam;
    this.runtimeVersions = new RuntimeVersions({
      providers: () => this.seam.backends.values(),
      onChange: () => void this.publishActiveCatalog().catch(() => undefined),
      log: (label, detail) => this.log(label, detail),
    });
    this.hostExtensions = components.hostExtensions;
    this.packages = components.packages;
    this.watch = components.watch;
    this.attached = components.attached;
    this.attachedThread = components.attachedThread;
    this.projection = components.projection;
    this.extensionUi = components.extensionUi;
    this.clientMessages = components.clientMessages;
    this.binding = components.binding;
    this.runtimes = components.runtimes;
    this.prewarm = components.prewarm;
    this.prompts = components.prompts;
    this.turns = components.turns;
    this.turnsInFlight = components.turnsInFlight;
    ({ queue: this.queue, limits: this.limits, settlement: this.settlement, catalogs: this.catalogs, pricing: this.pricing } = components);
    this.continueThreadsAfterRestart = components.continueThreadsAfterRestart;
    this.threadLifecycle = components.threadLifecycle;
    this.turnObservers = components.turnObservers;
    this.toolOwners = components.toolOwners;
    this.emit = components.emit;
    this.activation = new ThreadActivation({
      assertHostOwned: (thread) => {
        if (thread === this.attachedThread) throw new Error("The attached Pi runtime cannot be activated as a host thread.");
        const existing = this.threads.get(thread.threadId)?.runtime;
        if (existing && existing !== thread) throw new Error("A different runtime already owns this thread.");
      },
      isCurrentRuntime: (thread) => this.threads.get(thread.threadId)?.runtime === thread,
      beforeActivate: (thread) => this.threadLifecycle.beforeActivate(this.hostThreadFor(thread)),
      adopt: async (thread) => {
        // A live runtime is normally already registered. Keep the old
        // activation behavior for that path, while refusing to silently
        // replace a different runtime with the same thread id.
        const existing = this.threads.get(thread.threadId)?.runtime;
        if (existing && existing !== thread) throw new Error("A different runtime already owns this thread.");
        if (!existing) await this.adoptThread(thread);
      },
      captureVisibleState: (): VisibleThreadState => ({
        active: this.localActive,
        cwd: this.cwd,
        extensionCount: this.extensionCount,
      }),
      setVisible: (thread, generation) => {
        this.visibleActivationGeneration = generation;
        this.threads.setActive(thread.threadId);
        this.cwd = thread.cwd;
        this.extensionCount = thread.state.extensionCount;
      },
      restoreVisibleState: (state, expected, generation) => {
        // A concurrent live fast-path may already have won the screen. Its
        // pointer must not be overwritten by this stale transaction.
        if (this.visibleActivationGeneration !== generation || this.threads.active?.runtime !== expected) return;
        this.threads.setActive(state.active?.threadId);
        this.cwd = state.cwd;
        this.extensionCount = state.extensionCount;
        this.visibleActivationGeneration = generation + 1;
      },
      rememberProject: (projectCwd) => this.rememberProject(projectCwd),
      refreshShell: (thread, touch) => this.index.refreshShell(thread, touch),
      publishVisible: (thread) => {
        this.log("session.opened", thread.threadId.slice(0, 8));
        this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "project", project: this.projectMetadata(thread.cwd), sessionId: thread.threadId });
        this.prewarm.scheduleThreads();
        if (this.defaultBackendKind === "pi") this.prewarm.scheduleSpare(thread.cwd);
      },
    });
  }
  /** Offers a ctx.ui drawing to every presenter; false when none handles that surface. */
  private presentUi<K extends keyof HostUiPresenter>(method: K, ...args: Parameters<NonNullable<HostUiPresenter[K]>>): boolean {
    let handled = false;
    for (const presenter of this.seam.uiPresenters) {
      const draw = presenter[method] as ((...params: typeof args) => void) | undefined;
      if (!draw) continue;
      try { draw.apply(presenter, args); } catch (error) { this.log("extension-ui.presenter-failed", `${method}: ${this.errorMessage(error)}`); }
      handled = true;
    }
    return handled;
  }

  private hostThread(sessionId?: string): HostThread | undefined {
    const thread = this.threadFor(sessionId);
    // A thread Pi's terminal owns answers through its own runtime, not as a host thread.
    return thread && !this.ownedByPi(thread) ? this.hostThreadFor(thread) : undefined;
  }

  private hostThreadFor(thread: ThreadRuntime): HostThread {
    const parentThreadId = () => this.index.parentOf(thread.threadId);
    return {
      sessionId: thread.threadId, cwd: thread.cwd, backendKind: thread.backend.kind,
      get sessionFile() { return thread.sessionFile; },
      get parentThreadId() { return parentThreadId(); },
      get usage() { return thread.backend.catalogView().usage; },
      get model() { const model = thread.backend.catalogView().model; return model && { provider: model.provider, id: model.id }; },
      isStreaming: () => thread.state.streaming || thread.adapterStreaming,
      isIdle: () => !thread.state.streaming && thread.state.idle && !thread.adapterStreaming
      && thread.adapterPending === 0 && !this.extensionUi.hasOpen(thread.threadId),
      waitForIdle: () => thread.backend.waitForIdle(),
      isCurrent: () => this.threads.get(thread.threadId)?.runtime === thread,
      sessionName: () => thread.state.title,
      transcript: () => thread.backend.transcript(),
      complete: (provider, modelId, request) => requireCapability(thread.backend, "completions").complete(provider, modelId, request),
      modelApi: () => thread.backend.capabilities.completions?.modelApi(),
      shortcuts: (userBindings) => thread.backend.capabilities.extensions?.shortcuts(userBindings) ?? [],
      runShortcut: async (keys, userBindings) => {
        // A shortcut handler draws through ctx.ui, which only exists once bound.
        await this.binding.settle(thread);
        return thread.backend.capabilities.extensions?.runShortcut(keys, userBindings) ?? false;
      },
      entries: () => thread.entries,
      appendEntry: (customType, data) => thread.appendJournalEntry(customType, data),
    };
  }

  /** Opens a runtime for a session file an extension created; it stays off screen until activated. */
  private async prepareThread(session: HostSessionFile, manager: SessionManager, options: { previousSessionFile?: string } = {}): Promise<HostPreparedThread> {
    const runtime = await this.runtimes.open(
      manager,
      { type: "session_start", reason: "resume", ...(options.previousSessionFile ? { previousSessionFile: options.previousSessionFile } : {}) },
      { adopt: false, prepared: true },
    );
    let settled = false;
    let activationInFlight = false;
    return {
      sessionId: runtime.threadId,
      session,
      activate: async () => {
        // Check the terminal state before minting a lease. A duplicate handle
        // must not invalidate an unrelated activation already in flight.
        if (settled) throw new Error("This prepared thread was already used.");
        // The first caller claims the handle synchronously; later callers do
        // not get a chance to mint a competing epoch while it waits in the
        // lifecycle queue.
        if (activationInFlight) throw new Error("This prepared thread is already being activated.");
        activationInFlight = true;
        try {
          return await this.lifecycle.runActivation("prepared-thread-activate", async (activation) => {
            if (settled) throw new Error("This prepared thread was already used.");
            await this.adoptThread(runtime);
            if (!await this.activateThread(runtime, true, activation.epoch)) throw new Error("The thread was superseded before it became active.");
            settled = true;
            runtime.releaseEventBarrier((event, thread, sessionId, cwd, error) => {
              if (error) this.fail(error, sessionId);
              else this.handleSessionEvent(event, thread, sessionId, cwd);
            }, (event) => this.emit(event), (title) => this.publishWindowTitle(title));
            return this.actionResult(this.lifecycleUpdates(await this.snapshot()));
          });
        } catch (error) {
          if (!settled) activationInFlight = false;
          throw error;
        } finally {
          if (settled) activationInFlight = false;
        }
      },
      discard: async () => {
        if (settled) return;
        settled = true;
        if (this.threads.get(runtime.threadId)?.runtime === runtime) await this.threads.release(runtime.threadId);
        else await this.runtimes.dispose(runtime);
      },
    };
  }

  /**
   * A thread an extension runs for its own work. It is created, indexed and
   * prompted like any other, but never competes for the screen, so the user
   * keeps the thread they are reading.
   */
  private async startThread(options: HostThreadStartOptions): Promise<HostStartedThread> {
    this.workbenchReload.assertAvailable();
    const cwd = options.cwd || this.cwd;
    const backendKind = options.backend ?? "pi";
    const provider = backendKind === "pi" ? undefined : this.requireBackend(backendKind);
    if (options.tools && !provider?.restrictsTools) {
      throw new Error(`The ${provider?.label ?? backendKind} runtime cannot restrict its tools${provider ? "" : " when a thread starts; a runtime extension sets them"}.`);
    }
    const requestedAt = performance.now();
    // Background starts share the queue's background lane: they build their own
    // thread and touch nothing the thread on screen depends on, so serialising
    // them behind each other only made fifty sub-agents start one per second.
    const thread = await this.lifecycle.runBackground("start-thread", async () => {
      const marks = new PhaseTimer(requestedAt);
      marks.mark("queue");
      let runtime: ThreadRuntime;
      if (backendKind === "pi") {
        const manager = SessionManager.create(cwd, this.sessionsDirOverride);
        if (options.parent) this.index.linkParent(manager, options.parent);
        runtime = await this.runtimes.open(manager, { type: "session_start", reason: "new" }, { adopt: false, prepared: true });
      } else {
        // Another backend keeps no Pi session file, so the link lives in the index only.
        const threadId = randomUUID();
        if (options.parent) this.index.rememberParent(threadId, options.parent.threadId);
        runtime = await this.runtimes.openExternal(backendKind, threadId, cwd, { resume: false, adopt: false, ...(options.tools ? { tools: options.tools } : {}) });
      }
      marks.mark("open");
      try {
        await this.adoptThread(runtime);
        marks.mark("adopt");
        if (options.model) await requireCapability(runtime.backend, "catalogWrite").setModel(options.model.provider, options.model.id);
        marks.mark("model");
        // The shell has to exist before a title can be published against it.
        await this.index.refreshShell(runtime, true);
        marks.mark("shell");
        if (options.title) await this.applyThreadTitle(runtime, options.title, "renamed");
        marks.mark("title");
        this.log("thread.start.timing", `${runtime.threadId.slice(0, 8)} · ${marks.report()}`);
      } catch (error) {
        if (this.threads.has(runtime.threadId)) await this.threads.release(runtime.threadId);
        else await this.runtimes.dispose(runtime);
        throw error;
      }
      runtime.releaseEventBarrier((event, owner, sessionId, eventCwd, error) => {
        if (error) this.fail(error, sessionId);
        else this.handleSessionEvent(event, owner, sessionId, eventCwd);
      }, (event) => this.emit(event), () => undefined);
      return runtime;
    });
    // Delivery is detached on purpose: the caller gets its thread id at once
    // and reads the answer through the thread, the way the client does.
    void this.prompt(options.prompt, [], thread.threadId)
      .catch((error) => this.log("thread.start-prompt-failed", this.errorMessage(error)));
    return { sessionId: thread.threadId, cwd: thread.cwd, ...(thread.state.title ? { title: thread.state.title } : {}) };
  }

  private runtimeExtensionsFor(settingsManager: SettingsManager, session: RuntimeSessionInfo): SessionRuntimeExtension[] {
    const settings = { global: settingsManager.getGlobalSettings(), project: settingsManager.getProjectSettings() };
    return this.seam.runtimeExtensions
      .filter((contribution) => contribution.enabledFor?.(settings) ?? true)
      .map(({ name, factory, shellCommandPrefix }) => ({ name, factory: (pi) => factory(pi, session), shellCommandPrefix: shellCommandPrefix?.(session) }));
  }

  /** The provider behind a non-Pi backend kind. */
  private requireBackend(kind: ThreadBackendKind): HostRuntimeBackendProvider {
    const provider = this.seam.backends.get(kind);
    if (!provider) throw new Error(`Runtime backend "${kind}" is not installed; enable its extension, pick another runtime for new threads, or unset TAU_RUNTIME_ADAPTER.`);
    return provider;
  }

  private async activateHostExtensions(): Promise<void> {
    // The kits Tau ships arrive as a thunk so their compilation happens with the
    // host, not with the module that configured it.
    const bundled = typeof this.pendingHostExtensions === "function" ? await this.pendingHostExtensions() : this.pendingHostExtensions;
    this.pendingHostExtensions = bundled;
    for (const extension of bundled) await this.hostExtensions.activate(extension);
    await this.packages?.start();
    await this.watch?.retarget().catch((error: unknown) => this.log("watch.retarget.failed", this.errorMessage(error)));
  }

  /**
   * Kits and packages, read from disk again and re-activated. No runtime is
   * touched and nothing waits for a turn: a thread mid-run keeps the runtime
   * it has, and a runtime extension the new code registers applies to the next
   * runtime the host builds. Host commands and panels change at once.
   */
  async reloadExtensions(): Promise<void> {
    return this.lifecycle.run("reload-extensions", async () => {
      const source = this.hostExtensionSource;
      const bundled = typeof source === "function" ? await source() : source;
      this.pendingHostExtensions = bundled;
      for (const extension of bundled) await this.hostExtensions.activate(extension);
      await this.packages?.refresh({ force: true });
      this.log("extensions.reloaded", `${bundled.length} bundled`);
      const snapshot = await this.snapshot();
      for (const update of this.lifecycleUpdates(snapshot)) this.emitUpdate(update);
    });
  }

  /** Turns a known host extension off or on again; the desktop toggle calls this for a package's host half. */
  async setHostExtensionActive(id: string, active: boolean): Promise<HostExtensionSummary[]> {
    if (active) await this.hostExtensions.activateKnown(id);
    else await this.hostExtensions.deactivate(id);
    this.log(active ? "host-extension.enabled" : "host-extension.disabled", id);
    return this.listHostExtensions();
  }

  /** Records the user's answer for a package and starts or stops both of its halves. */
  async grantExtension(id: string, grant: boolean): Promise<void> {
    await this.packages?.grant(id, grant);
  }

  invokeHostExtension(extensionId: string, command: string, input?: unknown, principal: HostInvocationPrincipal = HOST_CORE_PRINCIPAL): Promise<unknown> {
    return this.hostExtensions.invoke(extensionId, command, input, principal);
  }

  /** Extension commands that may run long, so a client runs them as host jobs. */
  longHostExtensionCommands(): string[] {
    return this.hostExtensions.longCommands();
  }

  listHostExtensions(): HostExtensionSummary[] {
    const summaries = this.hostExtensions.summaries();
    // A package awaiting approval has no code loaded, but the user still has to see it.
    summaries.push(...this.packages?.waitingSummaries(new Set(summaries.map((summary) => summary.id))) ?? []);
    return summaries;
  }

  private adapterFor(kind: ThreadBackendKind): AgentRuntimeAdapter {
    return kind === "pi" ? this.piAdapter : this.requireBackend(kind).adapter;
  }

  // ---------------------------------------------------------------------------
  // Active thread accessors. Most of the host reads "the runtime": it is the one
  // the workbench shows, or nothing while Pi's own TUI owns the visible thread.
  // ---------------------------------------------------------------------------

  private get active(): ThreadRuntime | undefined {
    return this.attached.session.isAttached ? this.attachedThread : this.threads.active?.runtime;
  }

  /** The active thread of Tau's own registry; excludes a thread Pi owns. */
  private get localActive(): ThreadRuntime | undefined {
    return this.threads.active?.runtime;
  }

  private requireActive(): ThreadRuntime {
    const thread = this.active;
    if (!thread) throw new Error("Pi runtime is not ready");
    return thread;
  }

  /** Whether a thread is the one Pi's own terminal owns. */
  private ownedByPi(thread: ThreadRuntime | undefined): boolean {
    return thread === this.attachedThread;
  }

  private threadFor(threadId: string | undefined): ThreadRuntime | undefined {
    if (this.attached.session.owns(threadId)) return this.attachedThread;
    if (!threadId) return this.active;
    return this.threads.get(threadId)?.runtime;
  }

  private requireThread(threadId: string | undefined): ThreadRuntime {
    return this.threadFor(threadId) ?? this.noRuntimeFor(threadId);
  }

  /** No runtime holds this thread and nothing else can answer for it. */
  private noRuntimeFor(threadId: string | undefined): never {
    throw new Error(threadId && threadId !== this.active?.threadId
      ? "That thread is not open any more. Open it again to continue."
      : "Pi runtime is not ready");
  }

  /**
   * Resolves the thread a turn names. A thread that is still opening is waited
   * for rather than refused, and a client that painted from its cache before
   * this run published anything names last run's thread: that first message
   * belongs to the empty thread this run put on screen.
   */
  private async awaitThread(threadId: string | undefined): Promise<ThreadRuntime> {
    const live = this.threadFor(threadId);
    if (live) return live;
    if (!threadId) return this.requireActive();
    // Join whatever lifecycle work holds the queue; the thread may be in it.
    await this.lifecycle.run("await-thread", async () => undefined);
    const opened = this.threadFor(threadId);
    if (opened) return opened;
    const onScreen = this.emptyThreadOnScreen(threadId);
    if (!onScreen) return this.requireThread(threadId);
    this.log("prompt.retargeted", `${threadId.slice(0, 8)} → ${onScreen.threadId.slice(0, 8)}`);
    // The client is showing a thread this run does not have. Publish the one
    // it is really writing to, so the turn is not delivered out of sight.
    this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(this.snapshotSync([])) });
    return onScreen;
  }

  /** The blank thread on screen, when the named one cannot be one of this run's. */
  private emptyThreadOnScreen(threadId: string): ThreadRuntime | undefined {
    if (this.index.byId(threadId)) return undefined;
    const active = this.active;
    return active && !active.state.hasMessages ? active : undefined;
  }

  private isCurrentActivation(epoch: number): boolean { return this.lifecycle.isCurrentActivation(epoch); }
  private async staleActivationResult(): Promise<HostActionResult> {
    return this.actionResult([]);
  }
  /**
   * A superseded new-thread request never reaches prompt delivery, so it must
   * report a rejection. A bare action result would leave the client waiting for
   * a commit that can no longer happen.
   */
  private async staleNewThreadResult(requestId?: NewThreadRequestId): Promise<NewThreadResult> {
    return this.newThreadResult([], { accepted: false, message: "A newer request replaced this new thread." }, requestId);
  }
  private liveThreadForPath(path: string | undefined): ThreadRuntime | undefined {
    if (!path) return undefined;
    const external = externalThreadFromPath(path);
    if (external) return this.threads.get(external.threadId)?.runtime;
    const indexed = this.index.byPath(path);
    if (indexed?.backendKind && indexed.backendKind !== "pi") return this.threads.get(indexed.id)?.runtime;
    return this.threads.list().find((record) => samePath(record.runtime.sessionFile, path))?.runtime;
  }

  private liveThreadIds(): Set<string> {
    return new Set(this.threads.list().map((record) => record.threadId));
  }

  private async initialSessionManager(cwd: string): Promise<SessionManager> {
    return SessionManager.continueRecent(cwd, this.sessionsDirOverride);
  }

  private async openInitialThread(cwd: string): Promise<ThreadRuntime> {
    if (this.defaultBackendKind !== "pi") {
      const kind = this.defaultBackendKind;
      const latest = (await this.requireBackend(kind).listThreads())
        .filter((record) => record.cwd === cwd)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      return this.runtimes.openExternal(kind, latest?.threadId ?? randomUUID(), cwd, { resume: Boolean(latest) });
    }
    try {
      return await this.runtimes.open(await this.initialSessionManager(cwd), undefined);
    } catch (error) {
      // The last session of this workspace points at a folder that is gone, or
      // another host writes it; a fresh session in the workspace is the right
      // answer at startup, where nobody chose that session.
      if (!(error instanceof Error && (error.name === "MissingSessionCwdError" || isSessionHeldElsewhere(error)))) throw error;
      this.log(isSessionHeldElsewhere(error) ? "session.held-elsewhere" : "session.cwd-missing", this.errorMessage(error));
      return this.runtimes.open(SessionManager.create(cwd, this.sessionsDirOverride), undefined);
    }
  }

  async start(): Promise<HostBootstrap> {
    return this.lifecycle.runActivation("start", async (activation) => {
      const activationEpoch = activation.epoch;
      this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", "bootstrap");
      try {
        await this.activateHostExtensions();
        // A default backend nobody registered is a configuration error; say so now, not at the first thread.
        if (this.defaultBackendKind !== "pi") this.requireBackend(this.defaultBackendKind);
        await this.rememberProject(this.cwd);
        // Classify saved projects while the runtime opens. Each answer is a
        // single git call, so it is ready long before bootstrap reads the list.
        for (const project of this.projectHistory.list()) this.projects.classify(project.path);
        if (!this.isCurrentActivation(activationEpoch)) throw new Error("The initial runtime was superseded before it became active.");
        const safeModeOwner = this.safeMode ? await findPiBridge(this.cwd) : undefined;
        if (safeModeOwner && processIsAlive(safeModeOwner.pid)) {
          throw new Error("Pi already owns this session. Close Pi before opening the project in Tau safe mode.");
        }
        if (this.defaultBackendKind !== "pi" || !(await this.attached.session.attach(this.cwd, undefined, {}, activationEpoch))) {
          if (!this.isCurrentActivation(activationEpoch)) throw new Error("The initial runtime was superseded before it became active.");
          // Extensions repair what they keep beside sessions (a restore
          // journal, say) before a session opens on this workspace.
          await this.threadLifecycle.beforeWorkspace(this.cwd);
          if (!this.isCurrentActivation(activationEpoch)) throw new Error("The initial runtime was superseded before it became active.");
          const thread = await this.openInitialThread(this.cwd);
          if (!await this.activateThread(thread, false, activationEpoch)) throw new Error("The initial runtime was superseded before it became active.");
        }
        if (!this.isCurrentActivation(activationEpoch)) throw new Error("The initial runtime was superseded before it became active.");
        this.projects.label(this.cwd);
        const indexStartedAt = performance.now();
        this.log("bootstrap.first-content");
        // The global index is independent of the active detail. Publish it when
        // ready rather than making first content wait for every session file.
        void this.index.refresh("index").then(async () => {
          this.recordBackgroundLifecycle("session-index", indexStartedAt);
          this.log("bootstrap.full-ready");
          this.index.startRecovery();
          this.trash.start();
          // Before anything else is opened for this run: the index is the only
          // way back to a marked thread's session file.
          await this.reconcileInterruptedTurns();
          this.prewarm.scheduleThreads();
          this.catalogs.start();
        }).catch((error) => this.fail(error));
        const result = await this.bootstrap();
        this.lifecycleMetrics.end();
        return result;
      } catch (error) {
        this.lifecycleMetrics.end();
        throw error;
      }
    });
  }

  activeWorkspacePath(): string {
    return this.cwd;
  }

  threadTitle(sessionId: string): string | undefined { return this.index.byId(sessionId)?.title; }

  async bootstrap(): Promise<HostBootstrap> {
    // The project list is withheld while a checkout is unclassified. Bootstrap
    // is the one publication the client cannot miss, so settle it here.
    await this.projects.settleClassifications();
    const host = { ...this.snapshotSync(await this.ensureModels()), projectLabel: this.projectLabel };
    const detail = this.detailForSnapshot(host);
    const result: HostBootstrap = {
      threadIndex: this.index.snapshot(),
      version: HOST_PROTOCOL_VERSION,
      detail,
      catalog: catalogFromSnapshot(host),
      project: this.projectMetadata(host.cwd, host.projectLabel),
    };
    this.lifecycleMetrics.recordIpc(result);
    return result;
  }

  /** Focused active detail endpoint; it never includes catalogs or project metadata. */
  async getThreadDetail(cursor?: HostTranscriptCursor): Promise<TranscriptPage | ThreadDetail> {
    const snapshot = await this.snapshot();
    const result = cursor !== undefined
      ? clientTranscript(localTranscriptPage(
        snapshot.sessionId,
        snapshot.messages,
        snapshot.taskHistory,
        snapshot.turnActivityHistory,
        snapshot.turnActivityHistoryComplete,
        cursor,
      ))
      : this.detailForSnapshot(snapshot);
    this.lifecycleMetrics.recordIpc(result);
    return result;
  }

  async loadTranscript(sessionId: string, cursor?: HostTranscriptCursor): Promise<TranscriptPage> {
    const thread = this.threadFor(sessionId);
    if (!thread) {
      const result = clientTranscript(await this.releasedTranscript(sessionId, cursor));
      this.lifecycleMetrics.recordIpc(result);
      return result;
    }
    const paging = thread.backend.capabilities.transcriptPaging;
    let result: TranscriptPage;
    if (paging) {
      result = await paging.page(cursor);
    } else {
      const rawMessages = this.projection.branchMessages(thread);
      result = localTranscriptPage(
        sessionId,
        this.projection.messages(thread),
        taskProgressHistoryFromMessages(rawMessages),
        turnActivityHistoryFromMessages(rawMessages),
        true,
        cursor,
      );
    }
    result = clientTranscript(result);
    this.lifecycleMetrics.recordIpc(result);
    return result;
  }

  /**
   * Read persisted tool output on demand. The transcript and live event
   * payloads intentionally keep only bounded previews; this seam is the only
   * path used by the renderer's deliberate "copy full output" action.
   */
  async readToolOutput(sessionId: string, toolCallId: string): Promise<import("../shared/contracts.js").UiToolOutputReadResult | undefined> {
    if (!toolCallId) throw new Error("A tool call id is required.");
    const thread = this.threadFor(sessionId);
    if (!thread) {
      const result = (await this.persistedTranscript(sessionId)).toolOutput(toolCallId);
      this.lifecycleMetrics.recordIpc(result);
      return result;
    }
    const paging = thread.backend.capabilities.transcriptPaging;
    const result = paging
      ? await paging.readToolOutput(toolCallId)
      : readLocalToolOutput(this.projection.branchMessages(thread), toolCallId);
    this.lifecycleMetrics.recordIpc(result);
    return result;
  }

  /** A deferred tool's output as the transcript would have carried it; `clientToolRun` held it back. */
  async toolOutput(sessionId: string, toolCallId: string): Promise<UiToolOutputPreview | undefined> {
    if (!toolCallId) throw new Error("A tool call id is required.");
    const thread = this.threadFor(sessionId);
    if (thread && !isPiBackend(thread)) {
      const tool = [thread.tools.get(toolCallId), ...thread.adapterActivity.flatMap((entry) => entry.tools).reverse()]
        .find((candidate) => candidate?.id === toolCallId);
      if (tool?.output === undefined) return undefined;
      return { toolCallId, output: tool.output, ...(tool.outputTruncated ? { outputTruncated: true } : {}), ...(tool.fullOutputAvailable ? { fullOutputAvailable: true } : {}) };
    }
    const read = await this.readToolOutput(sessionId, toolCallId);
    if (!read) return undefined;
    const output = boundedToolOutput(read.output);
    return { toolCallId, output, ...(output !== read.output ? { outputTruncated: true, fullOutputAvailable: true } : {}) };
  }

  /**
   * The transcript of a thread no runtime holds. Runtimes are capped and idle
   * ones are released oldest first, so a thread's tab must read what was
   * persisted rather than tell the reader to take the thread over first: a Pi
   * thread its session file, a thread of another backend the shell that
   * backend keeps. Neither opens a runtime.
   */
  private async releasedTranscript(sessionId: string, cursor?: HostTranscriptCursor): Promise<TranscriptPage> {
    const session = await this.index.find(sessionId);
    const kind = session?.backendKind ?? "pi";
    if (!session || kind === "pi") return (await this.persistedTranscript(sessionId)).page(cursor);
    const record = await this.seam.backends.get(kind)?.lookup(sessionId);
    if (!record) this.noRuntimeFor(sessionId);
    return shellTranscriptPage(sessionId, record, cursor);
  }

  private async persistedTranscript(sessionId: string): Promise<PersistedThreadTranscript> {
    const session = await this.index.find(sessionId);
    // Nothing persisted to read: a thread of another backend keeps no session
    // file, and an unknown id was never this host's.
    if (!session || (session.backendKind ?? "pi") !== "pi") this.noRuntimeFor(sessionId);
    const active = this.active;
    return new PersistedThreadTranscript({
      sessionId,
      cwd: session.projectPath,
      path: session.path,
      ...(session.title ? { title: session.title } : {}),
      ...(session.parentThreadId ? { parentThreadId: session.parentThreadId } : {}),
    }, {
      runtimeAdapter: this.piAdapter,
      // Its own runtime is gone; the skills of the thread on screen are the
      // same host's catalog, and the host's defaults when there is none.
      skillCommands: active && isPiBackend(active) ? this.projection.composerCommands(active) : this.runtimeCommands,
      pins: (thread) => this.projection.pinsFor(thread),
    });
  }

  getLifecycleMeasurements() { return this.lifecycleMetrics.getMeasurements(); }
  getBackgroundLifecycleMeasurements() { return this.report.backgroundMeasurements.map((item) => ({ ...item })); }

  private detailForSnapshot(snapshot: HostSnapshot, requestId?: NewThreadRequestId): ThreadDetail {
    return this.publication.detailForSnapshot(snapshot, requestId);
  }

  private actionResult(updates: HostUpdate[]): HostActionResult {
    return this.publication.actionResult(updates);
  }

  private newThreadResult(
    updates: HostUpdate[],
    submission: SubmissionResult,
    requestId?: NewThreadRequestId,
    sessionId?: string,
  ): NewThreadResult {
    return this.publication.newThreadResult(updates, submission, requestId, sessionId);
  }

  /** Publishes a thread the runtime created and now owns; one identity and publication path. */
  private async completeRuntimeOwnedNewThread(thread: ThreadRuntime, requestId: NewThreadRequestId): Promise<NewThreadResult> {
    this.cwd = thread.cwd;
    await this.index.refreshShell(thread, true);
    return this.newThreadResult(this.lifecycleUpdates(await this.snapshot()), { accepted: true }, requestId, thread.threadId);
  }

  private lifecycleUpdates(snapshot: HostSnapshot, requestId?: NewThreadRequestId): HostUpdate[] {
    return this.publication.lifecycleUpdates(snapshot, requestId);
  }

  private async activeUpdates(activationEpoch?: number): Promise<HostActionResult> {
    const snapshot = await this.snapshot();
    if (activationEpoch !== undefined && !this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
    return this.actionResult(this.lifecycleUpdates(snapshot));
  }

  /**
   * Publish the initial snapshot after a new-thread request has been accepted.
   * Model/catalog discovery can share a serialized backend lane with the first
   * prompt, so it must never be part of the renderer's acceptance round trip.
   */
  private async publishNewSessionUpdates(activationEpoch: number, requestId: NewThreadRequestId | undefined, sessionId: string): Promise<void> {
    // Publish the thread identity and a first detail without waiting for the
    // model catalog. Catalog discovery can share the runtime's serialized
    // lane with prompt delivery; neither the renderer's promotion nor the
    // initial thread shell should depend on that slower read.
    try {
      if (!this.isCurrentActivation(activationEpoch)) return;
      const snapshot = this.snapshotSync([]);
      if (!this.isCurrentActivation(activationEpoch)) return;
      this.publication.publishInitialSessionUpdates(snapshot, requestId);
    } catch (error) {
      // A runtime may expose its first detail only after its own startup
      // bookkeeping. Keep the asynchronous catalog path alive; it can still
      // publish the authoritative snapshot once that bookkeeping completes.
      this.log("new-session.initial-publish.failed", this.errorMessage(error));
    }
    try {
      const active = await this.activeUpdates(activationEpoch);
      if (!this.isCurrentActivation(activationEpoch)) return;
      for (const update of active.updates) {
        if (requestId && update.type === "thread-detail") {
          this.emitUpdate({ ...update, detail: { ...update.detail, requestId } });
        } else {
          this.emitUpdate(update);
        }
      }
    } catch (error) {
      this.fail(error, sessionId);
    }
  }

  async setWorkspace(cwd: string): Promise<HostActionResult> {
    return this.lifecycle.runActivation("set-workspace", (activation) => this.setWorkspaceNow(cwd, activation.epoch));
  }

  private async setWorkspaceNow(cwd: string, activationEpoch: number): Promise<HostActionResult> {
    if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
    // Workspace switching never waits on another thread's history work.
    await this.rememberProject(cwd);
    if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
    if (cwd === this.cwd && this.active) {
      await this.threadLifecycle.beforeWorkspace(cwd);
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      return this.activeUpdates(activationEpoch);
    }
    if (this.defaultBackendKind === "pi" && await this.attached.session.attach(cwd, undefined, {}, activationEpoch)) {
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      await this.rememberProject(this.cwd);
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      await this.refreshActiveThreadIndex(false);
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      return this.activeUpdates(activationEpoch);
    }
    if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
    this.attached.session.detach();
    await this.leaveWorkspaceFor(cwd);
    await this.threadLifecycle.beforeWorkspace(cwd);
    const startedAt = performance.now();
    const thread = this.defaultBackendKind !== "pi"
      ? await this.openInitialThread(cwd)
      : await (async () => {
        const manager = await this.initialSessionManager(cwd);
        return this.liveThreadForPath(manager.getSessionFile())
          ?? await this.runtimes.open(manager, { type: "session_start", reason: "resume", previousSessionFile: this.active?.sessionFile });
      })();
    if (!await this.activateThread(thread, false, activationEpoch)) return this.staleActivationResult();
    this.logReplacement("workspace", startedAt);
    return this.activeUpdates(activationEpoch);
  }

  /**
   * The host left `cwd`. It runs after that workspace's last thread and before
   * `beforeWorkspace` of the next one, and a hook that cannot let go is logged
   * rather than allowed to block the workspace that is opening.
   */
  private async closeWorkspace(cwd: string, reason: HostWorkspaceCloseReason): Promise<void> {
    try {
      await this.threadLifecycle.afterWorkspaceClose(cwd, reason);
    } catch (error) {
      this.log("workspace.close.failed", this.errorMessage(error));
    }
  }

  /** A project switch closes the workspace being left, unless the host stays in it. */
  private async leaveWorkspaceFor(next: string): Promise<void> {
    if (next === this.cwd) return;
    await this.closeWorkspace(this.cwd, "switch");
  }

  /**
   * Moves a persisted thread to the trash: its runtime is released and the
   * index republished without it. The `threadDeleted` hooks run when the
   * trash purges it. A thread that is running, or the one on screen, is
   * refused — the caller stops or leaves it first.
   */
  async removeThread(sessionId: string): Promise<void> {
    await this.index.find(sessionId); // outside the lifecycle: the first scan's sweep runs kit hooks
    return this.lifecycle.run("remove-thread", async () => {
      const session = this.index.byId(sessionId);
      if (!session) throw new Error(`No thread ${sessionId.slice(0, 8)} in this host's index.`);
      if (this.active?.threadId === sessionId) throw new Error("This thread is on screen; open another one before deleting it.");
      const live = this.threadFor(sessionId);
      if (live?.state.streaming || live?.adapterStreaming) throw new Error("This thread is still running; stop it before deleting it.");
      if (live && this.ownedByPi(live)) throw new Error("Pi's terminal holds this thread; close it there first.");
      if (live) await this.threads.release(sessionId);
      await this.trash.trash({ sessionId, cwd: session.projectPath, title: session.title, backendKind: session.backendKind ?? "pi", path: session.path });
      await this.index.refresh("changes");
    });
  }

  async restoreThread(sessionId: string): Promise<void> {
    return this.lifecycle.run("restore-thread", async () => {
      await this.trash.restore(sessionId);
      await this.index.refresh("changes");
    });
  }

  purgeThread(sessionId: string): Promise<void> {
    return this.trash.purge(sessionId);
  }

  async removeProject(path: string): Promise<HostActionResult> {
    await this.projectHistory.remove(path);
    const update: HostUpdate = {
      version: HOST_PROTOCOL_VERSION,
      type: "thread-index",
      index: this.index.snapshot(),
    };
    this.emitUpdate(update);
    return this.actionResult([update]);
  }

  /**
   * Closes tool calls left dangling by a turn that never finished, so the thread
   * can be used again. Without a result the provider rejects the next request.
   */
  async recoverThread(): Promise<HostActionResult> {
    // While Pi owns the thread its session file has another writer. The runtime
    // hands it back only when Pi has stopped answering; otherwise repair belongs there.
    const takenOver = await this.attached.session.releaseToHost();
    if (takenOver) await this.attached.session.withoutAttaching(() => this.switchSession(takenOver));

    const thread = this.requireActive();
    return this.threads.run(thread.threadId, async () => {
      const journal = thread.backend.capabilities.journal;
      if (!journal) {
        if (thread.adapterPending > 0 || thread.state.streaming) await this.abortThread(thread);
        thread.adapterMessages = await thread.backend.transcript();
        const snapshot = await this.snapshot();
        const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) };
        this.emitUpdate(update);
        return this.actionResult([update]);
      }
      await this.repairDanglingToolCalls(thread);
      const snapshot = await this.snapshot();
      const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) };
      this.emitUpdate(update);
      return this.actionResult([update]);
    });
  }

  /**
   * Closes the tool calls a turn left open, so the provider takes the next
   * request. Zero of them is a success: the session is already consistent.
   */
  private async repairDanglingToolCalls(thread: ThreadRuntime): Promise<number> {
    const journal = thread.backend.capabilities.journal;
    if (!journal) return 0;
    // A run that is still in flight owns its tool calls; closing them from
    // outside would race the runtime. Stop it first, then repair.
    if (!thread.state.idle || thread.adapterPending > 0) await this.abortThread(thread);
    const dangling = findDanglingToolCalls(thread.entries
      .flatMap((entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "message"
        ? [(entry as { message?: unknown }).message]
        : []));
    for (const { toolCallId, toolName } of dangling) {
      journal.appendMessage({
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: "Interrupted: Tau closed this tool call so the thread could continue." }],
        isError: true,
        timestamp: Date.now(),
      });
    }
    thread.tools.clear();
    this.log("thread.recovered", dangling.length === 0
      ? "session already consistent"
      : `${dangling.length} tool ${dangling.length === 1 ? "call" : "calls"}`);
    return dangling.length;
  }

  /**
   * The turns this host had in flight when it stopped. Continuing one is the
   * user's choice (Settings → Defaults); otherwise the thread is repaired,
   * told in its own transcript, and marked for the rail.
   */
  private async reconcileInterruptedTurns(): Promise<void> {
    const markers = await this.turnsInFlight.load();
    const { continued } = markers.length === 0 ? { continued: [] } : await reconcileInFlightTurns({
      markers: () => markers,
      forget: (sessionId) => this.turnsInFlight.clear(sessionId),
      continueAfterRestart: this.continueThreadsAfterRestart,
      markInterrupted: (sessionId) => this.index.setInterrupted(sessionId, true),
      log: (label, detail) => this.log(label, detail),
      errorMessage: (error) => this.errorMessage(error),
      open: async (marker) => {
        const thread = this.threads.get(marker.sessionId)?.runtime ?? await this.openMarkedThread(marker);
        if (!thread) return undefined;
        const resume = thread.backend.capabilities.resume;
        return {
          threadId: thread.threadId,
          repair: () => this.repairDanglingToolCalls(thread),
          // The notice lands in a transcript the client has already drawn, and
          // it has to be there before the continuation starts, not after it.
          ...(resume ? { resume: { ...resume, notice: async (text: string) => {
            await resume.notice?.(text);
            await this.publishThreadDetail(thread);
          } } } : {}),
          prompt: (text, hidden) => this.prompt(text, [], thread.threadId, undefined, undefined, { hidden }),
        } satisfies ReconcilableThread;
      },
    });
    // A restored queue follows a continuation and waits for the user otherwise.
    await this.queue.restore(continued);
    await this.limits.restore();
  }

  /** Republishes one thread's transcript, when it is the one on screen. */
  private async publishThreadDetail(thread: ThreadRuntime): Promise<void> {
    if (this.active !== thread) return;
    const snapshot = await this.snapshot();
    this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) });
  }

  /** Reopens a marked thread off screen; `undefined` when its session is gone. */
  private async openMarkedThread(marker: { sessionId: string; backend: ThreadBackendKind }): Promise<ThreadRuntime | undefined> {
    const path = marker.backend === "pi"
      ? this.index.byId(marker.sessionId)?.path
      : externalThreadPath(marker.backend, marker.sessionId);
    if (!path) return undefined;
    return this.runtimes.openForPath(path, "resume", true, marker.backend);
  }

  private async reopenThread(sessionId: string): Promise<ThreadRuntime> {
    const live = this.threads.get(sessionId)?.runtime;
    if (live) return live;
    const thread = await this.openMarkedThread({ sessionId, backend: (await this.index.find(sessionId))?.backendKind ?? "pi" });
    if (!thread) throw new Error("That thread no longer exists.");
    return thread;
  }

  private async sendToThread(sessionId: string, text: string, delivery: "prompt" | "steer" | "queue", from?: string): Promise<void> {
    const thread = await this.reopenThread(sessionId);
    if (delivery === "queue") this.queue.add(thread.threadId, { text, attachments: [], ...(from ? { fromThreadId: from } : {}) });
    else await (delivery === "steer" ? this.steer(text, [], thread.threadId) : this.prompt(text, [], thread.threadId));
  }

  /** A queued message is prepared when it leaves, against the thread as it is then. */
  private async deliverQueued(sessionId: string, message: QueuedMessage): Promise<void> {
    const prepared = message.skillDraft ? await this.preparePrompt(message.text, sessionId, message.skillDraft) : undefined;
    await this.prompt(message.skillDraft ? message.text : message.text.trim(), message.attachments, sessionId, undefined, prepared);
  }

  async newSession(
    initialPrompt?: string,
    attachments: UiPromptAttachment[] = [],
    cwd?: string,
    clientMessageIdOrRequestId?: ClientTurnRequest,
    prepared?: PreparedPrompt,
    configuration?: NewThreadConfiguration,
  ): Promise<HostActionResult> {
    this.workbenchReload.assertAvailable();
    const requestValue = typeof clientMessageIdOrRequestId === "string" ? clientMessageIdOrRequestId : undefined;
    const requestId = requestValue?.startsWith("new-thread-")
      ? requestValue as NewThreadRequestId
      : typeof clientMessageIdOrRequestId === "object"
        ? clientMessageIdOrRequestId.newThreadRequestId
        : undefined;
    const identity = clientIdentityForRequest(clientMessageIdOrRequestId);
    const clientMessageId = identity?.clientMessageId;
    const backendKind = prepared?.backendKind ?? this.defaultBackendKind;
    if (prepared && backendKind !== "pi" && !this.seam.backends.has(backendKind)) {
      throw new Error("Prepared prompt names an unsupported runtime backend.");
    }
    // A runtime that creates threads itself answers the request; Tau only
    // publishes what it reports.
    const owner = !cwd || cwd === this.cwd ? this.active : undefined;
    const runtimeThreads = owner?.backend.kind === backendKind ? owner.backend.capabilities.newThread : undefined;
    if (owner && runtimeThreads) {
      return this.lifecycle.runActivation("new-thread-runtime", async (activation) => {
        const activationEpoch = activation.epoch;
        if (!this.isCurrentActivation(activationEpoch)) return this.staleNewThreadResult(requestId);
        const ownedRequestId = requestId ?? createNewThreadRequestId(randomUUID());
        try {
          this.prompts.assertAttachmentInput(owner, attachments);
        } catch (error) {
          return this.newThreadResult([], { accepted: false, message: this.errorMessage(error) }, ownedRequestId);
        }
        try {
          const rebind = promptRebindForThread(prepared, owner.threadId);
          const ownedPrepared = rebind ? await owner.backend.preparePrompt(initialPrompt ?? "", rebind.skill) : prepared;
          if (ownedPrepared) this.prompts.assertBound(owner, initialPrompt ?? "", ownedPrepared, this.projection.composerCommands(owner));
          if (identity) this.clientTurns.enqueueAny(identity, ownedPrepared?.sourceFingerprint);
          const outcome = await runtimeThreads.create({
            requestId: ownedRequestId,
            projectPath: this.cwd,
            ...(initialPrompt === undefined ? {} : { initialPrompt }),
            attachments,
            ...(identity ? { identity } : {}),
            ...(ownedPrepared ? { prepared: ownedPrepared } : {}),
          });
          if (!this.isCurrentActivation(activationEpoch)) return this.staleNewThreadResult(requestId);
          if (!outcome.adopted) return this.newThreadResult([], { accepted: true }, ownedRequestId);
          return await this.completeRuntimeOwnedNewThread(owner, ownedRequestId);
        } catch (error) {
          if (identity) this.clientTurns.cancel(undefined, identity);
          if (!this.isCurrentActivation(activationEpoch)) return this.staleNewThreadResult(requestId);
          const reason = error instanceof Error ? error.message : String(error);
          this.log("new-thread.rejected", reason);
          return this.newThreadResult([], { accepted: false, message: reason }, ownedRequestId);
        }
      }, "unserialized");
    }
    if (prepared && prepared.tauThreadId === undefined && prepared.sessionId === undefined) {
      this.prompts.assertUnbound(initialPrompt ?? "", prepared, this.adapterFor(backendKind), this.composerCommandsFor(backendKind, cwd ?? this.cwd), backendKind);
    }
    return this.lifecycle.runActivation("new-thread", async (activation) => {
      const activationEpoch = activation.epoch;
      // A superseded request still creates its thread and delivers its prompt
      // in the background; it only stops competing for the visible thread.
      const startedAt = performance.now();
      const targetCwd = cwd ?? this.cwd;
      if (this.isCurrentActivation(activationEpoch)) this.attached.session.detach();
      const spare = backendKind === "pi" ? await this.prewarm.takeSpare(targetCwd) : undefined;
      const thread = spare
        ?? (backendKind !== "pi"
          ? await this.runtimes.openExternal(backendKind, randomUUID(), targetCwd, { resume: false })
          : await this.runtimes.open(
            SessionManager.create(targetCwd, this.sessionsDirOverride),
            { type: "session_start", reason: "new", previousSessionFile: this.active?.sessionFile },
            { adopt: false, prepared: true },
          ));
      let lifecycle: "prepared" | "adopting" | "adopted" | "promoted" = "prepared";
      let visible = false;
      try {
        // A model chosen on the start screen belongs to this prepared runtime,
        // never to the previously active thread. Apply it before validating
        // images because model capability determines whether they are accepted.
        if (configuration?.model) {
          await requireCapability(thread.backend, "catalogWrite").setModel(
            configuration.model.provider,
            configuration.model.id,
          );
        }
        if (configuration?.thinkingLevel) await requireCapability(thread.backend, "catalogWrite").setThinkingLevel(configuration.thinkingLevel);
        if (configuration?.mode) await requireCapability(thread.backend, "mode").set(configuration.mode);
        // Decode and validate attachment data before promoting a prepared
        // runtime, so malformed input cannot leave an adopted blank thread.
        this.prompts.assertAttachmentInput(thread, attachments);
        lifecycle = "adopting";
        await this.adoptThread(thread);
        lifecycle = "adopted";
        visible = await this.activateThread(thread, true, activationEpoch);
        // A newer activation owns the visible thread. This one still needs its
        // shell in the index so the workbench can list and open it.
        if (!visible) await this.index.refreshShell(thread, true);
        lifecycle = "promoted";
        if (isLocalPiRuntime(thread)) {
          // Shell/index publication precedes releasing buffered runtime events;
          // extension questions remain answerable after release.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          thread.releaseEventBarrier((event, runtime, sessionId, eventCwd, error) => {
            if (error) this.fail(error, sessionId);
            else this.handleSessionEvent(event, runtime, sessionId, eventCwd);
          }, (event) => this.emit(event), (title) => this.publishWindowTitle(title));
        }
        if (initialPrompt?.trim()) {
          const presentation = prepared?.skill ?? skillMessagePresentation(initialPrompt, thread.runtimeAdapter, this.projection.composerCommands(thread));
          const visiblePrompt = prepared?.visibleText ?? (presentation && "text" in presentation ? presentation.text : visibleTitleText(initialPrompt));
          this.index.retitle(thread.threadId, firstSentence(visiblePrompt));
        }
      } catch (error) {
        // A pure validation failure leaves an untouched spare available. Once
        // adoption or activation has started, discard the candidate on failure
        // (except a prompt rejection after promotion: the visible blank thread
        // remains active and the scoped renderer draft remains untouched).
        if (lifecycle === "prepared") {
          if (isLocalPiRuntime(thread) && !configuration?.model && !configuration?.thinkingLevel && !configuration?.mode) this.prewarm.retainSpare(thread);
          else {
            await this.runtimes.dispose(thread);
            if (backendKind === "pi") this.prewarm.scheduleSpare(targetCwd, true);
          }
          return this.newThreadResult([], { accepted: false, message: this.errorMessage(error) }, requestId);
        } else if (lifecycle !== "promoted") {
          if (this.threads.has(thread.threadId)) await this.threads.release(thread.threadId);
          else await this.runtimes.dispose(thread);
          this.prewarm.scheduleSpare(targetCwd, true);
          return this.newThreadResult([], { accepted: false, message: this.errorMessage(error) }, requestId);
        }
        thread.cancelEventBarrier();
        if (!visible) return this.newThreadResult([], { accepted: false, message: this.errorMessage(error) }, requestId, thread.sessionId);
        const active = await this.activeUpdates();
        return { ...active, submission: { accepted: false, message: this.errorMessage(error) }, ...(requestId ? { requestId } : {}) };
      }
      this.logReplacement(spare ? "new-spare" : "new", startedAt);
      if (backendKind === "pi") this.prewarm.scheduleSpare(targetCwd);
      if (visible) void this.publishNewSessionUpdates(activationEpoch, requestId, thread.sessionId);
      if (initialPrompt || attachments.length > 0) {
        // Delivery is intentionally detached from acceptance. AgentSession may
        // keep its prompt pending while the renderer has already settled the
        // submission, and a later correlated failure event reconciles it.
        void (async () => {
          try {
            const preparedThreadId = prepared?.tauThreadId ?? prepared?.sessionId;
            const deliveryPrepared = preparedThreadId && preparedThreadId !== thread.threadId
              ? await thread.backend.preparePrompt(initialPrompt ?? "", prepared?.skill
                ? { source: "skill", name: prepared.skill.name, visibleText: prepared.visibleText, command: prepared.skill.command }
                : undefined)
              : prepared;
            await this.prompt(initialPrompt ?? "", attachments, thread.threadId, identity, deliveryPrepared);
            // Whether this prompt creates a user turn is decided inside
            // prompt(), against the text it actually resolved, and reported by
            // its own event. Do not re-derive it from the request here.
            if (clientMessageId) {
              this.emit({
                type: "new-thread-delivery-settled",
                sessionId: thread.threadId,
                clientMessageId,
                accepted: true,
              });
            }
          } catch (error) {
            // prompt() normally reconciles the optimistic message through its
            // marker. Re-preparation can fail before that marker exists, so
            // the detached boundary also publishes the correlated failure.
            if (clientMessageId) {
              const message = this.errorMessage(error);
              this.emit({
                type: "new-thread-delivery-settled",
                sessionId: thread.threadId,
                clientMessageId,
                accepted: false,
                message,
              });
              this.emit({
                type: "user-message-failed",
                sessionId: thread.threadId,
                clientMessageId,
                message,
              });
            }
            this.log("prompt.rejected", this.errorMessage(error));
          }
        })();
      }
      return this.newThreadResult([], { accepted: true }, requestId, thread.sessionId);
    });
  }

  async getPreparedThreadCapability(cwd?: string): Promise<PreparedThreadCapability> {
    return this.lifecycle.run("prepared-thread-capability", async () => {
      const targetCwd = cwd ?? this.cwd;
      const generation = ++this.preparedThreadCapabilityGeneration;
      // A runtime that creates its own threads answers for the next one too.
      const owner = !cwd || cwd === this.cwd ? this.active : undefined;
      if (owner?.backend.capabilities.newThread) {
        return { cwd: targetCwd, generation, supportsImageInput: owner.state.supportsImageInput };
      }
      const prepared = await this.prewarm.awaitSpare(targetCwd);
      return { cwd: targetCwd, generation, supportsImageInput: prepared?.state.supportsImageInput ?? false };
    });
  }

  async forkThread(entryId: string, expectedSessionId?: string): Promise<HostActionResult> {
    return this.lifecycle.runActivation("fork-thread", async (activation) => {
      const activationEpoch = activation.epoch;
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      const thread = this.requireActive();
      if (expectedSessionId && thread.threadId !== expectedSessionId) {
        throw new Error("The selected thread changed before it could be forked.");
      }
      const fork = requireCapability(thread.backend, "fork");
      // A runtime that forks itself reports the result through its own events.
      if (fork.runtimeOwned) {
        await fork.requestFork?.(entryId);
        return this.isCurrentActivation(activationEpoch) ? this.actionResult([]) : this.staleActivationResult();
      }
      if (thread.state.streaming) throw new Error("Wait for the active run before forking this thread.");
      const sourceFile = thread.sessionFile;
      if (!sourceFile || !existsSync(sourceFile)) {
        throw new Error("This thread has not been saved yet. Wait for the first assistant response before forking it.");
      }
      const startedAt = performance.now();
      // The fork is a new session file, so it gets a runtime of its own; the
      // source thread keeps running untouched.
      // createBranchedSession turns this manager into the fork. A branch without
      // an assistant message has no file until its first response, so the fork
      // must keep this manager instead of reopening its path.
      const forkedManager = SessionManager.open(sourceFile);
      if (!forkedManager.createBranchedSession(entryId)) throw new Error("Failed to create the forked thread.");
      // Extensions carry what they keep beside the source into the fork.
      await this.threadLifecycle.afterFork(this.hostThreadFor(thread), this.seam.sessionFile(forkedManager));
      const forked = await this.runtimes.open(
        forkedManager,
        { type: "session_start", reason: "fork", previousSessionFile: sourceFile },
      );
      if (!await this.activateThread(forked, true, activationEpoch)) return this.staleActivationResult();
      this.logReplacement("fork", startedAt);
      return this.activeUpdates(activationEpoch);
    });
  }

  /** Pi's /tree: the session tree of a thread, for moving it to another point. */
  async threadTree(sessionId?: string): Promise<UiThreadTree> {
    const thread = sessionId ? this.requireThread(sessionId) : this.requireActive();
    return requireCapability(thread.backend, "tree", "Use /tree in Pi.").tree();
  }

  /** Moves the active thread to another entry of its tree, staying in the same session file. */
  async navigateThreadTree(entryId: string, options: { summarize?: boolean } = {}, expectedSessionId?: string): Promise<ThreadTreeNavigationResult> {
    return this.lifecycle.run("navigate-tree", async () => {
      const thread = this.requireActive();
      if (expectedSessionId && thread.threadId !== expectedSessionId) throw new Error("The selected thread changed before it could be moved.");
      const tree = requireCapability(thread.backend, "tree", "Use /tree in Pi.");
      if (thread.state.streaming) throw new Error("Wait for the active run before moving this thread.");
      const result = await tree.navigateTree(entryId, options);
      if (result.cancelled) return { ...this.actionResult([]), cancelled: true };
      this.log("thread.tree.navigated", entryId);
      const snapshot = await this.snapshot();
      const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) };
      this.emitUpdate(update);
      return { ...this.actionResult([update]), cancelled: false, ...(result.draftText ? { draftText: result.draftText } : {}) };
    });
  }

  /** Pi's /clone: a new thread continuing from the active thread's current leaf. */
  async duplicateThread(expectedSessionId?: string): Promise<HostActionResult> {
    const thread = this.requireActive();
    if (expectedSessionId && thread.threadId !== expectedSessionId) throw new Error("The selected thread changed before it could be duplicated.");
    const leafId = requireCapability(thread.backend, "tree", "Duplicate the thread in Pi instead.").leafEntryId();
    if (!leafId) throw new Error("Nothing to duplicate yet. Send a first message before duplicating this thread.");
    return this.forkThread(leafId, thread.threadId);
  }

  async exportThreadMarkdown(expectedSessionId?: string): Promise<string> {
    const thread = this.requireThread(expectedSessionId);
    // A runtime that normalizes its own transcript owns the export: re-parsing
    // here could reinterpret a visible `$skill ...` instruction as a wrapper.
    const exported = await thread.backend.capabilities.markdownExport?.exportTranscript();
    const messages = exported?.messages
      ?? (await thread.backend.transcript()).map((message) => ({ role: message.role, content: [{ type: "text", text: message.text }] }));
    const firstUserMessage = messages.find((message) => message.role === "user");
    return formatChatTranscript({
      title: safeSessionTitle(exported?.title) || safeSessionTitle(thread.state.title) || safeSessionTitle(thread.adapterTitle)
        || firstSentence(visibleTitleText(textFromContent(firstUserMessage?.content))),
      cwd: exported?.cwd ?? thread.cwd,
      threadId: exported?.threadId ?? thread.threadId,
      messages,
    });
  }

  /**
   * Resolves a prompt before the renderer creates its optimistic message. A
   * prompt for a thread that does not exist yet names the backend it wants;
   * without one, the host's default applies.
   */
  async preparePrompt(text: string, sessionId?: string, skill?: UiSkillDraft, backendKind?: ThreadBackendKind): Promise<PreparedPrompt> {
    const kind = backendKind ?? this.defaultBackendKind;
    if (!sessionId && kind !== "pi") this.requireBackend(kind);
    const target = sessionId
      ? await this.awaitThread(sessionId)
      : (this.active && threadBackendKind(this.active) === kind ? this.active : undefined);
    if (target) return target.backend.preparePrompt(text, skill);
    return this.prompts.prepare(text, skill, this.adapterFor(kind), this.composerCommandsFor(kind, this.cwd), undefined, kind);
  }

  /**
   * The backends a new thread can run on, in the one order every picker uses:
   * Pi, then registered backends by their `order`, then by registration.
   */
  runtimeBackends(): UiRuntimeBackend[] {
    const withModes = (modes: readonly string[] | undefined) => modes?.length ? { modes: [...modes] } : {};
    const registered = sortByRuntimeOrder([...this.seam.backends.values()]).map((provider) => {
      const version = this.runtimeVersions.get(provider.kind);
      return { kind: provider.kind, label: provider.label ?? provider.kind, ...(version ? { version } : {}), ...withModes(provider.adapter.capabilities.modes) };
    });
    return [{ kind: "pi", label: "Pi", ...withModes(runtimeExtensionModes(this.seam.runtimeExtensions)) }, ...registered];
  }

  /** The extension that registered a backend, for its `sign-in-state` (`readiness`). */
  runtimeBackendOwner(kind: ThreadBackendKind): string | undefined { const provider = this.seam.backends.get(kind); return provider && runtimeBackendOwner(provider); }

  /** The commands a backend's composer offers, before any thread of it exists. */
  private composerCommandsFor(kind: ThreadBackendKind, cwd: string): readonly UiComposerCommand[] {
    return kind !== "pi" ? this.externalComposerCommands(kind, cwd) : this.runtimeCommands;
  }

  async switchSession(path: string): Promise<HostActionResult> {
    // The index carries the lifecycle owner; the virtual path of an external
    // thread is the fallback for entries that predate the index.
    const indexedSession = this.index.byPath(path);
    const backendKind = indexedSession?.backendKind ?? externalThreadFromPath(path)?.kind;
    // A thread whose runtime is already live switches immediately and outside
    // the lifecycle queue: nothing is created, aborted or replaced.
    const live = this.ownedByPi(this.active) ? undefined : this.liveThreadForPath(path);
    if (live && !isUnavailableBackend(live.backend)) {
      return this.lifecycle.runActivation("live-switch", async (activation) => {
        const startedAt = performance.now();
        if (!await this.activateThread(live, false, activation.epoch)) return this.staleActivationResult();
        this.logReplacement("live-switch", startedAt);
        return this.activeUpdates(activation.epoch);
      }, "unserialized");
    }
    return this.lifecycle.runActivation("switch-thread", async (activation) => {
      const activationEpoch = activation.epoch;
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      const startedAt = performance.now();
      if ((backendKind ?? "pi") === "pi" && this.defaultBackendKind === "pi" && await this.attached.session.attach(dirname(path), path, {}, activationEpoch)) {
        if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
        this.cwd = this.attachedThread.cwd;
        await this.rememberProject(this.cwd);
        if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
        await this.refreshActiveThreadIndex(false);
        if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
        return this.activeUpdates(activationEpoch);
      }
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      this.attached.session.detach();
      await this.leaveWorkspaceFor(indexedSession?.projectPath ?? dirname(path));
      await this.threadLifecycle.beforeWorkspace(this.cwd);
      // A thread that opened read-only tries its runtime again on every switch to it.
      const unavailable = this.liveThreadForPath(path);
      if (unavailable && isUnavailableBackend(unavailable.backend)) await this.threads.release(unavailable.threadId);
      const alreadyLive = this.liveThreadForPath(path);
      this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", alreadyLive ? "warm-switch" : "cold-switch");
      try {
        const thread = alreadyLive ?? await this.runtimes.openForPath(path, "resume", false, backendKind);
        if (!await this.activateThread(thread, false, activationEpoch)) return this.staleActivationResult();
        this.logReplacement("resume", startedAt);
        return this.activeUpdates(activationEpoch);
      } finally {
        this.lifecycleMetrics.end();
      }
    });
  }

  /** Opens a thread's runtime ahead of time so switching to it is immediate. */
  async prewarmSession(path: string): Promise<void> {
    if (!this.localActive || this.safeMode || this.liveThreadForPath(path)) return;
    const backendKind = this.index.byPath(path)?.backendKind ?? externalThreadFromPath(path)?.kind;
    const startedAt = performance.now();
    try {
      await this.runtimes.openForPath(path, "resume", true, backendKind);
      this.log("runtime.prewarm.ready", basename(path));
    } catch (error) {
      this.log("runtime.prewarm.failed", this.errorMessage(error));
    } finally {
      this.recordBackgroundLifecycle("prewarm", startedAt);
    }
  }

  async prompt(
    text: string,
    attachments: UiPromptAttachment[] = [],
    sessionId?: string,
    clientMessageIdOrPreflight?: ClientTurnRequest | PromptPreflight,
    prepared?: PreparedPrompt,
    options: { hidden?: boolean } = {},
  ): Promise<void> {
    this.workbenchReload.assertAvailable();
    const onPreflightResult = typeof clientMessageIdOrPreflight === "function" ? clientMessageIdOrPreflight : undefined;
    const identity = typeof clientMessageIdOrPreflight === "function"
      ? undefined
      : clientIdentityForRequest(clientMessageIdOrPreflight);
    const clientMessageId = identity?.clientMessageId;
    const thread = await this.awaitThread(sessionId);
    // Freeze the epoch after resolving the thread. A concurrent switch changes
    // it, and the prompt must not land on a thread that was superseded.
    const promptEpoch = this.activationEpoch;
    // The switch that opened this thread may still be binding its extensions.
    await this.binding.settle(thread);
    // A prompt named for its thread goes there while another one is on screen; it only needs the thread still open.
    if (sessionId !== undefined && thread.threadId === sessionId) {
      if (this.threadFor(sessionId) !== thread) this.noRuntimeFor(sessionId);
    } else if (!this.isCurrentActivation(promptEpoch)) {
      throw new Error("The active thread changed while the prompt was being prepared. Retry after the switch completes.");
    }
    // Whatever a restart left behind, this thread is moving again.
    this.settlement.started(thread.threadId);
    if (!thread.backend.capabilities.journal) {
      // The composer waits for admission, not for the whole turn: a streamed
      // runtime reports it as soon as the message is on its way, and this call
      // returns then. What breaks after admission is reported as a failure of
      // the thread, as on the journal path.
      const preflight: { state: PromptPreflightState; rejection?: unknown } = { state: "pending" };
      let resolveAdmitted!: () => void;
      const admitted = new Promise<void>((resolve) => { resolveAdmitted = resolve; });
      const report = (result: PromptPreflightResult) => {
        if (preflight.state !== "pending") return;
        preflight.state = result.accepted ? "accepted" : "rejected";
        if (!result.accepted) preflight.rejection = result.error ?? new Error("The prompt was rejected before it started.");
        onPreflightResult?.(result);
        resolveAdmitted();
      };
      const run = this.turns.toRuntime(thread, text, attachments, "prompt", identity, prepared, (accepted) => { if (accepted) report({ accepted: true }); }, options.hidden)
        .then(() => report({ accepted: true }), (error) => {
          if (preflight.state === "pending") report({ accepted: false, error });
          else this.fail(error, thread.threadId);
        });
      await Promise.race([admitted, run]);
      if (preflight.state === "rejected") throw preflight.rejection;
      this.log("prompt.accepted", text.slice(0, 80));
      return;
    }
    this.prompts.assertAttachmentInput(thread, attachments);
    // Resolve the runtime spelling once at the backend boundary. The same
    // prepared object is then used for marker correlation and delivery, so a
    // resource-registry change cannot cause host and backend to normalize
    // different dialects for one turn.
    const resolvedPrepared = prepared ?? await thread.backend.preparePrompt(text);
    this.prompts.assertBound(thread, text, resolvedPrepared, this.projection.composerCommands(thread));
    const prompt = resolvedPrepared.runtimeText;
    const isExtensionCommand = this.projection.isExtensionCommand(thread, prompt);
    const preparedTurnId = isExtensionCommand ? undefined : randomUUID();
    const wasStreaming = thread.state.streaming;
    if (preparedTurnId) {
      this.turnObservers.accepted(thread.threadId, preparedTurnId, { deferBefore: wasStreaming });
      this.turnsInFlight.record({
        sessionId: thread.threadId, cwd: thread.cwd, turnId: preparedTurnId, backend: thread.backend.kind,
        startedAt: Date.now(), prompt: { text, ...(attachments.length ? { images: attachments.length } : {}) },
      });
      // Idle prompts prepare before Pi starts; queued prompts are prepared at
      // their actual delivery boundary, after earlier tool work has settled.
      if (!wasStreaming) await this.turnObservers.prepare(thread.threadId, preparedTurnId);
    }
    let markerActive = false;
    let preflightState: PromptPreflightState = "pending";
    let resolvePreflight!: () => void;
    let rejectPreflight!: (error: unknown) => void;
    const preflight = new Promise<void>((resolve, reject) => {
      resolvePreflight = resolve;
      rejectPreflight = reject;
    });
    const failUnpersistedMarker = () => {
      if (!markerActive) return;
      this.clientMessages.failIfUnpersisted(thread, clientMessageId);
      if (identity) this.clientTurns.cancel(thread.threadId, identity);
      markerActive = false;
    };
    const reportPreflight = (result: PromptPreflightResult) => {
      if (preflightState !== "pending") return;
      preflightState = result.accepted ? "accepted" : "rejected";
      onPreflightResult?.(result);
      if (result.accepted) resolvePreflight();
      else {
        failUnpersistedMarker();
        if (preparedTurnId) this.turnsInFlight.clear(thread.threadId, preparedTurnId);
        if (preparedTurnId) void this.turnObservers.cancelled(thread.threadId, preparedTurnId);
        rejectPreflight(result.error ?? new Error("The prompt was rejected before it started."));
      }
    };
    this.log("prompt.accepted", `${prompt.slice(0, 80)}${attachments.length ? ` · ${attachments.length} image(s)` : ""}`);
    try {
      if (identity) this.clientTurns.enqueue(thread.threadId, identity, resolvedPrepared.sourceFingerprint);
      markerActive = this.clientMessages.appendMarker(thread, clientMessageId, text, resolvedPrepared.sourceFingerprint);
      const run = thread.backend.prompt({
        text,
        delivery: "prompt",
        ...(identity ? { identity } : {}),
        prepared: resolvedPrepared,
        attachments,
        queued: wasStreaming,
        ...(options.hidden ? { hidden: true } : {}),
        onAdmitted: (accepted) => reportPreflight({ accepted }),
      });
      void run.then(async () => {
        if (preflightState === "pending") reportPreflight({ accepted: true });
        if (preparedTurnId) this.turnsInFlight.clear(thread.threadId, preparedTurnId);
        if (preparedTurnId) await this.turnObservers.ended(thread.threadId, preparedTurnId, "completed");
        if (this.threads.get(thread.threadId)?.runtime === thread) await this.index.refreshShell(thread, true);
      }).catch((error) => {
        if (preflightState === "pending") reportPreflight({ accepted: false, error });
        else if (preflightState === "accepted") {
          if (preparedTurnId) this.turnsInFlight.clear(thread.threadId, preparedTurnId);
          if (preparedTurnId) void this.turnObservers.ended(thread.threadId, preparedTurnId, "failed");
          if (!thread.deferError(error)) this.fail(error, thread.threadId);
        }
      });
    } catch (error) {
      if (this.threads.get(thread.threadId)?.runtime !== thread) return;
      if (preparedTurnId) this.turnsInFlight.clear(thread.threadId, preparedTurnId);
      if (preparedTurnId) await this.turnObservers.cancelled(thread.threadId, preparedTurnId);
      if (identity) this.clientTurns.cancel(thread.threadId, identity);
      reportPreflight({ accepted: false, error });
    }
    // Reaching here means preflight accepted; a rejection throws out of the await.
    await preflight;
    // An extension command is answered without a user message or an agent run.
    // Its marker would otherwise label the next turn and be reported as a lost
    // message by agent_settled, and the client would wait for a turn that never
    // persists.
    if (isExtensionCommand && markerActive) {
      if (clientMessageId && this.clientMessages.persistedIds(thread).has(clientMessageId)) {
        this.clientMessages.forget(thread, clientMessageId);
      } else {
        this.clientMessages.cancelMarker(thread, clientMessageId);
      }
      if (identity) this.clientTurns.cancel(thread.threadId, identity);
      markerActive = false;
      if (clientMessageId) {
        this.emit({ type: "prompt-without-user-turn", sessionId: thread.threadId, clientMessageId });
      }
    }
    if ((!wasStreaming || isExtensionCommand) && markerActive && (preflightState as PromptPreflightState) !== "accepted") failUnpersistedMarker();
  }

  async runShellAction(command: string, includeInContext = false, expectedCwd?: string): Promise<ShellActionResult> {
    this.workbenchReload.assertAvailable();
    const shellCommand = command.trim();
    if (!shellCommand) throw new Error("An action command is required.");
    const thread = await this.lifecycle.run("shell-action", async () => {
      if (expectedCwd && this.cwd !== expectedCwd) {
        throw new Error("The selected project did not finish loading. Run the action again.");
      }
      return this.requireActive();
    });
    await this.binding.settle(thread);
    const shell = requireCapability(thread.backend, "shellAction", "Run project actions in Pi instead.");
    if (shell.isRunning()) throw new Error("Another project action is already running.");
    const result = await shell.run(shellCommand, includeInContext);
    if (this.threads.get(thread.threadId)?.runtime === thread) {
      await this.index.refreshShell(thread, true);
      const snapshot = await this.snapshot();
      this.emitUpdate({
        version: HOST_PROTOCOL_VERSION,
        type: "thread-detail",
        detail: this.detailForSnapshot(snapshot),
      });
    }
    this.log("action.shell", `${result.exitCode ?? "cancelled"} · ${shellCommand}`);
    return {
      output: boundedToolOutput(result.output),
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
    };
  }

  async steer(
    text: string,
    attachments: UiPromptAttachment[] = [],
    sessionId?: string,
    clientMessageIdOrIdentity?: ClientTurnRequest,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    await this.turns.queued("steer", text, attachments, sessionId, clientMessageIdOrIdentity, prepared);
  }

  async followUp(
    text: string,
    attachments: UiPromptAttachment[] = [],
    sessionId?: string,
    clientMessageIdOrIdentity?: ClientTurnRequest,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    await this.turns.queued("followUp", text, attachments, sessionId, clientMessageIdOrIdentity, prepared);
  }

  async abort(sessionId?: string): Promise<void> {
    const thread = this.threadFor(sessionId);
    if (!thread) return;
    await this.abortThread(thread);
  }

  /**
   * Stops one thread's run. Its open questions and approvals are settled first:
   * Pi's abort waits for the run to go idle, and a tool blocked on an unanswered
   * question would otherwise hold that wait open indefinitely.
   */
  private async abortThread(thread: ThreadRuntime): Promise<void> {
    this.extensionUi.cancelFor(thread.threadId);
    thread.adapterAbortGeneration += 1;
    for (const controller of thread.adapterAbortControllers) controller.abort();
    this.queue.hold(thread.threadId);
    await thread.backend.abort();
  }

  async setModel(provider: string, id: string): Promise<HostActionResult> {
    const thread = this.requireActive();
    await requireCapability(thread.backend, "catalogWrite").setModel(provider, id);
    if (this.threads.get(thread.threadId)?.runtime === thread) await this.index.publishModelProvider(thread);
    this.log("model.changed", `${provider}/${id}`);
    return this.catalogResult();
  }

  async setThinkingLevel(level: string): Promise<HostActionResult> {
    await requireCapability(this.requireActive().backend, "catalogWrite").setThinkingLevel(level);
    this.log("thinking.changed", level);
    return this.catalogResult();
  }

  async setMode(mode: string, expectedSessionId?: string): Promise<HostActionResult> {
    const thread = expectedSessionId ? await this.awaitThread(expectedSessionId) : this.requireActive();
    await requireCapability(thread.backend, "mode").set(mode);
    this.log("mode.changed", mode);
    return thread === this.active ? this.catalogResult() : this.actionResult([]);
  }

  private async catalogResult(): Promise<HostActionResult> {
    const catalog = { version: HOST_PROTOCOL_VERSION, type: "catalog" as const, catalog: await this.activeCatalog() };
    this.emitUpdate(catalog);
    return this.actionResult([catalog]);
  }

  /** `catalogFromSnapshot(await this.snapshot())` without projecting the transcript. */
  private async activeCatalog(): Promise<HostCatalog> {
    this.ensureCompletionModels();
    this.runtimeVersions.refresh();
    const models = await this.ensureModels();
    return {
      ...this.projection.catalog(this.active, models, this.extensionCount),
      ...(this.completionModels ? { completionModels: [...this.completionModels] } : {}),
      runtimeBackends: this.runtimeBackends().map((backend) => ({ ...backend })),
      ...(this.defaultBackendKind ? { defaultBackendKind: this.defaultBackendKind } : {}),
    };
  }

  async renameThread(rawTitle: string, expectedSessionId?: string): Promise<HostActionResult> {
    const title = rawTitle.trim();
    if (!title) throw new Error("Thread titles cannot be empty.");
    if (title.length > 120) throw new Error("Thread titles must be 120 characters or fewer.");
    const thread = this.requireThread(expectedSessionId);
    return this.actionResult([await this.applyThreadTitle(thread, title, "renamed")]);
  }

  /** Stores a title on the thread's backend and publishes the renamed shell. */
  private async applyThreadTitle(thread: ThreadRuntime, title: string, source: "generated" | "renamed"): Promise<HostUpdate> {
    await thread.backend.setTitle(title, source);
    if (source === "renamed") {
      const state = thread.state;
      thread.adapterTitle = state.title;
      thread.adapterTitleSource = state.titleSource;
      return this.index.publishTitle(thread.threadId, state.title ?? title);
    }
    thread.adapterTitle = title;
    thread.adapterTitleSource = "generated";
    return this.index.publishTitle(thread.threadId, title);
  }

  prepareWorkbenchReload(mode: import("../shared/contracts.js").WorkbenchReloadMode): Promise<import("../shared/contracts.js").WorkbenchReloadPreparation> { return this.workbenchReload.prepare(mode); }
  async releaseWorkbenchReload(): Promise<void> { this.workbenchReload.release(); }

  async reloadRuntime(): Promise<void> {
    return this.lifecycle.run("reload-runtime", async () => {
      const thread = this.requireActive();
      const reload = requireCapability(thread.backend, "reload");
      // A runtime the host does not own reloads in its own process; the caches
      // below are the host's, and it has none of them for that thread.
      if (!isLocalPiRuntime(thread)) {
        await reload.reload();
        this.log("runtime.reload.requested", "runtime owner");
        return;
      }
      if (thread.state.streaming) throw new Error("Wait for the active run before reloading Pi.");
      await reload.reload();
      this.modelCatalogCache.invalidate();
      this.runtimes.invalidateResources();
      // Other idle runtimes still hold the old resources; they are cheap to
      // rebuild on demand, so drop them rather than reload each one.
      this.prewarm.discardSpare();
      for (const record of this.threads.list()) {
        if (record.runtime !== thread && isLocalPiRuntime(record.runtime)
          && record.runtime.state.idle
          && this.turnObservers.pending(record.threadId) === 0
          && !this.extensionUi.hasOpen(record.threadId)) {
          await this.threads.release(record.threadId);
        }
      }
      this.extensionCount = thread.state.extensionCount;
      // The manual fallback restarts every package, however unchanged it looks.
      await this.packages?.refresh({ force: true });
      this.log("runtime.reloaded");
      const snapshot = await this.snapshot();
      for (const update of this.lifecycleUpdates(snapshot)) this.emitUpdate(update);
      this.prewarm.scheduleThreads();
      this.prewarm.scheduleSpare(this.cwd);
    });
  }

  async compactContext(): Promise<HostActionResult> {
    await requireCapability(this.requireActive().backend, "compaction").compact();
    this.log("context.compacted");
    const snapshot = await this.snapshot();
    const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) };
    this.emitUpdate(update);
    return this.actionResult([update]);
  }

  async snapshot(): Promise<HostSnapshot> {
    this.ensureCompletionModels();
    this.runtimeVersions.refresh();
    const models = await this.ensureModels();
    return { ...this.snapshotSync(models), projectLabel: this.projects.label(this.cwd) };
  }

  /** Workspace metadata is only exposed for projects already admitted by the host. */
  private async knownWorkspacePath(cwd: string): Promise<string> {
    return findKnownWorkspacePath(this.resolveWorkspacePath(cwd), new Set([
      this.cwd,
      ...this.projectHistory.list().map((project) => project.path),
      ...this.index.list().map((session) => session.projectPath),
      ...this.threads.list().map((thread) => thread.cwd),
      ...this.admittedWorkspaces,
    ]));
  }

  private admitWorkspace(path: string): WorkspaceRef {
    this.admittedWorkspaces.add(path);
    return this.workspaces.ref(path);
  }

  async dispose(): Promise<void> {
    // Before anything is torn down: the aborts below are this shutdown's, not
    // the user's, and a thread they stop is exactly one a restart must see.
    this.turnsInFlight.freeze();
    this.queue.freeze(); this.limits.freeze();
    return this.lifecycle.run("dispose", async () => {
      this.clientTurns.clear();
      this.watch?.close();
      this.threads.stopIdleRelease();
      this.prewarm.dispose();
      this.catalogs.dispose();
      this.trash.dispose();
      const teardownErrors: unknown[] = [];
      this.attached.session.detach();
      // Before the extensions are torn down: a hook that releases what belongs
      // to a workspace still has to run, and nothing reopens after this.
      for (const cwd of new Set([this.cwd, ...this.threads.list().map((thread) => thread.cwd)])) {
        await this.closeWorkspace(cwd, "shutdown");
      }
      try { await this.hostExtensions.dispose(); } catch (error) { teardownErrors.push(error); }
      await this.seam.mcp.close();
      try { await this.prewarm.discardSpare(); } catch (error) { teardownErrors.push(error); }
      await this.runtimes.settleOpening();
      const results = await Promise.allSettled(this.threads.list().map((record) => this.threads.release(record.threadId)));
      for (const result of results) if (result.status === "rejected") teardownErrors.push(result.reason);
      try {
        await this.projectHistory.flush();
      } catch (error) {
        teardownErrors.push(error);
      }
      try {
        await this.index.dispose();
      } catch (error) {
        teardownErrors.push(error);
      }
      if (teardownErrors.length > 0) {
        throw new AggregateError(teardownErrors, "Pi runtime shutdown failed");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Thread runtime lifecycle
  // ---------------------------------------------------------------------------

  private async adoptThread(thread: ThreadRuntime): Promise<void> {
    await this.threads.adopt({ threadId: thread.threadId, cwd: thread.cwd, runtime: thread, isolation: "in-process" });
  }

  /** Puts a live thread on screen. Cheap: it changes pointers and publishes state. */
  private async activateThread(
    thread: ThreadRuntime,
    touch: boolean,
    activationEpoch = this.activationEpoch,
  ): Promise<boolean> {
    return this.activation.promote(thread, touch, this.lifecycle.activation(activationEpoch));
  }

  private async publishActiveCatalog(): Promise<void> {
    this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: await this.activeCatalog() });
  }

  private async rememberProject(cwd: string): Promise<void> {
    await this.workspaces.learn(cwd);
    await this.projectHistory.remember(cwd, await this.projects.loadName(cwd));
  }

  private publishLabel(cwd: string, label: string | undefined): void {
    if (cwd === this.cwd) {
      this.projectLabel = label;
      this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd, label }, ...(this.active ? { sessionId: this.active.threadId } : {}) });
    }
    this.index.publishLabel(cwd, label);
  }

  private recordBackgroundLifecycle(name: string, startedAt: number): void {
    this.report.recordBackground(name, startedAt);
  }

  // ---------------------------------------------------------------------------
  // Session events. Every live runtime reports through here; the thread it
  // belongs to travels with each event so the renderer can scope it.
  // ---------------------------------------------------------------------------

  private handleSessionEvent(
    event: any,
    thread: LiveTurnState,
    sessionId: string,
    cwd: string,
  ): void {
    handleRuntimeSessionEvent(event, thread, sessionId, cwd, {
      clientTurns: this.clientTurns,
      emit: (next) => this.emit(next),
      emitUpdate: (update) => this.emitUpdate(update),
      log: (label, detail) => this.log(label, detail),
      fail: (error, owner) => this.fail(error, owner),
      settledSnapshot: () => this.snapshot(),
      detailForSnapshot: (snapshot) => this.detailForSnapshot(snapshot),
      trackedClientMessageIds: (runtime) => this.clientMessages.trackedIds(runtime),
      failClientMessageIfUnpersisted: (runtime, id, owner) => { this.clientMessages.failIfUnpersisted(runtime, id, owner); },
      correlateUserMessageStart: (runtime, message, owner) => this.clientMessages.correlateStart(runtime, message, owner),
      decorateUserEvent: (runtime, message) => this.clientMessages.decorateUserEvent(runtime, message),
      messageMappingOptions: (runtime) => this.projection.mapping(runtime),
      pinnedEntries: (runtime) => this.projection.pinnedEntries(runtime),
      ownTool: (id, owner) => this.toolOwners.set(id, owner),
      releaseTool: (id) => { this.toolOwners.delete(id); },
      pushToolOutput: (id, output) => this.pushToolOutput(id, output),
      toolEnded: (owner, tool, toolCwd) => this.turnObservers.toolEnded(owner, tool, toolCwd),
      turnSettled: (owner, error) => this.settlement.settled(owner, error),
    });
  }

  /** The transport coalesces these per tool; the host sends each one on. */
  private pushToolOutput(toolCallId: string, output: string): void {
    this.emit({ type: "tool-update", sessionId: this.toolOwners.get(toolCallId) ?? "", id: toolCallId, output });
  }

  /** A streamed external backend reports in Tau's dialect; the same bookkeeping applies. */
  private handleBackendEvent(threadId: string, event: ThreadRuntimeEvent): void {
    const thread = this.threads.get(threadId)?.runtime;
    if (!thread) return;
    handleBackendRuntimeEvent(event, thread, {
      clientTurns: this.clientTurns,
      emit: (next) => this.emit(next),
      emitUpdate: (update) => this.emitUpdate(update),
      log: (label, detail) => this.log(label, detail),
      fail: (error, owner) => this.fail(error, owner),
      settledSnapshot: () => this.snapshot(),
      detailForSnapshot: (snapshot) => this.detailForSnapshot(snapshot),
      ownTool: (id, owner) => this.toolOwners.set(id, owner),
      releaseTool: (id) => { this.toolOwners.delete(id); },
      pushToolOutput: (id, output) => this.pushToolOutput(id, output),
      toolEnded: (owner, tool, toolCwd) => this.turnObservers.toolEnded(owner, tool, toolCwd),
      refreshShell: (runtime, touch) => this.index.refreshShell(runtime, touch),
      turnSettled: (owner, error, limit) => this.settlement.settled(owner, error, limit),
    });
  }

  /**
   * The catalog a kit's small jobs may name. Building it opens the user's model
   * runtime, which is too slow to hold up a snapshot, so the first snapshot
   * goes without and a catalog update carries it a moment later.
   */
  private ensureCompletionModels(): void {
    if (this.completionModels || this.completionModelsPending) return;
    this.completionModelsPending = true;
    void this.completions.models()
      .then((models) => {
        this.completionModels = models;
        return this.publishActiveCatalog();
      })
      .catch(() => { this.completionModels = []; });
  }

  private async ensureModels(): Promise<UiModel[]> {
    const active = this.active;
    if (!active) return [];
    // Only a runtime the host builds itself pays for a catalog scan; every
    // other one answers from what it already holds.
    if (!isLocalPiRuntime(active)) return active.backend.models();
    const key = this.runtimes.fingerprint(this.cwd);
    const cached = this.modelCatalogCache.get(key);
    if (cached) return cached;
    const models = await active.backend.models();
    this.modelCatalogCache.set(key, models);
    return models;
  }

  /** What a runtime offers a thread that does not exist yet, from the host's cache (`RuntimeCatalogs`). */
  runtimeCatalog(kind: ThreadBackendKind): Promise<UiRuntimeCatalog | undefined> { return this.catalogs.get(kind); }
  /** Every runtime's the client does not hold (`known`); `revalidate` asks again behind the answer those some minutes old. */
  runtimeCatalogs(revalidate = false, known?: Record<string, number>): Promise<UiRuntimeCatalog[]> { return this.catalogs.list(revalidate, known); }
  /** The user edited `modelPrices`; totals already published are worked out again. */
  modelPricesChanged(): void { this.pricing.reloadPrices(); }
  /** `extensions.watch` changed: follow Tau's files again, or stop. */
  async watchingChanged(): Promise<void> { await this.watch?.retarget(); }
  /** Tau wrote its config: kits that read it hear so even while watching is off. */
  configWritten(paths: readonly string[]): void { this.seam.notifyConfigChange({ kind: "config", paths }); }

  async modelsConfig(): Promise<CustomProviderConfig[]> {
    return loadModelsConfig(this.agentDir);
  }

  async addModelProvider(input: CustomProviderInput): Promise<UiModel[]> {
    await addModelProvider(this.agentDir, input);
    this.modelCatalogCache.invalidate();
    await this.publishActiveCatalog();
    return this.ensureModels();
  }

  async inspectSystemPrompt(threadId?: string, cwd?: string): Promise<SystemPromptInspection> {
    const thread = (threadId ? this.threadFor(threadId) : undefined) ?? this.active;
    if (thread?.backend.capabilities.systemPrompt) {
      return await thread.backend.capabilities.systemPrompt.inspect();
    }
    const targetCwd = cwd || thread?.cwd || this.cwd;
    const overrides = discoverPromptOverrides(targetCwd, this.agentDir);
    return {
      effectivePrompt: overrides.customPrompt?.content ?? "(No active thread — showing project configuration)",
      ...(overrides.customPrompt ? { basePrompt: overrides.customPrompt.content, basePromptSource: overrides.customPrompt.path } : {}),
      appends: overrides.appendPrompts.map((p) => ({ text: p.content, source: p.path })),
      contextFiles: overrides.contextFiles,
    };
  }

  /** Prompt completion updates one shell; the global scan is a startup/recovery path. */
  private async refreshActiveThreadIndex(touch = true): Promise<void> {
    const thread = this.active;
    if (!thread) return;
    await this.index.refreshShell(thread, touch);
  }

  /** Commands of an external backend; a supplied catalog is re-spelled in the backend's dialect. */
  private externalComposerCommands(kind: ThreadBackendKind, cwd: string): UiComposerCommand[] {
    const provider = this.requireBackend(kind);
    if (this.runtimeCommands.length > 0) return composerCommandsForAdapter(this.runtimeCommands, provider.adapter);
    return provider.composerCommands(cwd);
  }

  private snapshotSync(models: UiModel[]): HostSnapshot {
    return {
      ...this.projection.hostSnapshot(this.active, models, this.cwd, this.extensionCount),
      ...(this.completionModels ? { completionModels: this.completionModels } : {}),
      ...this.workspaces.ref(this.cwd),
      runtimeBackends: this.runtimeBackends(),
      defaultBackendKind: this.defaultBackendKind,
    };
  }

  /** Identity and display of one workspace, as every published shape carries it. */
  private projectMetadata(cwd: string, label?: string): ProjectMetadata {
    return this.publication.projectMetadata(cwd, label);
  }

  /** The workspace a client named, by id or — for a client that still sends paths — by path. */
  resolveWorkspacePath(value: string): string {
    return this.workspaces.pathFor(value);
  }
  answerExtensionUi(id: string, answer: ExtensionUiAnswer): void {
    this.extensionUi.answer(id, answer);
  }

  /** Re-announces questions raised before the renderer was listening. */
  replayOpenUiPrompts(): void {
    this.extensionUi.replay();
  }
  private logRuntimePhase(phase: string, startedAt: number, reason: string, cwd: string, note?: string, thread?: ThreadRuntime): void {
    this.report.runtimePhase(phase, startedAt, reason, cwd, note, thread);
  }

  /** The same event without the critical-path measurement, for phases that run in the background. */
  private logPhaseEvent(phase: string, startedAt: number, reason: string, cwd: string, note?: string, thread?: ThreadRuntime): void {
    this.report.phaseEvent(phase, startedAt, reason, cwd, note, thread);
  }

  private logReplacement(reason: string, startedAt: number): void {
    this.report.replacement(reason, startedAt);
  }
  /** Every client titles its own window, so a host in another process reaches each of them. */
  private publishWindowTitle(title: string): void {
    this.windowTitle = title;
    this.emit({ type: "window-title", title });
  }

  private emitUpdate(update: HostUpdate): void {
    this.emit({ type: "host-update", update });
  }

  private emitForThread(thread: ThreadRuntime | undefined, event: ThreadHostEvent): void {
    if (thread?.deferHostEvent(event)) return;
    this.emit(event);
  }
  private log(label: string, detail?: string): void {
    this.report.log(label, detail);
  }

  private logForThread(thread: ThreadRuntime, label: string, detail?: string): void {
    this.report.logForThread(thread, label, detail);
  }
  private errorMessage(error: unknown): string {
    return this.report.errorMessage(error);
  }

  private fail(error: unknown, sessionId?: string, thread?: ThreadRuntime): void {
    this.report.fail(error, sessionId, thread);
  }
}
