// Shared by both halves; no imports, so either side may read it.

export const NOTIFICATIONS_EXTENSION_ID = "tau.notifications";

/** Pushed with the whole list whenever it changes; every client's badge follows it. */
export const ATTENTION_EVENT = "attention";
/** Pushed for one client, named by `clientKey`: it is the one that shows the notification. */
export const NOTIFY_EVENT = "notify";
/** A client left; the others say again what they show, so the host knows who is still looking. */
export const PRESENCE_REQUEST_EVENT = "presence-request";
/** Host command for other kits (Push): `{ attended }`, whether someone is at a client right now. */
export const ATTENDED_COMMAND = "attended";
/** A focused client without a touch, a key or a click for this long no longer counts as attended. */
export const IDLE_AFTER_MS = 3 * 60_000;

/** `approval` is a question that asks for permission, as the rail's status tells them apart. */
export type AttentionReason = "completed" | "failed" | "question" | "approval";

const APPROVAL_OPTION = /^(?:allow|approve|deny|reject)\b/iu;

/** A yes/no confirmation, or a choice that offers Allow or Deny, asks for permission. */
export function promptReason(prompt: { kind: string; options?: readonly string[] }): "question" | "approval" {
  if (prompt.kind === "confirm") return "approval";
  return prompt.kind === "select" && prompt.options?.some((option) => APPROVAL_OPTION.test(option)) ? "approval" : "question";
}

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
  /** Focused, but nobody used it for `IDLE_AFTER_MS`: the user may have walked away. */
  idle?: boolean;
}

/** News for one client to show. */
export interface Delivery {
  clientKey: string;
  items: AttentionItem[];
  /** The client already shows the thread in a focused window; only an opt-in makes it speak. */
  seen?: boolean;
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
    && ["completed", "failed", "question", "approval"].includes((item as AttentionItem).reason)
    && typeof (item as AttentionItem).at === "number");
}

export function decodeDelivery(value: unknown): Delivery | undefined {
  const clientKey = (value as { clientKey?: unknown } | null)?.clientKey;
  if (typeof clientKey !== "string") return undefined;
  const items = decodeAttentionItems(value);
  const seen = (value as { seen?: unknown }).seen === true;
  return items.length ? { clientKey, items, ...(seen ? { seen } : {}) } : undefined;
}

/** Options `tau.notifications.event-<kind>`: a switch per kind of news, on unless turned off. */
export const eventOption = (kind: AttentionReason) => `event-${kind}`;
/** Option `tau.notifications.quiet` turns quiet hours on; values `quiet-from` and `quiet-to` are "HH:MM" on the host's clock. */
export const QUIET = { on: "quiet", from: "quiet-from", to: "quiet-to", start: "23:00", end: "07:00" } as const;

export interface KitSettings { options: Record<string, boolean | undefined>; values: Record<string, string | undefined> }

const clock = (text: string | undefined, fallback: string) => (text && /^\d\d:\d\d$/u.test(text) ? text : fallback);
export const quietFrom = (values: KitSettings["values"]) => clock(values[QUIET.from], QUIET.start);
export const quietTo = (values: KitSettings["values"]) => clock(values[QUIET.to], QUIET.end);

/** Whether news of this kind stays silent now: its switch is off, or it is quiet hours on the host's clock. */
export function silenced(kind: AttentionReason, settings: KitSettings | undefined, at: Date): boolean {
  if (!settings) return false;
  if (settings.options[eventOption(kind)] === false) return true;
  if (settings.options[QUIET.on] !== true) return false;
  const minutes = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
  const now = at.getHours() * 60 + at.getMinutes();
  const from = minutes(quietFrom(settings.values));
  const to = minutes(quietTo(settings.values));
  return from <= to ? now >= from && now < to : now >= from || now < to;
}
