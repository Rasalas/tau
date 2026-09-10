import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostEvent } from "../shared/contracts";
import { HOST_TRANSPORT_VERSION } from "../shared/host-transport";
import { createSocketHostClient } from "./host-connection-socket";

/** A socket that opens, carries frames and drops exactly when the test says so. */
class FakeSocket {
  static readonly OPEN = 1;
  static readonly opened: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
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

  drop(code?: number): void {
    this.readyState = 3;
    this.onclose?.(code === undefined ? undefined : { code });
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

function helloReply(nextSeq: number, missed: Array<{ seq: number; event: HostEvent }> = [], resync = false) {
  return { protocol: HOST_TRANSPORT_VERSION, hostVersion: "test", capabilities: ["jobs", "replay"], resync, missed, nextSeq };
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

  it("stops trying when the host refuses the token, and says so once", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
    let refused = 0;
    createSocketHostClient("ws://host.test:7788", "wrong-token", { onUnauthorized: () => { refused += 1; } });
    FakeSocket.opened[0]!.drop(4401);
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
    second.deliver({ type: "response", response: { id: (request!.request as { id: string }).id, result: [] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toEqual([]);
  });

  it("ignores a frame that is not JSON at all and keeps serving the connection", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const { connection } = createSocketHostClient("ws://host.test:7788");
    const socket = FakeSocket.opened[0]!;
    socket.accept();
    await settle();

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
