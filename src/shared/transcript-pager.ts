import type { UiMessage } from "./contracts.js";
import type { TranscriptPage } from "./host-protocol.js";

/** The number of user turns needed for the first useful transcript paint. */
export const INITIAL_TRANSCRIPT_TURN_LIMIT = 10 as const;

/** The number of older user turns returned by one explicit history action. */
export const OLDER_TRANSCRIPT_TURN_LIMIT = 20 as const;

export interface TranscriptPageBounds {
  start: number;
  end: number;
  olderCursor?: string;
  hasMore: boolean;
}

/** Resolve a bounded page over any transcript records that expose a user role. */
export function transcriptPageBounds(
  messages: readonly { role?: string }[],
  turnLimit: number = INITIAL_TRANSCRIPT_TURN_LIMIT,
  cursor?: string,
): TranscriptPageBounds {
  if (!Number.isInteger(turnLimit) || turnLimit < 1) throw new Error("turnLimit must be positive");
  const end = cursor === undefined ? messages.length : parseTranscriptCursor(cursor, messages.length);
  if (end <= 0) return { start: 0, end, hasMore: false };
  let start = end;
  let turns = 0;
  while (start > 0 && turns < turnLimit) {
    start -= 1;
    if (messages[start]?.role === "user") turns += 1;
  }
  return {
    start,
    end,
    ...(start > 0 ? { olderCursor: String(start) } : {}),
    hasMore: start > 0,
  };
}

function parseTranscriptCursor(cursor: string, messageCount: number): number {
  if (!/^\d+$/u.test(cursor)) throw new Error("Invalid transcript cursor");
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0 || value > messageCount) throw new Error("Invalid transcript cursor");
  return value;
}

/** Pages the message stream by user turns while retaining message boundaries. */
export class TranscriptPager {
  private readonly messages: UiMessage[];
  constructor(messages: readonly UiMessage[], private readonly turnLimit: number = INITIAL_TRANSCRIPT_TURN_LIMIT) {
    if (!Number.isInteger(turnLimit) || turnLimit < 1) throw new Error("turnLimit must be positive");
    this.messages = [...messages];
  }

  page(cursor?: string): TranscriptPage {
    const bounds = transcriptPageBounds(this.messages, this.turnLimit, cursor);
    // A page always starts at a user message and includes every record after it
    // up to the cursor. This avoids splitting a visible conversation turn while
    // retaining notices and other records adjacent to that turn.
    return {
      sessionId: "",
      messages: this.messages.slice(bounds.start, bounds.end),
      ...(bounds.olderCursor ? { olderCursor: bounds.olderCursor } : {}),
      hasMore: bounds.hasMore,
    };
  }

  static pageFor(sessionId: string, messages: readonly UiMessage[], turnLimit: number = INITIAL_TRANSCRIPT_TURN_LIMIT, cursor?: string): TranscriptPage {
    const page = new TranscriptPager(messages, turnLimit).page(cursor);
    return { ...page, sessionId };
  }

}

export function countUserTurns(messages: readonly UiMessage[]): number {
  return messages.reduce((count, message) => count + (message.role === "user" ? 1 : 0), 0);
}
