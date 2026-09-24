import { WebSocket, type ClientOptions } from "ws";
import {
  HOST_TRANSPORT_VERSION,
  decodeHostServerFrame,
  type HostClientCall,
  type HostHello,
  type HostHelloReply,
  type HostPush,
} from "../shared/host-transport.js";
import type { HostLogger } from "./host-log.js";
import { HostCertificateRefusedError, hostTlsConnect, type EndpointTrust, type ReachedCertificate } from "./host-tls-trust.js";

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** `host-transport-socket.ts` closes with this when the hello carried the wrong token. */
const UNAUTHORIZED = 4401;

export interface HostUplinkOptions {
  url: string;
  token: string;
  /** Every push the host sends. */
  onPush?(push: HostPush): void;
  /** A call the host sent to this connection alone: a window half is asked to do something. */
  onCall?(call: HostClientCall): void;
  /** Read at every hello, a reconnect's included: which window this is and which halves it runs. */
  helloFields?(): Pick<HostHello, "windowId" | "windowHalves" | "subscription">;
  /** `certificate`: what the TLS handshake of the socket that said hello showed, for a `wss:` host. */
  onHello?(reply: HostHelloReply, certificate?: ReachedCertificate): void;
  logger?: HostLogger;
  requestTimeoutMs?: number;
  /**
   * How to trust a `wss:` host: its key (or an old certificate) pinned, or a
   * CA. Read at every connect, so a pin changed in place applies to the next.
   */
  trust?: EndpointTrust;
  /** The pinned host presented another certificate. The uplink does not retry. */
  onCertificateRefused?(error: HostCertificateRefusedError): void;
  /**
   * After a refusal: the token as it is now, such as re-read from the host's
   * token file after a rotation. A different one is tried once; the same one
   * ends the uplink as before.
   */
  refreshToken?(): string | undefined;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The window process's own connection to its host. The renderer speaks the
 * protocol for itself; this is what the process around it needs — the kit
 * bundles it serves, the calls a host makes back into the window, and the
 * shutdown a supervisor asks for. It reconnects, because the host it talks to
 * may be restarted under it.
 */
export class HostUplink {
  private socket: WebSocket | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly outbox: string[] = [];
  private counter = 0;
  private closed = false;
  private delayMs = RECONNECT_MIN_MS;
  private helloSent = false;
  private token: string;
  private certificate: ReachedCertificate | undefined;

  constructor(private readonly options: HostUplinkOptions) {
    this.token = options.token;
    this.connect();
  }

  /** Opens one connection, says hello and reports the reply; nothing is kept. */
  static async probe(url: string, token: string, timeoutMs = 3_000): Promise<HostHelloReply | undefined> {
    const uplink = new HostUplink({ url, token });
    try {
      const reply = await Promise.race([
        uplink.hello(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
      ]);
      return reply ?? undefined;
    } catch {
      return undefined;
    } finally {
      uplink.close();
    }
  }

  async hello(): Promise<HostHelloReply> {
    this.helloSent = true;
    // Not a client of its own: the renderer beside this process is the one that counts.
    const reply = await this.send("hello", [{ ...this.options.helloFields?.(), protocol: HOST_TRANSPORT_VERSION, auxiliary: true }]) as HostHelloReply;
    this.options.onHello?.(reply, this.certificate);
    return reply;
  }

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    if (!this.helloSent) await this.hello();
    return this.send(method, params) as Promise<T>;
  }

  close(): void {
    this.closed = true;
    this.failPending("The uplink to the host was closed.");
    this.socket?.close();
  }

  private send(method: string, params: readonly unknown[]): Promise<unknown> {
    // Closed for good (by the caller, a refused certificate or token): nothing would ever answer.
    if (this.closed) return Promise.reject(new Error("The uplink to the host was closed."));
    this.counter += 1;
    const id = `w${this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: the host did not answer in ${this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS}ms`));
      }, this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const frame = method === "hello"
        ? { type: "hello", id, hello: { ...(params[0] as object), token: this.token } }
        : { type: "request", request: { id, method, params } };
      this.write(JSON.stringify(frame));
    });
  }

  private write(text: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(text);
    else this.outbox.push(text);
  }

  private failPending(message: string): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    this.pending.clear();
  }

  private connect(): void {
    if (this.closed) return;
    const { trust } = this.options;
    const tls = this.options.url.startsWith("wss:");
    this.certificate = undefined;
    const createConnection = tls && trust ? hostTlsConnect(trust, (presented, via) => { this.certificate = { presented, via }; }) : undefined;
    const socket = createConnection
      ? new WebSocket(this.options.url, { createConnection: createConnection as unknown as ClientOptions["createConnection"] })
      : new WebSocket(this.options.url);
    this.socket = socket;
    socket.on("open", () => {
      this.delayMs = RECONNECT_MIN_MS;
      // A reconnect starts over: the host has forgotten this peer said hello.
      if (this.helloSent) void this.hello().catch(() => undefined);
      for (const text of this.outbox.splice(0)) socket.send(text);
    });
    socket.on("message", (data) => this.receive(String(data)));
    socket.on("error", (error) => {
      if (!(error instanceof HostCertificateRefusedError) || this.closed) return;
      this.closed = true;
      this.options.logger?.error("host-uplink.certificate-refused", { url: this.options.url, presented: error.presented, expected: error.expected });
      this.options.onCertificateRefused?.(error);
    });
    socket.on("close", (code: number) => {
      this.failPending("The host connection dropped.");
      if (this.closed) return;
      if (code === UNAUTHORIZED) {
        const next = this.options.refreshToken?.();
        if (next && next !== this.token) {
          this.token = next;
          this.options.logger?.info("host-uplink.token-refreshed", { url: this.options.url });
          this.connect();
          return;
        }
        this.closed = true;
        this.options.logger?.error("host-uplink.unauthorized", { url: this.options.url });
        return;
      }
      setTimeout(() => this.connect(), this.delayMs).unref?.();
      this.delayMs = Math.min(this.delayMs * 2, RECONNECT_MAX_MS);
    });
  }

  private receive(data: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    const frame = decodeHostServerFrame(parsed);
    if (!frame) return;
    if (frame.type === "push") {
      this.options.onPush?.(frame.push);
      return;
    }
    if (frame.type === "client-call") {
      this.options.onCall?.(frame.call);
      return;
    }
    // Pairing has its own client (`host-pairing.ts`); a connected uplink never asked.
    if (frame.type === "pair-reply") return;
    if (frame.type === "pong") return;
    const id = frame.type === "response" ? frame.response.id : frame.id;
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (frame.type === "hello-reply") request.resolve(frame.reply);
    else if (frame.response.error) request.reject(Object.assign(new Error(frame.response.error.message), { code: frame.response.error.code }));
    else request.resolve(frame.response.result);
  }
}
