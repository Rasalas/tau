import { buildSessionContext, estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UiCompaction, UiMessage } from "../shared/contracts.js";

/** The role of the transcript record a Pi compaction entry becomes; `mapMessage` turns it into a divider. */
export const COMPACTION_RECORD_ROLE = "tauCompaction";

interface BranchEntry {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  summary?: unknown;
  tokensBefore?: unknown;
  firstKeptEntryId?: unknown;
  message?: { role?: unknown };
}

/** Entries are the runtime's own objects, so one branch read works each compaction out once. */
const measured = new WeakMap<object, UiCompaction>();

function userTurnsBefore(entries: readonly BranchEntry[], end: number): number {
  let count = 0;
  for (let index = 0; index < end; index += 1) {
    if (entries[index]?.type === "message" && entries[index]?.message?.role === "user") count += 1;
  }
  return count;
}

function indexOfEntry(entries: readonly BranchEntry[], id: unknown, fallback: number): number {
  const at = typeof id === "string" ? entries.findIndex((entry) => entry?.id === id) : -1;
  return at < 0 ? fallback : at;
}

/**
 * What the compaction at `index` did: the turns its summary replaced (those
 * the previous compaction had not), the size Pi measured before, and an
 * estimate of the context it left, which Pi only measures on the next reply.
 */
export function compactionFacts(entries: readonly unknown[], index: number): UiCompaction {
  const branch = entries as readonly BranchEntry[];
  const entry = branch[index]!;
  const known = measured.get(entry);
  if (known) return known;
  let previous = -1;
  for (let at = index - 1; at >= 0; at -= 1) if (branch[at]?.type === "compaction") { previous = at; break; }
  const start = previous < 0 ? 0 : indexOfEntry(branch, branch[previous]!.firstKeptEntryId, previous + 1);
  const kept = indexOfEntry(branch, entry.firstKeptEntryId, index);
  const first = userTurnsBefore(branch, start) + 1;
  const last = userTurnsBefore(branch, kept);
  let tokensAfter: number | undefined;
  try {
    const context = buildSessionContext(entries as SessionEntry[], typeof entry.id === "string" ? entry.id : null);
    tokensAfter = context.messages.reduce((total, message) => total + estimateTokens(message), 0);
  } catch {
    tokensAfter = undefined;
  }
  const facts: UiCompaction = {
    ...(typeof entry.tokensBefore === "number" && entry.tokensBefore > 0 ? { tokensBefore: entry.tokensBefore } : {}),
    ...(tokensAfter ? { tokensAfter } : {}),
    ...(last >= first ? { turns: { first, last } } : {}),
    ...(typeof entry.summary === "string" && entry.summary.trim() ? { summary: entry.summary } : {}),
  };
  measured.set(entry, facts);
  return facts;
}

/** The record `branchRecords` puts where a compaction entry sits on the branch. */
export function compactionRecord(entries: readonly unknown[], index: number): Record<string, unknown> {
  const entry = entries[index] as BranchEntry;
  const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  return {
    role: COMPACTION_RECORD_ROLE,
    tauEntryId: entry.id,
    ...(Number.isFinite(timestamp) ? { timestamp } : {}),
    compaction: compactionFacts(entries, index),
  };
}

/** The divider row of a compaction record. */
export function compactionMessage(record: { tauEntryId?: string; timestamp?: number; compaction?: UiCompaction }, index: number): UiMessage {
  return {
    id: record.tauEntryId ?? `compaction-${record.timestamp ?? index}-${index}`,
    sourceEntryId: record.tauEntryId,
    role: "notice",
    text: "Context compacted",
    timestamp: record.timestamp ?? Date.now(),
    compaction: { ...record.compaction },
  };
}
