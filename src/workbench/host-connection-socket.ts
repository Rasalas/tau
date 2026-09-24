import {
  HOST_CAPABILITY,
  HOST_CLOSE_CODE,
  HOST_ERROR,
  decodeHostServerFrame,
  type HostPush,
  type HostResponse,
} from "../shared/host-transport";
import { HostConnection, type HostTransport } from "./host-connection";
import { createHostClient, type HostClient } from "./host-client";
import type { HostLink, HostWake, HostWakeSource } from "./host-link";

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 3_000;
/** While the device reports no network, attempts slow down; coming back online tries at once. */
const RECONNECT_OFFLINE_MAX_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
const OUTBOX_LIMIT = 100;
/** A connect that hangs (a dead address, a network that went away mid-handshake) is given up. */
export const SOCKET_CONNECT_TIMEOUT_MS = 10_000;
/** An open socket whose hello stays unanswered is dropped, so recovery starts over on a new one. */
export const SOCKET_HELLO_TIMEOUT_MS = 15_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** How long a heartbeat may go unanswered before the link counts as dead. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;
/** Shorter after a wake: the user is looking, and a dead link should be replaced quickly. */
export const WAKE_PROBE_TIMEOUT_MS = 3_000;

export interface SocketTransportOptions {
  /**
   * The host refused the token. Retrying cannot help, so the transport stops
   * and the client asks for another one instead of reconnecting forever.
   * `reason` is `ACCESS_CLOSE_REASON`'s: refused, revoked or rotated away.
   */
  onUnauthorized?(reason: string): void;
  /** The host refused the page this client runs in (its origin). Final, like `onUnauthorized`. */
  onOriginRefused?(): void;
  /** The token changed under the open connection (a rotation this client asked for); keep it where the next start reads it. */
  onTokenChanged?(token: string): void;
  /** When the socket may have died silently. Without one, only heartbeats notice. */
  wakes?: HostWakeSource;
}

interface Pending {
  resolve(response: HostResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Probe {
  id: string;
  sentAt: number;
  /** `received` when the ping went out. */
  received: number;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The same protocol over a socket. A dropped link is expected here: the
 * transport reconnects with backoff and the connection above replays what it
 * missed, so a frozen or restarted host does not lose the workbench's state.
 * A link can also die without a close (a phone that slept or changed
 * networks), so the transport sends heartbeats, probes after every wake and
 * gives up on a connect or a hello that hangs.
 */
export function createSocketHostTransport(url: string, initialToken?: string, options?: SocketTransportOptions): HostTransport {
  let token = initialToken;
  const pending = new Map<string, Pending>();
  const pushListeners = new Set<(push: HostPush) => void>();
  const openListeners = new Set<() => void>();
  const closeListeners = new Set<() => void>();
  const linkListeners = new Set<(link: HostLink) => void>();
  const outbox: Array<{ text: string; hello: boolean }> = [];
  let socket: WebSocket | undefined;
  let counter = 0;
  let everOpened = false;
  let closed = false;
  let delayMs = RECONNECT_MIN_MS;
  let offline = false;
  let link: HostLink = { phase: "connecting", attempts: 0 };
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let probe: Probe | undefined;
  /** Set once this socket's hello was answered by a host that answers pings. */
  let heartbeat = false;
  /** Frames the current socket delivered. */
  let received = 0;
  let stopWakes: (() => void) | undefined;

  const setLink = (next: Partial<HostLink>): void => {
    const merged: HostLink = { ...link, ...next };
    if (merged.phase !== "waiting" && merged.phase !== "offline") delete merged.retryAt;
    if (merged.phase === link.phase && merged.roundTripMs === link.roundTripMs
      && merged.attempts === link.attempts && merged.retryAt === link.retryAt) return;
    link = merged;
    for (const listener of linkListeners) listener(link);
  };

  const armHello = (): void => {
    clearTimeout(helloTimer);
    const current = socket;
    helloTimer = setTimeout(() => { if (socket === current) abandon(); }, SOCKET_HELLO_TIMEOUT_MS);
  };

  const write = (text: string, hello: boolean): void => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(text);
      if (hello) armHello();
      return;
    }
    if (outbox.length >= OUTBOX_LIMIT) outbox.shift();
    outbox.push({ text, hello });
  };

  const failPending = (message: string): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    pending.clear();
  };

  const stopTimers = (): void => {
    clearTimeout(connectTimer);
    clearTimeout(helloTimer);
    clearInterval(heartbeatTimer);
    if (probe) clearTimeout(probe.timer);
    probe = undefined;
    heartbeat = false;
  };

  const schedule = (): void => {
    const delay = delayMs;
    delayMs = Math.min(delayMs * 2, offline ? RECONNECT_OFFLINE_MAX_MS : RECONNECT_MAX_MS);
    setLink({ phase: offline ? "offline" : "waiting", attempts: link.attempts + 1, retryAt: Date.now() + delay });
    retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, delay);
  };

  /** The socket is gone, by a close event or because this client gave up on it. */
  const lost = (code?: number, reason?: string): void => {
    stopTimers();
    socket = undefined;
    failPending("The host connection dropped.");
    for (const listener of closeListeners) listener();
    if (closed) return;
    if (code === HOST_CLOSE_CODE.unauthorized || code === HOST_CLOSE_CODE.forbiddenOrigin) {
      closed = true;
      stopWakes?.();
      setLink({ phase: "closed" });
      if (code === HOST_CLOSE_CODE.unauthorized) options?.onUnauthorized?.(reason ?? "");
      else options?.onOriginRefused?.();
      return;
    }
    schedule();
  };

  /** Stops waiting for a socket that may never report its own death. */
  const abandon = (): void => {
    const current = socket;
    if (!current) return;
    current.onopen = null;
    current.onclose = null;
    current.onmessage = null;
    try { current.close(); } catch { /* already closing */ }
    lost();
  };

  /** One heartbeat; anything the host sends before the deadline proves the link. */
  const sendProbe = (timeoutMs: number): void => {
    if (!socket || !heartbeat) return;
    if (probe) {
      if (probe.timeoutMs <= timeoutMs) return;
      clearTimeout(probe.timer);
    }
    counter += 1;
    const id = `p${counter}`;
    const sentAt = Date.now();
    const current = socket;
    const timer = setTimeout(() => {
      if (socket !== current || probe?.id !== id) return;
      const answered = received > probe.received;
      probe = undefined;
      if (answered) return;
      // Fired far too late: the page was frozen, not the link. Ask again.
      if (Date.now() - sentAt > timeoutMs * 2 + 1_000) { sendProbe(timeoutMs); return; }
      abandon();
    }, timeoutMs);
    probe = { id, sentAt, received, timeoutMs, timer };
    current.send(JSON.stringify({ type: "ping", id }));
  };

  const connect = (): void => {
    if (closed) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    const current = new WebSocket(url);
    socket = current;
    setLink({ phase: "connecting" });
    connectTimer = setTimeout(() => { if (socket === current && current.readyState !== WebSocket.OPEN) abandon(); }, SOCKET_CONNECT_TIMEOUT_MS);
    current.onopen = () => {
      clearTimeout(connectTimer);
      delayMs = RECONNECT_MIN_MS;
      received = 0;
      // A socket that opened contradicts an `offline` that no `online` followed.
      offline = false;
      setLink({ phase: "open", attempts: 0 });
      for (const { text, hello } of outbox.splice(0)) {
        current.send(text);
        if (hello) armHello();
      }
      // The first open is the caller's own hello; later ones need recovery.
      if (everOpened) for (const listener of openListeners) listener();
      everOpened = true;
    };
    current.onclose = (event?: { code?: number; reason?: string }) => lost(event?.code, event?.reason);
    current.onmessage = (event: MessageEvent<string>) => {
      received += 1;
      receive(event.data);
    };
  };

  const receive = (data: string): void => {
    let parsed: unknown;
    let id: string | undefined;
    try {
      parsed = JSON.parse(data);
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
    if (frame.type === "client-call") return;
    if (frame.type === "pong") {
      if (probe?.id !== frame.id) return;
      clearTimeout(probe.timer);
      setLink({ roundTripMs: Date.now() - probe.sentAt });
      probe = undefined;
      return;
    }
    if (frame.type === "hello-reply") {
      clearTimeout(helloTimer);
      if (!heartbeat && frame.reply.capabilities.includes(HOST_CAPABILITY.heartbeat)) {
        heartbeat = true;
        heartbeatTimer = setInterval(() => sendProbe(HEARTBEAT_TIMEOUT_MS), HEARTBEAT_INTERVAL_MS);
      }
    }
    const frameId = frame.type === "response" ? frame.response.id : frame.id;
    const request = pending.get(frameId);
    if (!request) return;
    pending.delete(frameId);
    clearTimeout(request.timer);
    request.resolve(frame.type === "response" ? frame.response : { id: frameId, result: frame.reply });
  };

  /** Checks the link at a moment it may have died, and skips the wait when it is down. */
  const wake = (kind: HostWake): void => {
    if (closed) return;
    if (kind === "offline") {
      offline = true;
      if (link.phase === "waiting") setLink({ phase: "offline" });
      sendProbe(WAKE_PROBE_TIMEOUT_MS);
      return;
    }
    if (kind === "online") offline = false;
    if (retryTimer !== undefined || !socket) {
      delayMs = RECONNECT_MIN_MS;
      connect();
      return;
    }
    // A handshake begun on the network the device just left will not finish.
    if (socket.readyState !== WebSocket.OPEN && kind !== "foreground") {
      abandon();
      clearTimeout(retryTimer);
      retryTimer = undefined;
      delayMs = RECONNECT_MIN_MS;
      connect();
      return;
    }
    sendProbe(WAKE_PROBE_TIMEOUT_MS);
  };
  connect();
  stopWakes = options?.wakes?.(wake);

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
        write(JSON.stringify({ type: "hello", id, hello: { ...hello, ...(token ? { token } : {}) } }), true);
        return;
      }
      write(JSON.stringify({ type: "request", request: { id, method, params } }), false);
    }),
    onPush: (listener) => { pushListeners.add(listener); return () => pushListeners.delete(listener); },
    onOpen: (listener) => { openListeners.add(listener); return () => openListeners.delete(listener); },
    onClose: (listener) => { closeListeners.add(listener); return () => closeListeners.delete(listener); },
    getLink: () => link,
    onLink: (listener) => { linkListeners.add(listener); return () => linkListeners.delete(listener); },
    retryNow: () => wake("foreground"),
    close: () => {
      closed = true;
      stopWakes?.();
      clearTimeout(retryTimer);
      stopTimers();
      failPending(`The host connection was closed (${HOST_ERROR.cancelled}).`);
      setLink({ phase: "closed" });
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
  let connection: HostConnection | undefined = undefined;
  const transport = createSocketHostTransport(url, token, {
    ...options,
    onOriginRefused: options?.onOriginRefused
      ?? (() => connection?.refuse("This host does not accept connections from this page's address. Open the client from the host's own address, or add this one to TAU_HOST_ALLOWED_ORIGINS on the host.")),
  });
  connection = new HostConnection(transport);
  return { client: createHostClient(connection, local), connection };
}
