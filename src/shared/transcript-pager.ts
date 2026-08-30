import type { UiMessage } from "./contracts.js";
import type { TranscriptPage } from "./host-protocol.js";

/** Pages the message stream by user turns while retaining message boundaries. */
export class TranscriptPager {
  private readonly messages: UiMessage[];
  constructor(messages: readonly UiMessage[], private readonly turnLimit = 40) {
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
    // A page always includes the complete assistant/tool-adjacent records after
    // its first user message; this avoids splitting a visible conversation turn.
    const pageStart = start === 0 ? 0 : start;
    return {
      sessionId: "",
      messages: this.messages.slice(pageStart, end),
      ...(pageStart > 0 ? { olderCursor: String(pageStart) } : {}),
      hasMore: pageStart > 0,
    };
  }

  static pageFor(sessionId: string, messages: readonly UiMessage[], turnLimit: number, cursor?: string): TranscriptPage {
    const page = new TranscriptPager(messages, turnLimit).page(cursor);
    return { ...page, sessionId };
  }

  private parseCursor(cursor: string): number {
    const value = Number.parseInt(cursor, 10);
    if (!Number.isInteger(value) || value < 0 || value > this.messages.length) throw new Error("Invalid transcript cursor");
    return value;
  }
}
