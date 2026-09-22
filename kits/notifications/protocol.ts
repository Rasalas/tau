// Shared by both halves; no imports, so either side may read it.

export const NOTIFICATIONS_EXTENSION_ID = "tau.notifications";

/** Pushed with the whole list whenever it changes; every client's badge follows it. */
export const ATTENTION_EVENT = "attention";
/** Pushed for one client, named by `clientKey`: it is the one that shows the notification. */
export const NOTIFY_EVENT = "notify";
/** A client left; the others say again what they show, so the host knows who is still looking. */
export const PRESENCE_REQUEST_EVENT = "presence-request";

export type AttentionReason = "completed" | "failed" | "question";

/** A thread whose news nobody has seen yet. */
export interface AttentionItem {
  threadId: string;
  reason: AttentionReason;
  /** Epoch ms of the news. */
  at: number;
  /** The thread's title as the host knows it. */
  title?: string;
  /** Its session file, for a client whose thread index has not listed it yet. */
  path?: string;
}

export interface AttentionState {
  items: AttentionItem[];
}

/** What one client shows: whether its window has focus and which thread is on screen. */
export interface PresenceInput {
  /** A key the client made up for itself when its kit activated. */
  clientKey: string;
  focused: boolean;
  threadId?: string;
}

/** News for one client to show. */
export interface Delivery {
  clientKey: string;
  items: AttentionItem[];
}

/** `presence` answers with the list and, the first time a client reports, what waited for one. */
export interface PresenceReply extends AttentionState {
  delivery?: Delivery;
}

export function decodeAttentionItems(value: unknown): AttentionItem[] {
  const items = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is AttentionItem =>
    typeof item === "object" && item !== null
    && typeof (item as AttentionItem).threadId === "string"
    && ["completed", "failed", "question"].includes((item as AttentionItem).reason)
    && typeof (item as AttentionItem).at === "number");
}

export function decodeDelivery(value: unknown): Delivery | undefined {
  const clientKey = (value as { clientKey?: unknown } | null)?.clientKey;
  if (typeof clientKey !== "string") return undefined;
  const items = decodeAttentionItems(value);
  return items.length ? { clientKey, items } : undefined;
}
