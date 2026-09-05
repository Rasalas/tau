import type { HostEvent } from "./contracts.js";
import { isHostUpdate } from "./host-protocol.js";

/**
 * The client-to-host protocol. Electron IPC is one transport for it, a local
 * socket is another; both carry the same frames and the same method names.
 * Method names are the former IPC channels without their `tau:` prefix.
 */
export const HOST_TRANSPORT_VERSION = 1;

/** Largest frame a socket transport accepts; prompt attachments are the big ones. */
export const HOST_TRANSPORT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** How many pushes a host keeps for a reconnecting client. */
export const HOST_PUSH_BUFFER_SIZE = 500;

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

/** Everything a host pushes: workbench events and job progress share one sequence. */
export type HostPushEvent = HostEvent | HostJobEvent;

export interface HostPush {
  seq: number;
  event: HostPushEvent;
}

export interface HostHello {
  protocol: number;
  /** Required by a socket transport, ignored by the in-process Electron one. */
  token?: string;
  /** Highest sequence the client has seen; absent for a first connection. */
  lastSeq?: number;
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
}

export type HostClientFrame =
  | { type: "hello"; id: string; hello: HostHello }
  | { type: "request"; request: HostRequest };

export type HostServerFrame =
  | { type: "hello-reply"; id: string; reply: HostHelloReply }
  | { type: "response"; response: HostResponse }
  | { type: "push"; push: HostPush };

export const HOST_ERROR = {
  invalidRequest: "invalid-request",
  unknownMethod: "unknown-method",
  unauthorized: "unauthorized",
  cancelled: "cancelled",
  /** The method exists in the protocol but not in this host. */
  unsupported: "unsupported",
  failed: "failed",
} as const;

/** Capability names a host may announce in its hello reply. */
export const HOST_CAPABILITY = {
  /** `start-job`, `cancel-job` and `job-methods` are available. */
  jobs: "jobs",
  /** Pushes are buffered, so a reconnect can replay instead of resyncing. */
  replay: "replay",
  /** Paths in commands and results are paths of the machine the client runs on. */
  localFiles: "local-files",
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

export function decodeHostHello(value: unknown): HostHello | undefined {
  const item = record(value);
  if (!item || item.protocol !== HOST_TRANSPORT_VERSION) return undefined;
  if (item.token !== undefined && typeof item.token !== "string") return undefined;
  if (item.lastSeq !== undefined && !Number.isSafeInteger(item.lastSeq)) return undefined;
  return {
    protocol: HOST_TRANSPORT_VERSION,
    ...(typeof item.token === "string" ? { token: item.token } : {}),
    ...(typeof item.lastSeq === "number" ? { lastSeq: item.lastSeq } : {}),
  };
}

export function isHostJobEvent(event: HostPushEvent): event is HostJobEvent {
  return event.type === "job-progress" || event.type === "job-done";
}

function decodePushEvent(value: unknown): HostPushEvent | undefined {
  const item = record(value);
  if (!item || !nonEmptyString(item.type)) return undefined;
  // A contradictory update must never reach the renderer's state machine.
  if (item.type === "host-update" && !isHostUpdate(item.update)) return undefined;
  if ((item.type === "job-progress" || item.type === "job-done") && !nonEmptyString(item.jobId)) return undefined;
  if (item.type === "job-progress" && typeof item.message !== "string") return undefined;
  return item as unknown as HostPushEvent;
}

export function decodeHostPush(value: unknown): HostPush | undefined {
  const item = record(value);
  if (!item || !Number.isSafeInteger(item.seq) || (item.seq as number) < 1) return undefined;
  const event = decodePushEvent(item.event);
  return event ? { seq: item.seq as number, event } : undefined;
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
  };
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
  return undefined;
}

/** Turns any thrown value into the error a response carries. */
export function hostErrorInfo(error: unknown, code: string = HOST_ERROR.failed): HostErrorInfo {
  return { message: error instanceof Error ? error.message : String(error), code };
}
