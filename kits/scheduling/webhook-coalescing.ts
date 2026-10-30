import type { WebhookCoalescing } from "./protocol.js";
import { validWebhookPath } from "./webhook-path.js";

export const DEFAULT_WEBHOOK_WAIT_SECONDS = 120;
export const MIN_WEBHOOK_WAIT_SECONDS = 10;
export const MAX_WEBHOOK_WAIT_SECONDS = 3600;

/** undefined preserves older clients; null explicitly turns combining off. */
export function decodeWebhookCoalescing(input: unknown): WebhookCoalescing | null {
  if (input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid webhook bursts configuration.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["keyPath", "waitSeconds"].includes(key)) || !validWebhookPath(value.keyPath, false)) throw new Error("Key path must use dot-separated names or array indices, without [].");
  if (typeof value.waitSeconds !== "number" || !Number.isInteger(value.waitSeconds) || value.waitSeconds < MIN_WEBHOOK_WAIT_SECONDS || value.waitSeconds > MAX_WEBHOOK_WAIT_SECONDS) throw new Error("Webhook wait must be 10 to 3600 whole seconds.");
  return { keyPath: value.keyPath, waitSeconds: value.waitSeconds };
}
