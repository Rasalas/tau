import { afterEach, describe, expect, it } from "vitest";
import type { ThreadIndexSnapshot } from "../shared/contracts.js";
import { HOST_TRANSPORT_VERSION } from "../shared/host-transport.js";
import { EnvironmentMonitor, type MonitorSocket, type MonitorState } from "./environment-monitor.js";
import { HostPushLog } from "./host-push-log.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import { certificateFingerprint, publicKeyPin } from "./host-tls.js";
import { createSelfSignedCertificate } from "./self-signed-certificate.js";
import type { PairingEndpoint } from "../shared/connections.js";
import type { HostHelloReply } from "../shared/host-transport.js";
import type { ReachedCertificate } from "./environment-monitor.js";

let transport: SocketHostTransport | undefined;
const monitors: EnvironmentMonitor[] = [];
afterEach(async () => {
  for (const monitor of monitors.splice(0)) monitor.close();
  await transport?.close();
  transport = undefined;
});

const index = (ids: string[]): ThreadIndexSnapshot => ({
  projects: [{ path: "/p", name: "p", lastOpenedAt: 1 }],
  sessions: ids.map((id, position) => ({ id, path: `/s/${id}.jsonl`, title: id, modifiedAt: position, projectPath: "/p", projectName: "p", messageCount: 1 })),
});

async function host() {
  const pushLog = new HostPushLog();
  transport = await startSocketHostTransport({
    listen: "127.0.0.1:0",
    methods: { bootstrap: async () => ({ threadIndex: index(["a"]) }) },
    pushLog,
    hostVersion: "9.9.9",
    capabilities: [],
    token: "host-secret",
    host: { id: "host-studio", name: "studio" },
  });
  const started = transport;
  return {
    url: `ws://127.0.0.1:${started.port}`,
    push: (event: Parameters<HostPushLog["record"]>[0]) => started.deliver(pushLog.record(event)),
  };
}

function watch(options: ConstructorParameters<typeof EnvironmentMonitor>[0]) {
  const states: MonitorState[] = [];
  const monitor = new EnvironmentMonitor({ ...options, onChange: (state) => { states.push(state); options.onChange(state); } });
  monitors.push(monitor);
  return { monitor, states, last: () => monitor.current };
}

describe("the window's connection to a machine", () => {
  it("says hello, reads the thread index and follows it, and knows which threads run", async () => {
    const { url, push } = await host();
    const reached: string[] = [];
    const { last } = watch({ urls: () => [url], token: "host-secret", onChange: () => undefined, onReached: (at) => reached.push(at) });
    await expect.poll(() => last().index?.sessions.map((session) => session.id)).toEqual(["a"]);
    expect(last()).toMatchObject({ status: "connected", address: url, hostVersion: "9.9.9", host: { id: "host-studio", name: "studio" } });
    expect(reached).toEqual([url]);

    push({ type: "agent-status", sessionId: "a", running: true });
    await expect.poll(() => [...last().running]).toEqual(["a"]);
    push({ type: "thread-index", threadIndex: index(["a", "b"]) });
    await expect.poll(() => last().index?.sessions.length).toBe(2);
    push({ type: "agent-status", sessionId: "a", running: false });
    await expect.poll(() => last().running.size).toBe(0);
    // The host sends most index changes as updates: a whole index, or one thread's shell.
    push({ type: "host-update", update: { version: 1, type: "thread-index", index: index(["a", "b", "c"]) } });
    await expect.poll(() => last().index?.sessions.length).toBe(3);
    push({ type: "host-update", update: { version: 1, type: "thread-shell", update: { sessionId: "b", removed: true } } });
    await expect.poll(() => last().index?.sessions.map((session) => session.id)).toEqual(["a", "c"]);
    push({ type: "host-update", update: { version: 1, type: "thread-shell", update: { sessionId: "d", shell: index(["d"]).sessions[0] } } });
    await expect.poll(() => last().index?.sessions.map((session) => session.id)).toEqual(["d", "a", "c"]);
  });

  it("tells which key a certificate pin let in, and where else the machine is reachable, a CA's address flagged", async () => {
    const tls = createSelfSignedCertificate({ commonName: "Tau host", dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"], days: 30 });
    const endpoints: PairingEndpoint[] = [
      { url: "https://studio.tail0000.ts.net/", kind: "magicdns", trustedCertificate: true },
      { url: "https://100.64.0.9:7788/", kind: "tailscale" },
    ];
    transport = await startSocketHostTransport({
      listen: "127.0.0.1:0",
      methods: { bootstrap: async () => ({ threadIndex: index([]) }) },
      pushLog: new HostPushLog(), hostVersion: "9.9.9", capabilities: [], token: "host-secret", tls,
      host: { id: "host-studio", name: "studio", endpoints: () => endpoints },
    });
    const url = `wss://127.0.0.1:${transport.port}`;
    const reached: Array<{ reply: HostHelloReply; certificate: ReachedCertificate | undefined }> = [];
    watch({
      urls: () => [url], token: "host-secret", onChange: () => undefined,
      trust: () => ({ pin: { fingerprint: certificateFingerprint(tls.cert) } }),
      onReached: (_at, reply, certificate) => reached.push({ reply, certificate }),
    });
    await expect.poll(() => reached.length).toBe(1);
    expect(reached[0]!.reply.host?.endpoints).toEqual(endpoints);
    expect(reached[0]!.certificate).toEqual({ presented: { fingerprint: certificateFingerprint(tls.cert), publicKey: publicKeyPin(tls.cert) }, via: "pin" });
  });

  it("is refused for good when a pinned key is not the one the machine presents", async () => {
    const tls = createSelfSignedCertificate({ commonName: "Tau host", dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"], days: 30 });
    const started = await startSocketHostTransport({ listen: "127.0.0.1:0", methods: {}, pushLog: new HostPushLog(), hostVersion: "9", capabilities: [], token: "host-secret", tls });
    transport = started;
    const other = publicKeyPin(createSelfSignedCertificate({ commonName: "x", dnsNames: [], ipAddresses: [], days: 1 }).cert);
    const { last } = watch({ urls: () => [`wss://127.0.0.1:${started.port}`], token: "host-secret", onChange: () => undefined, trust: () => ({ pin: { publicKey: other } }) });
    await expect.poll(() => last().status).toBe("refused");
    expect(last().detail).toMatch(/presented a key/u);
  });

  it("is refused for good when the machine no longer takes its key", async () => {
    const { url } = await host();
    const { last } = watch({ urls: () => [url], token: "revoked", onChange: () => undefined });
    await expect.poll(() => last().status).toBe("refused");
    expect(last().detail).toMatch(/no longer accepts/u);
  });
});

/** A socket the test drives by hand, and timers it fires by hand. */
class FakeSocket implements MonitorSocket {
  readonly sent: Array<{ type: string; id?: string; request?: { id: string; method: string } }> = [];
  private readonly handlers = new Map<string, (...args: never[]) => void>();
  closed = false;
  bufferedAmount = 0;
  constructor(readonly url: string) {}
  on(event: string, listener: (...args: never[]) => void): void { this.handlers.set(event, listener); }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.closed = true; }
  terminate(): void { this.closed = true; }
  fire(event: string, ...args: unknown[]): void { (this.handlers.get(event) as ((...values: unknown[]) => void) | undefined)?.(...args); }
  reply(frame: unknown): void { this.fire("message", JSON.stringify(frame)); }
}

function fakeWorld() {
  const sockets: FakeSocket[] = [];
  let now = 0;
  let timers: Array<{ at: number; run: () => void; id: number }> = [];
  let next = 0;
  return {
    sockets,
    now: () => now,
    createSocket: (url: string) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    setTimer: (run: () => void, ms: number) => { next += 1; timers.push({ at: now + ms, run, id: next }); return next; },
    clearTimer: (id: unknown) => { timers = timers.filter((timer) => timer.id !== id); },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        now = due.at;
        due.run();
      }
      now = until;
    },
  };
}

const helloReply = (capabilities: string[] = ["heartbeat"]) => ({
  type: "hello-reply",
  id: "hello",
  reply: { protocol: HOST_TRANSPORT_VERSION, hostVersion: "1", capabilities, resync: false, missed: [], nextSeq: 1 },
});

describe("a machine that goes away", () => {
  it("is noticed by the ping, reported offline, and tried again at its next address", () => {
    const world = fakeWorld();
    const { last } = watch({ urls: () => ["wss://lan:7788/", "wss://tailnet:7788/"], token: "t", onChange: () => undefined, ...world });
    const first = world.sockets[0]!;
    first.fire("open");
    expect(first.sent[0]).toMatchObject({ type: "hello" });
    first.reply(helloReply());
    expect(last().status).toBe("connected");

    world.advance(20_000);
    expect(first.sent.at(-1)).toMatchObject({ type: "ping" });
    world.advance(30);
    first.reply({ type: "pong", id: "p" });
    expect(last().roundTripMs).toBe(30);

    // The next ping goes unanswered: the link is half open.
    world.advance(20_000);
    world.advance(10_000);
    expect(last()).toMatchObject({ status: "offline", detail: "It stopped answering." });
    expect(first.closed).toBe(true);
    expect(last().lastSeenAt).toBeDefined();

    world.advance(1_000);
    expect(world.sockets[1]!.url).toBe("wss://tailnet:7788/");
  });

  it("waits past the deadline while a large frame of its own still drains, not while it is stuck", () => {
    const world = fakeWorld();
    const { last } = watch({ urls: () => ["wss://lan:7788/"], token: "t", onChange: () => undefined, ...world });
    const socket = world.sockets[0]!;
    socket.fire("open");
    socket.reply(helloReply());
    // A file piece is going out slowly; the ping sits behind it and the other side has not answered yet.
    socket.bufferedAmount = 9_000_000;
    world.advance(20_000);
    socket.bufferedAmount = 4_000_000;
    world.advance(10_000);
    expect(last().status).toBe("connected");
    socket.bufferedAmount = 1_000;
    world.advance(10_000);
    expect(last().status).toBe("connected");
    // Nothing more leaves: the link is stuck, not slow.
    world.advance(10_000);
    expect(last()).toMatchObject({ status: "offline", detail: "It stopped answering." });
  });

  it("backs off while it cannot be reached, and tries at once when asked", () => {
    const world = fakeWorld();
    const { monitor, last } = watch({ urls: () => ["wss://lan:7788/"], token: "t", onChange: () => undefined, ...world });
    world.sockets[0]!.fire("close", 1006);
    expect(last()).toMatchObject({ status: "offline", detail: "wss://lan:7788/ could not be reached." });
    world.advance(1_000);
    world.sockets[1]!.fire("close", 1006);
    world.advance(1_999);
    expect(world.sockets).toHaveLength(2);
    world.advance(1);
    expect(world.sockets).toHaveLength(3);
    world.sockets[2]!.fire("close", 1006);
    monitor.retryNow();
    expect(world.sockets).toHaveLength(4);
    expect(last().status).toBe("connecting");
  });
});
