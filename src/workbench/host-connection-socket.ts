import {
  HOST_ERROR,
  decodeHostServerFrame,
  type HostPush,
  type HostResponse,
} from "../shared/host-transport";
import { HostConnection, type HostTransport } from "./host-connection";
import { createHostClient, type HostClient } from "./host-client";

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
const OUTBOX_LIMIT = 100;
/** `host-transport-socket.ts` closes with this when the hello carried the wrong token, or its access was taken away. */
const UNAUTHORIZED = 4401;

export interface SocketTransportOptions {
  /**
   * The host refused the token. Retrying cannot help, so the transport stops
   * and the client asks for another one instead of reconnecting forever.
   * `reason` is `ACCESS_CLOSE_REASON`'s: refused, revoked or rotated away.
   */
  onUnauthorized?(reason: string): void;
  /** The token changed under the open connection (a rotation this client asked for); keep it where the next start reads it. */
  onTokenChanged?(token: string): void;
}

interface Pending {
  resolve(response: HostResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The same protocol over a local socket. A dropped link is expected here: the
 * transport reconnects with backoff and the connection above replays what it
 * missed, so a frozen or restarted host does not lose the workbench's state.
 */
export function createSocketHostTransport(url: string, initialToken?: string, options?: SocketTransportOptions): HostTransport {
  let token = initialToken;
  const pending = new Map<string, Pending>();
  const pushListeners = new Set<(push: HostPush) => void>();
  const openListeners = new Set<() => void>();
  const closeListeners = new Set<() => void>();
  const outbox: string[] = [];
  let socket: WebSocket | undefined;
  let counter = 0;
  let everOpened = false;
  let closed = false;
  let delayMs = RECONNECT_MIN_MS;

  const send = (frame: unknown): void => {
    const text = JSON.stringify(frame);
    if (socket?.readyState === WebSocket.OPEN) socket.send(text);
    else {
      if (outbox.length >= OUTBOX_LIMIT) outbox.shift();
      outbox.push(text);
    }
  };

  const failPending = (message: string): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    pending.clear();
  };

  const connect = (): void => {
    if (closed) return;
    socket = new WebSocket(url);
    socket.onopen = () => {
      delayMs = RECONNECT_MIN_MS;
      for (const text of outbox.splice(0)) socket?.send(text);
      // The first open is the caller's own hello; later ones need recovery.
      if (everOpened) for (const listener of openListeners) listener();
      everOpened = true;
    };
    socket.onclose = (event?: { code?: number; reason?: string }) => {
      failPending("The host connection dropped.");
      for (const listener of closeListeners) listener();
      if (closed) return;
      if (event?.code === UNAUTHORIZED) {
        closed = true;
        options?.onUnauthorized?.(event.reason ?? "");
        return;
      }
      setTimeout(connect, delayMs);
      delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      let parsed: unknown;
      let id: string | undefined;
      try {
        parsed = JSON.parse(event.data);
        // Try to extract id even if the frame is malformed
        if (parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "string") {
          id = parsed.id;
        } else if (parsed && typeof parsed === "object" && "response" in parsed) {
          const resp = parsed.response as { id?: string };
          if (typeof resp?.id === "string") id = resp.id;
        }
      } catch (error) {
        // Malformed JSON: cannot extract id, log and drop
        console.error("Host sent invalid JSON:", error);
        return;
      }
      const frame = decodeHostServerFrame(parsed);
      if (!frame) {
        // Valid JSON but undecodable frame shape
        if (id) {
          const request = pending.get(id);
          if (request) {
            pending.delete(id);
            clearTimeout(request.timer);
            request.reject(new Error(`${HOST_ERROR.invalidResponse}: undecodable frame`));
          }
        }
        console.error("Host sent undecodable frame:", parsed);
        return;
      }
      if (frame.type === "push") {
        for (const listener of pushListeners) listener(frame.push);
        return;
      }
      // Calls into a window go to the window's own process, never to a page.
      if (frame.type === "client-call" || frame.type === "pair-reply") return;
      const frameId = frame.type === "response" ? frame.response.id : frame.id;
      const request = pending.get(frameId);
      if (!request) return;
      pending.delete(frameId);
      clearTimeout(request.timer);
      request.resolve(frame.type === "response" ? frame.response : { id: frameId, result: frame.reply });
    };
  };
  connect();

  return {
    platform: "remote",
    request: (method, params) => new Promise<HostResponse>((resolve, reject) => {
      counter += 1;
      const id = `c${counter}`;
      const timer = setTimeout(() => {
        const request = pending.get(id);
        if (request) {
          pending.delete(id);
          request.reject(new Error(`${HOST_ERROR.timeout}: request timed out after ${REQUEST_TIMEOUT_MS}ms`));
        }
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      // Hello carries the token and is answered before any method runs.
      if (method === "hello") {
        const hello = (params[0] ?? {}) as Record<string, unknown>;
        send({ type: "hello", id, hello: { ...hello, ...(token ? { token } : {}) } });
        return;
      }
      send({ type: "request", request: { id, method, params } });
    }),
    onPush: (listener) => { pushListeners.add(listener); return () => pushListeners.delete(listener); },
    onOpen: (listener) => { openListeners.add(listener); return () => openListeners.delete(listener); },
    onClose: (listener) => { closeListeners.add(listener); return () => closeListeners.delete(listener); },
    close: () => {
      closed = true;
      failPending(`The host connection was closed (${HOST_ERROR.cancelled}).`);
      socket?.close();
    },
    updateToken: (next) => {
      token = next;
      options?.onTokenChanged?.(next);
    },
  };
}

/**
 * A host client that talks to a host over a socket instead of through Electron.
 * `local` is the client's own machine, when it has one: a desktop window whose
 * host runs in another process keeps answering `CLIENT_SIDE_METHODS` there.
 */
export function createSocketHostClient(
  url: string,
  token?: string,
  options?: SocketTransportOptions,
  local?: HostConnection,
): { client: HostClient; connection: HostConnection } {
  const connection = new HostConnection(createSocketHostTransport(url, token, options));
  return { client: createHostClient(connection, local), connection };
}
