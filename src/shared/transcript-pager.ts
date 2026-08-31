import type { UiMessage } from "./contracts.js";
import type { HostTranscriptCursor } from "./transcript-cursor.js";
import type { ThreadTranscriptPage, TranscriptPageBundle } from "./transcript-contract.js";

/** The number of user turns needed for the first useful transcript paint. */
export const INITIAL_TRANSCRIPT_TURN_LIMIT = 10 as const;

/** The number of older user turns returned by one explicit history action. */
export const OLDER_TRANSCRIPT_TURN_LIMIT = 20 as const;

export interface TranscriptCursorPolicy<TCursor extends string = HostTranscriptCursor> {
  at: (index: number) => TCursor;
  index: (cursor: TCursor, maximum: number) => number;
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
    : policy!.index(cursor, messages.length);
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
    ...(hasOlderTurn && policy ? { olderCursor: policy.at(start) } : {}),
    hasMore: hasOlderTurn,
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
      messages: this.messages.slice(bounds.start, bounds.end),
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
