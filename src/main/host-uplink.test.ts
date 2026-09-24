import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { HostClientCall } from "../shared/host-transport.js";
import { HostUplink } from "./host-uplink.js";

let server: WebSocketServer | undefined;
let uplink: HostUplink | undefined;

afterEach(async () => {
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
});
