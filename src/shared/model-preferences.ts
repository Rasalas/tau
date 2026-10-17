import type { TauModelPreferences, UiModel } from "./contracts.js";

const MAX_KEYS = 2_000;

function keyList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_KEYS) return undefined;
  return value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 300) ? [...value as string[]] : undefined;
}

// eslint-disable-next-line no-control-regex -- Display labels are single-line plain text.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export function readModelName(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 120 && !CONTROL_CHARACTER.test(value) ? value.trim() || undefined : undefined;
}

function nameRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_KEYS) return undefined;
  const names: Record<string, string> = {};
  for (const [key, entry] of entries) {
    const name = readModelName(entry);
    if (!key.length || key.length > 300 || !name) return undefined;
    names[key] = name;
  }
  return names;
}

/** One runtime's entry of `modelPreferences`, or undefined when it is not one. */
export function readModelPreferences(value: unknown): TauModelPreferences | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const hidden = raw.hidden === undefined ? [] : keyList(raw.hidden);
  const order = raw.order === undefined ? [] : keyList(raw.order);
  if (!hidden || !order) return undefined;
  const names = raw.names === undefined ? {} : nameRecord(raw.names);
  if (!names) return undefined;
  return { ...(hidden.length ? { hidden } : {}), ...(order.length ? { order } : {}), ...(Object.keys(names).length ? { names } : {}) };
}

/** A model's durable key within one runtime. */
export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** The user's label for one runtime's offering, falling back to its catalog name. */
export function modelDisplayName(model: Pick<UiModel, "provider" | "id" | "name">, preferences?: TauModelPreferences): string {
  return preferences?.names?.[modelKey(model)] ?? model.name;
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
