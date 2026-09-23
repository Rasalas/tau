import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { HOST_TRANSPORT_VERSION, decodeHostServerFrame, type HostServerFrame } from "../shared/host-transport.js";
import { HostPushLog } from "./host-push-log.js";
import { HostPushCoalescer } from "./host-push-coalescer.js";
import { clientHostToken, hostTokenMatches, readHostToken, readOrCreateHostToken } from "./host-token.js";
import { HostClientRegistry } from "./host-clients.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import { isLoopbackHost, parseListen } from "./host-listen.js";
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

async function listen(pushLog = new HostPushLog(), address = "127.0.0.1:0", allowNonLoopback = false, clients?: HostClientRegistry) {
  transport = await startSocketHostTransport({
    listen: address,
    allowNonLoopback,
    methods,
    pushLog,
    hostVersion: "test",
    capabilities: ["jobs"],
    token: TOKEN,
    ...(clients ? { clients } : {}),
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

async function hello(port: number, token: string, lastSeq?: number, profile?: string) {
  const socket = connect(port);
  await opened(socket);
  socket.send(JSON.stringify({ type: "hello", id: "h", hello: {
    protocol: HOST_TRANSPORT_VERSION,
    token,
    ...(lastSeq === undefined ? {} : { lastSeq }),
    ...(profile === undefined ? {} : { profile }),
  } }));
  return { socket, frame: nextFrame(socket) };
}

describe("socket host transport", () => {
  it("counts a client from its hello until its socket closes", async () => {
    const clients = new HostClientRegistry();
    const seen: string[] = [];
    clients.observe({
      attached: (_id, client) => seen.push(`+${client.transport}:${client.profile ?? "none"}`),
      detached: () => seen.push("-"),
    });
    const { transport: started } = await listen(new HostPushLog(), "127.0.0.1:0", false, clients);

    const first = await hello(started.port, TOKEN, undefined, "web");
    await first.frame;
    expect(clients.count()).toBe(1);

    const second = await hello(started.port, TOKEN);
    await second.frame;
    expect(clients.count()).toBe(2);

    first.socket.close();
    await closed(first.socket);
    await vi.waitFor(() => expect(clients.count()).toBe(1));
    expect(seen).toEqual(["+socket:web", "+socket:none", "-"]);
  });

  it("serves a window's own process without counting it as a second client", async () => {
    const clients = new HostClientRegistry();
    const { transport: started } = await listen(new HostPushLog(), "127.0.0.1:0", false, clients);
    const socket = connect(started.port);
    await opened(socket);
    socket.send(JSON.stringify({ type: "hello", id: "h", hello: { protocol: HOST_TRANSPORT_VERSION, token: TOKEN, auxiliary: true } }));
    expect((await nextFrame(socket)).type).toBe("hello-reply");
    expect(clients.count()).toBe(0);
  });

  it("does not count a peer whose token was refused", async () => {
    const clients = new HostClientRegistry();
    const { transport: started } = await listen(new HostPushLog(), "127.0.0.1:0", false, clients);
    const wrong = await hello(started.port, "b".repeat(64));
    void wrong.frame.catch(() => undefined);
    expect(await closed(wrong.socket)).toBe(4401);
    expect(clients.count()).toBe(0);
  });

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

describe("socket host transport and the coalescer", () => {
  it("compresses frames and answers only after the pushes its method caused", async () => {
    const pushLog = new HostPushLog();
    let started: SocketHostTransport | undefined;
    const pushes = new HostPushCoalescer((event) => {
      const push = pushLog.record(event);
      started?.deliver(push);
      return push.seq;
    });
    started = await startSocketHostTransport({
      listen: "127.0.0.1:0",
      methods: {
        stream: async () => {
          pushes.publish({ type: "assistant-delta", sessionId: "s", id: "a", delta: "streamed" });
          return "done";
        },
      },
      pushLog,
      hostVersion: "test",
      capabilities: [],
      token: TOKEN,
      beforeReply: () => pushes.flush(),
    });
    transport = started;
    const { socket, frame } = await hello(started.port, TOKEN);
    await frame;
    expect(socket.extensions).toContain("permessage-deflate");
    const frames: HostServerFrame[] = [];
    const both = new Promise<void>((resolve) => socket.on("message", (data) => {
      frames.push(decodeHostServerFrame(JSON.parse(String(data)) as unknown)!);
      if (frames.length === 2) resolve();
    }));
    socket.send(JSON.stringify({ type: "request", request: { id: "r1", method: "stream", params: [] } }));
    await both;
    expect(frames.map((entry) => entry.type)).toEqual(["push", "response"]);
  });

  it("reports a client that starts from a snapshot, not one that replays or a window's own process", async () => {
    const onSnapshotClient = vi.fn();
    transport = await startSocketHostTransport({
      listen: "127.0.0.1:0", methods, pushLog: new HostPushLog(), hostVersion: "test", capabilities: [], token: TOKEN, onSnapshotClient,
    });
    await (await hello(transport.port, TOKEN)).frame;
    expect(onSnapshotClient).toHaveBeenCalledTimes(1);
    await (await hello(transport.port, TOKEN, 0)).frame;
    expect(onSnapshotClient).toHaveBeenCalledTimes(1);
    // Ahead of the host: told to resync, so it starts over from a snapshot.
    await (await hello(transport.port, TOKEN, 5)).frame;
    expect(onSnapshotClient).toHaveBeenCalledTimes(2);
    const auxiliary = connect(transport.port);
    await opened(auxiliary);
    auxiliary.send(JSON.stringify({ type: "hello", id: "h", hello: { protocol: HOST_TRANSPORT_VERSION, token: TOKEN, auxiliary: true } }));
    await nextFrame(auxiliary);
    expect(onSnapshotClient).toHaveBeenCalledTimes(2);
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

  it("reads an existing token for a client without creating one", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tau-token-")), ".tau", "host-token");
    expect(readHostToken(path)).toBeUndefined();
    expect(clientHostToken({}, path)).toBeUndefined();
    // TAU_HOST_TOKEN wins, so one client machine can reach several hosts.
    expect(clientHostToken({ TAU_HOST_TOKEN: ` ${TOKEN} ` }, path)).toBe(TOKEN);
    const created = readOrCreateHostToken(path);
    expect(clientHostToken({}, path)).toBe(created);
    expect(existsSync(path)).toBe(true);
  });

  it("matches only the exact token", () => {
    expect(hostTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(hostTokenMatches(TOKEN, undefined)).toBe(false);
    expect(hostTokenMatches(TOKEN, "a".repeat(63))).toBe(false);
    expect(hostTokenMatches(TOKEN, `${"a".repeat(63)}b`)).toBe(false);
  });
});

describe("listen policy", () => {
  it("reads a host and a port out of TAU_HOST_LISTEN", () => {
    expect(parseListen("0.0.0.0:7788")).toEqual({ host: "0.0.0.0", port: 7788 });
    expect(parseListen(":7788")).toEqual({ host: "127.0.0.1", port: 7788 });
    expect(parseListen("[::1]:7788")).toEqual({ host: "[::1]", port: 7788 });
  });

  it("knows which addresses are loopback", () => {
    for (const host of ["127.0.0.1", "127.9.9.9", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["0.0.0.0", "192.168.1.10", "example.com", "::"]) expect(isLoopbackHost(host)).toBe(false);
  });

  it("refuses a public interface unless the operator opted in", async () => {
    await expect(listen(new HostPushLog(), "0.0.0.0:0")).rejects.toThrow(/TAU_HOST_INSECURE/u);
    const started = await listen(new HostPushLog(), "0.0.0.0:0", true);
    expect(started.transport.port).toBeGreaterThan(0);
  });
});
