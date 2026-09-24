import type { Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { Server as TlsServer } from "node:tls";
import { WebSocketServer, type WebSocket } from "ws";
import {
  HOST_CAPABILITY,
  HOST_CLOSE_CODE,
  HOST_ERROR,
  HOST_TRANSPORT_MAX_FRAME_BYTES,
  decodeHostClientFrame,
  hostErrorInfo,
  type HostClientCall,
  type HostPush,
  type HostServerFrame,
} from "../shared/host-transport.js";
import { ACCESS_CLOSE_REASON } from "../shared/connections.js";
import { helloReply, type HostPushLog } from "./host-push-log.js";
import { invokeHostMethod, type HostMethodTable } from "./host-methods.js";
import { hostTokenMatches } from "./host-token.js";
import type { AccessPeer, HostCredential } from "./host-access.js";
import type { HostInvocationPrincipal } from "./host-invocation.js";
import { assertListenAllowed, parseListen } from "./host-listen.js";
import { isLoopbackPeer, socketCapabilities } from "./host-local-files.js";
import { originAllowed } from "./host-origin.js";
import type { ClientPeer } from "./client-calls.js";
import type { HostClientSink } from "./host-transport-clients.js";
import type { HostLogger } from "./host-log.js";

const UNAUTHORIZED = HOST_CLOSE_CODE.unauthorized;
/** A socket that has not said hello by then is closed. */
export const SOCKET_HELLO_TIMEOUT_MS = 10_000;
/**
 * How often the host pings every socket at the WebSocket level. A peer that
 * has not answered the previous ping by the next one is gone (a phone that
 * slept or changed networks) and is dropped, so it stops counting as a client.
 */
export const SOCKET_PING_INTERVAL_MS = 30_000;

/** What the transport asks of the host's access model; `HostAccess` implements it. */
export interface SocketAccess {
  authenticate(token: string | undefined): HostCredential | undefined;
  /** Answers the connection's id; `close` ends it when its access is revoked or rotated away. */
  attach(credential: HostCredential, peer: AccessPeer, close: (reason: string) => void): string;
  touch(connectionId: string): void;
  detach(connectionId: string): void;
}

/** One secret and nothing else: the shape of a host before per-client tokens. */
function tokenOnlyAccess(token: string): SocketAccess {
  let counter = 0;
  return {
    authenticate: (offered) => (hostTokenMatches(token, offered) ? { kind: "owner" } : undefined),
    attach: () => `socket-${++counter}`,
    touch: () => undefined,
    detach: () => undefined,
  };
}

export interface SocketHostTransportOptions {
  /** `host:port` as `TAU_HOST_LISTEN` gives it; port 0 picks a free one. */
  listen: string;
  methods: HostMethodTable;
  pushLog: HostPushLog;
  hostVersion: string;
  capabilities: string[];
  /** The secret from `~/.tau/host-token`; every client repeats it in its hello. Ignored when `access` is given. */
  token?: string;
  /** The host token and the paired clients' tokens (ADR 0023). */
  access?: SocketAccess;
  /** `TAU_HOST_INSECURE=1`: bind a public interface although nothing is encrypted. */
  allowNonLoopback?: boolean;
  /** Speak TLS with this certificate; any interface may then be bound. */
  tls?: { cert: string; key: string };
  /**
   * An HTTP server to upgrade on instead of a socket of its own. A host that
   * also serves the web client gives its one here, so the browser reaches the
   * page and the protocol at the same origin and the same port. With `tls` it
   * must be an HTTPS server built from the same certificate.
   */
  attachTo?: Server;
  /** Where attached clients are reported; without one the host counts nobody. */
  clients?: HostClientSink;
  /** Told about every authenticated connection, so a call into a window can pick one; `ClientCalls` implements it. */
  calls?: { attach(connection: string, peer: ClientPeer): void; detach(connection: string): void };
  /** Runs before every reply, so pushes still waiting to be coalesced reach the client first. */
  beforeReply?(): void;
  /** A client starts from a snapshot, not a replay: its first hello, or a resync. */
  onSnapshotClient?(): void;
  /** Page origins accepted besides the listener's own and Electron's local `file://` (`hostAllowedOrigins`). */
  allowedOrigins?: readonly string[];
  /** Defaults to `SOCKET_HELLO_TIMEOUT_MS`. */
  helloTimeoutMs?: number;
  /** Runs `tick` every `SOCKET_PING_INTERVAL_MS` by default; answers a stop. Tests tick by hand. */
  schedulePings?(tick: () => void): () => void;
  logger?: HostLogger;
}

/**
 * Compression for every frame. With context takeover (the `ws` default) the
 * window spans frames, so the small ones compress too and no threshold applies.
 */
export const SOCKET_PER_MESSAGE_DEFLATE = true;

export interface SocketHostTransport {
  readonly port: number;
  /** `wss:` or `ws:`, whichever this listener speaks. */
  readonly scheme: "wss" | "ws";
  /** Set when the listener runs without TLS beyond loopback; the caller prints it. */
  readonly warning?: string;
  deliver(push: HostPush): void;
  /** Sends a call to that connection alone; false when it is gone. */
  sendCall(connection: string, call: HostClientCall): boolean;
  close(): Promise<void>;
}

/**
 * The same method table over a local socket. Nothing runs before the hello is
 * accepted, so an unauthenticated peer can neither call a method nor observe
 * a push. Without `tls` confidentiality is a tunnel's job (ADR 0010) and a
 * public interface is refused unless the operator insists; with it, the
 * listener is an HTTPS server and the token never travels in clear text.
 */
export async function startSocketHostTransport(options: SocketHostTransportOptions): Promise<SocketHostTransport> {
  const bind = parseListen(options.listen);
  const { warning } = assertListenAllowed(bind, { encrypted: options.tls !== undefined, insecure: options.allowNonLoopback === true });
  if (warning) options.logger?.warn("host-transport-socket.insecure", { host: bind.host });
  if (options.tls && options.attachTo && !(options.attachTo instanceof TlsServer)) {
    throw new Error("A TLS listener cannot attach to a plain HTTP server; build the web client's server with the same certificate.");
  }
  const { host, port } = bind;
  const http = options.attachTo ?? (options.tls ? createTlsUpgradeServer(options.tls) : undefined);
  const settings = { maxPayload: HOST_TRANSPORT_MAX_FRAME_BYTES, perMessageDeflate: SOCKET_PER_MESSAGE_DEFLATE };
  const server = http
    ? new WebSocketServer({ server: http, ...settings })
    : new WebSocketServer({ host, port, ...settings });
  if (!options.access && !options.token) throw new Error("A socket listener needs a host token or an access model.");
  const access = options.access ?? tokenOnlyAccess(options.token!);
  /** Every authenticated socket, with the principal its requests run as. */
  const authenticated = new Map<WebSocket, { connection: string; principal: HostInvocationPrincipal }>();
  /** The id the client registry knows a socket by, while it is authenticated. */
  const clientIds = new Map<WebSocket, string>();
  const sockets = new Map<string, WebSocket>();
  const forget = (socket: WebSocket): void => {
    const session = authenticated.get(socket);
    authenticated.delete(socket);
    if (session) {
      sockets.delete(session.connection);
      access.detach(session.connection);
      options.calls?.detach(session.connection);
    }
    const clientId = clientIds.get(socket);
    if (clientId === undefined) return;
    clientIds.delete(socket);
    options.clients?.detached(clientId);
  };

  const send = (socket: WebSocket, frame: HostServerFrame): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };
  /** A response goes after every push its method caused, even one still being coalesced. */
  const respond = (socket: WebSocket, response: HostServerFrame): void => {
    options.beforeReply?.();
    send(socket, response);
  };

  /** Sockets that answered the last WebSocket ping, or sent anything since. */
  const alive = new WeakSet<WebSocket>();

  server.on("connection", (socket, request) => {
    const origin = request.headers.origin;
    if (!originAllowed({ origin, host: request.headers.host, peerAddress: request.socket.remoteAddress }, options.allowedOrigins)) {
      options.logger?.warn("host-transport-socket.origin-refused", { origin });
      socket.close(HOST_CLOSE_CODE.forbiddenOrigin, "origin not allowed");
      return;
    }
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    const helloTimer = setTimeout(() => {
      if (!authenticated.has(socket)) socket.close(HOST_CLOSE_CODE.helloTimeout, "no hello");
    }, options.helloTimeoutMs ?? SOCKET_HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    // Only a peer on this machine may be told that the host's files are local.
    const capabilities = [...socketCapabilities(options.capabilities, request.socket.remoteAddress), HOST_CAPABILITY.heartbeat];
    socket.on("message", (data) => {
      alive.add(socket);
      let payload: unknown;
      try { payload = JSON.parse(String(data)) as unknown; }
      catch { socket.close(UNAUTHORIZED, "malformed frame"); return; }
      const frame = decodeHostClientFrame(payload);
      if (!frame) {
        options.logger?.warn("host-transport-socket.malformed-frame");
        socket.close(UNAUTHORIZED, "malformed frame");
        return;
      }
      if (frame.type === "hello") {
        const credential = access.authenticate(frame.hello.token);
        if (!credential) {
          options.logger?.warn("host-transport-socket.unauthorized");
          socket.close(UNAUTHORIZED, ACCESS_CLOSE_REASON.unauthorized);
          return;
        }
        // A client that says hello twice on one socket replaces itself, with
        // whatever profile it now claims.
        forget(socket);
        // Waiting pushes are numbered now, before the reply names the next sequence.
        options.beforeReply?.();
        const userAgent = request.headers["user-agent"];
        const connection = access.attach(credential, {
          ...(request.socket.remoteAddress ? { address: request.socket.remoteAddress } : {}),
          ...(typeof userAgent === "string" ? { userAgent } : {}),
          ...(frame.hello.profile ? { profile: frame.hello.profile } : {}),
          ...(frame.hello.auxiliary ? { auxiliary: true } : {}),
        }, (reason) => {
          // Gone from the set first, so nothing more is delivered on the way out.
          forget(socket);
          socket.close(UNAUTHORIZED, reason);
        });
        clearTimeout(helloTimer);
        sockets.set(connection, socket);
        // Only a window's own process runs halves; a renderer names the window it sits in.
        options.calls?.attach(connection, {
          local: isLoopbackPeer(request.socket.remoteAddress),
          ...(credential.kind === "client" ? { pairedClient: credential.clientId } : {}),
          ...(frame.hello.windowId ? { windowId: frame.hello.windowId } : {}),
          ...(frame.hello.auxiliary && frame.hello.windowHalves ? { windowHalves: frame.hello.windowHalves } : {}),
        });
        authenticated.set(socket, {
          connection,
          principal: Object.freeze({
            kind: "workbench-client",
            connection,
            ...(credential.kind === "client" ? { pairedClient: credential.clientId } : {}),
          }),
        });
        // The reply first: it carries the sequence this client starts from, and
        // the push that announces its own arrival must come after that number.
        const reply = helloReply(options.pushLog, frame.hello, { ...options, capabilities });
        send(socket, { type: "hello-reply", id: frame.id, reply });
        if (!frame.hello.auxiliary && (frame.hello.lastSeq === undefined || reply.resync)) options.onSnapshotClient?.();
        if (options.clients && !frame.hello.auxiliary) {
          clientIds.set(socket, options.clients.attached({
            transport: "socket",
            ...(frame.hello.profile ? { profile: frame.hello.profile } : {}),
          }));
        }
        return;
      }
      const session = authenticated.get(socket);
      if (!session) {
        socket.close(UNAUTHORIZED, ACCESS_CLOSE_REASON.unauthorized);
        return;
      }
      // Not activity of the user's: a heartbeat leaves "last seen" alone.
      if (frame.type === "ping") {
        send(socket, { type: "pong", id: frame.id });
        return;
      }
      access.touch(session.connection);
      const { id, method, params } = frame.request;
      // JSON turns a missing positional argument into null; decoders expect undefined.
      const normalized = params.map((value) => (value === null ? undefined : value));
      void invokeHostMethod(options.methods, method, normalized, session.principal)
        .then((result) => respond(socket, { type: "response", response: { id, result } }))
        .catch((error: unknown) => {
          const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : HOST_ERROR.failed;
          respond(socket, { type: "response", response: { id, error: hostErrorInfo(error, code) } });
        });
    });
    socket.on("close", () => { clearTimeout(helloTimer); forget(socket); });
    socket.on("error", () => { clearTimeout(helloTimer); forget(socket); });
  });

  await new Promise<void>((resolve, reject) => {
    const listening = http ?? server;
    listening.once("error", reject);
    if (http) http.listen(port, host, () => resolve());
    else server.once("listening", () => resolve());
  });
  const pingAll = (): void => {
    for (const socket of server.clients) {
      if (!alive.has(socket)) { socket.terminate(); continue; }
      alive.delete(socket);
      socket.ping();
    }
  };
  const stopPings = options.schedulePings?.(pingAll) ?? everyInterval(pingAll, SOCKET_PING_INTERVAL_MS);
  const address = (http ?? server).address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  const scheme = options.tls ? "wss" : "ws";
  options.logger?.info("host-transport-socket.listening", { host, port: boundPort, scheme });

  return {
    port: boundPort,
    scheme,
    ...(warning ? { warning } : {}),
    deliver: (push) => {
      if (authenticated.size === 0) return;
      const frame = JSON.stringify({ type: "push", push } satisfies HostServerFrame);
      for (const socket of authenticated.keys()) if (socket.readyState === socket.OPEN) socket.send(frame);
    },
    sendCall: (connection, call) => {
      const socket = sockets.get(connection);
      if (!socket || socket.readyState !== socket.OPEN) return false;
      socket.send(JSON.stringify({ type: "client-call", call } satisfies HostServerFrame));
      return true;
    },
    close: async () => {
      stopPings();
      for (const socket of [...authenticated.keys()]) { forget(socket); socket.close(); }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function everyInterval(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** An HTTPS server with nothing to serve but the upgrade to the protocol. */
function createTlsUpgradeServer(tls: { cert: string; key: string }): Server {
  return createHttpsServer({ cert: tls.cert, key: tls.key, minVersion: "TLSv1.2" }, (_request, response) => {
    response.writeHead(426, { "content-type": "text/plain; charset=utf-8", connection: "close" });
    response.end("This port speaks the Tau host protocol over WebSocket.");
  });
}
