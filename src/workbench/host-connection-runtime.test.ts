import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { createSocketHostClient, type HostSocket } from "./host-connection-socket";
import { HOST_TRANSPORT_VERSION } from "../shared/host-transport";
import type { HostWake } from "./host-link";

it("recovers over a real loopback socket without delivering a prompt twice", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const prompts: string[] = [];
  let fireWake!: (wake: HostWake) => void;
  let hellos = 0;
  server.on("connection", (socket) => {
    socket.on("message", (bytes) => {
      const frame = JSON.parse(String(bytes));
      if (frame.type === "hello") {
        hellos += 1;
        socket.send(JSON.stringify({ type: "hello-reply", id: frame.id, reply: {
          protocol: HOST_TRANSPORT_VERSION, hostVersion: "fixture", capabilities: ["replay", "heartbeat"],
          nextSeq: hellos === 1 ? 1 : 2, resync: false,
          missed: hellos === 1 ? [] : [{ seq: 1, event: { type: "event-log", label: "finished offline", timestamp: 0 } }],
        } }));
      } else if (frame.type === "request" && frame.request.method === "prompt") {
        prompts.push(frame.request.params[0]);
        // The host accepted the prompt, but the acknowledgement never reached the client.
        socket.close();
      } else if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong", id: frame.id }));
    });
  });
  const { client, connection } = createSocketHostClient(`ws://127.0.0.1:${port}`, undefined, {
    createSocket: (url) => new WebSocket(url) as unknown as HostSocket,
    wakes: (listener) => { fireWake = listener; return () => undefined; },
  });
  const replayed: string[] = [];
  connection.onEvent((event) => { if (event.type === "event-log") replayed.push(event.label); });
  try {
    await connection.start();
    await expect(client.sendPrompt("once", [], "thread", "turn-id")).rejects.toThrow(/dropped/);
    fireWake("offline");
    expect(client.getConnectionLink()?.phase).toBe("offline");
    const recovered = new Promise<void>((resolve) => {
      const stop = client.onConnectionState((state) => { if (state === "connected") { stop(); resolve(); } });
    });
    fireWake("online");
    await recovered;
    expect(replayed).toEqual(["finished offline"]);
    expect(prompts).toEqual(["once"]);
    expect(client.getConnectionLink()?.phase).toBe("open");
  } finally {
    connection.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
