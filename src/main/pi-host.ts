import { tmpdir } from "node:os";
import { RuntimeSwitches } from "./runtime-switches.js";
import { RequestReceipts } from "./request-receipts.js";
import type { AgentSessionControl } from "./agent-session-control.js";
import { compactThreadContext } from "./host-compaction.js";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { promptFiles } from "./prompt-attachments.js";
import { decodeUiPromptAttachments, decodeUiSkillDraft } from "./ipc-input.js";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager, type SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionUiAnswer,
  ExtensionUiPrompt,
  HostBootstrap,
  HostEvent,
  HostExtensionSummary,
  ThreadHostEvent,
  HostSnapshot,
  ThreadIndexSnapshot,
  PreparedThreadCapability,
  ShellActionResult,
  UiComposerCommand,
  UiModel,
  UiRuntimeCatalog,
  UiRuntimeToolsState,
  UiPromptAttachment,
  UiRuntimeBackend,
  UiSkillDraft,
  UiSession,
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
import type { GoalAction, ThreadControls } from "./thread-stop.js";
import { loadModelsConfig } from "./models-config.js";
import { inspectHostSystemPrompt, configureHostModelProvider, configuredComposerCommands } from "./host-model-configuration.js";
import { createNewThreadRequestId } from "../shared/contracts.js";
import {
  HOST_PROTOCOL_VERSION,
  type HostActionResult,
  type ForkThreadResult,
  type HostUpdate,
  type NewThreadResult,
  type ThreadDetail,
  type TranscriptPage,
} from "../shared/host-protocol.js";
import type { HostLifecycleInstrumentation } from "./host-lifecycle.js";
import type { HostReport } from "./host-report.js";
import type { HostLifecycleCoordinator } from "./host-lifecycle-coordinator.js";
import { ThreadActivation, type VisibleThreadState } from "./thread-activation.js";
import { HOST_CORE_PRINCIPAL, type HostInvocationPrincipal } from "./host-invocation.js";
import type { HostPublication } from "./host-publication.js";
import type { ExtensionPackageActivator } from "./extension-package-activation.js";
import type { WorkspaceWatch } from "./workspace-watch.js";
import type { TurnsInFlight } from "./turns-in-flight.js";
import { markWake, type QueuedMessage, type QueuedMessages } from "./queued-messages.js";
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
  HostTurnObserver,
  HostUiPresenter,
  HostWorkspaceCloseReason,
  RuntimeSessionInfo,
} from "./host-extensions.js";
import { runtimeBackendOwner } from "./host-extensions.js";
import { hostThreadCompletionServices } from "./host-completion.js";
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
import type { LiveTurnState } from "./live-turn-state.js";
import { ThreadRuntime, isLocalPiRuntime, isPiBackend, threadBackendKind } from "./thread-runtime.js";
import { requireCapability } from "./runtime-types.js";
import { exportThreadMarkdown, readLocalToolOutput } from "./host-transcript.js";
import { clientTranscript } from "./client-tool-output.js";
import { shellTranscriptPage, type PersistedThreadInfo, type PersistedTranscriptOptions } from "./persisted-transcript.js";
import { PersistedTranscriptReader } from "./persisted-transcript-reader.js";
import { isUnavailableBackend } from "./unavailable-thread-backend.js";
import { isSessionHeldElsewhere } from "./session-locks.js";
import type { ClientMessageTracker } from "./client-message-tracker.js";
import type { ThreadProjection } from "./thread-projection.js";
import type { ExtensionUiCoordinator } from "./extension-ui-coordinator.js";
import type { PiHostOptions } from "./pi-host-options.js";
import { buildPiHostComponents, type PiHostComponents } from "./pi-host-components.js";
import { finishHostShutdown, PhaseTimer, promptRebindForThread, clientIdentityForRequest, externalThreadFromPath, externalThreadPath, findKnownWorkspacePath, processIsAlive, samePath, type ClientTurnRequest } from "./pi-host-support.js";
export type { PiHostOptions } from "./pi-host-options.js";
export { workspaceLabel } from "./pi-host-support.js";
import type { WorkspaceIdentity } from "./workspace-identity.js";
import type { WorkspaceRef } from "../shared/workspace-identity.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import type { ClientTurnLedger } from "./client-turn-ledger.js";
import { skillMessagePresentation } from "./skill-invocation.js";
import { skillDraftOf } from "../shared/prepared-prompt.js";
import { piWorkspaceCommands } from "./workspace-skills.js";
import type { WorkbenchReloadCoordinator } from "./workbench-reload-coordinator.js";
import type { AgentRuntimeAdapter, RuntimePermissionLevel } from "./runtime-adapters.js";
import {
  firstSentence,
  visibleTitleText,
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
  private readonly promptReceipts = new RequestReceipts<void>();
  private readonly newThreadReceipts = new RequestReceipts<NewThreadResult>();
  private readonly projection: ThreadProjection;
  private readonly persistedTranscripts = new PersistedTranscriptReader();
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
  private readonly catalogs: PiHostComponents["catalogs"];
  private readonly toolUpdates: PiHostComponents["toolUpdates"];
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
  /** What the host looks like right now, and every update and result that says so. */
  private readonly publication: HostPublication;
  /** What extensions know about projects: name, label, nesting, all cached. */
  private readonly projects: ProjectFactsCache;
  /** Every persisted thread, the shell it is drawn as, and the publication of both. */
  private readonly index: ThreadIndex;
  private readonly runtimeSwitches: RuntimeSwitches;
  private readonly runtimeSegmentsDir: string;
  private readonly runtimeSwitching = new Set<string>();
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

  prepareUpdateRestart(resume: boolean | undefined): Promise<void> {
    return this.turnsInFlight.prepareUpdateRestart(resume);
  }
  /** The composer's queue and the limit marks, kept by the host so both outlive a restart. */
  readonly queue: QueuedMessages;
  readonly controls: ThreadControls;
  readonly limits: ThreadLimits;
  private readonly settlement: TurnSettlement;

  private readonly sessionControl: AgentSessionControl;
  /** The last title a Pi extension gave the window, for a client that attaches later. */
  private windowTitle?: string;
  private readonly events: PiHostComponents["events"];
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
    this.runtimeSegmentsDir = options.dataFolder ? join(options.dataFolder, "runtime-segments") : join(tmpdir(), `tau-runtime-segments-${randomUUID()}`);
    const components = buildPiHostComponents(options, {
      getCwd: () => this.cwd,
      setCwd: (value) => { this.cwd = value; },
      persistedTranscripts: this.persistedTranscripts,
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
      setWindowTitle: (title) => this.publishWindowTitle(title),
      windowTitle: () => this.windowTitle,
      activateThread: (thread, epoch) => this.activateThread(thread, false, epoch),
      staleActivationResult: () => this.staleActivationResult(),
      setExtensionCount: (count) => { this.extensionCount = count; },
      promptThread: (threadId, text, hidden) => this.prompt(text, [], threadId, undefined, undefined, { hidden }),
      applyThreadTitle: (thread, title, source) => this.applyThreadTitle(thread, title, source),
      prewarmSession: (path) => this.prewarmSession(path),
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
      extensionCount: () => this.extensionCount,
      refreshActiveThreadShell: () => this.refreshActiveThreadIndex(false),
      setWorkspace: (path) => this.setWorkspace(path),
      knownWorkspacePath: (path) => this.knownWorkspacePath(path),
      admitWorkspace: (path) => this.admitWorkspace(path),
      prepareThread: (session, manager, prepareOptions) => this.prepareThread(session, manager, prepareOptions),
      startThread: (startOptions) => this.startThread(startOptions),
      switchThreadRuntime: (id, kind) => this.switchThreadRuntime(id, kind),
      removeThread: (sessionId) => this.removeThread(sessionId),
      restoreThread: (sessionId) => this.restoreThread(sessionId),
      purgeThread: (sessionId) => this.purgeThread(sessionId),
      pendingHostExtensions: () => this.pendingHostExtensions,
      deliverQueued: (sessionId, message) => this.deliverQueued(sessionId, message),
      sendToThread: (sessionId, text, delivery, from, attachments, wake, identity) => this.sendToThread(sessionId, text, delivery, from, attachments, wake, identity),
    });
    this.agentDir = components.agentDir;
    this.sessionsDirOverride = components.sessionsDirOverride;
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
    this.runtimeSwitches = components.runtimeSwitches;
    this.trash = components.trash;
    this.publication = components.publication;
    this.seam = components.seam;
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
    ({ queue: this.queue, limits: this.limits, settlement: this.settlement, catalogs: this.catalogs, toolUpdates: this.toolUpdates, pricing: this.pricing, controls: this.controls } = components);
    this.sessionControl = components.sessionControl;
    this.threadLifecycle = components.threadLifecycle;
    this.turnObservers = components.turnObservers;
    this.events = components.events;
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
        this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "project", project: this.publication.projectMetadata(thread.cwd), sessionId: thread.threadId });
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
      transcript: async () => this.projection.messages(thread),
      ...hostThreadCompletionServices(thread.backend),
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
            return this.publication.activeUpdates();
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
  async startThread(options: HostThreadStartOptions): Promise<HostStartedThread> {
    this.workbenchReload.assertAvailable();
    const attachments = decodeUiPromptAttachments("sessions.start", "attachments", options.attachments) ?? [];
    const skillDraft = decodeUiSkillDraft("sessions.start", "skillDraft", options.skillDraft);
    const files = promptFiles(attachments);
    const cwd = options.cwd || this.cwd;
    const backendKind = options.backend ?? "pi";
    await this.prompts.assertRuntimeKind(backendKind, cwd);
    const provider = backendKind === "pi" ? undefined : this.requireBackend(backendKind);
    if (options.tools && !provider?.restrictsTools) {
      throw new Error(`The ${provider?.label ?? backendKind} runtime cannot restrict its tools${provider ? "" : " when a thread starts; a runtime extension sets them"}.`);
    }
    const requestedAt = performance.now();
    let failedRuntime: ThreadRuntime | undefined;
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
        // Another backend keeps no Pi session file; persist its lineage before opening it.
        const threadId = randomUUID();
        if (options.parent) await this.index.rememberParent(threadId, options.parent.threadId);
        runtime = await this.runtimes.openExternal(backendKind, threadId, cwd, { resume: false, adopt: false, ...(options.tools ? { tools: options.tools } : {}) });
      }
      marks.mark("open");
      try {
        await this.adoptThread(runtime);
        marks.mark("adopt");
        if (options.model) await requireCapability(runtime.backend, "catalogWrite").setModel(options.model.provider, options.model.id);
        if (options.thinkingLevel) await requireCapability(runtime.backend, "catalogWrite").setThinkingLevel(options.thinkingLevel);
        if (options.mode) await requireCapability(runtime.backend, "mode").set(options.mode);
        this.prompts.assertAttachmentInput(runtime, runtime.runtimeAdapter.capabilities.fileAttachments ? attachments : attachments.filter((attachment) => attachment.kind === "image"));
        marks.mark("model");
        // The shell has to exist before a title can be published against it.
        await this.index.refreshShell(runtime, true);
        marks.mark("shell");
        if (options.title) await this.applyThreadTitle(runtime, options.title, "renamed");
        marks.mark("title");
        this.log("thread.start.timing", `${runtime.threadId.slice(0, 8)} · ${marks.report()}`);
      } catch (error) {
        failedRuntime = runtime;
        if (this.threads.has(runtime.threadId)) await this.threads.release(runtime.threadId);
        else await this.runtimes.dispose(runtime);
        throw error;
      }
      runtime.releaseEventBarrier((event, owner, sessionId, eventCwd, error) => {
        if (error) this.fail(error, sessionId);
        else this.handleSessionEvent(event, owner, sessionId, eventCwd);
      }, (event) => this.emit(event), () => undefined);
      return runtime;
    }).catch(async (error) => {
      if (failedRuntime) await this.discardFailedStart(failedRuntime);
      throw error;
    });
    // Wait for admission, so callers can retain drafts and remove unused
    // worktrees on rejection. The answer continues on the child's own thread.
    try {
      await options.beforePrompt?.(this.hostThreadFor(thread));
      const nativeFiles = thread.runtimeAdapter.capabilities.fileAttachments === true;
      const text = !nativeFiles && files.length ? `${options.prompt}\n\nAttached files:\n${files.map((file) => `- ${file.path}`).join("\n")}` : options.prompt;
      const deliveredAttachments = nativeFiles ? attachments : attachments.filter((attachment) => attachment.kind === "image");
      const prepared = await thread.backend.preparePrompt(text, skillDraft);
      await this.prompt(text, deliveredAttachments, thread.threadId, undefined, prepared);
    } catch (error) {
      await this.threads.release(thread.threadId);
      await this.discardFailedStart(thread);
      throw error;
    }
    return { sessionId: thread.threadId, cwd: thread.cwd, ...(thread.state.title ? { title: thread.state.title } : {}) };
  }

  /** Only a fresh background thread that never admitted its first turn. */
  private async discardFailedStart(thread: ThreadRuntime): Promise<void> {
    const kind = threadBackendKind(thread);
    if (kind === "pi") {
      // Pi may not have flushed a file yet. No trash entry is needed for a
      // thread that rejected its first prompt and never held a conversation.
      if (thread.sessionFile) await rm(thread.sessionFile, { force: true });
    } else {
      await this.requireBackend(kind).removeThread?.(thread.threadId);
    }
    await this.index.refresh("changes");
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
      await this.publication.publishLifecycle();
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

  observeHostExtensionMachineRouting(listener: () => void) { return this.hostExtensions.observeMachineRouting(listener); }

  hostExtensionMachineRouting(id: string) { return this.hostExtensions.machineRoutingFor(id); }

  authorizeHostExtension(extensionId: string, command: string, input: unknown, principal: HostInvocationPrincipal): Promise<void> { return this.hostExtensions.authorizeInvocation(extensionId, command, input, principal); }
  /** A thread's live runtime, for external MCP control (ADR 0046); undefined once released. */
  liveThread(sessionId: string): HostThread | undefined { return sessionId ? this.hostThread(sessionId) : undefined; }

  /** Core's own turn observer beside the extensions' (ADR 0046): the ceilings of externally started threads. */
  observeTurns(observer: HostTurnObserver): () => void { return this.turnObservers.add(observer); }

  /** Every host extension that became active, a reload included (ADR 0046). */
  observeExtensionActivation(listener: (id: string) => void): () => void { return this.hostExtensions.observeActivation(listener); }

  /** Core's per-thread ceilings, which clamp every runtime's level whatever the extensions do (ADR 0046). */
  setThreadCeiling(provider: ((sessionId: string) => RuntimePermissionLevel | undefined) | undefined): void { this.seam.setThreadCeiling(provider); }

  /** Who started a thread over MCP, for the thread list (ADR 0046). */
  markMcpClient(sessionId: string, client: UiSession["mcpClient"]): void { this.index.setMcpClient(sessionId, client); }

  activeThreadIdentity(): { sessionId: string; backendKind: string } | undefined { const thread = this.active; return thread ? { sessionId: thread.threadId, backendKind: thread.backend.kind } : undefined; }

  hasRequiredBackgroundWork(): boolean {
    return this.attached.session.isAttached && this.controls.hasRequiredBackgroundWork(this.attachedThread)
      || this.threads.list().some(({ runtime }) => this.controls.hasRequiredBackgroundWork(runtime));
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

  // Active thread accessors. Most of the host reads "the runtime": it is the one
  // the workbench shows, or nothing while Pi's own TUI owns the visible thread.

  private get active(): ThreadRuntime | undefined {
    return this.attached.session.isAttached ? this.attachedThread : this.threads.active?.runtime;
  }

  /** The active thread of Tau's own registry; excludes a thread Pi owns. */
  private get localActive(): ThreadRuntime | undefined {
    return this.threads.active?.runtime;
  }

  private requireActive(): ThreadRuntime {
    this.sessionControl.assertAvailable(undefined);
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
    this.sessionControl.assertAvailable(threadId);
    return this.threadFor(threadId) ?? this.noRuntimeFor(threadId);
  }

  /** No runtime holds this thread and nothing else can answer for it. */
  private noRuntimeFor(threadId: string | undefined): never {
    throw new Error(threadId && threadId !== this.active?.threadId
      ? "That thread is not open any more. Open it again to continue."
      : "Pi runtime is not ready");
  }

  /**
   * Resolves the thread a turn names, waiting for opening runtimes and reopening
   * saved threads. An unknown cached id from a previous run belongs to the
   * blank thread this run put on screen.
   */
  private async awaitThread(threadId: string | undefined): Promise<ThreadRuntime> {
    this.sessionControl.assertAvailable(threadId);
    const live = this.threadFor(threadId);
    if (live) return live;
    if (!threadId) return this.requireActive();
    // Join whatever lifecycle work holds the queue; the thread may be in it.
    await this.lifecycle.run("await-thread", async () => undefined);
    const opened = this.threadFor(threadId);
    if (opened) return opened;
    if (this.index.byId(threadId)) {
      return this.lifecycle.run("reopen-prompt-thread", async () => {
        this.sessionControl.assertAvailable(threadId);
        return this.runtimes.reopen(threadId);
      });
    }
    // Only an unknown cached id can belong to the blank thread on screen.
    const onScreen = this.active;
    if (!onScreen || onScreen.state.hasMessages) return this.requireThread(threadId);
    this.log("prompt.retargeted", `${threadId.slice(0, 8)} → ${onScreen.threadId.slice(0, 8)}`);
    // The client is showing a thread this run does not have. Publish the one
    // it is really writing to, so the turn is not delivered out of sight.
    this.publication.publishDetailNow();
    return onScreen;
  }

  private isCurrentActivation(epoch: number): boolean { return this.lifecycle.isCurrentActivation(epoch); }
  private async staleActivationResult(): Promise<HostActionResult> {
    return this.publication.actionResult([]);
  }
  /**
   * A superseded new-thread request never reaches prompt delivery, so it must
   * report a rejection. A bare action result would leave the client waiting for
   * a commit that can no longer happen.
   */
  private async staleNewThreadResult(requestId?: NewThreadRequestId): Promise<NewThreadResult> {
    return this.publication.newThreadResult([], { accepted: false, message: "A newer request replaced this new thread." }, requestId);
  }
  private async initialSessionManager(cwd: string): Promise<SessionManager> {
    return this.runtimes.openRecent(cwd, this.sessionsDirOverride);
  }

  private async openInitialThread(cwd: string): Promise<ThreadRuntime> {
    if (this.defaultBackendKind !== "pi") {
      const kind = this.defaultBackendKind;
      const latest = (await this.requireBackend(kind).listThreads())
        .filter((record) => record.cwd === cwd && !this.runtimeSwitches.get(record.threadId)?.deleted)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      const switched = latest ? this.runtimeSwitches.get(latest.threadId) : undefined;
      if (switched?.sessionPath) return this.runtimes.open(SessionManager.open(switched.sessionPath), { type: "session_start", reason: "resume" });
      return this.runtimes.openExternal(switched?.kind ?? kind, latest?.threadId ?? randomUUID(), cwd, { resume: Boolean(latest) });
    }
    try {
      const manager = await this.initialSessionManager(cwd);
      const switched = this.runtimeSwitches.get(manager.getSessionId());
      if (!this.safeMode && switched && !switched.deleted) return switched.sessionPath ? this.runtimes.open(SessionManager.open(switched.sessionPath), { type: "session_start", reason: "resume" }) : this.runtimes.openExternal(switched.kind, manager.getSessionId(), cwd);
      return await this.runtimes.open(manager, undefined);
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
      this.report.startDiagnostics();
      const activationEpoch = activation.epoch;
      this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", "bootstrap");
      try {
        // Load durable state before extensions or recovery can start a turn.
        const [interruptedTurns] = await Promise.all([this.turnsInFlight.load(), this.queue.restore(), this.limits.load()]);
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
        // First content does not wait for every session file, unless the previous run left
        // turns to recover: then no client command may race their reconciliation.
        const ready = this.index.refresh("index").then(async () => {
          this.recordBackgroundLifecycle("session-index", indexStartedAt);
          this.log("bootstrap.full-ready");
          this.index.startRecovery();
          this.trash.start();
          // The index is the only way back to a marked thread's session file.
          await this.sessionControl.reconcile(interruptedTurns);
          this.prewarm.scheduleThreads();
          this.catalogs.start();
          this.toolUpdates.start();
        }).catch((error) => this.fail(error));
        if (interruptedTurns.length) await ready;
        const result = await this.bootstrap();
        this.lifecycleMetrics.end();
        return result;
      } catch (error) {
        this.report.stopDiagnostics();
        this.lifecycleMetrics.end();
        throw error;
      }
    });
  }

  activeWorkspacePath(): string {
    return this.cwd;
  }

  threadTitle(sessionId: string): string | undefined { return this.index.byId(sessionId)?.title; }
  threadPath(sessionId: string): string | undefined { return this.index.byId(sessionId)?.path; }
  threadIndexSnapshot(): ThreadIndexSnapshot { return this.index.snapshot(); }
  bootstrap(): Promise<HostBootstrap> { return this.publication.bootstrap(); }

  /** Focused active detail endpoint; it never includes catalogs or project metadata. */
  getThreadDetail(cursor?: HostTranscriptCursor): Promise<TranscriptPage | ThreadDetail> { return this.publication.threadDetail(cursor); }

  async loadTranscript(sessionId: string, cursor?: HostTranscriptCursor): Promise<TranscriptPage> {
    const thread = this.threadFor(sessionId);
    if (!thread) {
      const result = clientTranscript(await this.releasedTranscript(sessionId, cursor));
      this.lifecycleMetrics.recordIpc(result);
      return result;
    }
    const result = clientTranscript(await this.projection.transcriptPage(thread, cursor));
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
      const { thread: persisted, options } = await this.persistedTranscript(sessionId);
      const result = await this.persistedTranscripts.toolOutput(persisted, options, toolCallId);
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
    if (this.runtimeSwitches.get(sessionId)) return this.projection.transcriptPage(await this.runtimes.reopen(sessionId), cursor);
    const session = await this.index.find(sessionId);
    const kind = session?.backendKind ?? "pi";
    if (!session || kind === "pi") {
      const { thread, options } = await this.persistedTranscript(sessionId);
      return this.persistedTranscripts.page(thread, options, cursor);
    }
    const record = await this.seam.backends.get(kind)?.lookup(sessionId);
    if (!record) this.noRuntimeFor(sessionId);
    return shellTranscriptPage(sessionId, record, cursor);
  }

  private async persistedTranscript(sessionId: string): Promise<{ thread: PersistedThreadInfo; options: PersistedTranscriptOptions }> {
    const session = await this.index.find(sessionId);
    // Nothing persisted to read: a thread of another backend keeps no session
    // file, and an unknown id was never this host's.
    if (!session || (session.backendKind ?? "pi") !== "pi") this.noRuntimeFor(sessionId);
    const active = this.active;
    return { thread: {
      sessionId,
      cwd: session.projectPath,
      path: session.path,
      ...(session.title ? { title: session.title } : {}),
      ...(session.parentThreadId ? { parentThreadId: session.parentThreadId } : {}),
    }, options: {
      runtimeAdapter: this.piAdapter,
      // Its own runtime is gone; the skills of the thread on screen are the
      // same host's catalog, and the host's defaults when there is none.
      skillCommands: active && isPiBackend(active) ? this.projection.composerCommands(active) : this.runtimeCommands,
      ...(this.projection.hasPinProviders ? {
        pins: (thread: HostThread) => this.projection.pinsFor(thread), pinsRevision: this.projection.pinsRevision,
      } : {}),
    } };
  }

  getLifecycleMeasurements() { return this.lifecycleMetrics.getMeasurements(); }
  getBackgroundLifecycleMeasurements() { return this.report.backgroundMeasurements.map((item) => ({ ...item })); }
  getEventLoopStallHistory() { return this.report.getEventLoopStallHistory(); }

  /** Publishes a thread the runtime created and now owns; one identity and publication path. */
  private async completeRuntimeOwnedNewThread(thread: ThreadRuntime, requestId: NewThreadRequestId): Promise<NewThreadResult> {
    this.cwd = thread.cwd;
    await this.index.refreshShell(thread, true);
    return this.publication.newThreadResult(this.publication.lifecycleUpdates(await this.publication.snapshot()), { accepted: true }, requestId, thread.threadId);
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
      return this.publication.activeUpdates(activationEpoch);
    }
    if (this.defaultBackendKind === "pi" && await this.attached.session.attach(cwd, undefined, {}, activationEpoch)) {
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      await this.rememberProject(this.cwd);
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      await this.refreshActiveThreadIndex(false);
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      return this.publication.activeUpdates(activationEpoch);
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
        return this.runtimes.liveForPath(manager.getSessionFile())
          ?? await this.runtimes.open(manager, { type: "session_start", reason: "resume", previousSessionFile: this.active?.sessionFile });
      })();
    if (!await this.activateThread(thread, false, activationEpoch)) return this.staleActivationResult();
    this.logReplacement("workspace", startedAt);
    return this.publication.activeUpdates(activationEpoch);
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
    return this.publication.actionResult([update]);
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
    return this.sessionControl.recover(thread);
  }

  async sendToThread(sessionId: string, text: string, delivery: "prompt" | "steer" | "queue", from?: string, attachments: UiPromptAttachment[] = [], wake?: QueuedMessage["wake"], identity?: ClientTurnRequest): Promise<void> {
    const thread = await this.runtimes.reopen(sessionId);
    if (!thread.runtimeAdapter.capabilities.fileAttachments) {
      const files = promptFiles(attachments);
      if (files.length) text = `${text}\n\nAttached files:\n${files.map((file) => `- ${file.path}`).join("\n")}`;
      attachments = attachments.filter((attachment) => attachment.kind === "image");
    }
    if (delivery === "queue") await this.queue.submit(thread.threadId, { ...markWake(text, wake), attachments: this.prompts.checked(thread, attachments), ...(from ? { fromThreadId: from } : {}), ...(identity ? { identity: clientIdentityForRequest(identity) } : {}) });
    else await (delivery === "steer" ? this.steer(text, attachments, thread.threadId, identity) : this.prompt(text, attachments, thread.threadId, identity));
  }

  /** A queued message is prepared when it leaves, against the thread as it is then. */
  private async deliverQueued(sessionId: string, message: QueuedMessage): Promise<void> {
    const prepared = message.skillDraft ? await this.preparePrompt(message.text, sessionId, message.skillDraft) : undefined;
    // A wake is not the user's message; the user's own carry a "sent from the queue" mark.
    const identity = message.wake ? undefined : message.identity ?? { clientTurnId: randomUUID(), clientMessageId: randomUUID() };
    await this.prompt(message.skillDraft ? message.text : message.text.trim(), message.attachments, sessionId, identity, prepared, identity ? { delivery: "queued" } : {});
  }

  async newSession(
    initialPrompt?: string,
    attachments: UiPromptAttachment[] = [],
    cwd?: string,
    clientMessageIdOrRequestId?: ClientTurnRequest,
    prepared?: PreparedPrompt,
    configuration?: NewThreadConfiguration,
  ): Promise<NewThreadResult> {
    return this.newThreadReceipts.run("new-thread", clientIdentityForRequest(clientMessageIdOrRequestId)?.clientMessageId, () => this.createSession(initialPrompt, attachments, cwd, clientMessageIdOrRequestId, prepared, configuration));
  }

  private async createSession(...[initialPrompt, attachments = [], cwd, clientMessageIdOrRequestId, prepared, configuration]: Parameters<PiHost["newSession"]>): Promise<NewThreadResult> {
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
    // Asked now, answered inside the activation: waiting here would queue this request behind a later switch.
    const refusal = this.prompts.runtimeRefusal(backendKind, cwd ?? this.cwd);
    // A runtime that creates threads itself answers the request; Tau only
    // publishes what it reports.
    const owner = !cwd || cwd === this.cwd ? this.active : undefined;
    const runtimeThreads = owner?.backend.kind === backendKind ? owner.backend.capabilities.newThread : undefined;
    if (owner && runtimeThreads) {
      return this.lifecycle.runActivation("new-thread-runtime", async (activation) => {
        const activationEpoch = activation.epoch;
        const refused = await refusal;
        if (refused) return this.publication.newThreadResult([], { accepted: false, message: refused }, requestId);
        if (!this.isCurrentActivation(activationEpoch)) return this.staleNewThreadResult(requestId);
        const ownedRequestId = requestId ?? createNewThreadRequestId(randomUUID());
        try {
          this.prompts.assertAttachmentInput(owner, attachments);
        } catch (error) {
          return this.publication.newThreadResult([], { accepted: false, message: this.errorMessage(error) }, ownedRequestId);
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
          if (!outcome.adopted) return this.publication.newThreadResult([], { accepted: true }, ownedRequestId);
          return await this.completeRuntimeOwnedNewThread(owner, ownedRequestId);
        } catch (error) {
          if (identity) this.clientTurns.cancel(undefined, identity);
          if (!this.isCurrentActivation(activationEpoch)) return this.staleNewThreadResult(requestId);
          const reason = error instanceof Error ? error.message : String(error);
          this.log("new-thread.rejected", reason);
          return this.publication.newThreadResult([], { accepted: false, message: reason }, ownedRequestId);
        }
      }, "unserialized");
    }
    if (prepared && prepared.tauThreadId === undefined && prepared.sessionId === undefined) {
      this.prompts.assertUnbound(initialPrompt ?? "", prepared, this.adapterFor(backendKind), await this.composerCommandsFor(backendKind, cwd ?? this.cwd), backendKind);
    }
    return this.lifecycle.runActivation("new-thread", async (activation) => {
      const activationEpoch = activation.epoch;
      const refused = await refusal;
      if (refused) return this.publication.newThreadResult([], { accepted: false, message: refused }, requestId);
      // A superseded request, or one sent from a draft the user has left, still creates
      // its thread and delivers its prompt in the background; it never takes the visible thread.
      const startedAt = performance.now();
      const targetCwd = cwd ?? this.cwd;
      if (this.isCurrentActivation(activationEpoch)) this.attached.session.detach();
      const spare = backendKind === "pi" ? await this.prewarm.takeSpare(targetCwd) : undefined;
      const thread = spare
        ?? (backendKind !== "pi"
          ? await this.runtimes.openExternal(backendKind, randomUUID(), targetCwd, { resume: false, adopt: false })
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
            if (this.threads.has(thread.threadId)) await this.threads.release(thread.threadId);
            else await this.runtimes.dispose(thread);
            if (backendKind === "pi") this.prewarm.scheduleSpare(targetCwd, true);
          }
          return this.publication.newThreadResult([], { accepted: false, message: this.errorMessage(error) }, requestId);
        } else if (lifecycle !== "promoted") {
          if (this.threads.has(thread.threadId)) await this.threads.release(thread.threadId);
          else await this.runtimes.dispose(thread);
          this.prewarm.scheduleSpare(targetCwd, true);
          return this.publication.newThreadResult([], { accepted: false, message: this.errorMessage(error) }, requestId);
        }
        thread.cancelEventBarrier();
        if (!visible) return this.publication.newThreadResult([], { accepted: false, message: this.errorMessage(error) }, requestId, thread.sessionId);
        const active = await this.publication.activeUpdates();
        return { ...active, submission: { accepted: false, message: this.errorMessage(error) }, ...(requestId ? { requestId } : {}) };
      }
      this.logReplacement(spare ? "new-spare" : "new", startedAt);
      if (backendKind === "pi") this.prewarm.scheduleSpare(targetCwd);
      if (visible) void this.publication.publishNewSessionUpdates(activationEpoch, requestId, thread.sessionId);
      if (initialPrompt || attachments.length > 0) {
        // Thread creation settles its receipt before detached prompt admission.
        void (async () => {
          try {
            const preparedThreadId = prepared?.tauThreadId ?? prepared?.sessionId;
            const deliveryPrepared = preparedThreadId && preparedThreadId !== thread.threadId
              ? await thread.backend.preparePrompt(initialPrompt ?? "", prepared && skillDraftOf(prepared, prepared.visibleText))
              : prepared;
            await this.prompt(initialPrompt ?? "", attachments, thread.threadId, identity, deliveryPrepared);
            // prompt() reports whether its resolved text creates a user turn.
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
      return this.publication.newThreadResult([], { accepted: true }, requestId, thread.sessionId);
    }, configuration?.background ? "detached" : "exclusive");
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

  async forkThread(entryId: string, expectedSessionId?: string, cwd?: string, background?: boolean): Promise<ForkThreadResult> {
    return this.lifecycle.runActivation("fork-thread", async (activation) => {
      const activationEpoch = activation.epoch;
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      const thread = this.requireActive();
      if (expectedSessionId && thread.threadId !== expectedSessionId) {
        throw new Error("The selected thread changed before it could be forked.");
      }
      await this.prompts.assertRuntimeOn(thread, cwd ?? thread.cwd);
      const fork = requireCapability(thread.backend, "fork");
      // A runtime that forks itself reports the result through its own events.
      if (fork.runtimeOwned) {
        if (background !== undefined) throw new Error("This runtime cannot start a task in a fork.");
        if (cwd && cwd !== thread.cwd) throw new Error("A fork into another folder needs Tau to own this thread's runtime.");
        await fork.requestFork?.(entryId);
        return this.isCurrentActivation(activationEpoch) ? this.publication.actionResult([]) : this.staleActivationResult();
      }
      if (thread.state.streaming) throw new Error("Wait for the active run before forking this thread.");
      const sourceFile = thread.sessionFile;
      if (!sourceFile || !existsSync(sourceFile)) {
        throw new Error("This thread has not been saved yet. Wait for the first assistant response before forking it.");
      }
      const startedAt = performance.now();
      // The fork is a new session file, so it gets a runtime of its own; the source thread keeps running untouched.
      // createBranchedSession turns this manager into the fork. A branch without
      // an assistant message has no file until its first response, so the fork
      // must keep this manager instead of reopening its path. In another folder (its own worktree) it gets the sessions directory a new thread there would.
      const elsewhere = cwd && cwd !== thread.cwd ? [SessionManager.create(cwd, this.sessionsDirOverride).getSessionDir(), cwd] as const : [];
      const forkedManager = SessionManager.open(sourceFile, ...elsewhere);
      if (!forkedManager.createBranchedSession(entryId)) throw new Error("Failed to create the forked thread.");
      // Extensions carry what they keep beside the source into the fork.
      await this.threadLifecycle.afterFork(this.hostThreadFor(thread), this.seam.sessionFile(forkedManager));
      const forked = await this.runtimes.open(
        forkedManager,
        { type: "session_start", reason: "fork", previousSessionFile: sourceFile },
        background ? { adopt: false, prepared: true } : {},
      );
      if (background) {
        await this.adoptThread(forked);
        await this.index.refreshShell(forked, true);
        forked.releaseEventBarrier((event, owner, sessionId, eventCwd, error) => {
          if (error) this.fail(error, sessionId);
          else this.handleSessionEvent(event, owner, sessionId, eventCwd);
        }, (event) => this.emit(event), () => undefined);
        return { ...this.publication.actionResult([]), forkedSessionId: forked.threadId };
      }
      if (!await this.activateThread(forked, true, activationEpoch)) return this.staleActivationResult();
      this.logReplacement("fork", startedAt);
      return { ...await this.publication.activeUpdates(activationEpoch), forkedSessionId: forked.threadId };
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
      if (thread.state.streaming || thread.adapterPending > 0 || thread.pendingClientMessageIds.length > 0 || thread.inFlightClientMessageIds.size > 0) throw new Error("Wait for the active run before moving this thread.");
      const result = await this.sessionControl.navigating(thread.threadId, () => tree.navigateTree(entryId, options));
      if (result.cancelled) return { ...this.publication.actionResult([]), cancelled: true };
      this.log("thread.tree.navigated", entryId);
      const update = await this.publication.publishDetail();
      return { ...this.publication.actionResult([update]), cancelled: false, ...(result.draftText ? { draftText: result.draftText } : {}) };
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

  async exportThreadMarkdown(expectedSessionId?: string): Promise<string> { return exportThreadMarkdown(this.requireThread(expectedSessionId)); }

  /**
   * Resolves a prompt before the renderer creates its optimistic message. A
   * prompt for a thread that does not exist yet names the backend it wants
   * (the host's default without one) and its project, whose skills decide.
   */
  async preparePrompt(text: string, sessionId?: string, skill?: UiSkillDraft, backendKind?: ThreadBackendKind, workspace?: string): Promise<PreparedPrompt> {
    const kind = backendKind ?? this.defaultBackendKind;
    if (!sessionId && kind !== "pi") this.requireBackend(kind);
    const cwd = workspace ? this.resolveWorkspacePath(workspace) : this.cwd;
    const sameDraft = this.active && threadBackendKind(this.active) === kind && (!workspace || samePath(this.active.cwd, cwd));
    const target = sessionId ? await this.awaitThread(sessionId) : sameDraft ? this.active : undefined;
    if (target) return target.backend.preparePrompt(text, skill);
    return this.prompts.prepare(text, skill, this.adapterFor(kind), await this.composerCommandsFor(kind, cwd), undefined, kind);
  }

  /** The backends a new thread can run on, in the order every picker uses. */
  runtimeBackends(): UiRuntimeBackend[] { return this.publication.runtimeBackends(); }

  /** The extension that registered a backend, for its `sign-in-state` (`readiness`). */
  runtimeBackendOwner(kind: ThreadBackendKind): string | undefined { const provider = this.seam.backends.get(kind); return provider && runtimeBackendOwner(provider); }

  /** The commands a backend's composer offers, before any thread of it exists. */
  async composerCommandsFor(kind: ThreadBackendKind, cwd: string): Promise<readonly UiComposerCommand[]> {
    return kind !== "pi" ? this.externalComposerCommands(kind, cwd) : await piWorkspaceCommands(this.runtimeCommands, cwd, this.piAdapter);
  }

  /** Runtime sessions stay owned by their provider; the conversation retains one Tau identity. */
  async switchThreadRuntime(id: string, kind: string): Promise<void> {
    this.workbenchReload.assertAvailable();
    if (this.runtimeSwitching.has(id)) throw new Error("This thread is already switching runtimes.");
    this.runtimeSwitching.add(id);
    try { await this.lifecycle.runActivation("switch-runtime", async activation => {
      const source = await this.runtimes.reopen(id);
      if (this.ownedByPi(source) || source.backend.kind === "machine") throw new Error("Switch the runtime on the thread's home machine; attached sessions must be taken over first.");
      if (kind === source.backend.kind) return;
      if (kind === "machine" || (kind !== "pi" && this.requireBackend(kind).hidden)) throw new Error("Choose an executing runtime on this machine.");
      if (source.state.streaming || !source.state.idle || this.threads.isBusy(id) || this.queue.list(id).length || source.adapterPending > 0 || source.pendingClientMessageIds.length > 0 || source.inFlightClientMessageIds.size > 0) throw new Error("Wait for this thread and its queued messages to finish before switching runtimes.");
      if ((source.backend.capabilities.background?.list?.() ?? source.backend.capabilities.background?.current() ?? []).some(task => task.state !== "reported")) throw new Error("Stop this runtime's background tasks before switching runtimes.");
      const goal = source.backend.capabilities.goals?.current();
      if (goal && goal.status !== "complete") throw new Error("End this runtime's goal before switching runtimes.");
      await this.prompts.assertRuntimeKind(kind, source.cwd);
      if (kind !== "pi") {
        const catalog = await this.requireBackend(kind).newThreadCatalog?.();
        if (catalog?.status) throw new Error(catalog.note ?? `The ${kind} runtime is ${catalog.status}. Configure it before switching.`);
      }
      const history = this.projection.messages(source);
      if (history.reduce((size, message) => size + message.text.length, 0) > 500_000) throw new Error("This conversation is too large for a direct runtime switch. Use Continue in… to pass a summary instead.");
      const previous = this.runtimeSwitches.get(id);
      let target: ThreadRuntime;
      let freshExternal = false;
      let sessionPath: string | undefined;
      // A fresh Pi segment has the same Tau id and its own file. Its original file stays untouched.
      if (kind === "pi") {
        const manager = SessionManager.create(source.cwd, this.runtimeSegmentsDir, { id });
        sessionPath = manager.getSessionFile();
        if (!sessionPath) throw new Error("Pi could not create a persisted runtime segment.");
        await mkdir(dirname(sessionPath), { recursive: true });
        await writeFile(sessionPath, `${JSON.stringify(manager.getHeader())}\n`, { mode: 0o600, flag: "wx" });
        try { target = await this.runtimes.open(SessionManager.open(sessionPath), { type: "session_start", reason: "resume" }, { adopt: false, prepared: true }); }
        catch (error) { await rm(sessionPath, { force: true }); throw error; }
      } else {
        const provider = this.requireBackend(kind);
        const existing = await provider.lookup(id);
        freshExternal = !existing;
        try { target = await this.runtimes.openExternal(kind, id, source.cwd, { resume: Boolean(existing), adopt: false }); }
        catch (error) { if (freshExternal) await provider.removeThread?.(id); throw error; }
      }
      let published = false;
      let replacement: ReturnType<ThreadRuntimeRegistry<ThreadRuntime>["stageReplacement"]> | undefined;
      try {
        if (target.state.streaming || !target.state.idle) throw new Error("The target runtime is already working in its saved session.");
        const offset = (await target.backend.transcript()).length;
        const title = source.state.title;
        if (title) await target.backend.setTitle(title, source.state.titleSource ?? "renamed");
        await this.runtimeSwitches.set(id, { kind, cwd: source.cwd, ...(title ? { title } : {}), history, offset, contextPending: true, paths: [...new Set([...previous?.paths ?? [], source.sessionFile ?? externalThreadPath(source.backend.kind, id), sessionPath ?? externalThreadPath(kind, id)])], activity: this.projection.hostSnapshot(source, [], source.cwd, this.extensionCount).turnActivityHistory ?? [], activityOffset: target.adapterActivity.length, ...(sessionPath ? { sessionPath } : {}) });
        target.decorateBackend(backend => this.runtimeSwitches.wrap(backend));
        if (kind !== "pi") target.adapterMessages = await target.backend.transcript();
        target.adapterActivity = await target.backend.capabilities.activityHistory?.load() ?? [];
        replacement = this.threads.stageReplacement({ threadId: id, cwd: target.cwd, runtime: target, isolation: "in-process" });
        if (!await this.activateThread(target, false, activation.epoch)) throw new Error("Runtime switching was superseded by another navigation.");
        published = true;
        await replacement.commit().catch(error => this.log("runtime.switch.cleanup-failed", this.errorMessage(error)));
        target.releaseEventBarrier((event, thread, sessionId, cwd, error) => error ? this.fail(error, sessionId) : this.handleSessionEvent(event, thread, sessionId, cwd), event => this.emit(event), () => undefined);
        await this.index.refresh("changes");
        for (const update of (await this.publication.activeUpdates(activation.epoch)).updates) this.emitUpdate(update);
      } catch (error) {
        if (!published) { await this.runtimeSwitches.set(id, previous); if (replacement) await replacement.rollback(); else await this.runtimes.dispose(target); if (freshExternal) await this.requireBackend(kind).removeThread?.(id); if (sessionPath) await rm(sessionPath, { force: true }); }
        throw error;
      }
    }); } finally { this.runtimeSwitching.delete(id); }
  }

  async switchSession(path: string): Promise<HostActionResult> {
    // The index carries the lifecycle owner; the virtual path of an external
    // thread is the fallback for entries that predate the index.
    const indexedSession = this.index.byPath(path);
    const backendKind = indexedSession?.backendKind ?? externalThreadFromPath(path)?.kind;
    // A thread whose runtime is already live switches immediately and outside
    // the lifecycle queue: nothing is created, aborted or replaced.
    const live = this.ownedByPi(this.active) ? undefined : this.runtimes.liveForPath(path);
    if (live && !isUnavailableBackend(live.backend)) {
      return this.lifecycle.runActivation("live-switch", async (activation) => {
        const startedAt = performance.now();
        if (!await this.activateThread(live, false, activation.epoch)) return this.staleActivationResult();
        this.logReplacement("live-switch", startedAt);
        return this.publication.activeUpdates(activation.epoch);
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
        return this.publication.activeUpdates(activationEpoch);
      }
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      this.attached.session.detach();
      await this.leaveWorkspaceFor(indexedSession?.projectPath ?? dirname(path));
      await this.threadLifecycle.beforeWorkspace(this.cwd);
      // A thread that opened read-only tries its runtime again on every switch to it.
      const unavailable = this.runtimes.liveForPath(path);
      if (unavailable && isUnavailableBackend(unavailable.backend)) await this.threads.release(unavailable.threadId);
      const alreadyLive = this.runtimes.liveForPath(path);
      this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", alreadyLive ? "warm-switch" : "cold-switch");
      try {
        const thread = alreadyLive ?? await this.runtimes.openForPath(path, "resume", false, backendKind);
        if (!await this.activateThread(thread, false, activationEpoch)) return this.staleActivationResult();
        this.logReplacement("resume", startedAt);
        return this.publication.activeUpdates(activationEpoch);
      } finally {
        this.lifecycleMetrics.end();
      }
    });
  }

  /** Opens a thread's runtime ahead of time so switching to it is immediate. */
  async prewarmSession(path: string): Promise<void> {
    if (!this.localActive || this.safeMode || this.runtimes.liveForPath(path)) return;
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
    options: { hidden?: boolean; delivery?: "queued" } = {},
  ): Promise<void> {
    const id = typeof clientMessageIdOrPreflight === "function" ? undefined : clientIdentityForRequest(clientMessageIdOrPreflight)?.clientMessageId;
    return this.promptReceipts.run(sessionId ?? this.active?.threadId ?? "", id, () => this.deliverPrompt(text, attachments, sessionId, clientMessageIdOrPreflight, prepared, options));
  }

  private async deliverPrompt(...[text, attachments = [], sessionId, clientMessageIdOrPreflight, prepared, options = {}]: Parameters<PiHost["prompt"]>): Promise<void> {
    this.workbenchReload.assertAvailable();
    const onPreflightResult = typeof clientMessageIdOrPreflight === "function" ? clientMessageIdOrPreflight : undefined;
    const identity = typeof clientMessageIdOrPreflight === "function"
      ? undefined
      : clientIdentityForRequest(clientMessageIdOrPreflight);
    const clientMessageId = identity?.clientMessageId;
    const thread = await this.awaitThread(sessionId);
    if (clientMessageId && this.clientMessages.persistedIds(thread).has(clientMessageId)) return;
    const restartGeneration = thread.restartGeneration;
    // An unnamed prompt must still belong to the active thread after preparation.
    const promptEpoch = this.activationEpoch;
    await this.prompts.assertRuntimeOn(thread);
    // The switch that opened this thread may still be binding its extensions.
    await this.binding.settle(thread);
    this.sessionControl.assertAvailable(thread.threadId);
    if (this.runtimeSwitching.has(thread.threadId)) throw new Error("This thread is switching runtimes. Send again when the switch finishes.");
    if (thread.restartGeneration !== restartGeneration) throw new Error("The agent session changed while the message was being prepared. Send it again.");
    // A prompt named for its thread goes there while another one is on screen; it only needs the thread still open.
    if (sessionId !== undefined && thread.threadId === sessionId) {
      if (this.threadFor(sessionId) !== thread) this.noRuntimeFor(sessionId);
    } else if (!this.isCurrentActivation(promptEpoch)) {
      throw new Error("The active thread changed while the prompt was being prepared. Retry after the switch completes.");
    }
    // Whatever a restart left behind, this thread is moving again.
    this.settlement.started(thread.threadId);
    if (!thread.backend.capabilities.journal) {
      // Admission settles the receipt; later errors belong to the running turn.
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
      const run = this.turns.toRuntime(thread, text, attachments, "prompt", identity, prepared, (accepted, error) => report({ accepted, ...(error !== undefined ? { error } : {}) }), options.hidden)
        .then(() => report({ accepted: true }), (error) => {
          if (preflight.state === "pending") report({ accepted: false, error });
          else if (preflight.state === "accepted" && this.threadFor(thread.threadId) === thread) this.fail(error, thread.threadId);
        });
      await Promise.race([admitted, run]);
      if (preflight.state === "rejected") throw preflight.rejection;
      this.log("prompt.accepted", text.slice(0, 80));
      return;
    }
    this.prompts.assertAttachmentInput(thread, attachments);
    // Use the same prepared spelling for marker correlation and delivery.
    const resolvedPrepared = prepared ?? await thread.backend.preparePrompt(text);
    this.sessionControl.assertAvailable(thread.threadId);
    if (this.threadFor(thread.threadId) !== thread || thread.restartGeneration !== restartGeneration) throw new Error("The agent session changed while the message was being prepared. Send it again.");
    this.prompts.assertBound(thread, text, resolvedPrepared, this.projection.composerCommands(thread));
    const prompt = resolvedPrepared.runtimeText;
    const isExtensionCommand = this.projection.isExtensionCommand(thread, prompt);
    const preparedTurnId = isExtensionCommand ? undefined : randomUUID();
    const wasStreaming = thread.state.streaming;
    let markerActive = false;
    let preflightState: PromptPreflightState = "pending";
    let resolvePreflight!: () => void;
    let rejectPreflight!: (error: unknown) => void;
    const preflight = new Promise<void>((resolve, reject) => {
      resolvePreflight = resolve;
      rejectPreflight = reject;
    });
    const failUnpersistedMarker = () => {
      if (identity) this.clientTurns.cancel(thread.threadId, identity);
      if (!markerActive) return;
      this.clientMessages.failIfUnpersisted(thread, clientMessageId);
      markerActive = false;
    };
    const reportPreflight = (result: PromptPreflightResult) => {
      if (preflightState !== "pending") return;
      preflightState = result.accepted ? "accepted" : "rejected";
      onPreflightResult?.(result);
      if (result.accepted) { this.turnsInFlight.resetContinuations(thread.threadId); resolvePreflight(); }
      else {
        failUnpersistedMarker();
        if (preparedTurnId) this.turnsInFlight.clear(thread.threadId, preparedTurnId);
        if (preparedTurnId) void this.turnObservers.cancelled(thread.threadId, preparedTurnId);
        rejectPreflight(result.error ?? new Error("The prompt was rejected before it started."));
      }
    };
    try {
      if (preparedTurnId) {
        this.turnObservers.accepted(thread.threadId, preparedTurnId, { deferBefore: wasStreaming });
        if (!wasStreaming) this.turnsInFlight.record({
          sessionId: thread.threadId, cwd: thread.cwd, turnId: preparedTurnId, backend: thread.backend.kind,
          startedAt: Date.now(), prompt: { text, ...(attachments.length ? { images: attachments.length } : {}) },
        });
        // Queued prompts prepare at delivery, after earlier tool work settles.
        if (!wasStreaming) await this.turnObservers.prepare(thread.threadId, preparedTurnId);
      }
      if (identity) this.clientTurns.enqueue(thread.threadId, identity, resolvedPrepared.sourceFingerprint);
      markerActive = this.clientMessages.appendMarker(thread, clientMessageId, text, resolvedPrepared.sourceFingerprint, options.delivery);
      const run = thread.backend.prompt({
        text,
        delivery: "prompt",
        ...(identity ? { identity } : {}),
        prepared: resolvedPrepared,
        attachments,
        queued: wasStreaming,
        ...(options.hidden ? { hidden: true } : {}),
        onAdmitted: (accepted, error) => reportPreflight({ accepted, ...(error !== undefined ? { error } : {}) }),
      });
      void run.then(async () => {
        if (this.threads.get(thread.threadId)?.runtime !== thread) {
          // A runtime released before admitting the prompt never ran it.
          if (preflightState === "pending") reportPreflight({ accepted: false, error: new Error("The agent session changed while the message was being prepared. Send it again.") });
          return;
        }
        if (preflightState === "pending") reportPreflight({ accepted: true });
        if ((preflightState as PromptPreflightState) === "rejected") return;
        if (preparedTurnId) this.turnsInFlight.clear(thread.threadId, preparedTurnId);
        if (preparedTurnId) await this.turnObservers.ended(thread.threadId, preparedTurnId, "completed");
        if (this.threads.get(thread.threadId)?.runtime === thread) await this.index.refreshShell(thread, true);
      }).catch((error) => {
        if (preflightState === "pending") reportPreflight({ accepted: false, error });
        else if (preflightState === "accepted" && this.threads.get(thread.threadId)?.runtime === thread) this.turns.failAcceptedTurn(thread, preparedTurnId, error);
      });
    } catch (error) {
      // An unadmitted prompt always settles, even when its runtime was released meanwhile.
      if ((preflightState as PromptPreflightState) !== "accepted") reportPreflight({ accepted: false, error });
      else if (this.threads.get(thread.threadId)?.runtime === thread) this.turns.failAcceptedTurn(thread, preparedTurnId, error);
    }
    // Reaching here means preflight accepted; a rejection throws out of the await.
    await preflight;
    this.log("prompt.accepted", `${prompt.slice(0, 80)}${attachments.length ? ` · ${attachments.length} image(s)` : ""}`);
    // A command's unused marker must not label the next user turn.
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
    const { thread, restartGeneration } = await this.lifecycle.run("shell-action", async () => {
      if (expectedCwd && this.cwd !== expectedCwd) {
        throw new Error("The selected project did not finish loading. Run the action again.");
      }
      const selected = this.requireActive();
      return { thread: selected, restartGeneration: selected.restartGeneration };
    });
    await this.binding.settle(thread);
    this.sessionControl.assertAvailable(thread.threadId);
    if (this.threadFor(thread.threadId) !== thread || thread.restartGeneration !== restartGeneration) throw new Error("The agent session changed while the action was being prepared. Run it again.");
    const shell = requireCapability(thread.backend, "shellAction", "Run project actions in Pi instead.");
    if (shell.isRunning()) throw new Error("Another project action is already running.");
    const result = await shell.run(shellCommand, includeInContext);
    if (this.threads.get(thread.threadId)?.runtime === thread) {
      await this.index.refreshShell(thread, true);
      await this.publication.publishDetail();
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
    if (thread) await this.controls.stop(thread);
  }

  threadGoal(sessionId: string, action: GoalAction, objective?: string): Promise<void> { return this.controls.goal(sessionId, action, objective); }

  async setModel(provider: string, id: string, expectedSessionId?: string): Promise<HostActionResult> {
    const thread = this.requireThread(expectedSessionId);
    await requireCapability(thread.backend, "catalogWrite").setModel(provider, id);
    if (this.threads.get(thread.threadId)?.runtime === thread) await this.index.publishModelProvider(thread);
    this.log("model.changed", `${provider}/${id}`);
    return this.publication.catalogResult(thread);
  }

  async setThinkingLevel(level: string, expectedSessionId?: string): Promise<HostActionResult> {
    const thread = this.requireThread(expectedSessionId);
    await requireCapability(thread.backend, "catalogWrite").setThinkingLevel(level); this.log("thinking.changed", level);
    return this.publication.catalogResult(thread);
  }

  async setMode(mode: string, expectedSessionId?: string): Promise<HostActionResult> {
    const thread = expectedSessionId ? await this.awaitThread(expectedSessionId) : this.requireActive();
    await requireCapability(thread.backend, "mode").set(mode);
    this.log("mode.changed", mode);
    return thread === this.active ? this.publication.catalogResult() : this.publication.actionResult([]);
  }

  async renameThread(rawTitle: string, expectedSessionId?: string): Promise<HostActionResult> {
    const title = rawTitle.trim();
    if (!title) throw new Error("Thread titles cannot be empty.");
    if (title.length > 120) throw new Error("Thread titles must be 120 characters or fewer.");
    const thread = this.requireThread(expectedSessionId);
    return this.publication.actionResult([await this.applyThreadTitle(thread, title, "renamed")]);
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

  restartSession(threadId: string): Promise<HostActionResult> { return this.lifecycle.runActivation("restart-session", (activation) => this.sessionControl.restart(threadId, activation.epoch)); }

  reloadRuntime(): Promise<void> { return this.lifecycle.run("reload-runtime", () => this.sessionControl.reload()); }

  async compactContext(expectedSessionId?: string, prompt?: { text: string; attachments: UiPromptAttachment[]; skillDraft?: UiSkillDraft }): Promise<HostActionResult> {
    const thread = this.requireThread(expectedSessionId);
    await compactThreadContext(thread, prompt, { queue: this.queue, prompts: this.prompts, emit: this.emit, report: this.report });
    return this.publication.actionResult(thread === this.active ? [await this.publication.publishDetail()] : []);
  }

  snapshot(): Promise<HostSnapshot> { return this.publication.snapshot(); }

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

  private admitWorkspace(path: string): WorkspaceRef { this.admittedWorkspaces.add(path); return this.workspaces.ref(path); }

  async dispose(): Promise<void> {
    this.report.stopDiagnostics();
    // Before anything is torn down: the aborts below are this shutdown's, not
    // the user's, and a thread they stop is exactly one a restart must see.
    this.turnsInFlight.freeze();
    this.queue.freeze(); this.limits.freeze();
    return this.lifecycle.run("dispose", async () => {
      this.report.stopDiagnostics();
      this.clientTurns.clear();
      this.watch?.close();
      this.threads.stopIdleRelease();
      this.prewarm.dispose();
      this.catalogs.dispose();
      this.toolUpdates.dispose();
      this.trash.dispose();
      const teardownErrors: unknown[] = [];
      this.attached.session.detach();
      // Before the extensions are torn down: a hook that releases what belongs
      // to a workspace still has to run, and nothing reopens after this.
      for (const cwd of new Set([this.cwd, ...this.threads.list().map((thread) => thread.cwd)])) {
        await this.closeWorkspace(cwd, "shutdown");
      }
      try { await this.seam.mcp.close(); } catch (error) { teardownErrors.push(error); }
      try { await this.prewarm.discardSpare(); } catch (error) { teardownErrors.push(error); }
      try { await this.runtimes.settleOpening(); } catch (error) { teardownErrors.push(error); }
      const results = await Promise.allSettled(this.threads.list().map((record) => this.threads.release(record.threadId)));
      for (const result of results) if (result.status === "rejected") teardownErrors.push(result.reason);
      await finishHostShutdown(teardownErrors, [
        // Runtime disposal can still persist final messages. Keep the owning
        // extensions and their session databases alive until those writes finish.
        () => this.hostExtensions.dispose(),
        () => this.projectHistory.flush(),
        () => this.index.dispose(),
        () => this.persistedTranscripts.dispose(),
      ]);
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

  private async rememberProject(cwd: string): Promise<void> {
    await this.workspaces.learn(cwd);
    if (!await this.projects.projectless(cwd) && !await this.projects.nested(cwd)) await this.projectHistory.remember(cwd, await this.projects.loadName(cwd));
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
    this.events.session(event, thread, sessionId, cwd);
  }

  /** What a runtime offers a thread that does not exist yet, from the host's cache (`RuntimeCatalogs`). */
  runtimeCatalog(kind: ThreadBackendKind): Promise<UiRuntimeCatalog | undefined> { return this.catalogs.get(kind); }
  /** Every runtime's the client does not hold (`known`); `revalidate` asks again behind the answer those some minutes old. */
  runtimeCatalogs(revalidate = false, known?: Record<string, number>): Promise<UiRuntimeCatalog[]> { return this.catalogs.list(revalidate, known); }
  /** Settings → Runtimes: keeping the agent CLIs current (`RuntimeToolUpdates.act`). */
  runtimeTools(action: string, input?: { on?: unknown; kind?: unknown }): Promise<UiRuntimeToolsState> { return this.toolUpdates.act(action, input); }
  /** The user edited `modelPrices`; totals already published are worked out again. */
  modelPricesChanged(): void { this.pricing.reloadPrices(); }
  /** `extensions.watch` changed: follow Tau's files again, or stop. */
  async watchingChanged(): Promise<void> { await this.watch?.retarget(); }
  /** Tau wrote its config: kits and every client hear so even while watching is off. */
  configWritten(paths: readonly string[]): void { this.seam.notifyConfigChange({ kind: "config", paths }); this.emit({ type: "config-changed", kind: "config", paths: [...paths] }); }

  async modelsConfig(): Promise<CustomProviderConfig[]> {
    return loadModelsConfig(this.agentDir);
  }

  async addModelProvider(input: CustomProviderInput): Promise<UiModel[]> {
    return configureHostModelProvider(this.agentDir, input, this.publication);
  }

  async inspectSystemPrompt(threadId?: string, cwd?: string): Promise<SystemPromptInspection> {
    return inspectHostSystemPrompt((threadId ? this.threadFor(threadId) : undefined) ?? this.active, cwd || this.cwd, this.agentDir, cwd);
  }

  /** Prompt completion updates one shell; the global scan is a startup/recovery path. */
  private async refreshActiveThreadIndex(touch = true): Promise<void> {
    const thread = this.active;
    if (!thread) return;
    await this.index.refreshShell(thread, touch);
  }

  /** Commands of an external backend; a supplied catalog is re-spelled in the backend's dialect. */
  private externalComposerCommands(kind: ThreadBackendKind, cwd: string): UiComposerCommand[] {
    return configuredComposerCommands(this.requireBackend(kind), this.runtimeCommands, cwd);
  }

  /** The workspace a client named, by id or — for a client that still sends paths — by path. */
  resolveWorkspacePath(value: string): string {
    return this.workspaces.pathFor(value);
  }
  answerExtensionUi(id: string, answer: ExtensionUiAnswer): void {
    this.extensionUi.answer(id, answer);
  }

  /** Re-announces questions raised before the renderer was listening. */
  replayOpenUiPrompts(): ExtensionUiPrompt[] {
    return this.extensionUi.replay();
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
