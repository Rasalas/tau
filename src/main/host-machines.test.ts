import { createHash, randomBytes } from "node:crypto";
import { createReadStream, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { pairWithHost, type PairingSocket } from "../shared/host-pairing.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import { MACHINE_REQUEST_METHODS } from "../shared/host-method-access.js";
import type { HostMachine } from "./host-extensions.js";
import { HostAccess } from "./host-access.js";
import { HostBlobStore, createBlobMethods } from "./host-blobs.js";
import type { HostInvocationPrincipal } from "./host-invocation.js";
import type { HostLogger } from "./host-log.js";
import { HostMachines, createMachineMethods, decodeMachineEntry, type HostMachineEntry } from "./host-machines.js";
import type { HostMethodTable } from "./host-methods.js";
import { invokeHostMethod } from "./host-methods.js";
import { HostPushLog } from "./host-push-log.js";
import { HostTokenFile } from "./host-token.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";

const directories: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const logger: HostLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "tau-machines-"));
  directories.push(directory);
  return directory;
}

/** Machine B: a listening host with a stub method table and its own access store. */
async function startRex(methods: HostMethodTable) {
  const directory = tempDir();
  const access = await HostAccess.open({ tokenFile: new HostTokenFile(join(directory, "host-token")), storePath: join(directory, "paired-clients.json") });
  const pushLog = new HostPushLog();
  const transport: SocketHostTransport = await startSocketHostTransport({
    listen: "127.0.0.1:0",
    methods,
    pushLog,
    hostVersion: "test",
    capabilities: [],
    access,
    host: { id: "rex-id", name: "rex", endpoints: () => [] },
  });
  cleanups.push(async () => { await access.flush().catch(() => undefined); await transport.close(); });
  return { access, transport, pushLog, url: `http://127.0.0.1:${transport.port}/` };
}

/** Machine A's window pairs with B for itself and its agents; B's owner allows it once. */
async function pairWithAgents(rex: Awaited<ReturnType<typeof startRex>>) {
  const result = await pairWithHost({
    url: rex.url.replace(/^http/u, "ws"),
    name: "Mini",
    companion: { name: "Mini · Agents" },
    createSocket: (url) => new WebSocket(url) as unknown as PairingSocket,
    onWaiting: () => { void rex.access.approvePairing(rex.access.overview().requests[0]!.id); },
  });
  if (result.state !== "approved" || !result.companion) throw new Error(`not approved with a companion: ${JSON.stringify(result)}`);
  return result;
}

async function openMachines(path = join(tempDir(), "host-machines.json")) {
  const machines = await HostMachines.open({ path, logger, ownId: "mini-id" });
  cleanups.push(() => machines.close());
  return { machines, path };
}

/** Resolves once the list satisfies `test`; the monitor reports every change it sees. */
function until(machines: HostMachines, test: (list: readonly HostMachine[]) => boolean): Promise<readonly HostMachine[]> {
  if (test(machines.list())) return Promise.resolve(machines.list());
  return new Promise((resolve) => {
    const stop = machines.subscribe((list) => { if (test(list)) { stop(); resolve(list); } });
  });
}

const rexEntry = (url: string, token: string): HostMachineEntry => ({
  id: "rex-id", name: "rex", endpoints: [{ url, kind: "loopback" }], token, addedAt: "2026-09-25T00:00:00.000Z",
});

describe("another machine, reached by this host for its agents", () => {
  it("calls a kit there as the agents' own device, and stops at once when that device is revoked", async () => {
    const seen: Array<{ params: readonly unknown[]; device?: string }> = [];
    const rex = await startRex({
      "host-extension": async (params, context) => {
        const device = context.principal.kind === "workbench-client" ? context.principal.pairedClient : undefined;
        seen.push({ params, ...(device ? { device } : {}) });
        return { device };
      },
    });
    const paired = await pairWithAgents(rex);
    const { machines } = await openMachines();
    await machines.add(rexEntry(rex.url, paired.companion!.token));
    await until(machines, (list) => list[0]?.status === "connected");

    expect(await machines.call("rex", "tau.environments", "whoami", { hello: 1 })).toEqual({ device: paired.companion!.clientId });
    expect(seen).toEqual([{ params: ["tau.environments", "whoami", { hello: 1 }], device: paired.companion!.clientId }]);
    // B lists two devices, and the agents' connection is its own.
    expect(rex.access.overview().clients.map((client) => [client.label, client.connections])).toEqual(expect.arrayContaining([["Mini", 0], ["Mini · Agents", 1]]));

    await rex.access.revokeClient(paired.companion!.clientId);
    const [refused] = await until(machines, (list) => list[0]?.status === "refused");
    expect(refused?.detail).toMatch(/revoked/u);
    await expect(machines.call("rex-id", "tau.environments", "whoami")).rejects.toMatchObject({ code: HOST_ERROR.unauthorized, message: expect.stringMatching(/refuses this computer's agents/u) });
    // The window's own device is untouched.
    expect(rex.access.authenticate(paired.token)).toEqual({ kind: "client", clientId: paired.clientId });
  });

  it("asks only the methods on the list, and refuses the rest before anything leaves", async () => {
    const reached: string[] = [];
    const stub = (name: string) => async () => { reached.push(name); return name; };
    const rex = await startRex({ "transcript-page": stub("transcript-page"), "abort": stub("abort"), "prompt": stub("prompt"), "connections-list": stub("connections-list") });
    const paired = await pairWithAgents(rex);
    const { machines } = await openMachines();
    await machines.add(rexEntry(rex.url, paired.companion!.token));
    await until(machines, (list) => list[0]?.status === "connected");

    expect(await machines.request("rex", "transcript-page", ["s1"])).toBe("transcript-page");
    expect(await machines.request("rex", "abort", ["s1"])).toBe("abort");
    for (const method of ["prompt", "connections-list", "host-extension", "start-job", "subscribe", "environments-open"]) {
      await expect(machines.request("rex", method), method).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
    }
    expect(reached).toEqual(["transcript-page", "abort"]);
    expect(MACHINE_REQUEST_METHODS).not.toContain("connections-approve");
  });

  it("answers this host's own id here, for the methods that only read", async () => {
    const asked: Array<[string, readonly unknown[]]> = [];
    const machines = await HostMachines.open({
      path: join(tempDir(), "host-machines.json"),
      logger,
      ownId: "mini-id",
      local: async (method, params) => { asked.push([method, params]); return { cpuCount: 8 }; },
    });
    cleanups.push(() => machines.close());
    expect(await machines.request("mini-id", "host-resources")).toEqual({ cpuCount: 8 });
    expect(await machines.request("mini-id", "readiness", [])).toEqual({ cpuCount: 8 });
    // Stopping this host's own threads is `services.sessions`' job.
    await expect(machines.request("mini-id", "abort", ["s1"])).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
    await expect(machines.request("mini-id", "prompt")).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
    expect(asked).toEqual([["host-resources", []], ["readiness", []]]);
    expect(machines.list()).toEqual([]);
  });

  it("follows a topic a kit there emits, across the hello, and lets go of it", async () => {
    const rex = await startRex({});
    const paired = await pairWithAgents(rex);
    const { machines } = await openMachines();
    await machines.add(rexEntry(rex.url, paired.companion!.token));
    const events: unknown[] = [];
    const stop = machines.forExtension("tau.remote").watch("rex", "status/t1", (event) => events.push(event));
    await until(machines, (list) => list[0]?.status === "connected");
    const arrived = new Promise<void>((resolve) => {
      const other = machines.watch("rex", "tau.remote", "status/t1", () => { other(); resolve(); });
    });
    rex.transport.deliver(rex.pushLog.record({ type: "extension-event", extensionId: "tau.remote", name: "status", payload: { running: true }, topic: "status/t1" }));
    rex.transport.deliver(rex.pushLog.record({ type: "extension-event", extensionId: "tau.other", name: "status", payload: 2, topic: "status/t1" }));
    await arrived;
    expect(events).toEqual([{ name: "status", payload: { running: true } }]);
    stop();
  });

  it("keeps the key in a 0600 file across a restart, names a machine by id or name, and says why it cannot reach one", async () => {
    const { machines, path } = await openMachines();
    await machines.add(rexEntry("http://127.0.0.1:9/", "tauc.0123456789abcdef01234567.secret"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("tauc.0123456789abcdef01234567.secret");
    expect(machines.list()).toEqual([expect.objectContaining({ id: "rex-id", name: "rex" })]);
    expect(JSON.stringify(machines.list())).not.toContain("secret");
    await expect(machines.call("studio", "tau.x", "y")).rejects.toThrow(/no key for studio/u);
    await expect(machines.call("REX", "tau.x", "y")).rejects.toThrow(/rex/u);
    await expect(machines.add({ ...rexEntry("http://127.0.0.1:9/", "t"), id: "mini-id" })).rejects.toThrow(/this one/u);
    machines.close();

    const again = await openMachines(path);
    expect(again.machines.list().map((machine) => machine.id)).toEqual(["rex-id"]);
    expect(await again.machines.remove("rex-id")).toBe(true);
    expect(again.machines.list()).toEqual([]);
    expect(readFileSync(path, "utf8")).not.toContain("secret");
  });
});

describe("a file sent to another machine", () => {
  it("arrives through the agents' device in pieces, with progress, the same sum, and once", async () => {
    const blobsDir = join(tempDir(), "blobs");
    const store = await HostBlobStore.open({ dir: blobsDir, scheduleSweep: () => () => undefined });
    cleanups.push(() => store.close());
    const rex = await startRex(createBlobMethods(() => store));
    const paired = await pairWithAgents(rex);
    const { machines } = await openMachines();
    await machines.add(rexEntry(rex.url, paired.companion!.token));
    await until(machines, (list) => list[0]?.status === "connected");

    const bytes = randomBytes(9 * 1024 * 1024);
    const file = join(tempDir(), "random.bin");
    writeFileSync(file, bytes);
    const progress: number[] = [];
    const sent = await machines.forExtension("tau.remote").upload("rex", createReadStream(file), { size: bytes.length, onProgress: (step) => progress.push(step.sent) });
    const sum = createHash("sha256").update(bytes).digest("hex");
    expect(sent).toMatchObject({ size: bytes.length, sha256: sum });
    expect(progress).toEqual([8 * 1024 * 1024, bytes.length]);
    const taken = await store.take(sent.id, (blob) => ({ sum: createHash("sha256").update(readFileSync(blob.path)).digest("hex"), device: blob.device }));
    expect(taken).toEqual({ sum, device: paired.companion!.clientId });
    expect(readdirSync(blobsDir)).toEqual([]);
    await expect(store.take(sent.id, () => undefined)).rejects.toThrow(/taken already/u);
    // One audit line for the file, none for its pieces.
    expect(rex.access.overview().clients.find((client) => client.id === paired.companion!.clientId)?.lastAction?.action).toBe("blob-commit");
  });

  it("is refused when rex's owner made the agents' device Read only, and nothing stays there", async () => {
    const blobsDir = join(tempDir(), "blobs");
    const store = await HostBlobStore.open({ dir: blobsDir, scheduleSweep: () => () => undefined });
    cleanups.push(() => store.close());
    const rex = await startRex(createBlobMethods(() => store));
    const paired = await pairWithAgents(rex);
    const { machines } = await openMachines();
    await machines.add(rexEntry(rex.url, paired.companion!.token));
    await until(machines, (list) => list[0]?.status === "connected");
    // The preset changes while the agents stay connected: rex refuses the first piece.
    await rex.access.updateClient(paired.companion!.clientId, { access: "read-only" });
    await expect(machines.upload("rex", Buffer.from("not allowed"))).rejects.toMatchObject({ code: HOST_ERROR.forbidden, message: expect.stringMatching(/Read only; sending a file there needs Full access/u) });
    expect(readdirSync(blobsDir)).toEqual([]);
  });

  it("says so when the other machine's Tau cannot take files", async () => {
    const rex = await startRex({});
    const paired = await pairWithAgents(rex);
    const { machines } = await openMachines();
    await machines.add(rexEntry(rex.url, paired.companion!.token));
    await until(machines, (list) => list[0]?.status === "connected");
    await expect(machines.upload("rex", Buffer.from("x"))).rejects.toMatchObject({ code: HOST_ERROR.unsupported, message: expect.stringMatching(/cannot take files yet/u) });
  });
});

describe("the machines-* methods", () => {
  const owner: HostInvocationPrincipal = { kind: "workbench-client", connection: "c1", local: true };
  const paired: HostInvocationPrincipal = { kind: "workbench-client", connection: "c2", pairedClient: "p" };
  const remoteOwner: HostInvocationPrincipal = { kind: "workbench-client", connection: "c3" };

  it("answer only the host token on this machine, and never hand a key back", async () => {
    const { machines } = await openMachines();
    const table = createMachineMethods(() => machines) as HostMethodTable;
    const entry = rexEntry("https://192.0.2.9:7788/", "tauc.0123456789abcdef01234567.secret");
    for (const principal of [paired, remoteOwner]) {
      await expect(invokeHostMethod(table, "machines-add", [entry], principal)).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
      await expect(invokeHostMethod(table, "machines-list", [], principal)).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
    }
    expect(await invokeHostMethod(table, "machines-add", [entry], owner)).toEqual({ added: true });
    const listed = await invokeHostMethod(table, "machines-list", [], owner);
    expect(listed).toEqual({ machines: [expect.objectContaining({ id: "rex-id", name: "rex" })] });
    expect(JSON.stringify(listed)).not.toContain("secret");
    expect(await invokeHostMethod(table, "machines-remove", ["rex-id"], owner)).toEqual({ removed: true });
  });

  it("are refused where the host keeps no machines", async () => {
    const table = createMachineMethods(() => undefined) as HostMethodTable;
    await expect(invokeHostMethod(table, "machines-list", [], owner)).rejects.toMatchObject({ code: HOST_ERROR.unsupported });
  });

  it("take a machine as a window paired it, and nothing else", () => {
    expect(decodeMachineEntry({
      id: "rex-id", name: "rex", token: "t", publicKey: "AB:CD",
      endpoints: [{ url: "https://rex.local:7788/", kind: "mdns" }, { url: "ftp://nope/" }, { url: "https://rex.example.ts.net/", trustedCertificate: true }],
    })).toEqual({
      id: "rex-id", name: "rex", token: "t", publicKey: "AB:CD", addedAt: expect.any(String),
      endpoints: [{ url: "https://rex.local:7788/", kind: "mdns" }, { url: "https://rex.example.ts.net/", trustedCertificate: true }],
    });
    expect(() => decodeMachineEntry({ id: "rex-id", token: "t", endpoints: [] })).toThrow(/addresses/u);
    expect(() => decodeMachineEntry({ id: "rex-id", endpoints: [{ url: "https://rex.local/" }] })).toThrow(/token/u);
  });
});
