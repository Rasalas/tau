import type { WebhookFilter } from "./protocol.js";
import { validWebhookPath, webhookField, WEBHOOK_PATH_PROBLEM } from "./webhook-path.js";

export const MAX_WEBHOOK_FILTER_VISITS = 32_768;

export const MAX_WEBHOOK_FILTERS = 16;
export const MAX_WEBHOOK_FILTER_PATH = 256;
export const MAX_WEBHOOK_FILTER_VALUE = 1024;

/** Shared by the host decoder and editor; no executable expressions or implicit type conversions. */
export function decodeWebhookFilters(input: unknown): WebhookFilter[] {
  if (!Array.isArray(input) || input.length > MAX_WEBHOOK_FILTERS) throw new Error(`Use at most ${MAX_WEBHOOK_FILTERS} webhook filters.`);
  return Array.from(input, (entry: unknown): WebhookFilter => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid webhook filter.");
    const rule = entry as Record<string, unknown>;
    const { path, op, value } = rule;
    if (!validWebhookPath(path)) throw new Error(WEBHOOK_PATH_PROBLEM);
    if (op !== "equals" && op !== "exists") throw new Error("Webhook conditions must be equals or exists.");
    if (Object.keys(rule).some((key) => !(op === "exists" ? ["path", "op"] : ["path", "op", "value"]).includes(key))) throw new Error("Invalid webhook filter fields.");
    if (op === "exists") return { path, op };
    if (value !== null && typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") throw new Error("Webhook equality needs a string, number, boolean or null value.");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Webhook equality needs a finite number.");
    if (typeof value === "string" && (value.length > MAX_WEBHOOK_FILTER_VALUE || value.includes("\0"))) throw new Error(`Webhook values must be at most ${MAX_WEBHOOK_FILTER_VALUE} characters without null characters.`);
    return { path, op, value };
  });
}

/**
 * Wildcards produce candidates: equals needs one strictly equal scalar; exists
 * needs one resolved own field, including null/false/empty objects and arrays.
 * Empty arrays, missing suffix fields and non-arrays produce no candidates.
 * A shared visit budget fails the whole filter set closed when exhausted.
 */
export function matchesWebhookFilters(filters: readonly WebhookFilter[], payload: unknown): boolean {
  let visits = 0;
  let exceeded = false;
  const matches = (filter: WebhookFilter): boolean => {
    const segments = filter.path.split(".");
    const walk = (value: unknown, at: number): boolean => {
      if (++visits > MAX_WEBHOOK_FILTER_VISITS) { exceeded = true; return false; }
      if (at === segments.length) return filter.op === "exists" ? value !== undefined : value === filter.value;
      const segment = segments[at]!;
      if (!segment.endsWith("[]")) return walk(webhookField(value, segment), at + 1);
      const array = webhookField(value, segment.slice(0, -2));
      if (!Array.isArray(array)) return false;
      for (const item of array) {
        if (walk(item, at + 1)) return true;
        if (exceeded) return false;
      }
      return false;
    };
    return walk(payload, 0);
  };
  return filters.every(matches) && !exceeded;
}
