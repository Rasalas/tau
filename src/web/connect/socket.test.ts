// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { BrowserConnectSocket, type TlsTunnel } from "./socket";
import type { BrowserConnectRoute } from "./offer";

const route: BrowserConnectRoute = { relay: "https://relay.example", id: "12345678-1234-1234-1234-123456789abc", token: "r".repeat(43), url: "wss://host.local/", pin: "AB".repeat(32), key: true };
function fixture() {
  const tls: TlsTunnel = { feed: vi.fn(), drain: vi.fn(() => new Uint8Array()), poll: vi.fn(() => false), receive: vi.fn(() => undefined), send: vi.fn(), flush: vi.fn(), closed: () => false, close_code: () => 1006, close_reason: () => "", close: vi.fn(), free: vi.fn() };
  const relay = { readyState: 1, bufferedAmount: 0, binaryType: "", onopen: null, onclose: null, onerror: null, onmessage: null, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
  const failure = vi.fn(); const createRelay = vi.fn(() => relay);
  const socket = new BrowserConnectSocket(route, failure, async () => tls, createRelay);
  return { socket, tls, relay, failure, createRelay };
}
describe("browser relay socket lifecycle", () => {
  it("sends only relay authentication until TLS and the inner upgrade finish", async () => {
    const { socket, tls, relay, createRelay } = fixture(); await Promise.resolve();
    const opened = vi.fn(); socket.onopen = opened;
    relay.onopen!(new Event("open"));
    expect(createRelay).toHaveBeenCalledWith(`wss://relay.example/v1/browser/${route.id}`);
    expect(relay.send).toHaveBeenCalledWith(JSON.stringify({ type: "authenticate", token: route.token }));
    expect(() => socket.send("host-credential")).toThrow(/not open/u);
    relay.onmessage!({ data: '{"type":"authenticated"}' } as MessageEvent);
    expect(opened).not.toHaveBeenCalled();
    vi.mocked(tls.poll).mockReturnValue(true);
    relay.onmessage!({ data: new ArrayBuffer(4) } as MessageEvent);
    expect(opened).toHaveBeenCalledOnce(); socket.send("hello"); expect(tls.send).toHaveBeenCalledWith("hello"); socket.close();
    expect(tls.free).toHaveBeenCalledOnce(); expect(relay.close).toHaveBeenCalledOnce();
  });
  it("frees a WASM tunnel loaded after pairing was cancelled without opening a relay", async () => {
    const { tls, socket: original } = fixture(); original.close(); await Promise.resolve(); let loaded!: (tls: TlsTunnel) => void;
    const createRelay = vi.fn(); const socket = new BrowserConnectSocket(route, undefined, () => new Promise((resolve) => { loaded = resolve; }), createRelay);
    socket.close(); loaded(tls); await Promise.resolve(); expect(tls.free).toHaveBeenCalled(); expect(createRelay).not.toHaveBeenCalled();
  });
  it("fails closed on a pin failure and drops both transport layers", async () => {
    const { socket, tls, relay, failure } = fixture(); await Promise.resolve();
    vi.mocked(tls.feed).mockImplementation(() => { throw new Error("The host's pinned key differs."); });
    relay.onmessage!({ data: '{"type":"authenticated"}' } as MessageEvent);
    relay.onmessage!({ data: new ArrayBuffer(4) } as MessageEvent);
    expect(failure).toHaveBeenCalledWith("The host's pinned key differs."); expect(socket.readyState).toBe(3); expect(tls.send).not.toHaveBeenCalled(); expect(tls.free).toHaveBeenCalledOnce();
  });
  it("reports a refused relay route without opening the pinned host socket", async () => {
    const { socket, tls, relay, failure } = fixture(); await Promise.resolve();
    relay.onclose!({ code: 4401, reason: "Relay authentication refused" } as CloseEvent);
    expect(failure).toHaveBeenCalledWith(expect.stringContaining("Copy a new link"));
    expect(socket.readyState).toBe(3); expect(tls.feed).not.toHaveBeenCalled(); expect(tls.free).toHaveBeenCalledOnce();
  });
});
