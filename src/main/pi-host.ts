import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { getAgentDir, SessionManager, type SettingsManager } from "@earendil-works/pi-coding-agent";
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
  UiPromptAttachment,
  SubmissionResult,
  UiSkillDraft,
  NewThreadRequestId,
  ThreadBackendKind,
  PreparedPrompt,
  ThreadTreeNavigationResult,
  UiThreadTree,
} from "../shared/contracts.js";
import { createNewThreadRequestId, type ClientTurnIdentity } from "../shared/contracts.js";
import {
  HOST_PROTOCOL_VERSION,
  catalogFromSnapshot,
  detailFromSnapshot,
  type HostActionResult,
  type HostUpdate,
  type NewThreadResult,
  type ProjectMetadata,
  type ThreadDetail,
  type TranscriptPage,
} from "../shared/host-protocol.js";
import { formatChatTranscript } from "../shared/chat-transcript.js";
import { taskProgressHistoryFromMessages } from "../shared/task-progress.js";
import { ThreadDetailStore } from "../shared/thread-detail-store.js";
import { HostLifecycleInstrumentation } from "./host-lifecycle.js";
import { RuntimeResourceCache } from "./runtime-resource-cache.js";
import { ExtensionPackageActivator } from "./extension-package-activation.js";
import { findDanglingToolCalls } from "./dangling-tool-calls.js";
import { resolvePiSessionsDirOverride } from "./pi-session-dir.js";
import { ThreadRuntimeRegistry } from "./thread-runtimes.js";
import {
  HostExtensionRegistry,
  HostThreadLifecycleSet,
  HostTurnObserverSet,
  type HostExtension,
  type HostPlatform,
  type HostPreparedThread,
  type HostRuntimeBackendProvider,
  type HostSessionFile,
  type HostStartedThread,
  type HostThread,
  type HostThreadStartOptions,
  type HostUiPresenter,
  type RuntimeSessionInfo,
} from "./host-extensions.js";
import { ProjectHistory } from "./project-history.js";
import { ProjectFactsCache } from "./project-facts-cache.js";
import { ThreadIndex } from "./thread-index.js";
import { ThreadBinding } from "./thread-binding.js";
import { ThreadRuntimeLifecycle } from "./thread-runtime-lifecycle.js";
import { RuntimePrewarm } from "./runtime-prewarm.js";
import { ToolOutputBatcher } from "./tool-output-batcher.js";
import { promptImages } from "./prompt-attachments.js";
import { AttachedThreadBackend } from "./attached-thread-backend.js";
import {
  createAttachedSessionHost,
  createHostExtensionSeam,
  type AttachedSessionPort,
  type ExtensionServicesPort,
  type HostExtensionSeam,
} from "./host-ports.js";
import { findPiBridge } from "./pi-bridge-client.js";
import { composerCommandsForAdapter } from "./bridge-snapshot.js";
import type { LiveTurnState } from "./live-turn-state.js";
import { ThreadRuntime, isLocalPiRuntime, threadBackendKind } from "./thread-runtime.js";
import { LifecycleQueue } from "./lifecycle-queue.js";
import { requireCapability } from "./runtime-types.js";
import { localTranscriptCursorPolicy, localTranscriptPage, readLocalToolOutput } from "./host-transcript.js";
import { handleRuntimeSessionEvent } from "./session-events.js";
import { ClientMessageTracker } from "./client-message-tracker.js";
import { ThreadProjection } from "./thread-projection.js";
import { ExtensionUiCoordinator } from "./extension-ui-coordinator.js";
import type { PiHostOptions } from "./pi-host-options.js";
import { PhaseTimer, promptRebindForThread, clientIdentityForRequest, externalThreadFromPath, findKnownWorkspacePath, processIsAlive, samePath, type ClientTurnRequest } from "./pi-host-support.js";
export type { PiHostOptions } from "./pi-host-options.js";
export { workspaceLabel } from "./pi-host-support.js";
import { markTauHostRuntime } from "./tau-runtime-owner.js";
import { WorkspaceIdentity } from "./workspace-identity.js";
import { randomBytes } from "node:crypto";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { ClientTurnLedger } from "./client-turn-ledger.js";
import {
  prepareSkillPrompt,
  skillMessagePresentation,
} from "./skill-invocation.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import { validatePreparedPrompt } from "../shared/prepared-prompt.js";
import { WorkbenchReloadCoordinator } from "./workbench-reload-coordinator.js";
import { assertRuntimeAdapter, PI_AGENT_RUNTIME_ADAPTER, type AgentRuntimeAdapter } from "./runtime-adapters.js";
import type { HostLogger } from "./host-log.js";
import {
  textFromContent,
  turnActivityHistoryFromMessages,
  firstSentence,
  visibleTitleText,
  safeSessionTitle,
  boundedToolOutput,
} from "./host-messages.js";
/** Live Pi runtimes kept in memory; idle ones beyond this are released oldest first. */
const MAX_LIVE_THREADS = 6;

type Emit = (event: HostEvent) => void;
interface PromptPreflightResult {
  accepted: boolean;
  error?: unknown;
}
type PromptPreflight = (result: PromptPreflightResult) => void;
type PromptPreflightState = "pending" | "accepted" | "rejected";

export class PiHost {
  private cwd: string;
  /** Pi is the built-in backend; every other kind comes from a registered provider. */
  private readonly piAdapter: AgentRuntimeAdapter;
  private readonly defaultBackendKind: ThreadBackendKind;
  private readonly runtimeCommands: readonly UiComposerCommand[];
  private emit: Emit;
  /** Correlates raw Pi user-message events with renderer sends. */
  private readonly clientTurns = new ClientTurnLedger();
  private readonly clientMessages: ClientMessageTracker;
  private readonly projection: ThreadProjection;
  private readonly extensionUi: ExtensionUiCoordinator;
  /**
   * The thread a Pi terminal owns while Tau follows it, and its runtime record.
   * That record lives beside the registry, because Pi owns it and Tau does not.
   */
  private readonly attached: AttachedThreadBackend;
  private readonly attachedThread: ThreadRuntime;
  private readonly agentDir = getAgentDir();
  /** PI_CODING_AGENT_SESSION_DIR, resolved once; undefined keeps Pi's own default sessions layout. */
  private readonly sessionsDirOverride = resolvePiSessionsDirOverride();
  private extensionCount = 0;
  private readonly lifecycleMetrics = new HostLifecycleInstrumentation();
  /** Everything host extensions contribute; only the seam writes those registries. */
  private readonly seam: HostExtensionSeam;
  private readonly hostExtensions: HostExtensionRegistry;
  /** Resolved on the first activation when it arrived as a thunk. */
  private pendingHostExtensions: readonly HostExtension[] | (() => Promise<readonly HostExtension[]>);
  /** The host halves of installed packages; absent in safe mode, where no package loads. */
  private readonly packages?: ExtensionPackageActivator;
  /** Mints and resolves the ids clients name workspaces by. */
  private readonly workspaces: WorkspaceIdentity;
  private readonly platform: HostPlatform;

  /** Root of the folders host extensions keep their own state in. */
  private readonly kitStateDir: string;
  private readonly logger?: HostLogger;
  private readonly modelCatalogCache = new RuntimeResourceCache<UiModel[]>({ maxEntries: 8, ttlMs: 5 * 60_000 });
  private readonly threads = new ThreadRuntimeRegistry<ThreadRuntime>({
    maxLive: MAX_LIVE_THREADS,
    // A thread with work in flight, an open question, or nothing saved yet has
    // state that only its runtime holds; releasing it would lose that state.
    canEvict: (record) => record.runtime.state.idle
      && !this.extensionUi.hasOpen(record.threadId)
      && record.runtime.adapterPending === 0
      && !record.runtime.adapterStreaming
      && this.turnObservers.pending(record.threadId) === 0
      // An external runtime owns its transcript in the app-data store rather
      // than in Pi's message array. It is therefore safe to release once its
      // own visible projection has been persisted.
      && (record.runtime.state.hasMessages || (record.runtime.adapterMessages?.length ?? 0) > 0),
    dispose: (record) => this.runtimes.dispose(record.runtime),
  });
  private preparedThreadCapabilityGeneration = 0;
  private readonly backgroundLifecycle: Array<{ name: string; durationMs: number }> = [];
  /** Serialises thread lifecycle work; reentrant, so a hook of one operation cannot wait for it. */
  private readonly lifecycle = new LifecycleQueue({
    onSlow: (operation, elapsedMs) => this.log("lifecycle.slow", `${operation} · ${Math.round(elapsedMs / 100) / 10}s`),
  });
  private readonly workbenchReload = new WorkbenchReloadCoordinator({
    runs: () => [...this.threads.list().map((record) => record.runtime), this.attachedThread]
      .filter((thread) => !thread.state.idle || thread.state.streaming || thread.adapterPending > 0 || thread.adapterStreaming)
      .map((thread) => ({ waitForIdle: () => thread.backend.waitForIdle(), abort: () => this.abortThread(thread) })),
    serialize: (operation) => this.lifecycle.run("workbench-reload", operation),
  });
  /** Monotonic ownership epoch; stale lifecycle work may not publish or activate. */
  private activationEpoch = 0;
  private readonly detailStore = new ThreadDetailStore(5);
  private projectLabel?: string;
  /** What extensions know about projects: name, label, nesting, all cached. */
  private readonly projects = new ProjectFactsCache({
    onLabel: (cwd, label) => this.publishLabel(cwd, label),
    onNesting: () => this.index.publishSnapshotSoon(),
    recordBackground: (name, startedAt) => this.recordBackgroundLifecycle(name, startedAt),
    log: (label, detail) => this.log(label, detail),
    errorMessage: (error) => this.errorMessage(error),
  });
  /** Every persisted thread, the shell it is drawn as, and the publication of both. */
  private readonly index: ThreadIndex;
  /** Tau's dialog surface inside a runtime's extensions, and the events it lets through. */
  private readonly binding: ThreadBinding;
  /** A thread's runtime from build to teardown. */
  private readonly runtimes: ThreadRuntimeLifecycle;
  /** Runtimes built before anyone asks for them: the spare, and the neighbours of the thread on screen. */
  private readonly prewarm: RuntimePrewarm;
  /** Set by the app shell so extensions can retitle the window. */
  onWindowTitle?: (title: string) => void;
  private readonly toolOutputBatcher: ToolOutputBatcher;
  private readonly toolOwners = new Map<string, string>();
  /** Extensions stepping into thread opening, forking, activation and the index sweep. */
  private readonly threadLifecycle = new HostThreadLifecycleSet();
  private readonly turnObservers = new HostTurnObserverSet();
  constructor(
    cwd: string,
    emit: Emit,
    private readonly projectHistory: ProjectHistory,
    private readonly safeMode = false,
    private readonly automaticPrewarm = true,
    options: PiHostOptions = {},
  ) {
    this.cwd = cwd;
    this.piAdapter = assertRuntimeAdapter(this.safeMode ? PI_AGENT_RUNTIME_ADAPTER : options.runtimeAdapter ?? PI_AGENT_RUNTIME_ADAPTER);
    if (this.piAdapter.id !== "pi") throw new Error("The host's own runtime adapter must be Pi; other backends come from host extensions.");
    this.defaultBackendKind = this.safeMode ? "pi" : options.defaultBackendKind ?? "pi";
    this.runtimeCommands = options.runtimeCommands ?? [];
    this.pendingHostExtensions = this.safeMode ? [] : options.hostExtensions ?? [];
    this.workspaces = options.workspaceIdentity ?? new WorkspaceIdentity(randomBytes(16).toString("hex"));
    this.platform = options.platform ?? {};
    this.kitStateDir = options.kitStateDir ?? join(tmpdir(), "tau-kit-state");
    this.logger = options.logger;
    this.index = new ThreadIndex({
      cwd: () => this.cwd,
      safeMode: this.safeMode,
      sessionsDir: this.sessionsDirOverride,
      projects: this.projects,
      workspaces: this.workspaces,
      projectHistory: this.projectHistory,
      threadLifecycle: this.threadLifecycle,
      backends: () => this.seam.backends,
      liveThreads: () => this.threads.list().map((record) => record.runtime),
      hostThread: (thread) => this.hostThreadFor(thread),
      emit: (event) => this.emit(event),
      emitUpdate: (update) => this.emitUpdate(update),
      log: (label, detail) => this.log(label, detail),
      fail: (error) => this.fail(error),
      errorMessage: (error) => this.errorMessage(error),
    }, {
      ...(options.sessionUsageCachePath ? { usageCachePath: options.sessionUsageCachePath } : {}),
      ...(options.sessionLineageCachePath ? { lineageCachePath: options.sessionLineageCachePath } : {}),
      ...(this.logger ? { logger: this.logger } : {}),
    });
    const port = this.hostPort();
    this.seam = createHostExtensionSeam(port);
    this.hostExtensions = new HostExtensionRegistry(this.seam.services, (event) => this.emit(event));
    const loadPackages = this.safeMode ? undefined : options.hostExtensionPackages;
    this.packages = loadPackages && new ExtensionPackageActivator({
      registry: this.hostExtensions,
      load: loadPackages,
      cwd: () => this.cwd,
      agentDir: this.agentDir,
      bundled: (id) => Array.isArray(this.pendingHostExtensions) && this.pendingHostExtensions.some((extension) => extension.id === id),
      log: (label, detail) => this.log(label, detail),
      publish: (event) => this.emit(event),
      ...(options.grantsFilePath ? { grantsFilePath: options.grantsFilePath } : {}),
    });
    this.attached = new AttachedThreadBackend(createAttachedSessionHost(port));
    this.attachedThread = new ThreadRuntime(this.attached);
    this.projection = new ThreadProjection(
      this.clientTurns,
      () => this.attached.session.snapshot,
      this.seam.entryPins,
      (thread) => this.hostThreadFor(thread),
      (error) => this.log("host-extension.pins.failed", this.errorMessage(error)),
    );
    this.extensionUi = new ExtensionUiCoordinator(
      (thread, event) => this.emitForThread(thread, event),
      (thread, label, detail) => thread ? this.logForThread(thread, label, detail) : this.log(label, detail),
    );
    this.clientMessages = new ClientMessageTracker(
      this.clientTurns,
      (thread) => knownSkillNames(this.projection.composerCommands(thread)),
      (thread) => this.projection.mapping(thread),
      (event) => this.emit(event),
    );
    this.binding = new ThreadBinding({
      extensionUi: this.extensionUi,
      clientTurns: this.clientTurns,
      clientMessages: this.clientMessages,
      turnObservers: this.turnObservers,
      projection: this.projection,
      isActive: (thread) => this.active === thread,
      isCurrent: (thread) => this.threads.get(thread.threadId)?.runtime === thread,
      onSessionEvent: (event, thread, threadId, threadCwd) => this.handleSessionEvent(event, thread, threadId, threadCwd),
      emitForThread: (thread, event) => this.emitForThread(thread, event),
      presentUi: (method, ...args) => this.presentUi(method, ...args),
      setWindowTitle: (title) => this.onWindowTitle?.(title),
      publishActiveCatalog: () => this.publishActiveCatalog(),
      recordBackground: (name, startedAt) => this.recordBackgroundLifecycle(name, startedAt),
      logPhase: (phase, startedAt, reason, phaseCwd, thread) => this.logPhaseEvent(phase, startedAt, reason, phaseCwd, undefined, thread),
      log: (label, detail) => this.log(label, detail),
      logForThread: (thread, label, detail) => this.logForThread(thread, label, detail),
      fail: (error, sessionId, thread) => this.fail(error, sessionId, thread),
      errorMessage: (error) => this.errorMessage(error),
    });
    this.runtimes = new ThreadRuntimeLifecycle({
      safeMode: this.safeMode,
      agentDir: this.agentDir,
      cwd: () => this.cwd,
      activeSessionFile: () => this.active?.sessionFile,
      adapterFor: (kind) => this.adapterFor(kind),
      requireBackend: (kind) => this.requireBackend(kind),
      permissionLevel: () => this.seam.permissionLevel(),
      sessionFile: (manager) => this.seam.sessionFile(manager),
      runtimeExtensions: (settingsManager, session) => this.runtimeExtensionsFor(settingsManager, session),
      runtimeExtensionNames: () => this.seam.runtimeExtensions.map((entry) => entry.name),
      threadLifecycle: this.threadLifecycle,
      turnObservers: this.turnObservers,
      clientTurns: this.clientTurns,
      extensionUi: this.extensionUi,
      projection: this.projection,
      projects: this.projects,
      binding: this.binding,
      lifecycleMetrics: this.lifecycleMetrics,
      adopt: (thread) => this.adoptThread(thread),
      currentRuntime: (threadId) => this.threads.get(threadId)?.runtime,
      liveThreadForPath: (path) => this.liveThreadForPath(path),
      indexedSession: (path) => this.index.byPath(path),
      presentUi: (method, ...args) => this.presentUi(method, ...args),
      releaseTool: (toolCallId) => { this.toolOwners.delete(toolCallId); },
      emitMessage: (threadId, message) => this.emit(message.role === "user"
        ? { type: "user-message", sessionId: threadId, message }
        : { type: "assistant-end", sessionId: threadId, message }),
      logRuntimePhase: (phase, startedAt, reason, phaseCwd) => this.logRuntimePhase(phase, startedAt, reason, phaseCwd),
      log: (label, detail) => this.log(label, detail),
      errorMessage: (error) => this.errorMessage(error),
    });
    this.prewarm = new RuntimePrewarm({
      automatic: this.automaticPrewarm,
      safeMode: this.safeMode,
      maxLiveThreads: MAX_LIVE_THREADS,
      cwd: () => this.cwd,
      sessionsDir: this.sessionsDirOverride,
      runtimes: this.runtimes,
      extensionUi: this.extensionUi,
      liveThreadIds: () => this.liveThreadIds(),
      hasLocalActive: () => Boolean(this.localActive),
      indexedSessions: () => this.index.list(),
      prewarmSession: (path) => this.prewarmSession(path),
      recordBackground: (name, startedAt) => this.recordBackgroundLifecycle(name, startedAt),
      log: (label, detail) => this.log(label, detail),
      fail: (error) => this.fail(error),
      errorMessage: (error) => this.errorMessage(error),
    });
    markTauHostRuntime();
    this.emit = (event) => {
      this.lifecycleMetrics.recordIpc(event);
      emit(event);
    };
    this.toolOutputBatcher = new ToolOutputBatcher((updates) => {
      for (const [id, output] of updates) {
        this.emit({ type: "tool-update", sessionId: this.toolOwners.get(id) ?? "", id, output });
      }
    });
  }

  /** The one place PiHost hands its collaborators what they may ask of it. */
  private hostPort(): AttachedSessionPort & ExtensionServicesPort {
    return {
      safeMode: this.safeMode,
      platform: this.platform,
      stateDir: this.kitStateDir,
      clientTurns: this.clientTurns,
      emit: (event) => this.emit(event),
      emitUpdate: (update) => this.emitUpdate(update),
      log: (label, detail) => this.log(label, detail),
      errorMessage: (error) => this.errorMessage(error),
      fail: (error) => this.fail(error),
      beginActivation: () => this.beginActivation(),
      isCurrentActivation: (epoch) => this.isCurrentActivation(epoch),
      releaseLocalThread: async (sessionFile) => {
        const local = this.liveThreadForPath(sessionFile);
        if (local) await this.threads.release(local.threadId);
      },
      clearActiveThread: () => this.threads.setActive(undefined),
      cwd: () => this.cwd,
      setCwd: (cwd) => { this.cwd = cwd; },
      onSessionEvent: (event, threadId) => this.handleSessionEvent(event, this.attachedThread, threadId, this.cwd),
      snapshot: () => this.snapshot(),
      detailForSnapshot: (snapshot, requestId) => this.detailForSnapshot(snapshot, requestId),
      lifecycleUpdates: (snapshot) => this.lifecycleUpdates(snapshot),
      refreshActiveThreadShell: () => this.refreshActiveThreadIndex(false),
      openWorkspace: (path) => this.setWorkspace(path),
      knownWorkspacePath: (path) => this.knownWorkspacePath(path),
      workspaceRef: (path) => this.workspaces.ref(path),
      projectName: (cwd) => this.projects.loadName(cwd),
      rememberProjectName: (cwd, name) => { this.projects.rememberName(cwd, name); },
      runtimeOwner: () => this.ownedByPi(this.active) ? "pi" : "tau",
      thread: (sessionId) => this.hostThread(sessionId),
      setThreadTitle: async (sessionId, title, source) => { await this.applyThreadTitle(this.requireThread(sessionId), title, source); },
      attachedRuntime: (sessionId) => this.ownedByPi(this.threadFor(sessionId)) ? this.attached.hostRuntime : undefined,
      describeProjects: (facts) => this.projects.add(facts),
      noteSubprocess: () => this.lifecycleMetrics.countSubprocess(),
      refreshExtensionPackages: () => this.packages?.refresh() ?? Promise.resolve(),
      prepareThread: (session, manager, options) => this.prepareThread(session, manager, options),
      startThread: (options) => this.startThread(options),
      exclusive: (work) => this.lifecycle.run("extension.exclusive", work),
      refreshThreadIndex: () => this.index.refresh("none").catch(() => this.index.snapshot()),
      registerThreadLifecycle: (lifecycle) => this.threadLifecycle.add(lifecycle),
      registerTurnObserver: (observer) => this.turnObservers.add(observer),
      pinTranscriptEntries: () => { throw new Error("The extension seam owns transcript pins."); },
      decorateUiPrompt: (decorator) => this.extensionUi.addDecorator(decorator),
    };
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
    return {
      sessionId: runtime.threadId,
      session,
      activate: async () => {
        if (settled) throw new Error("This prepared thread was already used.");
        const previous = this.active;
        try {
          await this.adoptThread(runtime);
          if (!await this.activateThread(runtime, true)) throw new Error("The thread was superseded before it became active.");
          settled = true;
          runtime.releaseEventBarrier((event, thread, sessionId, cwd, error) => {
            if (error) this.fail(error, sessionId);
            else this.handleSessionEvent(event, thread, sessionId, cwd);
          }, (event) => this.emit(event), (title) => this.onWindowTitle?.(title));
          return this.actionResult(this.lifecycleUpdates(await this.snapshot()));
        } catch (error) {
          // The caller keeps the thread it had; the prepared runtime is theirs to discard.
          if (!settled && previous && this.threads.active?.runtime === runtime) {
            this.threads.setActive(previous.threadId);
            this.cwd = previous.cwd;
            this.extensionCount = previous.state.extensionCount;
          }
          throw error;
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
    const requestedAt = performance.now();
    // Background starts share the queue's background lane: they build their own
    // thread and touch nothing the thread on screen depends on, so serialising
    // them behind each other only made fifty sub-agents start one per second.
    const thread = await this.lifecycle.runBackground("start-thread", async () => {
      const marks = new PhaseTimer(requestedAt);
      marks.mark("queue");
      const manager = SessionManager.create(cwd, this.sessionsDirOverride);
      if (options.parent) this.index.linkParent(manager, options.parent);
      const runtime = await this.runtimes.open(
        manager,
        { type: "session_start", reason: "new" },
        { adopt: false, prepared: true },
      );
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

  private runtimeExtensionsFor(settingsManager: SettingsManager, session: RuntimeSessionInfo): Array<{ name: string; factory: import("@earendil-works/pi-coding-agent").ExtensionFactory }> {
    const settings = { global: settingsManager.getGlobalSettings(), project: settingsManager.getProjectSettings() };
    return this.seam.runtimeExtensions
      .filter((contribution) => contribution.enabledFor?.(settings) ?? true)
      .map(({ name, factory }) => ({ name, factory: (pi) => factory(pi, session) }));
  }

  /** The provider behind a non-Pi backend kind. */
  private requireBackend(kind: ThreadBackendKind): HostRuntimeBackendProvider {
    const provider = this.seam.backends.get(kind);
    if (!provider) throw new Error(`Runtime backend "${kind}" is not installed; enable its extension or unset TAU_RUNTIME_ADAPTER.`);
    return provider;
  }

  private async activateHostExtensions(): Promise<void> {
    // The kits Tau ships arrive as a thunk so their compilation happens with the
    // host, not with the module that configured it.
    const bundled = typeof this.pendingHostExtensions === "function" ? await this.pendingHostExtensions() : this.pendingHostExtensions;
    this.pendingHostExtensions = bundled;
    for (const extension of bundled) await this.hostExtensions.activate(extension);
    await this.packages?.start();
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

  invokeHostExtension(extensionId: string, command: string, input?: unknown): Promise<unknown> {
    return this.hostExtensions.invoke(extensionId, command, input);
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
    const thread = this.threadFor(threadId);
    if (!thread) {
      throw new Error(threadId && threadId !== this.active?.threadId
        ? "That thread is not open any more. Open it again to continue."
        : "Pi runtime is not ready");
    }
    return thread;
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

  private beginActivation(): number {
    this.activationEpoch += 1;
    return this.activationEpoch;
  }
  private isCurrentActivation(epoch: number): boolean {
    return this.activationEpoch === epoch;
  }
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
      // The last session of this workspace points at a folder that is gone
      // (Pi refuses to resume it); a fresh session in the workspace is the
      // right answer at startup, where nobody chose that session.
      if (!(error instanceof Error && error.name === "MissingSessionCwdError")) throw error;
      this.log("session.cwd-missing", this.errorMessage(error));
      return this.runtimes.open(SessionManager.create(cwd, this.sessionsDirOverride), undefined);
    }
  }

  async start(): Promise<HostBootstrap> {
    const activationEpoch = this.beginActivation();
    return this.lifecycle.run("start", async () => {
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
        void this.index.refresh("index").then(() => {
          this.recordBackgroundLifecycle("session-index", indexStartedAt);
          this.log("bootstrap.full-ready");
          this.index.startRecovery();
          this.prewarm.scheduleThreads();
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
      ? localTranscriptPage(
        snapshot.sessionId,
        snapshot.messages,
        snapshot.taskHistory,
        snapshot.turnActivityHistory,
        snapshot.turnActivityHistoryComplete,
        cursor,
      )
      : this.detailForSnapshot(snapshot);
    this.lifecycleMetrics.recordIpc(result);
    return result;
  }

  async loadTranscript(sessionId: string, cursor?: HostTranscriptCursor): Promise<TranscriptPage> {
    const thread = this.requireThread(sessionId);
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
    const thread = this.requireThread(sessionId);
    const paging = thread.backend.capabilities.transcriptPaging;
    const result = paging
      ? await paging.readToolOutput(toolCallId)
      : readLocalToolOutput(this.projection.branchMessages(thread), toolCallId);
    this.lifecycleMetrics.recordIpc(result);
    return result;
  }

  getLifecycleMeasurements() { return this.lifecycleMetrics.getMeasurements(); }
  getBackgroundLifecycleMeasurements() { return this.backgroundLifecycle.map((item) => ({ ...item })); }

  private detailForSnapshot(snapshot: HostSnapshot, requestId?: NewThreadRequestId): ThreadDetail {
    // A fresh runtime snapshot is authoritative; only the renderer uses the
    // cached record for optimistic selection between host confirmations.
    const detail = detailFromSnapshot(snapshot, undefined, localTranscriptCursorPolicy);
    this.detailStore.set(detail);
    return requestId ? { ...detail, requestId } : detail;
  }

  private actionResult(updates: HostUpdate[]): HostActionResult {
    const result = { version: HOST_PROTOCOL_VERSION, updates } satisfies HostActionResult;
    this.lifecycleMetrics.recordIpc(result);
    return result;
  }

  private newThreadResult(
    updates: HostUpdate[],
    submission: SubmissionResult,
    requestId?: NewThreadRequestId,
    sessionId?: string,
  ): NewThreadResult {
    return {
      ...this.actionResult(updates),
      submission,
      ...(requestId ? { requestId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  }

  /** Publishes a thread the runtime created and now owns; one identity and publication path. */
  private async completeRuntimeOwnedNewThread(thread: ThreadRuntime, requestId: NewThreadRequestId): Promise<NewThreadResult> {
    this.cwd = thread.cwd;
    await this.index.refreshShell(thread, true);
    return this.newThreadResult(this.lifecycleUpdates(await this.snapshot()), { accepted: true }, requestId, thread.threadId);
  }

  private lifecycleUpdates(snapshot: HostSnapshot, requestId?: NewThreadRequestId): HostUpdate[] {
    const shell = this.index.byId(snapshot.sessionId);
    return [
      ...(shell ? [{ version: HOST_PROTOCOL_VERSION, type: "thread-shell" as const, update: { sessionId: shell.id, shell } }] : []),
      { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot, requestId) },
      { version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) },
      { version: HOST_PROTOCOL_VERSION, type: "project", project: this.projectMetadata(snapshot.cwd, snapshot.projectLabel) },
    ];
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
      const shell = this.index.byId(snapshot.sessionId);
      const initialUpdates: HostUpdate[] = [
        ...(shell ? [{ version: HOST_PROTOCOL_VERSION, type: "thread-shell" as const, update: { sessionId: shell.id, shell } }] : []),
        { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot, requestId) },
        { version: HOST_PROTOCOL_VERSION, type: "project", project: this.projectMetadata(snapshot.cwd, snapshot.projectLabel) },
      ];
      for (const update of initialUpdates) this.emitUpdate(update);
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
    const activationEpoch = this.beginActivation();
    return this.lifecycle.run("set-workspace", () => this.setWorkspaceNow(cwd, activationEpoch));
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
      // A run that is still in flight owns its tool calls; closing them from
      // outside would race the runtime. Stop it first, then repair.
      if (!thread.state.idle || thread.adapterPending > 0) await this.abortThread(thread);
      // Zero dangling calls is a success: the session is already consistent and
      // the caller only has stale activity to clear.
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
      const snapshot = await this.snapshot();
      const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) };
      this.emitUpdate(update);
      return this.actionResult([update]);
    });
  }

  async newSession(
    initialPrompt?: string,
    attachments: UiPromptAttachment[] = [],
    cwd?: string,
    clientMessageIdOrRequestId?: ClientTurnRequest,
    prepared?: PreparedPrompt,
  ): Promise<HostActionResult> {
    this.workbenchReload.assertAvailable();
    // Admit the activation before waiting on the lifecycle queue. A newer live
    // switch must supersede this request even when its queued work starts later.
    const activationEpoch = this.beginActivation();
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
      if (!this.isCurrentActivation(activationEpoch)) return this.staleNewThreadResult(requestId);
      const ownedRequestId = requestId ?? createNewThreadRequestId(randomUUID());
      try {
        this.assertImageInput(owner, attachments);
      } catch (error) {
        return this.newThreadResult([], { accepted: false, message: this.errorMessage(error) }, ownedRequestId);
      }
      try {
        const rebind = promptRebindForThread(prepared, owner.threadId);
        const ownedPrepared = rebind ? await owner.backend.preparePrompt(initialPrompt ?? "", rebind.skill) : prepared;
        if (ownedPrepared) this.assertPreparedPrompt(owner, initialPrompt ?? "", ownedPrepared, this.projection.composerCommands(owner));
        if (identity) this.clientTurns.enqueueAny(identity);
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
    }
    // A prepared prompt from the currently visible thread may be carried into
    // a new-thread request. It is deliberately re-prepared after the new
    // backend is created; only an owner-less preflight can be validated here.
    if (prepared && prepared.tauThreadId === undefined && prepared.sessionId === undefined) {
      const adapter = this.adapterFor(backendKind);
      const commands = backendKind !== "pi"
        ? this.externalComposerCommands(backendKind, cwd ?? this.cwd)
        : this.runtimeCommands;
      validatePreparedPrompt(initialPrompt ?? "", prepared, {
        backendKind,
        runtimeCapabilities: adapter.capabilities,
        commands,
      });
    }
    return this.lifecycle.run("new-thread", async () => {
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
        // Decode and validate attachment data before promoting a prepared
        // runtime, so malformed input cannot leave an adopted blank thread.
        this.assertImageInput(thread, attachments);
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
          }, (event) => this.emit(event), (title) => this.onWindowTitle?.(title));
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
          if (isLocalPiRuntime(thread)) this.prewarm.retainSpare(thread);
          else await this.runtimes.dispose(thread);
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
    const activationEpoch = this.beginActivation();
    return this.lifecycle.run("fork-thread", async () => {
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

  private async sendThroughRuntimeAdapter(
    thread: ThreadRuntime,
    text: string,
    attachments: UiPromptAttachment[],
    delivery: "prompt" | "steer" | "followUp",
    identity?: ClientTurnIdentity,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    const clientMessageId = identity?.clientMessageId;
    thread.adapterPending ??= 0;
    thread.adapterAbortGeneration ??= 0;
    const generation = thread.adapterAbortGeneration;
    const wasPending = thread.adapterPending > 0;
    thread.adapterPending += 1;
    thread.adapterStreaming = true;
    if (!wasPending) this.emit({ type: "agent-status", sessionId: thread.threadId, running: true });
    const operation = thread.adapterQueue.then(() => {
      if (generation !== thread.adapterAbortGeneration) {
        if (clientMessageId) {
          this.emit({
            type: "user-message-failed",
            sessionId: thread.threadId,
            clientMessageId,
            message: "The selected runtime request was aborted.",
          });
        }
        const error = new Error("The selected runtime request was aborted.");
        error.name = "AbortError";
        throw error;
      }
      return this.sendThroughRuntimeAdapterNow(thread, text, attachments, delivery, identity, prepared);
    });
    const settled = operation.finally(() => {
      thread.adapterPending = Math.max(0, thread.adapterPending - 1);
      if (thread.adapterPending === 0) {
        thread.adapterStreaming = false;
        this.emit({ type: "agent-status", sessionId: thread.threadId, running: false });
      }
    });
    thread.adapterQueue = settled.then(() => undefined, () => undefined);
    return settled;
  }

  private async sendThroughRuntimeAdapterNow(
    thread: ThreadRuntime,
    text: string,
    attachments: UiPromptAttachment[],
    delivery: "prompt" | "steer" | "followUp",
    identity?: ClientTurnIdentity,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    const clientMessageId = identity?.clientMessageId;
    const commands = this.projection.composerCommands(thread);
    if (prepared) this.assertPreparedPrompt(thread, text, prepared, commands);
    const abortController = new AbortController();
    thread.adapterAbortControllers ??= new Set<AbortController>();
    thread.adapterAbortControllers.add(abortController);
    try {
      if (attachments.length > 0) throw new Error("Image attachments are not supported by the selected runtime adapter.");
      await thread.backend.prompt({ text, delivery, ...(identity ? { identity } : {}), ...(prepared ? { prepared } : {}), signal: abortController.signal });
      thread.adapterMessages = await thread.backend.transcript();
      const state = thread.state;
      thread.adapterTitle = state.title;
      thread.adapterTitleSource = state.titleSource;
      await this.index.refreshShell(thread, true);
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      if (clientMessageId) {
        this.emit({
          type: "user-message-failed",
          sessionId: thread.threadId,
          clientMessageId,
          message: aborted ? "The selected runtime request was aborted." : "The selected runtime rejected the message.",
        });
      }
      if (!aborted) this.fail(error);
      throw error;
    } finally {
      thread.adapterAbortControllers.delete(abortController);
    }
  }

  /**
   * Prepared prompt data is an opaque host result, but IPC callers can still
   * replay or forge it. Bind it to the exact visible input and runtime owner
   * before allowing the backend to execute the runtime spelling.
   */
  private assertPreparedPrompt(
    thread: ThreadRuntime,
    text: string,
    prepared: PreparedPrompt,
    commands: readonly UiComposerCommand[],
  ): void {
    this.assertPreparedPromptData(
      text,
      prepared,
      threadBackendKind(thread),
      thread.threadId,
      thread.backend.providerSessionId,
      thread.runtimeAdapter,
      commands,
    );
  }

  private assertPreparedPromptData(
    text: string,
    prepared: PreparedPrompt,
    backendKind: ThreadBackendKind,
    threadId: string | undefined,
    providerSessionId: string | undefined,
    adapter: AgentRuntimeAdapter,
    commands: readonly UiComposerCommand[],
  ): void {
    validatePreparedPrompt(text, prepared, {
      backendKind,
      threadId,
      providerSessionId,
      runtimeCapabilities: adapter.capabilities,
      commands,
    });
  }

  /** Resolves a prompt before the renderer creates its optimistic message. */
  async preparePrompt(text: string, sessionId?: string, skill?: UiSkillDraft): Promise<PreparedPrompt> {
    const target = sessionId
      ? await this.awaitThread(sessionId)
      : (this.active && threadBackendKind(this.active) === this.defaultBackendKind ? this.active : undefined);
    if (target) return target.backend.preparePrompt(text, skill);
    const adapter = this.adapterFor(this.defaultBackendKind);
    const commands = this.defaultBackendKind !== "pi"
      ? this.externalComposerCommands(this.defaultBackendKind, this.cwd)
      : this.runtimeCommands;
    return this.preparePromptForAdapter(text, skill, adapter, commands, undefined, this.defaultBackendKind);
  }

  private preparePromptForAdapter(
    text: string,
    skill: UiSkillDraft | undefined,
    adapter: AgentRuntimeAdapter,
    commands: readonly UiComposerCommand[],
    threadId: string | undefined,
    backendKind: ThreadBackendKind,
  ): PreparedPrompt {
    if (adapter.id !== "pi") this.requireBackend(adapter.id).assertPromptAllowed?.(this.seam.permissionLevel());
    const effectiveCommands = commands;
    const prepared = prepareSkillPrompt(text, adapter, effectiveCommands, skill);
    const skillNames = [...knownSkillNames(effectiveCommands)];
    const result: PreparedPrompt = {
      ...(threadId ? { tauThreadId: threadId } : {}),
      ...(threadId && adapter.id === "pi" ? { providerSessionId: threadId } : {}),
      ...(threadId ? { sessionId: threadId } : {}),
      backendKind,
      runtimeCapabilities: adapter.capabilities,
      visibleText: prepared.text,
      runtimeText: prepared.runtimeText,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      sourceFingerprint: clientMessageFingerprint(text, skillNames),
    };
    validatePreparedPrompt(text, result, {
      backendKind,
      threadId,
      providerSessionId: threadId && adapter.id === "pi" ? threadId : undefined,
      runtimeCapabilities: adapter.capabilities,
      commands: effectiveCommands,
    });
    return result;
  }

  /** Images travel to a runtime only when it says its model takes them. */
  private assertImageInput(thread: ThreadRuntime, attachments: readonly UiPromptAttachment[]): void {
    if (attachments.length === 0) return;
    if (!thread.state.supportsImageInput) throw new Error("The active model does not support image input.");
    promptImages(attachments);
  }

  async switchSession(path: string): Promise<HostActionResult> {
    const activationEpoch = this.beginActivation();
    // The index carries the lifecycle owner; the virtual path of an external
    // thread is the fallback for entries that predate the index.
    const indexedSession = this.index.byPath(path);
    const backendKind = indexedSession?.backendKind ?? externalThreadFromPath(path)?.kind;
    // A thread whose runtime is already live switches immediately and outside
    // the lifecycle queue: nothing is created, aborted or replaced.
    const live = this.ownedByPi(this.active) ? undefined : this.liveThreadForPath(path);
    if (live) {
      const startedAt = performance.now();
      if (!await this.activateThread(live, false, activationEpoch)) return this.staleActivationResult();
      this.logReplacement("live-switch", startedAt);
      return this.activeUpdates(activationEpoch);
    }
    return this.lifecycle.run("switch-thread", async () => {
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
      await this.threadLifecycle.beforeWorkspace(this.cwd);
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

  /**
   * Delivery for a runtime that keeps no host-owned journal: it owns the turn
   * itself, so there is no request marker and no host turn observer for it.
   */
  private async deliverRuntimeTurn(
    thread: ThreadRuntime,
    text: string,
    attachments: UiPromptAttachment[],
    delivery: "prompt" | "steer" | "followUp",
    identity?: ClientTurnIdentity,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    if (thread.backend.turnReporting === "awaited") {
      await this.sendThroughRuntimeAdapter(thread, text, attachments, delivery, identity, prepared);
      return;
    }
    this.assertImageInput(thread, attachments);
    if (prepared) this.assertPreparedPrompt(thread, text, prepared, this.projection.composerCommands(thread));
    try {
      if (identity) this.clientTurns.enqueue(thread.threadId, identity);
      await thread.backend.prompt({
        text,
        delivery,
        attachments,
        ...(identity ? { identity } : {}),
        ...(prepared ? { prepared } : {}),
      });
    } catch (error) {
      if (identity) this.clientTurns.cancel(thread.threadId, identity);
      throw error;
    }
  }

  async prompt(
    text: string,
    attachments: UiPromptAttachment[] = [],
    sessionId?: string,
    clientMessageIdOrPreflight?: ClientTurnRequest | PromptPreflight,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    this.workbenchReload.assertAvailable();
    const onPreflightResult = typeof clientMessageIdOrPreflight === "function" ? clientMessageIdOrPreflight : undefined;
    const identity = typeof clientMessageIdOrPreflight === "function"
      ? undefined
      : clientIdentityForRequest(clientMessageIdOrPreflight);
    const clientMessageId = identity?.clientMessageId;
    const thread = await this.awaitThread(sessionId);
    // The switch that opened this thread may still be binding its extensions.
    await this.binding.settle(thread);
    if (!thread.backend.capabilities.journal) {
      try {
        await this.deliverRuntimeTurn(thread, text, attachments, "prompt", identity, prepared);
      } catch (error) {
        onPreflightResult?.({ accepted: false, error });
        throw error;
      }
      onPreflightResult?.({ accepted: true });
      this.log("prompt.accepted", text.slice(0, 80));
      return;
    }
    this.assertImageInput(thread, attachments);
    // Resolve the runtime spelling once at the backend boundary. The same
    // prepared object is then used for marker correlation and delivery, so a
    // resource-registry change cannot cause host and backend to normalize
    // different dialects for one turn.
    const resolvedPrepared = prepared ?? await thread.backend.preparePrompt(text);
    this.assertPreparedPrompt(thread, text, resolvedPrepared, this.projection.composerCommands(thread));
    const prompt = resolvedPrepared.runtimeText;
    const isExtensionCommand = this.projection.isExtensionCommand(thread, prompt);
    const preparedTurnId = isExtensionCommand ? undefined : randomUUID();
    const wasStreaming = thread.state.streaming;
    if (preparedTurnId) {
      this.turnObservers.accepted(thread.threadId, preparedTurnId, { deferBefore: wasStreaming });
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
        if (preparedTurnId) void this.turnObservers.cancelled(thread.threadId, preparedTurnId);
        rejectPreflight(result.error ?? new Error("The prompt was rejected before it started."));
      }
    };
    this.log("prompt.accepted", `${prompt.slice(0, 80)}${attachments.length ? ` · ${attachments.length} image(s)` : ""}`);
    try {
      if (identity) this.clientTurns.enqueue(thread.threadId, identity);
      markerActive = this.clientMessages.appendMarker(thread, clientMessageId, text, resolvedPrepared.sourceFingerprint);
      const run = thread.backend.prompt({
        text,
        delivery: "prompt",
        ...(identity ? { identity } : {}),
        prepared: resolvedPrepared,
        attachments,
        queued: wasStreaming,
        onAdmitted: (accepted) => reportPreflight({ accepted }),
      });
      void run.then(async () => {
        if (preflightState === "pending") reportPreflight({ accepted: true });
        if (preparedTurnId) await this.turnObservers.ended(thread.threadId, preparedTurnId, "completed");
        if (this.threads.get(thread.threadId)?.runtime === thread) await this.index.refreshShell(thread, true);
      }).catch((error) => {
        if (preflightState === "pending") reportPreflight({ accepted: false, error });
        else if (preflightState === "accepted") {
          if (preparedTurnId) void this.turnObservers.ended(thread.threadId, preparedTurnId, "failed");
          if (!thread.deferError(error)) this.fail(error, thread.threadId);
        }
      });
    } catch (error) {
      if (this.threads.get(thread.threadId)?.runtime !== thread) return;
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
    if (this.threads.get(thread.threadId)?.runtime === thread) await this.index.refreshShell(thread, true);
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
    await this.deliverQueuedTurn("steer", text, attachments, sessionId, clientMessageIdOrIdentity, prepared);
  }

  async followUp(
    text: string,
    attachments: UiPromptAttachment[] = [],
    sessionId?: string,
    clientMessageIdOrIdentity?: ClientTurnRequest,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    await this.deliverQueuedTurn("followUp", text, attachments, sessionId, clientMessageIdOrIdentity, prepared);
  }

  /**
   * Steering and follow-up share one path: both hand the runtime a message for
   * a turn that is already in flight, so neither reports a preflight result.
   */
  private async deliverQueuedTurn(
    delivery: "steer" | "followUp",
    text: string,
    attachments: UiPromptAttachment[],
    sessionId?: string,
    clientMessageIdOrIdentity?: ClientTurnRequest,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    this.workbenchReload.assertAvailable();
    const identity = clientIdentityForRequest(clientMessageIdOrIdentity);
    const clientMessageId = identity?.clientMessageId;
    let thread: ThreadRuntime | undefined;
    let preparedTurnId: string | undefined;
    try {
      thread = this.requireThread(sessionId);
      await this.binding.settle(thread);
      if (!thread.backend.capabilities.journal) {
        await this.deliverRuntimeTurn(thread, text, attachments, delivery, identity, prepared);
        return;
      }
      if (identity) this.clientTurns.enqueue(thread.threadId, identity);
      this.assertImageInput(thread, attachments);
      const resolvedPrepared = prepared ?? await thread.backend.preparePrompt(text);
      this.assertPreparedPrompt(thread, text, resolvedPrepared, this.projection.composerCommands(thread));
      if (!this.projection.isExtensionCommand(thread, resolvedPrepared.runtimeText)) {
        preparedTurnId = randomUUID();
        this.turnObservers.accepted(thread.threadId, preparedTurnId, { deferBefore: true, expectsInput: false });
      }
      let markerActive = this.clientMessages.appendMarker(thread, clientMessageId, text, resolvedPrepared.sourceFingerprint);
      try {
        await thread.backend.prompt({ text, delivery, ...(identity ? { identity } : {}), prepared: resolvedPrepared, attachments });
      } catch (error) {
        if (markerActive) {
          this.clientMessages.failIfUnpersisted(thread, clientMessageId);
          markerActive = false;
        }
        if (identity) this.clientTurns.cancel(thread.threadId, identity);
        if (preparedTurnId) await this.turnObservers.cancelled(thread.threadId, preparedTurnId);
        throw error;
      }
    } catch (error) {
      if (identity && thread?.backend.capabilities.journal) this.clientTurns.cancel(thread.threadId, identity);
      if (delivery === "followUp") this.fail(error, sessionId);
      else this.fail(error);
      if (thread && preparedTurnId) await this.turnObservers.cancelled(thread.threadId, preparedTurnId);
      throw error;
    }
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
    await thread.backend.abort();
  }

  async setModel(provider: string, id: string): Promise<HostActionResult> {
    const thread = this.requireActive();
    await requireCapability(thread.backend, "catalogWrite").setModel(provider, id);
    if (this.threads.get(thread.threadId)?.runtime === thread) await this.index.refreshShell(thread, false);
    this.log("model.changed", `${provider}/${id}`);
    return this.catalogResult();
  }

  async setThinkingLevel(level: string): Promise<HostActionResult> {
    await requireCapability(this.requireActive().backend, "catalogWrite").setThinkingLevel(level);
    this.log("thinking.changed", level);
    return this.catalogResult();
  }

  private async catalogResult(): Promise<HostActionResult> {
    const snapshot = await this.snapshot();
    const catalog = { version: HOST_PROTOCOL_VERSION, type: "catalog" as const, catalog: catalogFromSnapshot(snapshot) };
    this.emitUpdate(catalog);
    return this.actionResult([catalog]);
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
    ]));
  }

  async dispose(): Promise<void> {
    return this.lifecycle.run("dispose", async () => {
      this.clientTurns.clear();
      this.toolOutputBatcher.dispose();
      this.prewarm.dispose();
      const teardownErrors: unknown[] = [];
      this.attached.session.detach();
      try { await this.hostExtensions.dispose(); } catch (error) { teardownErrors.push(error); }
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
    if (!this.isCurrentActivation(activationEpoch)) return false;
    const restore = await this.threadLifecycle.beforeActivate(this.hostThreadFor(thread));
    let activationCommitted = !restore;
    try {
      if (!this.isCurrentActivation(activationEpoch)) {
        await restore?.rollback();
        activationCommitted = true;
        return false;
      }
      if (!this.threads.has(thread.threadId)) await this.adoptThread(thread);
      if (!this.isCurrentActivation(activationEpoch)) {
        await restore?.rollback();
        activationCommitted = true;
        return false;
      }
      this.threads.setActive(thread.threadId);
      this.cwd = thread.cwd;
      this.extensionCount = thread.state.extensionCount;
      await this.rememberProject(this.cwd);
      if (!this.isCurrentActivation(activationEpoch)) {
        await restore?.rollback();
        activationCommitted = true;
        return false;
      }
      await this.index.refreshShell(thread, touch);
      if (!this.isCurrentActivation(activationEpoch)) {
        await restore?.rollback();
        activationCommitted = true;
        return false;
      }
      this.log("session.opened", thread.threadId.slice(0, 8));
      this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "project", project: this.projectMetadata(thread.cwd) });
      this.prewarm.scheduleThreads();
      if (this.defaultBackendKind === "pi") this.prewarm.scheduleSpare(thread.cwd);
      await restore?.commit();
      activationCommitted = true;
      return true;
    } catch (error) {
      if (restore && !activationCommitted) {
        try {
          await restore.rollback();
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], "Thread activation failed and workspace recovery needs attention.", { cause: recoveryError });
        }
      }
      throw error;
    }
  }

  private async publishActiveCatalog(): Promise<void> {
    const snapshot = await this.snapshot();
    this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) });
  }

  private async rememberProject(cwd: string): Promise<void> {
    await this.workspaces.learn(cwd);
    await this.projectHistory.remember(cwd, await this.projects.loadName(cwd));
  }

  private publishLabel(cwd: string, label: string | undefined): void {
    if (cwd === this.cwd) {
      this.projectLabel = label;
      this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd, label } });
    }
    this.index.publishLabel(cwd, label);
  }

  private recordBackgroundLifecycle(name: string, startedAt: number): void {
    this.backgroundLifecycle.push({ name, durationMs: Math.round((performance.now() - startedAt) * 10) / 10 });
    if (this.backgroundLifecycle.length > 100) this.backgroundLifecycle.shift();
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
      pushToolOutput: (id, output) => this.toolOutputBatcher.push(id, output),
      flushToolOutput: (id) => this.toolOutputBatcher.flushId(id),
      toolEnded: (owner, tool, toolCwd) => this.turnObservers.toolEnded(owner, tool, toolCwd),
    });
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
      ...this.workspaces.ref(this.cwd),
    };
  }

  /** Identity and display of one workspace, as every published shape carries it. */
  private projectMetadata(cwd: string, label?: string): ProjectMetadata {
    return { cwd, ...this.workspaces.ref(cwd), ...(label === undefined ? {} : { label }) };
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
    this.lifecycleMetrics.phase(phase, startedAt);
    this.logPhaseEvent(phase, startedAt, reason, cwd, note, thread);
  }

  /** The same event without the critical-path measurement, for phases that run in the background. */
  private logPhaseEvent(phase: string, startedAt: number, reason: string, cwd: string, note?: string, thread?: ThreadRuntime): void {
    const elapsed = Math.round((performance.now() - startedAt) * 10) / 10;
    const detail = `${elapsed}ms · ${reason} · ${basename(cwd) || cwd}`;
    const eventDetail = note ? `${detail} · ${note}` : detail;
    if (thread) this.logForThread(thread, `runtime.${phase}.ready`, eventDetail);
    else this.log(`runtime.${phase}.ready`, eventDetail);
  }

  private logReplacement(reason: string, startedAt: number): void {
    const elapsed = Math.round((performance.now() - startedAt) * 10) / 10;
    this.log("runtime.replace.ready", `${elapsed}ms · ${reason}`);
  }
  private emitUpdate(update: HostUpdate): void {
    this.emit({ type: "host-update", update });
  }

  private emitForThread(thread: ThreadRuntime | undefined, event: ThreadHostEvent): void {
    if (thread?.deferHostEvent(event)) return;
    this.emit(event);
  }
  private log(label: string, detail?: string): void {
    const event = { type: "event-log" as const, label, detail, timestamp: Date.now() };
    this.emit(event);
  }

  private logForThread(thread: ThreadRuntime, label: string, detail?: string): void {
    this.emitForThread(thread, { type: "event-log", label, detail, timestamp: Date.now(), sessionId: thread.sessionId });
  }
  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private fail(error: unknown, sessionId?: string, thread?: ThreadRuntime): void {
    if (thread?.deferError(error)) return;
    const message = this.errorMessage(error); this.logger?.error("host.error", error); // full error to the log, message only to the renderer
    if (sessionId) this.emit({ type: "error", message, sessionId });
    else this.emit({ type: "error", message });
    const owner = thread instanceof ThreadRuntime
      ? thread
      : sessionId ? this.threadFor(sessionId) : undefined;
    if (owner instanceof ThreadRuntime) this.logForThread(owner, "host.error", message);
    else if (sessionId) this.emit({ type: "event-log", label: "host.error", detail: message, timestamp: Date.now(), sessionId });
    else this.emit({ type: "event-log", label: "host.error", detail: message, timestamp: Date.now() });
  }
}
