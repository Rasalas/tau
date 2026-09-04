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

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Small synchronous SHA-256 implementation usable in both Electron and Vite. */
function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000) >>> 0);

  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
  let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const w15 = words[index - 15];
      const w2 = words[index - 2];
      const sigma0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const sigma1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4; let f = h5; let g = h6; let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word.toString(16).padStart(8, "0")).join("");
}

/** Stable, non-reversible cryptographic digest used only for request correlation. */
export function clientMessageFingerprint(value: unknown, knownSkillNames: Iterable<string> = []): string {
  const text = visibleFingerprintText(messageText(value), knownSkillNames);
  return `${text.length.toString(16)}:${sha256Hex(text)}`;
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
      ? persistedId ?? pending.find((candidate) => candidate.fingerprint === clientMessageFingerprint(value, knownSkillNames))?.clientMessageId
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
    const matchedId = persistedId ?? pending.find((candidate) => candidate.fingerprint === clientMessageFingerprint(message.message, knownSkillNames))?.clientMessageId;
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
      ? persistedId ?? pending.find((candidate) => candidate.fingerprint === clientMessageFingerprint(value, knownSkillNames))?.clientMessageId
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
