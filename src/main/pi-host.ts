import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionUiAnswer,
  HostBootstrap,
  HostEvent,
  HostExtensionSummary,
  ThreadHostEvent,
  HostSnapshot,
  PreparedThreadCapability,
  ShellActionResult,
  ThreadIndexSnapshot,
  UiComposerCommand,
  UiMessage,
  UiModel,
  UiPromptAttachment,
  SubmissionResult,
  UiSkillDraft,
  UiSession,
  NewThreadRequestId,
  ThreadBackendKind,
  PreparedPrompt,
  ThreadTreeNavigationResult,
  UiThreadTree,
  WorkbenchReloadMode,
  WorkbenchReloadPreparation,
} from "../shared/contracts.js";
import { createNewThreadRequestId } from "../shared/contracts.js";
import {
  HOST_PROTOCOL_VERSION,
  catalogFromSnapshot,
  detailFromSnapshot,
  type HostActionResult,
  type HostUpdate,
  type NewThreadResult,
  type ThreadDetail,
  type TranscriptPage,
} from "../shared/host-protocol.js";
import { formatChatTranscript } from "../shared/chat-transcript.js";
import { taskProgressHistoryFromMessages } from "../shared/task-progress.js";
import { ThreadDetailStore } from "../shared/thread-detail-store.js";
import { HostLifecycleInstrumentation } from "./host-lifecycle.js";
import { RuntimeResourceCache, runtimeResourceFingerprint } from "./runtime-resource-cache.js";
import { cachedResourceOptions, captureResourceDiscovery, type ResourceDiscoverySnapshot } from "./resource-discovery-cache.js";
import { createExtensionUiContext } from "./extension-ui.js";
import type { HostPackageLoadResult } from "./extension-packages.js";
import { findDanglingToolCalls } from "./dangling-tool-calls.js";
import { ThreadRuntimeRegistry } from "./thread-runtimes.js";
import {
  HostExtensionRegistry,
  HostProjectFactsSet,
  HostThreadLifecycleSet,
  HostTurnObserverSet,
  type HostAttachedRuntime,
  type HostExtension,
  type HostExtensionServices,
  type HostPlatform,
  type HostPreparedThread,
  type HostRuntimeBackendProvider,
  type HostSessionFile,
  type HostThread,
  type HostUiPresenter,
  type RuntimeExtensionContribution,
  type RuntimeSessionInfo,
} from "./host-extensions.js";
import { ProjectHistory } from "./project-history.js";
import { ToolOutputBatcher } from "./tool-output-batcher.js";
import { promptImages } from "./prompt-attachments.js";
import { AttachedPiSession, type AttachedSessionHost } from "./attached-pi-session.js";
import type { AttachedRuntimeBackend } from "./attached-runtime.js";
import { findPiBridge } from "./pi-bridge-client.js";
import { composerCommandsForAdapter } from "./bridge-snapshot.js";
import type { LiveTurnState } from "./live-turn-state.js";
import { ThreadRuntime, isPiBackend, threadBackendKind } from "./thread-runtime.js";
import { localTranscriptCursorPolicy, localTranscriptPage, readAttachedToolOutput, readLocalToolOutput } from "./host-transcript.js";
import { handleRuntimeSessionEvent } from "./session-events.js";
import { ClientMessageTracker } from "./client-message-tracker.js";
import { ThreadProjection } from "./thread-projection.js";
import { ExtensionUiCoordinator } from "./extension-ui-coordinator.js";
import type { PiHostOptions } from "./pi-host-options.js";
import { attachedPromptRebind, clientIdentityForRequest, externalThreadFromPath, externalThreadPath, findKnownWorkspacePath, processIsAlive, samePath, type ClientTurnRequest } from "./pi-host-support.js";
export type { PiHostOptions } from "./pi-host-options.js";
export { workspaceLabel } from "./pi-host-support.js";
import { markTauHostRuntime } from "./tau-runtime-owner.js";
import {
  transcriptPagingNegotiated,
  type PiBridgePreparedPrompt,
  type PiBridgeSnapshot,
} from "../shared/pi-bridge-protocol.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import {
  bridgeCursorValue,
} from "./transcript-cursor.js";
import { clientMessageCancelMarker, clientMessageFingerprint, CLIENT_MESSAGE_CANCEL_MARKER, unclaimedClientMessageIds } from "../shared/client-message-correlation.js";
import { ClientTurnLedger } from "./client-turn-ledger.js";
import {
  prepareSkillPrompt,
  skillMessagePresentation,
} from "./skill-invocation.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import { validatePreparedPrompt } from "../shared/prepared-prompt.js";
import { assertRuntimeAdapter, PI_AGENT_RUNTIME_ADAPTER, type AgentRuntimeAdapter, type RuntimePermissionLevel } from "./runtime-adapters.js";
import { PiThreadRuntimeBackend } from "./thread-runtime-backend.js";
import { findExecutable } from "./shell-environment.js";
import {
  textFromContent,
  mapMessage,
  mapBridgeTranscriptPageValue,
  turnActivityHistoryFromMessages,
  mapModel,
  modelSupportsImageInput,
  assertImageInputCapability,
  assertBridgeImageInputCapability,
  firstSentence,
  visibleTitleText,
  safeSessionTitle,
  cleanThreadTitle,
  mapSessions,
  sessionIndexUpdates,
  reconcileActiveThreadShell,
  mergeSessionIndexScan,
  boundedToolOutput,
} from "./host-messages.js";
/** Live Pi runtimes kept in memory; idle ones beyond this are released oldest first. */
const MAX_LIVE_THREADS = 6;
/** Longest a shutdown waits for a run to stop before the runtime is dropped anyway. */
const SHUTDOWN_ABORT_MS = 3_000;

type Emit = (event: HostEvent) => void;
type RuntimeStartEvent = Parameters<CreateAgentSessionRuntimeFactory>[0]["sessionStartEvent"];
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
  private readonly backends = new Map<ThreadBackendKind, HostRuntimeBackendProvider>();
  private readonly defaultBackendKind: ThreadBackendKind;
  private readonly runtimeCommands: readonly UiComposerCommand[];
  private emit: Emit;
  /** Correlates raw Pi user-message events with renderer sends. */
  private readonly clientTurns = new ClientTurnLedger();
  private readonly clientMessages: ClientMessageTracker;
  private readonly projection: ThreadProjection;
  private readonly extensionUi: ExtensionUiCoordinator;
  /** The Pi terminal owning the visible thread, when Tau is attached to one. */
  private readonly attached: AttachedRuntimeBackend;
  private readonly agentDir = getAgentDir();
  private extensionCount = 0;
  private readonly lifecycleMetrics = new HostLifecycleInstrumentation();
  private readonly hostExtensions: HostExtensionRegistry;
  private readonly pendingHostExtensions: readonly HostExtension[];
  private readonly hostExtensionPackages?: (cwd: string) => Promise<HostPackageLoadResult>;
  private packagedHostExtensionIds = new Set<string>();
  private readonly platform: HostPlatform;
  /** Pi extensions host extensions contribute; loaded into every runtime created afterwards. */
  private readonly runtimeExtensionContributions: RuntimeExtensionContribution[] = [];
  private permissionLevelProvider: (() => RuntimePermissionLevel) | undefined;
  private readonly uiPresenters = new Set<HostUiPresenter>();
  private readonly modelCatalogCache = new RuntimeResourceCache<UiModel[]>({ maxEntries: 8, ttlMs: 5 * 60_000 });
  private readonly resourceDiscoveryCache = new RuntimeResourceCache<ResourceDiscoverySnapshot>({ maxEntries: 4, ttlMs: 5 * 60_000 });
  private readonly threads = new ThreadRuntimeRegistry<ThreadRuntime>({
    maxLive: MAX_LIVE_THREADS,
    // A thread with work in flight, an open question, or nothing saved yet has
    // state that only its runtime holds; releasing it would lose that state.
    canEvict: (record) => (record.runtime.backend?.isIdle?.() ?? true)
      && !this.extensionUi.hasOpen(record.threadId)
      && record.runtime.adapterPending === 0
      && !record.runtime.adapterStreaming
      && this.turnObservers.pending(record.threadId) === 0
      // An external runtime owns its transcript in the app-data store rather
      // than in Pi's message array. It is therefore safe to release once its
      // own visible projection has been persisted.
      && (record.runtime.backend.hasMessages() || (record.runtime.adapterMessages?.length ?? 0) > 0),
    dispose: (record) => this.disposeThread(record.runtime),
  });
  /** Runtimes being opened, keyed by session file, so a prewarm and a switch share one. */
  private readonly openingThreads = new Map<string, Promise<ThreadRuntime>>();
  /** A blank runtime for the current project, so a new thread is ready before it is asked for. */
  private spare?: { cwd: string; pending: Promise<ThreadRuntime | undefined>; cancel: () => void };
  private preparedThreadCapabilityGeneration = 0;
  /** Session managers whose runtime is being built in the background, outside any measurement. */
  private readonly backgroundManagers = new WeakSet<SessionManager>();
  private readonly backgroundLifecycle: Array<{ name: string; durationMs: number }> = [];
  private prewarmTimer?: ReturnType<typeof setTimeout>;
  private sessions: UiSession[] = [];
  private lifecycleQueue: Promise<void> = Promise.resolve();
  /** Blocks new work after every running thread has drained and while Tau applies a reload. */
  private workbenchReloadPending = false;
  /** Monotonic ownership epoch; stale lifecycle work may not publish or activate. */
  private activationEpoch = 0;
  private threadIndexRefresh?: Promise<ThreadIndexSnapshot>;
  private readonly detailStore = new ThreadDetailStore(5);
  /** Publications coalesced into the next tick, keyed by what they carry. */
  private readonly coalescedPublishes = new Map<"shells" | "index", ReturnType<typeof setTimeout>>();
  private indexRecoveryTimer?: ReturnType<typeof setInterval>;
  private projectLabel?: string;
  /** Last known label per project; the provider is never awaited on an interactive path. */
  private readonly knownLabels = new Map<string, string | undefined>();
  private readonly labelRefreshes = new Map<string, Promise<void>>();
  /** What extensions know about projects: name, label, nesting. */
  private readonly projectFacts = new HostProjectFactsSet();
  /** A linked worktree keeps the repository's project name instead of becoming a new project. */
  private readonly knownProjectNames = new Map<string, string>();
  /** Which known project paths are nested in another project. Unclassified paths stay absent. */
  private readonly knownNestedProjects = new Map<string, boolean>();
  private readonly nestedClassifications = new Map<string, Promise<void>>();
  private readonly pendingShellUpdates = new Map<string, UiSession>();
  /** Set by the app shell so extensions can retitle the window. */
  onWindowTitle?: (title: string) => void;
  private readonly toolOutputBatcher: ToolOutputBatcher;
  private readonly toolOwners = new Map<string, string>();
  /** Extensions stepping into thread opening, forking, activation and the index sweep. */
  private readonly threadLifecycle = new HostThreadLifecycleSet();
  private readonly turnObservers = new HostTurnObserverSet();
  /** Providers naming entries that keep a text-empty assistant visible. */
  private readonly entryPinProviders = new Set<(thread: HostThread) => Iterable<string>>();
  /** Session managers behind the session files extensions opened; a runtime prepared for one shares it. */
  private readonly sessionFileManagers = new WeakMap<HostSessionFile, SessionManager>();
  private readonly createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const reason = sessionStartEvent?.reason ?? "initial";
    const scenario = reason === "initial" ? "bootstrap" : reason === "resume" ? "cold-switch" : "warm-switch";
    const ownsMeasurement = !this.lifecycleMetrics.isActive() && !this.backgroundManagers.has(sessionManager);
    if (ownsMeasurement) this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", scenario);
    const totalStartedAt = performance.now();

    const settingsStartedAt = performance.now();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    this.logRuntimePhase("settings", settingsStartedAt, reason, cwd);

    const modelsStartedAt = performance.now();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    this.logRuntimePhase("models", modelsStartedAt, reason, cwd);

    const resourcesStartedAt = performance.now();
    const resourceKey = this.resourceFingerprint(cwd, settingsManager);
    const cachedResources = this.resourceDiscoveryCache.get(resourceKey);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        ...(cachedResources ? cachedResourceOptions(cachedResources) : {}),
        noExtensions: this.safeMode,
        // Host extensions add theirs through the services facade; none in safe mode.
        extensionFactories: this.runtimeExtensionsFor(settingsManager, { sessionId: sessionManager.getSessionId(), cwd }),
      },
    });
    if (!cachedResources) this.resourceDiscoveryCache.set(resourceKey, captureResourceDiscovery(services.resourceLoader));
    this.logRuntimePhase(cachedResources ? "resources-cache-hit" : "resources", resourcesStartedAt, reason, cwd);

    const sessionStartedAt = performance.now();
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    });
    this.logRuntimePhase("session", sessionStartedAt, reason, cwd);
    this.logRuntimePhase("total", totalStartedAt, reason, cwd);
    if (ownsMeasurement) this.lifecycleMetrics.end();

    return {
      ...created,
      services,
      diagnostics: services.diagnostics,
    };
  };

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
    this.hostExtensionPackages = this.safeMode ? undefined : options.hostExtensionPackages;
    this.platform = options.platform ?? {};
    this.hostExtensions = new HostExtensionRegistry(this.hostExtensionServices(), (event) => this.emit(event));
    this.attached = new AttachedPiSession(this.attachedSessionHost());
    this.projection = new ThreadProjection(
      this.clientTurns,
      () => this.attached.snapshot,
      this.entryPinProviders,
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

  /** What the attached Pi session may ask of the host; it never touches the thread registry itself. */
  private attachedSessionHost(): AttachedSessionHost {
    return {
      safeMode: this.safeMode,
      clientTurns: this.clientTurns,
      emit: (event) => this.emit(event),
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
      setCwd: (cwd) => { this.cwd = cwd; },
      onSessionEvent: (event, turn, sessionId) => this.handleSessionEvent(event, turn, sessionId, this.cwd),
      onSnapshot: (requestId, stillCurrent) => {
        void this.snapshot().then((snapshot) => {
          if (!stillCurrent()) return;
          this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot, requestId) });
          this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) });
        }).catch((error) => this.fail(error));
      },
      onReconnected: async (activationEpoch) => {
        await this.refreshActiveThreadIndex(false);
        if (!this.isCurrentActivation(activationEpoch)) return;
        const snapshot = await this.snapshot();
        if (!this.isCurrentActivation(activationEpoch)) return;
        for (const update of this.lifecycleUpdates(snapshot)) this.emitUpdate(update);
        this.emit({ type: "event-log", label: "bridge.reconnected", detail: "Pi session bridge", timestamp: Date.now() });
      },
    };
  }

  /** What a host extension may ask of core: the workspace, project identity, Git cache, logging. */
  private hostExtensionServices(): HostExtensionServices {
    return {
      cwd: () => this.cwd,
      safeMode: this.safeMode,
      log: (label, detail) => this.log(label, detail),
      openWorkspace: (path) => this.setWorkspace(path),
      knownWorkspacePath: (path) => this.knownWorkspacePath(path),
      projectName: (cwd) => this.loadProjectName(cwd),
      rememberProjectName: (cwd, name) => { this.knownProjectNames.set(cwd, name); },
      pickDirectory: (options) => this.platform.pickDirectory
        ? this.platform.pickDirectory(options)
        : Promise.reject(new Error("This host has no folder picker.")),
      runtimeOwner: () => this.attached.isAttached ? "pi" : "tau",
      thread: (sessionId) => this.hostThread(sessionId),
      setThreadTitle: async (sessionId, title, source) => { await this.applyThreadTitle(this.requireThread(sessionId), title, source); },
      attachedRuntime: (sessionId) => this.attachedRuntime(sessionId),
      describeProjects: (facts) => this.projectFacts.add(facts),
      noteSubprocess: () => this.lifecycleMetrics.countSubprocess(),
      findCommand: (name) => findExecutable(name),
      sessions: {
        list: async () => (await SessionManager.listAll()).map((info) => ({ sessionId: info.id, path: info.path, cwd: info.cwd })),
        open: (path) => {
          // Pi falls back to process.cwd() for a missing file; never hand that out.
          if (!existsSync(path)) throw new Error(`No session file at ${path}.`);
          return this.sessionFile(SessionManager.open(path));
        },
        prepare: (session, options) => this.prepareThread(session, options),
        exclusive: (work) => this.runLifecycle(work),
        refreshIndex: async () => ({
          version: HOST_PROTOCOL_VERSION,
          type: "thread-index",
          index: await this.refreshThreadIndex(false).catch(() => this.threadIndexSnapshot()),
        }),
      },
      registerThreadLifecycle: (lifecycle) => this.threadLifecycle.add(lifecycle),
      registerTurnObserver: (observer) => this.turnObservers.add(observer),
      pinTranscriptEntries: (provider) => {
        this.entryPinProviders.add(provider);
        return () => { this.entryPinProviders.delete(provider); };
      },
      decorateUiPrompt: (decorator) => this.extensionUi.addDecorator(decorator),
      registerRuntimeExtension: (name, factory, options) => {
        const contribution = { name, factory, ...(options ?? {}) };
        this.runtimeExtensionContributions.push(contribution);
        return () => {
          const index = this.runtimeExtensionContributions.indexOf(contribution);
          if (index >= 0) this.runtimeExtensionContributions.splice(index, 1);
        };
      },
      setPermissionLevel: (provider) => { this.permissionLevelProvider = provider; },
      registerRuntimeBackend: (provider) => {
        if (provider.kind === "pi" || !provider.kind) throw new Error(`Runtime backend kind "${provider.kind}" is reserved.`);
        if (this.backends.has(provider.kind)) throw new Error(`Runtime backend "${provider.kind}" is already registered.`);
        assertRuntimeAdapter(provider.adapter);
        if (provider.adapter.id !== provider.kind) throw new Error(`Runtime backend "${provider.kind}" must carry an adapter of the same kind.`);
        this.backends.set(provider.kind, provider);
        return () => { if (this.backends.get(provider.kind) === provider) this.backends.delete(provider.kind); };
      },
      presentUi: (presenter) => {
        this.uiPresenters.add(presenter);
        return () => { this.uiPresenters.delete(presenter); };
      },
    };
  }

  /** Offers a ctx.ui drawing to every presenter; false when none handles that surface. */
  private presentUi<K extends keyof HostUiPresenter>(method: K, ...args: Parameters<NonNullable<HostUiPresenter[K]>>): boolean {
    let handled = false;
    for (const presenter of this.uiPresenters) {
      const draw = presenter[method] as ((...params: typeof args) => void) | undefined;
      if (!draw) continue;
      try { draw.apply(presenter, args); } catch (error) { this.log("extension-ui.presenter-failed", `${method}: ${this.errorMessage(error)}`); }
      handled = true;
    }
    return handled;
  }

  private hostThread(sessionId?: string): HostThread | undefined {
    const thread = this.threadFor(sessionId);
    return thread ? this.hostThreadFor(thread) : undefined;
  }

  private hostThreadFor(thread: ThreadRuntime): HostThread {
    return {
      sessionId: thread.threadId, cwd: thread.cwd, backendKind: thread.backend.kind,
      get sessionFile() { return thread.sessionFile; },
      isStreaming: () => thread.backend.isStreaming() || thread.adapterStreaming,
      isIdle: () => !thread.backend.isStreaming() && thread.backend.isIdle() && !thread.adapterStreaming
      && thread.adapterPending === 0 && !this.extensionUi.hasOpen(thread.threadId),
      waitForIdle: () => thread.backend.waitForIdle(),
      isCurrent: () => this.threads.get(thread.threadId)?.runtime === thread,
      sessionName: () => thread.backend.sessionName(),
      transcript: () => thread.backend.transcript(),
      completeTitle: (provider, modelId, conversation) => thread.backend.completeTitle(provider, modelId, conversation),
      complete: (provider, modelId, request) => thread.backend.complete(provider, modelId, request),
      modelApi: () => thread.backend.modelApi(),
      shortcuts: (userBindings) => thread.backend.shortcuts(userBindings),
      runShortcut: (keys, userBindings) => thread.backend.runShortcut(keys, userBindings),
      entries: () => thread.backend.branchEntries(),
      appendEntry: (customType, data) => thread.backend.appendCustomEntry(customType, data),
    };
  }

  /** The Pi terminal owning a thread while Tau is attached; its extensions answer through the bridge. */
  private attachedRuntime(sessionId?: string): HostAttachedRuntime | undefined {
    if (!this.attachedOwns(sessionId) || !this.attached.snapshot) return undefined;
    return {
      sessionId: this.attached.snapshot.sessionId,
      invoke: (extensionId, name, input) => this.attached.command({ command: "extension", extensionId, name, input }),
    };
  }

  /** Wraps a session manager for extensions; a runtime prepared for the file later shares the manager. */
  private sessionFile(manager: SessionManager): HostSessionFile {
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
        let path: string | undefined;
        try { path = manager.createBranchedSession(entryId); } catch { return undefined; }
        return path ? this.sessionFile(manager) : undefined;
      },
    };
    this.sessionFileManagers.set(file, manager);
    return file;
  }

  /** Opens a runtime for a session file an extension created; it stays off screen until activated. */
  private async prepareThread(session: HostSessionFile, options: { previousSessionFile?: string } = {}): Promise<HostPreparedThread> {
    const manager = this.sessionFileManagers.get(session) ?? SessionManager.open(session.path);
    const runtime = await this.openThread(
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
            this.extensionCount = previous.backend.extensionCount();
          }
          throw error;
        }
      },
      discard: async () => {
        if (settled) return;
        settled = true;
        if (this.threads.get(runtime.threadId)?.runtime === runtime) await this.threads.release(runtime.threadId);
        else await this.disposeThread(runtime);
      },
    };
  }

  private runtimeExtensionsFor(settingsManager: SettingsManager, session: RuntimeSessionInfo): Array<{ name: string; factory: import("@earendil-works/pi-coding-agent").ExtensionFactory }> {
    const settings = { global: settingsManager.getGlobalSettings(), project: settingsManager.getProjectSettings() };
    return this.runtimeExtensionContributions
      .filter((contribution) => contribution.enabledFor?.(settings) ?? true)
      .map(({ name, factory }) => ({ name, factory: (pi) => factory(pi, session) }));
  }

  /** External runtimes launch with this; without an access extension everything is allowed. */
  private permissionLevel(): RuntimePermissionLevel {
    return this.permissionLevelProvider?.() ?? "full";
  }

  /** The provider behind a non-Pi backend kind. */
  private requireBackend(kind: ThreadBackendKind): HostRuntimeBackendProvider {
    const provider = this.backends.get(kind);
    if (!provider) throw new Error(`Runtime backend "${kind}" is not installed; enable its extension or unset TAU_RUNTIME_ADAPTER.`);
    return provider;
  }

  private async activateHostExtensions(): Promise<void> {
    for (const extension of this.pendingHostExtensions) await this.hostExtensions.activate(extension);
    await this.syncHostExtensionPackages();
  }

  /** Replaces the host halves of extension packages with what the workspace's folders hold now. */
  private async syncHostExtensionPackages(): Promise<void> {
    if (!this.hostExtensionPackages) return;
    let loaded: HostPackageLoadResult;
    try {
      loaded = await this.hostExtensionPackages(this.cwd);
    } catch (error) {
      this.log("host-extension.packages.failed", this.errorMessage(error));
      return;
    }
    for (const failure of loaded.errors) this.log("host-extension.package.failed", `${failure.path}: ${failure.message}`);
    for (const skip of loaded.skipped) this.log("host-extension.package.skipped", `${skip.directory}: ${skip.reason}`);
    const next = new Set(loaded.extensions.map((entry) => entry.extension.id));
    for (const id of this.packagedHostExtensionIds) {
      if (!next.has(id)) await this.hostExtensions.remove(id).catch((error) => this.log("host-extension.remove.failed", `${id}: ${this.errorMessage(error)}`));
    }
    for (const { extension, package: pkg } of loaded.extensions) {
      if (this.pendingHostExtensions.some((bundled) => bundled.id === extension.id)) {
        this.log("host-extension.package.failed", `${pkg.directory}: id ${extension.id} belongs to a bundled kit`);
        continue;
      }
      await this.hostExtensions.activate(extension);
      this.log("host-extension.package.loaded", `${extension.name} · ${pkg.scope} · ${pkg.directory}`);
    }
    this.packagedHostExtensionIds = next;
  }

  /** Turns a known host extension off or on again; the desktop toggle calls this for a package's host half. */
  async setHostExtensionActive(id: string, active: boolean): Promise<HostExtensionSummary[]> {
    if (active) await this.hostExtensions.activateKnown(id);
    else await this.hostExtensions.deactivate(id);
    this.log(active ? "host-extension.enabled" : "host-extension.disabled", id);
    return this.listHostExtensions();
  }

  invokeHostExtension(extensionId: string, command: string, input?: unknown): Promise<unknown> {
    return this.hostExtensions.invoke(extensionId, command, input);
  }

  listHostExtensions(): HostExtensionSummary[] {
    return this.hostExtensions.summaries();
  }

  private adapterFor(kind: ThreadBackendKind): AgentRuntimeAdapter {
    return kind === "pi" ? this.piAdapter : this.requireBackend(kind).adapter;
  }

  // ---------------------------------------------------------------------------
  // Active thread accessors. Most of the host reads "the runtime": it is the one
  // the workbench shows, or nothing while Pi's own TUI owns the visible thread.
  // ---------------------------------------------------------------------------

  private get active(): ThreadRuntime | undefined {
    return this.threads.active?.runtime;
  }

  private requireActive(): ThreadRuntime {
    const thread = this.active;
    if (!thread) throw new Error("Pi runtime is not ready");
    return thread;
  }

  private threadFor(threadId: string | undefined): ThreadRuntime | undefined {
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
  /** Whether a command for a Tau thread id belongs to the thread Pi's TUI owns. */
  private attachedOwns(threadId: string | undefined): boolean {
    return this.adapterFor("pi").id === "pi" && this.attached.owns(threadId);
  }

  private liveThreadForPath(path: string | undefined): ThreadRuntime | undefined {
    if (!path) return undefined;
    const external = externalThreadFromPath(path);
    if (external) return this.threads.get(external.threadId)?.runtime;
    const indexed = this.sessions.find((session) => session.path === path);
    if (indexed?.backendKind && indexed.backendKind !== "pi") return this.threads.get(indexed.id)?.runtime;
    return this.threads.list().find((record) => samePath(record.runtime.backend.sessionFile(), path))?.runtime;
  }

  private liveThreadIds(): Set<string> {
    return new Set(this.threads.list().map((record) => record.threadId));
  }

  private async initialSessionManager(cwd: string): Promise<SessionManager> {
    return SessionManager.continueRecent(cwd);
  }

  private async openInitialThread(cwd: string): Promise<ThreadRuntime> {
    if (this.defaultBackendKind !== "pi") {
      const kind = this.defaultBackendKind;
      const latest = (await this.requireBackend(kind).listThreads())
        .filter((record) => record.cwd === cwd)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      return this.openExternalThread(kind, latest?.threadId ?? randomUUID(), cwd, { resume: Boolean(latest) });
    }
    return this.openThread(await this.initialSessionManager(cwd), undefined);
  }

  async start(): Promise<HostBootstrap> {
    const activationEpoch = this.beginActivation();
    return this.runLifecycle(async () => {
      this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", "bootstrap");
      try {
        await this.activateHostExtensions();
        // A default backend nobody registered is a configuration error; say so now, not at the first thread.
        if (this.defaultBackendKind !== "pi") this.requireBackend(this.defaultBackendKind);
        await this.rememberProject(this.cwd);
        // Classify saved projects while the runtime opens. Each answer is a
        // single git call, so it is ready long before bootstrap reads the list.
        for (const project of this.projectHistory.list()) this.classifyNestedInBackground(project.path);
        if (!this.isCurrentActivation(activationEpoch)) throw new Error("The initial runtime was superseded before it became active.");
        const safeModeOwner = this.safeMode ? await findPiBridge(this.cwd) : undefined;
        if (safeModeOwner && processIsAlive(safeModeOwner.pid)) {
          throw new Error("Pi already owns this session. Close Pi before opening the project in Tau safe mode.");
        }
        if (this.defaultBackendKind !== "pi" || !(await this.attached.attach(this.cwd, undefined, {}, activationEpoch))) {
          if (!this.isCurrentActivation(activationEpoch)) throw new Error("The initial runtime was superseded before it became active.");
          // Extensions repair what they keep beside sessions (a restore
          // journal, say) before a session opens on this workspace.
          await this.threadLifecycle.beforeWorkspace(this.cwd);
          if (!this.isCurrentActivation(activationEpoch)) throw new Error("The initial runtime was superseded before it became active.");
          const thread = await this.openInitialThread(this.cwd);
          if (!await this.activateThread(thread, false, activationEpoch)) throw new Error("The initial runtime was superseded before it became active.");
        }
        if (!this.isCurrentActivation(activationEpoch)) throw new Error("The initial runtime was superseded before it became active.");
        this.labelFor(this.cwd);
        const indexStartedAt = performance.now();
        this.log("bootstrap.first-content");
        // The global index is independent of the active detail. Publish it when
        // ready rather than making first content wait for every session file.
        void this.refreshThreadIndex(true).then(() => {
          this.recordBackgroundLifecycle("session-index", indexStartedAt);
          this.log("bootstrap.full-ready");
          this.startIndexRecovery();
          this.scheduleRuntimePrewarm();
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
    await Promise.allSettled([...this.nestedClassifications.values()]);
    const host = { ...this.snapshotSync(await this.ensureModels()), projectLabel: this.projectLabel };
    const detail = this.detailForSnapshot(host);
    const result: HostBootstrap = {
      threadIndex: this.threadIndexSnapshot(),
      version: HOST_PROTOCOL_VERSION,
      detail,
      catalog: catalogFromSnapshot(host),
      project: { cwd: host.cwd, label: host.projectLabel },
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
    let result: TranscriptPage;
    if (this.attachedOwns(sessionId) && transcriptPagingNegotiated(this.attached.snapshot?.capabilities)) {
      const raw = cursor === undefined
        ? await this.attached.command({ command: "transcript_page" }) as unknown
        : await this.attached.command({ command: "transcript_page", cursor: bridgeCursorValue(cursor) }) as unknown;
      result = mapBridgeTranscriptPageValue(sessionId, raw);
    } else if (this.attachedOwns(sessionId)) {
      // Older Pi bridge extensions expose a bounded snapshot but no paging
      // command. Keep that compatibility path local to the retained window.
      const snapshot = this.projection.attachedHostSnapshot();
      result = localTranscriptPage(
        sessionId,
        snapshot.messages,
        snapshot.taskHistory,
        snapshot.turnActivityHistory,
        snapshot.turnActivityHistoryComplete,
        cursor,
      );
    } else {
      const thread = this.requireThread(sessionId);
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
    const result = this.attachedOwns(sessionId)
      ? await readAttachedToolOutput(toolCallId, (command) => this.attached.command(command))
      : readLocalToolOutput(this.projection.branchMessages(this.requireThread(sessionId)), toolCallId);
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

  /** Complete a correlated Pi handoff through one identity/publication path. */
  private completeAttachedNewSession(snapshot: PiBridgeSnapshot, requestId: NewThreadRequestId): NewThreadResult {
    this.attached.adoptSnapshot(snapshot);
    this.cwd = snapshot.cwd;
    const next = this.projection.attachedHostSnapshot();
    const firstUserMessage = snapshot.messages.find((message) => (
      message && typeof message === "object" && (message as { role?: string }).role === "user"
    )) as { content?: unknown } | undefined;
    const shell: UiSession = {
      id: snapshot.sessionId,
      path: snapshot.sessionFile,
      title: cleanThreadTitle(snapshot.sessionName || firstSentence(textFromContent(firstUserMessage?.content))),
      modifiedAt: Date.now(),
      projectPath: snapshot.cwd,
      projectName: this.projectNameFor(snapshot.cwd),
      projectLabel: this.labelFor(snapshot.cwd),
      messageCount: next.messages.length,
    };
    this.sessions = [shell, ...this.sessions.filter((entry) => entry.id !== shell.id)];
    return this.newThreadResult([
      { version: HOST_PROTOCOL_VERSION, type: "thread-shell", update: { sessionId: shell.id, shell } },
      ...this.lifecycleUpdates(next),
    ], { accepted: true }, requestId, snapshot.sessionId);
  }

  private lifecycleUpdates(snapshot: HostSnapshot, requestId?: NewThreadRequestId): HostUpdate[] {
    const shell = this.sessions.find((thread) => thread.id === snapshot.sessionId);
    return [
      ...(shell ? [{ version: HOST_PROTOCOL_VERSION, type: "thread-shell" as const, update: { sessionId: shell.id, shell } }] : []),
      { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot, requestId) },
      { version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) },
      { version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd: snapshot.cwd, label: snapshot.projectLabel } },
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
      const shell = this.sessions.find((thread) => thread.id === snapshot.sessionId);
      const initialUpdates: HostUpdate[] = [
        ...(shell ? [{ version: HOST_PROTOCOL_VERSION, type: "thread-shell" as const, update: { sessionId: shell.id, shell } }] : []),
        { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot, requestId) },
        { version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd: snapshot.cwd, label: snapshot.projectLabel } },
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
    return this.runLifecycle(() => this.setWorkspaceNow(cwd, activationEpoch));
  }

  private async setWorkspaceNow(cwd: string, activationEpoch: number): Promise<HostActionResult> {
    if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
    // Workspace switching never waits on another thread's history work.
    await this.rememberProject(cwd);
    if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
    if (cwd === this.cwd && (this.attached.isAttached || this.active)) {
      await this.threadLifecycle.beforeWorkspace(cwd);
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      return this.activeUpdates(activationEpoch);
    }
    if (this.defaultBackendKind === "pi" && await this.attached.attach(cwd, undefined, {}, activationEpoch)) {
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      await this.rememberProject(this.cwd);
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      await this.refreshActiveThreadIndex(false);
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      return this.activeUpdates(activationEpoch);
    }
    if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
    this.attached.detach();
    await this.threadLifecycle.beforeWorkspace(cwd);
    const startedAt = performance.now();
    const thread = this.defaultBackendKind !== "pi"
      ? await this.openInitialThread(cwd)
      : await (async () => {
        const manager = await this.initialSessionManager(cwd);
        return this.liveThreadForPath(manager.getSessionFile())
          ?? await this.openThread(manager, { type: "session_start", reason: "resume", previousSessionFile: this.active?.sessionFile });
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
      index: this.threadIndexSnapshot(),
    };
    this.emitUpdate(update);
    return this.actionResult([update]);
  }

  /**
   * Closes tool calls left dangling by a turn that never finished, so the thread
   * can be used again. Without a result the provider rejects the next request.
   */
  async recoverThread(): Promise<HostActionResult> {
    // While Pi owns the thread its session file has another writer. Only take it
    // over when Pi has actually stopped answering; otherwise repair belongs there.
    if (this.attached.isAttached) {
      const sessionFile = this.attached.descriptor!.sessionFile;
      let responsive = true;
      try {
        await this.attached.send({ command: "ping" }, 2_000);
      } catch {
        responsive = false;
      }
      // Only a run that is genuinely in flight is worth protecting: repairing
      // under Pi's feet mid-turn would race its writer. An idle or absent peer
      // is not using the session, so Tau takes it over to close the call.
      if (responsive && this.attached.snapshot?.isStreaming) {
        throw new Error("Pi is running this thread right now. Stop the run in Pi, then try again.");
      }
      this.log(responsive ? "bridge.takeover" : "bridge.unresponsive", "recover_thread");
      this.attached.detach();
      await this.attached.withoutAttaching(() => this.switchSession(sessionFile));
    }

    const thread = this.requireActive();
    return this.threads.run(thread.threadId, async () => {
      if (!isPiBackend(thread)) {
        if (thread.adapterPending > 0 || thread.backend.isStreaming()) await this.abortThread(thread);
        thread.adapterMessages = await thread.backend.transcript();
        const snapshot = await this.snapshot();
        const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) };
        this.emitUpdate(update);
        return this.actionResult([update]);
      }
      // A run that is still in flight owns its tool calls; closing them from
      // outside would race the runtime. Stop it first, then repair.
      if (!thread.backend.isIdle() || thread.adapterPending > 0) await this.abortThread(thread);
      // Zero dangling calls is a success: the session is already consistent and
      // the caller only has stale activity to clear.
      const dangling = findDanglingToolCalls(thread.backend.branchEntries()
        .flatMap((entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "message"
          ? [(entry as { message?: unknown }).message]
          : []));
      for (const { toolCallId, toolName } of dangling) {
        thread.backend.appendMessage({
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
    this.assertWorkbenchReloadAvailable();
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
    if (prepared && backendKind !== "pi" && !this.backends.has(backendKind)) {
      throw new Error("Prepared prompt names an unsupported runtime backend.");
    }
    if (backendKind === "pi" && this.attached.isAttached && (!cwd || cwd === this.cwd)) {
      if (!this.isCurrentActivation(activationEpoch)) return this.staleNewThreadResult(requestId);
      const attachedRequestId = requestId ?? createNewThreadRequestId(randomUUID());
      try {
        assertBridgeImageInputCapability(this.attached.snapshot, attachments);
      } catch (error) {
        return this.newThreadResult([], { accepted: false, message: this.errorMessage(error) }, attachedRequestId);
      }
      try {
        const attachedSessionId = this.attached.snapshot?.sessionId, rebind = attachedPromptRebind(prepared, attachedSessionId);
        const attachedPrepared = rebind ? await this.preparePrompt(initialPrompt ?? "", attachedSessionId, rebind.skill) : prepared;
        if (attachedPrepared) this.assertAttachedPreparedPrompt(initialPrompt ?? "", attachedPrepared, attachedSessionId);
        if (identity) this.clientTurns.enqueueAny(identity);
        const outcome = await this.attached.requestNewSession({
          requestId: attachedRequestId,
          projectPath: this.cwd,
          initialPrompt,
          attachments,
          identity,
          ...(attachedPrepared ? { prepared: this.attachedPreparedPrompt(attachedPrepared) } : {}),
        });
        if (!this.isCurrentActivation(activationEpoch)) return this.staleNewThreadResult(requestId);
        if (!outcome.snapshot) return this.newThreadResult([], { accepted: true }, attachedRequestId);
        return this.completeAttachedNewSession(outcome.snapshot, attachedRequestId);
      } catch (error) {
        if (identity) this.clientTurns.cancel(undefined, identity);
        if (!this.isCurrentActivation(activationEpoch)) return this.staleNewThreadResult(requestId);
        const reason = error instanceof Error ? error.message : String(error);
        this.log("bridge.new_session.rejected", reason);
        return this.newThreadResult([], { accepted: false, message: reason }, attachedRequestId);
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
    return this.runLifecycle(async () => {
      if (!this.isCurrentActivation(activationEpoch)) return this.staleNewThreadResult(requestId);
      const startedAt = performance.now();
      const targetCwd = cwd ?? this.cwd;
      this.attached.detach();
      const spare = backendKind === "pi" ? await this.takePreparedThread(targetCwd) : undefined;
      const thread = spare
        ?? (backendKind !== "pi"
          ? await this.openExternalThread(backendKind, randomUUID(), targetCwd, { resume: false })
          : await this.openThread(
            SessionManager.create(targetCwd),
            { type: "session_start", reason: "new", previousSessionFile: this.active?.sessionFile },
            { adopt: false, prepared: true },
          ));
      let lifecycle: "prepared" | "adopting" | "adopted" | "promoted" = "prepared";
      try {
        if (isPiBackend(thread) && thread.runtime) assertImageInputCapability(thread.runtime.session, attachments);
        else if (!isPiBackend(thread) && attachments.length > 0) {
          throw new Error("Image attachments are not supported by the selected runtime adapter.");
        }
        // Decode and validate attachment data before promoting a prepared
        // runtime, so malformed input cannot leave an adopted blank thread.
        if (attachments.length > 0) promptImages(attachments);
        lifecycle = "adopting";
        await this.adoptThread(thread);
        lifecycle = "adopted";
        if (!await this.activateThread(thread, true, activationEpoch)) {
          if (this.threads.get(thread.threadId)?.runtime === thread && this.active !== thread) {
            await this.threads.release(thread.threadId);
          }
          return this.staleNewThreadResult(requestId);
        }
        lifecycle = "promoted";
        if (isPiBackend(thread)) {
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
          this.retitleShell(thread.threadId, firstSentence(visiblePrompt));
        }
      } catch (error) {
        // A pure validation failure leaves an untouched spare available. Once
        // adoption or activation has started, discard the candidate on failure
        // (except a prompt rejection after promotion: the visible blank thread
        // remains active and the scoped renderer draft remains untouched).
        if (lifecycle === "prepared") {
          if (isPiBackend(thread)) this.retainPreparedThread(thread);
          else await this.disposeThread(thread);
          return this.newThreadResult([], { accepted: false, message: this.errorMessage(error) }, requestId);
        } else if (lifecycle !== "promoted") {
          if (this.threads.has(thread.threadId)) await this.threads.release(thread.threadId);
          else await this.disposeThread(thread);
          this.scheduleSpareThread(targetCwd, true);
          return this.newThreadResult([], { accepted: false, message: this.errorMessage(error) }, requestId);
        }
        thread.cancelEventBarrier();
        const active = await this.activeUpdates();
        return { ...active, submission: { accepted: false, message: this.errorMessage(error) }, ...(requestId ? { requestId } : {}) };
      }
      if (!this.isCurrentActivation(activationEpoch)) return this.staleNewThreadResult(requestId);
      this.logReplacement(spare ? "new-spare" : "new", startedAt);
      if (backendKind === "pi") this.scheduleSpareThread(targetCwd);
      void this.publishNewSessionUpdates(activationEpoch, requestId, thread.sessionId);
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
    return this.runLifecycle(async () => {
      const targetCwd = cwd ?? this.cwd;
      const generation = ++this.preparedThreadCapabilityGeneration;
      if (this.attached.isAttached && (!cwd || cwd === this.cwd)) {
        return { cwd: targetCwd, generation, supportsImageInput: this.attached.snapshot?.supportsImageInput ?? false };
      }
      if (!this.spare || this.spare.cwd !== targetCwd) this.scheduleSpareThread(targetCwd, true);
      const spare = this.spare?.cwd === targetCwd ? this.spare : undefined;
      const prepared = spare ? await spare.pending : undefined;
      return {
        cwd: targetCwd,
        generation,
        supportsImageInput: modelSupportsImageInput(prepared?.runtime?.session.model),
      };
    });
  }

  async forkThread(entryId: string, expectedSessionId?: string): Promise<HostActionResult> {
    const activationEpoch = this.beginActivation();
    if (this.attached.isAttached) {
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      if (expectedSessionId && this.attached.snapshot?.sessionId !== expectedSessionId) {
        throw new Error("The selected thread changed before it could be forked.");
      }
      await this.attached.send({ command: "fork", entryId });
      return this.isCurrentActivation(activationEpoch) ? this.actionResult([]) : this.staleActivationResult();
    }
    return this.runLifecycle(async () => {
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      const thread = this.requireActive();
      if (expectedSessionId && thread.threadId !== expectedSessionId) {
        throw new Error("The selected thread changed before it could be forked.");
      }
      if (!isPiBackend(thread)) throw new Error("Only Pi threads can be forked.");
      if (thread.backend.isStreaming()) throw new Error("Wait for the active run before forking this thread.");
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
      await this.threadLifecycle.afterFork(this.hostThreadFor(thread), this.sessionFile(forkedManager));
      const forked = await this.openThread(
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
    if (this.attachedOwns(sessionId)) throw new Error("The session tree is unavailable while Pi owns this thread. Use /tree in Pi.");
    const thread = sessionId ? this.requireThread(sessionId) : this.requireActive();
    return thread.backend.tree();
  }

  /** Moves the active thread to another entry of its tree, staying in the same session file. */
  async navigateThreadTree(entryId: string, options: { summarize?: boolean } = {}, expectedSessionId?: string): Promise<ThreadTreeNavigationResult> {
    if (this.attached.isAttached) throw new Error("Tree navigation is unavailable while Pi owns this thread. Use /tree in Pi.");
    return this.runLifecycle(async () => {
      const thread = this.requireActive();
      if (expectedSessionId && thread.threadId !== expectedSessionId) throw new Error("The selected thread changed before it could be moved.");
      if (!isPiBackend(thread)) throw new Error("Only Pi threads have a session tree.");
      if (thread.backend.isStreaming()) throw new Error("Wait for the active run before moving this thread.");
      const result = await thread.backend.navigateTree(entryId, options);
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
    if (this.attached.isAttached) throw new Error("Duplicating is unavailable while Pi owns this thread. Use /clone in Pi.");
    const thread = this.requireActive();
    if (expectedSessionId && thread.threadId !== expectedSessionId) throw new Error("The selected thread changed before it could be duplicated.");
    const leafId = thread.backend.leafEntryId();
    if (!leafId) throw new Error("Nothing to duplicate yet. Send a first message before duplicating this thread.");
    return this.forkThread(leafId, thread.threadId);
  }

  async exportThreadMarkdown(expectedSessionId?: string): Promise<string> {
    if (this.attached.isAttached) {
      if (expectedSessionId && this.attached.snapshot?.sessionId !== expectedSessionId) {
        throw new Error("The selected thread changed before it could be copied.");
      }
      const result = await this.attached.send({ command: "export_markdown" }) as {
        title?: unknown;
        cwd?: unknown;
        sessionId?: unknown;
        messages?: unknown;
      };
      if (!Array.isArray(result.messages)) throw new Error("Pi did not return a normalized chat transcript.");
      const messages = result.messages as Array<{ role?: string; content?: unknown }>;
      const explicitTitle = typeof result.title === "string"
        ? safeSessionTitle(result.title)
        : safeSessionTitle(this.attached.snapshot?.sessionName);
      const firstUserMessage = messages.find((message) => message.role === "user");
      return formatChatTranscript({
        title: explicitTitle || firstSentence(visibleTitleText(textFromContent(firstUserMessage?.content))),
        cwd: typeof result.cwd === "string" ? result.cwd : this.attached.snapshot?.cwd ?? this.cwd,
        threadId: typeof result.sessionId === "string" ? result.sessionId : this.attached.snapshot?.sessionId ?? "",
        // The Pi bridge owns normalization against its live command registry.
        // Re-parsing here could reinterpret a legitimate visible `$skill ...`
        // instruction after the wrapper has already been removed.
        messages,
      });
    }
    const thread = this.requireThread(expectedSessionId);
    if (!isPiBackend(thread)) {
      const visibleMessages = await thread.backend.transcript();
      return formatChatTranscript({
        title: safeSessionTitle(thread.adapterTitle) || firstSentence(visibleTitleText(visibleMessages.find((message) => message.role === "user")?.text ?? "")),
        cwd: thread.cwd,
        threadId: thread.threadId,
        messages: visibleMessages.map((message) => ({ role: message.role, content: [{ type: "text", text: message.text }] })),
      });
    }
    // The backend owns transcript normalization. Export consumes its visible
    // projection so runtime wrappers, provider syntax, and injected bodies do
    // not leak into copied chat history.
    const visibleMessages = await thread.backend.transcript();
    const messages = visibleMessages.map((message) => ({
      role: message.role,
      content: [{ type: "text", text: message.text }],
    }));
    return formatChatTranscript({
      title: safeSessionTitle(thread.backend.sessionName()) || safeSessionTitle(thread.adapterTitle) || firstSentence(visibleTitleText(textFromContent(messages.find((message) => message.role === "user")?.content))),
      cwd: thread.cwd,
      threadId: thread.threadId,
      messages,
    });
  }

  private async sendThroughRuntimeAdapter(
    thread: ThreadRuntime,
    text: string,
    attachments: UiPromptAttachment[],
    delivery: "prompt" | "steer" | "followUp",
    clientMessageId?: string,
    prepared?: PreparedPrompt,
  ): Promise<void> {
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
      return this.sendThroughRuntimeAdapterNow(thread, text, attachments, delivery, clientMessageId, prepared);
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
    clientMessageId?: string,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    const commands = this.projection.composerCommands(thread);
    if (prepared) this.assertPreparedPrompt(thread, text, prepared, commands);
    const abortController = new AbortController();
    thread.adapterAbortControllers ??= new Set<AbortController>();
    thread.adapterAbortControllers.add(abortController);
    try {
      if (attachments.length > 0) throw new Error("Image attachments are not supported by the selected runtime adapter.");
      if (!isPiBackend(thread)) {
        await thread.backend.prompt({ text, delivery, ...(clientMessageId ? { clientMessageId } : {}), ...(prepared ? { prepared } : {}), signal: abortController.signal });
        thread.adapterMessages = await thread.backend.transcript();
        const backendDetail = await thread.backend.detail();
        thread.adapterTitle = backendDetail.title;
        thread.adapterTitleSource = backendDetail.titleSource;
        await this.refreshThreadShell(thread, true);
        return;
      }
      throw new Error("Pi prompts must use the Pi session backend.");
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
    if (this.attachedOwns(sessionId)) {
      const result = await this.attached.command({ command: "prepare_prompt", text, ...(skill ? { skill } : {}) });
      if (!result || typeof result !== "object") throw new Error("Pi bridge returned an invalid prepared prompt.");
      const prepared = result as Partial<PiBridgePreparedPrompt>;
      if (typeof prepared.visibleText !== "string" || typeof prepared.runtimeText !== "string" || typeof prepared.sourceFingerprint !== "string") {
        throw new Error("Pi bridge returned an invalid prepared prompt.");
      }
      const preparedResult: PreparedPrompt = {
        tauThreadId: this.attached.snapshot?.sessionId,
        providerSessionId: this.attached.snapshot?.sessionId,
        sessionId: this.attached.snapshot?.sessionId,
        backendKind: "pi",
        runtimeCapabilities: prepared.runtimeCapabilities ?? PI_AGENT_RUNTIME_ADAPTER.capabilities,
        visibleText: prepared.visibleText,
        runtimeText: prepared.runtimeText,
        ...(prepared.skill ? { skill: prepared.skill } : {}),
        sourceFingerprint: prepared.sourceFingerprint,
      };
      validatePreparedPrompt(text, preparedResult, {
        backendKind: "pi",
        threadId: this.attached.snapshot?.sessionId,
        providerSessionId: this.attached.snapshot?.sessionId,
        runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
        commands: this.attached.snapshot?.composerCommands ?? [],
      });
      return preparedResult;
    }
    const target = sessionId
      ? this.requireThread(sessionId)
      : (this.active && threadBackendKind(this.active) === this.defaultBackendKind ? this.active : undefined);
    if (target?.backend) return target.backend.preparePrompt(text, skill);
    if (target) {
      return this.preparePromptForAdapter(
        text,
        skill,
        target.runtimeAdapter,
        this.projection.composerCommands(target),
        target.sessionId,
        threadBackendKind(target),
      );
    }
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
    if (adapter.id !== "pi") this.requireBackend(adapter.id).assertPromptAllowed?.(this.permissionLevel());
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

  private attachedPreparedPrompt(prepared: PreparedPrompt): PiBridgePreparedPrompt {
    if (prepared.backendKind !== "pi") throw new Error("Prepared prompt belongs to another runtime.");
    return {
      visibleText: prepared.visibleText,
      runtimeText: prepared.runtimeText,
      runtimeCapabilities: prepared.runtimeCapabilities,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      sourceFingerprint: prepared.sourceFingerprint,
    };
  }

  private assertAttachedPreparedPrompt(text: string, prepared: PreparedPrompt, sessionId?: string): void {
    this.assertPreparedPromptData(
      text,
      prepared,
      "pi",
      sessionId,
      sessionId,
      PI_AGENT_RUNTIME_ADAPTER,
      composerCommandsForAdapter(this.attached.snapshot?.composerCommands ?? [], PI_AGENT_RUNTIME_ADAPTER),
    );
  }

  async switchSession(path: string): Promise<HostActionResult> {
    const activationEpoch = this.beginActivation();
    // The index carries the lifecycle owner; the virtual path of an external
    // thread is the fallback for entries that predate the index.
    const indexedSession = this.sessions.find((session) => session.path === path);
    const backendKind = indexedSession?.backendKind ?? externalThreadFromPath(path)?.kind;
    // A thread whose runtime is already live switches immediately and outside
    // the lifecycle queue: nothing is created, aborted or replaced.
    const live = this.attached.isAttached ? undefined : this.liveThreadForPath(path);
    if (live) {
      const startedAt = performance.now();
      if (!await this.activateThread(live, false, activationEpoch)) return this.staleActivationResult();
      this.logReplacement("live-switch", startedAt);
      return this.activeUpdates(activationEpoch);
    }
    return this.runLifecycle(async () => {
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      const startedAt = performance.now();
      if ((backendKind ?? "pi") === "pi" && this.defaultBackendKind === "pi" && await this.attached.attach(dirname(path), path, {}, activationEpoch)) {
        if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
        this.cwd = this.attached.snapshot!.cwd;
        await this.rememberProject(this.cwd);
        if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
        await this.refreshActiveThreadIndex(false);
        if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
        return this.activeUpdates(activationEpoch);
      }
      if (!this.isCurrentActivation(activationEpoch)) return this.staleActivationResult();
      this.attached.detach();
      await this.threadLifecycle.beforeWorkspace(this.cwd);
      const alreadyLive = this.liveThreadForPath(path);
      this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", alreadyLive ? "warm-switch" : "cold-switch");
      try {
        const thread = alreadyLive ?? await this.openThreadForPath(path, "resume", false, backendKind);
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
    if (this.attached.isAttached || this.safeMode || this.liveThreadForPath(path)) return;
    const backendKind = this.sessions.find((session) => session.path === path)?.backendKind
      ?? externalThreadFromPath(path)?.kind;
    const startedAt = performance.now();
    try {
      await this.openThreadForPath(path, "resume", true, backendKind);
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
  ): Promise<void> {
    this.assertWorkbenchReloadAvailable();
    const onPreflightResult = typeof clientMessageIdOrPreflight === "function" ? clientMessageIdOrPreflight : undefined;
    const identity = typeof clientMessageIdOrPreflight === "function"
      ? undefined
      : clientIdentityForRequest(clientMessageIdOrPreflight);
    const clientMessageId = identity?.clientMessageId;
    if (this.attachedOwns(sessionId)) {
      // Pi's bridge extension is the runtime owner and performs prompt
      // normalization against its current command registry exactly once.
      try {
        assertBridgeImageInputCapability(this.attached.snapshot, attachments);
        if (prepared) this.assertAttachedPreparedPrompt(text, prepared, this.attached.snapshot?.sessionId);
        if (identity) this.clientTurns.enqueue(this.attached.snapshot?.sessionId, identity);
        await this.attached.send({
          command: "prompt",
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(identity ?? {}),
          ...(prepared ? { prepared: this.attachedPreparedPrompt(prepared) } : {}),
        });
      } catch (error) {
        if (identity) this.clientTurns.cancel(this.attached.snapshot?.sessionId, identity);
        onPreflightResult?.({ accepted: false, error });
        throw error;
      }
      onPreflightResult?.({ accepted: true });
      this.log("prompt.accepted", text.slice(0, 80));
      return;
    }
    const thread = this.requireThread(sessionId);
    if (!isPiBackend(thread)) {
      await this.sendThroughRuntimeAdapter(thread, text, attachments, "prompt", clientMessageId, prepared);
      onPreflightResult?.({ accepted: true });
      return;
    }
    if (thread.runtime) assertImageInputCapability(thread.runtime.session, attachments);
    // Resolve the runtime spelling once at the backend boundary. The same
    // prepared object is then used for marker correlation and delivery, so a
    // resource-registry change cannot cause host and backend to normalize
    // different dialects for one turn.
    const resolvedPrepared = prepared ?? await thread.backend.preparePrompt(text);
    this.assertPreparedPrompt(thread, text, resolvedPrepared, this.projection.composerCommands(thread));
    const prompt = resolvedPrepared.runtimeText;
    const isExtensionCommand = this.projection.isExtensionCommand(thread, prompt);
    const preparedTurnId = isExtensionCommand ? undefined : randomUUID();
    const wasStreaming = thread.backend.isStreaming();
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
    const images = promptImages(attachments);
    this.log("prompt.accepted", `${prompt.slice(0, 80)}${images.length ? ` · ${images.length} image(s)` : ""}`);
    try {
      if (identity) this.clientTurns.enqueue(thread.threadId, identity);
      markerActive = this.clientMessages.appendMarker(thread, clientMessageId, text, resolvedPrepared.sourceFingerprint);
      const run = thread.backend.prompt({
        text,
        delivery: "prompt",
        ...(clientMessageId ? { clientMessageId } : {}),
        prepared: resolvedPrepared,
        images,
        promptOptions: {
          images,
          streamingBehavior: wasStreaming ? "followUp" : undefined,
          preflightResult: (success) => reportPreflight({ accepted: success }),
        },
      });
      void run.then(async () => {
        if (preflightState === "pending") reportPreflight({ accepted: true });
        if (preparedTurnId) await this.turnObservers.ended(thread.threadId, preparedTurnId, "completed");
        if (this.threads.get(thread.threadId)?.runtime === thread) await this.refreshThreadShell(thread, true);
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
    this.log("prompt.accepted", `${text.slice(0, 80)}${attachments.length ? ` · ${attachments.length} image(s)` : ""}`);
  }

  async runShellAction(command: string, includeInContext = false, expectedCwd?: string): Promise<ShellActionResult> {
    this.assertWorkbenchReloadAvailable();
    if (this.attached.isAttached) throw new Error("Run project actions in Pi while Tau is attached to its runtime.");
    const shellCommand = command.trim();
    if (!shellCommand) throw new Error("An action command is required.");
    const thread = await this.runLifecycle(async () => {
      if (expectedCwd && this.cwd !== expectedCwd) {
        throw new Error("The selected project did not finish loading. Run the action again.");
      }
      return this.requireActive();
    });
    if (!isPiBackend(thread)) throw new Error("Project actions are unavailable for threads of an external runtime.");
    if (thread.backend.isBashRunning()) throw new Error("Another project action is already running.");
    const result = await thread.backend.executeBash(shellCommand, includeInContext);
    if (this.threads.get(thread.threadId)?.runtime === thread) await this.refreshThreadShell(thread, true);
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
    this.assertWorkbenchReloadAvailable();
    const identity = clientIdentityForRequest(clientMessageIdOrIdentity);
    const clientMessageId = identity?.clientMessageId;
    if (this.attachedOwns(sessionId)) {
      assertBridgeImageInputCapability(this.attached.snapshot, attachments);
      if (prepared) this.assertAttachedPreparedPrompt(text, prepared, this.attached.snapshot?.sessionId);
      try {
        if (identity) this.clientTurns.enqueue(this.attached.snapshot?.sessionId, identity);
        await this.attached.send({
          command: "prompt",
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          deliverAs: "steer",
          ...(identity ?? {}),
          ...(prepared ? { prepared: this.attachedPreparedPrompt(prepared) } : {}),
        });
      } catch (error) {
        if (identity) this.clientTurns.cancel(this.attached.snapshot?.sessionId, identity);
        throw error;
      }
      return;
    }
    let thread: ThreadRuntime | undefined;
    let preparedTurnId: string | undefined;
    try {
      thread = this.requireThread(sessionId);
      if (identity && isPiBackend(thread)) this.clientTurns.enqueue(thread.threadId, identity);
      if (!isPiBackend(thread)) {
        await this.sendThroughRuntimeAdapter(thread, text, attachments, "steer", clientMessageId, prepared);
        return;
      }
      if (thread.runtime) assertImageInputCapability(thread.runtime.session, attachments);
      const resolvedPrepared = prepared ?? await thread.backend.preparePrompt(text);
      this.assertPreparedPrompt(thread, text, resolvedPrepared, this.projection.composerCommands(thread));
      if (!this.projection.isExtensionCommand(thread, resolvedPrepared.runtimeText)) {
        preparedTurnId = randomUUID();
        this.turnObservers.accepted(thread.threadId, preparedTurnId, { deferBefore: true, expectsInput: false });
      }
      let markerActive = this.clientMessages.appendMarker(thread, clientMessageId, text, resolvedPrepared.sourceFingerprint);
      try {
        await thread.backend.prompt({ text, delivery: "steer", ...(clientMessageId ? { clientMessageId } : {}), prepared: resolvedPrepared, images: promptImages(attachments) });
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
      if (identity && thread && isPiBackend(thread)) this.clientTurns.cancel(thread.threadId, identity);
      if (thread && preparedTurnId) await this.turnObservers.cancelled(thread.threadId, preparedTurnId);
      this.fail(error);
      throw error;
    }
  }

  async followUp(
    text: string,
    attachments: UiPromptAttachment[] = [],
    sessionId?: string,
    clientMessageIdOrIdentity?: ClientTurnRequest,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    this.assertWorkbenchReloadAvailable();
    const identity = clientIdentityForRequest(clientMessageIdOrIdentity);
    const clientMessageId = identity?.clientMessageId;
    if (this.attachedOwns(sessionId)) {
      assertBridgeImageInputCapability(this.attached.snapshot, attachments);
      if (prepared) this.assertAttachedPreparedPrompt(text, prepared, this.attached.snapshot?.sessionId);
      try {
        if (identity) this.clientTurns.enqueue(this.attached.snapshot?.sessionId, identity);
        await this.attached.send({
          command: "prompt",
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          deliverAs: "followUp",
          ...(identity ?? {}),
          ...(prepared ? { prepared: this.attachedPreparedPrompt(prepared) } : {}),
        });
      } catch (error) {
        if (identity) this.clientTurns.cancel(this.attached.snapshot?.sessionId, identity);
        throw error;
      }
      return;
    }
    let thread: ThreadRuntime | undefined;
    let preparedTurnId: string | undefined;
    try {
      thread = this.requireThread(sessionId);
      if (identity && isPiBackend(thread)) this.clientTurns.enqueue(thread.threadId, identity);
      if (!isPiBackend(thread)) {
        await this.sendThroughRuntimeAdapter(thread, text, attachments, "followUp", clientMessageId, prepared);
        return;
      }
      if (thread.runtime) assertImageInputCapability(thread.runtime.session, attachments);
      const resolvedPrepared = prepared ?? await thread.backend.preparePrompt(text);
      this.assertPreparedPrompt(thread, text, resolvedPrepared, this.projection.composerCommands(thread));
      if (!this.projection.isExtensionCommand(thread, resolvedPrepared.runtimeText)) {
        preparedTurnId = randomUUID();
        this.turnObservers.accepted(thread.threadId, preparedTurnId, { deferBefore: true, expectsInput: false });
      }
      let markerActive = this.clientMessages.appendMarker(thread, clientMessageId, text, resolvedPrepared.sourceFingerprint);
      try {
        await thread.backend.prompt({ text, delivery: "followUp", ...(clientMessageId ? { clientMessageId } : {}), prepared: resolvedPrepared, images: promptImages(attachments) });
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
      if (identity && thread && isPiBackend(thread)) this.clientTurns.cancel(thread.threadId, identity);
      this.fail(error, sessionId);
      if (thread && preparedTurnId) await this.turnObservers.cancelled(thread.threadId, preparedTurnId);
      throw error;
    }
  }

  async abort(sessionId?: string): Promise<void> {
    if (this.attachedOwns(sessionId)) {
      this.attached.cancelPendingNewSession(sessionId);
      await this.attached.send({ command: "abort" });
      return;
    }
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
    if (!isPiBackend(thread)) {
      thread.adapterAbortGeneration ??= 0;
      thread.adapterAbortGeneration += 1;
      for (const controller of thread.adapterAbortControllers ?? []) controller.abort();
      await thread.backend.abort();
      return;
    }
    await thread.backend.abort();
  }

  async setModel(provider: string, id: string): Promise<HostActionResult> {
    if (this.attached.isAttached) {
      await this.attached.send({ command: "set_model", provider, id });
      await this.attached.refreshSnapshot();
      return this.catalogResult();
    }
    const thread = this.requireActive();
    await thread.backend.setModel(provider, id);
    this.log("model.changed", `${provider}/${id}`);
    return this.catalogResult();
  }

  async setThinkingLevel(level: string): Promise<HostActionResult> {
    if (this.attached.isAttached) {
      await this.attached.send({ command: "set_thinking", level });
      await this.attached.refreshSnapshot();
      return this.catalogResult();
    }
    const thread = this.requireActive();
    await thread.backend.setThinkingLevel(level);
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
    let sessionId: string;
    let displayedTitle = title;
    if (this.attached.isAttached) {
      sessionId = this.attached.snapshot?.sessionId ?? "";
      if (expectedSessionId && sessionId !== expectedSessionId) {
        throw new Error("The selected thread did not finish loading. Try renaming it again.");
      }
      await this.attached.send({ command: "set_session_name", name: title });
      await this.attached.refreshSnapshot();
    } else {
      const thread = this.requireThread(expectedSessionId);
      sessionId = thread.threadId;
      return this.actionResult([await this.applyThreadTitle(thread, title, "renamed")]);
    }
    return this.actionResult([this.publishThreadTitle(sessionId, displayedTitle)]);
  }

  /** Stores a title on the thread's backend and publishes the renamed shell. */
  private async applyThreadTitle(thread: ThreadRuntime, title: string, source: "generated" | "renamed"): Promise<HostUpdate> {
    await thread.backend.setTitle(title, source);
    if (source === "renamed") {
      const detail = await thread.backend.detail();
      thread.adapterTitle = detail.title;
      thread.adapterTitleSource = detail.titleSource;
      return this.publishThreadTitle(thread.threadId, detail.title ?? title);
    }
    thread.adapterTitle = title;
    thread.adapterTitleSource = "generated";
    return this.publishThreadTitle(thread.threadId, title);
  }

  private publishThreadTitle(sessionId: string, title: string): HostUpdate {
    const now = Date.now();
    this.sessions = this.sessions.map((thread) =>
      thread.id === sessionId ? { ...thread, title, modifiedAt: now } : thread,
    );
    const shell = this.sessions.find((thread) => thread.id === sessionId);
    if (!shell) throw new Error("The active thread is missing from the session index.");
    this.log("title.renamed", title);
    const update: HostUpdate = {
      version: HOST_PROTOCOL_VERSION,
      type: "thread-shell",
      update: { sessionId, shell },
    };
    this.emitUpdate(update);
    return update;
  }

  private assertWorkbenchReloadAvailable(): void {
    if (this.workbenchReloadPending) throw new Error("Tau is waiting to apply changes. Cancel the reload before starting more work.");
  }

  private runningWorkbenchThreads(): ThreadRuntime[] {
    return this.threads.list()
      .map((record) => record.runtime)
      .filter((thread) => !thread.backend.isIdle() || thread.backend.isStreaming() || thread.adapterPending > 0 || thread.adapterStreaming);
  }

  private runningWorkbenchThreadCount(): number {
    return this.runningWorkbenchThreads().length + (this.attached.snapshot?.isStreaming ? 1 : 0);
  }

  private async waitForWorkbenchRuns(): Promise<void> {
    while (true) {
      const local = this.runningWorkbenchThreads();
      await Promise.all(local.map((thread) => thread.backend.waitForIdle()));
      if (this.attached.snapshot?.isStreaming) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        if (this.attached.isAttached) await this.attached.refreshSnapshot();
      }
      const ready = await this.runLifecycle(async () => {
        if (this.runningWorkbenchThreadCount() > 0) return false;
        this.workbenchReloadPending = true;
        return true;
      });
      if (ready) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  async prepareWorkbenchReload(mode: WorkbenchReloadMode): Promise<WorkbenchReloadPreparation> {
    if (mode === "wait") {
      await this.waitForWorkbenchRuns();
      return { ready: true, runningThreads: 0 };
    }
    return this.runLifecycle(async () => {
      if (this.workbenchReloadPending) return { ready: true, runningThreads: 0 };
      const runningThreads = this.runningWorkbenchThreadCount();
      if (mode === "inspect") {
        if (runningThreads === 0) this.workbenchReloadPending = true;
        return { ready: runningThreads === 0, runningThreads };
      }
      if (mode !== "abort") throw new Error(`Unknown workbench reload mode: ${mode}`);
      this.workbenchReloadPending = true;
      if (this.attached.snapshot?.isStreaming) await this.attached.send({ command: "abort" });
      await Promise.all(this.runningWorkbenchThreads().map((thread) => this.abortThread(thread)));
      return { ready: true, runningThreads: 0 };
    });
  }

  async releaseWorkbenchReload(): Promise<void> {
    this.workbenchReloadPending = false;
  }

  async reloadRuntime(): Promise<void> {
    return this.runLifecycle(async () => {
      if (this.attached.isAttached) {
        await this.attached.send({ command: "reload" });
        this.log("runtime.reload.requested", "Pi owner");
        return;
      }
      const thread = this.requireActive();
      if (thread.backend.kind !== "pi") throw new Error("Only the Pi runtime reloads its extensions; an external runtime manages its own resources.");
      if (thread.backend.isStreaming()) throw new Error("Wait for the active run before reloading Pi.");
      await thread.backend.reload();
      this.modelCatalogCache.invalidate();
      this.resourceDiscoveryCache.invalidate();
      // Other idle runtimes still hold the old resources; they are cheap to
      // rebuild on demand, so drop them rather than reload each one.
      this.discardSpare();
      for (const record of this.threads.list()) {
        if (record.runtime !== thread && isPiBackend(record.runtime)
          && record.runtime.backend.isIdle()
          && this.turnObservers.pending(record.threadId) === 0
          && !this.extensionUi.hasOpen(record.threadId)) {
          await this.threads.release(record.threadId);
        }
      }
      this.extensionCount = thread.backend.extensionCount();
      await this.syncHostExtensionPackages();
      this.log("runtime.reloaded");
      const snapshot = await this.snapshot();
      for (const update of this.lifecycleUpdates(snapshot)) this.emitUpdate(update);
      this.scheduleRuntimePrewarm();
      this.scheduleSpareThread(this.cwd);
    });
  }

  async compactContext(): Promise<HostActionResult> {
    if (this.attached.isAttached) {
      await this.attached.send({ command: "compact" }, 120_000);
      await this.attached.refreshSnapshot();
    } else {
      await this.requireActive().backend.compact();
    }
    this.log("context.compacted");
    const snapshot = await this.snapshot();
    const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) };
    this.emitUpdate(update);
    return this.actionResult([update]);
  }

  async snapshot(): Promise<HostSnapshot> {
    const models = await this.ensureModels();
    return { ...this.snapshotSync(models), projectLabel: this.labelFor(this.cwd) };
  }

  /** Workspace metadata is only exposed for projects already admitted by the host. */
  private async knownWorkspacePath(cwd: string): Promise<string> {
    return findKnownWorkspacePath(cwd, new Set([
      this.cwd,
      ...this.projectHistory.list().map((project) => project.path),
      ...this.sessions.map((session) => session.projectPath),
      ...this.threads.list().map((thread) => thread.cwd),
    ]));
  }

  async dispose(): Promise<void> {
    return this.runLifecycle(async () => {
      this.clientTurns.clear();
      this.toolOutputBatcher.dispose();
      for (const timer of this.coalescedPublishes.values()) clearTimeout(timer);
      this.coalescedPublishes.clear();
      if (this.indexRecoveryTimer) clearInterval(this.indexRecoveryTimer);
      this.indexRecoveryTimer = undefined;
      if (this.prewarmTimer) clearTimeout(this.prewarmTimer);
      this.prewarmTimer = undefined;
      this.pendingShellUpdates.clear();
      const teardownErrors: unknown[] = [];
      this.attached.detach();
      try { await this.hostExtensions.dispose(); } catch (error) { teardownErrors.push(error); }
      try { await this.discardSpare(); } catch (error) { teardownErrors.push(error); }
      const opening = [...this.openingThreads.values()];
      this.openingThreads.clear();
      await Promise.allSettled(opening);
      const results = await Promise.allSettled(this.threads.list().map((record) => this.threads.release(record.threadId)));
      for (const result of results) if (result.status === "rejected") teardownErrors.push(result.reason);
      try {
        await this.projectHistory.flush();
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

  /** Opens a thread of a registered backend; no Pi session is allocated for it. */
  private async openExternalThread(
    kind: ThreadBackendKind,
    threadId: string,
    cwd: string,
    options: { background?: boolean; adopt?: boolean; resume?: boolean } = {},
  ): Promise<ThreadRuntime> {
    if (this.safeMode) throw new Error("Only the Pi runtime is available in Tau safe mode.");
    const provider = this.requireBackend(kind);
    const backend = await provider.open(threadId, cwd, { resume: options.resume !== false }, {
      projectName: this.projectNameFor(cwd),
      projectLabel: this.knownLabels.get(cwd),
      permissionLevel: () => this.permissionLevel(),
      onMessage: (message) => {
        const thread = this.threads.get(threadId)?.runtime;
        if (thread) {
          thread.adapterMessages = [...thread.adapterMessages, message];
          this.emit(message.role === "user"
            ? { type: "user-message", sessionId: threadId, message }
            : { type: "assistant-end", sessionId: threadId, message });
        }
      },
    });
    const thread = new ThreadRuntime(backend);
    thread.adapterMessages = await backend.transcript();
    const detail = await backend.detail();
    thread.adapterTitle = detail.title;
    thread.adapterTitleSource = detail.titleSource;
    if (options.adopt !== false) await this.adoptThread(thread);
    return thread;
  }

  /**
   * Builds a runtime for one session, binds Tau's UI to it, and hands it to the
   * registry. The thread is live afterwards but not yet on screen.
   */
  private async openThread(
    manager: SessionManager,
    sessionStartEvent: RuntimeStartEvent | undefined,
    options: { background?: boolean; adopt?: boolean; prepared?: boolean; abortSignal?: AbortSignal } = {},
  ): Promise<ThreadRuntime> {
    const cwd = manager.getCwd() || this.cwd;
    // Extensions repair what they keep beside a session before its runtime can start a turn.
    if (manager.getSessionFile()) await this.threadLifecycle.beforeOpen(this.sessionFile(manager));
    if (options.background) this.backgroundManagers.add(manager);
    let runtime: AgentSessionRuntime | undefined;
    let thread: ThreadRuntime | undefined;
    let backend: PiThreadRuntimeBackend | undefined;
    try {
      const createdRuntime = await createAgentSessionRuntime(this.createRuntime, {
        cwd,
        agentDir: this.agentDir,
        sessionManager: manager,
        sessionStartEvent,
      });
      runtime = createdRuntime;
      backend = new PiThreadRuntimeBackend(createdRuntime, this.adapterFor("pi"), {
        mapMessages: (messages) => messages
          .map((message, index) => mapMessage(message, index, this.projection.mapping(thread!)))
          .filter((message): message is UiMessage => Boolean(message?.text || message?.skill)),
        index: async (owner) => {
          const existing = this.sessions.find((entry) => entry.id === owner.threadId);
          if (existing) return existing;
          const messages = await owner.transcript();
          return {
            id: owner.threadId,
            path: owner.sessionFile() ?? owner.threadId,
            title: cleanThreadTitle(safeSessionTitle(owner.sessionName()) || firstSentence(visibleTitleText(messages[0]?.text ?? ""))),
            modifiedAt: Date.now(),
            projectPath: owner.cwd,
            projectName: this.projectNameFor(owner.cwd),
            projectLabel: this.labelFor(owner.cwd),
            messageCount: messages.length,
            backendKind: "pi",
          };
        },
      });
      thread = new ThreadRuntime(backend, createdRuntime);
      const preparedThread = thread;
      if (options.prepared ?? options.adopt === false) thread.beginEventBarrier();
      const cancelPrepared = () => {
        this.extensionUi.cancelFor(preparedThread.threadId);
        void preparedThread.backend.abort().catch((error) => this.log("runtime.prepared.abort", this.errorMessage(error)));
      };
      if (options.abortSignal) {
        options.abortSignal.addEventListener("abort", cancelPrepared, { once: true });
        if (options.abortSignal.aborted) cancelPrepared();
      }
      if (sessionStartEvent?.reason === "resume") await backend!.resume();
      else await backend!.create();
      await this.bindThread(thread);
      if (options.abortSignal?.aborted) throw new Error("Prepared runtime creation was cancelled.");
      this.installThreadHooks(thread);
      if (options.adopt !== false) await this.adoptThread(thread);
      return thread;
    } catch (error) {
      // A prepared runtime may have created extension questions while binding.
      // Keep its barrier active until every callback and teardown side effect
      // has completed, then discard all buffered output.
      if (thread) this.extensionUi.cancelFor(thread.sessionId);
      if (runtime) {
        const cleanupErrors = await this.teardownRuntime(runtime);
        thread?.cancelEventBarrier();
        if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "Pi runtime initialization failed");
      } else thread?.cancelEventBarrier();
      throw error;
    } finally {
      this.backgroundManagers.delete(manager);
    }
  }

  private async adoptThread(thread: ThreadRuntime): Promise<void> {
    await this.threads.adopt({ threadId: thread.threadId, cwd: thread.cwd, runtime: thread, isolation: "in-process" });
  }

  /** One runtime per session file: concurrent opens for the same path share it. */
  private openThreadForPath(
    path: string,
    reason: "resume",
    background = false,
    backendKind?: ThreadBackendKind,
  ): Promise<ThreadRuntime> {
    const live = this.liveThreadForPath(path);
    if (live) return Promise.resolve(live);
    let pending = this.openingThreads.get(path);
    if (!pending) {
      pending = (async () => {
        const external = externalThreadFromPath(path);
        const indexedSession = this.sessions.find((session) => session.path === path);
        const owner = backendKind ?? indexedSession?.backendKind ?? external?.kind ?? "pi";
        if (owner !== "pi") {
          if (this.safeMode) throw new Error("Only the Pi runtime is available in Tau safe mode.");
          const threadId = external?.threadId ?? indexedSession?.id;
          if (!threadId) throw new Error("The thread has no durable Tau thread id.");
          const record = await this.requireBackend(owner).lookup(threadId);
          if (!record) throw new Error("The selected thread is no longer available in its runtime.");
          return this.openExternalThread(owner, record.threadId, record.cwd, { background });
        }
        if (external) throw new Error("The selected thread is owned by another runtime backend.");
        let manager: SessionManager;
        manager = SessionManager.open(path);
        return this.openThread(
          manager,
          { type: "session_start", reason, previousSessionFile: this.active?.sessionFile },
          { background },
        );
      })().then((thread) => thread).finally(() => {
        if (this.openingThreads.get(path) === pending) this.openingThreads.delete(path);
      });
      this.openingThreads.set(path, pending);
    }
    return pending;
  }

  private async bindThread(thread: ThreadRuntime): Promise<void> {
    if (!isPiBackend(thread)) return;
    const bindStartedAt = performance.now();
    await thread.backend.bind({
      uiContext: createExtensionUiContext({
        sessionId: () => thread.threadId,
        ask: (prompt) => this.extensionUi.ask(prompt, thread),
        notify: (message, level) => this.emitForThread(thread, { type: "notice", message, level, sessionId: thread.threadId }),
        setWindowTitle: (title) => {
          if (!thread.deferTitle(title)) this.onWindowTitle?.(title);
        },
        unsupported: (method) => this.logForThread(thread, "extension-ui.unsupported", method),
        setStatus: (key, text) => this.presentUi("setStatus", thread.threadId, key, text),
        setWidget: (key, lines, placement) => this.presentUi("setWidget", thread.threadId, key, lines, placement),
        setWorkingMessage: (message) => this.presentUi("setWorkingMessage", thread.threadId, message),
      }),
      mode: "rpc",
      onError: (error) => this.fail(error, thread.threadId, thread),
    }, (event) => this.handleSessionEvent(event, thread, thread.threadId, thread.cwd));
    this.recoverOrphanedClientMessageMarkers(thread);
    this.logRuntimePhase("bind", bindStartedAt, "active", thread.cwd, undefined, thread);
  }

  /**
   * A persisted request marker can outlive a host process that crashed or was
   * disconnected before Pi emitted the corresponding user message. Cancel
   * those markers before subscribing to a reopened runtime so they cannot be
   * assigned to a later, unrelated turn.
   */
  private recoverOrphanedClientMessageMarkers(thread: ThreadRuntime): void {
    const staleIds = unclaimedClientMessageIds(thread.backend.branchEntries(), knownSkillNames(this.projection.composerCommands(thread)));
    for (const clientMessageId of staleIds) {
      thread.backend.appendCustomEntry(CLIENT_MESSAGE_CANCEL_MARKER, clientMessageCancelMarker(clientMessageId).data);
      this.clientMessages.forget(thread, clientMessageId);
    }
  }

  private installThreadHooks(thread: ThreadRuntime): void {
    if (!isPiBackend(thread)) return;
    thread.backend.setLifecycleHooks(() => {
      thread.backend.unbind();
      this.clientTurns.settle(thread.threadId);
      thread.resetLiveState();
      void this.turnObservers.reset(thread.threadId).catch((error) => this.log("turn-observer.reset.failed", this.errorMessage(error)));
    }, async () => {
      await this.bindThread(thread);
      if (this.active === thread) await this.publishActiveCatalog();
    });
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
      this.extensionCount = thread.backend.extensionCount();
      await this.rememberProject(this.cwd);
      if (!this.isCurrentActivation(activationEpoch)) {
        await restore?.rollback();
        activationCommitted = true;
        return false;
      }
      await this.refreshThreadShell(thread, touch);
      if (!this.isCurrentActivation(activationEpoch)) {
        await restore?.rollback();
        activationCommitted = true;
        return false;
      }
      this.log("session.opened", thread.threadId.slice(0, 8));
      this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd: thread.cwd } });
      this.scheduleRuntimePrewarm();
      if (this.defaultBackendKind === "pi") this.scheduleSpareThread(thread.cwd);
      await restore?.commit();
      activationCommitted = true;
      return true;
    } catch (error) {
      if (restore && !activationCommitted) {
        try {
          await restore.rollback();
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], "Thread activation failed and workspace recovery needs attention.");
        }
      }
      throw error;
    }
  }

  private async publishActiveCatalog(): Promise<void> {
    const snapshot = await this.snapshot();
    this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) });
  }

  private async disposeThread(thread: ThreadRuntime): Promise<void> {
    this.clientTurns.settle(thread.threadId);
    this.extensionUi.cancelFor(thread.threadId);
    this.presentUi("clear", thread.threadId);
    thread.adapterAbortGeneration ??= 0;
    thread.adapterAbortGeneration += 1;
    thread.unsubscribe?.();
    thread.unsubscribe = undefined;
    try {
      for (const controller of thread.adapterAbortControllers ?? []) controller.abort();
      if (thread.backend.isStreaming() || !thread.backend.isIdle()) {
        await Promise.race([
          thread.backend.abort(),
          new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_ABORT_MS).unref?.()),
        ]);
      }
    } catch (error) {
      this.log("runtime.adapter.abort-failed", this.errorMessage(error));
    }
    thread.backend.unbind();
    for (const id of thread.tools.keys()) this.toolOwners.delete(id);
    // Stop Pi before observers close: closing first would drop work in
    // flight while the provider could still mutate the checkout.
    const errors = thread.runtime ? await this.abortRuntime(thread.runtime) : [];
    try {
      await this.turnObservers.closed(thread.threadId);
    } catch (error) {
      errors.push(error);
    }
    if (thread.runtime) errors.push(...await this.disposeRuntime(thread.runtime));
    else {
      try { await thread.backend.dispose(); } catch (error) { errors.push(error); }
    }
    thread.cancelEventBarrier();
    if (errors.length > 0) throw new AggregateError(errors, "Pi runtime shutdown failed");
  }

  private async teardownRuntime(runtime: AgentSessionRuntime): Promise<unknown[]> {
    const errors = await this.abortRuntime(runtime);
    errors.push(...await this.disposeRuntime(runtime));
    return errors;
  }

  private async abortRuntime(runtime: AgentSessionRuntime): Promise<unknown[]> {
    const errors: unknown[] = [];
    try {
      // A run that will not stop must not block shutdown forever.
      await Promise.race([
        runtime.session.abort(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_ABORT_MS).unref?.()),
      ]);
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }

  private async disposeRuntime(runtime: AgentSessionRuntime): Promise<unknown[]> {
    const errors: unknown[] = [];
    let disposed = false;
    try {
      await runtime.dispose();
      disposed = true;
    } catch (error) {
      errors.push(error);
    }
    if (!disposed) {
      try {
        runtime.session.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private scheduleSpareThread(cwd: string, force = false): void {
    if ((!this.automaticPrewarm && !force) || this.safeMode || this.spare?.cwd === cwd) return;
    void this.discardSpare().catch((error) => this.fail(error));
    const startedAt = performance.now();
    const cancellation = new AbortController();
    const pending = this.openThread(
      SessionManager.create(cwd),
      { type: "session_start", reason: "new", previousSessionFile: undefined },
      { background: true, adopt: false, prepared: true, abortSignal: cancellation.signal },
    ).then((thread) => {
      this.log("runtime.spare.ready", basename(cwd));
      return thread;
    }).catch((error) => {
      this.log("runtime.spare.failed", this.errorMessage(error));
      return undefined;
    }).finally(() => this.recordBackgroundLifecycle("spare", startedAt));
    this.spare = { cwd, pending, cancel: () => cancellation.abort() };
  }

  private async takePreparedThread(cwd: string): Promise<ThreadRuntime | undefined> {
    const spare = this.spare;
    if (!spare || spare.cwd !== cwd) return undefined;
    this.spare = undefined;
    const thread = await spare.pending;
    if (!thread) return undefined;
    return thread;
  }

  private retainPreparedThread(thread: ThreadRuntime): void {
    this.spare = { cwd: thread.cwd, pending: Promise.resolve(thread), cancel: () => {
      this.extensionUi.cancelFor(thread.sessionId);
      void thread.backend.abort().catch((error) => this.log("runtime.prepared.abort", this.errorMessage(error)));
    } };
  }

  private async discardSpare(): Promise<void> {
    const spare = this.spare;
    this.spare = undefined;
    if (!spare) return;
    spare.cancel();
    const thread = await spare.pending;
    if (thread) await this.disposeThread(thread);
  }

  private projectNameFor(cwd: string): string {
    return this.knownProjectNames.get(cwd) ?? (basename(cwd) || cwd);
  }

  private async loadProjectName(cwd: string): Promise<string> {
    const known = this.knownProjectNames.get(cwd);
    if (known) return known;
    const name = await this.projectFacts.name(cwd).catch(() => undefined) ?? (basename(cwd) || cwd);
    this.knownProjectNames.set(cwd, name);
    return name;
  }

  private async rememberProject(cwd: string): Promise<void> {
    await this.projectHistory.remember(cwd, await this.loadProjectName(cwd));
  }

  /**
   * The label a project carries, as last seen. A refresh always runs in the
   * background and publishes when the answer changes, so opening or switching a
   * thread never waits on the provider — a busy repository used to hold
   * switches for seconds behind its own status scan.
   */
  private labelFor(cwd: string): string | undefined {
    this.refreshLabelInBackground(cwd);
    return this.knownLabels.get(cwd);
  }

  private refreshLabelInBackground(cwd: string): void {
    if (this.labelRefreshes.has(cwd)) return;
    const startedAt = performance.now();
    const pending = this.projectFacts.label(cwd).then((label) => {
      const known = this.knownLabels.has(cwd);
      const previous = this.knownLabels.get(cwd);
      this.knownLabels.set(cwd, label);
      if (!known || previous !== label) this.publishLabel(cwd, label);
    }).catch((error) => this.log("project-label.failed", `${basename(cwd)}: ${this.errorMessage(error)}`)).finally(() => {
      this.recordBackgroundLifecycle("project-label", startedAt);
      this.labelRefreshes.delete(cwd);
    });
    this.labelRefreshes.set(cwd, pending);
  }

  private publishLabel(cwd: string, label: string | undefined): void {
    if (cwd === this.cwd) {
      this.projectLabel = label;
      this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd, label } });
    }
    const changed = this.sessions.filter((session) => session.projectPath === cwd && session.projectLabel !== label);
    if (changed.length === 0) return;
    this.sessions = this.sessions.map((session) => session.projectPath === cwd ? { ...session, projectLabel: label } : session);
    for (const session of this.sessions) {
      if (session.projectPath === cwd) this.publishThreadShellSoon(session);
    }
  }

  private recordBackgroundLifecycle(name: string, startedAt: number): void {
    this.backgroundLifecycle.push({ name, durationMs: Math.round((performance.now() - startedAt) * 10) / 10 });
    if (this.backgroundLifecycle.length > 100) this.backgroundLifecycle.shift();
  }

  private scheduleRuntimePrewarm(): void {
    if (!this.automaticPrewarm || this.safeMode || this.prewarmTimer) return;
    this.prewarmTimer = setTimeout(() => {
      this.prewarmTimer = undefined;
      if (this.attached.isAttached) return;
      const live = this.liveThreadIds();
      const candidates = this.sessions
        .filter((session) => session.projectPath === this.cwd && !live.has(session.id) && !this.openingThreads.has(session.path))
        .slice(0, Math.max(0, MAX_LIVE_THREADS - 2 - live.size));
      for (const session of candidates) void this.prewarmSession(session.path);
    }, 1_000);
    this.prewarmTimer.unref?.();
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.then(() => undefined, () => undefined);
    return result;
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
    if (this.attached.snapshot) return this.attached.snapshot.models.map(mapModel);
    if (this.active && this.active.backend.kind !== "pi") return [];
    const key = this.resourceFingerprint(this.cwd);
    const cached = this.modelCatalogCache.get(key);
    if (cached) return cached;
    const active = this.active;
    if (!active) return [];
    const models = (await active.backend.catalog()).models;
    this.modelCatalogCache.set(key, models);
    return models;
  }

  private resourceFingerprint(cwd: string, settingsManager?: SettingsManager): string {
    return runtimeResourceFingerprint({
      cwd,
      settings: settingsManager
        ? { global: settingsManager.getGlobalSettings(), project: settingsManager.getProjectSettings(), safeMode: this.safeMode }
        : { safeMode: this.safeMode },
      extensions: { enabled: !this.safeMode, hostExtensions: this.runtimeExtensionContributions.map((entry) => entry.name) },
      providerState: { agentDir: this.agentDir },
    });
  }

  private async externalSessionShells(): Promise<UiSession[]> {
    if (this.safeMode) return [];
    const shells: UiSession[] = [];
    for (const provider of this.backends.values()) {
      let records: Awaited<ReturnType<HostRuntimeBackendProvider["listThreads"]>>;
      try { records = await provider.listThreads(); } catch (error) {
        this.log("runtime-backend.list.failed", `${provider.kind}: ${this.errorMessage(error)}`);
        continue;
      }
      for (const record of records) {
        const firstUser = record.messages.find((message) => message.role === "user");
        shells.push({
          id: record.threadId,
          path: externalThreadPath(provider.kind, record.threadId),
          title: cleanThreadTitle(safeSessionTitle(record.title) || firstSentence(visibleTitleText(firstUser?.text ?? ""))),
          modifiedAt: record.updatedAt,
          projectPath: record.cwd,
          projectName: this.projectNameFor(record.cwd),
          projectLabel: this.labelFor(record.cwd),
          messageCount: record.messages.length,
          backendKind: provider.kind,
        });
      }
    }
    return shells;
  }

  private async refreshThreadIndex(publish: boolean): Promise<ThreadIndexSnapshot> {
    if (!this.threadIndexRefresh) {
      const scanStartedAt = Date.now();
      this.threadIndexRefresh = (async () => {
        const sessionInfos = await SessionManager.listAll();
        const scanned = await mapSessions(
          sessionInfos,
          this.cwd,
          async (cwd) => this.labelFor(cwd),
          (cwd) => this.projectNameFor(cwd),
        );
        const previous = this.sessions;
        const external = await this.externalSessionShells();
        const byId = new Map(scanned.map((session) => [session.id, session] as const));
        for (const session of external) if (!byId.has(session.id)) byId.set(session.id, session);
        this.sessions = mergeSessionIndexScan([...byId.values()], this.sessions, scanStartedAt, this.liveThreadIds());
        await this.sweepSessions(sessionInfos, previous, this.sessions);
        return this.threadIndexSnapshot();
      })().finally(() => {
        this.threadIndexRefresh = undefined;
      });
    }
    const threadIndex = await this.threadIndexRefresh;
    if (publish) this.emit({ type: "thread-index", threadIndex });
    return threadIndex;
  }

  private startIndexRecovery(): void {
    if (this.indexRecoveryTimer) return;
    this.indexRecoveryTimer = setInterval(() => {
      void this.recoverThreadIndex().catch((error) => this.fail(error));
    }, 30_000);
    this.indexRecoveryTimer.unref?.();
  }

  private async recoverThreadIndex(): Promise<void> {
    const previous = this.sessions;
    const scanStartedAt = Date.now();
    const sessionInfos = await SessionManager.listAll();
    const scanned = await mapSessions(
      sessionInfos,
      this.cwd,
      async (cwd) => this.labelFor(cwd),
      (cwd) => this.projectNameFor(cwd),
    );
    const external = await this.externalSessionShells();
    const byId = new Map(scanned.map((session) => [session.id, session] as const));
    for (const session of external) if (!byId.has(session.id)) byId.set(session.id, session);
    const next = mergeSessionIndexScan([...byId.values()], this.sessions, scanStartedAt, this.liveThreadIds());
    this.sessions = next;
    await this.sweepSessions(sessionInfos, previous, next);
    for (const update of sessionIndexUpdates(previous, next)) this.emitUpdate(update);
  }

  /** Extensions reconcile what they keep beside sessions; a missing file is deletion, eviction is not. */
  private async sweepSessions(sessionInfos: readonly SessionInfo[], previous: readonly UiSession[], next: readonly UiSession[]): Promise<void> {
    const nextIds = new Set(next.map((session) => session.id));
    const liveIds = this.liveThreadIds();
    const deleted = previous
      .filter((session) => !nextIds.has(session.id) && !liveIds.has(session.id) && !existsSync(session.path))
      .map((session) => ({ sessionId: session.id, cwd: session.projectPath }));
    await this.threadLifecycle.sweep({
      sessions: sessionInfos.map((info) => ({ sessionId: info.id, path: info.path, cwd: info.cwd })),
      liveThreads: this.threads.list().map((record) => this.hostThreadFor(record.runtime)),
      projectPaths: this.projectHistory.list().map((project) => project.path),
      deleted,
    });
  }

  /** Prompt completion updates one shell; the global scan is a startup/recovery path. */
  private async refreshActiveThreadIndex(touch = true): Promise<void> {
    const thread = this.active;
    if (!thread) return;
    await this.refreshThreadShell(thread, touch);
  }

  private sessionShellPath(thread: ThreadRuntime): string {
    const kind = threadBackendKind(thread);
    return kind !== "pi" ? externalThreadPath(kind, thread.threadId) : thread.sessionFile ?? thread.threadId;
  }

  private async refreshThreadShell(thread: ThreadRuntime, touch: boolean): Promise<void> {
    const projectPath = thread.cwd;
    const existing = this.sessions.find((entry) => entry.id === thread.threadId);
    const visibleMessages = await thread.backend.transcript();
    const shell = reconcileActiveThreadShell({
      id: thread.threadId,
      path: this.sessionShellPath(thread),
      explicitTitle: safeSessionTitle(thread.backend.sessionName()) || safeSessionTitle(thread.adapterTitle),
      derivedTitle: firstSentence(visibleTitleText(visibleMessages.find((message) => message.role === "user")?.text ?? "")),
      now: Date.now(),
      projectPath,
      projectName: this.projectNameFor(projectPath),
      projectLabel: this.labelFor(projectPath),
      messageCount: visibleMessages.length,
      backendKind: threadBackendKind(thread),
    }, existing, touch);
    this.sessions = [shell, ...this.sessions.filter((item) => item.id !== shell.id)];
    this.publishThreadShellSoon(shell);
  }

  private retitleShell(sessionId: string, title: string): void {
    const shell = this.sessions.find((entry) => entry.id === sessionId);
    if (!shell || shell.title === title) return;
    const titled = { ...shell, title };
    this.sessions = this.sessions.map((entry) => entry.id === sessionId ? titled : entry);
    this.publishThreadShellSoon(titled);
  }

  private publishThreadShellSoon(shell: UiSession): void {
    this.pendingShellUpdates.set(shell.id, shell);
    this.publishSoon("shells", () => {
      const updates = [...this.pendingShellUpdates.values()];
      this.pendingShellUpdates.clear();
      for (const pending of updates) {
        this.emitUpdate({
          version: HOST_PROTOCOL_VERSION,
          type: "thread-shell",
          update: { sessionId: pending.id, shell: pending },
        });
      }
    });
  }

  /** Collapse repeated publications of one kind into a single later emit. */
  private publishSoon(kind: "shells" | "index", publish: () => void): void {
    if (this.coalescedPublishes.has(kind)) return;
    const timer = setTimeout(() => {
      this.coalescedPublishes.delete(kind);
      publish();
    }, 0);
    timer.unref?.();
    this.coalescedPublishes.set(kind, timer);
  }

  private threadIndexSnapshot(): ThreadIndexSnapshot {
    const projects = this.projectHistory.list();
    const knownPaths = new Set(projects.map((project) => project.path));
    for (const thread of this.sessions) {
      if (knownPaths.has(thread.projectPath) || this.projectHistory.isHidden(thread.projectPath)) continue;
      projects.push({
        path: thread.projectPath,
        name: thread.projectName,
        lastOpenedAt: thread.modifiedAt,
      });
      knownPaths.add(thread.projectPath);
    }
    projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    return { projects: projects.filter((project) => this.isProjectRoot(project.path)), sessions: this.sessions };
  }

  /**
   * A project nested in another (Workspace Kit: a linked worktree) is not a
   * root of its own; the workspace bar moves inside the parent instead. The
   * provider is never awaited here; an unclassified path is withheld until its
   * background answer arrives.
   */
  private isProjectRoot(cwd: string): boolean {
    const nested = this.knownNestedProjects.get(cwd);
    if (nested === undefined) {
      this.classifyNestedInBackground(cwd);
      return false;
    }
    return !nested;
  }

  private classifyNestedInBackground(cwd: string): void {
    if (this.nestedClassifications.has(cwd)) return;
    const startedAt = performance.now();
    const pending = this.projectFacts.nested(cwd).then((nested) => {
      if (this.knownNestedProjects.get(cwd) === nested) return;
      this.knownNestedProjects.set(cwd, nested);
      this.publishThreadIndexSoon();
    }).catch(() => {
      // A path no provider can classify is simply a root.
      if (this.knownNestedProjects.has(cwd)) return;
      this.knownNestedProjects.set(cwd, false);
      this.publishThreadIndexSoon();
    }).finally(() => {
      this.recordBackgroundLifecycle("project-classification", startedAt);
      this.nestedClassifications.delete(cwd);
    });
    this.nestedClassifications.set(cwd, pending);
  }

  private publishThreadIndexSoon(): void {
    this.publishSoon("index", () => this.emitUpdate({
      version: HOST_PROTOCOL_VERSION,
      type: "thread-index",
      index: this.threadIndexSnapshot(),
    }));
  }

  /** Commands of an external backend; a supplied catalog is re-spelled in the backend's dialect. */
  private externalComposerCommands(kind: ThreadBackendKind, cwd: string): UiComposerCommand[] {
    const provider = this.requireBackend(kind);
    if (this.runtimeCommands.length > 0) return composerCommandsForAdapter(this.runtimeCommands, provider.adapter);
    return provider.composerCommands(cwd);
  }

  private snapshotSync(models: UiModel[]): HostSnapshot {
    return this.projection.hostSnapshot(this.active, models, this.cwd, this.extensionCount);
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
    const message = this.errorMessage(error);
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
