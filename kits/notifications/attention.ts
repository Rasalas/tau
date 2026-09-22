import type { AttentionItem, Delivery } from "./protocol.js";

interface Presence {
  focused: boolean;
  threadId?: string;
  /** When this client last gained focus; 0 when it never had it. */
  focusedAt: number;
  reportedAt: number;
}

/** What changed: whether every client's badge has to follow, and who shows what. */
export interface AttentionChange {
  changed: boolean;
  delivery?: Delivery;
}

export interface AttentionBookOptions {
  now(): number;
  /** A thread's second piece of news within this long updates the badge but notifies nobody. */
  debounceMs: number;
}

/**
 * The host's side of notifications, without timers or I/O: which threads
 * have news nobody saw, which client shows it, and what waits for a client
 * while none is attached. A thread is seen when a client whose window has
 * focus has it on screen.
 */
export class AttentionBook {
  private readonly items = new Map<string, AttentionItem>();
  private readonly clients = new Map<string, Presence>();
  private readonly notifiedAt = new Map<string, number>();
  /** News that found no client; the first one to report gets it. */
  private held: AttentionItem[] = [];

  constructor(private readonly options: AttentionBookOptions) {}

  /** Newest first. */
  list(): AttentionItem[] {
    return [...this.items.values()].sort((a, b) => b.at - a.at);
  }

  visible(threadId: string): boolean {
    for (const client of this.clients.values()) if (client.focused && client.threadId === threadId) return true;
    return false;
  }

  /** A thread finished, failed or asked something. */
  raise(news: Omit<AttentionItem, "at">): AttentionChange {
    if (this.visible(news.threadId)) return { changed: false };
    const now = this.options.now();
    const item: AttentionItem = { ...news, at: now };
    this.items.set(item.threadId, item);
    const last = this.notifiedAt.get(item.threadId);
    if (last !== undefined && now - last < this.options.debounceMs) return { changed: true };
    this.notifiedAt.set(item.threadId, now);
    const target = this.target();
    if (!target) {
      this.held = [...this.held.filter((entry) => entry.threadId !== item.threadId), item];
      return { changed: true };
    }
    return { changed: true, delivery: { clientKey: target, items: [item] } };
  }

  /** A client says what it shows; the thread it has on screen with focus is seen. */
  report(clientKey: string, presence: { focused: boolean; threadId?: string }): AttentionChange {
    const now = this.options.now();
    const prior = this.clients.get(clientKey);
    const focusedAt = presence.focused ? (prior?.focused ? prior.focusedAt : now) : (prior?.focusedAt ?? 0);
    this.clients.set(clientKey, { focused: presence.focused, ...(presence.threadId ? { threadId: presence.threadId } : {}), focusedAt, reportedAt: now });
    const changed = presence.focused && presence.threadId !== undefined && this.items.delete(presence.threadId);
    // What waited and is still unseen goes to whoever turned up first.
    const waiting = this.held.filter((entry) => this.items.get(entry.threadId) === entry);
    this.held = [];
    return { changed, ...(waiting.length ? { delivery: { clientKey, items: waiting.reverse() } } : {}) };
  }

  leave(clientKey: string): void {
    this.clients.delete(clientKey);
  }

  /** Nobody's presence can be trusted any more; the clients that are left report again. */
  forgetClients(): void {
    this.clients.clear();
  }

  /** The thread is gone for good. */
  drop(threadId: string): AttentionChange {
    this.notifiedAt.delete(threadId);
    this.held = this.held.filter((entry) => entry.threadId !== threadId);
    return { changed: this.items.delete(threadId) };
  }

  /** The client that had focus last, else the one heard from last. */
  private target(): string | undefined {
    let best: [string, Presence] | undefined;
    for (const entry of this.clients) {
      const [, client] = entry;
      if (!best || client.focusedAt > best[1].focusedAt || (client.focusedAt === best[1].focusedAt && client.reportedAt > best[1].reportedAt)) best = entry;
    }
    return best?.[0];
  }
}
