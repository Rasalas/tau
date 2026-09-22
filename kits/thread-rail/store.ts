import type { UiModel, UiSession } from "tau";
import { EMPTY_STATE, applyPatches, decodeState } from "./meta.js";
import type { RailState, ThreadMetaPatch, ThreadSiblingsService } from "./protocol.js";

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
  snoozeDialogFor?: UiSession;

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

  openSnooze(session: UiSession | undefined): void {
    this.snoozeDialogFor = session;
    this.changed();
  }

  siblingsOf = (threadId: string): readonly string[] => {
    const group = this.state.threads[threadId]?.siblingGroupId;
    if (!group) return [];
    return Object.entries(this.state.threads).filter(([, meta]) => meta.siblingGroupId === group).map(([id]) => id);
  };

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
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
 * draft already has along. The chip in the composer can add a model twice.
 */
export class FanOutSelection {
  private keys: readonly string[] = [];
  private listeners = new Set<() => void>();

  readonly id = "thread-rail.fan-out";
  selected = (): readonly string[] => this.keys;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  toggle = (model: UiModel, current: UiModel | undefined): void => {
    const key = modelKey(model);
    const base = this.keys.length === 0 && current ? [modelKey(current)] : this.keys;
    this.set(base.includes(key) ? base.filter((entry) => entry !== key) : [...base, key]);
  };

  reset = (): void => this.set([]);

  add(key: string): void {
    this.set([...this.keys, key]);
  }

  removeAt(index: number): void {
    this.set(this.keys.filter((_, at) => at !== index));
  }

  private set(keys: readonly string[]): void {
    this.keys = keys;
    for (const listener of this.listeners) listener();
  }
}
