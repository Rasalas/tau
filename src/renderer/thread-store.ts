import type { HostSnapshot, ThreadIndexSnapshot, UiProject, UiSession } from "../shared/contracts";

export interface ThreadActivitySnapshot {
  activeThreadId: string;
  isStreaming: boolean;
  runningToolName?: string;
  unreadThreadIds: readonly string[];
  waitingThreadIds: readonly string[];
  /** Threads with a run in flight, whether or not they are the one on screen. */
  runningThreadIds: readonly string[];
}

export interface ThreadStoreSnapshot {
  projects: readonly UiProject[];
  threads: readonly UiSession[];
  activeThreadId: string;
  isStreaming: boolean;
  runningToolName?: string;
  /** Threads whose last run finished without the user watching. Cleared on open. */
  unreadThreadIds: readonly string[];
  /** Threads stalled on an extension question; they cannot continue until answered. */
  waitingThreadIds: readonly string[];
  /** Threads with a run in flight, whether or not they are the one on screen. */
  runningThreadIds: readonly string[];
}

const EMPTY_SNAPSHOT: ThreadStoreSnapshot = {
  projects: [],
  threads: [],
  activeThreadId: "",
  isStreaming: false,
  unreadThreadIds: [],
  waitingThreadIds: [],
  runningThreadIds: [],
};

function threadEqual(left: UiSession, right: UiSession): boolean {
  return left.id === right.id &&
    left.path === right.path &&
    left.title === right.title &&
    left.modifiedAt === right.modifiedAt &&
    left.projectPath === right.projectPath &&
    left.projectName === right.projectName &&
    left.branch === right.branch &&
    left.messageCount === right.messageCount;
}

function stabilizeProjects(
  previous: readonly UiProject[],
  incoming: readonly UiProject[],
): readonly UiProject[] {
  const previousByPath = new Map(previous.map((project) => [project.path, project] as const));
  const next = incoming.map((project) => {
    const old = previousByPath.get(project.path);
    return old && old.name === project.name && old.lastOpenedAt === project.lastOpenedAt ? old : project;
  });
  return next.length === previous.length && next.every((project, index) => project === previous[index]) ? previous : next;
}

function stabilizeThreads(
  previous: readonly UiSession[],
  incoming: readonly UiSession[],
): readonly UiSession[] {
  if (previous === incoming) return previous;
  const previousById = new Map(previous.map((thread) => [thread.id, thread] as const));
  const next = incoming.map((thread) => {
    const old = previousById.get(thread.id);
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
    activeThreadId: "", isStreaming: false, unreadThreadIds: [], waitingThreadIds: [], runningThreadIds: [],
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
    this.publish({
      ...this.snapshot,
      activeThreadId: snapshot.sessionId,
      isStreaming: snapshot.isStreaming,
      runningToolName: undefined,
    });
  }

  applyThreadIndex(threadIndex: ThreadIndexSnapshot): void {
    this.publish({
      ...this.snapshot,
      projects: stabilizeProjects(this.snapshot.projects, threadIndex.projects),
      threads: stabilizeThreads(this.snapshot.threads, threadIndex.sessions),
    });
  }

  applyThreadShell(sessionId: string, shell?: UiSession, removed = false): void {
    const current = this.snapshot.threads;
    const existingIndex = current.findIndex((thread) => thread.id === sessionId);
    let threads: readonly UiSession[] = current;
    if (removed) {
      if (existingIndex >= 0) threads = current.filter((thread) => thread.id !== sessionId);
    } else if (shell) {
      if (existingIndex < 0) threads = [shell, ...current];
      else if (!threadEqual(current[existingIndex], shell)) {
        const next = [...current];
        next[existingIndex] = shell;
        threads = next;
      }
    }
    if (threads !== current) this.publish({ ...this.snapshot, threads });
  }

  setStreaming(isStreaming: boolean): void {
    this.publish({ ...this.snapshot, isStreaming });
  }

  /** Run state belongs to the thread, not to whichever thread is on screen. */
  setThreadRunning(threadId: string, running: boolean): void {
    if (!threadId) return;
    const current = this.snapshot.runningThreadIds;
    if (running === current.includes(threadId)) return;
    this.publish({
      ...this.snapshot,
      runningThreadIds: running ? [...current, threadId] : current.filter((id) => id !== threadId),
    });
  }

  setActiveThread(activeThreadId: string, isStreaming = false): void {
    this.publish({ ...this.snapshot, activeThreadId, isStreaming, runningToolName: undefined });
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

  private publish(next: ThreadStoreSnapshot): void {
    if (
      next.projects === this.snapshot.projects &&
      next.threads === this.snapshot.threads &&
      next.activeThreadId === this.snapshot.activeThreadId &&
      next.isStreaming === this.snapshot.isStreaming &&
      next.runningToolName === this.snapshot.runningToolName &&
      next.unreadThreadIds === this.snapshot.unreadThreadIds &&
      next.waitingThreadIds === this.snapshot.waitingThreadIds &&
      next.runningThreadIds === this.snapshot.runningThreadIds
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
      next.runningThreadIds !== previous.runningThreadIds
    ) {
      this.activitySnapshot = {
        activeThreadId: next.activeThreadId,
        isStreaming: next.isStreaming,
        runningToolName: next.runningToolName,
        unreadThreadIds: next.unreadThreadIds,
        waitingThreadIds: next.waitingThreadIds,
        runningThreadIds: next.runningThreadIds,
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
