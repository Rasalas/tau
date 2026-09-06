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

interface Pending {
  resolve(response: HostResponse): void;
  reject(error: Error): void;
}

/**
 * The same protocol over a local socket. A dropped link is expected here: the
 * transport reconnects with backoff and the connection above replays what it
 * missed, so a frozen or restarted host does not lose the workbench's state.
 */
export function createSocketHostTransport(url: string, token?: string): HostTransport {
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
    else outbox.push(text);
  };

  const failPending = (message: string): void => {
    for (const request of pending.values()) request.reject(new Error(message));
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
    socket.onclose = () => {
      failPending("The host connection dropped.");
      for (const listener of closeListeners) listener();
      if (closed) return;
      setTimeout(connect, delayMs);
      delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      const frame = decodeHostServerFrame(JSON.parse(event.data) as unknown);
      if (!frame) return;
      if (frame.type === "push") {
        for (const listener of pushListeners) listener(frame.push);
        return;
      }
      const id = frame.type === "response" ? frame.response.id : frame.id;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      request.resolve(frame.type === "response" ? frame.response : { id, result: frame.reply });
    };
  };
  connect();

  return {
    platform: "remote",
    request: (method, params) => new Promise<HostResponse>((resolve, reject) => {
      counter += 1;
      const id = `c${counter}`;
      pending.set(id, { resolve, reject });
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
  };
}

/** A host client that talks to a host over a socket instead of through Electron. */
export function createSocketHostClient(url: string, token?: string): { client: HostClient; connection: HostConnection } {
  const connection = new HostConnection(createSocketHostTransport(url, token));
  return { client: createHostClient(connection), connection };
}
