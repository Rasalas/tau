/** What the notice says was done. */
export type UndoAction = "Unpinned" | "Settled" | "Snoozed" | "Archived" | "Deleted";
/** One kind of thread action; a later one of the same kind on the same thread takes the earlier one's undo. */
export type UndoKind = "pin" | "settle" | "snooze" | "archive" | "delete";

export interface UndoNotice {
  action: UndoAction;
  count: number;
}

interface Entry {
  kind: UndoKind;
  threadId: string;
  action: UndoAction;
  undo(): Promise<void>;
}

export interface ThreadUndoOptions {
  /** How long the last action stays undoable; five seconds. */
  windowMs?: number;
  /** A timer the tests can fire by hand; answers its own cancel. */
  schedule?(run: () => void, ms: number): () => void;
  onError(action: UndoAction, error: unknown): void;
}

const defaultSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * The thread actions that can still be taken back, shared by the row menu,
 * the title menu, drags and chords. Consecutive actions of the same kind
 * share one notice and are undone together; the window runs
 * from the last action, and when it closes every entry goes.
 */
export class ThreadUndo {
  private entries: Entry[] = [];
  private cancel?: () => void;
  private notice?: UndoNotice;
  private version = 0;
  private listeners = new Set<() => void>();
  private readonly windowMs: number;
  private readonly schedule: NonNullable<ThreadUndoOptions["schedule"]>;

  constructor(private readonly options: ThreadUndoOptions) {
    this.windowMs = options.windowMs ?? 5_000;
    this.schedule = options.schedule ?? defaultSchedule;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getVersion = (): number => this.version;
  getNotice = (): UndoNotice | undefined => this.notice;

  record(kind: UndoKind, threadId: string, action: UndoAction, undo: () => Promise<void>): void {
    this.entries = this.entries.filter((entry) => !(entry.kind === kind && entry.threadId === threadId));
    // Settling drops the pin and the snooze; an older undo of either would promote the thread off the shelf.
    if (kind === "settle") this.entries = this.entries.filter((entry) => entry.threadId !== threadId || (entry.kind !== "pin" && entry.kind !== "snooze"));
    this.entries.push({ kind, threadId, action, undo });
    this.cancel?.();
    this.cancel = this.schedule(() => {
      this.entries = [];
      this.cancel = undefined;
      this.refresh();
    }, this.windowMs);
    this.refresh();
  }

  /** The user did the opposite by hand; that thread's undo of this kind is spent. */
  invalidate(kind: UndoKind, threadId: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => !(entry.kind === kind && entry.threadId === threadId));
    if (this.entries.length !== before) this.refresh();
  }

  /** Takes back the group the notice shows; false when there is nothing to take back. */
  undo(): boolean {
    const group = this.latestGroup();
    if (group.length === 0) return false;
    // Consume before awaiting, so a second press cannot run the same group twice.
    this.entries = this.entries.filter((entry) => !group.includes(entry));
    this.refresh();
    for (const entry of group) {
      void entry.undo().catch((error: unknown) => this.options.onError(entry.action, error));
    }
    return true;
  }

  dispose(): void {
    this.cancel?.();
    this.cancel = undefined;
    this.entries = [];
    this.listeners.clear();
  }

  private latestGroup(): Entry[] {
    const latest = this.entries.at(-1);
    if (!latest) return [];
    const group: Entry[] = [];
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]!;
      if (entry.action !== latest.action) break;
      group.push(entry);
    }
    return group;
  }

  private refresh(): void {
    const group = this.latestGroup();
    this.notice = group.length > 0 ? { action: group[0]!.action, count: group.length } : undefined;
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
