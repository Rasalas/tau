import type { TauModelPreferences } from "./contracts.js";

const MAX_KEYS = 2_000;

function keyList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_KEYS) return undefined;
  return value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 300) ? [...value as string[]] : undefined;
}

/** One runtime's entry of `modelPreferences`, or undefined when it is not one. */
export function readModelPreferences(value: unknown): TauModelPreferences | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const hidden = raw.hidden === undefined ? [] : keyList(raw.hidden);
  const order = raw.order === undefined ? [] : keyList(raw.order);
  if (!hidden || !order) return undefined;
  return { ...(hidden.length ? { hidden } : {}), ...(order.length ? { order } : {}) };
}

/** Every valid runtime entry of a `modelPreferences` record; the rest is dropped. */
export function readModelPreferenceRecord(value: unknown): Record<string, TauModelPreferences> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, TauModelPreferences> = {};
  for (const [runtime, entry] of Object.entries(value as Record<string, unknown>)) {
    const read = readModelPreferences(entry);
    if (read) result[runtime] = read;
  }
  return result;
}
