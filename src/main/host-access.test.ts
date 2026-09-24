import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HOST_ERROR, HOST_TRANSPORT_VERSION, decodeHostServerFrame, type HostServerFrame } from "../shared/host-transport.js";
import { DEFAULT_NETWORK_SETTINGS, type UiConnections, type UiCreatedPairingLink, type UiNetworkAccess } from "../shared/connections.js";
import type { Interfaces } from "./host-endpoints.js";
import { HostAccess } from "./host-access.js";
import { createConnectionsMethods, endpointOrigins, hostEndpoints, type HostConnectionsService } from "./host-connections.js";
import { HostPushLog } from "./host-push-log.js";
import { HostTokenFile, readHostToken } from "./host-token.js";
import { HostUplink } from "./host-uplink.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
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

async function openAccess(now: () => number = Date.now, directory = mkdtempSync(join(tmpdir(), "tau-access-"))) {
  if (!directories.includes(directory)) directories.push(directory);
  const tokenFile = new HostTokenFile(join(directory, "tau", "host-token"));
  const storePath = join(directory, "user-data", "paired-clients.json");
  return { access: await HostAccess.open({ tokenFile, storePath, now }), tokenFile, storePath, directory };
}

const peer = { address: "::ffff:192.0.2.7", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" };

describe("pairing links", () => {
  it("are redeemed once; the second attempt gets nothing", async () => {
    const { access } = await openAccess();
    const { code, link } = access.createLink({ label: "Kitchen iPad" });
    expect(access.overview().links.map((entry) => entry.id)).toEqual([link.id]);
    const token = await access.redeem(code, peer);
    expect(token).toMatch(/^tauc\.[0-9a-f]{24}\.[\w-]{43}$/u);
    expect(await access.redeem(code, peer)).toBeUndefined();
    // Spent links leave the list; the client they made takes the label.
    expect(access.overview().links).toEqual([]);
    expect(access.overview().clients).toMatchObject([{ label: "Kitchen iPad", device: { os: "iOS", browser: "Safari", kind: "phone" }, lastAddress: "192.0.2.7" }]);
  });

  it("expire, and an expired code is spent by the attempt", async () => {
    let now = 1_000_000;
    const { access } = await openAccess(() => now);
    const { code } = access.createLink({ lifetimeMs: 10 * 60_000 });
    now += 10 * 60_000;
    expect(await access.redeem(code, peer)).toBeUndefined();
    now -= 60_000;
    // Even with the clock back inside the window, the code is gone.
    expect(await access.redeem(code, peer)).toBeUndefined();
    expect(access.overview().clients).toEqual([]);
  });

  it("drop out of the list when they expire and clamp their lifetime to a day", async () => {
    let now = 0;
    const { access } = await openAccess(() => now);
    const { link } = access.createLink({ lifetimeMs: 30 * 86_400_000 });
    expect(Date.parse(link.expiresAt)).toBe(86_400_000);
    now = 86_400_000;
    expect(access.overview().links).toEqual([]);
  });

  it("can be revoked before anyone uses them", async () => {
    const { access } = await openAccess();
    const { code, link } = access.createLink();
    expect(access.revokeLink(link.id)).toBe(true);
    expect(await access.redeem(code, peer)).toBeUndefined();
    expect(access.revokeLink(link.id)).toBe(false);
  });

  it("refuses an invented code and one in the shape of a token", async () => {
    const { access } = await openAccess();
    expect(await access.redeem("not-a-code", peer)).toBeUndefined();
    expect(await access.redeem("x".repeat(10_000), peer)).toBeUndefined();
  });
});

describe("client tokens", () => {
  it("are stored as hashes in a 0o600 file and survive a restart", async () => {
    const first = await openAccess();
    const { code } = first.access.createLink();
    const token = (await first.access.redeem(code, peer))!;
    const stored = readFileSync(first.storePath, "utf8");
    expect(stored).not.toContain(token.split(".")[2]);
    if (process.platform !== "win32") expect(statSync(first.storePath).mode & 0o777).toBe(0o600);

    const again = await openAccess(Date.now, first.directory);
    expect(again.access.authenticate(token)).toEqual({ kind: "client", clientId: token.split(".")[1] });
  });

  it("do not authenticate with a wrong secret, a wrong id or the host token's shape", async () => {
    const { access, tokenFile } = await openAccess();
    const token = (await access.redeem(access.createLink().code, peer))!;
    const [prefix, id, secret] = token.split(".");
    // Another last character, whatever the random secret ends with.
    const altered = `${secret!.slice(0, -1)}${secret!.endsWith("A") ? "B" : "A"}`;
    expect(access.authenticate(`${prefix}.${id}.${altered}`)).toBeUndefined();
    expect(access.authenticate(`${prefix}.${"0".repeat(24)}.${secret}`)).toBeUndefined();
    expect(access.authenticate(`${token}.extra`)).toBeUndefined();
    expect(access.authenticate(undefined)).toBeUndefined();
    expect(access.authenticate(tokenFile.current())).toEqual({ kind: "owner" });
  });
});

// A host behind a real socket, so revocation and rotation are seen as a client sees them.
async function listen(access: HostAccess, methods: HostMethodTable = {}) {
  transport = await startSocketHostTransport({
    listen: "127.0.0.1:0",
    methods: { ping: async () => "pong", ...methods },
    pushLog: new HostPushLog(),
    hostVersion: "test",
    capabilities: [],
    access,
  });
  return transport.port;
}

interface TestClient {
  socket: WebSocket;
  closed: Promise<{ code: number; reason: string }>;
  request(method: string, params?: unknown[]): Promise<{ result?: unknown; error?: { code: string; message: string } }>;
}

async function client(port: number, token: string): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(socket);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: String(reason) })));
  await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  const frames: HostServerFrame[] = [];
  const waiting = new Map<string, (frame: HostServerFrame) => void>();
  socket.on("message", (data) => {
    const frame = decodeHostServerFrame(JSON.parse(String(data)) as unknown)!;
    const id = frame.type === "response" ? frame.response.id : frame.type === "hello-reply" ? frame.id : undefined;
    const resolve = id ? waiting.get(id) : undefined;
    if (resolve && id) { waiting.delete(id); resolve(frame); } else frames.push(frame);
  });
  let counter = 0;
  const send = (frame: object, id: string) => new Promise<HostServerFrame>((resolve, reject) => {
    waiting.set(id, resolve);
    void closed.then(({ code }) => reject(new Error(`closed ${code}`)));
    socket.send(JSON.stringify(frame));
  });
  await send({ type: "hello", id: "h", hello: { protocol: HOST_TRANSPORT_VERSION, token } }, "h");
  return {
    socket,
    closed,
    request: async (method, params = []) => {
      const id = `r${++counter}`;
      const frame = await send({ type: "request", request: { id, method, params } }, id);
      return frame.type === "response" ? frame.response : {};
    },
  };
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

describe("revoking a client", () => {
  it("closes its live connection at once and refuses its next hello", async () => {
    const { access, tokenFile } = await openAccess();
    const port = await listen(access);
    const token = (await access.redeem(access.createLink().code, peer))!;
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
});

describe("rotating the host token", () => {
  it("closes every other connection on the old token, keeps the caller's and every paired client", async () => {
    const { access, tokenFile } = await openAccess();
    const methods = createConnectionsMethods(() => ({ access, listen: () => undefined })) as HostMethodTable;
    const port = await listen(access, methods);
    const old = tokenFile.current();
    const caller = await client(port, old);
    const other = await client(port, old);
    const paired = (await access.redeem(access.createLink().code, peer))!;
    const phone = await client(port, paired);

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
    expect(created.urls).toEqual([{ url: `http://127.0.0.1:4100/#pair=${encodeURIComponent(created.code)}`, label: "This machine", reachability: "loopback", kind: "loopback" }]);

    const token = (await access.redeem(created.code, peer))!;
    const phone = await client(port, token);
    for (const method of ["connections-list", "connections-create-link", "connections-rotate-host-token", "connections-set-network", "connections-reload-certificate"]) {
      expect((await phone.request(method)).error?.code).toBe(HOST_ERROR.forbidden);
    }
    expect((await phone.request("start-job", ["connections-revoke-client", [token.split(".")[1]]])).error?.code).toBe(HOST_ERROR.forbidden);

    const list = (await owner.request("connections-list")).result as UiConnections;
    expect(list.clients).toMatchObject([{ label: "Laptop", connections: 1, current: false }]);
    expect(list.owners).toMatchObject([{ current: true }]);
    expect(list.tokenPath).toBe(tokenFile.path);
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
          state = { ...state, settings: { ...state.settings, ...input } as UiNetworkAccess["settings"], listeners: [{ host: "::", port: 7788, kind: "network" }] };
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
    expect(link.urls[0]!.url).toBe(`https://192.168.1.20:7788/#pair=${encodeURIComponent(link.code)}`);
    await expect(invokeHostMethod(methods, "connections-reload-certificate", [], HOST_CORE_PRINCIPAL)).rejects.toMatchObject({ code: HOST_ERROR.unsupported });
    expect(await endpointOrigins(service)).toEqual(["https://192.168.1.20:7788", "http://127.0.0.1:4100"]);
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
