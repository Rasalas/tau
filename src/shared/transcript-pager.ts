import type { UiMessage } from "./contracts.js";
import {
  localTranscriptCursorAt,
  rawBridgeTranscriptCursorAt,
  transcriptCursorIndex,
  type LocalTranscriptCursor,
  type TranscriptCursor,
} from "./transcript-cursor.js";
import type { ThreadTranscriptPage, TranscriptPageBundle } from "./transcript-contract.js";

/** The number of user turns needed for the first useful transcript paint. */
export const INITIAL_TRANSCRIPT_TURN_LIMIT = 10 as const;

/** The number of older user turns returned by one explicit history action. */
export const OLDER_TRANSCRIPT_TURN_LIMIT = 20 as const;

export interface TranscriptPageBounds<TCursor extends TranscriptCursor = LocalTranscriptCursor> {
  start: number;
  end: number;
  olderCursor?: TCursor;
  hasMore: boolean;
}

function cursorFactory<TCursor extends TranscriptCursor>(
  cursor: string | TCursor | undefined,
  cursorAt?: (index: number) => TCursor,
): (index: number) => TCursor {
  return cursorAt ?? (typeof cursor !== "string" && cursor?.kind === "bridge"
    ? rawBridgeTranscriptCursorAt
    : localTranscriptCursorAt) as (index: number) => TCursor;
}

/** Resolve a bounded page over any transcript records that expose a user role. */
export function transcriptPageBounds<TCursor extends TranscriptCursor = LocalTranscriptCursor>(
  messages: readonly { role?: string }[],
  turnLimit: number = INITIAL_TRANSCRIPT_TURN_LIMIT,
  cursor?: string | TCursor,
  cursorAt?: (index: number) => TCursor,
): TranscriptPageBounds<TCursor> {
  if (!Number.isInteger(turnLimit) || turnLimit < 1) throw new Error("turnLimit must be positive");
  const makeCursor = cursorFactory(cursor, cursorAt);
  const end = cursor === undefined
    ? messages.length
    : transcriptCursorIndex(cursor, messages.length);
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
    ...(hasOlderTurn ? { olderCursor: makeCursor(start) } : {}),
    hasMore: hasOlderTurn,
  };
}

/** Pages the message stream by user turns while retaining message boundaries. */
export class TranscriptPager<TCursor extends TranscriptCursor = LocalTranscriptCursor> {
  private readonly messages: UiMessage[];
  constructor(
    messages: readonly UiMessage[],
    private readonly turnLimit: number = INITIAL_TRANSCRIPT_TURN_LIMIT,
    private readonly cursorAt?: (index: number) => TCursor,
  ) {
    if (!Number.isInteger(turnLimit) || turnLimit < 1) throw new Error("turnLimit must be positive");
    this.messages = [...messages];
  }

  page(cursor?: string | TCursor): TranscriptPageBundle<UiMessage, number[], TCursor> {
    const bounds = transcriptPageBounds(this.messages, this.turnLimit, cursor, cursorFactory(cursor, this.cursorAt));
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

  static pageFor<TCursor extends TranscriptCursor = LocalTranscriptCursor>(
    sessionId: string,
    messages: readonly UiMessage[],
    turnLimit: number = INITIAL_TRANSCRIPT_TURN_LIMIT,
    cursor?: string | TCursor,
    cursorAt?: (index: number) => TCursor,
  ): ThreadTranscriptPage<UiMessage, number[], TCursor> {
    const page = new TranscriptPager<TCursor>(messages, turnLimit, cursorAt).page(cursor);
    return { ...page, sessionId };
  }

}

export function countUserTurns(messages: readonly UiMessage[]): number {
  return messages.reduce((count, message) => count + (message.role === "user" ? 1 : 0), 0);
}
