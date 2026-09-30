// @vitest-environment node
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { connect as connectTcp } from "node:net";
import { once } from "node:events";
import { createPrivateKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createSelfSignedCertificate } from "../../main/self-signed-certificate";
import { certificateFingerprint, publicKeyPin } from "../../main/host-tls";
import { BrowserTunnel, initSync } from "../../../browser-connect/pkg/tau_browser_connect.js";

initSync({ module: readFileSync(new URL("../../../browser-connect/pkg/tau_browser_connect_bg.wasm", import.meta.url)) });

async function exercise(cert: string, key: string, pin: string, keyPin = true) {
  const server = createServer({ cert, key, minVersion: "TLSv1.3" }); const web = new WebSocketServer({ server });
  server.on("tlsClientError", () => undefined);
  let received = ""; let upgrades = 0;
  web.on("connection", (peer) => { upgrades++; peer.on("message", (data) => { received = data.toString(); peer.send(received); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number };
  const tunnel = new BrowserTunnel(`wss://localhost:${address.port}/path?keep=1`, "localhost", pin, keyPin);
  const socket = connectTcp(address.port, "127.0.0.1"); await once(socket, "connect");
  const ciphertext: Buffer[] = [];
  let failure: unknown;
  let opened = false;
  let echoed: string | undefined;
  const pump = () => {
    if (failure) return;
    try {
      const next = tunnel.poll(); if (next) opened = true;
      const text = tunnel.receive(); if (text) echoed = text;
      tunnel.flush();
      let bytes: Uint8Array; while ((bytes = tunnel.drain()).length) { ciphertext.push(Buffer.from(bytes)); socket.write(bytes); }
    } catch (error) { failure = error; }
  };
  socket.on("data", (bytes) => { try { for (let offset = 0; offset < bytes.length; offset += 65536) tunnel.feed(bytes.subarray(offset, offset + 65536)); pump(); } catch (error) { failure = error; } });
  socket.on("error", (error) => { failure = error; });
  pump();

  try {
    await expect.poll(() => opened || failure !== undefined).toBe(true);
    if (!failure && opened) {
      const message = JSON.stringify({ type: "hello", token: "paired-host-secret", text: "x".repeat(300000) });
      tunnel.send(message); pump(); await expect.poll(() => echoed !== undefined || failure !== undefined).toBe(true);
      expect(String(failure ?? "")).toBe(""); expect(echoed?.length).toBe(message.length); expect(received.length).toBe(message.length);
      expect(Buffer.concat(ciphertext).includes(Buffer.from("paired-host-secret"))).toBe(false);
    }
    return { failure, opened, upgrades, received };
  } finally { socket.destroy(); tunnel.free(); for (const peer of web.clients) peer.terminate(); web.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

describe("the shipped browser WASM verifies the host before WebSocket upgrade", () => {
  it("pins SPKI across certificate renewal and carries large host messages inside TLS", async () => {
    const options = { commonName: "Tau", dnsNames: ["localhost"], ipAddresses: [], days: 1 };
    const first = createSelfSignedCertificate(options);
    const renewed = createSelfSignedCertificate({ ...options, privateKey: createPrivateKey(first.key) });
    expect((await exercise(renewed.cert, renewed.key, publicKeyPin(first.cert))).failure).toBeUndefined();
  });
  it("rejects a different key before an upgrade or host credential leaves", async () => {
    const material = createSelfSignedCertificate({ commonName: "Tau", dnsNames: ["localhost"], ipAddresses: [], days: 1 });
    const result = await exercise(material.cert, material.key, "00".repeat(32));
    expect(String(result.failure)).toMatch(/pinned/u); expect(result.opened).toBe(false); expect(result.upgrades).toBe(0); expect(result.received).toBe("");
  });
  it("supports an explicit legacy certificate pin and rejects a wrong one", async () => {
    const material = createSelfSignedCertificate({ commonName: "Tau", dnsNames: ["localhost"], ipAddresses: [], days: 1 });
    expect((await exercise(material.cert, material.key, certificateFingerprint(material.cert), false)).failure).toBeUndefined();
    expect((await exercise(material.cert, material.key, "FF".repeat(32), false)).opened).toBe(false);
  });
});
