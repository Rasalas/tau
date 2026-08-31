/**
 * A user turn's correlation id is persisted as a non-context session entry.
 * Pi deliberately has no user-message metadata slot, so this marker sits next
 * to the message in the append-only session tree and is consumed only by the
 * host/bridge projection. It never becomes prompt text or transcript content.
 */
export const CLIENT_MESSAGE_MARKER = "tau-client-message";
export const CLIENT_MESSAGE_CANCEL_MARKER = "tau-client-message-cancel";

interface MarkerData {
  clientMessageId: string;
}

function markerData(value: unknown, customType: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { type?: unknown; customType?: unknown; data?: unknown };
  if (entry.type !== "custom" || entry.customType !== customType || !entry.data || typeof entry.data !== "object") return undefined;
  const id = (entry.data as MarkerData).clientMessageId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function messageEntry(value: unknown): { message: Record<string, unknown> } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { type?: unknown; message?: unknown };
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return undefined;
  return { message: entry.message as Record<string, unknown> };
}

function messageClientMessageId(message: Record<string, unknown>): string | undefined {
  return typeof message.clientMessageId === "string" && message.clientMessageId.length > 0
    ? message.clientMessageId
    : undefined;
}

function removePending(pending: string[], clientMessageId: string): void {
  const index = pending.indexOf(clientMessageId);
  if (index >= 0) pending.splice(index, 1);
}

function cancelledClientMessageIds(entries: readonly unknown[]): Set<string> {
  return new Set(entries.flatMap((entry) => {
    const clientMessageId = markerData(entry, CLIENT_MESSAGE_CANCEL_MARKER);
    return clientMessageId ? [clientMessageId] : [];
  }));
}

/**
 * Projects branch entries to message objects carrying only the correlation id
 * needed by the UI. The source entries themselves are never mutated.
 */
export function branchMessagesWithClientMessageIds(entries: readonly unknown[]): unknown[] {
  const pending: string[] = [];
  const messages: unknown[] = [];
  const cancelledIds = cancelledClientMessageIds(entries);
  for (const entry of entries) {
    const marker = markerData(entry, CLIENT_MESSAGE_MARKER);
    if (marker && !cancelledIds.has(marker)) {
      pending.push(marker);
      continue;
    }
    const cancelled = markerData(entry, CLIENT_MESSAGE_CANCEL_MARKER);
    if (cancelled) {
      removePending(pending, cancelled);
      continue;
    }
    const message = messageEntry(entry);
    if (!message) continue;
    const value = message.message;
    const persistedId = value.role === "user" ? messageClientMessageId(value) : undefined;
    if (persistedId) removePending(pending, persistedId);
    const clientMessageId = value.role === "user" ? persistedId ?? pending.shift() : undefined;
    messages.push(clientMessageId ? { ...value, clientMessageId } : { ...value });
  }
  return messages;
}

/**
 * Returns request markers that survived without a persisted user message.
 * This is used only when a runtime is reopened: an in-flight request from a
 * previous host process cannot be allowed to claim a later message.
 */
export function unclaimedClientMessageIds(entries: readonly unknown[]): string[] {
  const pending: string[] = [];
  const cancelledIds = cancelledClientMessageIds(entries);
  for (const entry of entries) {
    const marker = markerData(entry, CLIENT_MESSAGE_MARKER);
    if (marker && !cancelledIds.has(marker)) {
      pending.push(marker);
      continue;
    }
    const cancelled = markerData(entry, CLIENT_MESSAGE_CANCEL_MARKER);
    if (cancelled) {
      removePending(pending, cancelled);
      continue;
    }
    const message = messageEntry(entry);
    if (!message || message.message.role !== "user") continue;
    const persistedId = messageClientMessageId(message.message);
    if (persistedId) removePending(pending, persistedId);
  }
  return pending;
}

/**
 * Resolves an event's id by object identity against the authoritative branch.
 * There is intentionally no timestamp/text fallback: equal prompts are valid
 * and out-of-order events must never reconcile the wrong optimistic row.
 */
export function clientMessageIdForMessage(entries: readonly unknown[], target: unknown): string | undefined {
  if (!target || typeof target !== "object") return undefined;
  const targetRecord = target as Record<string, unknown>;
  const directId = targetRecord.role === "user" ? messageClientMessageId(targetRecord) : undefined;
  if (directId) return directId;
  const pending: string[] = [];
  const cancelledIds = cancelledClientMessageIds(entries);
  for (const entry of entries) {
    const marker = markerData(entry, CLIENT_MESSAGE_MARKER);
    if (marker && !cancelledIds.has(marker)) {
      pending.push(marker);
      continue;
    }
    const cancelled = markerData(entry, CLIENT_MESSAGE_CANCEL_MARKER);
    if (cancelled) {
      removePending(pending, cancelled);
      continue;
    }
    const message = messageEntry(entry);
    if (!message) continue;
    const persistedId = message.message.role === "user" ? messageClientMessageId(message.message) : undefined;
    if (persistedId) removePending(pending, persistedId);
    const clientMessageId = message.message.role === "user" ? persistedId ?? pending.shift() : undefined;
    if (message.message === target) return clientMessageId;
  }
  return undefined;
}

export function clientMessageMarker(clientMessageId: string): { customType: string; data: MarkerData } {
  return { customType: CLIENT_MESSAGE_MARKER, data: { clientMessageId } };
}

export function clientMessageCancelMarker(clientMessageId: string): { customType: string; data: MarkerData } {
  return { customType: CLIENT_MESSAGE_CANCEL_MARKER, data: { clientMessageId } };
}
