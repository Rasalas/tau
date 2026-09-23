import type { EvidenceTurn } from "./protocol.js";

interface TimedMessage {
  id: string;
  role: string;
  timestamp: number;
}

/** A turn's prompt may be written a moment before the host starts the turn. */
const PROMPT_SLACK_MS = 5_000;
/** An answer's entry may be stamped a moment after the turn settled. */
const ANSWER_SLACK_MS = 1_000;

/**
 * The message a settled turn's pictures sit under: the last reply of the
 * turn, else its prompt. Nothing for a turn whose messages are not loaded,
 * so its row waits for its page. A running turn sits at the tail.
 */
export function turnAnchor(turn: Pick<EvidenceTurn, "startedAt" | "endedAt">, messages: readonly TimedMessage[]): string | undefined {
  if (turn.endedAt === undefined) return undefined;
  const until = turn.endedAt + ANSWER_SLACK_MS;
  let reply: string | undefined;
  let prompt: string | undefined;
  for (const message of messages) {
    if (message.timestamp > until || message.timestamp < turn.startedAt - PROMPT_SLACK_MS) continue;
    if (message.role === "user") prompt = message.id;
    else reply = message.id;
  }
  return reply ?? prompt;
}

/**
 * A turn the host never saw settle — it stopped mid-turn — reads as settled
 * at its last picture once the thread is idle.
 */
export function settledTurn(turn: EvidenceTurn, streaming: boolean): EvidenceTurn {
  if (turn.endedAt !== undefined || streaming) return turn;
  return { ...turn, endedAt: turn.frames.at(-1)?.at ?? turn.startedAt };
}
