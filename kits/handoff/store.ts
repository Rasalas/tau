import type { ThreadStore, UiRuntimeBackend } from "tau";
import { EMPTY_LINEAGE, type LineageLink, type LineageState } from "./protocol.js";

/** A draft that continues another thread; the handoff is written when it is sent. */
export interface DraftHandoff {
  transferId: string;
  sourceTitle: string;
  status: "waiting" | "writing" | "failed";
  error?: string;
}

/** What the draft's own slot keeps, so a reload brings the chip back. */
export interface SavedHandoff {
  transferId: string;
  sourceTitle: string;
}

export interface HandoffView {
  lineage: LineageState;
  /** The thread whose "Continue in…" menu is open. */
  pickerFor?: string;
  runtimes: readonly UiRuntimeBackend[];
  drafts: Readonly<Record<string, DraftHandoff>>;
  /** A merge-back waiting for its parent to be on screen, to go into that composer. */
  mergeDraft?: { parentThreadId: string; text: string };
}

/** A continuation made a moment ago; the next new draft takes it. */
const ARMED_MS = 15_000;

export function parseSaved(value: unknown): SavedHandoff | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { transferId, sourceTitle } = value as Record<string, unknown>;
  return typeof transferId === "string" && transferId ? { transferId, sourceTitle: typeof sourceTitle === "string" ? sourceTitle : "another thread" } : undefined;
}

/**
 * The desktop half's state, one immutable view for `useSyncExternalStore`
 * plus the bookkeeping between a send and the thread it created.
 */
export class HandoffStore {
  private view: HandoffView = { lineage: EMPTY_LINEAGE, runtimes: [], drafts: {} };
  private readonly listeners = new Set<() => void>();
  private armed: (SavedHandoff & { at: number }) | undefined;
  /** Transfers whose first prompt was accepted, oldest first, waiting for their thread's id. */
  private readonly awaiting: string[] = [];
  /** Per draft scope: clears the draft's own slot once its prompt went. */
  private readonly clearers = new Map<string, () => void>();
  /** The window's thread index, lent by the title region while it is drawn. */
  threads: ThreadStore | undefined;

  constructor(private readonly clock: () => number = Date.now) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): HandoffView => this.view;

  private update(change: Partial<HandoffView>): void {
    this.view = { ...this.view, ...change };
    for (const listener of [...this.listeners]) listener();
  }

  setLineage(value: unknown): void {
    const links = value && typeof value === "object" && Array.isArray((value as LineageState).links) ? (value as LineageState).links : undefined;
    if (links) this.update({ lineage: { links: links.filter((link): link is LineageLink => Boolean(link?.threadId && link.parentThreadId)) } });
  }

  link(threadId: string | undefined): LineageLink | undefined {
    return threadId ? this.view.lineage.links.find((entry) => entry.threadId === threadId) : undefined;
  }

  setRuntimes(runtimes: readonly UiRuntimeBackend[] | undefined): void {
    if (!runtimes || runtimes === this.view.runtimes) return;
    if (runtimes.length === this.view.runtimes.length && runtimes.every((runtime, index) => runtime.kind === this.view.runtimes[index]?.kind && runtime.label === this.view.runtimes[index]?.label)) return;
    this.update({ runtimes });
  }

  openPicker(threadId: string | undefined): void {
    if (this.view.pickerFor !== threadId) this.update({ pickerFor: threadId });
  }

  arm(handoff: SavedHandoff): void {
    this.armed = { ...handoff, at: this.clock() };
  }

  /** The continuation the next new draft takes, once. */
  takeArmed(): SavedHandoff | undefined {
    const armed = this.armed;
    this.armed = undefined;
    return armed && this.clock() - armed.at < ARMED_MS ? { transferId: armed.transferId, sourceTitle: armed.sourceTitle } : undefined;
  }

  bindDraft(scope: string, handoff: SavedHandoff, clear: () => void): void {
    this.clearers.set(scope, clear);
    const current = this.view.drafts[scope];
    if (current?.transferId === handoff.transferId) return;
    this.update({ drafts: { ...this.view.drafts, [scope]: { ...handoff, status: "waiting" } } });
  }

  draft(scope: string): DraftHandoff | undefined {
    return this.view.drafts[scope];
  }

  setDraftStatus(scope: string, status: DraftHandoff["status"], error?: string): void {
    const current = this.view.drafts[scope];
    if (!current) return;
    this.update({ drafts: { ...this.view.drafts, [scope]: { transferId: current.transferId, sourceTitle: current.sourceTitle, status, ...(error ? { error } : {}) } } });
  }

  /** Forgets the draft's handoff; `sent` queues its transfer for the thread the prompt creates. */
  releaseDraft(scope: string, sent: boolean): string | undefined {
    const current = this.view.drafts[scope];
    const clear = this.clearers.get(scope);
    this.clearers.delete(scope);
    if (!current) return undefined;
    clear?.();
    if (sent) this.awaiting.push(current.transferId);
    const { [scope]: _released, ...drafts } = this.view.drafts;
    this.update({ drafts });
    return current.transferId;
  }

  /** The oldest sent transfer that has no thread yet. */
  nextAwaiting(): string | undefined {
    return this.awaiting.shift();
  }

  setMergeDraft(mergeDraft: HandoffView["mergeDraft"]): void {
    this.update({ mergeDraft });
  }

  clear(): void {
    this.armed = undefined;
    this.awaiting.length = 0;
    this.clearers.clear();
    this.threads = undefined;
    this.view = { lineage: EMPTY_LINEAGE, runtimes: [], drafts: {} };
    for (const listener of [...this.listeners]) listener();
  }
}
