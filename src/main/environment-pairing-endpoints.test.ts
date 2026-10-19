import { expect, it, vi } from "vitest";
import { pairEnvironment } from "./environment-pairing.js";

vi.mock("../shared/host-pairing.js", () => ({
  pairWithHost: async () => ({ state: "approved", token: "fixture-token", clientId: "fixture", access: "full" }),
}));

it("keeps an HTTPS pairing token away from plaintext addresses reported by hello", async () => {
  const sockets: string[] = [];
  const result = await pairEnvironment({
    text: "https://studio.example:7788/",
    deviceName: "fixture",
    probe: async () => ({ authorized: true, publicKey: "fixture-key", fingerprint: "fixture", subject: "Studio", validTo: "2099-01-01" }),
    createSocket: (url) => {
      sockets.push(url);
      const listeners = new Map<string, (event: { data: unknown; code?: number; reason?: string }) => void>();
      queueMicrotask(() => listeners.get("open")?.({ data: undefined }));
      return {
        close() {},
        addEventListener(type: string, listener: (event: { data: unknown; code?: number; reason?: string }) => void) { listeners.set(type, listener); },
        send(data: string) {
          expect(JSON.parse(data).hello.token).toBe("fixture-token");
          queueMicrotask(() => listeners.get("message")?.({ data: JSON.stringify({
            type: "hello-reply", id: "hello",
            reply: { protocol: 1, hostVersion: "test", capabilities: [], resync: false, missed: [], nextSeq: 0,
              host: { id: "fixture", name: "Studio", endpoints: [{ url: "http://10.0.0.4:7788/", kind: "lan" }] } },
          }) }));
        },
      };
    },
  });
  expect(result).toMatchObject({ state: "approved", environment: {
    token: "fixture-token", endpoints: [{ url: "https://studio.example:7788/" }],
  } });
  expect(sockets).toEqual(["wss://studio.example:7788/"]);
});
