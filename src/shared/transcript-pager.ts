import type { UiMessage } from "./contracts.js";
import type { TranscriptPage } from "./host-protocol.js";

/** The number of user turns needed for the first useful transcript paint. */
export const INITIAL_TRANSCRIPT_TURN_LIMIT = 10 as const;

/** The number of older user turns returned by one explicit history action. */
export const OLDER_TRANSCRIPT_TURN_LIMIT = 20 as const;

/** Pages the message stream by user turns while retaining message boundaries. */
export class TranscriptPager {
  private readonly messages: UiMessage[];
  constructor(messages: readonly UiMessage[], private readonly turnLimit: number = INITIAL_TRANSCRIPT_TURN_LIMIT) {
    if (!Number.isInteger(turnLimit) || turnLimit < 1) throw new Error("turnLimit must be positive");
    this.messages = [...messages];
  }

  page(cursor?: string): TranscriptPage {
    const end = cursor === undefined ? this.messages.length : this.parseCursor(cursor);
    if (end <= 0) return { sessionId: "", messages: [], hasMore: false };
    let start = end;
    let turns = 0;
    while (start > 0 && turns < this.turnLimit) {
      start -= 1;
      if (this.messages[start]?.role === "user") turns += 1;
    }
    // A page always starts at a user message and includes every record after it
    // up to the cursor. This avoids splitting a visible conversation turn while
    // retaining notices and other records adjacent to that turn.
    const pageStart = start;
    return {
      sessionId: "",
      messages: this.messages.slice(pageStart, end),
      ...(pageStart > 0 ? { olderCursor: String(pageStart) } : {}),
      hasMore: pageStart > 0,
    };
  }

  static pageFor(sessionId: string, messages: readonly UiMessage[], turnLimit: number = INITIAL_TRANSCRIPT_TURN_LIMIT, cursor?: string): TranscriptPage {
    const page = new TranscriptPager(messages, turnLimit).page(cursor);
    return { ...page, sessionId };
  }

  private parseCursor(cursor: string): number {
    if (!/^\d+$/u.test(cursor)) throw new Error("Invalid transcript cursor");
    const value = Number(cursor);
    if (!Number.isSafeInteger(value) || value < 0 || value > this.messages.length) throw new Error("Invalid transcript cursor");
    return value;
  }
}

export function countUserTurns(messages: readonly UiMessage[]): number {
  return messages.reduce((count, message) => count + (message.role === "user" ? 1 : 0), 0);
}
