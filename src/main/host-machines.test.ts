import { createHash, randomBytes } from "node:crypto";
import { createReadStream, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { pairWithHost, type PairingSocket } from "../shared/host-pairing.js";
import { HOST_ERROR, HOST_TRANSPORT_VERSION, type HostPushEvent } from "../shared/host-transport.js";
import type { ThreadIndexSnapshot } from "../shared/contracts.js";
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
import { EnvironmentMonitor, type EnvironmentMonitorOptions, type MonitorSocket, type MonitorState } from "./environment-monitor.js";

const directories: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
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

async function fakeMachines() {
  const monitors: Array<{ options: EnvironmentMonitorOptions; resubscribe: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const machines = await HostMachines.open({
    path: join(tempDir(), "host-machines.json"), logger, ownId: "mini-id",
    monitor: (options) => {
      const monitor = { options, resubscribe: vi.fn(), close: vi.fn() };
      monitors.push(monitor);
      return monitor as unknown as EnvironmentMonitor;
    },
  });
  cleanups.push(() => machines.close());
  await machines.add(rexEntry("http://127.0.0.1:9/", "t"));
  return { machines, monitors, monitor: monitors[0]! };
}

describe("a machine's index and followed thread streams", () => {
  it("reads the latest index and running threads, notifying once per burst per machine", async () => {
    const { machines, monitor, monitors } = await fakeMachines();
    await machines.add({ ...rexEntry("http://127.0.0.1:9/", "t"), id: "studio-id", name: "studio" });
    vi.useFakeTimers();
    const services = machines.forExtension("tau.machines");
    expect(monitor.options.bootstrap).toBe(true);
    expect(services.index!("rex")).toBeUndefined();
    expect([...services.running!("rex")]).toEqual([]);
    const changes: Array<[string, ThreadIndexSnapshot | undefined]> = [];
    const stop = services.subscribeIndex!((id) => changes.push([id, services.index!(id)]));
    const first: ThreadIndexSnapshot = { projects: [], sessions: [] };
    const latest: ThreadIndexSnapshot = { projects: [{ path: "/p", name: "p", lastOpenedAt: 1 }], sessions: [] };
    const state: MonitorState = { status: "connected", running: new Set(), index: first };
    monitor.options.onChange(state);
    monitor.options.onChange({ ...state, index: latest, running: new Set(["t1"]) });
    monitors[1]!.options.onChange(state);
    expect(services.index!("rex-id")).toBe(latest);
    expect([...services.running!("rex")]).toEqual(["t1"]);
    vi.advanceTimersByTime(249);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([["rex-id", latest], ["studio-id", first]]);
    monitor.options.onChange({ ...state, index: latest, running: new Set() });
    vi.advanceTimersByTime(250);
    expect(changes).toHaveLength(3);
    stop();
    monitor.options.onChange(state);
    machines.close();
    vi.advanceTimersByTime(250);
    expect(changes).toHaveLength(3);
  });

  it("follows only the named thread, including questions and details, until its last listener leaves", async () => {
    const { machines, monitor } = await fakeMachines();
    const services = machines.forExtension("tau.machines");
    const received: HostPushEvent[] = [];
    const second = vi.fn();
    const stop = services.followThread!("rex", "t1", (push) => received.push(push));
    const stopSecond = services.followThread!("rex-id", "t1", second);
    expect(monitor.options.threads!()).toEqual(["t1"]);
    expect(monitor.resubscribe).toHaveBeenCalledTimes(1);
    const delta: HostPushEvent = { type: "assistant-delta", sessionId: "t1", id: "m1", delta: "hello" };
    const question = { type: "extension-ui-prompt", sessionId: "t1", prompt: { id: "q1" } };
    const resolved: HostPushEvent = { type: "extension-ui-resolved", sessionId: "t1", id: "q1" };
    const running: HostPushEvent = { type: "agent-status", sessionId: "t1", running: true };
    const run: HostPushEvent = { type: "host-update", update: { version: 1, type: "run", sessionId: "t1", event: "settled" } };
    const detail = { type: "host-update", update: { type: "thread-detail", detail: { sessionId: "t1" } } };
    for (const event of [delta, { ...delta, sessionId: "t2" }, question, { ...question, sessionId: "t2" }, resolved, detail, running, { ...running, sessionId: "t2" }, run,
      { ...run, update: { ...run.update, sessionId: "t2" } }]) monitor.options.onPush!(event);
    expect(received).toEqual([delta, question, resolved, detail, running, run]);
    expect(received[0]).toBe(delta);
    expect(second).toHaveBeenCalledTimes(6);
    stop();
    expect(monitor.options.threads!()).toEqual(["t1"]);
    expect(monitor.resubscribe).toHaveBeenCalledTimes(1);
    stopSecond();
    expect(monitor.options.threads!()).toEqual([]);
    expect(monitor.resubscribe).toHaveBeenCalledTimes(2);
    monitor.options.onPush!(delta);
    expect(received).toHaveLength(6);
  });

  it("keeps followers when a machine's key is replaced and isolates the same thread id on another machine", async () => {
    const { machines, monitors, monitor } = await fakeMachines();
    const listener = vi.fn();
    const stop = machines.followThread("rex", "t1", listener);
    await machines.add({ ...rexEntry("http://127.0.0.1:9/", "t"), id: "studio-id", name: "studio" });
    monitors[1]!.options.onPush!({ type: "assistant-delta", sessionId: "t1", id: "m1", delta: "studio" });
    expect(listener).not.toHaveBeenCalled();
    await machines.add(rexEntry("http://127.0.0.1:9/", "new-key"));
    const replacement = monitors[2]!;
    expect(replacement.options.threads!()).toEqual(["t1"]);
    monitor.options.onPush!({ type: "assistant-delta", sessionId: "t1", id: "m1", delta: "old" });
    expect(listener).not.toHaveBeenCalled();
    replacement.options.onPush!({ type: "assistant-delta", sessionId: "t1", id: "m1", delta: "new" });
    expect(listener).toHaveBeenCalledOnce();
    stop();
    expect(replacement.options.threads!()).toEqual([]);
    expect(replacement.resubscribe).toHaveBeenCalledOnce();
  });

  it("clears followers and pending index notifications when the machine is removed", async () => {
    const { machines, monitor, monitors } = await fakeMachines();
    vi.useFakeTimers();
    const changes = vi.fn();
    machines.subscribeIndex(changes);
    const stop = machines.followThread("rex", "t1", vi.fn());
    monitor.options.onChange({ status: "connected", running: new Set(["t1"]), index: { projects: [], sessions: [] } });
    await machines.remove("rex-id");
    vi.advanceTimersByTime(250);
    expect(changes).not.toHaveBeenCalled();
    stop();
    await machines.add(rexEntry("http://127.0.0.1:9/", "t"));
    expect(monitors[1]!.options.threads!()).toEqual([]);
  });

  it("reads followers added while offline again in the next hello", async () => {
    class Socket implements MonitorSocket {
      readonly sent: Array<{ type: string; hello?: { subscription: { threads: string[] } } }> = [];
      private readonly handlers = new Map<string, (...args: never[]) => void>();
      on(event: string, listener: (...args: never[]) => void): void { this.handlers.set(event, listener); }
      send(data: string): void { this.sent.push(JSON.parse(data)); }
      close(): void {}
      fire(event: string, ...args: unknown[]): void { (this.handlers.get(event) as ((...values: unknown[]) => void) | undefined)?.(...args); }
    }
    const sockets: Socket[] = [];
    const machines = await HostMachines.open({
      path: join(tempDir(), "host-machines.json"), logger, ownId: "mini-id",
      monitor: (options) => new EnvironmentMonitor({ ...options, createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; } }),
    });
    cleanups.push(() => machines.close());
    vi.useFakeTimers();
    await machines.add(rexEntry("http://127.0.0.1:9/", "t"));
    const socket = sockets[0]!;
    socket.fire("open");
    expect(socket.sent[0]!.hello!.subscription.threads).toEqual([]);
    socket.fire("message", JSON.stringify({ type: "hello-reply", id: "hello", reply: { protocol: HOST_TRANSPORT_VERSION, hostVersion: "test", capabilities: [], resync: false, missed: [], nextSeq: 1 } }));
    socket.fire("close", 1006);
    const stop = machines.followThread("rex", "t1", vi.fn());
    vi.advanceTimersByTime(1_000);
    sockets[1]!.fire("open");
    expect(sockets[1]!.sent[0]!.hello!.subscription.threads).toEqual(["t1"]);
    stop();
  });
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
    const rex = await startRex({ "transcript-page": stub("transcript-page"), "abort": stub("abort"), "send-to-thread": stub("send-to-thread"), "switch-session": stub("switch-session"), "prompt": stub("prompt"), "connections-list": stub("connections-list") });
    const paired = await pairWithAgents(rex);
    const { machines } = await openMachines();
    await machines.add(rexEntry(rex.url, paired.companion!.token));
    await until(machines, (list) => list[0]?.status === "connected");

    expect(await machines.request("rex", "transcript-page", ["s1"])).toBe("transcript-page");
    expect(await machines.request("rex", "abort", ["s1"])).toBe("abort");
    expect(await machines.request("rex", "send-to-thread", ["s1", "hello"])).toBe("send-to-thread");
    for (const method of ["prompt", "switch-session", "connections-list", "host-extension", "start-job", "subscribe", "environments-open"]) {
      await expect(machines.request("rex", method), method).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
    }
    expect(reached).toEqual(["transcript-page", "abort", "send-to-thread"]);
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
    await expect(machines.request("mini-id", "start-thread", ["hello"])).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
    await expect(machines.request("mini-id", "send-to-thread", ["s1", "hello"])).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
    await expect(machines.request("mini-id", "prompt")).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
    expect(asked).toEqual([["host-resources", []], ["readiness", []]]);
    expect(machines.list()).toEqual([]);
  });

  it("names this host to a kit by the id, name and version its hello gives", async () => {
    const machines = await HostMachines.open({ path: join(tempDir(), "host-machines.json"), logger, ownId: "mini-id", ownName: "mini", ownVersion: "0.7.0" });
    cleanups.push(() => machines.close());
    expect(machines.forExtension("tau.remote-work").self).toEqual({ id: "mini-id", name: "mini", version: "0.7.0" });
    expect(machines.services.self.id).toBe("mini-id");
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
