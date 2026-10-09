import type { AttentionItem, Delivery } from "./protocol.js";

interface Presence {
  focused: boolean;
  threadId?: string;
  idle?: boolean;
  /** When this client last gained focus; 0 when it never had it. */
  focusedAt: number;
  reportedAt: number;
  /** Host time of the user's last key, click or touch there, from a client that tells it. */
  usedAt: number;
  /** An older client says nothing of its use: its focus alone tells. */
  tellsUse: boolean;
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
    return this.viewer(threadId) !== undefined;
  }

  /** A client whose window has focus and shows the thread. */
  private viewer(threadId: string): string | undefined {
    for (const [key, client] of this.clients) if (client.focused && client.threadId === threadId) return key;
    return undefined;
  }

  /**
   * A thread finished, failed or asked something. A focused client showing it
   * has seen it, so the list stays as it is; that client still hears of it,
   * marked `seen`, in case its user asked to be told anyway.
   */
  raise(news: Omit<AttentionItem, "at">): AttentionChange {
    const now = this.options.now();
    const item: AttentionItem = { ...news, at: now };
    const viewer = this.viewer(item.threadId);
    if (!viewer) this.items.set(item.threadId, item);
    const last = this.notifiedAt.get(item.threadId);
    if (last !== undefined && now - last < this.options.debounceMs) return { changed: !viewer };
    this.notifiedAt.set(item.threadId, now);
    if (viewer) return { changed: false, delivery: { clientKey: viewer, items: [item], seen: true } };
    const target = this.target();
    if (!target) {
      this.held = [...this.held.filter((entry) => entry.threadId !== item.threadId), item];
      return { changed: true };
    }
    return { changed: true, delivery: { clientKey: target, items: [item] } };
  }

  /** A client says what it shows; the thread it has on screen with focus is seen. */
  report(clientKey: string, presence: { focused: boolean; threadId?: string; idle?: boolean; usedAgoMs?: number }): AttentionChange {
    const now = this.options.now();
    const prior = this.clients.get(clientKey);
    const focusedAt = presence.focused ? (prior?.focused ? prior.focusedAt : now) : (prior?.focusedAt ?? 0);
    const tellsUse = presence.usedAgoMs !== undefined;
    const usedAt = tellsUse ? now - Math.max(0, presence.usedAgoMs!) : 0;
    this.clients.set(clientKey, {
      focused: presence.focused,
      ...(presence.threadId ? { threadId: presence.threadId } : {}),
      ...(presence.idle ? { idle: true } : {}),
      focusedAt,
      reportedAt: now,
      usedAt,
      tellsUse,
    });
    const changed = presence.focused && presence.threadId !== undefined && this.items.delete(presence.threadId);
    // What waited and is still unseen goes to whoever turned up first.
    const waiting = this.held.filter((entry) => this.items.get(entry.threadId) === entry);
    this.held = [];
    return { changed, ...(waiting.length ? { delivery: { clientKey, items: waiting.reverse() } } : {}) };
  }

  /**
   * How long until nobody counts as at a client: someone used one within
   * `awayAfterMs`, focused or not, as Discord holds a phone back while its
   * desktop is in use. 0 when the user is away; undefined while an older
   * client's focus says someone is there for as long as it lasts.
   */
  awayIn(awayAfterMs: number): number | undefined {
    const now = this.options.now();
    let left = 0;
    for (const client of this.clients.values()) {
      if (!client.tellsUse) {
        if (client.focused && !client.idle) return undefined;
        continue;
      }
      left = Math.max(left, client.usedAt + awayAfterMs - now);
    }
    return left;
  }

  /** Someone is at a client, so news reaches them there and a phone need not buzz. */
  attended(awayAfterMs: number): boolean {
    return this.awayIn(awayAfterMs) !== 0;
  }

  /** The thread's news is still unseen: no focused client showed it, and its question waits. */
  unseen(threadId: string): boolean {
    return this.items.has(threadId);
  }

  leave(clientKey: string): void {
    this.clients.delete(clientKey);
  }

  /** Nobody's presence can be trusted any more; the clients that are left report again. */
  forgetClients(): void {
    this.clients.clear();
  }

  /** The thread's questions were answered, wherever: it no longer waits on anyone. */
  answered(threadId: string): AttentionChange {
    const item = this.items.get(threadId);
    if (!item || (item.reason !== "question" && item.reason !== "approval")) return { changed: false };
    this.items.delete(threadId);
    this.held = this.held.filter((entry) => entry !== item);
    return { changed: true };
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
