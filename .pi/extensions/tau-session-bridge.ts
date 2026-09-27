import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClientTurnIdentity, NewThreadRequestId, UiPromptAttachment } from "../../src/shared/contracts.js";
import { ClientTurnLedgerStore, type ClientTurnLedgerObservation } from "../../src/shared/client-turn-ledger.js";
import { clientIdentityMatches, hasExplicitClientIdentity, resolveClientTurnIdentity } from "../../src/shared/transcript-turn.js";
import { taskProgressFromMessages, taskProgressHistoryFromMessages } from "../../src/shared/task-progress.js";
import { INITIAL_TRANSCRIPT_TURN_LIMIT, transcriptPageBounds } from "../../src/shared/transcript-pager.js";
import type { TranscriptHistoryCompleteness } from "../../src/shared/transcript-completeness.js";
import {
  branchMessagesWithClientMessageIds,
  clientMessageFingerprint,
  clientMessageIdForMessage,
  CLIENT_MESSAGE_MARKER,
  CLIENT_MESSAGE_CANCEL_MARKER,
  matchClientMessageId,
  unclaimedClientMessageIds,
} from "../../src/shared/client-message-correlation.js";
import { knownSkillNames } from "../../src/shared/skill-envelope.js";
import { PI_RUNTIME_ADAPTER, prepareSkillPrompt, skillInvocationCommand, skillMessagePresentation } from "../../src/main/skill-invocation.js";
import type { UiSkillDraft } from "../../src/shared/contracts.js";
import { validatePreparedPrompt } from "../../src/shared/prepared-prompt.js";
import { tauOwnsRuntime } from "../../src/main/tau-runtime-owner.js";
import { readSessionFile } from "../../src/main/session-read.js";
import { promptImages } from "../../src/main/prompt-attachments.js";
import {
  loadPiKitExtensions,
  piKitsRoot,
  type LoadedPiKitExtension,
  type PiKitBridge,
  type PiKitExtensionFailure,
  type PiKitTranscriptMessage,
  type PiKitTurnObserver,
} from "../../src/main/pi-kit-extensions.js";
import { bridgeTranscriptPage, boundedBridgePayload, boundedBridgeValue } from "../../src/shared/bridge-transcript-pager.js";
import { TOOL_OUTPUT_READ_PAGE_CHARACTERS, toolOutputByteLength } from "../../src/shared/tool-output.js";
import {
  encodePiBridgeFrame,
  PI_BRIDGE_MAX_FRAME_BYTES,
  PI_BRIDGE_PROTOCOL_VERSION,
  transcriptPagingNegotiated,
  type PiBridgeClientFrame,
  type PiBridgeDescriptor,
  type PiBridgePreparedPrompt,
  type PiBridgeServerFrame,
  type PiBridgeAwaitingInput,
  type PiBridgeSnapshot,
  type PiBridgeToolOutputPage,
  type PiBridgeTranscriptPage,
  type PiBridgeExtensionEvent,
} from "../../src/shared/pi-bridge-protocol.js";

interface ClientState {
  socket: Socket;
  authenticated: boolean;
  buffer: string;
  transcriptPaging: boolean;
}

type BridgeTranscriptRecord = Record<string, unknown> & { role?: string };

export interface BridgeMessageObservation {
  role?: string;
  content?: unknown;
  timestamp?: number;
  clientTurnId?: string;
  clientMessageId?: string;
  tauClientTurnId?: string;
  tauClientMessageId?: string;
}

export const BRIDGE_TURN_PENDING_LIMIT = 64;
export const BRIDGE_TURN_TOTAL_PENDING_LIMIT = 1_024;
export const BRIDGE_TURN_REMEMBERED_LIMIT = 256;
export const BRIDGE_TURN_TOTAL_REMEMBERED_LIMIT = 1_024;

export function bridgeVisibleText(message: BridgeMessageObservation): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const value = part as { type?: string; text?: string };
    return value.type === "text" ? value.text ?? "" : "";
  }).join("");
}

export function normalizeBridgeFingerprint(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

function bridgeIdentity(message: BridgeMessageObservation): ClientTurnIdentity | undefined {
  return resolveClientTurnIdentity({
    clientTurnId: message.clientTurnId ?? message.tauClientTurnId,
    clientMessageId: message.clientMessageId ?? message.tauClientMessageId,
  });
}

function hasExplicitBridgeIdentity(message: BridgeMessageObservation): boolean {
  return hasExplicitClientIdentity({
    clientTurnId: message.clientTurnId ?? message.tauClientTurnId,
    clientMessageId: message.clientMessageId ?? message.tauClientMessageId,
  });
}

/** Bounded bridge-side correlation for Pi versions that do not preserve send metadata. */
export class BridgeClientTurnLedger {
  private readonly store = new ClientTurnLedgerStore({
    pendingPerScope: BRIDGE_TURN_PENDING_LIMIT,
    pendingTotal: BRIDGE_TURN_TOTAL_PENDING_LIMIT,
    rememberedPerScope: BRIDGE_TURN_REMEMBERED_LIMIT,
    rememberedTotal: BRIDGE_TURN_TOTAL_REMEMBERED_LIMIT,
  });

  enqueue(sessionId: string | undefined, identity: ClientTurnIdentity, submittedText: string): number {
    const metadata = { fingerprint: normalizeBridgeFingerprint(submittedText) };
    return (sessionId
      ? this.store.enqueue(sessionId, identity, metadata)
      : this.store.enqueueAny(identity, metadata)).sequence;
  }

  enqueueAny(identity: ClientTurnIdentity, submittedText: string): number {
    return this.store.enqueueAny(identity, { fingerprint: normalizeBridgeFingerprint(submittedText) }).sequence;
  }

  cancel(sessionId: string | undefined, identity: ClientTurnIdentity): void {
    this.store.cancel(sessionId, identity);
  }

  cancelAny(identity: ClientTurnIdentity): void {
    this.store.cancel(undefined, identity);
  }

  claim(
    sessionId: string,
    message: BridgeMessageObservation,
    rawMessage?: object,
    allowCommandOrderFallback = true,
  ): ClientTurnIdentity | undefined {
    if (message.role !== undefined && message.role !== "user") return undefined;
    const explicit = bridgeIdentity(message);
    if (hasExplicitBridgeIdentity(message)) {
      if (!explicit) return undefined;
      const selected = this.store.findPending(sessionId, (entry) => clientIdentityMatches(explicit, entry.identity), { bySequence: true });
      if (selected) this.store.removePending(selected);
      this.remember(sessionId, message, explicit, rawMessage);
      return explicit;
    }
    const remembered = rawMessage ? this.store.identityForRaw(rawMessage) : undefined;
    if (remembered) return remembered;
    const fingerprint = normalizeBridgeFingerprint(bridgeVisibleText(message));
    const selected = this.store.findPending(sessionId, (entry) => entry.fingerprint === fingerprint, { bySequence: true })
      ?? (allowCommandOrderFallback ? this.store.findPending(sessionId, () => true, { bySequence: true }) : undefined);
    if (!selected) {
      const observed = this.identityForMessage(sessionId, message);
      if (observed) {
        this.remember(sessionId, message, observed, rawMessage);
        return observed;
      }
      return undefined;
    }
    this.store.removePending(selected);
    this.remember(sessionId, message, selected.entry.identity, rawMessage);
    return selected.entry.identity;
  }

  remember(sessionId: string, message: BridgeMessageObservation, identity: ClientTurnIdentity, rawMessage?: object, sourceEntryId?: string): void {
    const observation: ClientTurnLedgerObservation = {
      sourceEntryId,
      fingerprint: normalizeBridgeFingerprint(bridgeVisibleText(message)),
      timestamp: message.timestamp,
    };
    this.store.remember(sessionId, observation, identity, rawMessage);
  }

  rememberEntry(sessionId: string, sourceEntryId: string, message: BridgeMessageObservation): void {
    if (message.role !== undefined && message.role !== "user") return;
    const withEntryId = { ...message, tauEntryId: sourceEntryId };
    const identity = bridgeIdentity(message)
      ?? this.store.identityForRaw(message as object)
      ?? this.identityForMessage(sessionId, withEntryId)
      ?? this.claim(sessionId, withEntryId, undefined, false);
    if (identity) this.remember(sessionId, message, identity, message as object, sourceEntryId);
  }

  identityForMessage(sessionId: string, message: BridgeMessageObservation): ClientTurnIdentity | undefined {
    if (message.role !== undefined && message.role !== "user") return undefined;
    if (hasExplicitBridgeIdentity(message)) return bridgeIdentity(message);
    const entries = this.store.rememberedEntries(sessionId);
    const sourceEntryId = (message as { tauEntryId?: string }).tauEntryId;
    const source = sourceEntryId ? entries.find((entry) => entry.sourceEntryId === sourceEntryId) : undefined;
    if (source) return source.identity;
    const fingerprint = normalizeBridgeFingerprint(bridgeVisibleText(message));
    const fingerprintMatches = entries.filter((entry) => entry.fingerprint === fingerprint);
    if (message.timestamp !== undefined) {
      const exactTimestamp = fingerprintMatches.find((entry) => entry.timestamp === message.timestamp);
      if (exactTimestamp) return exactTimestamp.identity;
    }
    return fingerprintMatches.length === 1 ? fingerprintMatches[0].identity : undefined;
  }

  clearSession(sessionId: string): void { this.store.clear(sessionId); }
  settle(sessionId: string): void { this.clearSession(sessionId); }
  clear(preserveAny = false): void { this.store.clear(undefined, { preserveAny }); }
  get size(): number { return this.store.size; }
}

export function decorateBridgeUserMessage(ledger: BridgeClientTurnLedger, message: BridgeMessageObservation, sessionId: string): void {
  if (message.role !== "user") return;
  const text = bridgeVisibleText(message).trim();
  if (text.startsWith("/tau-bridge-new") || text.startsWith("/tau-bridge-reload") || text.startsWith("/tau-bridge-fork")) return;
  if (!text && !hasExplicitBridgeIdentity(message)) return;
  const identity = ledger.claim(sessionId, message, message as object);
  if (!identity) return;
  const raw = message as Record<string, unknown>;
  raw.tauClientTurnId = identity.clientTurnId;
  raw.tauClientMessageId = identity.clientMessageId;
}

export function bridgeSnapshotMessages(
  ledger: BridgeClientTurnLedger,
  sessionId: string,
  entries: readonly { type: string; id: string; message?: unknown }[],
): unknown[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return [];
    const message = entry.message as BridgeMessageObservation & Record<string, unknown>;
    ledger.rememberEntry(sessionId, entry.id, message);
    const identity = ledger.identityForMessage(sessionId, message);
    return [{ ...message, tauEntryId: entry.id, ...(identity ? {
      tauClientTurnId: identity.clientTurnId,
      tauClientMessageId: identity.clientMessageId,
    } : {}) }];
  });
}

const LEGACY_SNAPSHOT_RECORD_LIMIT = 160 as const;

declare const rawBridgeTranscriptCursorBrand: unique symbol;
type RawBridgeTranscriptCursor = string & { readonly [rawBridgeTranscriptCursorBrand]: true };

function parseRawBridgeTranscriptCursor(value: unknown, maximum?: number): RawBridgeTranscriptCursor {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) throw new Error("Invalid transcript cursor");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || (maximum !== undefined && number > maximum)) {
    throw new Error("Invalid transcript cursor");
  }
  return value as RawBridgeTranscriptCursor;
}

function rawBridgeTranscriptCursorAt(index: number): RawBridgeTranscriptCursor {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid transcript cursor");
  return String(index) as RawBridgeTranscriptCursor;
}

type TranscriptViewPolicy =
  | { kind: "legacy-snapshot"; maxRecords: number }
  | { kind: "initial-page"; turnLimit: number }
  | { kind: "older-page"; turnLimit: number; cursor?: RawBridgeTranscriptCursor | string };

interface TranscriptView {
  branchMessages: BridgeTranscriptRecord[];
  visibleMessages: BridgeTranscriptRecord[];
  messagesOffset: number;
  cursorBeforeMessageId?: string;
  olderCursor?: RawBridgeTranscriptCursor;
  hasMore: boolean;
  historyCompleteness: TranscriptHistoryCompleteness;
  taskHistoryMessages: readonly BridgeTranscriptRecord[];
}

/** Stable host-facing error for a stale or malformed bridge page cursor. */
export class InvalidBridgeTranscriptCursorError extends Error {
  readonly code = "INVALID_BRIDGE_TRANSCRIPT_CURSOR" as const;

  constructor() {
    super("Pi returned an invalid or stale transcript page cursor.");
    this.name = "InvalidBridgeTranscriptCursorError";
  }
}

function validateBridgeCursor(
  value: RawBridgeTranscriptCursor | string | undefined,
  branchLength: number,
): RawBridgeTranscriptCursor | undefined {
  if (value === undefined) return undefined;
  try {
    return parseRawBridgeTranscriptCursor(
      value,
      branchLength,
    );
  } catch {
    throw new InvalidBridgeTranscriptCursorError();
  }
}

export function buildTranscriptView(
  branchMessages: BridgeTranscriptRecord[],
  policy: TranscriptViewPolicy,
): TranscriptView {
  if (policy.kind === "legacy-snapshot") {
    const messagesOffset = Math.max(0, branchMessages.length - policy.maxRecords);
    const firstUser = branchMessages.slice(messagesOffset).find((message) => message.role === "user");
    return {
      branchMessages,
      visibleMessages: branchMessages.slice(messagesOffset),
      messagesOffset,
      ...(typeof firstUser?.tauEntryId === "string" ? { cursorBeforeMessageId: firstUser.tauEntryId } : {}),
      hasMore: false,
      historyCompleteness: "unknown",
      taskHistoryMessages: branchMessages,
    };
  }

  const cursor = policy.kind === "older-page"
    ? validateBridgeCursor(policy.cursor, branchMessages.length)
    : undefined;
  const bounds = transcriptPageBounds(
    branchMessages,
    policy.turnLimit,
    cursor,
    {
      cursorAtIndex: rawBridgeTranscriptCursorAt,
      indexFromCursor: (value, maximum) => Number(parseRawBridgeTranscriptCursor(value, maximum)),
    },
  );
  const olderCursor = bounds.olderCursor;
  const visibleMessages = branchMessages.slice(bounds.start, bounds.end);
  const firstUser = visibleMessages.find((message) => message.role === "user");
  return {
    branchMessages,
    visibleMessages,
    messagesOffset: bounds.start,
    ...(typeof firstUser?.tauEntryId === "string" ? { cursorBeforeMessageId: firstUser.tauEntryId } : {}),
    olderCursor,
    hasMore: bounds.hasMore,
    historyCompleteness: bounds.hasMore ? "has-more" : "complete",
    taskHistoryMessages: visibleMessages,
  };
}

function transcriptView(ctx: ExtensionContext, policy: TranscriptViewPolicy): TranscriptView {
  const branchMessages = ctx.sessionManager.getBranch()
    .flatMap((entry) => entry.type === "message"
      ? [{ ...(entry.message as unknown as Record<string, unknown>), tauEntryId: entry.id }]
      : []) as BridgeTranscriptRecord[];
  return buildTranscriptView(branchMessages, policy);
}

export function bridgeSupportsImageInput(model: { input?: readonly string[] } | undefined): boolean {
  return model?.input?.includes("image") === true;
}

function bridgePromptContent(text: string, attachments: readonly UiPromptAttachment[] = []) {
  const images = promptImages(attachments).map((image) => ({
    type: "image" as const,
    mimeType: image.mimeType,
    data: image.data,
  }));
  if (images.length === 0) return text;
  return [...(text ? [{ type: "text" as const, text }] : []), ...images];
}

/** Encode the registered command used by the socket side of the bridge.
 *
 * Socket callbacks receive an ExtensionContext, not the command-only context
 * that owns session replacement. Going through this registered command keeps
 * that distinction real at runtime as well as in the types.
 */
export function bridgeNewSessionCommand(
  initialPrompt?: string,
  requestId?: NewThreadRequestId,
  clientMessageIdOrIdentity?: string | ClientTurnIdentity,
  prepared?: PiBridgePreparedPrompt,
  attachments?: UiPromptAttachment[],
): string {
  const identity = typeof clientMessageIdOrIdentity === "string"
    ? { clientTurnId: clientMessageIdOrIdentity, clientMessageId: clientMessageIdOrIdentity }
    : clientMessageIdOrIdentity;
  if (initialPrompt === undefined && requestId === undefined && identity === undefined && prepared === undefined && attachments === undefined) return "/tau-bridge-new";
  const value = requestId || identity || prepared || attachments
    ? { initialPrompt, requestId, ...(identity ?? {}), prepared, attachments }
    : initialPrompt;
  return `/tau-bridge-new ${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

export interface NewSessionRequestTracker {
  begin(requestId: NewThreadRequestId): void;
  remove(requestId: NewThreadRequestId): void;
  markReady(requestId: NewThreadRequestId, sessionId: string, bridgeEpoch: string): void;
  requestIdForSnapshot(): NewThreadRequestId | undefined;
  acknowledge(requestId: NewThreadRequestId, sessionId: string, bridgeEpoch: string): boolean;
  abort(requestId: NewThreadRequestId, sessionId: string, bridgeEpoch: string): boolean;
  clear(): void;
}

/** Keeps a request token alive until Pi receives the host's correlated ACK. */
export function createNewSessionRequestTracker(): NewSessionRequestTracker {
  type Entry = { state: "pending" | "ready" | "acked"; sessionId?: string; bridgeEpoch?: string };
  const entries = new Map<NewThreadRequestId, Entry>();
  const remove = (requestId: NewThreadRequestId) => {
    entries.delete(requestId);
  };
  return {
    begin(requestId) {
      for (const [id, entry] of entries) if (entry.state === "acked") remove(id);
      if (entries.size > 0) throw new Error("Pi is already creating a new thread.");
      entries.set(requestId, { state: "pending" });
    },
    remove,
    markReady(requestId, sessionId, bridgeEpoch) {
      const entry = entries.get(requestId);
      if (!entry) return;
      if (entry.sessionId && entry.sessionId !== sessionId) return;
      entry.sessionId = sessionId;
      entry.bridgeEpoch = bridgeEpoch;
      if (entry.state !== "acked") entry.state = "ready";
    },
    // Keep the acked tombstone in snapshots so a host that lost the ACK
    // response can reconnect and retry the same idempotent acknowledgement.
    requestIdForSnapshot: () => entries.keys().next().value,
    acknowledge(requestId, sessionId, bridgeEpoch) {
      const entry = entries.get(requestId);
      if (!entry || !entry.sessionId || !entry.bridgeEpoch
        || entry.sessionId !== sessionId || entry.bridgeEpoch !== bridgeEpoch) return false;
      if (entry.state === "acked") return true;
      if (entry.state !== "ready") return false;
      entry.state = "acked";
      return true;
    },
    abort(requestId, sessionId, bridgeEpoch) {
      const entry = entries.get(requestId);
      if (!entry) return true;
      if (entry.sessionId && (entry.sessionId !== sessionId || entry.bridgeEpoch !== bridgeEpoch)) return false;
      remove(requestId);
      return true;
    },
    clear: () => entries.clear(),
  };
}

const MAX_BRIDGE_CATALOG_ITEMS = 64;
const MAX_BRIDGE_CATALOG_TEXT = 8 * 1024;
/** Preserve the pre-image transport ceiling for snapshots, events, and reads. */
const MAX_BRIDGE_OUTBOUND_FRAME_BYTES = 8 * 1024 * 1024;

function boundedCatalogText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length <= MAX_BRIDGE_CATALOG_TEXT
    ? text
    : `${text.slice(0, MAX_BRIDGE_CATALOG_TEXT)}\n[Bridge catalog text truncated]`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
}

const toolOutputCache = new WeakMap<object, { content: unknown; output: string; totalBytes: number }>();

function cachedToolOutput(record: object): { output: string; totalBytes: number } {
  const content = (record as { content?: unknown }).content;
  const cached = toolOutputCache.get(record);
  if (cached && cached.content === content) return cached;
  const output = textFromContent(content);
  const value = { content, output, totalBytes: toolOutputByteLength(output) };
  toolOutputCache.set(record, value);
  return value;
}

/** Return one bounded page from the durable branch for the host read seam. */
export function toolOutputPageForMessages(
  messages: readonly unknown[],
  toolCallId: string,
  offset = 0,
): PiBridgeToolOutputPage | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid tool output cursor.");
  const record = [...messages].reverse().find((message) => {
    if (!message || typeof message !== "object") return false;
    const value = message as { role?: unknown; toolCallId?: unknown };
    return value.role === "toolResult" && value.toolCallId === toolCallId;
  });
  if (!record || typeof record !== "object") return undefined;
  const { output, totalBytes } = cachedToolOutput(record);
  if (offset > output.length) throw new Error("Invalid tool output cursor.");
  const end = Math.min(output.length, offset + TOOL_OUTPUT_READ_PAGE_CHARACTERS);
  return {
    toolCallId,
    offset,
    output: output.slice(offset, end),
    totalBytes,
    ...(end < output.length ? { nextOffset: end } : {}),
  };
}

// jiti loads this file as CommonJS; a bundled ESM copy has `import.meta` instead.
const BRIDGE_FILE = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);

export interface TauSessionBridgeOptions {
  /** The kits' Pi halves; by default the prebuilt ones beside this checkout. Tests inject stubs. */
  kits?: { extensions: readonly LoadedPiKitExtension[]; errors: readonly PiKitExtensionFailure[] };
}

export default function tauSessionBridge(pi: ExtensionAPI, options: TauSessionBridgeOptions = {}) {
  // This extension exists so a Pi TUI session can be exposed to Tau. Inside
  // Tau's own runtime the kits' Pi halves are registered by the host itself,
  // and a second one would run against the same workspace lease, so the turn
  // would deadlock behind itself.
  if (tauOwnsRuntime()) return;
  const bridgeTurns = new BridgeClientTurnLedger();
  const newSessionRequests = createNewSessionRequestTracker();
  const correlationSkillNames = (): Set<string> => knownSkillNames(pi.getCommands());
  const preparedPrompt = (text: string, skill?: UiSkillDraft): PiBridgePreparedPrompt => {
    const commands = pi.getCommands();
    const effectiveCommands = commands;
    const prepared = prepareSkillPrompt(text, PI_RUNTIME_ADAPTER, effectiveCommands, skill);
    const result: PiBridgePreparedPrompt = {
      visibleText: prepared.text,
      runtimeText: prepared.runtimeText,
      runtimeCapabilities: PI_RUNTIME_ADAPTER.capabilities,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      sourceFingerprint: clientMessageFingerprint(text, knownSkillNames(effectiveCommands)),
    };
    validatePreparedPrompt(text, { ...result, backendKind: "pi" }, {
      backendKind: "pi",
      runtimeCapabilities: PI_RUNTIME_ADAPTER.capabilities,
      commands: effectiveCommands,
    });
    return result;
  };
  /**
   * Prepared data comes back over the authenticated socket, so validate its
   * owner and correlation proof before handing its runtime text to Pi. This
   * deliberately does not run the skill parser again: the bridge already did
   * that in preparedPrompt(), and the fingerprint/typed metadata are the
   * stable hand-off contract for the send operation.
   */
  const resolvePreparedPrompt = (text: string, candidate: unknown): PiBridgePreparedPrompt => {
    if (candidate === undefined) return preparedPrompt(text);
    if (!candidate || typeof candidate !== "object") throw new Error("Pi bridge received an invalid prepared prompt.");
    const value = candidate as Partial<PiBridgePreparedPrompt>;
    validatePreparedPrompt(text, { ...value, backendKind: "pi" }, {
      backendKind: "pi",
      runtimeCapabilities: PI_RUNTIME_ADAPTER.capabilities,
      commands: pi.getCommands(),
    });
    return value as PiBridgePreparedPrompt;
  };
  const pendingClientMessageIds: string[] = [];
  const pendingClientMessageFingerprints = new Map<string, string>();
  /** Markers already assigned to a message_start but not finalized at message_end. */
  const inFlightClientMessageIds = new Set<string>();
  /** One-shot restart failures for a host that reconnects after an orphaned request. */
  const failedClientMessageIds = new Set<string>();

  const appendClientMessageMarker = (
    appendEntry: (customType: string, data?: unknown) => void,
    clientMessageId: string | undefined,
    correlationText?: string,
    preparedFingerprint?: string,
  ): boolean => {
    if (!clientMessageId) return false;
    const fingerprint = preparedFingerprint ?? (correlationText === undefined ? undefined : clientMessageFingerprint(correlationText, correlationSkillNames()));
    appendEntry(CLIENT_MESSAGE_MARKER, { clientMessageId, ...(fingerprint ? { fingerprint } : {}) });
    // Only expose a marker to correlation after Pi has durably accepted it.
    // This keeps a synchronous append failure from leaving an in-memory id
    // that can be assigned to a later, unrelated user message.
    pendingClientMessageIds.push(clientMessageId);
    if (fingerprint) pendingClientMessageFingerprints.set(clientMessageId, fingerprint);
    return true;
  };

  const cancelClientMessageMarker = (
    appendEntry: (customType: string, data?: unknown) => void,
    clientMessageId: string | undefined,
  ): boolean => {
    if (!clientMessageId) return false;
    const wasPending = pendingClientMessageIds.includes(clientMessageId);
    const wasInFlight = inFlightClientMessageIds.has(clientMessageId);
    if (!wasPending && !wasInFlight) return false;
    // Keep the claim live until Pi has accepted the append. This makes a
    // transient persistence failure retryable and prevents a later user turn
    // from claiming the orphaned request id.
    appendEntry(CLIENT_MESSAGE_CANCEL_MARKER, { clientMessageId });
    forgetClientMessageId(clientMessageId);
    return true;
  };

  const forgetClientMessageId = (clientMessageId: string): void => {
    for (;;) {
      const pending = pendingClientMessageIds.indexOf(clientMessageId);
      if (pending < 0) break;
      pendingClientMessageIds.splice(pending, 1);
    }
    inFlightClientMessageIds.delete(clientMessageId);
    pendingClientMessageFingerprints.delete(clientMessageId);
  };

  const trackedClientMessageIds = (): string[] => [...new Set([
    ...pendingClientMessageIds,
    ...inFlightClientMessageIds,
  ])];

  /** Only an id on a persisted user entry proves that the request was recorded. */
  const persistedClientMessageIds = (ctx: ExtensionContext): Set<string> => new Set(
    branchMessagesWithClientMessageIds(ctx.sessionManager.getBranch(), correlationSkillNames()).flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const value = message as { role?: unknown; clientMessageId?: unknown };
      return value.role === "user" && typeof value.clientMessageId === "string" && value.clientMessageId.length > 0
        ? [value.clientMessageId]
        : [];
    }),
  );

  const failClientMessageIfUnpersisted = (
    ctx: ExtensionContext,
    clientMessageId: string | undefined,
    appendEntry: (customType: string, data?: unknown) => void = (customType, data) => pi.appendEntry(customType, data),
  ): boolean => {
    if (!clientMessageId) return false;
    if (persistedClientMessageIds(ctx).has(clientMessageId)) {
      forgetClientMessageId(clientMessageId);
      return false;
    }
    const cancelled = cancelClientMessageMarker(appendEntry, clientMessageId);
    if (cancelled) broadcastUserMessageFailure(ctx, clientMessageId);
    return cancelled;
  };

  const settlePendingClientMessageIds = (ctx: ExtensionContext): void => {
    if (pendingClientMessageIds.length === 0 && inFlightClientMessageIds.size === 0) return;
    const persistedIds = persistedClientMessageIds(ctx);
    for (const clientMessageId of trackedClientMessageIds()) {
      if (persistedIds.has(clientMessageId)) {
        forgetClientMessageId(clientMessageId);
      } else {
        failClientMessageIfUnpersisted(ctx, clientMessageId);
      }
    }
    pendingClientMessageIds.length = 0;
    inFlightClientMessageIds.clear();
    pendingClientMessageFingerprints.clear();
  };

  const correlateUserMessageStart = (ctx: ExtensionContext, message: unknown): void => {
    if (!message || typeof message !== "object") return;
    const value = message as BridgeMessageObservation & Record<string, unknown>;
    if (value.role !== "user") return;
    const identity = bridgeTurns.claim(ctx.sessionManager.getSessionId(), value, value);
    if (identity) {
      value.tauClientTurnId = identity.clientTurnId;
      value.tauClientMessageId = identity.clientMessageId;
      value.clientTurnId ??= identity.clientTurnId;
      value.clientMessageId ??= identity.clientMessageId;
      const pending = pendingClientMessageIds.indexOf(identity.clientMessageId);
      if (pending >= 0) pendingClientMessageIds.splice(pending, 1);
      inFlightClientMessageIds.add(identity.clientMessageId);
      return;
    }
    if (typeof value.clientMessageId === "string") {
      const pending = pendingClientMessageIds.indexOf(value.clientMessageId);
      if (pending >= 0) {
        pendingClientMessageIds.splice(pending, 1);
        inFlightClientMessageIds.add(value.clientMessageId);
      }
      return;
    }
    const clientMessageId = matchClientMessageId(
      pendingClientMessageIds,
      pendingClientMessageFingerprints,
      message,
      correlationSkillNames(),
    );
    if (clientMessageId) {
      const pending = pendingClientMessageIds.indexOf(clientMessageId);
      if (pending >= 0) pendingClientMessageIds.splice(pending, 1);
      inFlightClientMessageIds.add(clientMessageId);
      (message as Record<string, unknown>).clientMessageId = clientMessageId;
    }
  };

  const branchMessagesWithEntryIds = (ctx: ExtensionContext): unknown[] => {
    const entries = ctx.sessionManager.getBranch();
    const messages = branchMessagesWithClientMessageIds(entries, correlationSkillNames());
    let messageIndex = 0;
    return entries.flatMap((entry) => {
      if (entry.type !== "message") return [];
      const record: Record<string, unknown> = {
        ...(messages[messageIndex++] as Record<string, unknown>),
        tauEntryId: entry.id,
      };
      if (record.role === "user") {
        const identity = bridgeTurns.identityForMessage(ctx.sessionManager.getSessionId(), record as BridgeMessageObservation)
          ?? bridgeTurns.identityForMessage(ctx.sessionManager.getSessionId(), entry.message as BridgeMessageObservation);
        if (identity) {
          record.tauClientTurnId = identity.clientTurnId;
          record.tauClientMessageId = identity.clientMessageId;
          record.clientTurnId ??= identity.clientTurnId;
          record.clientMessageId ??= identity.clientMessageId;
          bridgeTurns.remember(ctx.sessionManager.getSessionId(), record as BridgeMessageObservation, identity, entry.message as object, entry.id);
        } else {
          bridgeTurns.rememberEntry(ctx.sessionManager.getSessionId(), entry.id, entry.message as BridgeMessageObservation);
        }
      }
      return [record];
    });
  };

  const readToolOutputPage = (ctx: ExtensionContext, toolCallId: string, offset = 0): PiBridgeToolOutputPage | undefined =>
    toolOutputPageForMessages(branchMessages(ctx), toolCallId, offset);

  const normalizedTranscriptMessage = (message: unknown): { role: "user" | "assistant"; content: unknown } | undefined => {
    if (!message || typeof message !== "object") return undefined;
    const value = message as { role?: string; content?: unknown };
    if (value.role !== "user" && value.role !== "assistant") return undefined;
    if (value.role === "assistant") return { role: "assistant", content: value.content };
    const text = textFromContent(value.content);
    const presentation = skillMessagePresentation(text, PI_RUNTIME_ADAPTER, pi.getCommands());
    // Only a skill proven by Pi's live command registry may be projected to
    // its visible suffix. Unknown or malformed wrappers are user-authored
    // text and must remain byte-for-byte lossless in exports.
    const visibleText = presentation?.text;
    if (visibleText === undefined) return { role: "user", content: value.content };
    const images = Array.isArray(value.content)
      ? value.content.filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "image")
      : [];
    return {
      role: "user",
      content: [
        ...(visibleText ? [{ type: "text", text: visibleText }] : []),
        ...images,
      ],
    };
  };

  pi.registerCommand("tau-bridge-reload", {
    description: "Reload Pi resources for an attached Tau client",
    handler: async (_args, ctx) => ctx.reload(),
  });
  pi.registerCommand("tau-bridge-new", {
    description: "Create a new Pi session for an attached Tau client",
    handler: async (args, ctx) => {
      const decoded = args ? JSON.parse(Buffer.from(args, "base64url").toString("utf8")) as unknown : undefined;
      const payload = typeof decoded === "string"
        ? { initialPrompt: decoded }
        : decoded && typeof decoded === "object"
          ? decoded as { initialPrompt?: unknown; requestId?: unknown; clientTurnId?: unknown; clientMessageId?: unknown; prepared?: unknown; attachments?: unknown }
          : {};
      const initialPrompt = typeof payload.initialPrompt === "string" ? payload.initialPrompt : undefined;
      const requestId = typeof payload.requestId === "string" ? payload.requestId as NewThreadRequestId : undefined;
      const clientTurnId = typeof payload.clientTurnId === "string" ? payload.clientTurnId : undefined;
      const clientMessageId = typeof payload.clientMessageId === "string" ? payload.clientMessageId : undefined;
      const clientIdentity = resolveClientTurnIdentity({ clientTurnId, clientMessageId });
      const prepared = payload.prepared && typeof payload.prepared === "object" ? payload.prepared as PiBridgePreparedPrompt : undefined;
      const attachments = Array.isArray(payload.attachments) ? payload.attachments as UiPromptAttachment[] : [];
      if (attachments.length > 0 && !bridgeSupportsImageInput(ctx.model)) throw new Error("The active model does not support image input.");
      // Legacy bridge callers may submit a request-correlated prompt without
      // the skill preflight fields. Preserve that wire path; skill-aware
      // callers always provide a client id or prepared payload and are checked
      // against Pi's live registry.
      const resolved = initialPrompt !== undefined && (clientMessageId || prepared)
        ? resolvePreparedPrompt(initialPrompt, prepared)
        : undefined;
      if (clientIdentity && initialPrompt !== undefined) bridgeTurns.enqueueAny(clientIdentity, initialPrompt);
      let marker = false;
      let appendNewSessionEntry: ((customType: string, data?: unknown) => void) | undefined;
      try {
        if (requestId) {
          newSessionRequests.begin(requestId);
        }
        const result = await ctx.newSession({
          ...(initialPrompt !== undefined || attachments.length > 0 ? {
            // `setup` is the only replacement-session hook with a writable
            // SessionManager. Keep the marker in the new session before its
            // first user message is dispatched.
            setup: async (sessionManager) => {
              appendNewSessionEntry = (customType, data) => { sessionManager.appendCustomEntry(customType, data); };
              marker = appendClientMessageMarker(appendNewSessionEntry, clientMessageId, initialPrompt ?? "", resolved?.sourceFingerprint);
            },
            withSession: async (fresh) => {
              try {
                await fresh.sendUserMessage(bridgePromptContent(resolved?.runtimeText ?? initialPrompt ?? "", attachments), { expandPromptTemplates: true });
              } catch (error) {
                if (marker && appendNewSessionEntry) failClientMessageIfUnpersisted(fresh, clientMessageId, appendNewSessionEntry);
                if (clientIdentity) bridgeTurns.cancelAny(clientIdentity);
                throw error;
              }
            },
          } : {}),
        });
        if (result.cancelled) throw new Error("Pi cancelled creation of the new thread.");
      } catch (error) {
        if (requestId) {
          broadcast({ type: "new_session_failed", requestId, message: error instanceof Error ? error.message : String(error) }, ctx);
          newSessionRequests.remove(requestId);
        }
        if (marker && appendNewSessionEntry) failClientMessageIfUnpersisted(ctx, clientMessageId, appendNewSessionEntry);
        if (clientIdentity) bridgeTurns.cancelAny(clientIdentity);
        throw error;
      }
    },
  });
  pi.registerCommand("tau-bridge-fork", {
    description: "Fork the active Pi session for an attached Tau client",
    handler: async (entryId, ctx) => {
      if (!ctx.sessionManager.getBranch().some((entry) => entry.id === entryId)) {
        ctx.ui.notify("The selected message is no longer on the active branch.", "error");
        return;
      }
      await ctx.fork(entryId, { position: "at" });
    },
  });

  let server: Server | undefined;
  let descriptor: PiBridgeDescriptor | undefined;
  let latestContext: ExtensionContext | undefined;
  /**
   * Pi owns its own UI context while it owns the runtime, so an extension cannot
   * intercept another extension's question — it is answered in Pi's terminal.
   * What Tau can be told is that the thread is stalled on one.
   */
  let awaitingInput: PiBridgeAwaitingInput | undefined;
  let sequence = 0;
  const clients = new Set<ClientState>();
  const currentContext = (ctx: ExtensionContext): boolean => Boolean(descriptor
    && descriptor.sessionId === ctx.sessionManager.getSessionId());
  /** Answers of the kits' Pi halves, keyed `<extension id>/<command>`. */
  const extensionCommands = new Map<string, (ctx: ExtensionContext, input: Record<string, unknown>) => Promise<unknown>>();
  const pinProviders: Array<(ctx: ExtensionContext) => readonly string[]> = [];
  const turnObservers: PiKitTurnObserver[] = [];
  const send = (client: ClientState, frame: PiBridgeServerFrame) => {
    if (client.socket.destroyed) return;
    try {
      client.socket.write(encodePiBridgeFrame(frame));
    } catch {
      // A malformed/oversized extension payload must not escape an event hook
      // as an unhandled exception. The client can reconnect and request a
      // bounded snapshot after this connection is dropped.
      client.socket.destroy();
      clients.delete(client);
    }
  };

  const branchMessages = (ctx: ExtensionContext): unknown[] => ctx.sessionManager.getBranch()
    .flatMap((entry) => entry.type === "message" ? [{ ...entry.message, tauEntryId: entry.id }] : []);

  // A kit's card can anchor to an entry whose message renders empty; a pinned
  // entry stays in the page so the card survives.
  const pinnedEntryIdsFor = (ctx: ExtensionContext, messages: readonly unknown[]): string[] => {
    const ids = new Set(messages.flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const id = (message as { tauEntryId?: unknown }).tauEntryId;
      return typeof id === "string" ? [id] : [];
    }));
    return pinProviders.flatMap((pin) => [...pin(ctx)]).filter((id) => ids.has(id));
  };
  const snapshot = (ctx: ExtensionContext, paged = false): PiBridgeSnapshot => {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) throw new Error("Tau bridge requires a persisted Pi session.");
    const usage = ctx.getContextUsage();
    const view = transcriptView(ctx, paged
      ? { kind: "initial-page", turnLimit: INITIAL_TRANSCRIPT_TURN_LIMIT }
      : { kind: "legacy-snapshot", maxRecords: LEGACY_SNAPSHOT_RECORD_LIMIT });
    const correlatedBranch = branchMessagesWithEntryIds(ctx) as BridgeTranscriptRecord[];
    const bridgePage = bridgeTranscriptPage(correlatedBranch);
    const visibleMessages = paged ? bridgePage.page.messages as BridgeTranscriptRecord[] : view.visibleMessages;
    const newSessionRequestId = newSessionRequests.requestIdForSnapshot();
    const result: PiBridgeSnapshot = {
      threadId: ctx.sessionManager.getSessionId(),
      providerSessionId: ctx.sessionManager.getSessionId(),
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: file,
      cwd: ctx.cwd,
      sessionName: pi.getSessionName(),
      messages: boundedBridgeValue(visibleMessages),
      ...(view.cursorBeforeMessageId ? { cursorBeforeMessageId: view.cursorBeforeMessageId } : {}),
      ...(paged ? {
        capabilities: { transcriptPaging: true },
        ...(bridgePage.page.olderCursor ? { olderCursor: bridgePage.page.olderCursor } : {}),
        historyCompleteness: bridgePage.page.hasMore ? "has-more" : "complete",
      } : {}),
      isStreaming: !ctx.isIdle(),
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name } : undefined,
      runtimeCapabilities: PI_RUNTIME_ADAPTER.capabilities,
      failedClientMessageIds: failedClientMessageIds.size > 0 ? [...failedClientMessageIds] : undefined,
      models: ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
      thinkingLevel: pi.getThinkingLevel(),
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      activeTools: pi.getActiveTools(),
      allTools: pi.getAllTools().map((tool) => ({ name: tool.name, description: tool.description })),
      supportsImageInput: bridgeSupportsImageInput(ctx.model),
      activityMessages: boundedBridgeValue(bridgePage.activityMessages),
      turnActivityHistory: boundedBridgeValue(bridgePage.turnActivityHistory),
      turnActivityHistoryComplete: bridgePage.turnActivityHistoryComplete,
      // A snapshot exposes only the bounded raw tail; older anchors travel with
      // their own transcript page.
      pinnedEntryIds: pinnedEntryIdsFor(ctx, visibleMessages),
      composerCommands: pi.getCommands()
        .filter((command) => !command.name.startsWith("tau-bridge-"))
        .slice(0, MAX_BRIDGE_CATALOG_ITEMS)
        .map((command) => ({
          name: boundedCatalogText(command.name),
          description: boundedCatalogText(command.description),
          source: command.source,
          ...(command.source === "skill"
            ? { skillCommand: skillInvocationCommand(command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name, PI_RUNTIME_ADAPTER) }
            : {}),
        })),
      contextUsage: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : undefined,
      taskProgress: boundedBridgeValue(taskProgressFromMessages(correlatedBranch)),
      taskHistory: boundedBridgeValue(taskProgressHistoryFromMessages(bridgePage.activityMessages.concat(visibleMessages))),
      awaitingInput,
      ...(newSessionRequestId ? { newSessionRequestId } : {}),
    };
    // Bound the complete snapshot as a final guard against extension-provided
    // metadata. The transcript pager's 160-record ceiling is higher than the
    // generic array cap, so no cursor-visible records are dropped here.
    return boundedBridgePayload(result);
  };

  const transcriptPage = (ctx: ExtensionContext, cursor?: string): PiBridgeTranscriptPage => {
    const records = branchMessagesWithEntryIds(ctx) as BridgeTranscriptRecord[];
    const bridged = bridgeTranscriptPage(records, cursor);
    const page = {
      sessionId: ctx.sessionManager.getSessionId(),
      ...boundedBridgeValue(bridged.page),
      activityMessages: boundedBridgeValue(bridged.activityMessages),
      turnActivityHistory: boundedBridgeValue(bridged.turnActivityHistory),
      turnActivityHistoryComplete: bridged.turnActivityHistoryComplete,
      pinnedEntryIds: pinnedEntryIdsFor(ctx, bridged.page.messages),
      taskHistory: taskProgressHistoryFromMessages(bridged.activityMessages.concat(bridged.page.messages)),
    } satisfies PiBridgeTranscriptPage;
    return page;
  };

  const decorateEvent = (event: unknown, ctx: ExtensionContext): unknown => {
    if (!event || typeof event !== "object") return event;
    const value = event as { message?: unknown };
    if (!value.message || typeof value.message !== "object" || (value.message as { role?: unknown }).role !== "user") return event;
    const existing = value.message as BridgeMessageObservation & Record<string, unknown>;
    const sessionId = ctx.sessionManager.getSessionId();
    const identity = bridgeTurns.identityForMessage(sessionId, existing);
    if (identity) {
      return {
        ...value,
        message: {
          ...existing,
          clientTurnId: identity.clientTurnId,
          clientMessageId: identity.clientMessageId,
          tauClientTurnId: identity.clientTurnId,
          tauClientMessageId: identity.clientMessageId,
        },
      };
    }
    if (typeof existing.clientMessageId === "string") return event;
    const clientMessageId = clientMessageIdForMessage(ctx.sessionManager.getBranch(), value.message, correlationSkillNames())
      ?? matchClientMessageId(pendingClientMessageIds, pendingClientMessageFingerprints, value.message, correlationSkillNames());
    return clientMessageId ? { ...value, message: { ...existing, clientMessageId } } : event;
  };

  const finalizeUserMessage = (ctx: ExtensionContext, message: unknown): void => {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") return;
    const value = message as BridgeMessageObservation & Record<string, unknown>;
    const identity = bridgeTurns.claim(ctx.sessionManager.getSessionId(), value, value);
    if (identity) {
      value.clientTurnId = identity.clientTurnId;
      value.clientMessageId = identity.clientMessageId;
      value.tauClientTurnId = identity.clientTurnId;
      value.tauClientMessageId = identity.clientMessageId;
      forgetClientMessageId(identity.clientMessageId);
      return;
    }
    const clientMessageId = typeof value.clientMessageId === "string"
      ? value.clientMessageId
      : clientMessageIdForMessage(ctx.sessionManager.getBranch(), message, correlationSkillNames())
        ?? matchClientMessageId(pendingClientMessageIds, pendingClientMessageFingerprints, message, correlationSkillNames());
    if (clientMessageId) forgetClientMessageId(clientMessageId);
  };

  const broadcast = (event: unknown, ctx: ExtensionContext) => {
    if (!currentContext(ctx)) return;
    latestContext = ctx;
    if (!descriptor) return;
    const frame: PiBridgeServerFrame = {
      protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
      type: "event",
      epoch: descriptor.epoch,
      seq: ++sequence,
      sessionId: descriptor.sessionId,
      event: boundedBridgePayload(decorateEvent(event, ctx), MAX_BRIDGE_OUTBOUND_FRAME_BYTES - 64 * 1024),
    };
    for (const client of clients) if (client.authenticated) send(client, frame);
  };

  const broadcastExtensionEvent = (extensionId: string, name: string, payload: unknown, ctx: ExtensionContext): void => {
    const frame: PiBridgeExtensionEvent = { type: "extension-event", extensionId, name, payload };
    broadcast(frame, ctx);
  };

  const broadcastUserMessageFailure = (ctx: ExtensionContext, clientMessageId: string | undefined): void => {
    if (!clientMessageId) return;
    broadcast({
      type: "user_message_failed",
      clientMessageId,
      message: "Pi did not add the prompt to the transcript.",
    }, ctx);
  };

  const broadcastSnapshot = (ctx: ExtensionContext) => {
    if (!currentContext(ctx) || !descriptor) return;
    for (const client of clients) if (client.authenticated) {
      const frame: PiBridgeServerFrame = {
        protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
        type: "snapshot",
        epoch: descriptor.epoch,
        seq: ++sequence,
        snapshot: snapshot(ctx, client.transcriptPaging),
      };
      send(client, frame);
    }
  };

  const respond = (client: ClientState, id: string, ok: boolean, result?: unknown) => {
    if (!descriptor) return;
    send(client, ok
      ? { protocolVersion: PI_BRIDGE_PROTOCOL_VERSION, type: "response", id, epoch: descriptor.epoch, ok: true, result: boundedBridgePayload(result, MAX_BRIDGE_OUTBOUND_FRAME_BYTES - 64 * 1024) }
      : { protocolVersion: PI_BRIDGE_PROTOCOL_VERSION, type: "response", id, epoch: descriptor.epoch, ok: false, error: String(result) });
  };

  const handleFrame = async (client: ClientState, frame: PiBridgeClientFrame) => {
    if (!descriptor || frame.protocolVersion !== PI_BRIDGE_PROTOCOL_VERSION || frame.epoch !== descriptor.epoch) {
      client.socket.destroy();
      return;
    }
    if (!client.authenticated) {
      if (frame.type !== "hello" || frame.token !== descriptor.token || frame.expectedSessionId !== descriptor.sessionId) {
        client.socket.destroy();
        return;
      }
      client.transcriptPaging = transcriptPagingNegotiated(frame.capabilities);
      client.authenticated = true;
      const ctx = latestContext;
      if (!ctx) return client.socket.destroy();
      const readySnapshot = snapshot(ctx, client.transcriptPaging);
      send(client, {
        protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
        type: "ready",
        id: frame.id,
        epoch: descriptor.epoch,
        snapshot: readySnapshot,
      });
      if (readySnapshot.newSessionRequestId) newSessionRequests.markReady(readySnapshot.newSessionRequestId, readySnapshot.sessionId, descriptor.epoch);
      // The ready snapshot is the host's only chance to observe failures that
      // happened before it reconnected; do not repeat them in later snapshots.
      failedClientMessageIds.clear();
      return;
    }
    if (frame.type !== "command" || frame.expectedSessionId !== descriptor.sessionId) {
      client.socket.destroy();
      return;
    }
    const ctx = latestContext;
    if (!ctx) return respond(client, frame.id, false, "Pi session is unavailable.");
    const responseId = frame.id;
    try {
      switch (frame.command) {
        case "ping": respond(client, frame.id, true, { now: Date.now() }); break;
        case "snapshot": {
          const current = snapshot(ctx, client.transcriptPaging);
          respond(client, frame.id, true, current);
          if (current.newSessionRequestId) newSessionRequests.markReady(current.newSessionRequestId, current.sessionId, descriptor.epoch);
          break;
        }
        case "prepare_prompt": {
          respond(client, frame.id, true, preparedPrompt(frame.text, frame.skill));
          break;
        }
        case "prompt": {
          const resolved = resolvePreparedPrompt(frame.text, frame.prepared);
          if ((frame.attachments?.length ?? 0) > 0 && !bridgeSupportsImageInput(ctx.model)) {
            throw new Error("The active model does not support image input.");
          }
          const wasIdle = ctx.isIdle();
          const commandName = resolved.runtimeText.startsWith("/")
            ? resolved.runtimeText.slice(1).split(/[ \t\r\n]/u, 1)[0]
            : "";
          const isExtensionCommand = pi.getCommands().some((command) => command.source === "extension" && command.name === commandName);
          const clientIdentity = resolveClientTurnIdentity(frame)
            ?? (frame.clientMessageId ? { clientTurnId: frame.clientMessageId, clientMessageId: frame.clientMessageId } : undefined);
          const clientTurnId = clientIdentity?.clientTurnId ?? randomUUID();
          // A kit that captures the turn binds it here, before Pi dispatches it.
          if (!isExtensionCommand) for (const observer of turnObservers) observer.accepted(clientTurnId, ctx);
          // `pi.sendUserMessage` is a synchronous void dispatch. A successful
          // return is the transport acknowledgement; later persistence is
          // proven only by Pi's authoritative message events. Extension
          // commands do not create a user message, so they get no marker.
          const appendMarker = typeof pi.appendEntry === "function"
            ? (customType: string, data?: unknown) => pi.appendEntry(customType, data)
            : undefined;
          const marker = isExtensionCommand || !appendMarker
            ? false
            : appendClientMessageMarker(appendMarker, frame.clientMessageId, frame.text, resolved.sourceFingerprint);
          if (!isExtensionCommand && clientIdentity) bridgeTurns.enqueue(ctx.sessionManager.getSessionId(), clientIdentity, frame.text);
          try {
            pi.sendUserMessage(bridgePromptContent(resolved.runtimeText, frame.attachments), {
              ...(wasIdle ? {} : { deliverAs: frame.deliverAs ?? "followUp" }),
              expandPromptTemplates: true,
            });
          } catch (error) {
            if (!isExtensionCommand) for (const observer of turnObservers) observer.failed(clientTurnId, ctx);
            if (clientIdentity) bridgeTurns.cancel(ctx.sessionManager.getSessionId(), clientIdentity);
            if (marker) failClientMessageIfUnpersisted(ctx, frame.clientMessageId);
            throw error;
          }
          respond(client, frame.id, true, { accepted: true });
          break;
        }
        case "abort": ctx.abort(); respond(client, frame.id, true); break;
        case "set_thinking": pi.setThinkingLevel(frame.level as Parameters<typeof pi.setThinkingLevel>[0]); respond(client, frame.id, true); break;
        case "set_model": {
          const model = ctx.modelRegistry.find(frame.provider, frame.id);
          if (!model || !(await pi.setModel(model))) throw new Error("Model is unavailable or not authenticated.");
          respond(client, frame.id, true);
          break;
        }
        case "compact": ctx.compact({ onComplete: () => broadcastSnapshot(ctx) }); respond(client, frame.id, true); break;
        case "reload":
          if (!ctx.isIdle()) throw new Error("Wait for the active run before reloading Pi.");
          respond(client, frame.id, true, { accepted: true });
          setTimeout(() => pi.sendUserMessage("/tau-bridge-reload", { expandPromptTemplates: true }), 0);
          break;
        case "set_session_name": pi.setSessionName(frame.name); respond(client, frame.id, true); break;
        case "export_markdown": {
          const messages = ctx.sessionManager.getBranch()
            .flatMap((entry) => entry.type === "message" ? [normalizedTranscriptMessage(entry.message)] : []);
          if (Buffer.byteLength(JSON.stringify(messages), "utf8") > MAX_BRIDGE_OUTBOUND_FRAME_BYTES - 1024) {
            throw new Error("This thread is too large to copy through the Tau bridge.");
          }
          respond(client, frame.id, true, {
            title: pi.getSessionName(),
            cwd: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            messages: messages.flatMap((message) => message ? [message] : []),
          });
          break;
        }
        case "extension": {
          const handler = extensionCommands.get(`${frame.extensionId}/${frame.name}`);
          if (!handler) throw new Error(`Pi has no "${frame.name}" command for extension ${frame.extensionId}.`);
          const input = frame.input && typeof frame.input === "object" ? frame.input as Record<string, unknown> : {};
          respond(client, frame.id, true, await handler(ctx, input));
          break;
        }
        case "new_session": {
          if (!ctx.isIdle()) throw new Error("Wait for the active run before creating a new thread.");
          // Only a registered command receives ExtensionCommandContext. The
          // socket callback deliberately dispatches that command instead of
          // pretending its event context has command-only session methods.
          if ((frame.attachments?.length ?? 0) > 0 && !bridgeSupportsImageInput(ctx.model)) {
            throw new Error("The active model does not support image input.");
          }
          const identity = resolveClientTurnIdentity(frame) ?? frame.clientMessageId;
          pi.sendUserMessage(bridgeNewSessionCommand(frame.initialPrompt, frame.requestId, identity, frame.prepared, frame.attachments), { expandPromptTemplates: true });
          respond(client, frame.id, true, { accepted: true, requestId: frame.requestId ?? frame.id });
          break;
        }
        case "new_session_ack": {
          if (frame.sessionId !== ctx.sessionManager.getSessionId() || frame.bridgeEpoch !== descriptor.epoch) {
            throw new Error("The new-thread acknowledgement does not match this Pi session.");
          }
          if (!newSessionRequests.acknowledge(frame.requestId, frame.sessionId, frame.bridgeEpoch)) throw new Error("The new-thread acknowledgement is stale or uncorrelated.");
          respond(client, frame.id, true, {
            accepted: true,
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            bridgeEpoch: frame.bridgeEpoch,
          });
          break;
        }
        case "new_session_abort": {
          if (frame.sessionId !== ctx.sessionManager.getSessionId() || frame.bridgeEpoch !== descriptor.epoch) {
            throw new Error("The new-thread abort does not match this Pi session.");
          }
          if (!newSessionRequests.abort(frame.requestId, frame.sessionId, frame.bridgeEpoch)) throw new Error("The new-thread abort is stale or uncorrelated.");
          respond(client, frame.id, true, { accepted: true, requestId: frame.requestId, sessionId: frame.sessionId, bridgeEpoch: frame.bridgeEpoch });
          break;
        }
        case "transcript_page":
          if (!client.transcriptPaging) {
            respond(client, frame.id, false, "Transcript paging was not negotiated by this v1 client.");
            break;
          }
          respond(client, frame.id, true, transcriptPage(ctx, frame.cursor));
          break;
        case "read_tool_output":
          respond(client, frame.id, true, readToolOutputPage(ctx, frame.toolCallId, frame.offset));
          break;
        case "fork": {
          if (!ctx.isIdle()) throw new Error("Wait for the active run before forking this thread.");
          if (!ctx.sessionManager.getBranch().some((entry) => entry.id === frame.entryId)) {
            throw new Error("The selected message is no longer on the active branch.");
          }
          respond(client, frame.id, true, { accepted: true });
          setTimeout(() => {
            pi.sendUserMessage(`/tau-bridge-fork ${frame.entryId}`, { expandPromptTemplates: true });
          }, 0);
          break;
        }
        default:
          respond(client, responseId, false, `Unsupported Pi bridge command. Reload Pi to update the Tau bridge (protocol ${PI_BRIDGE_PROTOCOL_VERSION}).`);
      }
    } catch (error) {
      respond(client, frame.id, false, error instanceof Error ? error.message : String(error));
    }
  };

  const stop = async () => {
    const closing = descriptor;
    descriptor = undefined;
    latestContext = undefined;
    for (const client of clients) client.socket.destroy();
    clients.clear();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    if (closing) {
      if (process.platform !== "win32") await rm(closing.socketPath, { force: true }).catch(() => undefined);
      const descriptorPath = join(getAgentDir(), "tau-bridge", "sessions", `${closing.sessionId}.json`);
      try {
        const current = JSON.parse(await readFile(descriptorPath, "utf8")) as { epoch?: string };
        if (current.epoch === closing.epoch) await rm(descriptorPath, { force: true });
      } catch { /* already gone */ }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await stop();
    for (const clientMessageId of unclaimedClientMessageIds(ctx.sessionManager.getBranch(), correlationSkillNames())) {
      pi.appendEntry(CLIENT_MESSAGE_CANCEL_MARKER, { clientMessageId });
      failedClientMessageIds.add(clientMessageId);
    }
    pendingClientMessageIds.length = 0;
    inFlightClientMessageIds.clear();
    pendingClientMessageFingerprints.clear();
    if (ctx.mode !== "tui") return;
    // A kit whose prebuilt Pi half did not load has lost its feature here; say
    // so once, in the terminal that owns this session.
    for (const failure of kitFailures.splice(0)) ctx.ui.notify(`Tau kit ${failure.path} did not load: ${failure.message}`, "error");
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    latestContext = ctx;
    sequence = 0;
    const epoch = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const suffix = createHash("sha256").update(`${ctx.sessionManager.getSessionId()}:${epoch}`).digest("hex").slice(0, 20);
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\tau-pi-${process.env.USERNAME ?? "user"}-${suffix}`
      : join(tmpdir(), `tau-pi-${process.getuid?.() ?? "user"}-${suffix}.sock`);
    if (process.platform !== "win32") await rm(socketPath, { force: true }).catch(() => undefined);
    server = createServer((socket) => {
      const client: ClientState = { socket, authenticated: false, buffer: "", transcriptPaging: false };
      clients.add(client);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        client.buffer += chunk;
        if (Buffer.byteLength(client.buffer, "utf8") > PI_BRIDGE_MAX_FRAME_BYTES) return socket.destroy();
        for (;;) {
          const newline = client.buffer.indexOf("\n");
          if (newline < 0) break;
          const line = client.buffer.slice(0, newline);
          client.buffer = client.buffer.slice(newline + 1);
          if (!line) continue;
          try { void handleFrame(client, JSON.parse(line) as PiBridgeClientFrame); }
          catch { socket.destroy(); }
        }
      });
      socket.on("close", () => clients.delete(client));
      socket.on("error", () => clients.delete(client));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, () => { server!.off("error", reject); resolve(); });
    });
    const descriptorDir = join(getAgentDir(), "tau-bridge", "sessions");
    await mkdir(descriptorDir, { recursive: true, mode: 0o700 });
    await chmod(descriptorDir, 0o700);
    descriptor = {
      protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
      epoch,
      threadId: ctx.sessionManager.getSessionId(),
      providerSessionId: ctx.sessionManager.getSessionId(),
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile,
      cwd: ctx.cwd,
      pid: process.pid,
      socketPath,
      token,
      startedAt: Date.now(),
    };
    const descriptorPath = join(descriptorDir, `${descriptor.sessionId}.json`);
    const tempPath = join(dirname(descriptorPath), `.${descriptor.sessionId}.${epoch}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, descriptorPath);
  });

  const onAny = pi.on as unknown as (
    eventName: string,
    handler: (event: Record<string, unknown>, ctx: ExtensionContext) => void | Promise<void>,
  ) => void;
  for (const eventName of [
    "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end", "queue_update", "model_select",
    "thinking_level_select", "ui_prompt_start", "ui_prompt_end",
  ] as const) onAny(eventName, async (event, ctx) => {
    if (eventName === "message_start" && event.message && (event.message as { role?: unknown }).role === "user") {
      correlateUserMessageStart(ctx, event.message);
    }
    if (eventName === "message_end" && event.message && (event.message as { role?: unknown }).role === "user") {
      finalizeUserMessage(ctx, event.message);
    }
    // A queued follow-up can make an inner agent turn settle while Pi is still
    // running. Do not cancel its marker until the runtime is genuinely idle.
    if (eventName === "agent_settled" && ctx.isIdle()) settlePendingClientMessageIds(ctx);
    broadcast({ ...event, type: eventName }, ctx);
    if (eventName === "message_end" || eventName === "agent_settled" || eventName === "model_select" || eventName === "thinking_level_select") {
      broadcastSnapshot(ctx);
    }
  });

  const kitBridge = (extensionId: string): PiKitBridge => ({
    extensionId,
    registerCommand: (name, handler) => { extensionCommands.set(`${extensionId}/${name}`, handler); },
    publishEvent: (name, payload, ctx) => broadcastExtensionEvent(extensionId, name, payload, ctx),
    refreshSnapshot: (ctx) => broadcastSnapshot(ctx),
    pinEntries: (pin) => { pinProviders.push(pin); },
    observeUserTurns: (observer) => { turnObservers.push(observer); },
    transcript: (ctx) => ctx.sessionManager.getBranch().flatMap((entry) => {
      const message = entry.type === "message" ? normalizedTranscriptMessage(entry.message) : undefined;
      return message ? [message satisfies PiKitTranscriptMessage] : [];
    }),
    openSession: (file) => {
      try {
        // In memory: Pi's open could repair a file another process is writing.
        const manager = readSessionFile(file);
        return { sessionId: manager.getSessionId(), cwd: manager.getCwd(), entries: manager.getBranch() };
      } catch {
        return undefined;
      }
    },
    isCurrentSession: (ctx) => currentContext(ctx),
  });
  const kits = options.kits ?? loadPiKitExtensions(piKitsRoot(BRIDGE_FILE));
  const kitFailures = [...kits.errors];
  for (const kit of kits.extensions) {
    try { kit.extension(pi, kitBridge(kit.id)); }
    catch (error) { kitFailures.push({ path: kit.file, message: error instanceof Error ? error.message : String(error) }); }
  }

  pi.on("session_info_changed", (event, ctx) => { broadcast({ ...event, type: "session_info_changed" }, ctx); broadcastSnapshot(ctx); });
  // Pi blocks here until the question in its terminal is answered. Tau cannot
  // answer it, but it can stop pretending the thread is merely "working".
  pi.on("ui_prompt_start", (event, ctx) => {
    awaitingInput = { kind: event.kind as PiBridgeAwaitingInput["kind"], title: event.title };
    broadcastSnapshot(ctx);
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    awaitingInput = undefined;
    broadcastSnapshot(ctx);
  });
  pi.on("session_shutdown", async () => {
    newSessionRequests.clear();
    pendingClientMessageIds.length = 0;
    inFlightClientMessageIds.clear();
    pendingClientMessageFingerprints.clear();
    await stop();
  });
}
