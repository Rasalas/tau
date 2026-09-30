import { createServer, connect, type Server, type Socket } from "node:net";
import { WebSocket, createWebSocketStream, type ClientOptions } from "ws";
import type { ConnectRoute } from "../shared/managed-connections.js";

export function connectRelayUrl(relay: string, role: "host" | "client" | "data", id: string, connection?: string): string {
  const url = new URL(relay);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Tau Connect requires an HTTPS relay address.");
  url.protocol = "wss:";
  url.pathname = `/v1/${role}/${id}${connection ? `/${connection}` : ""}`;
  url.search = ""; url.hash = "";
  return url.href;
}

function openRelay(relay: string, role: "host" | "client" | "data", id: string, token: string, connection?: string, options: ClientOptions = {}): WebSocket {
  return new WebSocket(connectRelayUrl(relay, role, id, connection), { ...options, handshakeTimeout: 15_000, perMessageDeflate: false, maxPayload: 65_536, headers: { Authorization: `Bearer ${token}` } });
}

function bridge(socket: Socket, peer: WebSocket): () => void {
  const stream = createWebSocketStream(peer, { highWaterMark: 65_536 });
  const close = () => { socket.destroy(); stream.destroy(); peer.terminate(); };
  stream.on("error", close); socket.on("error", close); socket.on("close", close); peer.on("close", close);
  socket.pipe(stream).pipe(socket);
  return close;
}

/** Every native TLS connection gets a new route. TLS remains between desktop and host. */
export class ConnectClientBridge {
  private server?: Server;
  private readonly connections = new Set<() => void>();
  constructor(readonly route: ConnectRoute, private readonly tlsOptions: ClientOptions = {}) {}
  async start(): Promise<void> {
    this.server = createServer((socket) => {
      const peer = openRelay(this.route.relay, "client", this.route.id, this.route.token, undefined, this.tlsOptions);
      peer.on("error", () => socket.destroy());
      socket.pause();
      const close = () => { socket.destroy(); peer.terminate(); this.connections.delete(close); };
      this.connections.add(close);
      socket.on("close", close);
      peer.once("open", () => { bridge(socket, peer); socket.resume(); });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.route.port, "127.0.0.1", resolve); });
  }
  close(): void { for (const close of this.connections) close(); this.connections.clear(); this.server?.close(); }
}

export interface ConnectHostRoute { relay: string; id: string; hostToken: string; clientToken: string }
export type ConnectPhase = "disabled" | "connecting" | "connected" | "offline";

/** The host makes outbound TLS connections only. Reconnect preserves the registered route. */
export class ConnectHostTunnel {
  private control?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;
  private attempts = 0;
  private readonly connections = new Set<() => void>();
  constructor(private readonly route: ConnectHostRoute, private readonly localPort: number, private readonly publish: (phase: ConnectPhase, detail?: string) => void, private readonly tlsOptions: ClientOptions = {}) {}
  start(): void {
    if (this.closed) return;
    this.publish("connecting");
    const control = openRelay(this.route.relay, "host", this.route.id, this.route.hostToken, undefined, this.tlsOptions);
    this.control = control;
    let live = true;
    control.on("pong", () => { live = true; });
    control.once("open", () => {
      this.attempts = 0; this.publish("connected");
      this.heartbeat = setInterval(() => { if (!live) control.terminate(); else { live = false; control.ping(); } }, 15_000);
      this.heartbeat.unref();
    });
    control.on("message", (data, binary) => {
      if (binary || data.length > 512) { control.close(1008); return; }
      let message: { type?: string; id?: string };
      try { message = JSON.parse(data.toString()); } catch { control.close(1008); return; }
      if (message.type !== "open" || !/^[a-f0-9-]{36}$/u.test(message.id ?? "")) { control.close(1008); return; }
      const peer = openRelay(this.route.relay, "data", this.route.id, this.route.hostToken, message.id, this.tlsOptions);
      peer.on("error", () => peer.terminate());
      peer.once("open", () => {
        const socket = connect(this.localPort, "127.0.0.1");
        const close = bridge(socket, peer);
        this.connections.add(close);
        peer.on("close", () => this.connections.delete(close));
      });
    });
    control.on("error", () => this.publish("offline", "The relay could not be reached or rejected this machine. Check its address and registration."));
    control.on("close", () => {
      clearInterval(this.heartbeat);
      for (const close of this.connections) close(); this.connections.clear();
      if (this.closed) return;
      this.publish("offline", "Reconnecting to Tau Connect…");
      this.timer = setTimeout(() => this.start(), Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts++, 5)));
      this.timer.unref();
    });
  }
  close(): void { this.closed = true; clearTimeout(this.timer); clearInterval(this.heartbeat); this.control?.terminate(); for (const close of this.connections) close(); this.connections.clear(); }
}
