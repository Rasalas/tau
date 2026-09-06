import type { UiPromptAttachment, UiSkillDraft } from "../shared/contracts";

export interface QueuedFollowUp {
  id: string;
  /** Raw composer value; the prompt is prepared when it is actually delivered. */
  text: string;
  attachments: UiPromptAttachment[];
  skillDraft?: UiSkillDraft;
}

const EMPTY: readonly QueuedFollowUp[] = Object.freeze([]);

/**
 * Follow-ups wait in the workbench, not in the runtime, so they can be
 * reordered, dropped or steered while the turn they wait for is still running.
 * Each thread has its own queue; the first entry leaves when its thread settles.
 */
export class FollowUpQueueStore {
  private readonly queues = new Map<string, readonly QueuedFollowUp[]>();
  private readonly paused = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getVersion = (): number => this.version;

  list(sessionId: string | undefined): readonly QueuedFollowUp[] {
    return sessionId ? this.queues.get(sessionId) ?? EMPTY : EMPTY;
  }

  sessionIds(): string[] {
    return [...this.queues.keys()];
  }

  enqueue(sessionId: string, item: Omit<QueuedFollowUp, "id">): QueuedFollowUp {
    this.sequence += 1;
    const queued: QueuedFollowUp = { ...item, id: `queued-${Date.now()}-${this.sequence}` };
    this.write(sessionId, [...this.list(sessionId), queued]);
    return queued;
  }

  /** Puts a taken entry back at the head, for a delivery that was rejected. */
  unshift(sessionId: string, item: QueuedFollowUp): void {
    this.write(sessionId, [item, ...this.list(sessionId)]);
  }

  remove(sessionId: string, id: string): QueuedFollowUp | undefined {
    const current = this.list(sessionId);
    const item = current.find((entry) => entry.id === id);
    if (item) this.write(sessionId, current.filter((entry) => entry !== item));
    return item;
  }

  shift(sessionId: string): QueuedFollowUp | undefined {
    const [first, ...rest] = this.list(sessionId);
    if (first) this.write(sessionId, rest);
    return first;
  }

  move(sessionId: string, id: string, toIndex: number): void {
    const current = this.list(sessionId);
    const fromIndex = current.findIndex((entry) => entry.id === id);
    if (fromIndex < 0) return;
    const target = Math.max(0, Math.min(current.length - 1, toIndex));
    if (target === fromIndex) return;
    const next = [...current];
    const [item] = next.splice(fromIndex, 1);
    next.splice(target, 0, item!);
    this.write(sessionId, next);
  }

  /**
   * A rejected delivery must not retry on every render. The pause lifts on the
   * next queue change for that thread or when the thread runs again.
   */
  pause(sessionId: string): void {
    this.paused.add(sessionId);
    this.publish();
  }

  resume(sessionId: string): void {
    if (this.paused.delete(sessionId)) this.publish();
  }

  isPaused(sessionId: string): boolean {
    return this.paused.has(sessionId);
  }

  private write(sessionId: string, next: readonly QueuedFollowUp[]): void {
    if (next.length === 0) this.queues.delete(sessionId);
    else this.queues.set(sessionId, next);
    this.paused.delete(sessionId);
    this.publish();
  }

  private publish(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
