import type { UiModel, UiSession, WorkbenchActions } from "tau";
import { EMPTY_STATE, applyPatches, decodeState } from "./meta.js";
import type { RailQuestion, RailState, ThreadMetaPatch, ThreadSiblingsService } from "./protocol.js";

/**
 * The host's thread meta as this client last heard it, plus what the rail
 * drew last (for the jump and next/previous commands) and the thread the
 * snooze dialog is open for.
 */
export class RailStore implements ThreadSiblingsService {
  private state: RailState = EMPTY_STATE;
  private version = 0;
  private listeners = new Set<() => void>();
  /** Pinned and active threads in the order the rail drew them. */
  displayed: readonly UiSession[] = [];
  /** Set once the host answered, so nothing is mirrored from an empty guess. */
  loaded = false;
  /** The threads the snooze dialog is open for: one from a row, several from a selection. */
  snoozeDialogFor?: readonly UiSession[];
  /** The thread the rename dialog is open for. */
  renameDialogFor?: UiSession;
  /** The confirmation on screen, if any. */
  question?: RailQuestion;
  /** The client's thread index, once the rail has drawn: how a command finds a thread by id. */
  threadStore?: { getSnapshot(): { threads: readonly UiSession[] }; markUnread(threadId: string): void };
  /** The workbench's actions as the rail last saw them, for a page that has none of its own. */
  actions?: WorkbenchActions;
  /** Threads with a turn in flight, from the host's `agent-status` events. */
  readonly running = new Set<string>();

  session(threadId: string): UiSession | undefined {
    return this.threadStore?.getSnapshot().threads.find((thread) => thread.id === threadId)
      ?? this.displayed.find((thread) => thread.id === threadId);
  }

  private noteClaims = new Map<string, number>();
  noteClaimed(threadId: string): boolean { return (this.noteClaims.get(threadId) ?? 0) > 0; }
  claimNote = (threadId: string): (() => void) => {
    this.noteClaims.set(threadId, (this.noteClaims.get(threadId) ?? 0) + 1);
    this.changed();
    return () => { const count = (this.noteClaims.get(threadId) ?? 1) - 1; if (count) this.noteClaims.set(threadId, count); else this.noteClaims.delete(threadId); this.changed(); };
  };

  getState = (): RailState => this.state;
  getVersion = (): number => this.version;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** What the host pushed; it replaces whatever this client assumed. */
  set(payload: unknown): void {
    this.state = decodeState(payload);
    this.loaded = true;
    this.changed();
  }

  /** A change this client just asked the host for, shown before the host confirms it. */
  apply(patches: Readonly<Record<string, ThreadMetaPatch | null>>): void {
    const next = applyPatches(this.state, patches);
    if (next === this.state) return;
    this.state = next;
    this.changed();
  }

  openSnooze(sessions: UiSession | readonly UiSession[] | undefined): void {
    this.snoozeDialogFor = sessions === undefined ? undefined : Array.isArray(sessions) ? sessions : [sessions as UiSession];
    this.changed();
  }

  openRename(session: UiSession | undefined): void {
    this.renameDialogFor = session;
    this.changed();
  }

  /** Shows a confirmation; a second one while the first is open answers the first no. */
  ask(question: RailQuestion | undefined): void {
    const previous = this.question;
    this.question = question;
    if (previous && previous !== question) previous.answer(false);
    this.changed();
  }

  dispose(): void {
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  siblingsOf = (threadId: string): readonly string[] => {
    const group = this.state.threads[threadId]?.siblingGroupId;
    if (!group) return [];
    return Object.entries(this.state.threads).filter(([, meta]) => meta.siblingGroupId === group).map(([id]) => id);
  };

  private wakeTimer?: ReturnType<typeof setTimeout>;

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
    this.scheduleWake();
  }

  /** The rail memoizes its sections, so a snooze running out has to say so itself. */
  private scheduleWake(): void {
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const meta of Object.values(this.state.threads)) {
      if (meta.snoozedUntil !== undefined && meta.snoozedUntil > now) next = Math.min(next, meta.snoozedUntil);
    }
    if (!Number.isFinite(next)) return;
    // A timer longer than a day is split: setTimeout overflows past 24.8 days.
    const timer = setTimeout(() => this.changed(), Math.min(next - now + 50, 86_400_000));
    (timer as { unref?(): void }).unref?.();
    this.wakeTimer = timer;
  }
}

export const modelKey = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;

export function parseModelKey(key: string): { provider: string; id: string } | undefined {
  const slash = key.indexOf("/");
  return slash > 0 && slash < key.length - 1 ? { provider: key.slice(0, slash), id: key.slice(slash + 1) } : undefined;
}

/**
 * The models one prompt goes to. Shift-click in a new thread's picker adds a
 * model or takes it out again; the first Shift-click brings the model the
 * draft already has along, so Shift-clicking that one asks for it twice. The
 * chip in the composer adds a model once more or drops one.
 */
export class FanOutSelection {
  private keys: readonly string[] = [];
  private launch?: { scope: string; group: string; baseCommit?: string; nextOrdinal: number };
  private listeners = new Set<() => void>();

  readonly id = "thread-rail.fan-out";
  selected = (): readonly string[] => this.keys;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  toggle = (model: UiModel, current: UiModel | undefined, runtime?: string, currentRuntime?: string): void => {
    const key = runtime ? `${runtime}::${modelKey(model)}` : modelKey(model);
    if (this.keys.length === 0 && current) {
      // The first Shift-click adds to the draft's own model, the same one included.
      this.set([currentRuntime ? `${currentRuntime}::${modelKey(current)}` : modelKey(current), key]);
      return;
    }
    this.set(this.keys.includes(key) ? this.keys.filter((entry) => entry !== key) : [...this.keys, key]);
  };

  attempt(scope: string, group: () => string): { scope: string; group: string; baseCommit?: string; nextOrdinal: number } {
    if (!this.launch || this.launch.scope !== scope) this.launch = { scope, group: group(), nextOrdinal: 0 };
    return this.launch;
  }

  retain = (keys: readonly string[]): void => {
    this.keys = keys;
    if (keys.length === 0) this.launch = undefined;
    for (const listener of this.listeners) listener();
  };

  reset = (): void => this.set([]);

  add(key: string): void {
    this.set([...this.keys, key]);
  }

  removeAt(index: number): void {
    this.set(this.keys.filter((_, at) => at !== index));
  }

  private set(keys: readonly string[]): void {
    this.launch = undefined;
    this.keys = keys;
    for (const listener of this.listeners) listener();
  }
}
