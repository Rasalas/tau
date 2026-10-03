import { afterEach, describe, expect, it, vi } from "vitest";
import { certificateRefusalNotice, connectHost } from "./connect";
import type { CertificateRefusal } from "./endpoints";
import type { SavedHost } from "./hosts";
import type { NativeSocketEvent, SocketBridge } from "./native-socket";

const KEY = "EF:".repeat(31) + "EF";

/** A bridge whose sockets close at once, each the way `outcome` says for its URL. */
function closingBridge(outcome: Record<string, Omit<Extract<NativeSocketEvent, { type: "close" }>, "id" | "type">>): SocketBridge {
  const listeners = new Map<string, (event: NativeSocketEvent) => void>();
  return {
    open: async (request) => {
      const close = outcome[request.url] ?? { code: 1006 };
      queueMicrotask(() => listeners.get(request.id)?.({ id: request.id, type: "close", ...close }));
    },
    send: async () => undefined,
    close: async () => undefined,
    subscribe: (id, listener) => { listeners.set(id, listener); return () => listeners.delete(id); },
  };
}

/** A bridge whose sockets open, and close as the host would once the hello arrives: one close from `closes` per socket. */
function helloClosingBridge(closes: Array<{ code: number; reason: string }>): SocketBridge & { hellos: string[] } {
  const listeners = new Map<string, (event: NativeSocketEvent) => void>();
  const hellos: string[] = [];
  return {
    hellos,
    open: async (request) => { queueMicrotask(() => listeners.get(request.id)?.({ id: request.id, type: "open" })); },
    send: async (id, data) => {
      const frame = JSON.parse(data) as { type: string; hello?: { token?: string } };
      if (frame.type !== "hello") return;
      hellos.push(frame.hello?.token ?? "");
      const close = closes.shift();
      if (close) queueMicrotask(() => listeners.get(id)?.({ id, type: "close", ...close }));
    },
    close: async () => undefined,
    subscribe: (id, listener) => { listeners.set(id, listener); return () => listeners.delete(id); },
  };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const host: SavedHost = {
  id: "h-1",
  name: "Mac mini",
  publicKey: KEY,
  endpoints: [
    { url: "https://192.168.1.2:7788/", kind: "lan" },
    { url: "https://100.64.1.2:7788/", kind: "tailscale" },
  ],
  access: "full",
  addedAt: "2026-09-24T10:00:00.000Z",
  lastUsedAt: "2026-09-24T10:00:00.000Z",
};

describe("connectHost", () => {
  it("gives up with the address when one shows another key and the others are out of reach", async () => {
    const refusals: CertificateRefusal[] = [];
    const { connection } = connectHost(() => host, "token", {
      bridge: closingBridge({ "wss://100.64.1.2:7788/": { code: 1006, pinMismatch: true } }),
      device: { platform: "ios", virtual: false },
    }, {
      onUnauthorized: () => undefined,
      onCertificateRefused: (refusal) => refusals.push(refusal),
    });
    void connection.start("compact").catch(() => undefined);
    await expect.poll(() => refusals.length).toBeGreaterThan(0);
    expect(refusals[0]).toEqual({ reason: "certificate-mismatch", addresses: ["100.64.1.2:7788"] });
    connection.close();
  });
});

describe("connectHost and the phone's token", () => {
  it.each([0, 0.5, 0.999])("keeps the token through malformed-frame closes until revoked, with jitter sample %s", async (sample) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(sample);
    const bridge = helloClosingBridge([
      { code: 4400, reason: "malformed frame" },
      { code: 4401, reason: "malformed frame" },
      { code: 4401, reason: "revoked" },
    ]);
    const refusals: string[] = [];
    const single: SavedHost = { ...host, endpoints: [host.endpoints[0]!] };
    const { connection } = connectHost(() => single, "phone-token", { bridge, device: { platform: "android", virtual: false } }, {
      onUnauthorized: (reason) => refusals.push(reason),
      onCertificateRefused: () => undefined,
    });
    void connection.start("compact").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.hellos).toEqual(["phone-token"]);
    expect(refusals).toEqual([]);
    // First retry is bounded at 300 ms; the next at 600 ms.
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.hellos).toEqual(["phone-token", "phone-token"]);
    expect(refusals).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    expect(bridge.hellos).toHaveLength(3);
    expect(refusals).toEqual(["revoked"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bridge.hellos).toHaveLength(3);
  });
});

describe("certificateRefusalNotice", () => {
  it("names the address and the host, for a wrong key and for an untrusted certificate", () => {
    expect(certificateRefusalNotice("Mac mini", { reason: "certificate-mismatch", addresses: ["100.64.1.2:7788"] }))
      .toMatch(/^100\.64\.1\.2:7788 answered for Mac mini with another key than the one this phone pinned/u);
    expect(certificateRefusalNotice("Mac mini", { reason: "untrusted-certificate", addresses: ["mac.tail0000.ts.net"] }))
      .toMatch(/^mac\.tail0000\.ts\.net showed a certificate this phone does not trust, so the phone did not connect to Mac mini\./u);
  });
});
