import type { UiMessage } from "./contracts.js";
import { localTranscriptCursorAt, parseLocalTranscriptCursor, type LocalTranscriptCursor, type RawBridgeTranscriptCursor } from "./transcript-cursor.js";
import type { ThreadTranscriptPage, TranscriptPageBundle } from "./transcript-contract.js";

/** The number of user turns needed for the first useful transcript paint. */
export const INITIAL_TRANSCRIPT_TURN_LIMIT = 10 as const;

/** The number of older user turns returned by one explicit history action. */
export const OLDER_TRANSCRIPT_TURN_LIMIT = 20 as const;

export interface TranscriptPageBounds {
  start: number;
  end: number;
  olderCursor?: LocalTranscriptCursor;
  hasMore: boolean;
}

/** Resolve a bounded page over any transcript records that expose a user role. */
export function transcriptPageBounds(
  messages: readonly { role?: string }[],
  turnLimit: number = INITIAL_TRANSCRIPT_TURN_LIMIT,
  cursor?: string | LocalTranscriptCursor | RawBridgeTranscriptCursor,
): TranscriptPageBounds {
  if (!Number.isInteger(turnLimit) || turnLimit < 1) throw new Error("turnLimit must be positive");
  const end = cursor === undefined ? messages.length : Number(parseLocalTranscriptCursor(cursor, messages.length));
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
    ...(hasOlderTurn ? { olderCursor: localTranscriptCursorAt(start) } : {}),
    hasMore: hasOlderTurn,
  };
}

/** Pages the message stream by user turns while retaining message boundaries. */
export class TranscriptPager {
  private readonly messages: UiMessage[];
  constructor(messages: readonly UiMessage[], private readonly turnLimit: number = INITIAL_TRANSCRIPT_TURN_LIMIT) {
    if (!Number.isInteger(turnLimit) || turnLimit < 1) throw new Error("turnLimit must be positive");
    this.messages = [...messages];
  }

  page(cursor?: string | LocalTranscriptCursor | RawBridgeTranscriptCursor): TranscriptPageBundle<UiMessage, number[], LocalTranscriptCursor> {
    const bounds = transcriptPageBounds(this.messages, this.turnLimit, cursor === undefined
      ? undefined
      : parseLocalTranscriptCursor(cursor, this.messages.length));
    // A page always starts at a user message and includes every record after it
    // up to the cursor. This avoids splitting a visible conversation turn while
    // retaining notices and other records adjacent to that turn.
    return {
      messages: this.messages.slice(bounds.start, bounds.end),
      ...(bounds.olderCursor ? { olderCursor: bounds.olderCursor } : {}),
      hasMore: bounds.hasMore,
      historyCompleteness: bounds.hasMore ? "has-more" : "complete",
    };
  }

  static pageFor(sessionId: string, messages: readonly UiMessage[], turnLimit: number = INITIAL_TRANSCRIPT_TURN_LIMIT, cursor?: string | LocalTranscriptCursor | RawBridgeTranscriptCursor): ThreadTranscriptPage<UiMessage, number[], LocalTranscriptCursor> {
    const page = new TranscriptPager(messages, turnLimit).page(cursor);
    return { ...page, sessionId };
  }

}

export function countUserTurns(messages: readonly UiMessage[]): number {
  return messages.reduce((count, message) => count + (message.role === "user" ? 1 : 0), 0);
}
