import type { ClientTurnIdentity, UiMessage } from "./contracts.js";

export type TranscriptTurnMessage = Pick<UiMessage, "role" | "id" | "text" | "timestamp" | "clientTurnId" | "clientMessageId">;

export interface TranscriptTurnReference {
  turnId: string;
  clientMessageId?: string;
  messageId?: string;
  text?: string;
  timestamp?: number;
}

export function hasExplicitClientIdentity(value: Partial<ClientTurnIdentity>): boolean {
  return value.clientTurnId !== undefined || value.clientMessageId !== undefined;
}

export function completeClientIdentity(value: Partial<ClientTurnIdentity>): ClientTurnIdentity | undefined {
  return value.clientTurnId && value.clientMessageId
    ? { clientTurnId: value.clientTurnId, clientMessageId: value.clientMessageId }
    : undefined;
}

/**
 * Resolve identity with one explicit-first policy. A supplied fallback is
 * consulted only when the observation has no identity fields at all; partial
 * or mismatched explicit metadata is never silently replaced by legacy data.
 */
export function resolveClientTurnIdentity(
  observation: Partial<ClientTurnIdentity>,
  fallback?: ClientTurnIdentity,
): ClientTurnIdentity | undefined {
  if (hasExplicitClientIdentity(observation)) return completeClientIdentity(observation);
  return fallback;
}

export function clientIdentityMatches(
  observation: Partial<ClientTurnIdentity>,
  expected: ClientTurnIdentity,
): boolean {
  const explicit = completeClientIdentity(observation);
  // A single client field is incomplete metadata, not a safe identity. Treat
  // it as authoritative (and therefore non-fallback) but never let it consume
  // a different optimistic entry that happens to share that one field.
  return explicit !== undefined
    && explicit.clientTurnId === expected.clientTurnId
    && explicit.clientMessageId === expected.clientMessageId;
}

/**
 * One matching policy shared by renderer reconciliation, navigation, and host
 * snapshots. A persisted message may carry only `clientMessageId`, which is
 * the stable renderer-to-runtime correlation key. When both sides also carry
 * a turn id, a mismatch still rejects the message. Only messages without any
 * explicit identity may use their message ID or the legacy text/clock key.
 */
export function matchesTranscriptTurnMessage(
  message: TranscriptTurnMessage,
  turn: TranscriptTurnReference,
  options: { allowUnclockedTextFallback?: boolean } = {},
): boolean {
  if (message.role !== "user") return false;
  if (hasExplicitClientIdentity(message)) {
    if (!message.clientMessageId || !turn.clientMessageId) return false;
    if (message.clientTurnId && message.clientTurnId !== turn.turnId) return false;
    return message.clientMessageId === turn.clientMessageId;
  }
  if (turn.messageId !== undefined && message.id === turn.messageId) return true;
  if (turn.text === undefined || message.text !== turn.text) return false;
  return options.allowUnclockedTextFallback === true
    || turn.timestamp === undefined
    || Math.abs(message.timestamp - turn.timestamp) <= 30_000;
}
