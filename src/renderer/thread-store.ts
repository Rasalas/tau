import type { HostSnapshot, ThreadIndexSnapshot, UiProject, UiSession } from "../shared/contracts";

export interface ThreadStoreSnapshot {
  projects: readonly UiProject[];
  threads: readonly UiSession[];
  activeThreadId: string;
  isStreaming: boolean;
  runningToolName?: string;
  /** Threads whose last run finished without the user watching. Cleared on open. */
  unreadThreadIds: readonly string[];
}

const EMPTY_SNAPSHOT: ThreadStoreSnapshot = {
  projects: [],
  threads: [],
  activeThreadId: "",
  isStreaming: false,
  unreadThreadIds: [],
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
  private listeners = new Set<() => void>();
  private runningTools = new Map<string, string>();

  getSnapshot = (): ThreadStoreSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
      projects: threadIndex.projects,
      threads: stabilizeThreads(this.snapshot.threads, threadIndex.sessions),
    });
  }

  setStreaming(isStreaming: boolean): void {
    this.publish({ ...this.snapshot, isStreaming });
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
      next.unreadThreadIds === this.snapshot.unreadThreadIds
    ) return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
}
