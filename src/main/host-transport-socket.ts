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
  logger?: HostLogger;
}

export interface SocketHostTransport {
  readonly port: number;
  deliver(push: HostPush): void;
  close(): Promise<void>;
}

function parseListen(listen: string): { host: string; port: number } {
  const separator = listen.lastIndexOf(":");
  if (separator < 0) return { host: "127.0.0.1", port: Number(listen) };
  return { host: listen.slice(0, separator) || "127.0.0.1", port: Number(listen.slice(separator + 1)) };
}

/**
 * The same method table over a local socket. Nothing runs before the hello is
 * accepted, so an unauthenticated peer can neither call a method nor observe
 * a push. Confidentiality is the tunnel's job (see ADR 0010): this is a
 * loopback listener with a shared secret, not a TLS endpoint.
 */
export async function startSocketHostTransport(options: SocketHostTransportOptions): Promise<SocketHostTransport> {
  const { host, port } = parseListen(options.listen);
  const server = new WebSocketServer({ host, port, maxPayload: HOST_TRANSPORT_MAX_FRAME_BYTES });
  const authenticated = new Set<WebSocket>();

  const send = (socket: WebSocket, frame: HostServerFrame): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };

  server.on("connection", (socket) => {
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
        authenticated.add(socket);
        send(socket, { type: "hello-reply", id: frame.id, reply: helloReply(options.pushLog, frame.hello, options) });
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
    socket.on("close", () => authenticated.delete(socket));
    socket.on("error", () => authenticated.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  options.logger?.info("host-transport-socket.listening", { host, port: boundPort });

  return {
    port: boundPort,
    deliver: (push) => {
      for (const socket of authenticated) send(socket, { type: "push", push });
    },
    close: () => new Promise<void>((resolve) => {
      for (const socket of authenticated) socket.close();
      server.close(() => resolve());
    }),
  };
}
