import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { Server as TlsServer } from "node:tls";
import { WebSocketServer, type WebSocket } from "ws";
import {
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
import { isLocalPeer, peerAddress, socketCapabilities, type ListenerTrust } from "./host-local-files.js";
import type { ClientPeer } from "./client-calls.js";
import type { HostClientSink } from "./host-transport-clients.js";
import type { HostLogger } from "./host-log.js";

/** Closed with this when the hello carried no token or the wrong one, or its access was taken away. */
const UNAUTHORIZED = 4401;

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
  /** What the listener `listen` names may conclude about its peers; `loopback` by default. */
  trust?: ListenerTrust;
  /** Where attached clients are reported; without one the host counts nobody. */
  clients?: HostClientSink;
  /** Told about every authenticated connection, so a call into a window can pick one; `ClientCalls` implements it. */
  calls?: { attach(connection: string, peer: ClientPeer): void; detach(connection: string): void };
  /** Runs before every reply, so pushes still waiting to be coalesced reach the client first. */
  beforeReply?(): void;
  /** A client starts from a snapshot, not a replay: its first hello, or a resync. */
  onSnapshotClient?(): void;
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
  /** The server `listen` bound; a certificate reload swaps its secure context. */
  readonly server: Server;
  /**
   * Serves the protocol on another server too, whose connections are judged
   * by `trust`. Detaching closes every connection that came through it.
   */
  attach(server: Server, trust: ListenerTrust): () => void;
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
  const http = options.attachTo ?? (options.tls ? createTlsUpgradeServer(options.tls) : createUpgradeServer());
  // No server of its own: every listener hands its upgrades over with the trust it has.
  const server = new WebSocketServer({ noServer: true, maxPayload: HOST_TRANSPORT_MAX_FRAME_BYTES, perMessageDeflate: SOCKET_PER_MESSAGE_DEFLATE });
  if (!options.access && !options.token) throw new Error("A socket listener needs a host token or an access model.");
  const access = options.access ?? tokenOnlyAccess(options.token!);
  /** Every authenticated socket, with the principal its requests run as. */
  const authenticated = new Map<WebSocket, { connection: string; principal: HostInvocationPrincipal }>();
  /** The id the client registry knows a socket by, while it is authenticated. */
  const clientIds = new Map<WebSocket, string>();
  const sockets = new Map<string, WebSocket>();
  /** The listener each socket came through, so detaching one closes its sockets. */
  const origins = new Map<WebSocket, Server>();
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

  const accept = (socket: WebSocket, request: IncomingMessage, trust: ListenerTrust): void => {
    // Only a peer on this machine may be told that the host's files are local.
    const capabilities = socketCapabilities(options.capabilities, request.socket.remoteAddress, process.env, trust);
    const local = isLocalPeer(trust, request.socket.remoteAddress);
    const address = peerAddress(trust, request);
    socket.on("message", (data) => {
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
          ...(address ? { address } : {}),
          ...(typeof userAgent === "string" ? { userAgent } : {}),
          ...(frame.hello.profile ? { profile: frame.hello.profile } : {}),
          ...(frame.hello.auxiliary ? { auxiliary: true } : {}),
        }, (reason) => {
          // Gone from the set first, so nothing more is delivered on the way out.
          forget(socket);
          socket.close(UNAUTHORIZED, reason);
        });
        sockets.set(connection, socket);
        // Only a window's own process runs halves; a renderer names the window it sits in.
        options.calls?.attach(connection, {
          local,
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
    socket.on("close", () => { origins.delete(socket); forget(socket); });
    socket.on("error", () => forget(socket));
  };

  const attach = (target: Server, trust: ListenerTrust): (() => void) => {
    const onUpgrade = (request: IncomingMessage, stream: Parameters<WebSocketServer["handleUpgrade"]>[1], head: Buffer): void => {
      server.handleUpgrade(request, stream, head, (socket) => {
        origins.set(socket, target);
        accept(socket, request, trust);
      });
    };
    target.on("upgrade", onUpgrade);
    return () => {
      target.off("upgrade", onUpgrade);
      for (const [socket, origin] of [...origins]) {
        if (origin !== target) continue;
        origins.delete(socket);
        forget(socket);
        socket.close();
      }
    };
  };
  attach(http, options.trust ?? "loopback");

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => { http.off("error", reject); resolve(); });
  });
  const address = http.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  const scheme = options.tls ? "wss" : "ws";
  options.logger?.info("host-transport-socket.listening", { host, port: boundPort, scheme });

  return {
    port: boundPort,
    scheme,
    server: http,
    attach,
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
      // One that never said hello would otherwise hold the port open.
      for (const socket of server.clients) if (!authenticated.has(socket)) socket.terminate();
      for (const socket of [...authenticated.keys()]) { forget(socket); socket.close(); }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

const upgradeOnly = (_request: IncomingMessage, response: ServerResponse): void => {
  response.writeHead(426, { "content-type": "text/plain; charset=utf-8", connection: "close" });
  response.end("This port speaks the Tau host protocol over WebSocket.");
};

/** An HTTPS server with nothing to serve but the upgrade to the protocol. */
function createTlsUpgradeServer(tls: { cert: string; key: string }): Server {
  return createHttpsServer({ cert: tls.cert, key: tls.key, minVersion: "TLSv1.2" }, upgradeOnly);
}

function createUpgradeServer(): Server {
  return createHttpServer(upgradeOnly);
}

/** A server for another listener with nothing but the protocol on it; `attach` it to a transport. */
export function createProtocolServer(tls?: { cert: string; key: string }): Server {
  return tls ? createTlsUpgradeServer(tls) : createUpgradeServer();
}
