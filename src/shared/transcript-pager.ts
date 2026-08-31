import type { UiMessage } from "./contracts.js";
import type { TranscriptPage } from "./host-protocol.js";

export interface BoundedTranscriptPage<T> {
  messages: T[];
  olderCursor?: string;
  hasMore: boolean;
}

export interface RecordPageBounds<T> {
  maxRecords?: number;
  maxBytes?: number;
  measure?(record: T): number;
  /** Number of source records represented by one paged record. */
  count?(record: T): number;
}

/**
 * Pages any Pi record stream by user turns. The bridge uses this same cursor
 * algorithm for raw session records, while the desktop host uses it for the
 * already-normalized renderer messages.
 */
export function pageRecords<T>(
  records: readonly T[],
  turnLimit: number,
  cursor: string | undefined,
  isUser: (record: T) => boolean,
  bounds: RecordPageBounds<T> = {},
): BoundedTranscriptPage<T> {
  if (!Number.isInteger(turnLimit) || turnLimit < 1) throw new Error("turnLimit must be positive");
  const maxRecords = bounds.maxRecords ?? Number.POSITIVE_INFINITY;
  const maxBytes = bounds.maxBytes ?? Number.POSITIVE_INFINITY;
  if (maxRecords !== Number.POSITIVE_INFINITY
    && (!Number.isSafeInteger(maxRecords) || maxRecords < 1)) throw new Error("maxRecords must be positive");
  if (maxBytes !== Number.POSITIVE_INFINITY
    && (!Number.isFinite(maxBytes) || maxBytes < 1)) throw new Error("maxBytes must be positive");
  if (cursor !== undefined && !/^\d+$/u.test(cursor)) throw new Error("Invalid transcript cursor");
  const end = cursor === undefined ? records.length : Number(cursor);
  if (!Number.isSafeInteger(end) || end < 0 || end > records.length) throw new Error("Invalid transcript cursor");
  if (end <= 0) return { messages: [], hasMore: false };
  let start = end;
  let turns = 0;
  let recordCount = 0;
  let bytes = 0;
  while (start > 0 && turns < turnLimit) {
    const candidate = records[start - 1]!;
    const candidateBytes = Math.max(0, bounds.measure?.(candidate) ?? 0);
    const candidateCount = Math.max(1, bounds.count?.(candidate) ?? 1);
    if (recordCount >= maxRecords || (recordCount > 0 && recordCount + candidateCount > maxRecords)
      || (recordCount > 0 && bytes + candidateBytes > maxBytes)) break;
    start -= 1;
    recordCount += candidateCount;
    bytes += candidateBytes;
    if (isUser(candidate)) turns += 1;
  }
  return {
    messages: records.slice(start, end),
    ...(start > 0 ? { olderCursor: String(start) } : {}),
    hasMore: start > 0,
  };
}

/** Pages the message stream by user turns while retaining message boundaries. */
export class TranscriptPager {
  private readonly messages: UiMessage[];
  constructor(messages: readonly UiMessage[], private readonly turnLimit = 40) {
    if (!Number.isInteger(turnLimit) || turnLimit < 1) throw new Error("turnLimit must be positive");
    this.messages = [...messages];
  }

  page(cursor?: string): TranscriptPage {
    const page = pageRecords(this.messages, this.turnLimit, cursor, (message) => message.role === "user");
    return {
      sessionId: "",
      ...page,
    };
  }

  static pageFor(sessionId: string, messages: readonly UiMessage[], turnLimit: number, cursor?: string): TranscriptPage {
    const page = new TranscriptPager(messages, turnLimit).page(cursor);
    return { ...page, sessionId };
  }
}
