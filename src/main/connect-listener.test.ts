import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { HOST_CAPABILITY, HOST_CLOSE_CODE, HOST_TRANSPORT_VERSION, type HostServerFrame } from "../shared/host-transport.js";
import type { HostPairRequest } from "../shared/pairing.js";
import { openConnectListener } from "./connect-listener.js";
import { HostAccess } from "./host-access.js";
import { isHostOwner } from "./host-invocation.js";
import { HostPushLog } from "./host-push-log.js";
import { HostTokenFile } from "./host-token.js";
import { certificateFingerprint, publicKeyPin } from "./host-tls.js";
import { startSocketHostTransport } from "./host-transport-socket.js";
import { createSelfSignedCertificate } from "./self-signed-certificate.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "tau-connect-listener-"));
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }));
  const tokenFile = new HostTokenFile(join(folder, "host-token"));
  const access = await HostAccess.open({ tokenFile, storePath: join(folder, "clients.json"), now: () => 0 });
  cleanup.push(() => access.flush());
  const transport = await startSocketHostTransport({
    listen: "127.0.0.1:0", access, capabilities: [],
    methods: { bootstrap: async (_params, context) => ({ owner: isHostOwner(context.principal) }) },
    hostVersion: "test", pushLog: new HostPushLog(),
  });
  cleanup.push(() => transport.close());
  const material = createSelfSignedCertificate({ commonName: "Tau test", dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"], days: 30 });
  const listener = await openConnectListener(transport, {
    ...material, publicKey: publicKeyPin(material.cert), fingerprint: certificateFingerprint(material.cert),
  });
  cleanup.push(() => listener.close());
  const connect = async (forwarded: string, headers: Record<string, string> = {}) => {
    const socket = new WebSocket(`wss://127.0.0.1:${listener.port}`, {
      ca: material.cert,
      headers: { "x-forwarded-for": forwarded, "tailscale-user-login": "forged@example.com", ...headers },
    });
    cleanup.push(() => socket.terminate());
    await once(socket, "open");
    return socket;
  };
  return { access, tokenFile, transport, connect };
}

async function exchange(socket: WebSocket, frame: object): Promise<HostServerFrame> {
  const reply = once(socket, "message");
  socket.send(JSON.stringify(frame));
  const [data] = await reply;
  return JSON.parse(String(data)) as HostServerFrame;
}

const pair = (socket: WebSocket, request: HostPairRequest = {}) => exchange(socket, { type: "pair", id: "p", pair: request });

it("shows the tunnel address in the owner's pairing request and cannot evade a denial with a forwarded address", async () => {
  const { access, connect } = await fixture();
  const socket = await connect("10.0.0.1, 100.64.0.9");
  expect(await pair(socket, { name: "Tunnel device" })).toMatchObject({ type: "pair-reply", reply: { state: "waiting" } });
  const [waiting] = access.overview().requests;
  expect(waiting).toMatchObject({ name: "Tunnel device", address: "127.0.0.1" });
  const denied = once(socket, "message");
  expect(access.denyPairing(waiting!.id)).toBe(true);
  await denied;
  expect(await pair(await connect("100.64.0.10"))).toMatchObject({ reply: { state: "refused", reason: "busy" } });
  expect(access.overview().requests).toEqual([]);
});

it("cannot authorize a browser origin through a client-supplied forwarded host", async () => {
  const { connect } = await fixture();
  const socket = await connect("127.0.0.1", { origin: "https://forged.example", "x-forwarded-host": "forged.example" });
  const outcome = new Promise<unknown>((resolve) => {
    socket.once("close", resolve);
    socket.once("message", () => resolve("pair-reply"));
  });
  socket.send(JSON.stringify({ type: "pair", id: "p", pair: { name: "Forged origin" } }));
  expect(await outcome).toBe(HOST_CLOSE_CODE.forbiddenOrigin);
});

it("counts forged source addresses in one strict tunnel bucket without exhausting loopback or proxy buckets", async () => {
  const { access, transport, connect } = await fixture();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const socket = await connect(`192.0.2.${attempt + 1}`);
    expect(await pair(socket, { code: "invented" })).toMatchObject({ reply: { state: "refused", reason: "unknown-code" } });
  }
  expect(await pair(await connect("192.0.2.6"), { code: "invented" })).toMatchObject({
    reply: { state: "refused", reason: "rate-limited", retryAfterMs: 1000 },
  });
  const local = new WebSocket(`ws://127.0.0.1:${transport.port}`);
  cleanup.push(() => local.terminate());
  await once(local, "open");
  expect(await pair(local, { code: "invented" })).toMatchObject({ reply: { state: "refused", reason: "unknown-code" } });
  expect(access.requestPairing({ code: "invented" }, { trust: "proxy", address: "127.0.0.1" }, { settle: () => true }).reply)
    .toMatchObject({ state: "refused", reason: "unknown-code" });
});

it("ignores proxy identity headers and grants no local privileges even with the host token", async () => {
  vi.stubEnv("TAU_HOST_LOCAL_FILES", "1");
  const { access, tokenFile, connect } = await fixture();
  const socket = await connect("127.0.0.1");
  const reply = await exchange(socket, {
    type: "hello", id: "h", hello: { protocol: HOST_TRANSPORT_VERSION, token: tokenFile.current() },
  });
  expect(reply.type).toBe("hello-reply");
  if (reply.type !== "hello-reply") throw new Error("Expected a hello reply.");
  expect(reply.reply.capabilities).not.toContain(HOST_CAPABILITY.localFiles);
  const [owner] = access.overview().owners;
  expect(owner).toMatchObject({ address: "127.0.0.1" });
  expect(owner).not.toHaveProperty("proxyUser");
  expect(await exchange(socket, { type: "request", request: { id: "r", method: "bootstrap", params: [] } }))
    .toMatchObject({ type: "response", response: { result: { owner: false } } });
});
