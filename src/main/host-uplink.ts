import { WebSocket, type ClientOptions } from "ws";
import { HOST_TRANSPORT_VERSION, type HostClientCall, type HostHello, type HostHelloReply, type HostPush } from "../shared/host-transport.js";
import type { HostTransport } from "../shared/host-transport-client.js";
import type { HostWakeSource } from "../shared/host-link.js";
import { ConnectionTimers } from "../shared/connection-timers.js";
import { createSocketHostTransport, type HostSocket } from "../shared/socket-host-transport.js";
import type { HostLogger } from "./host-log.js";
import { HostCertificateRefusedError, hostTlsConnect, type EndpointTrust, type ReachedCertificate } from "./host-tls-trust.js";
import { hostPowerState } from "./host-power-state.js";

export interface HostUplinkOptions {
  url: string;
  token: string;
  onPush?(push: HostPush): void;
  onCall?(call: HostClientCall): void;
  helloFields?(): Pick<HostHello, "windowId" | "windowHalves" | "subscription" | "nativeGrants">;
  onHello?(reply: HostHelloReply, certificate?: ReachedCertificate): void;
  logger?: HostLogger;
  requestTimeoutMs?: number;
  trust?: EndpointTrust;
  onCertificateRefused?(error: HostCertificateRefusedError): void;
  refreshToken?(): string | undefined;
  wakes?: HostWakeSource;
}

/**
 * The window process's auxiliary protocol client. Its socket uses the same
 * sleep-aware deadlines, heartbeat and outbox as the renderer's; this adapter
 * supplies Node's pinned TLS socket and the calls into native window halves.
 */
export class HostUplink {
  private transport!: HostTransport;
  private closed = false;
  private helloSent = false;
  private token: string;
  private certificate: ReachedCertificate | undefined;

  constructor(private readonly options: HostUplinkOptions) {
    this.token = options.token;
    this.connect();
  }

  static async probe(url: string, token: string, timeoutMs = 3_000): Promise<HostHelloReply | undefined> {
    const uplink = new HostUplink({ url, token });
    const timers = new ConnectionTimers();
    const stop = hostPowerState.subscribe((state) => {
      if (state === "suspend") timers.pause();
      if (state === "resume") timers.resume();
    });
    try {
      return await Promise.race([
        uplink.hello(),
        new Promise<undefined>((resolve) => timers.after(timeoutMs, () => resolve(undefined))),
      ]);
    } catch { return undefined; }
    finally { stop(); timers.close(); uplink.close(); }
  }

  async hello(): Promise<HostHelloReply> {
    this.helloSent = true;
    const reply = await this.send<HostHelloReply>("hello", [{
      ...this.options.helloFields?.(), protocol: HOST_TRANSPORT_VERSION, auxiliary: true,
    }]);
    this.options.onHello?.(reply, this.certificate);
    return reply;
  }

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    if (!this.helloSent) await this.hello();
    return this.send<T>(method, params);
  }

  close(): void {
    this.closed = true;
    this.transport.close?.();
  }

  private async send<T>(method: string, params: readonly unknown[]): Promise<T> {
    if (this.closed) throw new Error("The uplink to the host was closed.");
    const response = await this.transport.request(method, params);
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result as T;
  }

  private connect(): void {
    if (this.closed) return;
    this.transport?.close?.();
    this.certificate = undefined;
    const transport = createSocketHostTransport(this.options.url, this.token, {
      requestTimeoutMs: this.options.requestTimeoutMs,
      wakes: this.options.wakes ?? hostPowerState.subscribe,
      onClientCall: this.options.onCall,
      onDiagnostic: (reason) => this.options.logger?.debug("host-uplink.connection", { reason }),
      onUnauthorized: () => {
        const next = this.options.refreshToken?.();
        if (next && next !== this.token) {
          this.token = next;
          this.options.logger?.info("host-uplink.token-refreshed");
          this.connect();
        } else {
          this.closed = true;
          this.options.logger?.error("host-uplink.unauthorized");
        }
      },
      onOriginRefused: () => {
        this.closed = true;
        this.options.logger?.error("host-uplink.origin-refused");
      },
      createSocket: (url) => {
        const { trust } = this.options;
        const createConnection = url.startsWith("wss:") && trust
          ? hostTlsConnect(trust, (presented, via) => { this.certificate = { presented, via }; }) : undefined;
        const socket = new WebSocket(url, {
          // Browser WebSockets cannot set this upgrade header, even when Origin is stripped.
          headers: { "Sec-WebSocket-Tau-Native": "1" },
          ...(createConnection ? { createConnection: createConnection as unknown as ClientOptions["createConnection"] } : {}),
        });
        socket.on("error", (error) => {
          if (this.transport !== transport || this.closed || !(error instanceof HostCertificateRefusedError)) return;
          this.closed = true;
          transport.close?.();
          this.options.logger?.error("host-uplink.certificate-refused", { presented: error.presented, expected: error.expected });
          this.options.onCertificateRefused?.(error);
        });
        return socket as unknown as HostSocket;
      },
    });
    this.transport = transport;
    transport.onPush((push) => this.options.onPush?.(push));
    transport.onOpen?.(() => { if (this.helloSent) void this.hello().catch(() => undefined); });
    if (this.helloSent) void this.hello().catch(() => undefined);
  }
}
