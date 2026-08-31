import { parseKnownSkillName, parseSkillEnvelope } from "./skill-envelope.js";

/**
 * Correlates a renderer request with the user message written by the runtime.
 *
 * A runtime is allowed to omit the request id and can deliver queued messages
 * out of order.  The marker therefore carries a non-reversible fingerprint of
 * the normalized visible text.  Matching is always against that fingerprint;
 * there is deliberately no positional or timestamp fallback.
 */
export const CLIENT_MESSAGE_MARKER = "tau-client-message";
export const CLIENT_MESSAGE_CANCEL_MARKER = "tau-client-message-cancel";

interface MarkerData {
  clientMessageId: string;
  fingerprint?: string;
}

interface PendingMarker {
  clientMessageId: string;
  fingerprint?: string;
}

function markerData(value: unknown, customType: string): MarkerData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { type?: unknown; customType?: unknown; data?: unknown };
  if (entry.type !== "custom" || entry.customType !== customType || !entry.data || typeof entry.data !== "object") return undefined;
  const data = entry.data as { clientMessageId?: unknown; fingerprint?: unknown };
  if (typeof data.clientMessageId !== "string" || data.clientMessageId.length === 0) return undefined;
  return {
    clientMessageId: data.clientMessageId,
    ...(typeof data.fingerprint === "string" && data.fingerprint.length > 0 ? { fingerprint: data.fingerprint } : {}),
  };
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

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as { text?: unknown; content?: unknown };
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return "";
  return record.content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const item = part as { type?: unknown; text?: unknown };
    return item.type === "text" && typeof item.text === "string" ? item.text : "";
  }).join("\n");
}

/**
 * Pi expands a skill into an internal wrapper before persisting it.  The
 * wrapper is runtime data, so correlation compares its visible suffix only.
 * This intentionally recognizes a complete shape without exposing any of its
 * attributes or body to the renderer.
 */
function visibleFingerprintText(value: string, knownSkillNames: Iterable<string> = []): string {
  // A wrapper is only runtime syntax when its skill is present in the live
  // command registry. Without that proof it is ordinary user text: treating
  // an unknown wrapper's suffix as canonical would let it collide with a
  // different, genuinely typed message.
  const known = new Set(knownSkillNames);
  const envelope = parseSkillEnvelope(value);
  if (envelope && known.has(envelope.name)) return envelope.userMessage;
  const shorthand = parseKnownSkillName(value, known);
  if (shorthand) return shorthand.userMessage;
  return value;
}

/** Stable, non-reversible fingerprint used only for request correlation. */
export function clientMessageFingerprint(value: unknown, knownSkillNames: Iterable<string> = []): string {
  const text = visibleFingerprintText(messageText(value), knownSkillNames);
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${text.length.toString(16)}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function removePending(pending: PendingMarker[], clientMessageId: string): void {
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (pending[index]?.clientMessageId === clientMessageId) pending.splice(index, 1);
  }
}

function cancelledClientMessageIds(entries: readonly unknown[]): Set<string> {
  return new Set(entries.flatMap((entry) => {
    const marker = markerData(entry, CLIENT_MESSAGE_CANCEL_MARKER);
    return marker ? [marker.clientMessageId] : [];
  }));
}

/**
 * Matches an id-less runtime message against the oldest marker with the same
 * fingerprint.  Identical duplicate prompts intentionally use queue order;
 * different text never falls through to a blind FIFO match.
 */
export function matchClientMessageId(
  pendingClientMessageIds: readonly string[],
  fingerprints: ReadonlyMap<string, string>,
  message: unknown,
  knownSkillNames: Iterable<string> = [],
): string | undefined {
  const fingerprint = clientMessageFingerprint(message, knownSkillNames);
  return pendingClientMessageIds.find((clientMessageId) => fingerprints.get(clientMessageId) === fingerprint);
}

/** Projects branch entries without mutating the append-only source records. */
export function branchMessagesWithClientMessageIds(entries: readonly unknown[], knownSkillNames: Iterable<string> = []): unknown[] {
  const pending: PendingMarker[] = [];
  const cancelledIds = cancelledClientMessageIds(entries);
  const messages: unknown[] = [];
  for (const entry of entries) {
    const marker = markerData(entry, CLIENT_MESSAGE_MARKER);
    if (marker && !cancelledIds.has(marker.clientMessageId)) {
      pending.push(marker);
      continue;
    }
    const cancelled = markerData(entry, CLIENT_MESSAGE_CANCEL_MARKER);
    if (cancelled) {
      removePending(pending, cancelled.clientMessageId);
      continue;
    }
    const message = messageEntry(entry);
    if (!message) continue;
    const value = message.message;
    const persistedId = value.role === "user" ? messageClientMessageId(value) : undefined;
    if (persistedId) removePending(pending, persistedId);
    const clientMessageId = value.role === "user"
      ? persistedId ?? pending.find((marker) => marker.fingerprint === clientMessageFingerprint(value, knownSkillNames))?.clientMessageId
      : undefined;
    if (clientMessageId) removePending(pending, clientMessageId);
    messages.push(clientMessageId ? { ...value, clientMessageId } : { ...value });
  }
  return messages;
}

/** Returns marker ids that have no matching persisted user message. */
export function unclaimedClientMessageIds(entries: readonly unknown[], knownSkillNames: Iterable<string> = []): string[] {
  const pending: PendingMarker[] = [];
  const cancelledIds = cancelledClientMessageIds(entries);
  for (const entry of entries) {
    const marker = markerData(entry, CLIENT_MESSAGE_MARKER);
    if (marker && !cancelledIds.has(marker.clientMessageId)) {
      pending.push(marker);
      continue;
    }
    const cancelled = markerData(entry, CLIENT_MESSAGE_CANCEL_MARKER);
    if (cancelled) {
      removePending(pending, cancelled.clientMessageId);
      continue;
    }
    const message = messageEntry(entry);
    if (!message || message.message.role !== "user") continue;
    const persistedId = messageClientMessageId(message.message);
    const matchedId = persistedId ?? pending.find((marker) => marker.fingerprint === clientMessageFingerprint(message.message, knownSkillNames))?.clientMessageId;
    if (matchedId) removePending(pending, matchedId);
  }
  return pending.map((marker) => marker.clientMessageId);
}

/**
 * Resolves a live message by direct id, source object identity, or an exact
 * fingerprinted marker.  A copied object with equal text has no identity and
 * is intentionally left uncorrelated.
 */
export function clientMessageIdForMessage(entries: readonly unknown[], target: unknown, knownSkillNames: Iterable<string> = []): string | undefined {
  if (!target || typeof target !== "object") return undefined;
  const targetRecord = target as Record<string, unknown>;
  const directId = targetRecord.role === "user" ? messageClientMessageId(targetRecord) : undefined;
  if (directId) return directId;

  const pending: PendingMarker[] = [];
  const cancelledIds = cancelledClientMessageIds(entries);
  for (const entry of entries) {
    const marker = markerData(entry, CLIENT_MESSAGE_MARKER);
    if (marker && !cancelledIds.has(marker.clientMessageId)) {
      pending.push(marker);
      continue;
    }
    const cancelled = markerData(entry, CLIENT_MESSAGE_CANCEL_MARKER);
    if (cancelled) {
      removePending(pending, cancelled.clientMessageId);
      continue;
    }
    const message = messageEntry(entry);
    if (!message) continue;
    const value = message.message;
    const persistedId = value.role === "user" ? messageClientMessageId(value) : undefined;
    const id = value.role === "user"
      ? persistedId ?? pending.find((marker) => marker.fingerprint === clientMessageFingerprint(value, knownSkillNames))?.clientMessageId
      : undefined;
    if (id) removePending(pending, id);
    if (value === target) return id;
  }
  return undefined;
}

export function clientMessageMarker(clientMessageId: string, fingerprint?: string): { customType: string; data: MarkerData } {
  return {
    customType: CLIENT_MESSAGE_MARKER,
    data: { clientMessageId, ...(fingerprint ? { fingerprint } : {}) },
  };
}

export function clientMessageCancelMarker(clientMessageId: string): { customType: string; data: MarkerData } {
  return { customType: CLIENT_MESSAGE_CANCEL_MARKER, data: { clientMessageId } };
}
