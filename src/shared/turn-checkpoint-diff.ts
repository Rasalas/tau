import type { DiffLoadOptions } from "./contracts.js";

/** Shared diff paging normalization for host and bridge Git adapters. */
export function normalizeDiffLoadOptions(
  options: DiffLoadOptions | undefined,
  maxHunks: number,
): Required<DiffLoadOptions> {
  const offset = Number.isFinite(options?.hunkOffset) ? Math.max(0, Math.floor(options?.hunkOffset ?? 0)) : 0;
  const limit = Number.isFinite(options?.hunkLimit)
    ? Math.min(maxHunks, Math.max(1, Math.floor(options?.hunkLimit ?? maxHunks)))
    : maxHunks;
  return { hunkOffset: offset, hunkLimit: limit };
}
