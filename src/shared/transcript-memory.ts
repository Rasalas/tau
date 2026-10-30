/**
 * Conservative retained-data weight, in bytes: UTF-16 strings, numeric slots,
 * array slots and object keys. This is a budget, not a JS heap measurement.
 * Transcript records are acyclic JSON values.
 */
export function transcriptRetainedBytes(value: unknown): number {
  if (typeof value === "string") return value.length * 2;
  if (value === undefined || value === null) return 8;
  if (typeof value !== "object") return 8;
  if (Array.isArray(value)) return 24 + value.reduce((sum, entry) => sum + 8 + transcriptRetainedBytes(entry), 0);
  return 32 + Object.entries(value).reduce((sum, [key, entry]) => sum + 16 + key.length * 2 + transcriptRetainedBytes(entry), 0);
}
