import type { HostSnapshot, ThreadIndexSnapshot, UiProject, UiSession } from "../shared/contracts";
import type { DraftThread } from "./draft-threads";

export interface ThreadActivitySnapshot {
  activeThreadId: string;
  isStreaming: boolean;
  runningToolName?: string;
  unreadThreadIds: readonly string[];
  waitingThreadIds: readonly string[];
  /** Threads with a run in flight, whether or not they are the one on screen. */
  runningThreadIds: readonly string[];
  /** Threads whose last delivery the host refused or whose last turn failed; cleared when one starts again. */
  failedThreadIds: readonly string[];
  /** Threads a restart cut a turn short in, as the index reports them. */
  interruptedThreadIds: readonly string[];
  /** Threads a provider's usage or rate limit stopped, as the index reports them. */
  limitedThreadIds: readonly string[];
  /** When each run started, keyed by Tau thread id: the host's time where it said, else this client's. */
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
  /** Derived: refused deliveries, then the threads the index says failed their last turn. */
  failedThreadIds: readonly string[];
  /** Threads a restart cut a turn short in, as the index reports them. */
  interruptedThreadIds: readonly string[];
  /** Threads a provider's usage or rate limit stopped, as the index reports them. */
  limitedThreadIds: readonly string[];
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
  failedThreadIds: [],
  interruptedThreadIds: [],
  limitedThreadIds: [],
  runningStartedAt: {},
};

const ACTIVITY_KEYS = [
  "activeThreadId", "isStreaming", "runningToolName", "unreadThreadIds", "waitingThreadIds",
  "runningThreadIds", "failedThreadIds", "interruptedThreadIds", "limitedThreadIds", "runningStartedAt",
] as const satisfies ReadonlyArray<keyof ThreadActivitySnapshot>;

function activityOf(snapshot: ThreadStoreSnapshot): ThreadActivitySnapshot {
  return Object.fromEntries(ACTIVITY_KEYS.map((key) => [key, snapshot[key]])) as unknown as ThreadActivitySnapshot;
}

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
    left.interrupted === right.interrupted &&
    left.turnError === right.turnError &&
    left.runtimeError === right.runtimeError &&
    left.modelProvider === right.modelProvider &&
    left.model === right.model &&
    left.queueHeld === right.queueHeld &&
    same(left.limit, right.limit) &&
    same(left.queued, right.queued) &&
    same(left.usage, right.usage);
}

/** Small host-owned records, a fresh object each publication: compared field by field, never as JSON. */
function same(left: unknown, right: unknown): boolean {
  if (left === right || !left || !right || typeof left != "object") return left === right;
  let keys = 0;
  for (const key in left) if (keys++, !same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])) return false;
  for (const _ in right) keys--;
  return !keys;
}

function preserveObservedModelProvider(incoming: UiSession, existing: UiSession | undefined): UiSession {
  return incoming.modelProvider === undefined && existing?.modelProvider !== undefined
    ? { ...incoming, modelProvider: existing.modelProvider, ...(existing.model !== undefined ? { model: existing.model } : {}) }
    : incoming;
}

/** Keeps the previous array when the ids are the same, so a rescan is not a change. */
function sameIds(previous: readonly string[], next: readonly string[]): readonly string[] {
  return next.length === previous.length && next.every((id, index) => id === previous[index]) ? previous : next;
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
  private activitySnapshot = activityOf(EMPTY_SNAPSHOT);
  private shellListeners = new Map<string, Set<() => void>>();
  private runningTools = new Map<string, string>();
  /** Deliveries the host refused, by thread; the rest of `failedThreadIds` comes from the index. */
  private refusedThreadIds: readonly string[] = [];
  private drafts: readonly DraftThread[] = [];
  private draftListeners = new Set<() => void>();

  getSnapshot = (): ThreadStoreSnapshot => this.snapshot;
  getThreadIds = (): readonly string[] => this.threadIds;
  getProjects = (): readonly UiProject[] => this.snapshot.projects;
  getActivity = (): ThreadActivitySnapshot => this.activitySnapshot;
  getThread = (id: string): UiSession | undefined => this.snapshot.threads.find((thread) => thread.id === id);
  /** New threads' drafts, newest first: the one on screen and the ones left with text in them. */
  getDrafts = (): readonly DraftThread[] => this.drafts;

  subscribeToDrafts = (listener: () => void): (() => void) => {
    this.draftListeners.add(listener);
    return () => this.draftListeners.delete(listener);
  };

  setDrafts(drafts: readonly DraftThread[]): void {
    this.drafts = drafts;
    this.draftListeners.forEach((listener) => listener());
  }

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
      ...(threadIndex.runs ? this.runsFromHost(threadIndex.runs) : {}),
    });
  }

  /** A bootstrap's runs replace this client's: it may have missed a start or an end while away. */
  private runsFromHost(runs: Readonly<Record<string, number>>): Pick<ThreadStoreSnapshot, "runningThreadIds" | "runningStartedAt"> {
    const ids = Object.keys(runs);
    const { runningThreadIds, runningStartedAt } = this.snapshot;
    const sameRuns = ids.length === runningThreadIds.length && ids.every((id) => runningThreadIds.includes(id));
    const sameStarts = sameRuns && ids.every((id) => runningStartedAt[id] === runs[id]);
    this.refusedThreadIds = this.refusedThreadIds.filter((id) => runs[id] === undefined);
    return {
      runningThreadIds: sameRuns ? runningThreadIds : ids,
      runningStartedAt: sameStarts && Object.keys(runningStartedAt).length === ids.length ? runningStartedAt : { ...runs },
    };
  }

  setThreadModelProvider(sessionId: string, modelProvider: string | undefined, model?: string): void {
    const shell = this.getThread(sessionId);
    if (!shell || (shell.modelProvider === modelProvider && (model ?? shell.model) === shell.model)) return;
    this.applyThreadShell(sessionId, { ...shell, modelProvider, ...(model ? { model } : {}) });
  }

  applyThreadShell(sessionId: string, shell?: UiSession, removed = false): void {
    const current = this.snapshot.threads;
    const existingIndex = current.findIndex((thread) => thread.id === sessionId);
    let threads: readonly UiSession[] = current;
    if (removed) {
      if (existingIndex >= 0) threads = current.filter((thread) => thread.id !== sessionId);
    } else if (shell) {
      const existing = current[existingIndex];
      // A shell read before the first prompt was written says 0; one the thread outgrew never takes it back.
      const counted = shell.messageCount === 0 && (existing?.messageCount ?? 0) > 0 ? { ...shell, messageCount: existing!.messageCount } : shell;
      const mergedShell = preserveObservedModelProvider(counted, existing);
      if (existingIndex < 0) threads = [mergedShell, ...current];
      else if (!threadEqual(current[existingIndex], mergedShell)) {
        const next = [...current];
        next[existingIndex] = mergedShell;
        threads = next;
      }
    }
    if (threads !== current) this.publish({ ...this.snapshot, threads });
  }

  /**
   * Run state belongs to the thread, not to whichever thread is on screen.
   * `startedAt` is the host's start of the run and wins over this client's clock.
   */
  setThreadRunning(threadId: string, running: boolean, startedAt?: number): void {
    if (!threadId) return;
    const current = this.snapshot.runningThreadIds;
    const alreadyRunning = current.includes(threadId);
    const knownStart = this.snapshot.runningStartedAt[threadId];
    const hasStartedAt = knownStart !== undefined;
    if (running === alreadyRunning && running === hasStartedAt && (!running || startedAt === undefined || startedAt === knownStart)) return;
    const runningStartedAt = { ...this.snapshot.runningStartedAt };
    if (running) runningStartedAt[threadId] = startedAt ?? knownStart ?? Date.now();
    else delete runningStartedAt[threadId];
    // A thread that runs again is no longer the thread that failed.
    if (running) this.refusedThreadIds = this.refusedThreadIds.filter((id) => id !== threadId);
    // A run starts from a prompt: the list keeps a new thread when its run ends before the host's shell counts it.
    const threads = running && this.getThread(threadId)?.messageCount === 0
      ? this.snapshot.threads.map((thread) => thread.id === threadId ? { ...thread, messageCount: 1 } : thread)
      : this.snapshot.threads;
    this.publish({
      ...this.snapshot,
      threads,
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

  /** A delivery the host refused. The thread keeps saying so until it runs again. */
  markFailed(threadId: string): void {
    if (!threadId || this.refusedThreadIds.includes(threadId)) return;
    this.refusedThreadIds = [...this.refusedThreadIds, threadId];
    this.publish({ ...this.snapshot });
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
    // The index owns which threads are interrupted; the list is only mirrored
    // here so the rail reads every activity state from one snapshot.
    const interruptedThreadIds = sameIds(
      this.snapshot.interruptedThreadIds,
      candidate.threads.flatMap((thread) => thread.interrupted ? [thread.id] : []),
    );
    const limitedThreadIds = sameIds(
      this.snapshot.limitedThreadIds,
      candidate.threads.flatMap((thread) => thread.limit ? [thread.id] : []),
    );
    const failedThreadIds = sameIds(this.snapshot.failedThreadIds, [
      ...this.refusedThreadIds,
      ...candidate.threads.flatMap((thread) => thread.turnError && !this.refusedThreadIds.includes(thread.id) ? [thread.id] : []),
    ]);
    const next = candidate.isStreaming === isStreaming && candidate.interruptedThreadIds === interruptedThreadIds
      && candidate.failedThreadIds === failedThreadIds && candidate.limitedThreadIds === limitedThreadIds
      ? candidate
      : { ...candidate, isStreaming, interruptedThreadIds, failedThreadIds, limitedThreadIds };
    const previous = this.snapshot;
    const activityChanged = ACTIVITY_KEYS.some((key) => next[key] !== previous[key]);
    if (!activityChanged && next.projects === previous.projects && next.threads === previous.threads) return;
    this.snapshot = next;
    if (next.projects !== previous.projects) this.projectListeners.forEach((listener) => listener());
    if (activityChanged) {
      this.activitySnapshot = activityOf(next);
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
