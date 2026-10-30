import { performance } from "node:perf_hooks";
import type { UsageTally } from "./usage-pricing.js";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { ThreadBackendKind, UiMessage, UiSession, UiThreadUsage } from "../shared/contracts.js";
import type { ClientTurnLedger } from "./client-turn-ledger.js";
import type { ExtensionUiCoordinator } from "./extension-ui-coordinator.js";
import type {
  HostRuntimeBackendProvider,
  HostSessionFile,
  HostThreadLifecycleSet,
  HostTurnObserverSet,
  HostUiPresenter,
  RuntimeSessionInfo,
} from "./host-extensions.js";
import type { HostExecutionPolicy } from "./host-execution-policy.js";
import type { ThreadRuntimeEvent, ThreadRuntimeBackend } from "./runtime-types.js";
import type { HostLifecycleInstrumentation } from "./host-lifecycle.js";
import { mapMessage } from "./host-messages.js";
import { createPiModelRuntime } from "./pi-model-runtime.js";
import { beforeRuntimeDeadline, PhaseTimer, externalThreadFromPath, externalThreadPath, samePath } from "./pi-host-support.js";
import type { ProjectFactsCache } from "./project-facts-cache.js";
import { parentThreadIdFromEntries } from "./session-lineage.js";
import { cachedResourceOptions, captureResourceDiscovery, type ResourceDiscoverySnapshot } from "./resource-discovery-cache.js";
import { RuntimeResourceCache, runtimeResourceFingerprint } from "./runtime-resource-cache.js";
import type { AgentRuntimeAdapter, RuntimePermissionLevel } from "./runtime-adapters.js";
import type { ThreadBinding } from "./thread-binding.js";
import type { ThreadProjection } from "./thread-projection.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { PiThreadRuntimeBackend } from "./thread-runtime-backend.js";
import { UnavailableThreadBackend } from "./unavailable-thread-backend.js";
import { isSessionHeldElsewhere, type SessionLocks } from "./session-locks.js";
import { openRecentSession, readSessionFile } from "./session-read.js";
import { discoverPromptOverrides } from "./system-prompt-resolver.js";
import { defaultHostConfigManager } from "./host-config.js";
import { agentShellFor } from "./agent-scope.js";
import { withConfiguredSampling } from "./configured-sampling.js";
import { createDeferredToolsExtension } from "./deferred-tools.js";
import { ownedShellExtension } from "./owned-shell.js";
import { hidePiPackages } from "./pi-package-hiding.js";

type RuntimeStartEvent = Parameters<CreateAgentSessionRuntimeFactory>[0]["sessionStartEvent"];

/** A runtime extension bound to one session, with the shell lines it asked for there. */
export interface SessionRuntimeExtension {
  name: string;
  factory: ExtensionFactory;
  shellCommandPrefix?: string | undefined;
}

/** The extensions' lines first, then the user's own `shellCommandPrefix`; undefined when neither adds one. */
export function composeShellCommandPrefix(extensions: readonly SessionRuntimeExtension[], userPrefix: string | undefined): string | undefined {
  const lines = [...extensions.map((extension) => extension.shellCommandPrefix), userPrefix].filter((line): line is string => Boolean(line?.trim()));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Longest a shutdown waits for a run to stop before the runtime is dropped anyway. */
const SHUTDOWN_ABORT_MS = 3_000;

export interface ThreadRuntimeLifecyclePort {
  safeMode: boolean;
  canonicalPath?(path: string): string | undefined;
  decorateBackend?(backend: ThreadRuntimeBackend): ThreadRuntimeBackend;
  agentDir: string;
  cwd(): string;
  /** The session file of the thread on screen, as the previous one of the next open. */
  activeSessionFile(): string | undefined;
  adapterFor(kind: ThreadBackendKind): AgentRuntimeAdapter;
  requireBackend(kind: ThreadBackendKind): HostRuntimeBackendProvider;
  permissionLevel(sessionId?: string): RuntimePermissionLevel;
  sessionFile(manager: SessionManager): HostSessionFile;
  /** Runtime extensions host extensions contribute, filtered by the session's settings. */
  runtimeExtensions(settingsManager: SettingsManager, session: RuntimeSessionInfo): SessionRuntimeExtension[];
  runtimeExtensionNames(): string[];
  /** Which Pi package sources an extension replaces; Pi does not load those in a runtime Tau owns. */
  replacedPiPackages(): ((source: string) => boolean)[];
  /** The interaction modes runtime extensions give Pi threads. */
  runtimeModes(): readonly string[];
  threadLifecycle: HostThreadLifecycleSet;
  turnObservers: HostTurnObserverSet;
  clientTurns: ClientTurnLedger;
  extensionUi: ExtensionUiCoordinator;
  projection: ThreadProjection;
  projects: ProjectFactsCache;
  binding: ThreadBinding;
  lifecycleMetrics: HostLifecycleInstrumentation;
  adopt(thread: ThreadRuntime): Promise<void>;
  /** The runtime the registry holds for a thread id, if any. */
  currentRuntime(threadId: string): ThreadRuntime | undefined;
  liveThreads(): readonly ThreadRuntime[];
  indexedSession(path: string): UiSession | undefined;
  findSession(sessionId: string): Promise<UiSession | undefined>;
  presentUi<K extends keyof HostUiPresenter>(method: K, ...args: Parameters<NonNullable<HostUiPresenter[K]>>): boolean;
  releaseTool(toolCallId: string): void;
  /** A message an external backend produced, on its way to the transcript. */
  emitMessage(threadId: string, message: UiMessage): void;
  /** A streamed external backend's report about its turn. */
  emitRuntimeEvent(threadId: string, event: ThreadRuntimeEvent): void;
  logRuntimePhase(phase: string, startedAt: number, reason: string, cwd: string): void;
  log(label: string, detail?: string): void;
  /** A thread's tallies priced as the host prices every thread. */
  priceUsage(tallies: readonly UsageTally[]): UiThreadUsage | undefined;
  /** What a folder's commands may reach. */
  executionPolicy(cwd: string): Promise<HostExecutionPolicy>;
  errorMessage(error: unknown): string;
  /** Why a thread's runtime could not start, or undefined once it did. */
  runtimeUnavailable(threadId: string, reason: string | undefined): void;
  /** No runtime opens a Pi session another host on this machine writes. */
  sessionLocks: SessionLocks;
}

/**
 * A thread's runtime from build to teardown: the Pi session runtime behind it,
 * the backend of another provider, the one-runtime-per-session-file rule, and
 * the ordered shutdown a runtime needs so nothing is dropped in flight.
 */
export class ThreadRuntimeLifecycle {
  /** Runtimes being opened, keyed by session file, so a prewarm and a switch share one. */
  private readonly opening = new Map<string, Promise<ThreadRuntime>>();
  /** Session managers whose runtime is being built in the background, outside any measurement. */
  private readonly backgroundManagers = new WeakSet<SessionManager>();
  private readonly resourceCache = new RuntimeResourceCache<ResourceDiscoverySnapshot>({ maxEntries: 4, ttlMs: 5 * 60_000 });
  /** The session file each Pi runtime holds the lock of, released with the runtime. */
  private readonly lockedFiles = new WeakMap<ThreadRuntime, string>();

  private readonly discarded = new WeakSet<ThreadRuntime>();

  constructor(private readonly port: ThreadRuntimeLifecyclePort) {}

  /** A timed-out run must lose its event routes before its replacement opens. */
  discard(thread: ThreadRuntime): void {
    this.discarded.add(thread);
    thread.backend.capabilities.extensions?.setLifecycleHooks(() => undefined, async () => undefined);
    thread.runtime?.session.dispose();
    thread.unsubscribe?.();
    thread.unsubscribe = undefined;
    const lockedFile = this.lockedFiles.get(thread);
    if (lockedFile) {
      this.lockedFiles.delete(thread);
      this.port.sessionLocks.release(lockedFile);
    }
  }

  /** What a runtime's resources depend on; a changed answer is a new catalog. */
  fingerprint(cwd: string, settingsManager?: SettingsManager): string {
    const promptOverrides = discoverPromptOverrides(cwd, this.port.agentDir);
    return runtimeResourceFingerprint({
      cwd,
      settings: settingsManager
        ? { global: settingsManager.getGlobalSettings(), project: settingsManager.getProjectSettings(), safeMode: this.port.safeMode }
        : { safeMode: this.port.safeMode },
      extensions: { enabled: !this.port.safeMode, hostExtensions: this.port.runtimeExtensionNames() },
      providerState: {
        agentDir: this.port.agentDir,
        promptCustom: promptOverrides.customPrompt?.path,
        promptAppends: promptOverrides.appendPrompts.map((p) => p.path),
        contextFiles: promptOverrides.contextFiles.map((c) => c.path),
      },
    });
  }

  invalidateResources(): void {
    this.resourceCache.invalidate();
  }

  isOpening(path: string): boolean {
    return this.opening.has(path);
  }

  /** Builds one Pi session runtime, measuring each phase of it exactly once. */
  private readonly create: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const reason = sessionStartEvent?.reason ?? "initial";
    const scenario = reason === "initial" ? "bootstrap" : reason === "resume" ? "cold-switch" : "warm-switch";
    const ownsMeasurement = !this.port.lifecycleMetrics.isActive() && !this.backgroundManagers.has(sessionManager);
    if (ownsMeasurement) this.port.lifecycleMetrics.begin(this.port.safeMode ? "safe" : "full", scenario);
    const totalStartedAt = performance.now();

    const settingsStartedAt = performance.now();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    if (!this.port.safeMode) hidePiPackages(settingsManager, this.port.replacedPiPackages());
    const parentThreadId = parentThreadIdFromEntries(sessionManager.getEntries());
    const extensions = this.port.runtimeExtensions(settingsManager, { sessionId: sessionManager.getSessionId(), cwd, ...(parentThreadId ? { parentThreadId } : {}) });
    if (extensions.some((extension) => extension.shellCommandPrefix)) {
      // Not `applyOverrides`: Pi rebuilds its settings from the files on every reload.
      const userPrefix = settingsManager.getShellCommandPrefix.bind(settingsManager);
      settingsManager.getShellCommandPrefix = () => composeShellCommandPrefix(extensions, userPrefix());
    }
    // On Linux with a user manager each bash call starts in its own systemd scope; a shell the user chose stays.
    const agentShell = settingsManager.getShellPath() ? undefined : agentShellFor(undefined);
    if (agentShell) settingsManager.getShellPath = () => agentShell;
    this.port.logRuntimePhase("settings", settingsStartedAt, reason, cwd);

    const modelsStartedAt = performance.now();
    const modelRuntime = await createPiModelRuntime(agentDir);
    this.port.logRuntimePhase("models", modelsStartedAt, reason, cwd);

    const resourcesStartedAt = performance.now();
    const resourceKey = this.fingerprint(cwd, settingsManager);
    const cachedResources = this.resourceCache.get(resourceKey);
    const promptOverrides = discoverPromptOverrides(cwd, agentDir);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        ...(cachedResources ? cachedResourceOptions(cachedResources) : {}),
        noExtensions: this.port.safeMode,
        // Host extensions add theirs through the services facade; none in safe mode.
        // First, so extensions that narrow the active tools see tool_search and can drop it.
        extensionFactories: [
          { name: "tau-shell-ownership", factory: ownedShellExtension(cwd, settingsManager) },
          ...(this.port.safeMode ? [] : [{ name: "tau-tool-search", factory: createDeferredToolsExtension() }]),
          ...extensions.map((extension) => ({ name: extension.name, factory: extension.factory })),
        ],
        ...(cachedResources ? {} : {
          systemPromptOverride: (base) => promptOverrides.customPrompt?.content ?? base,
          appendSystemPromptOverride: (base) => [
            ...base,
            ...promptOverrides.appendPrompts.map((p) => p.content),
          ],
          agentsFilesOverride: (base) => {
            const existingPaths = new Set(base.agentsFiles.map((file) => file.path));
            const additions = promptOverrides.contextFiles.filter((file) => !existingPaths.has(file.path));
            return { agentsFiles: [...base.agentsFiles, ...additions] };
          },
        }),
      },
    });
    if (!cachedResources) this.resourceCache.set(resourceKey, captureResourceDiscovery(services.resourceLoader));
    this.port.logRuntimePhase(cachedResources ? "resources-cache-hit" : "resources", resourcesStartedAt, reason, cwd);

    const sessionStartedAt = performance.now();
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
    // Pi's settings know neither key; its providers read them from the stream options.
    const agent = created.session.agent;
    agent.streamFunction = withConfiguredSampling(agent.streamFunction, () => defaultHostConfigManager.read(cwd));
    this.port.logRuntimePhase("session", sessionStartedAt, reason, cwd);
    this.port.logRuntimePhase("total", totalStartedAt, reason, cwd);
    if (ownsMeasurement) this.port.lifecycleMetrics.end();

    return { ...created, services, diagnostics: services.diagnostics };
  };

  /** Opens a thread of a registered backend; no Pi session is allocated for it. */
  async openExternal(
    kind: ThreadBackendKind,
    threadId: string,
    cwd: string,
    options: { background?: boolean; adopt?: boolean; resume?: boolean; tools?: readonly string[] } = {},
  ): Promise<ThreadRuntime> {
    if (this.port.safeMode) throw new Error("Only the Pi runtime is available in Tau safe mode.");
    const provider = this.port.requireBackend(kind);
    let owned: ThreadRuntime | undefined;
    let opening = true;
    const pendingEvents: ThreadRuntimeEvent[] = [];
    const backend = await provider.open(threadId, cwd, { resume: options.resume !== false, ...(options.tools ? { tools: options.tools } : {}) }, {
      projectName: this.port.projects.name(cwd),
      projectLabel: this.port.projects.knownLabel(cwd),
      permissionLevel: () => this.port.permissionLevel(threadId),
      onMessage: (message) => {
        const thread = this.port.currentRuntime(threadId);
        if (thread && (!owned || thread === owned && !this.discarded.has(owned))) {
          thread.adapterMessages = [...thread.adapterMessages, message];
          this.port.emitMessage(threadId, message);
        }
      },
      onEvent: (event) => {
        if (owned && (this.discarded.has(owned) || this.port.currentRuntime(threadId) && this.port.currentRuntime(threadId) !== owned)) return;
        if (opening) pendingEvents.push(event);
        else this.port.emitRuntimeEvent(threadId, event);
      },
      priceUsage: (tallies) => this.port.priceUsage(tallies),
      executionPolicy: () => this.port.executionPolicy(cwd),
      cancelPrompts: () => {
        if (!owned || !this.discarded.has(owned)) this.port.extensionUi.cancelFor(threadId);
      },
      ask: (prompt) => this.port.extensionUi.ask(
        { ...prompt, id: `backend-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, sessionId: threadId },
        this.port.currentRuntime(threadId),
      ),
    });
    const thread = new ThreadRuntime(this.port.decorateBackend?.(backend) ?? backend);
    owned = thread;
    thread.adapterMessages = await thread.backend.transcript();
    thread.adapterActivity = await thread.backend.capabilities.activityHistory?.load().catch((error: unknown) => {
      this.port.log("activity.load.failed", this.port.errorMessage(error));
      return [];
    }) ?? [];
    const state = thread.backend.state();
    thread.adapterTitle = state.title;
    thread.adapterTitleSource = state.titleSource;
    if (options.adopt !== false) {
      await this.port.adopt(thread);
      // Resuming can join a turn whose start predates this host's subscription.
      if (state.streaming && !pendingEvents.some((event) => event.type === "turn-started")) this.port.emitRuntimeEvent(threadId, { type: "turn-started" });
    }
    opening = false;
    for (const event of pendingEvents) this.port.emitRuntimeEvent(threadId, event);
    return thread;
  }

  /**
   * Builds a runtime for one session, binds Tau's UI to it, and hands it to the
   * registry. The thread is live afterwards but not yet on screen. Throws
   * `SessionHeldElsewhereError` before anything touches a session another host writes.
   */
  async open(
    manager: SessionManager,
    sessionStartEvent: RuntimeStartEvent | undefined,
    options: { background?: boolean; adopt?: boolean; prepared?: boolean; abortSignal?: AbortSignal } = {},
  ): Promise<ThreadRuntime> {
    const sessionFile = manager.getSessionFile();
    if (sessionFile) await this.port.sessionLocks.acquire(sessionFile);
    try {
      const thread = await this.build(manager, sessionStartEvent, options);
      if (sessionFile) this.lockedFiles.set(thread, sessionFile);
      return thread;
    } catch (error) {
      if (sessionFile) this.port.sessionLocks.release(sessionFile);
      throw error;
    }
  }

  private async build(
    manager: SessionManager,
    sessionStartEvent: RuntimeStartEvent | undefined,
    options: { background?: boolean; adopt?: boolean; prepared?: boolean; abortSignal?: AbortSignal },
  ): Promise<ThreadRuntime> {
    const cwd = manager.getCwd() || this.port.cwd();
    const marks = new PhaseTimer();
    // Extensions repair what they keep beside a session before its runtime can
    // start a turn. A session this call is creating has nothing beside it yet,
    // and asking anyway cost every new thread the checkpoint kit's two-second
    // lease timeout, since the turn that spawned it holds that lease.
    const created = sessionStartEvent?.reason === "new";
    if (manager.getSessionFile() && !created) await this.port.threadLifecycle.beforeOpen(this.port.sessionFile(manager));
    marks.mark("before-open");
    if (options.background) this.backgroundManagers.add(manager);
    let runtime: AgentSessionRuntime | undefined;
    let thread: ThreadRuntime | undefined;
    try {
      const createdRuntime = await createAgentSessionRuntime(this.create, {
        cwd,
        agentDir: this.port.agentDir,
        sessionManager: manager,
        sessionStartEvent,
      });
      runtime = createdRuntime;
      const backend = new PiThreadRuntimeBackend(createdRuntime, this.port.adapterFor("pi"), {
        mapMessages: (messages) => {
          const mapping = this.port.projection.mapping(thread!);
          return messages
            .map((message, index) => mapMessage(message, index, mapping))
            .filter((message): message is UiMessage => Boolean(message?.text || message?.skill));
        },
        modes: () => this.port.runtimeModes(),
        priceUsage: (tallies) => this.port.priceUsage(tallies),
      });
      marks.mark("create-runtime");
      thread = new ThreadRuntime(this.port.decorateBackend?.(backend) ?? backend, createdRuntime);
      const preparedThread = thread;
      if (options.prepared ?? options.adopt === false) thread.beginEventBarrier();
      const cancelPrepared = () => {
        this.port.extensionUi.cancelFor(preparedThread.threadId);
        void preparedThread.backend.abort().catch((error) => this.port.log("runtime.prepared.abort", this.port.errorMessage(error)));
      };
      if (options.abortSignal) {
        options.abortSignal.addEventListener("abort", cancelPrepared, { once: true });
        if (options.abortSignal.aborted) cancelPrepared();
      }
      await backend.start(sessionStartEvent?.reason === "resume" ? "resume" : "create");
      marks.mark("backend-start");
      // An interactive open shows the thread while it binds; a prewarmed or
      // spare runtime is off every critical path and is handed over bound.
      if (options.background) await this.port.binding.bind(thread);
      else void this.port.binding.bind(thread, true);
      if (options.abortSignal?.aborted) throw new Error("Prepared runtime creation was cancelled.");
      this.port.binding.installHooks(thread);
      if (options.adopt !== false) await this.port.adopt(thread);
      marks.mark("hooks");
      this.port.log("thread.open.timing", `${thread.threadId.slice(0, 8)} · ${marks.report()}`);
      return thread;
    } catch (error) {
      // A prepared runtime may have created extension questions while binding.
      // Keep its barrier active until every callback and teardown side effect
      // has completed, then discard all buffered output.
      if (thread) this.port.extensionUi.cancelFor(thread.sessionId);
      if (runtime) {
        const cleanupErrors = await this.teardown(runtime);
        thread?.cancelEventBarrier();
        if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "Pi runtime initialization failed", { cause: error });
      } else thread?.cancelEventBarrier();
      throw error;
    } finally {
      this.backgroundManagers.delete(manager);
    }
  }

  /** The newest session of `cwd`, opened while this host holds it; throws `SessionHeldElsewhereError` when another process does. */
  openRecent(cwd: string, sessionsDir: string | undefined): Promise<SessionManager> {
    return openRecentSession(this.port.sessionLocks, cwd, sessionsDir);
  }

  /** One runtime per session file: concurrent opens for the same path share it. */
  openForPath(
    path: string,
    reason: "resume",
    background = false,
    backendKind?: ThreadBackendKind,
  ): Promise<ThreadRuntime> {
    const canonical = this.port.canonicalPath?.(path);
    if (canonical && canonical !== path) return this.openForPath(canonical, reason, background);
    const live = this.liveForPath(path);
    if (live) return Promise.resolve(live);
    let pending = this.opening.get(path);
    if (!pending) {
      pending = (async () => {
        const external = externalThreadFromPath(path);
        const indexedSession = this.port.indexedSession(path);
        const persistedKind = indexedSession?.backendKind ?? external?.kind;
        if (backendKind && persistedKind && backendKind !== persistedKind) {
          throw new Error(
            `Thread belongs to backend ${persistedKind}, refusing to open it as ${backendKind} (ADR 0005).`,
          );
        }
        const owner = backendKind ?? persistedKind ?? "pi";
        if (owner !== "pi") {
          if (this.port.safeMode) throw new Error("Only the Pi runtime is available in Tau safe mode.");
          const threadId = external?.threadId ?? indexedSession?.id;
          if (!threadId) throw new Error("The thread has no durable Tau thread id.");
          const provider = this.port.requireBackend(owner);
          const record = await provider.lookup(threadId);
          if (!record) throw new Error("The selected thread is no longer available in its runtime.");
          try {
            const thread = await this.openExternal(owner, record.threadId, record.cwd, { background });
            this.port.runtimeUnavailable(record.threadId, undefined);
            return thread;
          } catch (error) {
            if (background) throw error;
            // The thread still opens, read-only, so its history is not hidden behind a missing CLI.
            const why = this.port.errorMessage(error);
            this.port.log("runtime.unavailable", `${owner} ${record.threadId.slice(0, 8)}: ${why}`);
            const thread = new ThreadRuntime(new UnavailableThreadBackend(owner, provider.adapter, record, why));
            thread.adapterMessages = await thread.backend.transcript();
            thread.adapterTitle = record.title;
            this.port.runtimeUnavailable(record.threadId, why);
            await this.port.adopt(thread);
            return thread;
          }
        }
        if (external) throw new Error("The selected thread is owned by another runtime backend.");
        try {
          // Held across Pi's open, which may repair the file, until the runtime holds it too.
          await this.port.sessionLocks.acquire(path);
          try {
            const manager = SessionManager.open(path);
            const thread = await this.open(manager, { type: "session_start", reason, previousSessionFile: this.port.activeSessionFile() }, { background });
            this.port.runtimeUnavailable(thread.threadId, undefined);
            return thread;
          } finally {
            this.port.sessionLocks.release(path);
          }
        } catch (error) {
          if (background || !isSessionHeldElsewhere(error)) throw error;
          return this.openHeldElsewhere(path, readSessionFile(path), error.message);
        }
      })().finally(() => {
        if (this.opening.get(path) === pending) this.opening.delete(path);
      });
      this.opening.set(path, pending);
    }
    return pending;
  }

  /** A Pi thread another host writes opens read-only here, from its file, with the reason on the thread. */
  private async openHeldElsewhere(path: string, manager: SessionManager, why: string): Promise<ThreadRuntime> {
    const threadId = manager.getSessionId();
    this.port.log("runtime.held-elsewhere", `${threadId.slice(0, 8)}: ${why}`);
    const title = this.port.indexedSession(path)?.title;
    const record = { threadId, cwd: manager.getCwd() || this.port.cwd(), updatedAt: Date.now(), messages: [], ...(title ? { title } : {}) };
    const thread = new ThreadRuntime(new UnavailableThreadBackend("pi", this.port.adapterFor("pi"), record, why, { sessionFile: path, entries: manager.getBranch() }));
    thread.adapterTitle = title;
    this.port.runtimeUnavailable(threadId, why);
    await this.port.adopt(thread);
    return thread;
  }

  /** Resolves both virtual backend paths and Pi session files against the registry. */
  liveForPath(path: string | undefined): ThreadRuntime | undefined {
    if (!path) return undefined;
    const external = externalThreadFromPath(path);
    if (external) return this.port.currentRuntime(external.threadId);
    const indexed = this.port.indexedSession(path);
    if (indexed?.backendKind && indexed.backendKind !== "pi") return this.port.currentRuntime(indexed.id);
    return this.port.liveThreads().find((thread) => samePath(thread.sessionFile, path));
  }

  /** Reopens a durable thread off screen, sharing concurrent opens by its path. */
  async reopen(sessionId: string): Promise<ThreadRuntime> {
    const live = this.port.currentRuntime(sessionId);
    if (live) return live;
    const session = await this.port.findSession(sessionId);
    const thread = await this.openMarked({ sessionId, backend: session?.backendKind ?? "pi" }, session);
    if (!thread) throw new Error("That thread no longer exists.");
    return thread;
  }

  /** A restart marker carries its durable backend even if the index has not loaded it. */
  async openMarked(marker: { sessionId: string; backend: ThreadBackendKind }, session?: UiSession): Promise<ThreadRuntime | undefined> {
    const live = this.port.currentRuntime(marker.sessionId);
    if (live) return live;
    const path = marker.backend === "pi"
      ? (session ?? await this.port.findSession(marker.sessionId))?.path
      : externalThreadPath(marker.backend, marker.sessionId);
    return path ? this.openForPath(path, "resume", true, marker.backend) : undefined;
  }

  /** Waits for the opens in flight; shutdown may not leave a half-built runtime. */
  async settleOpening(): Promise<void> {
    const opening = [...this.opening.values()];
    this.opening.clear();
    await Promise.allSettled(opening);
  }

  /** Stops one thread's runtime in the order its collaborators need. */
  async dispose(thread: ThreadRuntime): Promise<void> {
    this.port.clientTurns.settle(thread.threadId);
    this.port.extensionUi.cancelFor(thread.threadId);
    this.port.presentUi("clear", thread.threadId);
    thread.adapterAbortGeneration += 1;
    thread.unsubscribe?.();
    thread.unsubscribe = undefined;
    thread.backend.capabilities.extensions?.setLifecycleHooks(() => undefined, async () => undefined);
    const discarded = this.discarded.has(thread);
    try {
      for (const controller of thread.adapterAbortControllers) controller.abort();
      const state = thread.state;
      if (!discarded && (state.streaming || !state.idle)) {
        await Promise.race([
          thread.backend.abort(),
          new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_ABORT_MS).unref?.()),
        ]);
      }
    } catch (error) {
      this.port.log("runtime.adapter.abort-failed", this.port.errorMessage(error));
    }
    thread.backend.capabilities.extensions?.unbind();
    for (const id of thread.tools.keys()) this.port.releaseTool(id);
    // A discarded Pi session is already disconnected; normal shutdown first drains it.
    const errors = !discarded && thread.runtime ? await this.abortRuntime(thread.runtime) : [];
    const closeObservers = async () => {
      try {
        if (!await beforeRuntimeDeadline(this.port.turnObservers.closed(thread.threadId), 10_000)) {
          errors.push(new Error("Runtime observers did not close within 10 s."));
        }
      } catch (error) { errors.push(error); }
    };
    const closeBackend = async () => {
      if (thread.runtime) errors.push(...await this.disposeRuntime(thread.runtime));
      else {
        try {
          if (!await beforeRuntimeDeadline(thread.backend.dispose(), 10_000)) {
            this.discard(thread);
            errors.push(new Error("Runtime disposal did not finish within 10 s."));
          }
        } catch (error) { errors.push(error); }
      }
    };
    if (discarded) {
      await beforeRuntimeDeadline(Promise.all([closeObservers(), closeBackend()]), 1_000);
    } else {
      await closeObservers();
      await closeBackend();
    }
    // After Pi's last write: another host may take the session from here on.
    const lockedFile = this.lockedFiles.get(thread);
    if (lockedFile) {
      this.lockedFiles.delete(thread);
      this.port.sessionLocks.release(lockedFile);
    }
    thread.cancelEventBarrier();
    if (errors.length > 0) throw new AggregateError(errors, "Pi runtime shutdown failed");
  }

  private async teardown(runtime: AgentSessionRuntime): Promise<unknown[]> {
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
      disposed = await beforeRuntimeDeadline(runtime.dispose(), 10_000);
      if (!disposed) errors.push(new Error("Runtime disposal did not finish within 10 s."));
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
}
