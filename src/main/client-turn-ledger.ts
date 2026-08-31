import type { ClientTurnIdentity, UiMessage } from "../shared/contracts.js";

interface PendingClientTurn {
  identity: ClientTurnIdentity;
}

interface RememberedClientTurn {
  identity: ClientTurnIdentity;
  sourceEntryId?: string;
  text: string;
  timestamp: number;
  rawMessage?: object;
}

type ClientMessageObservation = Partial<ClientTurnIdentity> & Pick<UiMessage, "text" | "timestamp" | "sourceEntryId">;

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
  private readonly pending = new Map<string, PendingClientTurn[]>();
  private readonly pendingAny: PendingClientTurn[] = [];
  private readonly remembered = new Map<string, RememberedClientTurn[]>();
  private readonly rawMessages = new WeakMap<object, ClientTurnIdentity>();

  enqueue(sessionId: string | undefined, identity: ClientTurnIdentity): void {
    if (!sessionId) return;
    const queue = this.pending.get(sessionId) ?? [];
    if (queue.some((entry) => entry.identity.clientTurnId === identity.clientTurnId)) return;
    queue.push({ identity });
    this.pending.set(sessionId, queue);
  }

  /** Used by a bridge `new_session` command whose resulting session ID is not known yet. */
  enqueueAny(identity: ClientTurnIdentity): void {
    if (this.pendingAny.some((entry) => entry.identity.clientTurnId === identity.clientTurnId)) return;
    this.pendingAny.push({ identity });
  }

  cancel(sessionId: string | undefined, identity: ClientTurnIdentity): void {
    if (sessionId) {
      const queue = this.pending.get(sessionId);
      if (queue) {
        const remaining = queue.filter((entry) => entry.identity.clientTurnId !== identity.clientTurnId);
        if (remaining.length === 0) this.pending.delete(sessionId);
        else this.pending.set(sessionId, remaining);
      }
    }
    const anyIndex = this.pendingAny.findIndex((entry) => entry.identity.clientTurnId === identity.clientTurnId);
    if (anyIndex >= 0) this.pendingAny.splice(anyIndex, 1);
  }

  /**
   * Claims a pending identity for an emitted Pi user message. Explicit bridge
   * metadata is matched first; local AgentSession delivery is serialized, so
   * FIFO is the safe compatibility fallback and never compares expanded text.
   */
  claim(
    sessionId: string | undefined,
    observation: ClientMessageObservation,
    rawMessage?: object,
  ): ClientTurnIdentity | undefined {
    if (!sessionId) return undefined;
    const sessionQueue = this.pending.get(sessionId);
    const queues = [
      ...(sessionQueue && sessionQueue.length > 0 ? [{ entries: sessionQueue, any: false }] : []),
      ...(this.pendingAny.length > 0 ? [{ entries: this.pendingAny, any: true }] : []),
    ];
    const hasExplicitIdentity = Boolean(observation.clientTurnId || observation.clientMessageId);
    let selected: { entries: PendingClientTurn[]; any: boolean; index: number } | undefined;
    if (hasExplicitIdentity) {
      for (const queue of queues) {
        const index = queue.entries.findIndex((entry) => (
          (observation.clientTurnId !== undefined && entry.identity.clientTurnId === observation.clientTurnId)
          || (observation.clientMessageId !== undefined && entry.identity.clientMessageId === observation.clientMessageId)
        ));
        if (index >= 0) {
          selected = { ...queue, index };
          break;
        }
      }
    } else if (queues.length > 0) {
      // A new-session request has no session ID until its first event. It must
      // win the compatibility FIFO over prompts queued after the new session
      // became visible, otherwise its identity would leak into that prompt.
      const queue = queues.find((candidate) => candidate.any) ?? queues[0];
      selected = { ...queue, index: 0 };
    }
    if (!selected) {
      const identity = this.identityForMessage(sessionId, observation);
      if (identity) this.remember(sessionId, observation, identity, rawMessage);
      return identity;
    }
    const [entry] = selected.entries.splice(selected.index, 1);
    if (selected.any) {
      // `splice` mutates the shared pendingAny array. Keep this branch explicit
      // so a future queue implementation cannot accidentally leave the draft
      // identity available to the next session.
      return this.rememberClaim(sessionId, observation, entry.identity, rawMessage);
    }
    if (selected.entries.length === 0) {
      this.pending.delete(sessionId);
    }
    return this.rememberClaim(sessionId, observation, entry.identity, rawMessage);
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
    const entries = this.remembered.get(sessionId) ?? [];
    const existing = entries.find((entry) => entry.identity.clientTurnId === identity.clientTurnId);
    if (existing) {
      existing.sourceEntryId ??= message.sourceEntryId;
      existing.rawMessage ??= rawMessage;
    } else {
      entries.push({ identity, sourceEntryId: message.sourceEntryId, text: message.text, timestamp: message.timestamp, rawMessage });
    }
    this.remembered.set(sessionId, entries);
    if (rawMessage) this.rawMessages.set(rawMessage, identity);
  }

  identityForRaw(rawMessage: object): ClientTurnIdentity | undefined {
    return this.rawMessages.get(rawMessage);
  }

  identityForMessage(sessionId: string, message: ClientMessageObservation): ClientTurnIdentity | undefined {
    if (message.clientTurnId && message.clientMessageId) {
      return { clientTurnId: message.clientTurnId, clientMessageId: message.clientMessageId };
    }
    const entries = this.remembered.get(sessionId);
    if (!entries) return undefined;
    const source = message.sourceEntryId
      ? entries.find((entry) => entry.sourceEntryId === message.sourceEntryId)
      : undefined;
    if (source) return source.identity;
    const timestampMatch = entries.find((entry) => entry.timestamp === message.timestamp && entry.text === message.text);
    return timestampMatch?.identity;
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      this.pending.delete(sessionId);
      this.remembered.delete(sessionId);
      return;
    }
    this.pending.clear();
    this.remembered.clear();
  }
}

export function withClientTurnIdentity(message: UiMessage, identity?: ClientTurnIdentity): UiMessage {
  return identity ? { ...message, ...identity } : message;
}
