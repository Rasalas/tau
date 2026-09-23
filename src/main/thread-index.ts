import { existsSync } from "node:fs";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { HostEvent, ThreadIndexSnapshot, UiSession, UiThreadUsage } from "../shared/contracts.js";
import { HOST_PROTOCOL_VERSION, type HostUpdate } from "../shared/host-protocol.js";
import type { HostLogger } from "./host-log.js";
import {
  firstSentence,
  mapSessions,
  mergeSessionIndexScan,
  reconcileActiveThreadShell,
  safeSessionTitle,
  sessionIndexUpdates,
  threadUsageEqual,
  visibleTitleText,
} from "./host-messages.js";
import type { HostRuntimeBackendProvider, HostThread, HostThreadLifecycleSet } from "./host-extensions.js";
import { loadExternalSessionShells } from "./external-session-shells.js";
import { externalThreadPath } from "./pi-host-support.js";
import type { ProjectFactsCache } from "./project-facts-cache.js";
import type { ProjectHistory } from "./project-history.js";
import { PARENT_LINK_ENTRY, SessionLineageIndex, parentLinkEntry } from "./session-lineage.js";
import { SessionUsageIndex, hasThreadUsage, readSessionFileStamp } from "./session-usage.js";
import { ThreadRuntime, threadBackendKind } from "./thread-runtime.js";
import type { WorkspaceIdentity } from "./workspace-identity.js";

/** A thread nobody has spent anything on shows no cost at all, not a zero. */
function usageOrUndefined(usage: UiThreadUsage | undefined): UiThreadUsage | undefined {
  return hasThreadUsage(usage) ? usage : undefined;
}

export interface ThreadIndexPort {
  /** A thread in the trash is neither listed nor announced as deleted until it is purged. */
  inTrash?(sessionId: string): boolean;
  cwd(): string;
  safeMode: boolean;
  /** PI_CODING_AGENT_SESSION_DIR, or undefined for Pi's own sessions layout. */
  sessionsDir: string | undefined;
  projects: ProjectFactsCache;
  workspaces: WorkspaceIdentity;
  projectHistory: ProjectHistory;
  threadLifecycle: HostThreadLifecycleSet;
  backends(): ReadonlyMap<string, HostRuntimeBackendProvider>;
  /** Threads with a live runtime; their own totals supersede the cache. */
  liveThreads(): readonly ThreadRuntime[];
  hostThread(thread: ThreadRuntime): HostThread;
  emit(event: HostEvent): void;
  emitUpdate(update: HostUpdate): void;
  log(label: string, detail?: string): void;
  fail(error: unknown): void;
  errorMessage(error: unknown): string;
}

export interface ThreadIndexOptions {
  usageCachePath?: string;
  lineageCachePath?: string;
  logger?: HostLogger;
}

/**
 * The thread index: every persisted thread across projects, the shell each one
 * is drawn as, and the publication of both. It reads session files, never
 * runtimes; a thread that is live supersedes what the caches hold for it.
 */
export class ThreadIndex {
  private sessions: UiSession[] = [];
  /** What each thread has cost, cached by session file so a scan never reads one. */
  private readonly usage: SessionUsageIndex;
  private usageCacheLoaded?: Promise<void>;
  /** Who spawned each thread, read from the session files and cached by stamp. */
  private readonly lineage: SessionLineageIndex;
  private lineageCacheLoaded?: Promise<void>;
  /** The parent of a thread this host started or indexed, for its live shell. */
  private readonly parents = new Map<string, string>();
  /** Deletions already announced, so the sweep does not repeat one the host made itself. */
  private readonly announcedDeletions = new Set<string>();
  /** Threads a restart cut a turn short in; survives a rescan, which reads files only. */
  private readonly interrupted = new Set<string>();
  private scan?: Promise<{ previous: readonly UiSession[]; next: UiSession[] }>;
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private readonly pendingShellUpdates = new Map<string, UiSession>();
  /** Publications coalesced into the next tick, keyed by what they carry. */
  private readonly coalesced = new Map<"shells" | "index", ReturnType<typeof setTimeout>>();

  constructor(private readonly port: ThreadIndexPort, options: ThreadIndexOptions = {}) {
    this.usage = new SessionUsageIndex({
      ...(options.usageCachePath ? { path: options.usageCachePath } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
      onResolved: (sessionPath, usage) => this.applyScannedUsage(sessionPath, usage),
    });
    this.lineage = new SessionLineageIndex({
      ...(options.lineageCachePath ? { path: options.lineageCachePath } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }

  list(): readonly UiSession[] {
    return this.sessions;
  }

  byId(sessionId: string): UiSession | undefined {
    return this.sessions.find((session) => session.id === sessionId);
  }

  byPath(path: string): UiSession | undefined {
    return this.sessions.find((session) => session.path === path);
  }

  /** The thread that spawned this one, from the index or from the start that made it. */
  parentOf(threadId: string): string | undefined {
    return this.parents.get(threadId) ?? this.byId(threadId)?.parentThreadId;
  }

  /**
   * Records a thread's parent before its first prompt, as the entry right after
   * the header, so the index reads it without opening the thread.
   */
  linkParent(manager: SessionManager, parent: { threadId: string; details?: Record<string, unknown> }): void {
    manager.appendCustomEntry(PARENT_LINK_ENTRY, parentLinkEntry(parent.threadId, parent.details));
    this.parents.set(manager.getSessionId(), parent.threadId);
  }

  /** The same link for a thread without a Pi session file; it lasts as long as the index does. */
  rememberParent(threadId: string, parentThreadId: string): void {
    this.parents.set(threadId, parentThreadId);
  }

  /**
   * One deduplicated pass over every persisted session. Concurrent callers
   * share it, so the recovery timer can never run a second sweep into the
   * lifecycle hooks while one is still in flight.
   */
  async refresh(publish: "none" | "index" | "changes"): Promise<ThreadIndexSnapshot> {
    this.scan ??= this.scanSessions().finally(() => { this.scan = undefined; });
    const { previous, next } = await this.scan;
    if (publish === "index") this.port.emit({ type: "thread-index", threadIndex: this.snapshot() });
    else if (publish === "changes") for (const update of sessionIndexUpdates(previous, next)) this.port.emitUpdate(update);
    return this.snapshot();
  }

  startRecovery(): void {
    if (this.recoveryTimer) return;
    this.recoveryTimer = setInterval(() => {
      void this.refresh("changes").catch((error) => this.port.fail(error));
    }, 30_000);
    this.recoveryTimer.unref?.();
  }

  private async scanSessions(): Promise<{ previous: readonly UiSession[]; next: UiSession[] }> {
    const scanStartedAt = Date.now();
    this.usageCacheLoaded ??= this.usage.load().catch(() => undefined);
    this.lineageCacheLoaded ??= this.lineage.load().catch(() => undefined);
    const [sessionInfos] = await Promise.all([SessionManager.listAll(this.port.sessionsDir), this.usageCacheLoaded, this.lineageCacheLoaded]);
    // Stamps are a stat per file; reading the files themselves is what the
    // usage index defers, so the scan stays a listing.
    const stamps = new Map(await Promise.all(sessionInfos.map(async (info) =>
      [info.path, await readSessionFileStamp(info.path)] as const)));
    this.usage.retain(sessionInfos.map((info) => info.path));
    // Two lines per session file the cache has not answered yet, so the rail
    // knows which threads an agent spawned before it paints them.
    const parents = await this.lineage.resolve(sessionInfos.map((info) => ({
      path: info.path,
      ...(stamps.get(info.path) ? { stamp: stamps.get(info.path)! } : {}),
    })));
    this.lineage.retain(sessionInfos.map((info) => info.path));
    for (const info of sessionInfos) {
      const parent = parents.get(info.path);
      if (parent && parent !== info.id) this.parents.set(info.id, parent);
    }
    const scanned = await mapSessions(
      sessionInfos,
      this.port.cwd(),
      async (cwd) => this.port.projects.label(cwd),
      (cwd) => this.port.projects.name(cwd),
      new Map(this.sessions.flatMap((session) => session.modelProvider ? [[session.id, session.modelProvider]] : [])),
      (info) => this.liveUsage(info.id) ?? usageOrUndefined(this.usage.lookup(info.path, stamps.get(info.path))),
      (info) => parents.get(info.path) ?? this.parents.get(info.id),
    );
    const previous = this.sessions;
    const external = await this.externalShells();
    const byId = new Map(scanned.map((session) => [session.id, session] as const));
    for (const session of external) if (!byId.has(session.id)) byId.set(session.id, session);
    const trashed = (id: string) => this.port.inTrash?.(id) === true;
    const next = mergeSessionIndexScan([...byId.values()], this.sessions, scanStartedAt, this.liveThreadIds())
      .filter((session) => !trashed(session.id));
    this.sessions = next;
    await this.sweep(sessionInfos, previous, next);
    return { previous, next };
  }

  private externalShells(): Promise<UiSession[]> {
    return loadExternalSessionShells({
      safeMode: this.port.safeMode, providers: this.port.backends().values(),
      projectName: (cwd) => this.port.projects.name(cwd), projectLabel: (cwd) => this.port.projects.label(cwd),
      onError: (provider, error) => this.port.log("runtime-backend.list.failed", `${provider.kind}: ${this.port.errorMessage(error)}`),
    });
  }

  /**
   * Word to every hook that a thread is gone for good. The host announces a
   * thread it deletes itself; the sweep announces one whose file disappeared.
   * The id is remembered until the sweep that would report it again has run,
   * so a deletion is announced once whichever of the two noticed it.
   */
  async announceDeleted(sessionId: string, cwd: string): Promise<void> {
    if (this.announcedDeletions.has(sessionId)) return;
    this.announcedDeletions.add(sessionId);
    await this.port.threadLifecycle.threadDeleted(sessionId, cwd);
  }

  /** Extensions reconcile what they keep beside sessions; a missing file is deletion, eviction is not. */
  private async sweep(sessionInfos: readonly SessionInfo[], previous: readonly UiSession[], next: readonly UiSession[]): Promise<void> {
    const nextIds = new Set(next.map((session) => session.id));
    const liveIds = this.liveThreadIds();
    const deleted = previous
      .filter((session) => !nextIds.has(session.id) && !liveIds.has(session.id) && !existsSync(session.path) && !this.port.inTrash?.(session.id))
      .map((session) => ({ sessionId: session.id, cwd: session.projectPath }));
    for (const threadId of [...this.parents.keys()]) {
      if (!nextIds.has(threadId) && !liveIds.has(threadId)) this.parents.delete(threadId);
    }
    for (const session of deleted) {
      try { await this.announceDeleted(session.sessionId, session.cwd); }
      catch (error) { this.port.log("thread.deleted.failed", this.port.errorMessage(error)); }
    }
    for (const session of deleted) this.announcedDeletions.delete(session.sessionId);
    await this.port.threadLifecycle.sweep({
      sessions: sessionInfos.map((info) => ({
        sessionId: info.id,
        path: info.path,
        cwd: info.cwd,
        ...(this.parents.get(info.id) ? { parentThreadId: this.parents.get(info.id)! } : {}),
      })),
      liveThreads: this.port.liveThreads().map((thread) => this.port.hostThread(thread)),
      projectPaths: this.port.projectHistory.list().map((project) => project.path),
      deleted,
    });
  }

  private liveThreadIds(): Set<string> {
    return new Set(this.port.liveThreads().map((thread) => thread.threadId));
  }

  private shellPath(thread: ThreadRuntime): string {
    const kind = threadBackendKind(thread);
    return kind !== "pi" ? externalThreadPath(kind, thread.threadId) : thread.sessionFile ?? thread.threadId;
  }

  /** Prompt completion updates one shell; the global scan is a startup/recovery path. */
  async refreshShell(thread: ThreadRuntime, touch: boolean): Promise<void> {
    const projectPath = thread.cwd;
    const usage = this.rememberUsage(thread);
    const existing = this.byId(thread.threadId);
    const visibleMessages = await thread.backend.transcript();
    const shell = reconcileActiveThreadShell({
      id: thread.threadId,
      path: this.shellPath(thread),
      explicitTitle: safeSessionTitle(thread.state.title) || safeSessionTitle(thread.adapterTitle),
      derivedTitle: firstSentence(visibleTitleText(visibleMessages.find((message) => message.role === "user")?.text ?? "")),
      now: Date.now(),
      projectPath,
      projectName: this.port.projects.name(projectPath),
      projectLabel: this.port.projects.label(projectPath),
      messageCount: visibleMessages.length,
      backendKind: threadBackendKind(thread),
      modelProvider: thread.backend.catalogView().model?.provider ?? this.port.backends().get(threadBackendKind(thread))?.modelProvider,
      ...(usage ? { usage } : {}),
      ...(this.parentOf(thread.threadId) ? { parentThreadId: this.parentOf(thread.threadId)! } : {}),
    }, existing, touch);
    this.sessions = [shell, ...this.sessions.filter((item) => item.id !== shell.id)];
    this.publishShellSoon(shell);
  }

  /**
   * A model change moves only the shell's provider. The transcript is not read
   * again, so the change costs the same in a thread of any length.
   */
  async publishModelProvider(thread: ThreadRuntime): Promise<void> {
    const shell = this.byId(thread.threadId);
    if (!shell) return this.refreshShell(thread, false);
    const modelProvider = thread.backend.catalogView().model?.provider ?? this.port.backends().get(threadBackendKind(thread))?.modelProvider;
    if (!modelProvider || modelProvider === shell.modelProvider) return;
    const updated = { ...shell, modelProvider };
    this.sessions = this.sessions.map((entry) => entry.id === shell.id ? updated : entry);
    this.publishShellSoon(updated);
  }

  /**
   * A live thread's own total, straight from its runtime. It supersedes the
   * cache, and seeds it, so an open thread is never re-read from disk.
   */
  private rememberUsage(thread: ThreadRuntime): UiThreadUsage | undefined {
    const usage = usageOrUndefined(thread.backend.catalogView().usage);
    const file = thread.sessionFile;
    if (usage && file) {
      void readSessionFileStamp(file)
        .then((stamp) => this.usage.record(file, stamp, usage))
        .catch(() => undefined);
    }
    return usage;
  }

  private liveUsage(threadId: string): UiThreadUsage | undefined {
    const thread = this.port.liveThreads().find((live) => live.threadId === threadId);
    return thread ? usageOrUndefined(thread.backend.catalogView().usage) : undefined;
  }

  /** A deferred session-file read finished; the thread's shell carries the number now. */
  private applyScannedUsage(sessionPath: string, usage: UiThreadUsage): void {
    const shell = this.byPath(sessionPath);
    if (!shell || threadUsageEqual(shell.usage, usage)) return;
    const updated = usageOrUndefined(usage) ? { ...shell, usage } : shell;
    if (updated === shell) return;
    this.sessions = this.sessions.map((entry) => entry.id === shell.id ? updated : entry);
    this.publishShellSoon(updated);
  }

  /** The first sentence of a new thread's prompt, before its runtime has titled it. */
  retitle(sessionId: string, title: string): void {
    const shell = this.byId(sessionId);
    if (!shell || shell.title === title) return;
    const titled = { ...shell, title };
    this.sessions = this.sessions.map((entry) => entry.id === sessionId ? titled : entry);
    this.publishShellSoon(titled);
  }

  /** Publishes a title the thread's backend has already stored. */
  publishTitle(sessionId: string, title: string): HostUpdate {
    const now = Date.now();
    this.sessions = this.sessions.map((thread) =>
      thread.id === sessionId ? { ...thread, title, modifiedAt: now } : thread,
    );
    const shell = this.byId(sessionId);
    if (!shell) throw new Error("The active thread is missing from the session index.");
    this.port.log("title.renamed", title);
    const update: HostUpdate = {
      version: HOST_PROTOCOL_VERSION,
      type: "thread-shell",
      update: { sessionId, shell },
    };
    this.port.emitUpdate(update);
    return update;
  }

  /** Carries a project's new label into every shell that names that project. */
  publishLabel(cwd: string, label: string | undefined): void {
    const changed = this.sessions.filter((session) => session.projectPath === cwd && session.projectLabel !== label);
    if (changed.length === 0) return;
    this.sessions = this.sessions.map((session) => session.projectPath === cwd ? { ...session, projectLabel: label } : session);
    for (const session of this.sessions) {
      if (session.projectPath === cwd) this.publishShellSoon(session);
    }
  }

  /**
   * A restart cut this thread's turn short. The mark is the host's, not the
   * session file's, so it lasts for this run and clears on the next prompt.
   */
  setInterrupted(sessionId: string, interrupted: boolean): void {
    if (interrupted === this.interrupted.has(sessionId)) return;
    if (interrupted) this.interrupted.add(sessionId); else this.interrupted.delete(sessionId);
    const shell = this.byId(sessionId);
    if (shell) this.publishShellSoon(shell);
  }

  /** A thread shell names its project the way every other published shape does. */
  private withIdentity(session: UiSession): UiSession {
    const { workspaceId, displayPath } = this.port.workspaces.ref(session.projectPath);
    return {
      ...session,
      workspaceId,
      projectDisplayPath: displayPath,
      ...(this.interrupted.has(session.id) ? { interrupted: true } : {}),
    };
  }

  private publishShellSoon(shell: UiSession): void {
    this.pendingShellUpdates.set(shell.id, shell);
    this.publishSoon("shells", () => {
      const updates = [...this.pendingShellUpdates.values()];
      this.pendingShellUpdates.clear();
      for (const pending of updates) {
        this.port.emitUpdate({
          version: HOST_PROTOCOL_VERSION,
          type: "thread-shell",
          update: { sessionId: pending.id, shell: this.withIdentity(pending) },
        });
      }
    });
  }

  /** Collapse repeated publications of one kind into a single later emit. */
  private publishSoon(kind: "shells" | "index", publish: () => void): void {
    if (this.coalesced.has(kind)) return;
    const timer = setTimeout(() => {
      this.coalesced.delete(kind);
      publish();
    }, 0);
    timer.unref?.();
    this.coalesced.set(kind, timer);
  }

  publishSnapshotSoon(): void {
    this.publishSoon("index", () => this.port.emitUpdate({
      version: HOST_PROTOCOL_VERSION,
      type: "thread-index",
      index: this.snapshot(),
    }));
  }

  snapshot(): ThreadIndexSnapshot {
    const projects = this.port.projectHistory.list();
    const knownPaths = new Set(projects.map((project) => project.path));
    for (const thread of this.sessions) {
      if (knownPaths.has(thread.projectPath) || this.port.projectHistory.isHidden(thread.projectPath)) continue;
      projects.push({
        path: thread.projectPath,
        name: thread.projectName,
        lastOpenedAt: thread.modifiedAt,
      });
      knownPaths.add(thread.projectPath);
    }
    projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    return {
      projects: projects.filter((project) => this.port.projects.isRoot(project.path)).map((project) => ({ ...project, ...this.port.workspaces.ref(project.path) })),
      sessions: this.sessions.map((session) => this.withIdentity(session)),
    };
  }

  async dispose(): Promise<void> {
    for (const timer of this.coalesced.values()) clearTimeout(timer);
    this.coalesced.clear();
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.pendingShellUpdates.clear();
    const errors: unknown[] = [];
    try { await this.usage.dispose(); } catch (error) { errors.push(error); }
    try { await this.lineage.dispose(); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, "Thread index shutdown failed");
  }
}
