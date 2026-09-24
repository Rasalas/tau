import { describe, expect, it } from "vitest";
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

describe("certificateRefusalNotice", () => {
  it("names the address and the host, for a wrong key and for an untrusted certificate", () => {
    expect(certificateRefusalNotice("Mac mini", { reason: "certificate-mismatch", addresses: ["100.64.1.2:7788"] }))
      .toMatch(/^100\.64\.1\.2:7788 answered for Mac mini with another key than the one this phone pinned/u);
    expect(certificateRefusalNotice("Mac mini", { reason: "untrusted-certificate", addresses: ["mac.tail0000.ts.net"] }))
      .toMatch(/^mac\.tail0000\.ts\.net showed a certificate this phone does not trust, so the phone did not connect to Mac mini\./u);
  });
});
