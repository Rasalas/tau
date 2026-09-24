import type { HostEvent, UiMessage, UiToolRun } from "./contracts.js";
import { isHostUpdate, type HostUpdate } from "./host-protocol.js";
import type { ToolOutputDelta } from "./tool-output-delta.js";
import { isPairingCommitment, isPairingNonce, type HostPairReply, type HostPairRequest } from "./pairing.js";

/**
 * The client-to-host protocol. Electron IPC is one transport for it, a local
 * socket is another; both carry the same frames and the same method names.
 * Method names are the former IPC channels without their `tau:` prefix.
 */
export const HOST_TRANSPORT_VERSION = 1;

/** Largest frame a socket transport accepts: a prompt with 80 MiB of images, base64, fits. */
export const HOST_TRANSPORT_MAX_FRAME_BYTES = 112 * 1024 * 1024;

/** How many bytes of pushes a host keeps for a reconnecting client. */
export const HOST_PUSH_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Methods the machine a client runs on answers for itself: its clipboard, the
 * files it can preview or hand the page by URL, the workbench build it started from, the notifications,
 * the icon badge and the context menus its OS draws. A host in another
 * process — or on another machine — has none of that, so a client that speaks
 * to one routes these to its own transport instead (ADR 0021).
 */
export const CLIENT_SIDE_METHODS = [
  "copy-text",
  "copy-image",
  "read-image-preview",
  "share-file",
  "desktop-extensions",
  "rebuild-workbench",
  "workbench-source",
  "relaunch-workbench",
  "install-update",
  "notify",
  "set-badge",
  "context-menu",
  "window-action",
] as const;

export const isClientSideMethod = (method: string): boolean =>
  (CLIENT_SIDE_METHODS as readonly string[]).includes(method);

export interface HostErrorInfo {
  message: string;
  code: string;
}

/** Params travel positionally, in the order of the matching `HostClient` method. */
export interface HostRequest {
  id: string;
  method: string;
  params: readonly unknown[];
}

export interface HostResponse {
  id: string;
  result?: unknown;
  error?: HostErrorInfo;
}

/** A long host operation reports through pushes instead of one late response. */
export type HostJobEvent =
  | { type: "job-progress"; jobId: string; message: string; fraction?: number }
  | { type: "job-done"; jobId: string; result?: unknown; error?: HostErrorInfo };

/**
 * A running tool's output as a change to the output the push numbered `after`
 * carried. Only the transport speaks it: `HostConnection` turns it back into a
 * `tool-update`, or drops it when it never saw that push.
 */
export interface HostToolOutputDeltaEvent extends ToolOutputDelta {
  type: "tool-update-delta";
  sessionId: string;
  id: string;
  after: number;
}

/**
 * A `tool-end` whose output is a change to the output the push numbered
 * `after` carried, usually none. `length` is the output's length, for a client
 * that never saw that push: it shows the output as deferred and loads it.
 */
export interface HostToolEndDeltaEvent extends ToolOutputDelta {
  type: "tool-end-delta";
  sessionId: string;
  /** The tool without its `output`. */
  tool: UiToolRun;
  after: number;
  length: number;
}

/** An `assistant-end` whose `text` and `thinking` are changes to what the message streamed as of push `after`. */
export interface HostAssistantEndDeltaEvent {
  type: "assistant-end-delta";
  sessionId: string;
  /** The message without `text` and `thinking`. */
  message: Omit<UiMessage, "text" | "thinking">;
  after: number;
  text: ToolOutputDelta;
  thinking?: ToolOutputDelta;
}

/**
 * A `thread-detail` without what the client has: `turnActivity` is the last history entry
 * (`activityFromHistory`); a message named in `texts` takes the text of that `assistant-end` push.
 */
export interface HostCompactThreadDetailEvent {
  type: "thread-detail-compact";
  update: Extract<HostUpdate, { type: "thread-detail" }>;
  activityFromHistory?: true;
  texts?: Record<string, number>;
}

/** Events only the transport speaks; `HostConnection` turns them back into `HostEvent`s. */
export type HostWireEvent = HostToolOutputDeltaEvent | HostToolEndDeltaEvent | HostAssistantEndDeltaEvent | HostCompactThreadDetailEvent;

/** Everything a host pushes: workbench events and job progress share one sequence. */
export type HostPushEvent = HostEvent | HostJobEvent | HostWireEvent;

export interface HostPush {
  seq: number;
  event: HostPushEvent;
  /**
   * The last push this connection was sent before this one, when that is not
   * `seq - 1`: the pushes between were about threads or topics it does not
   * subscribe to, so they are no gap. Only on a live push to a subscribed client.
   */
  prev?: number;
}

/**
 * What a client shows, so the host sends it the live events of those threads
 * and topics only. Everything without a thread or topic (the index, run
 * state, catalogs, questions) still goes to every client.
 */
export interface HostSubscription {
  /** Session ids whose streamed messages, tools and details this client receives. */
  threads: string[];
  /** Extension events published with a topic, as `<extensionId>/<topic>`. */
  topics: string[];
  /**
   * New-thread requests this client awaits: the thread whose first detail
   * answers one is sent to it from then on, before the client knows its id.
   */
  requests?: string[];
}

export interface HostHello {
  protocol: number;
  /** Required by a socket transport, ignored by the in-process Electron one. */
  token?: string;
  /** Highest sequence the client has seen; absent for a first connection. */
  lastSeq?: number;
  /** Which client this is (`desktop`, `web`, `compact`), for a host extension that counts them. */
  profile?: string;
  /**
   * A connection that is not a client of its own: the window process around a
   * renderer that already said hello, or a supervisor's probe (ADR 0021). The
   * host serves it but does not count it among its clients.
   */
  auxiliary?: boolean;
  /**
   * Shared by a window's renderer and the window's own process, so a call a
   * renderer causes reaches the window it sits in. Random per window.
   */
  windowId?: string;
  /** The extensions whose window half this connection runs; read only when `auxiliary`. */
  windowHalves?: string[];
  /**
   * What this connection receives from here on, and what a replay after
   * `lastSeq` is filtered by. Absent: every push, as before subscriptions.
   */
  subscription?: HostSubscription;
}

/** A call from the host into one client's process: the window half of an extension (ADR 0021, ADR 0023). */
export interface HostClientCall {
  callId: string;
  extensionId: string;
  command: string;
  input?: unknown;
}

export interface HostHelloReply {
  protocol: number;
  hostVersion: string;
  capabilities: string[];
  /** True when the client's `lastSeq` fell out of the buffer: refetch everything. */
  resync: boolean;
  missed: HostPush[];
  /** Sequence the next push will use, so a resyncing client can skip ahead. */
  nextSeq: number;
  /** Set for a device paired Read only: every call that changes something is refused (ADR 0024). */
  access?: "read-only";
}

export type HostClientFrame =
  | { type: "hello"; id: string; hello: HostHello }
  | { type: "request"; request: HostRequest }
  /** Asks to pair before any hello; answered with one or more `pair-reply` frames of the same id (ADR 0024). */
  | { type: "pair"; id: string; pair: HostPairRequest }
  /** The nonce a `pair` request committed to, after the host's `challenge`. */
  | { type: "pair-reveal"; id: string; nonce: string }
  /** A heartbeat; only after the hello was answered, and only to a host that announced `heartbeat`. */
  | { type: "ping"; id: string };

export type HostServerFrame =
  | { type: "hello-reply"; id: string; reply: HostHelloReply }
  | { type: "response"; response: HostResponse }
  | { type: "push"; push: HostPush }
  /** Sent to one connection only, outside the push sequence: never replayed, never seen by another client. */
  | { type: "client-call"; call: HostClientCall }
  | { type: "pair-reply"; id: string; reply: HostPairReply }
  | { type: "pong"; id: string };

/**
 * Close codes a socket host uses. A client stops for `unauthorized` and
 * `forbiddenOrigin`, since retrying cannot help; any other close is a drop.
 */
export const HOST_CLOSE_CODE = {
  /** The hello carried no token or the wrong one, or its access was taken away. */
  unauthorized: 4401,
  /** The page that opened the socket is not one this host serves or trusts. */
  forbiddenOrigin: 4403,
  /** No hello arrived in time after the socket opened. */
  helloTimeout: 4408,
} as const;

export const HOST_ERROR = {
  invalidRequest: "invalid-request",
  unknownMethod: "unknown-method",
  unauthorized: "unauthorized",
  /** Authenticated, but not allowed this: a paired client asking to manage access. */
  forbidden: "forbidden",
  cancelled: "cancelled",
  /** The method exists in the protocol but not in this host. */
  unsupported: "unsupported",
  failed: "failed",
  timeout: "timeout",
  invalidResponse: "invalid-response",
} as const;

/** Capability names a host may announce in its hello reply. */
export const HOST_CAPABILITY = {
  /** `start-job`, `cancel-job` and `job-methods` are available. */
  jobs: "jobs",
  /** Pushes are buffered, so a reconnect can replay instead of resyncing. */
  replay: "replay",
  /** Paths in commands and results are paths of the machine the client runs on. */
  localFiles: "local-files",
  /** The host answers `ping` with `pong`, so a client can tell a live link from a half-open one. */
  heartbeat: "heartbeat",
  /**
   * The host reads `subscription` in the hello and answers the `subscribe`
   * method, which replaces it (`[HostSubscription | null]`, null for every push).
   */
  subscriptions: "subscriptions",
} as const;

/** `host-extension` invocations are named per extension command, not per method. */
export function jobMethodKey(method: string, extensionId?: string, command?: string): string {
  return extensionId && command ? `${method}:${extensionId}/${command}` : method;
}

// Hand-written decoders, in the style of host-protocol.ts: no library, and a
// rejected frame is never echoed back to whoever sent it.

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function decodeErrorInfo(value: unknown): HostErrorInfo | undefined {
  const item = record(value);
  if (!item || typeof item.message !== "string" || !nonEmptyString(item.code)) return undefined;
  return { message: item.message, code: item.code };
}

export function decodeHostRequest(value: unknown): HostRequest | undefined {
  const item = record(value);
  if (!item || !nonEmptyString(item.id) || !nonEmptyString(item.method)) return undefined;
  if (item.params !== undefined && !Array.isArray(item.params)) return undefined;
  return { id: item.id, method: item.method, params: (item.params as unknown[] | undefined) ?? [] };
}

export function decodeHostResponse(value: unknown): HostResponse | undefined {
  const item = record(value);
  if (!item || !nonEmptyString(item.id)) return undefined;
  if (item.error === undefined) return { id: item.id, result: item.result };
  const error = decodeErrorInfo(item.error);
  return error ? { id: item.id, error } : undefined;
}

const MAX_WINDOW_ID = 128;
const MAX_WINDOW_HALVES = 256;
const MAX_SUBSCRIBED = 512;
const MAX_SUBSCRIPTION_KEY = 512;

function isKeyList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_SUBSCRIBED
    && value.every((entry) => nonEmptyString(entry) && entry.length <= MAX_SUBSCRIPTION_KEY);
}

export function decodeHostSubscription(value: unknown): HostSubscription | undefined {
  const item = record(value);
  if (!item || !isKeyList(item.threads) || !isKeyList(item.topics)) return undefined;
  if (item.requests !== undefined && !isKeyList(item.requests)) return undefined;
  return {
    threads: [...item.threads],
    topics: [...item.topics],
    ...(Array.isArray(item.requests) && item.requests.length > 0 ? { requests: [...item.requests as string[]] } : {}),
  };
}

/** The key a topic travels under in a subscription. */
export const hostTopicKey = (extensionId: string, topic: string): string => `${extensionId}/${topic}`;

export function decodeHostHello(value: unknown): HostHello | undefined {
  const item = record(value);
  if (!item || item.protocol !== HOST_TRANSPORT_VERSION) return undefined;
  if (item.token !== undefined && typeof item.token !== "string") return undefined;
  if (item.lastSeq !== undefined && !Number.isSafeInteger(item.lastSeq)) return undefined;
  if (item.profile !== undefined && typeof item.profile !== "string") return undefined;
  if (item.auxiliary !== undefined && typeof item.auxiliary !== "boolean") return undefined;
  if (item.windowId !== undefined && !(nonEmptyString(item.windowId) && item.windowId.length <= MAX_WINDOW_ID)) return undefined;
  if (item.windowHalves !== undefined && !isWindowHalves(item.windowHalves)) return undefined;
  const subscription = item.subscription === undefined ? undefined : decodeHostSubscription(item.subscription);
  if (item.subscription !== undefined && !subscription) return undefined;
  return {
    protocol: HOST_TRANSPORT_VERSION,
    ...(typeof item.token === "string" ? { token: item.token } : {}),
    ...(typeof item.lastSeq === "number" ? { lastSeq: item.lastSeq } : {}),
    ...(typeof item.profile === "string" ? { profile: item.profile } : {}),
    ...(item.auxiliary === true ? { auxiliary: true } : {}),
    ...(typeof item.windowId === "string" ? { windowId: item.windowId } : {}),
    ...(Array.isArray(item.windowHalves) ? { windowHalves: [...item.windowHalves as string[]] } : {}),
    ...(subscription ? { subscription } : {}),
  };
}

function isWindowHalves(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_WINDOW_HALVES
    && value.every((entry) => nonEmptyString(entry) && entry.length <= MAX_WINDOW_ID);
}

function decodeHostClientCall(value: unknown): HostClientCall | undefined {
  const item = record(value);
  if (!item || !nonEmptyString(item.callId) || !nonEmptyString(item.extensionId) || !nonEmptyString(item.command)) return undefined;
  return {
    callId: item.callId,
    extensionId: item.extensionId,
    command: item.command,
    ...(item.input === undefined ? {} : { input: item.input }),
  };
}

export function isHostJobEvent(event: HostPushEvent): event is HostJobEvent {
  return event.type === "job-progress" || event.type === "job-done";
}

const count = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;

function isToolOutputDelta(item: Record<string, unknown>): boolean {
  return typeof item.sessionId === "string" && nonEmptyString(item.id) && count(item.after)
    && count(item.keep) && count(item.drop) && typeof item.text === "string";
}

function isToolEndDelta(item: Record<string, unknown>): boolean {
  const tool = record(item.tool);
  return typeof item.sessionId === "string" && Boolean(tool && nonEmptyString(tool.id)) && count(item.after)
    && count(item.keep) && count(item.drop) && typeof item.text === "string" && count(item.length);
}

function isTextDelta(value: unknown): boolean {
  const item = record(value);
  return Boolean(item && count(item.keep) && count(item.drop) && typeof item.text === "string");
}

function isAssistantEndDelta(item: Record<string, unknown>): boolean {
  const message = record(item.message);
  return typeof item.sessionId === "string" && Boolean(message && nonEmptyString(message.id)) && count(item.after)
    && isTextDelta(item.text) && (item.thinking === undefined || isTextDelta(item.thinking));
}

function isCompactDetail(item: Record<string, unknown>): boolean {
  if (!isHostUpdate(item.update) || item.update.type !== "thread-detail") return false;
  if (item.activityFromHistory !== undefined && item.activityFromHistory !== true) return false;
  if (item.texts === undefined) return true;
  const texts = record(item.texts);
  return Boolean(texts && Object.values(texts).every((seq) => count(seq) && (seq as number) > 0));
}

function decodePushEvent(value: unknown): HostPushEvent | undefined {
  const item = record(value);
  if (!item || !nonEmptyString(item.type)) return undefined;
  // A contradictory update must never reach the renderer's state machine.
  if (item.type === "host-update" && !isHostUpdate(item.update)) return undefined;
  if ((item.type === "job-progress" || item.type === "job-done") && !nonEmptyString(item.jobId)) return undefined;
  if (item.type === "job-progress" && typeof item.message !== "string") return undefined;
  if (item.type === "tool-update-delta" && !isToolOutputDelta(item)) return undefined;
  if (item.type === "tool-end-delta" && !isToolEndDelta(item)) return undefined;
  if (item.type === "assistant-end-delta" && !isAssistantEndDelta(item)) return undefined;
  if (item.type === "thread-detail-compact" && !isCompactDetail(item)) return undefined;
  return item as unknown as HostPushEvent;
}

export function decodeHostPush(value: unknown): HostPush | undefined {
  const item = record(value);
  if (!item || !Number.isSafeInteger(item.seq) || (item.seq as number) < 1) return undefined;
  if (item.prev !== undefined && !(count(item.prev) && (item.prev as number) < (item.seq as number))) return undefined;
  const event = decodePushEvent(item.event);
  if (!event) return undefined;
  return { seq: item.seq as number, event, ...(item.prev === undefined ? {} : { prev: item.prev as number }) };
}

export function decodeHostHelloReply(value: unknown): HostHelloReply | undefined {
  const item = record(value);
  if (!item || item.protocol !== HOST_TRANSPORT_VERSION) return undefined;
  if (typeof item.hostVersion !== "string" || typeof item.resync !== "boolean") return undefined;
  if (!Number.isSafeInteger(item.nextSeq)) return undefined;
  if (!Array.isArray(item.capabilities) || !item.capabilities.every((entry) => typeof entry === "string")) return undefined;
  const missedFrames = Array.isArray(item.missed) ? item.missed.map(decodeHostPush) : [];
  if (missedFrames.some((push) => push === undefined)) return undefined;
  return {
    protocol: HOST_TRANSPORT_VERSION,
    hostVersion: item.hostVersion,
    capabilities: item.capabilities as string[],
    resync: item.resync,
    missed: missedFrames as HostPush[],
    nextSeq: item.nextSeq as number,
    ...(item.access === "read-only" ? { access: "read-only" as const } : {}),
  };
}

const MAX_PAIR_CODE = 256;
const MAX_DEVICE_NAME = 200;

function decodePairRequest(value: unknown): HostPairRequest | undefined {
  const item = record(value);
  if (!item) return undefined;
  if (item.code !== undefined && !(nonEmptyString(item.code) && item.code.length <= MAX_PAIR_CODE)) return undefined;
  if (item.name !== undefined && !(typeof item.name === "string" && item.name.length <= MAX_DEVICE_NAME)) return undefined;
  if (item.commitment !== undefined && !isPairingCommitment(item.commitment)) return undefined;
  return {
    ...(typeof item.code === "string" ? { code: item.code } : {}),
    ...(typeof item.name === "string" && item.name.trim() ? { name: item.name } : {}),
    ...(typeof item.commitment === "string" ? { commitment: item.commitment } : {}),
  };
}

const PAIR_REFUSALS = new Set(["unknown-code", "busy", "rate-limited", "invalid"]);

export function decodePairReply(value: unknown): HostPairReply | undefined {
  const item = record(value);
  if (!item) return undefined;
  switch (item.state) {
    case "challenge":
      return nonEmptyString(item.requestId) && isPairingNonce(item.hostNonce)
        ? { state: "challenge", requestId: item.requestId, hostNonce: item.hostNonce } : undefined;
    case "waiting":
      return nonEmptyString(item.requestId) && /^\d{6}$/u.test(String(item.verification)) && typeof item.expiresAt === "string"
        ? { state: "waiting", requestId: item.requestId, verification: String(item.verification), expiresAt: item.expiresAt } : undefined;
    case "approved":
      return nonEmptyString(item.token) && nonEmptyString(item.clientId) && (item.access === "full" || item.access === "read-only")
        ? { state: "approved", token: item.token, clientId: item.clientId, access: item.access } : undefined;
    case "denied":
    case "expired":
      return { state: item.state };
    case "refused":
      return typeof item.reason === "string" && PAIR_REFUSALS.has(item.reason)
        ? {
          state: "refused",
          reason: item.reason as Extract<HostPairReply, { state: "refused" }>["reason"],
          ...(count(item.retryAfterMs) ? { retryAfterMs: item.retryAfterMs as number } : {}),
        }
        : undefined;
    default:
      return undefined;
  }
}

export function decodeHostClientFrame(value: unknown): HostClientFrame | undefined {
  const item = record(value);
  if (!item) return undefined;
  if (item.type === "hello") {
    const hello = decodeHostHello(item.hello);
    return hello && nonEmptyString(item.id) ? { type: "hello", id: item.id, hello } : undefined;
  }
  if (item.type === "request") {
    const request = decodeHostRequest(item.request);
    return request ? { type: "request", request } : undefined;
  }
  if (item.type === "pair") {
    const pair = decodePairRequest(item.pair);
    return pair && nonEmptyString(item.id) ? { type: "pair", id: item.id, pair } : undefined;
  }
  if (item.type === "pair-reveal") {
    return nonEmptyString(item.id) && isPairingNonce(item.nonce) ? { type: "pair-reveal", id: item.id, nonce: item.nonce } : undefined;
  }
  if (item.type === "ping") return nonEmptyString(item.id) && item.id.length <= MAX_WINDOW_ID ? { type: "ping", id: item.id } : undefined;
  return undefined;
}

export function decodeHostServerFrame(value: unknown): HostServerFrame | undefined {
  const item = record(value);
  if (!item) return undefined;
  if (item.type === "hello-reply") {
    const reply = decodeHostHelloReply(item.reply);
    return reply && nonEmptyString(item.id) ? { type: "hello-reply", id: item.id, reply } : undefined;
  }
  if (item.type === "response") {
    const response = decodeHostResponse(item.response);
    return response ? { type: "response", response } : undefined;
  }
  if (item.type === "push") {
    const push = decodeHostPush(item.push);
    return push ? { type: "push", push } : undefined;
  }
  if (item.type === "client-call") {
    const call = decodeHostClientCall(item.call);
    return call ? { type: "client-call", call } : undefined;
  }
  if (item.type === "pair-reply") {
    const reply = decodePairReply(item.reply);
    return reply && nonEmptyString(item.id) ? { type: "pair-reply", id: item.id, reply } : undefined;
  }
  if (item.type === "pong") return nonEmptyString(item.id) ? { type: "pong", id: item.id } : undefined;
  return undefined;
}

/** Turns any thrown value into the error a response carries. */
export function hostErrorInfo(error: unknown, code?: string): HostErrorInfo {
  const embedded = (error as { code?: unknown } | null)?.code;
  const resolvedCode = code ?? (typeof embedded === "string" ? embedded : HOST_ERROR.failed);
  return { message: error instanceof Error ? error.message : String(error), code: resolvedCode };
}
