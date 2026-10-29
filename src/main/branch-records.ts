import { branchMessagesWithClientMessageIds } from "../shared/client-message-correlation.js";
import { compactionRecord } from "./compaction-record.js";

/** One message entry of a branch, in the shape the transcript maps. */
export interface BranchRecord {
  record: Record<string, unknown>;
  /** The runtime's own message object; the key the client-turn ledger correlates on. */
  raw?: object;
}

/**
 * Projects the message entries of a branch, resolving each user turn's client
 * message id from the markers beside it. A live thread reads its runtime's
 * journal and a released one its session file, and both arrive here.
 */
export function branchRecords(entries: readonly unknown[], skillNames: Iterable<string>): BranchRecord[] {
  const messages = branchMessagesWithClientMessageIds(entries, skillNames);
  let messageIndex = 0;
  return entries.flatMap((entry, index) => {
    const typed = entry as { type?: unknown; id?: unknown; message?: unknown };
    if (typed.type === "compaction") return [{ record: compactionRecord(entries, index) }];
    if (typed.type !== "message") return [];
    const projected = messages[messageIndex++] as Record<string, unknown>;
    const raw = typed.message && typeof typed.message === "object" ? typed.message as object : undefined;
    return [{ record: { ...projected, tauEntryId: typed.id }, ...(raw ? { raw } : {}) }];
  });
}
