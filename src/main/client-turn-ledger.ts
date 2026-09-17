import type { ClientTurnIdentity, UiMessage } from "../shared/contracts.js";
import {
  ClientTurnLedgerStore,
  type ClientTurnLedgerObservation,
  type ClientTurnLedgerSelection,
} from "../shared/client-turn-ledger.js";
import { clientIdentityMatches, resolveClientTurnIdentity, hasExplicitClientIdentity } from "../shared/transcript-turn.js";

type ClientMessageObservation = Partial<ClientTurnIdentity>
  & Pick<UiMessage, "text" | "timestamp" | "sourceEntryId">
  & { role?: UiMessage["role"]; fingerprint?: string };

/** Keep correlation state bounded even when a host is left attached for days. */
export const CLIENT_TURN_PENDING_LIMIT = 64;
export const CLIENT_TURN_TOTAL_PENDING_LIMIT = 1_024;
export const CLIENT_TURN_REMEMBERED_LIMIT = 256;
export const CLIENT_TURN_TOTAL_REMEMBERED_LIMIT = 1_024;

/**
 * Keeps renderer submission identities alongside Pi's message lifecycle.
 *
 * Pi expands `/skill` and `/template` commands inside AgentSession, before it
 * emits the user message. The SDK currently has no metadata parameter, so the
 * host carries the identity out-of-band and claims it when Pi emits the
 * message. If a bridge implementation echoes the identity, the explicit
 * fields win over the FIFO compatibility path; this is what keeps identical
 * prompts distinct when events arrive out of order.
 */
export class ClientTurnLedger {
  private readonly store = new ClientTurnLedgerStore({
    pendingPerScope: CLIENT_TURN_PENDING_LIMIT,
    pendingTotal: CLIENT_TURN_TOTAL_PENDING_LIMIT,
    rememberedPerScope: CLIENT_TURN_REMEMBERED_LIMIT,
    rememberedTotal: CLIENT_TURN_TOTAL_REMEMBERED_LIMIT,
  });

  /** The fingerprint is the one written into the request marker: the same text normalization on both sides. */
  enqueue(sessionId: string | undefined, identity: ClientTurnIdentity, fingerprint?: string): void {
    if (!sessionId) return;
    this.store.enqueue(sessionId, identity, fingerprint ? { fingerprint } : {});
  }

  /** Used by a bridge `new_session` command whose resulting session ID is not known yet. */
  enqueueAny(identity: ClientTurnIdentity, fingerprint?: string): void {
    this.store.enqueueAny(identity, fingerprint ? { fingerprint } : {});
  }

  cancel(sessionId: string | undefined, identity: ClientTurnIdentity): void {
    this.store.cancel(sessionId, identity);
  }

  /**
   * Claims a pending identity for an emitted Pi user message. Explicit bridge
   * metadata is matched first. Otherwise the message's text fingerprint picks
   * the pending turn: Pi delivers a steer before an earlier follow-up, so queue
   * order alone would hand the steer the follow-up's identity. Only turns that
   * were enqueued without a fingerprint still fall back to FIFO.
   */
  claim(
    sessionId: string | undefined,
    observation: ClientMessageObservation,
    rawMessage?: object,
  ): ClientTurnIdentity | undefined {
    if (!sessionId || (observation.role !== undefined && observation.role !== "user")) return undefined;
    const explicit = hasExplicitClientIdentity(observation);
    // Explicit fields are authoritative even when the same runtime object was
    // previously seen through the WeakMap. A reused object must not resurrect
    // an older optimistic identity after Pi changes its metadata.
    const remembered = !explicit && rawMessage ? this.store.identityForRaw(rawMessage) : undefined;
    if (remembered) return remembered;

    const selected = explicit
      ? this.store.findPending(sessionId, (entry) => clientIdentityMatches(observation, entry.identity), { preferAny: true })
      : this.findPendingByFingerprint(sessionId, observation.fingerprint);
    if (selected) {
      this.store.removePending(selected);
      return this.rememberClaim(sessionId, observation, selected.entry.identity, rawMessage);
    }

    // An explicit observation is still a valid authoritative identity even if
    // this host did not enqueue it (for example a restored runtime). It must
    // never consume a different pending turn.
    const identity = this.identityForMessage(sessionId, observation);
    if (identity) this.remember(sessionId, observation, identity, rawMessage);
    return identity;
  }

  /**
   * The exact fingerprint wins, then a turn enqueued without one. A message
   * whose text matches no pending turn still takes the oldest: Pi templates
   * and extension input hooks rewrite text before it is persisted.
   */
  private findPendingByFingerprint(sessionId: string, fingerprint: string | undefined): ClientTurnLedgerSelection | undefined {
    const any = () => this.store.findPending(sessionId, () => true, { preferAny: true });
    if (!fingerprint) return any();
    return this.store.findPending(sessionId, (entry) => entry.fingerprint === fingerprint, { preferAny: true })
      ?? this.store.findPending(sessionId, (entry) => entry.fingerprint === undefined, { preferAny: true })
      ?? any();
  }

  private rememberClaim(
    sessionId: string,
    observation: ClientMessageObservation,
    identity: ClientTurnIdentity,
    rawMessage?: object,
  ): ClientTurnIdentity {
    this.remember(sessionId, observation, identity, rawMessage);
    return identity;
  }

  remember(
    sessionId: string,
    message: Pick<UiMessage, "text" | "timestamp" | "sourceEntryId">,
    identity: ClientTurnIdentity,
    rawMessage?: object,
  ): void {
    const observation: ClientTurnLedgerObservation = {
      sourceEntryId: message.sourceEntryId,
      text: message.text,
      timestamp: message.timestamp,
    };
    this.store.remember(sessionId, observation, identity, rawMessage);
  }

  identityForRaw(rawMessage: object): ClientTurnIdentity | undefined {
    return this.store.identityForRaw(rawMessage);
  }

  identityForMessage(sessionId: string, message: ClientMessageObservation): ClientTurnIdentity | undefined {
    if (message.role !== undefined && message.role !== "user") return undefined;
    if (hasExplicitClientIdentity(message)) return resolveClientTurnIdentity(message);
    const entries = this.store.rememberedEntries(sessionId);
    const source = message.sourceEntryId
      ? entries.find((entry) => entry.sourceEntryId === message.sourceEntryId)
      : undefined;
    if (source) return source.identity;
    const timestampMatch = entries.find((entry) => entry.timestamp === message.timestamp && entry.text === message.text);
    return timestampMatch?.identity;
  }

  clear(sessionId?: string): void {
    this.store.clear(sessionId);
  }

  /** A settled runtime no longer needs pending or legacy snapshot correlation. */
  settle(sessionId: string): void {
    this.store.clear(sessionId);
  }

  /** Discard bridge-only commands when a bridge changes ownership. */
  clearAny(): void {
    this.store.clearAny();
  }

  get pendingSize(): number {
    return this.store.pendingSize;
  }

  get rememberedSize(): number {
    return this.store.rememberedSize;
  }

  get size(): number {
    return this.store.size;
  }
}

export function withClientTurnIdentity(message: UiMessage, identity?: ClientTurnIdentity): UiMessage {
  return identity ? { ...message, ...identity } : message;
}
