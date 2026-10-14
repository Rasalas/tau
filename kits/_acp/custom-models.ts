import type { AcpStoredModel } from "./session-store.js";

/** Only explicit, nonempty IDs from the kit's settings grant an exception. */
export function customModelIds(value: unknown): string[] {
  return typeof value === "string" ? [...new Set(value.split(/\r?\n/u).map((id) => id.trim()).filter(Boolean))] : [];
}

export function withCustomModels(models: readonly AcpStoredModel[], ids: readonly string[]): AcpStoredModel[] {
  const result = [...models];
  const seen = new Set(models.map((model) => model.id));
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ id, name: id, efforts: [] });
  }
  return result;
}
