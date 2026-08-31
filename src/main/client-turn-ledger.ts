import type { ClientTurnIdentity, UiMessage } from "../shared/contracts.js";

interface PendingClientTurn {
  identity: ClientTurnIdentity;
}

interface RememberedClientTurn {
  identity: ClientTurnIdentity;
  sourceEntryId?: string;
  text: string;
  timestamp: number;
}

type ClientMessageObservation = Partial<ClientTurnIdentity>
  & Pick<UiMessage, "text" | "timestamp" | "sourceEntryId">
  & { role?: UiMessage["role"] };

/** Keep correlation state bounded even when a host is left attached for days. */
export const CLIENT_TURN_PENDING_LIMIT = 64;
export const CLIENT_TURN_TOTAL_PENDING_LIMIT = 1_024;
export const CLIENT_TURN_REMEMBERED_LIMIT = 256;
export const CLIENT_TURN_TOTAL_REMEMBERED_LIMIT = 1_024;

function hasExplicitClientIdentity(message: Partial<ClientTurnIdentity>): boolean {
  return message.clientTurnId !== undefined || message.clientMessageId !== undefined;
}

function identityMatches(
  observation: Partial<ClientTurnIdentity>,
  identity: ClientTurnIdentity,
): boolean {
  // A complete pair is one identity. Never let one mismatched field consume a
  // different optimistic turn merely because its other field happens to match.
  if (observation.clientTurnId !== undefined && observation.clientMessageId !== undefined) {
    return observation.clientTurnId === identity.clientTurnId
      && observation.clientMessageId === identity.clientMessageId;
  }
  return observation.clientTurnId === identity.clientTurnId
    || observation.clientMessageId === identity.clientMessageId;
}

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
    while (queue.length > CLIENT_TURN_PENDING_LIMIT) queue.shift();
    this.pending.set(sessionId, queue);
    this.trimPending();
  }

  /** Used by a bridge `new_session` command whose resulting session ID is not known yet. */
  enqueueAny(identity: ClientTurnIdentity): void {
    if (this.pendingAny.some((entry) => entry.identity.clientTurnId === identity.clientTurnId)) return;
    this.pendingAny.push({ identity });
    while (this.pendingAny.length > CLIENT_TURN_PENDING_LIMIT) this.pendingAny.shift();
    this.trimPending();
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
    if (!sessionId || (observation.role !== undefined && observation.role !== "user")) return undefined;
    const sessionQueue = this.pending.get(sessionId);
    const queues = [
      ...(sessionQueue && sessionQueue.length > 0 ? [{ entries: sessionQueue, any: false }] : []),
      ...(this.pendingAny.length > 0 ? [{ entries: this.pendingAny, any: true }] : []),
    ];
    const hasExplicitIdentity = hasExplicitClientIdentity(observation);
    // Explicit fields are authoritative even when the same runtime object was
    // previously seen through the WeakMap. A reused object must not resurrect
    // an older optimistic identity after Pi changes its metadata.
    const remembered = !hasExplicitIdentity && rawMessage ? this.rawMessages.get(rawMessage) : undefined;
    if (remembered) return remembered;
    let selected: { entries: PendingClientTurn[]; any: boolean; index: number } | undefined;
    if (hasExplicitIdentity) {
      for (const queue of queues) {
        const index = queue.entries.findIndex((entry) => (
          identityMatches(observation, entry.identity)
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
      existing.text = message.text;
      existing.timestamp = message.timestamp;
    } else {
      entries.push({ identity, sourceEntryId: message.sourceEntryId, text: message.text, timestamp: message.timestamp });
    }
    while (entries.length > CLIENT_TURN_REMEMBERED_LIMIT) entries.shift();
    this.remembered.set(sessionId, entries);
    while (this.rememberedSize > CLIENT_TURN_TOTAL_REMEMBERED_LIMIT) {
      const oldest = this.remembered.entries().next().value as [string, RememberedClientTurn[]] | undefined;
      if (!oldest) break;
      const [oldestSession, oldestEntries] = oldest;
      oldestEntries.shift();
      if (oldestEntries.length === 0) this.remembered.delete(oldestSession);
    }
    if (rawMessage) this.rawMessages.set(rawMessage, identity);
  }

  identityForRaw(rawMessage: object): ClientTurnIdentity | undefined {
    return this.rawMessages.get(rawMessage);
  }

  identityForMessage(sessionId: string, message: ClientMessageObservation): ClientTurnIdentity | undefined {
    if (message.role !== undefined && message.role !== "user") return undefined;
    if (hasExplicitClientIdentity(message)) {
      if (!message.clientTurnId || !message.clientMessageId) return undefined;
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
    this.pendingAny.length = 0;
    this.remembered.clear();
  }

  /** A settled runtime no longer needs pending or legacy snapshot correlation. */
  settle(sessionId: string): void {
    this.clear(sessionId);
  }

  /** Discard bridge-only commands when a bridge changes ownership. */
  clearAny(): void {
    this.pendingAny.length = 0;
  }

  get pendingSize(): number {
    let size = this.pendingAny.length;
    for (const queue of this.pending.values()) size += queue.length;
    return size;
  }

  get rememberedSize(): number {
    let size = 0;
    for (const entries of this.remembered.values()) size += entries.length;
    return size;
  }

  get size(): number {
    return this.pendingSize + this.rememberedSize;
  }

  private trimPending(): void {
    while (this.pendingSize > CLIENT_TURN_TOTAL_PENDING_LIMIT) {
      if (this.pendingAny.length > 0) {
        this.pendingAny.shift();
        continue;
      }
      const oldest = this.pending.entries().next().value as [string, PendingClientTurn[]] | undefined;
      if (!oldest) break;
      const [sessionId, queue] = oldest;
      queue.shift();
      if (queue.length === 0) this.pending.delete(sessionId);
    }
  }
}

export function withClientTurnIdentity(message: UiMessage, identity?: ClientTurnIdentity): UiMessage {
  return identity ? { ...message, ...identity } : message;
}
