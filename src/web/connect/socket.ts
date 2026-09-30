import type { HostSocket } from "../../workbench/host-connection-socket";
import type { PairingSocket } from "../../shared/host-pairing";
import { browserRelayUrl, type BrowserConnectRoute } from "./offer";

export interface TlsTunnel {
  feed(bytes: Uint8Array): void; drain(): Uint8Array; poll(): boolean; receive(): string | undefined;
  send(text: string): void; flush(): void; closed(): boolean; close_code(): number; close_reason(): string; close(): void; free(): void;
}
export type TunnelFactory = (url: string, host: string, pin: string, key: boolean) => Promise<TlsTunnel>;
let moduleReady: Promise<typeof import("../../../browser-connect/pkg/tau_browser_connect.js")> | undefined;
export const loadBrowserTls: TunnelFactory = async (url, host, pin, key) => {
  moduleReady ??= import("../../../browser-connect/pkg/tau_browser_connect.js").then(async (module) => { await module.default(); return module; }).catch((error: unknown) => { moduleReady = undefined; throw error; });
  const module = await moduleReady;
  return new module.BrowserTunnel(url, host, pin, key);
};

type SocketEvent = { data?: unknown; code?: number; reason?: string };
/** Only the browser entry imports this module. Every reconnect gets fresh TLS state. */
export class BrowserConnectSocket implements HostSocket, PairingSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: SocketEvent) => void>>();
  private relay?: WebSocket;
  private tunnel?: TlsTunnel;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private authenticated = false;

  constructor(private readonly route: BrowserConnectRoute, private readonly onFailure?: (message: string) => void, factory: TunnelFactory = loadBrowserTls, private readonly createRelay = (url: string) => new WebSocket(url, "tau-connect-v1")) {
    this.deadline = setTimeout(() => this.fail("Tau Connect did not finish the relay and host handshake in time."), 15_000);
    void factory(route.url, new URL(route.url).hostname.replace(/^\[|\]$/gu, ""), route.pin, route.key).then((tunnel) => {
      if (this.readyState === 3) { tunnel.free(); return; }
      this.tunnel = tunnel;
      const relay = this.createRelay(browserRelayUrl(route)); this.relay = relay; relay.binaryType = "arraybuffer";
      relay.onopen = () => relay.send(JSON.stringify({ type: "authenticate", token: route.token }));
      relay.onerror = () => this.fail("Tau Connect could not reach the relay over trusted HTTPS.", false);
      relay.onclose = (event) => {
        if (event.code === 4401) this.fail("The relay refused this Tau Connect route. Copy a new link from the host.");
        else this.finish(event.code, event.reason || "The relay connection closed.");
      };
      relay.onmessage = (event) => {
        try {
          if (!this.authenticated) {
            if (typeof event.data !== "string" || event.data.length > 128 || JSON.parse(event.data).type !== "authenticated") throw new Error("The relay did not authenticate this route.");
            this.authenticated = true;
          } else {
            if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 65_536) throw new Error("The relay sent invalid TLS records.");
            tunnel.feed(new Uint8Array(event.data));
          }
          this.pump();
        } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
      };
    }).catch((error: unknown) => this.fail(`Tau Connect could not load or initialize browser TLS: ${error instanceof Error ? error.message : String(error)}`));
  }

  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void;
  addEventListener(type: string, listener: (event: never) => void): void {
    let set = this.listeners.get(type); if (!set) this.listeners.set(type, set = new Set()); set.add(listener as (event: SocketEvent) => void);
  }
  send(text: string): void {
    if (this.readyState !== 1) throw new Error("The pinned host socket is not open.");
    try { this.tunnel!.send(text); this.pump(); } catch (error) { this.fail(String(error)); }
  }
  close(): void { this.finish(1000, ""); }

  private pump(): void {
    if (this.readyState === 3 || !this.authenticated || !this.tunnel || this.relay?.readyState !== 1) return;
    clearTimeout(this.timer);
    const tunnel = this.tunnel;
    if (tunnel.poll() && this.readyState === 0) {
      this.readyState = 1; clearTimeout(this.deadline); this.onopen?.(); this.emit("open", {});
      if (this.isClosed()) return;
    }
    let text: string | undefined;
    while ((text = tunnel.receive()) !== undefined && text !== null) {
      this.onmessage?.({ data: text }); this.emit("message", { data: text });
      if (this.isClosed()) return;
    }
    tunnel.flush();
    // Browser sockets have no writable event. Bound the browser's queue while
    // rustls keeps the remaining records and tungstenite keeps pending writes.
    while (this.relay.bufferedAmount < 256 * 1024) {
      const bytes = tunnel.drain(); if (!bytes.length) break; this.relay.send(bytes);
    }
    if (tunnel.closed()) { this.finish(tunnel.close_code(), tunnel.close_reason()); return; }
    if (this.relay.bufferedAmount > 0) this.timer = setTimeout(() => { try { this.pump(); } catch (error) { this.fail(String(error)); } }, 8);
  }
  private fail(message: string, final = true): void {
    if (this.readyState === 3) return;
    if (final) this.onFailure?.(message);
    this.emit("error", {}); this.finish(1006, message);
  }
  private finish(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3; clearTimeout(this.timer); clearTimeout(this.deadline);
    if (this.relay) { this.relay.onclose = null; this.relay.onmessage = null; this.relay.onopen = null; this.relay.onerror = null; this.relay.close(); }
    this.tunnel?.free(); this.tunnel = undefined;
    this.onclose?.({ code, reason }); this.emit("close", { code, reason }); this.listeners.clear();
  }
  private emit(type: string, event: SocketEvent): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  private isClosed(): boolean { return this.readyState === 3; }
}
