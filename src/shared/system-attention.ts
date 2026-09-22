/**
 * What a client may show the user outside its page: a notification the OS
 * draws and a count on the app's icon. Plain data, because on a desktop window
 * it crosses from the renderer to the window's own process.
 */
export interface SystemNotification {
  title: string;
  body?: string;
  /** One notification per tag: a newer one with the same tag replaces the older. */
  tag?: string;
}

/**
 * How a notification ended for the one who raised it. `clicked` means the
 * client already brought its window forward; `unavailable` that the machine
 * or the user's permission did not let it show.
 */
export type SystemNotificationOutcome = "clicked" | "dismissed" | "unavailable";

const MAX_TITLE = 200;
const MAX_BODY = 1_000;
const MAX_TAG = 200;

function text(method: string, field: string, value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${method}: ${field} must be a non-empty string`);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function decodeSystemNotification(method: string, value: unknown): SystemNotification {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${method}: notification must be an object`);
  const item = value as Record<string, unknown>;
  return {
    title: text(method, "title", item.title, MAX_TITLE),
    ...(item.body === undefined ? {} : { body: text(method, "body", item.body, MAX_BODY) }),
    ...(item.tag === undefined ? {} : { tag: text(method, "tag", item.tag, MAX_TAG) }),
  };
}

export function decodeBadgeCount(method: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${method}: count must be a whole number of zero or more`);
  return value;
}
