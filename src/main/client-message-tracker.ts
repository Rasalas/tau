import type { HostEvent } from "../shared/contracts.js";
import {
  branchMessagesWithClientMessageIds,
  clientMessageCancelMarker,
  clientMessageFingerprint,
  clientMessageIdForMessage,
  clientMessageMarker,
  matchClientMessageId,
  CLIENT_MESSAGE_CANCEL_MARKER,
  CLIENT_MESSAGE_MARKER,
} from "../shared/client-message-correlation.js";
import type { ClientTurnLedger } from "./client-turn-ledger.js";
import type { MessageMappingOptions } from "./host-messages.js";
import { mapMessage } from "./host-messages.js";
import type { ThreadRuntime } from "./thread-runtime.js";

export class ClientMessageTracker {
  constructor(
    private readonly clientTurns: ClientTurnLedger,
    private readonly skillNames: (thread: ThreadRuntime) => ReadonlySet<string>,
    private readonly mapping: (thread: ThreadRuntime | undefined) => MessageMappingOptions,
    private readonly emit: (event: HostEvent) => void,
  ) {}

  appendMarker(thread: ThreadRuntime, clientMessageId: string | undefined, correlationText?: string, preparedFingerprint?: string): boolean {
    if (!clientMessageId) return false;
    const fingerprint = preparedFingerprint ?? (correlationText === undefined
      ? undefined
      : clientMessageFingerprint(correlationText, this.skillNames(thread)));
    thread.appendJournalEntry(CLIENT_MESSAGE_MARKER, clientMessageMarker(clientMessageId, fingerprint).data);
    thread.pendingClientMessageIds.push(clientMessageId);
    if (fingerprint) thread.pendingClientMessageFingerprints.set(clientMessageId, fingerprint);
    return true;
  }

  trackedIds(thread: ThreadRuntime): string[] {
    return [...new Set([...thread.pendingClientMessageIds, ...thread.inFlightClientMessageIds])];
  }

  persistedIds(thread: ThreadRuntime): Set<string> {
    return new Set(branchMessagesWithClientMessageIds(thread.entries, this.skillNames(thread)).flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const value = message as { role?: unknown; clientMessageId?: unknown };
      return value.role === "user" && typeof value.clientMessageId === "string" && value.clientMessageId.length > 0
        ? [value.clientMessageId]
        : [];
    }));
  }

  forget(thread: ThreadRuntime, clientMessageId: string): void {
    for (;;) {
      const pending = thread.pendingClientMessageIds.indexOf(clientMessageId);
      if (pending < 0) break;
      thread.pendingClientMessageIds.splice(pending, 1);
    }
    thread.inFlightClientMessageIds.delete(clientMessageId);
    thread.pendingClientMessageFingerprints.delete(clientMessageId);
  }

  cancelMarker(thread: ThreadRuntime, clientMessageId: string | undefined): boolean {
    if (!clientMessageId) return false;
    const wasPending = thread.pendingClientMessageIds.includes(clientMessageId);
    const wasInFlight = thread.inFlightClientMessageIds.has(clientMessageId);
    if (!wasPending && !wasInFlight) return false;
    thread.appendJournalEntry(CLIENT_MESSAGE_CANCEL_MARKER, clientMessageCancelMarker(clientMessageId).data);
    this.forget(thread, clientMessageId);
    return true;
  }

  failIfUnpersisted(thread: ThreadRuntime, clientMessageId: string | undefined, sessionId = thread.threadId): boolean {
    if (!clientMessageId) return false;
    if (this.persistedIds(thread).has(clientMessageId)) {
      this.forget(thread, clientMessageId);
      return false;
    }
    const cancelled = this.cancelMarker(thread, clientMessageId);
    if (cancelled) this.emit({
      type: "user-message-failed",
      sessionId,
      clientMessageId,
      message: "Pi did not add the prompt to the transcript.",
    });
    return cancelled;
  }

  correlateStart(thread: ThreadRuntime | undefined, message: unknown, sessionId = thread?.threadId): void {
    if (!message || typeof message !== "object") return;
    const value = message as { role?: string; clientMessageId?: unknown };
    if (value.role !== "user") return;
    const mapped = mapMessage(message, 0, this.mapping(thread));
    // The same digest the request marker carries, so the claim can tell two
    // queued prompts apart instead of consuming the oldest one.
    const fingerprint = thread ? clientMessageFingerprint(message, this.skillNames(thread)) : undefined;
    const identity = sessionId && mapped ? this.clientTurns.claim(sessionId, { ...mapped, fingerprint }, message) : undefined;
    if (identity) {
      const raw = message as Record<string, unknown>;
      raw.tauClientTurnId = identity.clientTurnId;
      raw.tauClientMessageId = identity.clientMessageId;
      raw.clientTurnId ??= identity.clientTurnId;
      raw.clientMessageId ??= identity.clientMessageId;
    }
    if (!thread) return;
    if (typeof value.clientMessageId === "string") {
      const pending = thread.pendingClientMessageIds.indexOf(value.clientMessageId);
      if (pending >= 0) {
        thread.pendingClientMessageIds.splice(pending, 1);
        thread.inFlightClientMessageIds.add(value.clientMessageId);
      }
      return;
    }
    const clientMessageId = matchClientMessageId(
      thread.pendingClientMessageIds,
      thread.pendingClientMessageFingerprints,
      message,
      this.skillNames(thread),
    );
    if (!clientMessageId) return;
    const pending = thread.pendingClientMessageIds.indexOf(clientMessageId);
    if (pending >= 0) thread.pendingClientMessageIds.splice(pending, 1);
    thread.inFlightClientMessageIds.add(clientMessageId);
    (message as Record<string, unknown>).clientMessageId = clientMessageId;
  }

  decorateUserEvent(thread: ThreadRuntime, message: unknown): unknown {
    if (!message || typeof message !== "object") return message;
    const value = message as { role?: string; clientMessageId?: string };
    if (value.role !== "user") return message;
    const directId = typeof value.clientMessageId === "string" && value.clientMessageId.length > 0 ? value.clientMessageId : undefined;
    const fingerprintId = matchClientMessageId(
      thread.pendingClientMessageIds,
      thread.pendingClientMessageFingerprints,
      message,
      this.skillNames(thread),
    );
    const clientMessageId = directId
      ?? clientMessageIdForMessage(thread.entries, message, this.skillNames(thread))
      ?? fingerprintId;
    if (clientMessageId) this.forget(thread, clientMessageId);
    return directId || !clientMessageId ? message : { ...value, clientMessageId };
  }
}
