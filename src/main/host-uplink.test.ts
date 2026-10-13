import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { HostClientCall } from "../shared/host-transport.js";
import { HostUplink } from "./host-uplink.js";
import { hostPowerState } from "./host-power-state.js";

let server: WebSocketServer | undefined;
let uplink: HostUplink | undefined;

afterEach(async () => {
  hostPowerState.change("resume");
  uplink?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A host that answers every hello and records what it was told. */
async function fakeHost(): Promise<{ url: string; hellos: unknown[]; sockets: WebSocket[] }> {
  const hellos: unknown[] = [];
  const sockets: WebSocket[] = [];
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { type: string; id: string; hello?: unknown };
      if (frame.type !== "hello") return;
      hellos.push(frame.hello);
      socket.send(JSON.stringify({ type: "hello-reply", id: frame.id, reply: { protocol: 1, hostVersion: "t", capabilities: [], resync: false, missed: [], nextSeq: 1 } }));
    });
  });
  await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
  const address = server.address() as { port: number };
  return { url: `ws://127.0.0.1:${address.port}`, hellos, sockets };
}

describe("the window process's uplink", () => {
  it("never executes a rejected queued call after reconnect", async () => {
    const host = await fakeHost();
    let reportClosed!: () => void;
    const dropped = new Promise<void>((resolve) => { reportClosed = resolve; });
    let reportHello!: () => void;
    const reopened = new Promise<void>((resolve) => { reportHello = resolve; });
    let hellos = 0;
    const executed: string[] = [];
    server!.on("connection", (socket) => socket.on("message", (bytes) => {
      const frame = JSON.parse(String(bytes));
      if (frame.type !== "request") return;
      executed.push(frame.request.method);
      socket.send(JSON.stringify({ type: "response", response: { id: frame.request.id, result: true } }));
    }));
    uplink = new HostUplink({
      url: host.url, token: "t",
      onHello: () => { if (++hellos === 2) reportHello(); },
      logger: { debug: (_message, fields) => { if (String((fields as { reason?: string } | undefined)?.reason).startsWith("socket-closed")) reportClosed(); }, info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    await uplink.hello();
    hostPowerState.change("suspend");
    const call = uplink.request("write-once").then(() => "accepted", () => "rejected");
    host.sockets[0]!.close();
    await dropped;
    expect(await call).toBe("rejected");
    hostPowerState.change("resume");
    await reopened;
    await uplink.request("barrier");
    expect(executed).toEqual(["barrier"]);
    expect(host.sockets).toHaveLength(2);
  });

  it("preserves an in-flight native call across sleep without reconnecting or repeating it", async () => {
    const host = await fakeHost();
    uplink = new HostUplink({ url: host.url, token: "t", requestTimeoutMs: 2_000 });
    await uplink.hello();
    const requests: Array<{ id: string; method: string }> = [];
    host.sockets[0]!.on("message", (bytes) => {
      const frame = JSON.parse(String(bytes));
      if (frame.type === "request") requests.push(frame.request);
    });
    let outcome: string | undefined;
    const call = uplink.request("write-once").then(() => { outcome = "answered"; }, () => { outcome = "rejected"; });
    hostPowerState.change("suspend");
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(outcome).toBeUndefined();
    expect(requests).toHaveLength(1);
    hostPowerState.change("resume");
    await vi.waitFor(() => expect(host.hellos).toHaveLength(2));
    host.sockets[0]!.send(JSON.stringify({ type: "response", response: { id: requests[0]!.id, result: "done" } }));
    await call;
    expect(outcome).toBe("answered");
    expect(host.sockets).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("names its window and halves in the hello and hands a call sent to it to the window", async () => {
    const host = await fakeHost();
    const halves = ["window"];
    const received: HostClientCall[] = [];
    uplink = new HostUplink({
      url: host.url,
      token: "t",
      helloFields: () => ({ windowId: "w1", windowHalves: [...halves] }),
      onCall: (call) => received.push(call),
    });
    await uplink.hello();
    halves.push("tau.preview");
    await uplink.hello();
    expect(host.hellos[0]).toMatchObject({ auxiliary: true, token: "t", windowId: "w1", windowHalves: ["window"] });
    // Said again once the halves are loaded, with what is there now.
    expect(host.hellos.at(-1)).toMatchObject({ windowId: "w1", windowHalves: ["window", "tau.preview"] });

    host.sockets[0]!.send(JSON.stringify({ type: "client-call", call: { callId: "c1", extensionId: "window", command: "pick-directory" } }));
    await vi.waitFor(() => expect(received).toEqual([{ callId: "c1", extensionId: "window", command: "pick-directory" }]));
  });

  it("reconnects after a protocol error, an older host's 4401 \"malformed frame\" included, and stops only on a refused token", async () => {
    const host = await fakeHost();
    const closes: Array<[number, string]> = [[4400, "malformed frame"], [4401, "malformed frame"], [4401, "unauthorized"]];
    server!.on("connection", (socket) => {
      const close = closes.shift();
      if (close) setTimeout(() => socket.close(...close), 10);
    });
    const errors: string[] = [];
    const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: (message: string) => { errors.push(message); } };
    uplink = new HostUplink({ url: host.url, token: "t", logger });
    void uplink.hello().catch(() => undefined);
    await vi.waitFor(() => expect(errors).toEqual(["host-uplink.unauthorized"]), { timeout: 5_000 });
    expect(host.sockets).toHaveLength(3);
  });
});
