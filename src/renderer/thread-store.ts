import type { HostSnapshot, ThreadIndexSnapshot, UiProject, UiSession } from "../shared/contracts";

export interface ThreadActivitySnapshot {
  activeThreadId: string;
  isStreaming: boolean;
  runningToolName?: string;
  unreadThreadIds: readonly string[];
  waitingThreadIds: readonly string[];
  /** Threads with a run in flight, whether or not they are the one on screen. */
  runningThreadIds: readonly string[];
  /** Local start times for live sidebar timers, keyed by Tau thread id. */
  runningStartedAt: Readonly<Record<string, number>>;
}

export interface ThreadStoreSnapshot {
  projects: readonly UiProject[];
  threads: readonly UiSession[];
  activeThreadId: string;
  /** Derived: the active thread has a run in flight. Never assigned directly. */
  isStreaming: boolean;
  runningToolName?: string;
  /** Threads whose last run finished without the user watching. Cleared on open. */
  unreadThreadIds: readonly string[];
  /** Threads stalled on an extension question; they cannot continue until answered. */
  waitingThreadIds: readonly string[];
  /** Threads with a run in flight, whether or not they are the one on screen. */
  runningThreadIds: readonly string[];
  /** Local start times for live sidebar timers, keyed by Tau thread id. */
  runningStartedAt: Readonly<Record<string, number>>;
}

const EMPTY_SNAPSHOT: ThreadStoreSnapshot = {
  projects: [],
  threads: [],
  activeThreadId: "",
  isStreaming: false,
  unreadThreadIds: [],
  waitingThreadIds: [],
  runningThreadIds: [],
  runningStartedAt: {},
};

function threadEqual(left: UiSession, right: UiSession): boolean {
  return left.id === right.id &&
    left.path === right.path &&
    left.title === right.title &&
    left.modifiedAt === right.modifiedAt &&
    left.projectPath === right.projectPath &&
    left.projectName === right.projectName &&
    left.projectLabel === right.projectLabel &&
    left.messageCount === right.messageCount &&
    left.backendKind === right.backendKind &&
    left.modelProvider === right.modelProvider;
}

function preserveObservedModelProvider(incoming: UiSession, existing: UiSession | undefined): UiSession {
  return incoming.modelProvider === undefined && existing?.modelProvider !== undefined
    ? { ...incoming, modelProvider: existing.modelProvider }
    : incoming;
}

function stabilizeProjects(
  previous: readonly UiProject[],
  incoming: readonly UiProject[],
): readonly UiProject[] {
  const previousByPath = new Map(previous.map((project) => [project.path, project] as const));
  const next = incoming.map((project) => {
    const old = previousByPath.get(project.path);
    return old && old.name === project.name && old.lastOpenedAt === project.lastOpenedAt && old.icon === project.icon ? old : project;
  });
  return next.length === previous.length && next.every((project, index) => project === previous[index]) ? previous : next;
}

function stabilizeThreads(
  previous: readonly UiSession[],
  incoming: readonly UiSession[],
): readonly UiSession[] {
  if (previous === incoming) return previous;
  const previousById = new Map(previous.map((thread) => [thread.id, thread] as const));
  const next = incoming.map((incomingThread) => {
    const old = previousById.get(incomingThread.id);
    const thread = preserveObservedModelProvider(incomingThread, old);
    return old && threadEqual(old, thread) ? old : thread;
  });
  return next.length === previous.length && next.every((thread, index) => thread === previous[index])
    ? previous
    : next;
}

export class ThreadStore {
  private snapshot: ThreadStoreSnapshot = EMPTY_SNAPSHOT;
  private threadIds: readonly string[] = [];
  private listeners = new Set<() => void>();
  private idListeners = new Set<() => void>();
  private projectListeners = new Set<() => void>();
  private activityListeners = new Set<() => void>();
  private activitySnapshot: ThreadActivitySnapshot = {
    activeThreadId: "", isStreaming: false, unreadThreadIds: [], waitingThreadIds: [], runningThreadIds: [], runningStartedAt: {},
  };
  private shellListeners = new Map<string, Set<() => void>>();
  private runningTools = new Map<string, string>();

  getSnapshot = (): ThreadStoreSnapshot => this.snapshot;
  getThreadIds = (): readonly string[] => this.threadIds;
  getProjects = (): readonly UiProject[] => this.snapshot.projects;
  getActivity = (): ThreadActivitySnapshot => this.activitySnapshot;
  getThread = (id: string): UiSession | undefined => this.snapshot.threads.find((thread) => thread.id === id);

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeToProjects = (listener: () => void): (() => void) => {
    this.projectListeners.add(listener);
    return () => this.projectListeners.delete(listener);
  };

  subscribeToActivity = (listener: () => void): (() => void) => {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  };

  /** Subscribe only to navigation order; shell updates do not invalidate this listener. */
  subscribeToIds = (listener: () => void): (() => void) => {
    this.idListeners.add(listener);
    return () => this.idListeners.delete(listener);
  };

  /** Subscribe to one shell record, preserving row-level render isolation. */
  subscribeToThread = (id: string, listener: () => void): (() => void) => {
    let listeners = this.shellListeners.get(id);
    if (!listeners) { listeners = new Set(); this.shellListeners.set(id, listeners); }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.shellListeners.delete(id);
    };
  };

  applyHostSnapshot(snapshot: HostSnapshot): void {
    this.runningTools.clear();
    this.publish({ ...this.snapshot, activeThreadId: snapshot.sessionId, runningToolName: undefined });
    this.setThreadRunning(snapshot.sessionId, snapshot.isStreaming);
  }

  applyThreadIndex(threadIndex: ThreadIndexSnapshot): void {
    this.publish({
      ...this.snapshot,
      projects: stabilizeProjects(this.snapshot.projects, threadIndex.projects),
      threads: stabilizeThreads(this.snapshot.threads, threadIndex.sessions),
    });
  }

  setThreadModelProvider(sessionId: string, modelProvider: string | undefined): void {
    const shell = this.getThread(sessionId);
    if (shell && shell.modelProvider !== modelProvider) this.applyThreadShell(sessionId, { ...shell, modelProvider });
  }

  applyThreadShell(sessionId: string, shell?: UiSession, removed = false): void {
    const current = this.snapshot.threads;
    const existingIndex = current.findIndex((thread) => thread.id === sessionId);
    let threads: readonly UiSession[] = current;
    if (removed) {
      if (existingIndex >= 0) threads = current.filter((thread) => thread.id !== sessionId);
    } else if (shell) {
      const mergedShell = preserveObservedModelProvider(shell, current[existingIndex]);
      if (existingIndex < 0) threads = [mergedShell, ...current];
      else if (!threadEqual(current[existingIndex], mergedShell)) {
        const next = [...current];
        next[existingIndex] = mergedShell;
        threads = next;
      }
    }
    if (threads !== current) this.publish({ ...this.snapshot, threads });
  }

  /** Run state belongs to the thread, not to whichever thread is on screen. */
  setThreadRunning(threadId: string, running: boolean): void {
    if (!threadId) return;
    const current = this.snapshot.runningThreadIds;
    const alreadyRunning = current.includes(threadId);
    const hasStartedAt = this.snapshot.runningStartedAt[threadId] !== undefined;
    if (running === alreadyRunning && running === hasStartedAt) return;
    const runningStartedAt = { ...this.snapshot.runningStartedAt };
    if (running) runningStartedAt[threadId] ??= Date.now();
    else delete runningStartedAt[threadId];
    this.publish({
      ...this.snapshot,
      runningThreadIds: running ? (alreadyRunning ? current : [...current, threadId]) : current.filter((id) => id !== threadId),
      runningStartedAt,
    });
  }

  setActiveThread(activeThreadId: string, isStreaming = false): void {
    this.publish({ ...this.snapshot, activeThreadId, runningToolName: undefined });
    this.setThreadRunning(activeThreadId, isStreaming);
  }

  toolStarted(id: string, name: string): void {
    this.runningTools.set(id, name);
    this.publish({ ...this.snapshot, runningToolName: name });
  }

  toolEnded(id: string): void {
    this.runningTools.delete(id);
    const runningToolName = [...this.runningTools.values()].at(-1);
    this.publish({ ...this.snapshot, runningToolName });
  }

  markUnread(threadId: string): void {
    if (!threadId || this.snapshot.unreadThreadIds.includes(threadId)) return;
    this.publish({ ...this.snapshot, unreadThreadIds: [...this.snapshot.unreadThreadIds, threadId] });
  }

  setWaiting(threadIds: readonly string[]): void {
    const next = [...new Set(threadIds)].sort();
    const current = [...this.snapshot.waitingThreadIds].sort();
    if (next.length === current.length && next.every((id, index) => id === current[index])) return;
    this.publish({ ...this.snapshot, waitingThreadIds: next });
  }

  markRead(threadId: string): void {
    if (!this.snapshot.unreadThreadIds.includes(threadId)) return;
    this.publish({
      ...this.snapshot,
      unreadThreadIds: this.snapshot.unreadThreadIds.filter((id) => id !== threadId),
    });
  }

  private publish(candidate: ThreadStoreSnapshot): void {
    // `isStreaming` is not stored: it is the run state of whichever thread is
    // on screen, so `setThreadRunning` stays its only writer.
    const isStreaming = Boolean(candidate.activeThreadId) && candidate.runningThreadIds.includes(candidate.activeThreadId);
    const next = candidate.isStreaming === isStreaming ? candidate : { ...candidate, isStreaming };
    if (
      next.projects === this.snapshot.projects &&
      next.threads === this.snapshot.threads &&
      next.activeThreadId === this.snapshot.activeThreadId &&
      next.isStreaming === this.snapshot.isStreaming &&
      next.runningToolName === this.snapshot.runningToolName &&
      next.unreadThreadIds === this.snapshot.unreadThreadIds &&
      next.waitingThreadIds === this.snapshot.waitingThreadIds &&
      next.runningThreadIds === this.snapshot.runningThreadIds &&
      next.runningStartedAt === this.snapshot.runningStartedAt
    ) return;
    const previous = this.snapshot;
    this.snapshot = next;
    if (next.projects !== previous.projects) this.projectListeners.forEach((listener) => listener());
    if (
      next.activeThreadId !== previous.activeThreadId ||
      next.isStreaming !== previous.isStreaming ||
      next.runningToolName !== previous.runningToolName ||
      next.unreadThreadIds !== previous.unreadThreadIds ||
      next.waitingThreadIds !== previous.waitingThreadIds ||
      next.runningThreadIds !== previous.runningThreadIds ||
      next.runningStartedAt !== previous.runningStartedAt
    ) {
      this.activitySnapshot = {
        activeThreadId: next.activeThreadId,
        isStreaming: next.isStreaming,
        runningToolName: next.runningToolName,
        unreadThreadIds: next.unreadThreadIds,
        waitingThreadIds: next.waitingThreadIds,
        runningThreadIds: next.runningThreadIds,
        runningStartedAt: next.runningStartedAt,
      };
      this.activityListeners.forEach((listener) => listener());
    }
    if (next.threads !== previous.threads) {
      const nextIds = next.threads.map((thread) => thread.id);
      const idsChanged = this.threadIds.length !== nextIds.length || this.threadIds.some((id, index) => id !== nextIds[index]);
      if (idsChanged) this.threadIds = nextIds;
      else if (nextIds.length === 0) this.threadIds = [];

      const previousIds = previous.threads.map((thread) => thread.id);
      if (previousIds.length !== this.threadIds.length || previousIds.some((id, index) => id !== this.threadIds[index])) {
        this.idListeners.forEach((listener) => listener());
      }
      const previousById = new Map(previous.threads.map((thread) => [thread.id, thread] as const));
      next.threads.forEach((thread) => {
        if (previousById.get(thread.id) !== thread) this.shellListeners.get(thread.id)?.forEach((listener) => listener());
      });
    }
    this.listeners.forEach((listener) => listener());
  }
}
