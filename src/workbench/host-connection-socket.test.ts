import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostEvent } from "../shared/contracts";
import { HOST_TRANSPORT_VERSION } from "../shared/host-transport";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  SOCKET_CONNECT_TIMEOUT_MS,
  SOCKET_HELLO_TIMEOUT_MS,
  WAKE_PROBE_TIMEOUT_MS,
  createSocketHostClient,
} from "./host-connection-socket";
import type { HostWake } from "./host-link";

/** A socket that opens, carries frames and drops exactly when the test says so. */
class FakeSocket {
  static readonly OPEN = 1;
  static readonly opened: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.drop();
  }

  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  drop(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.(code === undefined ? undefined : { code, ...(reason ? { reason } : {}) });
  }

  deliver(frame: unknown): void {
    this.deliverRaw(JSON.stringify(frame));
  }

  /** A frame that is not even JSON, for the paths that must survive one. */
  deliverRaw(text: string): void {
    this.onmessage?.({ data: text } as unknown as MessageEvent<string>);
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const logEvent = (label: string): HostEvent => ({ type: "event-log", label, timestamp: 0 });

function helloReply(nextSeq: number, missed: Array<{ seq: number; event: HostEvent }> = [], resync = false, capabilities = ["jobs", "replay"]) {
  return { protocol: HOST_TRANSPORT_VERSION, hostVersion: "test", capabilities, resync, missed, nextSeq };
}

/** Answers the hello the transport queued on `socket`, whatever id it chose. */
function answerHello(socket: FakeSocket, reply: ReturnType<typeof helloReply>): Record<string, unknown> {
  const hello = socket.frames().find((frame) => frame.type === "hello");
  expect(hello).toBeDefined();
  socket.deliver({ type: "hello-reply", id: hello!.id, reply });
  return hello!.hello as Record<string, unknown>;
}

afterEach(() => {
  FakeSocket.opened.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("socket host client", () => {
  it("resolves browser resources against the home host without exposing connection credentials", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const { client, connection } = createSocketHostClient("wss://host.test:7788/socket?token=connection-secret", "host-secret");
    const path = `/resources/${"a".repeat(64)}`;
    expect(client.resourceUrl?.(path)).toBe(`https://host.test:7788${path}`);
    for (const invalid of ["https://evil.test/resource", "/resources/../secret", path + "?token=x", "//evil.test/resource"]) expect(() => client.resourceUrl?.(invalid)).toThrow("Invalid host resource path");
    connection.close();
  });
  it("reconnects after a drop and re-hellos with the sequence it last saw", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const { connection } = createSocketHostClient("ws://host.test:7788", "secret-token");
    const states: string[] = [];
    connection.onState((state) => states.push(state));
    const events: string[] = [];
    connection.onEvent((event) => { if (event.type === "event-log") events.push(event.label); });

    const first = FakeSocket.opened[0]!;
    expect(first.url).toBe("ws://host.test:7788");
    const started = connection.start();
    first.accept();
    await settle();
    // The hello carries the token; nothing else is sent before it is answered.
    expect(answerHello(first, helloReply(1))).toMatchObject({ protocol: 1, token: "secret-token" });
    await started;

    first.deliver({ type: "push", push: { seq: 1, event: logEvent("before-the-drop") } });
    expect(events).toEqual(["before-the-drop"]);

    // The tab sleeps: the socket drops, two pushes happen without it.
    vi.useFakeTimers();
    first.drop();
    expect(connection.getState()).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(500);
    const second = FakeSocket.opened[1]!;
    expect(second).toBeDefined();
    second.accept();
    await vi.advanceTimersByTimeAsync(0);

    const resumed = answerHello(second, helloReply(4, [
      { seq: 2, event: logEvent("missed-one") },
      { seq: 3, event: logEvent("missed-two") },
    ]));
    expect(resumed).toMatchObject({ lastSeq: 1, token: "secret-token" });
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual(["before-the-drop", "missed-one", "missed-two"]);
    expect(states).toEqual(["reconnecting", "connected"]);
  });

  it("opens every socket through the factory it was given, never the browser's", async () => {
    vi.stubGlobal("WebSocket", class { constructor() { throw new Error("the page's WebSocket was used"); } });
    vi.useFakeTimers();
    const urls: string[] = [];
    const { connection } = createSocketHostClient("wss://host.test:7788", "secret-token", {
      createSocket: (url) => { urls.push(url); return new FakeSocket(url); },
    });
    const started = connection.start();
    FakeSocket.opened[0]!.accept();
    await vi.advanceTimersByTimeAsync(0);
    answerHello(FakeSocket.opened[0]!, helloReply(1));
    await started;

    FakeSocket.opened[0]!.drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(urls).toEqual(["wss://host.test:7788", "wss://host.test:7788"]);
  });

  it("stops trying when the host refuses the token, and says so once", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
    let refused = 0;
    createSocketHostClient("ws://host.test:7788", "wrong-token", { onUnauthorized: () => { refused += 1; } });
    FakeSocket.opened[0]!.drop(4401, "unauthorized");
    await vi.advanceTimersByTimeAsync(5_000);
    // A wrong token never becomes right: no second socket, and one report.
    expect(FakeSocket.opened).toHaveLength(1);
    expect(refused).toBe(1);
  });

  it("queues a request made while the socket is down and sends it once it is back", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const { connection } = createSocketHostClient("ws://host.test:7788");
    const first = FakeSocket.opened[0]!;
    first.accept();
    await settle();

    vi.useFakeTimers();
    first.drop();
    const pending = connection.request("host-extensions").catch((error: unknown) => (error as Error).message);
    await vi.advanceTimersByTimeAsync(500);
    const second = FakeSocket.opened[1]!;
    second.accept();
    await vi.advanceTimersByTimeAsync(0);

    const request = second.frames().find((frame) => frame.type === "request");
    expect(request).toMatchObject({ request: { method: "host-extensions" } });
    // The host closes a socket (4400) on any frame before its hello.
    expect(second.frames()[0]!.type).toBe("hello");
    second.deliver({ type: "response", response: { id: (request!.request as { id: string }).id, result: [] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toEqual([]);
  });

  it("answers a window action itself when no window process stands beside it", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const { client, connection } = createSocketHostClient("ws://host.test:7788");
    const request = vi.spyOn(connection, "request");

    await expect(client.windowAction({ kind: "status" })).rejects.toMatchObject({ code: "unsupported" });
    expect(request).not.toHaveBeenCalled();
  });

  it("ignores a frame that is not JSON at all and keeps serving the connection", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const { connection } = createSocketHostClient("ws://host.test:7788");
    const socket = FakeSocket.opened[0]!;
    socket.accept();
    await settle();
    const started = connection.start();
    answerHello(socket, helloReply(1));
    await started;

    const pending = connection.request<string[]>("host-extensions");
    const request = socket.frames().find((frame) => frame.type === "request")!;
    // Malformed JSON carries no id, so nothing can be rejected: the handler must
    // swallow it rather than throw out of the socket's message callback.
    socket.deliverRaw("{ this is not json");

    socket.deliver({ type: "response", response: { id: (request.request as { id: string }).id, result: ["kept"] } });
    expect(await pending).toEqual(["kept"]);
  });

  it("rejects the request behind an undecodable frame instead of leaving it pending", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const { connection } = createSocketHostClient("ws://host.test:7788");
    const socket = FakeSocket.opened[0]!;
    socket.accept();
    await settle();
    const started = connection.start();
    answerHello(socket, helloReply(1));
    await started;

    const pending = connection.request("host-extensions").then(
      () => "resolved",
      (error: Error) => error.message,
    );
    const request = socket.frames().find((frame) => frame.type === "request")!;
    // Valid JSON, unusable shape, and it names the request it belongs to.
    socket.deliver({ type: "nonsense", id: (request.request as { id: string }).id });

    expect(await pending).toMatch(/^invalid-response:/u);
  });

  it("rejects a request the host never answers once the deadline passes", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
    const { connection } = createSocketHostClient("ws://host.test:7788");
    const socket = FakeSocket.opened[0]!;
    socket.accept();
    await vi.advanceTimersByTimeAsync(0);

    const pending = connection.request("host-extensions").catch((error: unknown) => (error as Error).message);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await pending).toMatch(/^timeout:/u);
  });

  it("does not let the outbox grow past its limit while the host is unreachable", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const { connection } = createSocketHostClient("ws://host.test:7788");
    const first = FakeSocket.opened[0]!;
    first.accept();
    await settle();

    vi.useFakeTimers();
    first.drop();
    for (let index = 0; index < 120; index += 1) void connection.request("host-extensions").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(500);
    const second = FakeSocket.opened[1]!;
    second.accept();
    await vi.advanceTimersByTimeAsync(0);

    const requests = second.frames().filter((frame) => frame.type === "request");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.length).toBeLessThanOrEqual(100);

    // Drain the outstanding deadlines so the suite's fake-timer guard stays happy.
    connection.close();
    await vi.advanceTimersByTimeAsync(0);
  });
});

/** Wakes the test fires by hand, as a page or a native shell would. */
function manualWakes() {
  let fire: (wake: HostWake) => void = () => undefined;
  return { source: (listener: (wake: HostWake) => void) => { fire = listener; return () => { fire = () => undefined; }; }, wake: (wake: HostWake) => fire(wake) };
}

const pings = (socket: FakeSocket) => socket.frames().filter((frame) => frame.type === "ping");

/** A client whose first socket is open and whose hello a heartbeat-capable host answered. */
async function liveClient(options: { heartbeat?: boolean } = {}) {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
  const wakes = manualWakes();
  const { connection, client } = createSocketHostClient("ws://host.test:7788", "secret-token", { wakes: wakes.source });
  const first = FakeSocket.opened[0]!;
  const started = connection.start();
  first.accept();
  await vi.advanceTimersByTimeAsync(0);
  answerHello(first, helloReply(1, [], false, options.heartbeat === false ? ["jobs", "replay"] : ["jobs", "replay", "heartbeat"]));
  await started;
  return { connection, client, first, wake: wakes.wake };
}

describe("socket host client on a mobile network", () => {
  it("sends heartbeats to a host that answers them and reports the round trip", async () => {
    const { client, first } = await liveClient();
    expect(client.getConnectionLink()).toMatchObject({ phase: "open", attempts: 0 });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    const [ping] = pings(first);
    expect(ping).toMatchObject({ type: "ping" });
    await vi.advanceTimersByTimeAsync(40);
    first.deliver({ type: "pong", id: ping!.id });
    expect(client.getConnectionLink()).toMatchObject({ phase: "open", roundTripMs: 40 });

    // Answered: the socket stays, however long the test waits.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
    expect(FakeSocket.opened).toHaveLength(1);
    client.reconnectNow();
    first.deliver({ type: "pong", id: pings(first).at(-1)!.id });
    await vi.advanceTimersByTimeAsync(0);
  });

  it("never pings a host that did not announce heartbeats", async () => {
    const { first, connection } = await liveClient({ heartbeat: false });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
    expect(pings(first)).toEqual([]);
    connection.close();
  });

  it("replaces a half-open socket whose heartbeat goes unanswered, and replays what it missed", async () => {
    const { connection, first } = await liveClient();
    const events: string[] = [];
    connection.onEvent((event) => { if (event.type === "event-log") events.push(event.label); });
    first.deliver({ type: "push", push: { seq: 1, event: logEvent("before") } });

    // The network died without a close: the socket still says OPEN.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS);
    expect(connection.getState()).toBe("reconnecting");
    expect(connection.getLink()).toMatchObject({ phase: "waiting", attempts: 1 });

    await vi.advanceTimersByTimeAsync(250);
    const second = FakeSocket.opened[1]!;
    second.accept();
    await vi.advanceTimersByTimeAsync(0);
    expect(answerHello(second, helloReply(3, [{ seq: 2, event: logEvent("missed") }], false, ["heartbeat"]))).toMatchObject({ lastSeq: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["before", "missed"]);
    expect(connection.getState()).toBe("connected");
    expect(connection.getLink()).toMatchObject({ phase: "open", attempts: 0 });
    connection.close();
  });

  it("takes any frame from the host as proof of life", async () => {
    const { connection, first } = await liveClient();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    // The pong is stuck behind a long push; the push itself shows the link works.
    first.deliver({ type: "push", push: { seq: 1, event: logEvent("busy") } });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
    expect(FakeSocket.opened).toHaveLength(1);
    expect(connection.getState()).toBe("connected");
    connection.close();
  });

  it("asks again instead of dropping when its timer fired late because the page was frozen", async () => {
    const { connection, first } = await liveClient();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(pings(first)).toHaveLength(1);
    // A suspended page: the clock moves on, no timer runs.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
    expect(FakeSocket.opened).toHaveLength(1);
    expect(pings(first)).toHaveLength(2);
    first.deliver({ type: "pong", id: pings(first)[1]!.id });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
    expect(FakeSocket.opened).toHaveLength(1);
    connection.close();
  });

  it("probes at once on a wake and replaces a dead link within the short deadline", async () => {
    const { connection, first, wake } = await liveClient();
    wake("foreground");
    expect(pings(first)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(WAKE_PROBE_TIMEOUT_MS);
    expect(connection.getState()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeSocket.opened).toHaveLength(2);
    connection.close();
  });

  it("keeps a link that answers the wake probe", async () => {
    const { connection, first, wake } = await liveClient();
    wake("network-change");
    first.deliver({ type: "pong", id: pings(first)[0]!.id });
    await vi.advanceTimersByTimeAsync(WAKE_PROBE_TIMEOUT_MS * 2);
    expect(FakeSocket.opened).toHaveLength(1);
    expect(connection.getState()).toBe("connected");
    connection.close();
  });

  it("skips the backoff when the app comes back or the network returns", async () => {
    const { connection, client, first, wake } = await liveClient();
    first.drop();
    // Drops in a row stretch the wait.
    for (let index = 1; index <= 4; index += 1) {
      await vi.advanceTimersByTimeAsync(3_000);
      FakeSocket.opened.at(-1)!.drop();
    }
    const waiting = client.getConnectionLink()!;
    expect(waiting).toMatchObject({ phase: "waiting", attempts: 5 });
    expect(waiting.retryAt! - Date.now()).toBe(3_000);

    const before = FakeSocket.opened.length;
    wake("foreground");
    expect(FakeSocket.opened).toHaveLength(before + 1);
    expect(client.getConnectionLink()).toMatchObject({ phase: "connecting" });
    connection.close();
  });

  it("says offline while the device has no network, and tries at once when it is back", async () => {
    const { connection, client, first, wake } = await liveClient();
    wake("offline");
    first.drop();
    expect(client.getConnectionLink()).toMatchObject({ phase: "offline", attempts: 1 });
    for (let index = 0; index < 6; index += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      FakeSocket.opened.at(-1)!.drop();
    }
    // Offline attempts slow down further than the online ladder.
    expect(client.getConnectionLink()!.retryAt! - Date.now()).toBe(15_000);
    const before = FakeSocket.opened.length;
    wake("online");
    expect(FakeSocket.opened).toHaveLength(before + 1);
    FakeSocket.opened.at(-1)!.drop();
    expect(client.getConnectionLink()!.retryAt! - Date.now()).toBe(250);
    connection.close();
  });

  it("gives up a handshake begun on the network the device just left", async () => {
    const { connection, first, wake } = await liveClient();
    first.drop();
    await vi.advanceTimersByTimeAsync(250);
    const hanging = FakeSocket.opened[1]!;
    wake("network-change");
    expect(hanging.readyState).toBe(3);
    expect(FakeSocket.opened).toHaveLength(3);
    connection.close();
  });

  it("gives up a connect that never completes", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
    const { client, connection } = createSocketHostClient("ws://host.test:7788");
    expect(client.getConnectionLink()).toMatchObject({ phase: "connecting" });
    await vi.advanceTimersByTimeAsync(SOCKET_CONNECT_TIMEOUT_MS);
    expect(FakeSocket.opened[0]!.readyState).toBe(3);
    expect(client.getConnectionLink()).toMatchObject({ phase: "waiting", attempts: 1 });
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeSocket.opened).toHaveLength(2);
    connection.close();
  });

  it("drops an open socket whose hello stays unanswered and says hello again on the next", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
    const { connection } = createSocketHostClient("ws://host.test:7788", "secret-token");
    const first = FakeSocket.opened[0]!;
    first.accept();
    await vi.advanceTimersByTimeAsync(0);
    first.deliver({ type: "hello-reply", id: "none", reply: helloReply(3) });
    // A reconnect's hello goes unanswered: a host frozen mid-handshake.
    first.drop();
    await vi.advanceTimersByTimeAsync(250);
    const second = FakeSocket.opened[1]!;
    second.accept();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.frames().some((frame) => frame.type === "hello")).toBe(true);
    await vi.advanceTimersByTimeAsync(SOCKET_HELLO_TIMEOUT_MS);
    expect(second.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(500);
    const third = FakeSocket.opened[2]!;
    third.accept();
    await vi.advanceTimersByTimeAsync(0);
    answerHello(third, helloReply(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState()).toBe("connected");
    connection.close();
  });

  it("stops for good when the host refuses the page's origin, and says why", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
    const { connection, client } = createSocketHostClient("ws://host.test:7788", "secret-token");
    FakeSocket.opened[0]!.drop(4403, "origin not allowed");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.opened).toHaveLength(1);
    expect(connection.getState()).toBe("refused");
    expect(connection.getRefusal()).toMatch(/does not accept connections from this page/u);
    expect(client.getConnectionLink()).toMatchObject({ phase: "closed" });
  });

  it("keeps its token after a malformed-frame close, from this host (4400) or an older one (4401), and backs off", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
    const refusals: string[] = [];
    const { connection } = createSocketHostClient("ws://host.test:7788", "kept-token", { onUnauthorized: (reason) => refusals.push(reason) });
    void connection.start().catch(() => undefined);
    const closes: Array<[number, string]> = [[4400, "malformed frame"], [4401, "malformed frame"], [4401, "hello first"], [4400, "hello first"]];
    let wait = 250;
    for (const [index, [code, reason]] of closes.entries()) {
      const socket = FakeSocket.opened[index]!;
      socket.accept();
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.frames()[0]).toMatchObject({ type: "hello", hello: { token: "kept-token" } });
      socket.drop(code, reason);
      // An open socket that never got its hello answered does not reset the backoff.
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(FakeSocket.opened).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.opened).toHaveLength(index + 2);
      wait = Math.min(wait * 2, 3_000);
    }
    expect(refusals).toEqual([]);
    expect(connection.getState()).not.toBe("refused");
    // Answered at last: the next drop is retried at the shortest delay again.
    const last = FakeSocket.opened.at(-1)!;
    last.accept();
    await vi.advanceTimersByTimeAsync(0);
    answerHello(last, helloReply(1));
    await vi.advanceTimersByTimeAsync(0);
    last.drop(4400, "malformed frame");
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeSocket.opened).toHaveLength(closes.length + 2);
    connection.close();
  });

  it("forgets its token only for the reasons a host refuses one with", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
    for (const reason of ["unauthorized", "revoked", "token-rotated"]) {
      FakeSocket.opened.length = 0;
      const refusals: string[] = [];
      createSocketHostClient("ws://host.test:7788", "t", { onUnauthorized: (given) => refusals.push(given) });
      FakeSocket.opened[0]!.drop(4401, reason);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(refusals).toEqual([reason]);
      expect(FakeSocket.opened).toHaveLength(1);
    }
  });

  it("reconnects normally after the host closed a socket for a late hello", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
    let refused = 0;
    const { connection } = createSocketHostClient("ws://host.test:7788", "t", { onUnauthorized: () => { refused += 1; } });
    FakeSocket.opened[0]!.drop(4408, "no hello");
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeSocket.opened).toHaveLength(2);
    expect(refused).toBe(0);
    connection.close();
  });
});
