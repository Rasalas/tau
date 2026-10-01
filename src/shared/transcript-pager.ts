import type { UiMessage } from "./contracts.js";
import { numberWindowTurns } from "./message-turns.js";
import type { HostTranscriptCursor } from "./transcript-cursor.js";
import type { ThreadTranscriptPage, TranscriptPageBundle } from "./transcript-contract.js";

/** The number of user turns needed for the first useful transcript paint. */
export const INITIAL_TRANSCRIPT_TURN_LIMIT = 10 as const;

/** The number of older user turns returned by one explicit history action. */
export const OLDER_TRANSCRIPT_TURN_LIMIT = 20 as const;

export interface TranscriptCursorPolicy<TCursor extends string = HostTranscriptCursor> {
  cursorAtIndex: (index: number) => TCursor;
  indexFromCursor: (cursor: TCursor, maximum: number) => number;
}

export interface TranscriptPageBounds<TCursor extends string = HostTranscriptCursor> {
  start: number;
  end: number;
  olderCursor?: TCursor;
  hasMore: boolean;
}

/** Resolve a bounded page over any transcript records that expose a user role. */
export function transcriptPageBounds<TCursor extends string = HostTranscriptCursor>(
  messages: readonly { role?: string }[],
  turnLimit: number = INITIAL_TRANSCRIPT_TURN_LIMIT,
  cursor?: TCursor,
  policy?: TranscriptCursorPolicy<TCursor>,
): TranscriptPageBounds<TCursor> {
  if (!Number.isInteger(turnLimit) || turnLimit < 1) throw new Error("turnLimit must be positive");
  if (cursor !== undefined && !policy) throw new Error("A transcript cursor policy is required to read a cursor");
  const end = cursor === undefined
    ? messages.length
    : policy!.indexFromCursor(cursor, messages.length);
  if (end <= 0) return { start: 0, end, hasMore: false };
  const firstUser = messages.findIndex((message, index) => index < end && message.role === "user");
  // Records before the first user turn are orphan activities. They cannot be
  // rendered as a complete turn and must not make an activity-only branch
  // appear pageable forever.
  if (firstUser < 0) return { start: end, end, hasMore: false };
  let start = end;
  let turns = 0;
  while (start > 0 && turns < turnLimit) {
    start -= 1;
    if (messages[start]?.role === "user") turns += 1;
  }
  if (turns < turnLimit && start < firstUser) start = firstUser;
  const hasOlderTurn = messages.slice(0, start).some((message) => message.role === "user");
  return {
    start,
    end,
    ...(hasOlderTurn && policy ? { olderCursor: policy.cursorAtIndex(start) } : {}),
    hasMore: hasOlderTurn,
  };
}

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
export class TranscriptPager<TCursor extends string = HostTranscriptCursor> {
  private readonly messages: UiMessage[];
  constructor(
    messages: readonly UiMessage[],
    private readonly turnLimit: number = INITIAL_TRANSCRIPT_TURN_LIMIT,
    private readonly policy?: TranscriptCursorPolicy<TCursor>,
  ) {
    if (!Number.isInteger(turnLimit) || turnLimit < 1) throw new Error("turnLimit must be positive");
    this.messages = [...messages];
  }

  page(cursor?: TCursor): TranscriptPageBundle<UiMessage, TCursor> {
    const bounds = transcriptPageBounds(this.messages, this.turnLimit, cursor, this.policy);
    // A page always starts at a user message and includes every record after it
    // up to the cursor. This avoids splitting a visible conversation turn while
    // retaining notices and other records adjacent to that turn.
    return {
      messages: numberWindowTurns(this.messages, bounds.start, bounds.end),
      transcriptWindow: "bounded",
      ...(bounds.olderCursor ? { olderCursor: bounds.olderCursor } : {}),
      hasMore: bounds.hasMore,
      historyCompleteness: bounds.hasMore ? "has-more" : "complete",
    };
  }

  static pageFor<TCursor extends string = HostTranscriptCursor>(
    sessionId: string,
    messages: readonly UiMessage[],
    turnLimit: number = INITIAL_TRANSCRIPT_TURN_LIMIT,
    cursor?: TCursor,
    policy?: TranscriptCursorPolicy<TCursor>,
  ): ThreadTranscriptPage<UiMessage, TCursor> {
    const page = new TranscriptPager<TCursor>(messages, turnLimit, policy).page(cursor);
    return { ...page, sessionId };
  }
}

export function countUserTurns(messages: readonly UiMessage[]): number {
  return messages.reduce((count, message) => count + (message.role === "user" ? 1 : 0), 0);
}
