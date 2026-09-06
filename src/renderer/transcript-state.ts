import type { UiMessage } from "../shared/contracts";

/**
 * Immutable transcript value for the visible thread. Every operation returns a
 * new value, so a reducer over it stays pure; the revisions let consumers tell
 * a streamed delta from a structural change without diffing the array.
 */
export interface TranscriptState {
  readonly messages: readonly UiMessage[];
  /** Rough token count for the context meter, maintained per change. */
  readonly tokenEstimate: number;
  /** Increments for every visible record update, including assistant deltas. */
  readonly revision: number;
  /** Increments only when a user-message membership or content can affect reconciliation. */
  readonly userRevision: number;
  /** Increments only when the user-message lookup can become stale. */
  readonly lookupRevision: number;
}

export const EMPTY_TRANSCRIPT: TranscriptState = {
  messages: [],
  tokenEstimate: 0,
  revision: 0,
  userRevision: 0,
  lookupRevision: 0,
};

/** Keep this deliberately aligned with the context-meter heuristic in App. */
function estimateMessageTokens(message: Pick<UiMessage, "text" | "thinking">): number {
  return Math.ceil(message.text.length / 4) + Math.ceil((message.thinking ?? "").length / 4);
}

function estimateAll(messages: readonly UiMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function lookupFieldsChanged(current: UiMessage, next: UiMessage): boolean {
  if (current.id !== next.id || current.role !== next.role) return true;
  if (current.role !== "user" && next.role !== "user") return false;
  return current.text !== next.text
    || current.timestamp !== next.timestamp
    || current.sourceEntryId !== next.sourceEntryId
    || current.clientTurnId !== next.clientTurnId
    || current.clientMessageId !== next.clientMessageId;
}

/** Live rows sit at the end, so scanning backwards makes streaming lookups O(1). */
function findMessageIndex(transcript: TranscriptState, id: string): number {
  const { messages } = transcript;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].id === id) return index;
  }
  return -1;
}

export function hasMessage(transcript: TranscriptState, id: string): boolean {
  return findMessageIndex(transcript, id) >= 0;
}

export function replaceTranscript(previous: TranscriptState, messages: readonly UiMessage[]): TranscriptState {
  return {
    messages,
    tokenEstimate: estimateAll(messages),
    revision: previous.revision + 1,
    userRevision: previous.userRevision + 1,
    lookupRevision: previous.lookupRevision + 1,
  };
}

export function appendMessage(previous: TranscriptState, message: UiMessage): TranscriptState {
  const index = findMessageIndex(previous, message.id);
  if (index >= 0) return replaceMessageAt(previous, index, message);
  return {
    messages: [...previous.messages, message],
    tokenEstimate: previous.tokenEstimate + estimateMessageTokens(message),
    revision: previous.revision + 1,
    userRevision: previous.userRevision + (message.role === "user" ? 1 : 0),
    lookupRevision: previous.lookupRevision + 1,
  };
}

function replaceMessageAt(previous: TranscriptState, index: number, next: UiMessage): TranscriptState {
  const current = previous.messages[index];
  if (current === next) return previous;
  const messages = [...previous.messages];
  messages[index] = next;
  return {
    messages,
    tokenEstimate: previous.tokenEstimate + estimateMessageTokens(next) - estimateMessageTokens(current),
    revision: previous.revision + 1,
    userRevision: previous.userRevision + (current.role === "user" || next.role === "user" ? 1 : 0),
    lookupRevision: previous.lookupRevision + (lookupFieldsChanged(current, next) ? 1 : 0),
  };
}

export function replaceMessage(previous: TranscriptState, id: string, next: UiMessage): TranscriptState {
  const index = findMessageIndex(previous, id);
  return index < 0 ? previous : replaceMessageAt(previous, index, next);
}

export function updateMessage(
  previous: TranscriptState,
  id: string,
  update: (message: UiMessage) => UiMessage,
): TranscriptState {
  const index = findMessageIndex(previous, id);
  return index < 0 ? previous : replaceMessageAt(previous, index, update(previous.messages[index]));
}

export function removeMessage(previous: TranscriptState, id: string): TranscriptState {
  const index = findMessageIndex(previous, id);
  if (index < 0) return previous;
  const removed = previous.messages[index];
  return {
    messages: previous.messages.filter((_, at) => at !== index),
    tokenEstimate: previous.tokenEstimate - estimateMessageTokens(removed),
    revision: previous.revision + 1,
    userRevision: previous.userRevision + (removed.role === "user" ? 1 : 0),
    lookupRevision: previous.lookupRevision + 1,
  };
}

/** Applies one streamed chunk. The store merges a frame of chunks before calling this. */
export function appendMessageDelta(
  previous: TranscriptState,
  id: string,
  kind: "text" | "thinking",
  delta: string,
): TranscriptState {
  if (!delta) return previous;
  return updateMessage(previous, id, (message) => kind === "text"
    ? { ...message, text: message.text + delta }
    : { ...message, thinking: (message.thinking ?? "") + delta });
}
