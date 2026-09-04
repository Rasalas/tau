import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HOST_TRANSPORT_VERSION, decodeHostServerFrame, type HostServerFrame } from "../shared/host-transport.js";
import { HostPushLog } from "./host-push-log.js";
import { hostTokenMatches, readOrCreateHostToken } from "./host-token.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import type { HostMethodTable } from "./host-methods.js";

const TOKEN = "a".repeat(64);
const methods: HostMethodTable = {
  ping: async (params) => ({ echo: params[0] }),
  boom: async () => { throw new Error("no"); },
};

let transport: SocketHostTransport | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await transport?.close();
  transport = undefined;
});

async function listen(pushLog = new HostPushLog()) {
  transport = await startSocketHostTransport({
    listen: "127.0.0.1:0",
    methods,
    pushLog,
    hostVersion: "test",
    capabilities: ["jobs"],
    token: TOKEN,
  });
  return { transport, pushLog };
}

function connect(port: number): WebSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(socket);
  return socket;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function nextFrame(socket: WebSocket): Promise<HostServerFrame> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      const frame = decodeHostServerFrame(JSON.parse(String(data)) as unknown);
      if (frame) resolve(frame); else reject(new Error(`undecodable frame: ${String(data)}`));
    });
    socket.once("close", (code) => reject(new Error(`closed ${code}`)));
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

async function hello(port: number, token: string, lastSeq?: number) {
  const socket = connect(port);
  await opened(socket);
  socket.send(JSON.stringify({ type: "hello", id: "h", hello: { protocol: HOST_TRANSPORT_VERSION, token, ...(lastSeq === undefined ? {} : { lastSeq }) } }));
  return { socket, frame: nextFrame(socket) };
}

describe("socket host transport", () => {
  it("answers a hello that carries the right token", async () => {
    const { transport: started } = await listen();
    const { frame } = await hello(started.port, TOKEN);
    const reply = await frame;
    expect(reply.type).toBe("hello-reply");
    if (reply.type !== "hello-reply") return;
    expect(reply.reply).toMatchObject({ protocol: 1, hostVersion: "test", capabilities: ["jobs"], resync: false, nextSeq: 1 });
  });

  it("closes a connection whose token is wrong or missing", async () => {
    const { transport: started } = await listen();
    const wrong = await hello(started.port, "b".repeat(64));
    // The reply never comes; the close is the answer.
    void wrong.frame.catch(() => undefined);
    expect(await closed(wrong.socket)).toBe(4401);
    const none = connect(started.port);
    await opened(none);
    none.send(JSON.stringify({ type: "hello", id: "h", hello: { protocol: 1 } }));
    expect(await closed(none)).toBe(4401);
  });

  it("refuses a request from a peer that never said hello", async () => {
    const { transport: started } = await listen();
    const socket = connect(started.port);
    await opened(socket);
    socket.send(JSON.stringify({ type: "request", request: { id: "r", method: "ping", params: [] } }));
    expect(await closed(socket)).toBe(4401);
  });

  it("dispatches a request into the method table and reports a failure as an error", async () => {
    const { transport: started } = await listen();
    const { socket, frame } = await hello(started.port, TOKEN);
    await frame;
    socket.send(JSON.stringify({ type: "request", request: { id: "r1", method: "ping", params: ["hi", null] } }));
    const response = await nextFrame(socket);
    expect(response).toMatchObject({ type: "response", response: { id: "r1", result: { echo: "hi" } } });
    socket.send(JSON.stringify({ type: "request", request: { id: "r2", method: "boom" } }));
    expect(await nextFrame(socket)).toMatchObject({ type: "response", response: { id: "r2", error: { message: "no", code: "failed" } } });
    socket.send(JSON.stringify({ type: "request", request: { id: "r3", method: "nope" } }));
    expect(await nextFrame(socket)).toMatchObject({ type: "response", response: { error: { code: "unknown-method" } } });
  });

  it("pushes to authenticated clients and replays what a reconnect missed", async () => {
    const { transport: started, pushLog } = await listen();
    const first = await hello(started.port, TOKEN);
    await first.frame;
    const push = nextFrame(first.socket);
    started.deliver(pushLog.record({ type: "event-log", label: "live", timestamp: 0 }));
    expect(await push).toMatchObject({ type: "push", push: { seq: 1 } });
    first.socket.close();
    // Two pushes happen while nobody is connected.
    started.deliver(pushLog.record({ type: "event-log", label: "missed-1", timestamp: 0 }));
    started.deliver(pushLog.record({ type: "event-log", label: "missed-2", timestamp: 0 }));
    const again = await hello(started.port, TOKEN, 1);
    const reply = await again.frame;
    expect(reply.type === "hello-reply" && reply.reply.missed.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(reply.type === "hello-reply" && reply.reply.resync).toBe(false);
  });
});

describe("host token", () => {
  it("creates a 0o600 token once and reuses it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tau-token-")), ".tau", "host-token");
    const token = readOrCreateHostToken(path);
    expect(token).toHaveLength(64);
    expect(readOrCreateHostToken(path)).toBe(token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").trim()).toBe(token);
  });

  it("matches only the exact token", () => {
    expect(hostTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(hostTokenMatches(TOKEN, undefined)).toBe(false);
    expect(hostTokenMatches(TOKEN, "a".repeat(63))).toBe(false);
    expect(hostTokenMatches(TOKEN, `${"a".repeat(63)}b`)).toBe(false);
  });
});
