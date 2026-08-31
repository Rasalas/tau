import type { UiMessage } from "./contracts.js";
import type { TranscriptPage } from "./host-protocol.js";

export interface BoundedTranscriptPage<T> {
  messages: T[];
  olderCursor?: string;
  hasMore: boolean;
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
): BoundedTranscriptPage<T> {
  if (!Number.isInteger(turnLimit) || turnLimit < 1) throw new Error("turnLimit must be positive");
  const end = cursor === undefined ? records.length : Number.parseInt(cursor, 10);
  if (!Number.isInteger(end) || end < 0 || end > records.length) throw new Error("Invalid transcript cursor");
  if (end <= 0) return { messages: [], hasMore: false };
  let start = end;
  let turns = 0;
  while (start > 0 && turns < turnLimit) {
    start -= 1;
    if (isUser(records[start]!)) turns += 1;
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
