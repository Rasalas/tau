// @vitest-environment node
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:https";
import { connect } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket, createWebSocketStream } from "ws";
import { BrowserTunnel, initSync } from "../../../browser-connect/pkg/tau_browser_connect.js";
import { BrowserConnectSocket } from "./socket";
import type { BrowserConnectRoute } from "./offer";
import { buildCertificate, createSelfSignedCertificate } from "../../main/self-signed-certificate";
import { publicKeyPin } from "../../main/host-tls";
import { HostAccess } from "../../main/host-access";
import { HostTokenFile } from "../../main/host-token";
import { HostPushLog } from "../../main/host-push-log";
import { startSocketHostTransport } from "../../main/host-transport-socket";
import { pairWithHost } from "../../shared/host-pairing";
import { createSocketHostClient } from "../../workbench/host-connection-socket";

initSync({ module: readFileSync(new URL("../../../browser-connect/pkg/tau_browser_connect_bg.wasm", import.meta.url)) });
const serviceUrl = new URL("../../../connect-relay/service.mjs", import.meta.url).href;
const { createConnectRelay } = await import(/* @vite-ignore */ serviceUrl);

describe("browser Connect through a CA-verified relay and the real pinned host protocol", () => {
  it("pairs with bound digits, uses its own host token, reconnects and frees every route", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-browser-connect-"));
    const access = await HostAccess.open({ tokenFile: new HostTokenFile(join(directory, "host-token")), storePath: join(directory, "clients.json") });
    const hostTls = createSelfSignedCertificate({ commonName: "Tau", dnsNames: [], ipAddresses: ["127.0.0.1"], days: 1 });
    const host = await startSocketHostTransport({ listen: "127.0.0.1:0", trust: "proxy", methods: { ping: async (params) => ({ echo: params[0] }) }, access, pushLog: new HostPushLog(), hostVersion: "test", capabilities: ["replay"], tls: hostTls });
    const caKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    const ca = buildCertificate({ commonName: "Test relay CA", dnsNames: [], ipAddresses: [], days: 1, privateKey: caKey, issuer: { commonName: "Test relay CA", privateKey: caKey }, authority: true });
    const relayKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    const relayCert = buildCertificate({ commonName: "Relay", dnsNames: [], ipAddresses: ["127.0.0.1"], days: 1, privateKey: relayKey, issuer: { commonName: "Test relay CA", privateKey: caKey } });
    const server = createServer({ cert: relayCert, key: relayKey.export({ type: "pkcs8", format: "pem" }) });
    const admin = randomBytes(32).toString("base64url"); const relay = await createConnectRelay(server, { adminToken: admin });
    const peers: WebSocket[] = []; const bridges: ReturnType<typeof connect>[] = []; const browserSockets: BrowserConnectSocket[] = [];
    let client: ReturnType<typeof createSocketHostClient> | undefined;
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const credentials = await new Promise<{ id: string; clientToken: string; hostToken: string }>((resolve, reject) => {
        const registration = request(`${origin}/v1/routes`, { ca, method: "POST", headers: { Authorization: `Bearer ${admin}` } }, (response) => { let body = ""; response.on("data", (bytes) => { body += bytes; }); response.on("end", () => resolve(JSON.parse(body))); }); registration.on("error", reject); registration.end();
      });
      const control = new WebSocket(`${origin.replace("https:", "wss:")}/v1/host/${credentials.id}`, { ca, headers: { Authorization: `Bearer ${credentials.hostToken}` } }); peers.push(control);
      control.on("message", (bytes) => {
        const message = JSON.parse(String(bytes));
        const peer = new WebSocket(`${origin.replace("https:", "wss:")}/v1/data/${credentials.id}/${message.id}`, { ca, headers: { Authorization: `Bearer ${credentials.hostToken}` } }); peers.push(peer);
        peer.on("error", () => peer.terminate());
        peer.once("open", () => { const tcp = connect(host.port, "127.0.0.1"); bridges.push(tcp); const stream = createWebSocketStream(peer); stream.on("error", () => tcp.destroy()); tcp.on("error", () => peer.terminate()); peer.on("close", () => tcp.destroy()); tcp.pipe(stream).pipe(tcp); });
      });
      await once(control, "open");
      const route: BrowserConnectRoute = { relay: origin, id: credentials.id, token: credentials.clientToken, url: `wss://127.0.0.1:${host.port}/`, pin: publicKeyPin(hostTls.cert), key: true };
      const factory = () => {
        const socket = new BrowserConnectSocket(route, undefined, async (url, name, pin, key) => new BrowserTunnel(url, name, pin, key), (url) => new WebSocket(url, "tau-connect-v1", { ca }) as unknown as globalThis.WebSocket);
        browserSockets.push(socket); return socket;
      };
      const paired = await pairWithHost({ url: route.url, publicKey: route.pin, createSocket: factory, onWaiting: ({ verification }) => {
        const pending = access.overview().requests[0]!; expect(pending.verification).toBe(verification); void access.approvePairing(pending.id);
      } });
      expect(paired.state).toBe("approved"); if (paired.state !== "approved") throw new Error(JSON.stringify(paired));
      expect(paired.token).toMatch(/^tauc\./u); expect(paired.token).not.toBe(route.token);
      client = createSocketHostClient(route.url, paired.token, { createSocket: factory });
      const hello = await client.connection.start("compact"); expect(hello?.owner).toBe(false);
      expect(await client.connection.request("ping", ["through both TLS layers"])).toEqual({ echo: "through both TLS layers" });
      browserSockets.at(-1)!.close();
      await expect.poll(() => browserSockets.length).toBe(3);
      await expect.poll(() => client!.connection.getState()).toBe("connected");
      expect(await client.connection.request("ping", ["after reconnect"])).toEqual({ echo: "after reconnect" });
      client.connection.close(); await expect.poll(() => relay.stats().active).toBe(0);
    } finally {
      client?.connection.close(); for (const socket of browserSockets) socket.close(); for (const tcp of bridges) tcp.destroy(); for (const peer of peers) peer.terminate(); relay.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await host.close(); await access.flush(); await rm(directory, { recursive: true, force: true });
    }
  });
});
