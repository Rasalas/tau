import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HOST_ERROR, HOST_TRANSPORT_VERSION, decodeHostServerFrame, type HostServerFrame } from "../shared/host-transport.js";
import { DEFAULT_NETWORK_SETTINGS, parsePairingPayload, type UiConnections, type UiCreatedPairingLink, type UiNetworkAccess } from "../shared/connections.js";
import { pairingCommitment, pairingVerificationCode, randomPairingNonce, type HostPairReply } from "../shared/pairing.js";
import type { Interfaces } from "./host-endpoints.js";
import { HostAccess, type AccessAuditEntry, type AccessPeer, type PairingChannel } from "./host-access.js";
import { createConnectionsMethods, endpointOrigins, hostEndpoints, type HostConnectionsService } from "./host-connections.js";
import { HostPushLog } from "./host-push-log.js";
import { HostTokenFile, readHostToken } from "./host-token.js";
import { HostUplink } from "./host-uplink.js";
import { createProtocolServer, startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import type { HostMethodTable } from "./host-methods.js";
import { invokeHostMethod } from "./host-methods.js";
import { HOST_CORE_PRINCIPAL } from "./host-invocation.js";

const directories: string[] = [];
const sockets: WebSocket[] = [];
let transport: SocketHostTransport | undefined;

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await transport?.close();
  transport = undefined;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60_000;

async function openAccess(now: () => number = Date.now, directory = mkdtempSync(join(tmpdir(), "tau-access-")), audit?: (entry: AccessAuditEntry) => void) {
  if (!directories.includes(directory)) directories.push(directory);
  const tokenFile = new HostTokenFile(join(directory, "tau", "host-token"));
  const storePath = join(directory, "user-data", "paired-clients.json");
  let changes = 0;
  const access = await HostAccess.open({ tokenFile, storePath, now, onChange: () => { changes += 1; }, ...(audit ? { audit } : {}) });
  return { access, tokenFile, storePath, directory, changes: () => changes };
}

const peer = { address: "::ffff:192.0.2.7", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" };

/** A device's socket as the host sees it: every outcome the host settles lands here. */
function channel(open = true, fingerprint?: string): PairingChannel & { replies: HostPairReply[]; open: boolean } {
  const replies: HostPairReply[] = [];
  const state = {
    replies,
    open,
    ...(fingerprint ? { fingerprint } : {}),
    settle: (reply: HostPairReply) => {
      if (!state.open) return false;
      replies.push(reply);
      return true;
    },
  };
  return state;
}

/** Asks and lets the device in: what a device and its owner do together. */
async function pair(access: HostAccess, options: { code?: string; from?: AccessPeer; access?: "full" | "read-only"; name?: string } = {}): Promise<string> {
  const device = channel();
  const { id, reply } = access.requestPairing({ ...(options.code ? { code: options.code } : {}), ...(options.name ? { name: options.name } : {}) }, options.from ?? peer, device);
  if (!id || reply.state !== "waiting") throw new Error(`not waiting: ${JSON.stringify(reply)}`);
  expect(await access.approvePairing(id, options.access ? { access: options.access } : {})).toBe(true);
  const approved = device.replies.at(-1);
  if (approved?.state !== "approved") throw new Error("not approved");
  return approved.token;
}

describe("asking to pair", () => {
  it("gives nothing until the owner allows it, then a token of the device's own, once", async () => {
    const { access } = await openAccess();
    const { code, link } = access.createLink({ label: "Kitchen iPad" });
    expect(access.overview().links.map((entry) => entry.id)).toEqual([link.id]);
    const device = channel();
    const { id, reply } = access.requestPairing({ code }, peer, device);
    expect(reply).toMatchObject({ state: "waiting", requestId: id, verification: expect.stringMatching(/^\d{6}$/u) });
    // Spent by the request, and nobody is let in yet.
    expect(access.overview().links).toEqual([]);
    expect(access.overview().clients).toEqual([]);
    expect(access.overview().requests).toMatchObject([{ id, link: { label: "Kitchen iPad" }, verification: (reply as { verification: string }).verification, access: "full", address: "192.0.2.7" }]);

    expect(await access.approvePairing(id!)).toBe(true);
    const approved = device.replies[0];
    expect(approved).toMatchObject({ state: "approved", access: "full", token: expect.stringMatching(/^tauc\.[0-9a-f]{24}\.[\w-]{43}$/u) });
    expect(access.overview().requests).toEqual([]);
    expect(access.overview().clients).toMatchObject([{ label: "Kitchen iPad", device: { os: "iOS", browser: "Safari", kind: "phone" }, lastAddress: "192.0.2.7", access: "full", idleTimeoutDays: 90 }]);
    // A second approval of the same request lets nobody else in.
    expect(await access.approvePairing(id!)).toBe(false);
    expect(access.requestPairing({ code }, peer, channel()).reply).toEqual({ state: "refused", reason: "unknown-code" });
  });

  it("tells the device when the owner says no, and lets nobody in", async () => {
    const { access } = await openAccess();
    const device = channel();
    const { id } = access.requestPairing({ code: access.createLink().code }, peer, device);
    expect(access.denyPairing(id!)).toBe(true);
    expect(device.replies).toEqual([{ state: "denied" }]);
    expect(access.overview().clients).toEqual([]);
    expect(await access.approvePairing(id!)).toBe(false);
  });

  it("expires a request nobody answered and tells the device", async () => {
    let now = 1_000_000;
    const { access } = await openAccess(() => now);
    const device = channel();
    const { id } = access.requestPairing({ code: access.createLink().code }, peer, device);
    now += 2 * 60_000;
    access.sweep();
    expect(device.replies).toEqual([{ state: "expired" }]);
    expect(await access.approvePairing(id!)).toBe(false);
    expect(access.overview().clients).toEqual([]);
  });

  it("keeps no client for a device that left before it was allowed", async () => {
    const { access, storePath } = await openAccess();
    const device = channel();
    const { id } = access.requestPairing({ code: access.createLink().code }, peer, device);
    device.open = false;
    expect(await access.approvePairing(id!)).toBe(false);
    expect(access.overview().clients).toEqual([]);
    expect(readFileSync(storePath, "utf8")).not.toContain("secretHash\": \"");
  });

  it("forgets a request whose device withdrew", async () => {
    const { access, changes } = await openAccess();
    const { id } = access.requestPairing({}, peer, channel());
    const before = changes();
    access.withdrawPairing(id!);
    expect(access.overview().requests).toEqual([]);
    expect(changes()).toBeGreaterThan(before);
  });

  it("refuses an expired, spent or invented code with one answer, and spends an expired one", async () => {
    let now = 1_000_000;
    const { access } = await openAccess(() => now);
    const { code } = access.createLink({ lifetimeMs: 10 * 60_000 });
    now += 10 * 60_000;
    expect(access.requestPairing({ code }, peer, channel()).reply).toEqual({ state: "refused", reason: "unknown-code" });
    now -= 60_000;
    // Even with the clock back inside the window, the code is gone.
    expect(access.requestPairing({ code }, { address: "192.0.2.9" }, channel()).reply).toEqual({ state: "refused", reason: "unknown-code" });
    expect(access.requestPairing({ code: "not-a-code" }, { address: "192.0.2.8" }, channel()).reply).toEqual({ state: "refused", reason: "unknown-code" });
  });

  it("clamps a link to a day and drops it from the list when it expires", async () => {
    let now = 0;
    const { access } = await openAccess(() => now);
    const { link } = access.createLink({ lifetimeMs: 30 * DAY });
    expect(Date.parse(link.expiresAt)).toBe(DAY);
    now = DAY;
    expect(access.overview().links).toEqual([]);
  });

  it("can revoke a link before anyone uses it", async () => {
    const { access } = await openAccess();
    const { code, link } = access.createLink();
    expect(access.revokeLink(link.id)).toBe(true);
    expect(access.requestPairing({ code }, peer, channel()).reply).toMatchObject({ state: "refused", reason: "unknown-code" });
    expect(access.revokeLink(link.id)).toBe(false);
  });

  it("takes the preset from the link, and the owner's choice over it", async () => {
    const { access } = await openAccess();
    const readOnly = await pair(access, { code: access.createLink({ access: "read-only", label: "Watcher" }).code, from: { address: "192.0.2.10" } });
    const widened = await pair(access, { code: access.createLink({ access: "read-only" }).code, from: { address: "192.0.2.11" }, access: "full" });
    const clients = access.overview().clients;
    expect(clients.find((entry) => entry.id === readOnly.split(".")[1])).toMatchObject({ label: "Watcher", access: "read-only" });
    expect(clients.find((entry) => entry.id === widened.split(".")[1])).toMatchObject({ access: "full" });
  });

  it("asks the owner without a link too, one request per address and a few in all", async () => {
    const { access } = await openAccess();
    const first = access.requestPairing({ name: "Alex’s iPhone" }, peer, channel());
    expect(first.reply.state).toBe("waiting");
    expect(access.overview().requests).toMatchObject([{ name: "Alex’s iPhone" }]);
    expect(access.overview().requests[0]!.link).toBeUndefined();
    expect(access.requestPairing({}, peer, channel()).reply).toEqual({ state: "refused", reason: "busy" });
    access.requestPairing({}, { address: "192.0.2.21" }, channel());
    access.requestPairing({}, { address: "192.0.2.22" }, channel());
    expect(access.requestPairing({}, { address: "192.0.2.23" }, channel()).reply).toEqual({ state: "refused", reason: "busy" });
    // A link still gets through while others wait without one.
    expect(access.requestPairing({ code: access.createLink().code }, { address: "192.0.2.24" }, channel()).reply.state).toBe("waiting");
  });

  it("makes an address the owner said no to wait before it asks again without a link", async () => {
    let now = 1_000_000;
    const { access } = await openAccess(() => now);
    const { id } = access.requestPairing({}, peer, channel());
    access.denyPairing(id!);
    expect(access.requestPairing({}, peer, channel()).reply).toEqual({ state: "refused", reason: "busy" });
    now += 10 * 60_000;
    expect(access.requestPairing({}, peer, channel()).reply.state).toBe("waiting");
  });

  it("limits how often one address may ask", async () => {
    const { access } = await openAccess(() => 5_000);
    const replies = Array.from({ length: 6 }, () => access.requestPairing({ code: "guess" }, { address: "192.0.2.30" }, channel()).reply);
    expect(replies.slice(0, 5).every((reply) => reply.state === "refused" && reply.reason === "unknown-code")).toBe(true);
    expect(replies[5]).toEqual({ state: "refused", reason: "rate-limited", retryAfterMs: 1000 });
  });

  it("binds the digits to the certificate and both nonces when the device commits to one", async () => {
    const fingerprint = "AB:".repeat(31) + "AB";
    const { access } = await openAccess();
    const nonce = randomPairingNonce();
    const device = channel(true, fingerprint);
    const { id, reply } = access.requestPairing({ commitment: await pairingCommitment(nonce) }, peer, device);
    expect(reply).toMatchObject({ state: "challenge", requestId: id });
    // Not shown to the owner before the device revealed its nonce.
    expect(access.overview().requests).toEqual([]);
    const hostNonce = (reply as { hostNonce: string }).hostNonce;
    const waiting = await access.revealPairing(id!, nonce);
    const expected = await pairingVerificationCode({ fingerprint, deviceNonce: nonce, hostNonce });
    expect(waiting).toMatchObject({ state: "waiting", verification: expected });
    expect(access.overview().requests[0]!.verification).toBe(expected);
    // A relay with its own certificate would compute other digits.
    expect(await pairingVerificationCode({ fingerprint: "CD:".repeat(31) + "CD", deviceNonce: nonce, hostNonce })).not.toBe(expected);
  });

  it("ends a request whose revealed nonce is not the one it committed to", async () => {
    const { access } = await openAccess();
    const { id } = access.requestPairing({ commitment: await pairingCommitment(randomPairingNonce()) }, peer, channel());
    expect(await access.revealPairing(id!, randomPairingNonce())).toEqual({ state: "refused", reason: "invalid" });
    expect(await access.approvePairing(id!)).toBe(false);
  });
});

describe("client tokens", () => {
  it("are stored as hashes in a 0o600 file and survive a restart", async () => {
    const first = await openAccess();
    const token = await pair(first.access, { code: first.access.createLink().code });
    const stored = readFileSync(first.storePath, "utf8");
    expect(stored).not.toContain(token.split(".")[2]);
    if (process.platform !== "win32") expect(statSync(first.storePath).mode & 0o777).toBe(0o600);

    const again = await openAccess(Date.now, first.directory);
    expect(again.access.authenticate(token)).toEqual({ kind: "client", clientId: token.split(".")[1] });
    expect(again.access.overview().clients).toMatchObject([{ access: "full", idleTimeoutDays: 90 }]);
  });

  it("do not authenticate with a wrong secret, a wrong id or the host token's shape", async () => {
    const { access, tokenFile } = await openAccess();
    const token = await pair(access);
    const [prefix, id, secret] = token.split(".");
    // Another last character, whatever the random secret ends with.
    const altered = `${secret!.slice(0, -1)}${secret!.endsWith("A") ? "B" : "A"}`;
    expect(access.authenticate(`${prefix}.${id}.${altered}`)).toBeUndefined();
    expect(access.authenticate(`${prefix}.${"0".repeat(24)}.${secret}`)).toBeUndefined();
    expect(access.authenticate(`${token}.extra`)).toBeUndefined();
    expect(access.authenticate(undefined)).toBeUndefined();
    expect(access.authenticate(tokenFile.current())).toEqual({ kind: "owner" });
  });

  it("end after their idle timeout unused, and every use restarts the clock", async () => {
    let now = 1_000_000;
    const { access } = await openAccess(() => now);
    const token = await pair(access);
    const clientId = token.split(".")[1]!;
    expect(Date.parse(access.overview().clients[0]!.expiresAt!)).toBe(now + 90 * DAY);
    now += 89 * DAY;
    // A hello is a use: it restarts the ninety days.
    expect(access.authenticate(token)).toEqual({ kind: "client", clientId });
    const connection = access.attach({ kind: "client", clientId }, peer, () => undefined);
    access.detach(connection);
    now += 89 * DAY;
    expect(access.authenticate(token)).toEqual({ kind: "client", clientId });
    access.detach(access.attach({ kind: "client", clientId }, peer, () => undefined));
    now += 90 * DAY;
    expect(access.authenticate(token)).toBeUndefined();
    expect(access.overview().clients).toEqual([]);
  });

  it("never end while the device stays connected, however quiet", async () => {
    let now = 1_000_000;
    const { access } = await openAccess(() => now);
    const token = await pair(access);
    const clientId = token.split(".")[1]!;
    const connection = access.attach({ kind: "client", clientId }, peer, () => undefined);
    now += 400 * DAY;
    access.sweep();
    expect(access.overview().clients).toHaveLength(1);
    access.detach(connection);
    expect(access.authenticate(token)).toEqual({ kind: "client", clientId });
  });

  it("follow the timeout the owner picks, counted from the change, or never end", async () => {
    let now = 1_000_000;
    const { access } = await openAccess(() => now);
    const token = await pair(access);
    const clientId = token.split(".")[1]!;
    now += 40 * DAY;
    // Shorter than the time already unused: counted from now, so nothing ends on the spot.
    expect(await access.updateClient(clientId, { idleTimeoutDays: 30 })).toBe(true);
    expect(access.authenticate(token)).toEqual({ kind: "client", clientId });
    now += 31 * DAY;
    access.sweep();
    expect(access.authenticate(token)).toBeUndefined();

    const forever = await pair(access, { from: { address: "192.0.2.40" } });
    await access.updateClient(forever.split(".")[1]!, { idleTimeoutDays: null });
    now += 3650 * DAY;
    expect(access.authenticate(forever)).toMatchObject({ kind: "client" });
    expect(access.overview().clients[0]!.expiresAt).toBeUndefined();
  });

  it("read an older store as Full with the default timeout", async () => {
    const { directory } = await openAccess();
    mkdirSync(join(directory, "legacy"), { recursive: true });
    const storePath = join(directory, "legacy", "paired-clients.json");
    writeFileSync(storePath, JSON.stringify({ version: 1, clients: [{ id: "a".repeat(24), label: "Old phone", secretHash: "b".repeat(64), pairedAt: new Date().toISOString(), device: { kind: "phone" } }] }));
    const access = await HostAccess.open({ tokenFile: new HostTokenFile(join(directory, "tau", "host-token")), storePath });
    expect(access.overview().clients).toMatchObject([{ label: "Old phone", access: "full", idleTimeoutDays: 90 }]);
  });
});

describe("the owner's changes to a device", () => {
  it("rename it, change its preset and refuse nonsense", async () => {
    const { access } = await openAccess();
    const clientId = (await pair(access)).split(".")[1]!;
    expect(await access.updateClient(clientId, { label: "  Kitchen\u0000iPad ", access: "read-only" })).toBe(true);
    expect(access.overview().clients[0]).toMatchObject({ label: "Kitchen iPad", access: "read-only" });
    await expect(access.updateClient(clientId, { label: "   " })).rejects.toThrow(/needs a name/u);
    await expect(access.updateClient(clientId, { idleTimeoutDays: 7 as never })).rejects.toThrow(/idle timeout/u);
    await expect(access.updateClient(clientId, { access: "admin" as never })).rejects.toThrow(/full or read-only/u);
    expect(await access.updateClient("0".repeat(24), { label: "x" })).toBe(false);
  });

  it("sign out every other device at once", async () => {
    const { access } = await openAccess();
    const closed: string[] = [];
    const tokens = [await pair(access), await pair(access, { from: { address: "192.0.2.50" } })];
    for (const token of tokens) access.attach({ kind: "client", clientId: token.split(".")[1]! }, peer, (reason) => closed.push(reason));
    expect(await access.revokeOtherClients()).toBe(2);
    expect(closed).toEqual(["revoked", "revoked"]);
    expect(tokens.map((token) => access.authenticate(token))).toEqual([undefined, undefined]);
    expect(await access.revokeOtherClients()).toBe(0);
  });

  it("see the last change each device made, and hear of every refusal", async () => {
    const entries: AccessAuditEntry[] = [];
    const { access } = await openAccess(Date.now, undefined, (entry) => entries.push(entry));
    const clientId = (await pair(access, { name: "Phone" })).split(".")[1]!;
    const connection = access.attach({ kind: "client", clientId }, peer, () => undefined);
    access.audit(connection, "prompt", true);
    access.audit(connection, "tau.terminal/open", false);
    expect(access.overview().clients[0]!.lastAction).toMatchObject({ action: "prompt" });
    expect(entries).toEqual([
      { clientId, label: "Phone", action: "prompt", allowed: true },
      { clientId, label: "Phone", action: "tau.terminal/open", allowed: false },
    ]);
  });
});

// A host behind a real socket, so pairing, revocation and rotation are seen as a client sees them.
async function listen(access: HostAccess, methods: HostMethodTable = {}, helloTimeoutMs?: number) {
  transport = await startSocketHostTransport({
    listen: "127.0.0.1:0",
    methods: { ping: async () => "pong", ...methods },
    pushLog: new HostPushLog(),
    hostVersion: "test",
    capabilities: [],
    access,
    ...(helloTimeoutMs ? { helloTimeoutMs } : {}),
  });
  return transport.port;
}

interface TestClient {
  socket: WebSocket;
  closed: Promise<{ code: number; reason: string }>;
  frames: HostServerFrame[];
  hello(token: string): Promise<HostServerFrame>;
  send(frame: object): void;
  next(type: HostServerFrame["type"]): Promise<HostServerFrame>;
  request(method: string, params?: unknown[]): Promise<{ result?: unknown; error?: { code: string; message: string } }>;
}

async function connect(port: number, headers?: Record<string, string>): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, headers ? { headers } : undefined);
  sockets.push(socket);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: String(reason) })));
  await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  const frames: HostServerFrame[] = [];
  const waiting = new Map<string, (frame: HostServerFrame) => void>();
  const typed: Array<{ type: string; resolve(frame: HostServerFrame): void }> = [];
  socket.on("message", (data) => {
    const frame = decodeHostServerFrame(JSON.parse(String(data)) as unknown)!;
    const id = frame.type === "response" ? frame.response.id : frame.type === "hello-reply" ? frame.id : undefined;
    const resolve = id ? waiting.get(id) : undefined;
    if (resolve && id) { waiting.delete(id); resolve(frame); return; }
    const index = typed.findIndex((entry) => entry.type === frame.type);
    if (index >= 0) typed.splice(index, 1)[0]!.resolve(frame);
    else frames.push(frame);
  });
  let counter = 0;
  const send = (frame: object, id: string) => new Promise<HostServerFrame>((resolve, reject) => {
    waiting.set(id, resolve);
    void closed.then(({ code }) => reject(new Error(`closed ${code}`)));
    socket.send(JSON.stringify(frame));
  });
  return {
    socket,
    closed,
    frames,
    hello: (token) => send({ type: "hello", id: "h", hello: { protocol: HOST_TRANSPORT_VERSION, token } }, "h"),
    send: (frame) => socket.send(JSON.stringify(frame)),
    next: (type) => {
      const index = frames.findIndex((frame) => frame.type === type);
      if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]!);
      return new Promise((resolve) => typed.push({ type, resolve }));
    },
    request: async (method, params = []) => {
      const id = `r${++counter}`;
      const frame = await send({ type: "request", request: { id, method, params } }, id);
      return frame.type === "response" ? frame.response : {};
    },
  };
}

async function client(port: number, token: string): Promise<TestClient> {
  const opened = await connect(port);
  await opened.hello(token);
  return opened;
}

function refusedHello(port: number, token: string): Promise<{ code: number; reason: string }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("open", () => socket.send(JSON.stringify({ type: "hello", id: "h", hello: { protocol: HOST_TRANSPORT_VERSION, token } })));
    socket.once("message", () => reject(new Error("the hello was answered")));
    socket.once("close", (code, reason) => resolve({ code, reason: String(reason) }));
  });
}

const connectionsOf = (access: HostAccess) => createConnectionsMethods(() => ({
  access,
  listen: () => ({ scheme: "wss", host: "192.0.2.5", port: 4100, webClient: false, fingerprint: "AB:".repeat(31) + "AB" }),
  hostId: "f".repeat(32),
  hostName: "studio",
})) as HostMethodTable;

describe("pairing over the socket", () => {
  it("waits for the owner's answer and lets the device say hello on the same socket", async () => {
    const { access, tokenFile } = await openAccess();
    const port = await listen(access, { ...connectionsOf(access), "bootstrap": async () => "state" });
    const owner = await client(port, tokenFile.current());
    const created = (await owner.request("connections-create-link", [{ label: "Phone" }])).result as UiCreatedPairingLink;

    const device = await connect(port);
    device.send({ type: "pair", id: "p1", pair: { code: created.code } });
    const waiting = await device.next("pair-reply");
    expect(waiting).toMatchObject({ type: "pair-reply", id: "p1", reply: { state: "waiting" } });
    const verification = (waiting as { reply: { verification: string } }).reply.verification;
    // Nothing runs before a hello, pairing or not.
    expect((await owner.request("connections-list")).result).toMatchObject({ requests: [{ verification, link: { label: "Phone" } }] });

    const listed = (await owner.request("connections-list")).result as UiConnections;
    expect((await owner.request("connections-approve", [listed.requests[0]!.id, { access: "read-only" }])).result).toEqual({ approved: true });
    const approved = await device.next("pair-reply");
    expect(approved).toMatchObject({ reply: { state: "approved", access: "read-only" } });
    const token = (approved as { reply: { token: string } }).reply.token;
    const hello = await device.hello(token);
    expect(hello).toMatchObject({ type: "hello-reply", reply: { access: "read-only" } });
    expect((await device.request("bootstrap")).result).toBe("state");
  });

  it("closes the device's socket when the owner says no", async () => {
    const { access, tokenFile } = await openAccess();
    const port = await listen(access, connectionsOf(access));
    const owner = await client(port, tokenFile.current());
    const device = await connect(port);
    device.send({ type: "pair", id: "p1", pair: {} });
    await device.next("pair-reply");
    const [request] = ((await owner.request("connections-list")).result as UiConnections).requests;
    expect(request!.link).toBeUndefined();
    await owner.request("connections-deny", [request!.id]);
    expect(await device.next("pair-reply")).toMatchObject({ reply: { state: "denied" } });
    expect(await device.closed).toEqual({ code: 1000, reason: "denied" });
  });

  it("withdraws the request when the device goes away", async () => {
    const { access } = await openAccess();
    const port = await listen(access);
    const device = await connect(port);
    device.send({ type: "pair", id: "p1", pair: {} });
    await device.next("pair-reply");
    expect(access.overview().requests).toHaveLength(1);
    device.socket.close();
    await device.closed;
    await expect.poll(() => access.overview().requests).toEqual([]);
  });

  it("keeps a waiting device past the hello deadline, and gives it a new one once let in", async () => {
    const { access } = await openAccess();
    const port = await listen(access, {}, 20);
    const device = await connect(port);
    device.send({ type: "pair", id: "p1", pair: {} });
    await device.next("pair-reply");
    // A socket that neither pairs nor says hello is closed by the same deadline; by then the device's has passed too.
    const idle = await connect(port);
    expect(await idle.closed).toMatchObject({ code: 4408 });
    expect(device.socket.readyState).toBe(WebSocket.OPEN);
    await access.approvePairing(access.overview().requests[0]!.id);
    expect(await device.closed).toMatchObject({ code: 4408 });
  });

  it("refuses a pair frame from a socket that already said hello", async () => {
    const { access, tokenFile } = await openAccess();
    const port = await listen(access);
    const owner = await client(port, tokenFile.current());
    owner.send({ type: "pair", id: "p1", pair: {} });
    expect(await owner.next("pair-reply")).toMatchObject({ reply: { state: "refused", reason: "invalid" } });
  });

  it("runs the committed exchange a pinning device uses", async () => {
    const { access } = await openAccess();
    const port = await listen(access);
    const device = await connect(port);
    const nonce = randomPairingNonce();
    device.send({ type: "pair", id: "p1", pair: { commitment: await pairingCommitment(nonce), name: "Tablet" } });
    const challenge = await device.next("pair-reply") as { reply: { state: string; hostNonce: string } };
    expect(challenge.reply.state).toBe("challenge");
    device.send({ type: "pair-reveal", id: "p1", nonce });
    // A plaintext loopback socket has no certificate to bind to.
    const expected = await pairingVerificationCode({ deviceNonce: nonce, hostNonce: challenge.reply.hostNonce });
    expect(await device.next("pair-reply")).toMatchObject({ reply: { state: "waiting", verification: expected } });
    expect(access.overview().requests).toMatchObject([{ name: "Tablet", verification: expected }]);
  });
});

describe("listeners beyond this machine", () => {
  /** A listener a reverse proxy feeds: every peer dials from 127.0.0.1 and none of them is this machine. */
  async function proxyListener() {
    const server = createProtocolServer();
    transport!.attach(server, "proxy");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    return { server, port: typeof address === "object" && address ? address.port : 0 };
  }

  it("let the host token use the host but not manage access or stop it", async () => {
    const { access, tokenFile } = await openAccess();
    const port = await listen(access, { ...connectionsOf(access), "bootstrap": async () => "state", "host.shutdown": async () => "stopping" });
    const proxy = await proxyListener();
    try {
      const remote = await client(proxy.port, tokenFile.current());
      expect((await remote.request("bootstrap")).result).toBe("state");
      for (const method of ["connections-list", "connections-approve", "connections-rotate-host-token", "connections-set-network", "host.shutdown"]) {
        expect((await remote.request(method)).error, method).toMatchObject({ code: HOST_ERROR.forbidden });
      }
      const local = await client(port, tokenFile.current());
      expect((await local.request("connections-list")).result).toMatchObject({ requests: [] });
    } finally {
      proxy.server.close();
    }
  });

  it("count pairing attempts through a proxy apart and strictly, by the address it forwarded", async () => {
    const { access, tokenFile } = await openAccess();
    const port = await listen(access, connectionsOf(access));
    const proxy = await proxyListener();
    try {
      const ask = async (target: number, forwarded?: string, request: object = { code: "invented" }) => {
        const device = await connect(target, forwarded ? { "x-forwarded-for": forwarded } : undefined);
        device.send({ type: "pair", id: "p", pair: request });
        return { device, reply: (await device.next("pair-reply") as { reply: HostPairReply }).reply };
      };
      const replies = [];
      for (let attempt = 0; attempt < 6; attempt += 1) replies.push((await ask(proxy.port, "100.64.0.9")).reply);
      expect(replies.map((reply) => (reply.state === "refused" ? reply.reason : reply.state))).toEqual(["unknown-code", "unknown-code", "unknown-code", "unknown-code", "unknown-code", "rate-limited"]);
      expect((await ask(proxy.port, "100.64.0.10")).reply).toMatchObject({ reason: "unknown-code" });
      // This machine's own browser on the loopback listener is untouched by all of it.
      expect((await ask(port)).reply).toMatchObject({ reason: "unknown-code" });

      const { reply } = await ask(proxy.port, "100.101.102.103", { name: "Phone over the tailnet" });
      expect(reply.state).toBe("waiting");
      const owner = await client(port, tokenFile.current());
      const [request] = ((await owner.request("connections-list")).result as UiConnections).requests;
      expect(request).toMatchObject({ name: "Phone over the tailnet", address: "100.101.102.103" });
    } finally {
      proxy.server.close();
    }
  });
});

describe("a Read-only device", () => {
  it("is told so at hello, and a change of preset applies at its next call", async () => {
    const { access, tokenFile } = await openAccess();
    const methods: HostMethodTable = {
      ...connectionsOf(access),
      "prompt": async () => "sent",
      "bootstrap": async () => "state",
    };
    const port = await listen(access, methods);
    const owner = await client(port, tokenFile.current());
    const token = await pair(access, { code: access.createLink({ access: "read-only" }).code });
    const phone = await connect(port);
    expect(await phone.hello(token)).toMatchObject({ reply: { access: "read-only" } });
    expect((await phone.request("bootstrap")).result).toBe("state");
    expect((await phone.request("prompt", ["hi"])).error).toMatchObject({ code: HOST_ERROR.forbidden, message: expect.stringMatching(/Read only/u) });

    await owner.request("connections-update-client", [token.split(".")[1], { access: "full" }]);
    expect((await phone.request("prompt", ["hi"])).result).toBe("sent");
    expect(access.overview().clients[0]!.lastAction).toMatchObject({ action: "prompt" });
  });
});

describe("revoking a client", () => {
  it("closes its live connection at once and refuses its next hello", async () => {
    const { access, tokenFile } = await openAccess();
    const port = await listen(access);
    const token = await pair(access);
    const phone = await client(port, token);
    const owner = await client(port, tokenFile.current());
    expect((await phone.request("ping")).result).toBe("pong");
    expect(access.overview().clients[0]!.connections).toBe(1);

    expect(await access.revokeClient(token.split(".")[1]!)).toBe(true);
    expect(await phone.closed).toEqual({ code: 4401, reason: "revoked" });
    expect(await refusedHello(port, token)).toEqual({ code: 4401, reason: "unauthorized" });
    // The owner is not touched by it.
    expect((await owner.request("ping")).result).toBe("pong");
    expect(access.overview().clients).toEqual([]);
  });

  it("signs out every other device's live connection", async () => {
    const { access, tokenFile } = await openAccess();
    const port = await listen(access, connectionsOf(access));
    const owner = await client(port, tokenFile.current());
    const phone = await client(port, await pair(access));
    expect((await owner.request("connections-revoke-others")).result).toEqual({ revoked: 1 });
    expect(await phone.closed).toEqual({ code: 4401, reason: "revoked" });
  });
});

describe("rotating the host token", () => {
  it("closes every other connection on the old token, keeps the caller's and every paired client", async () => {
    const { access, tokenFile } = await openAccess();
    const methods = createConnectionsMethods(() => ({ access, listen: () => undefined })) as HostMethodTable;
    const port = await listen(access, methods);
    const old = tokenFile.current();
    const caller = await client(port, old);
    const other = await client(port, old);
    const phone = await client(port, await pair(access));

    const rotated = await caller.request("connections-rotate-host-token");
    const { token } = rotated.result as { token: string };
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    expect(token).not.toBe(old);
    expect(readFileSync(tokenFile.path, "utf8").trim()).toBe(token);
    if (process.platform !== "win32") expect(statSync(tokenFile.path).mode & 0o777).toBe(0o600);

    expect(await other.closed).toEqual({ code: 4401, reason: "token-rotated" });
    expect((await caller.request("ping")).result).toBe("pong");
    expect((await phone.request("ping")).result).toBe("pong");
    expect(await refusedHello(port, old)).toEqual({ code: 4401, reason: "unauthorized" });
    await client(port, token);
  });

  it("lets a window's uplink pick the new token up from the file and carry on", async () => {
    const { access, tokenFile } = await openAccess();
    const port = await listen(access);
    let onHello: () => void = () => undefined;
    const uplink = new HostUplink({
      url: `ws://127.0.0.1:${port}`,
      token: tokenFile.current(),
      refreshToken: () => readHostToken(tokenFile.path),
      onHello: () => onHello(),
    });
    try {
      expect(await uplink.request("ping")).toBe("pong");
      const again = new Promise<void>((resolve) => { onHello = resolve; });
      access.rotateHostToken();
      // The old connection is closed; the next one says hello with what the file holds now.
      await again;
      expect(await uplink.request("ping")).toBe("pong");
    } finally {
      uplink.close();
    }
  });

  it("follows a token another process wrote into the file", async () => {
    const { access, tokenFile } = await openAccess();
    const replaced = "d".repeat(64);
    // A new file renamed over it, as a rotation writes it: another inode, whatever the clock's resolution.
    writeFileSync(`${tokenFile.path}.new`, `${replaced}\n`, { mode: 0o600 });
    renameSync(`${tokenFile.path}.new`, tokenFile.path);
    expect(access.authenticate(replaced)).toEqual({ kind: "owner" });
    // A file that went missing keeps the last good token instead of locking the owner out.
    rmSync(tokenFile.path);
    expect(access.authenticate(replaced)).toEqual({ kind: "owner" });
  });
});

describe("the Connections methods", () => {
  it("answer the owner and refuse a paired client, even through a job", async () => {
    const { access, tokenFile } = await openAccess();
    const connections = createConnectionsMethods(() => ({ access, listen: () => ({ scheme: "ws", host: "127.0.0.1", port: 4100, webClient: true }) }));
    const methods: HostMethodTable = {
      ...connections,
      "start-job": async (params, context) => connections[params[0] as string]!(params[1] as unknown[], context),
    };
    const port = await listen(access, methods);
    const owner = await client(port, tokenFile.current());
    const created = (await owner.request("connections-create-link", [{ label: "Laptop" }])).result as UiCreatedPairingLink;
    expect(created.urls).toEqual([{ url: `http://127.0.0.1:4100/#pair=${encodeURIComponent(created.code)}&k=loopback`, label: "This machine", reachability: "loopback", kind: "loopback" }]);

    const token = await pair(access, { code: created.code });
    const phone = await client(port, token);
    for (const method of ["connections-list", "connections-create-link", "connections-rotate-host-token", "connections-set-network", "connections-reload-certificate", "connections-approve", "connections-update-client", "connections-revoke-others"]) {
      expect((await phone.request(method)).error?.code).toBe(HOST_ERROR.forbidden);
    }
    expect((await phone.request("start-job", ["connections-revoke-client", [token.split(".")[1]]])).error?.code).toBe(HOST_ERROR.forbidden);

    const list = (await owner.request("connections-list")).result as UiConnections;
    expect(list.clients).toMatchObject([{ label: "Laptop", connections: 1, current: false }]);
    expect(list.owners).toMatchObject([{ current: true }]);
    expect(list.tokenPath).toBe(tokenFile.path);
  });

  it("put every network address, the fingerprint and the host's id in each link", async () => {
    const { access, tokenFile } = await openAccess();
    const port = await listen(access, connectionsOf(access));
    const owner = await client(port, tokenFile.current());
    const created = (await owner.request("connections-create-link", [{ access: "read-only" }])).result as UiCreatedPairingLink;
    expect(created.link.access).toBe("read-only");
    expect(created.urls.map((endpoint) => endpoint.reachability)).toEqual(["network"]);
    expect(parsePairingPayload(created.urls[0]!.url)).toEqual({
      code: created.code,
      fingerprint: "AB:".repeat(31) + "AB",
      hostId: "f".repeat(32),
      hostName: "studio",
      endpoints: [{ url: "https://192.0.2.5:4100/", kind: "lan" }],
    });
  });

  it("say so on a host without a listener", async () => {
    const methods = createConnectionsMethods(() => undefined) as HostMethodTable;
    await expect(invokeHostMethod(methods, "connections-list", [], HOST_CORE_PRINCIPAL)).rejects.toMatchObject({ code: HOST_ERROR.unsupported });
  });

  it("list network access with its endpoints after the host's own, and change it for the owner", async () => {
    const { access } = await openAccess();
    const updates: unknown[] = [];
    let state: UiNetworkAccess = { settings: DEFAULT_NETWORK_SETTINGS, listeners: [], problems: [], tailscaleUp: false };
    const service: HostConnectionsService = {
      access,
      listen: () => ({ scheme: "ws", host: "127.0.0.1", port: 4100, webClient: true }),
      interfaces: () => ({ en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }] }) as unknown as Interfaces,
      names: async () => ({ localName: "box.local" }),
      network: {
        state: () => state,
        endpoints: () => state.listeners.length ? [{ url: "https://192.168.1.20:7788/", label: "LAN (en0)", reachability: "network", kind: "lan" }] : [],
        update: async (input) => {
          updates.push(input);
          state = {
            ...state,
            settings: { ...state.settings, ...input } as UiNetworkAccess["settings"],
            listeners: [{ host: "::", port: 7788, kind: "network" }],
            certificate: { source: "self-signed", fingerprint: "CD:".repeat(31) + "CD", validTo: "", certPath: "", warnings: [] },
          };
          return state;
        },
      },
    };
    const methods = createConnectionsMethods(() => service) as HostMethodTable;
    const off = await invokeHostMethod(methods, "connections-list", [], HOST_CORE_PRINCIPAL) as UiConnections;
    expect(off.endpoints.map((endpoint) => endpoint.label)).toEqual(["This machine"]);
    expect(off.network?.settings.lan).toBe(false);

    await expect(invokeHostMethod(methods, "connections-set-network", [{ port: 22 }], HOST_CORE_PRINCIPAL)).rejects.toThrow(/1024/u);
    await invokeHostMethod(methods, "connections-set-network", [{ lan: true }], HOST_CORE_PRINCIPAL);
    expect(updates).toEqual([{ lan: true }]);
    const on = await invokeHostMethod(methods, "connections-list", [], HOST_CORE_PRINCIPAL) as UiConnections;
    expect(on.endpoints.map((endpoint) => endpoint.label)).toEqual(["LAN (en0)", "This machine"]);
    const link = await invokeHostMethod(methods, "connections-create-link", [], HOST_CORE_PRINCIPAL) as UiCreatedPairingLink;
    // The host's own listener is plaintext loopback here; a phone meets the network listeners' certificate.
    expect(parsePairingPayload(link.urls[0]!.url)).toMatchObject({ code: link.code, fingerprint: "CD:".repeat(31) + "CD", endpoints: [{ url: "https://192.168.1.20:7788/", kind: "lan" }] });
    await expect(invokeHostMethod(methods, "connections-reload-certificate", [], HOST_CORE_PRINCIPAL)).rejects.toMatchObject({ code: HOST_ERROR.unsupported });
    expect(await endpointOrigins(service)).toEqual(["https://192.168.1.20:7788", "http://127.0.0.1:4100"]);
  });

  it("list a package's published endpoint first, in pairing links and among the page origins", async () => {
    const { access } = await openAccess();
    const served = { url: "https://box.tail0000.ts.net/", label: "Tailscale HTTPS", reachability: "network" as const, kind: "magicdns" as const, trustedCertificate: true };
    const service: HostConnectionsService = {
      access,
      listen: () => ({ scheme: "ws", host: "127.0.0.1", port: 4100, webClient: true }),
      interfaces: () => ({}) as Interfaces,
      published: () => [served],
    };
    const methods = createConnectionsMethods(() => service) as HostMethodTable;
    const list = await invokeHostMethod(methods, "connections-list", [], HOST_CORE_PRINCIPAL) as UiConnections;
    expect(list.endpoints).toEqual([served, expect.objectContaining({ label: "This machine" })]);
    const link = await invokeHostMethod(methods, "connections-create-link", [], HOST_CORE_PRINCIPAL) as UiCreatedPairingLink;
    expect(link.urls[0]).toMatchObject({ url: `https://box.tail0000.ts.net/#pair=${encodeURIComponent(link.code)}&k=magicdns`, trustedCertificate: true });
    expect(await endpointOrigins(service)).toEqual(["https://box.tail0000.ts.net", "http://127.0.0.1:4100"]);
  });
});

describe("host endpoints", () => {
  const interfaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }],
  } as unknown as Parameters<typeof hostEndpoints>[1];

  it("name one URL per usable address of a wildcard bind, and loopback last", () => {
    expect(hostEndpoints({ scheme: "wss", host: "0.0.0.0", port: 7788, webClient: true }, interfaces)).toEqual([
      { url: "https://192.168.1.20:7788/", label: "LAN (en0)", reachability: "network", kind: "lan", interface: "en0" },
      { url: "https://127.0.0.1:7788/", label: "This machine", reachability: "loopback", kind: "loopback" },
    ]);
  });

  it("keep a loopback bind on this machine", () => {
    expect(hostEndpoints({ scheme: "ws", host: "127.0.0.1", port: 1, webClient: true }, interfaces)).toEqual([
      { url: "http://127.0.0.1:1/", label: "This machine", reachability: "loopback", kind: "loopback" },
    ]);
  });
});
