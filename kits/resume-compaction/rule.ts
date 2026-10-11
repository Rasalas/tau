import type { UiContextUsage } from "tau";

/** A context this large, idle past its prompt cache's lifetime, is written to the cache anew. */
export const RESUME_COMPACTION_TOKENS = 100_000;

/** The cache's lifetime plus a margin for clocks and the last write: a sixth of it, one to ten minutes. */
export function coldAfterMs(promptCacheTtlMs: number): number {
  return promptCacheTtlMs + Math.min(10 * 60_000, Math.max(60_000, promptCacheTtlMs / 6));
}

/**
 * Whether to compact before the next prompt. Only a runtime that names
 * its prompt cache and dates its context takes part; the rest never see it.
 */
export function offersResumeCompaction(usage: UiContextUsage | undefined, now: number): boolean {
  if (!usage || usage.promptCacheTtlMs === undefined || usage.updatedAt === undefined) return false;
  return usage.tokens >= RESUME_COMPACTION_TOKENS && now - usage.updatedAt >= coldAfterMs(usage.promptCacheTtlMs);
}

/** When the offer becomes due, for a context large enough; undefined when it never will. */
export function offerDueAt(usage: UiContextUsage | undefined): number | undefined {
  if (!usage || usage.promptCacheTtlMs === undefined || usage.updatedAt === undefined || usage.tokens < RESUME_COMPACTION_TOKENS) return undefined;
  return usage.updatedAt + coldAfterMs(usage.promptCacheTtlMs);
}

/** A context's size as "153k". */
export function formatContextTokens(tokens: number): string {
  if (tokens < 1_000) return `${Math.round(tokens)}`;
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
}

/** A stored list of strings; anything else reads as empty. */
export function readList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
