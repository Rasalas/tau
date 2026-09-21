import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  HOST_ERROR,
  HOST_TRANSPORT_MAX_FRAME_BYTES,
  decodeHostClientFrame,
  hostErrorInfo,
  type HostPush,
  type HostServerFrame,
} from "../shared/host-transport.js";
import { helloReply, type HostPushLog } from "./host-push-log.js";
import { invokeHostMethod, type HostMethodTable } from "./host-methods.js";
import { hostTokenMatches } from "./host-token.js";
import { assertListenAllowed, parseListen } from "./host-listen.js";
import { socketCapabilities } from "./host-local-files.js";
import type { HostClientSink } from "./host-transport-clients.js";
import type { HostLogger } from "./host-log.js";

/** Closed with this when the hello carried no token or the wrong one. */
const UNAUTHORIZED = 4401;

export interface SocketHostTransportOptions {
  /** `host:port` as `TAU_HOST_LISTEN` gives it; port 0 picks a free one. */
  listen: string;
  methods: HostMethodTable;
  pushLog: HostPushLog;
  hostVersion: string;
  capabilities: string[];
  /** The secret from `~/.tau/host-token`; every client repeats it in its hello. */
  token: string;
  /** `TAU_HOST_INSECURE=1`: bind a public interface although nothing is encrypted. */
  allowNonLoopback?: boolean;
  /**
   * An HTTP server to upgrade on instead of a socket of its own. A host that
   * also serves the web client gives its one here, so the browser reaches the
   * page and the protocol at the same origin and the same port.
   */
  attachTo?: Server;
  /** Where attached clients are reported; without one the host counts nobody. */
  clients?: HostClientSink;
  logger?: HostLogger;
}

export interface SocketHostTransport {
  readonly port: number;
  deliver(push: HostPush): void;
  close(): Promise<void>;
}

/**
 * The same method table over a local socket. Nothing runs before the hello is
 * accepted, so an unauthenticated peer can neither call a method nor observe
 * a push. Confidentiality is the tunnel's job (see ADR 0010): this is a
 * loopback listener with a shared secret, not a TLS endpoint, and it refuses a
 * public interface unless the operator asked for one.
 */
export async function startSocketHostTransport(options: SocketHostTransportOptions): Promise<SocketHostTransport> {
  const bind = parseListen(options.listen);
  assertListenAllowed(bind, options.allowNonLoopback === true);
  const { host, port } = bind;
  const http = options.attachTo;
  const server = http
    ? new WebSocketServer({ server: http, maxPayload: HOST_TRANSPORT_MAX_FRAME_BYTES })
    : new WebSocketServer({ host, port, maxPayload: HOST_TRANSPORT_MAX_FRAME_BYTES });
  const authenticated = new Set<WebSocket>();
  /** The id the client registry knows a socket by, while it is authenticated. */
  const clientIds = new Map<WebSocket, string>();
  const forget = (socket: WebSocket): void => {
    authenticated.delete(socket);
    const clientId = clientIds.get(socket);
    if (clientId === undefined) return;
    clientIds.delete(socket);
    options.clients?.detached(clientId);
  };

  const send = (socket: WebSocket, frame: HostServerFrame): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };

  server.on("connection", (socket, request) => {
    // Only a peer on this machine may be told that the host's files are local.
    const capabilities = socketCapabilities(options.capabilities, request.socket.remoteAddress);
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
        if (!hostTokenMatches(options.token, frame.hello.token)) {
          options.logger?.warn("host-transport-socket.unauthorized");
          socket.close(UNAUTHORIZED, HOST_ERROR.unauthorized);
          return;
        }
        // A client that says hello twice on one socket replaces itself, with
        // whatever profile it now claims.
        forget(socket);
        authenticated.add(socket);
        // The reply first: it carries the sequence this client starts from, and
        // the push that announces its own arrival must come after that number.
        send(socket, { type: "hello-reply", id: frame.id, reply: helloReply(options.pushLog, frame.hello, { ...options, capabilities }) });
        if (options.clients && !frame.hello.auxiliary) {
          clientIds.set(socket, options.clients.attached({
            transport: "socket",
            ...(frame.hello.profile ? { profile: frame.hello.profile } : {}),
          }));
        }
        return;
      }
      if (!authenticated.has(socket)) {
        socket.close(UNAUTHORIZED, HOST_ERROR.unauthorized);
        return;
      }
      const { id, method, params } = frame.request;
      // JSON turns a missing positional argument into null; decoders expect undefined.
      const normalized = params.map((value) => (value === null ? undefined : value));
      void invokeHostMethod(options.methods, method, normalized)
        .then((result) => send(socket, { type: "response", response: { id, result } }))
        .catch((error: unknown) => {
          const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : HOST_ERROR.failed;
          send(socket, { type: "response", response: { id, error: hostErrorInfo(error, code) } });
        });
    });
    socket.on("close", () => forget(socket));
    socket.on("error", () => forget(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const listening = http ?? server;
    listening.once("error", reject);
    if (http) http.listen(port, host, () => resolve());
    else server.once("listening", () => resolve());
  });
  const address = (http ?? server).address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  options.logger?.info("host-transport-socket.listening", { host, port: boundPort });

  return {
    port: boundPort,
    deliver: (push) => {
      for (const socket of authenticated) send(socket, { type: "push", push });
    },
    close: async () => {
      for (const socket of [...authenticated]) { forget(socket); socket.close(); }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
