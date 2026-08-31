import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiBridgeClient, PiBridgeReconnectLoop } from "./pi-bridge-client.js";
import {
  encodePiBridgeFrame,
  PI_BRIDGE_PROTOCOL_VERSION,
  type PiBridgeClientFrame,
  type PiBridgeDescriptor,
  type PiBridgeSnapshot,
} from "../shared/pi-bridge-protocol.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

function fixture(): { descriptor: PiBridgeDescriptor; snapshot: PiBridgeSnapshot } {
  const id = randomUUID();
  return {
    descriptor: {
      protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
      epoch: randomUUID(),
      sessionId: id,
      sessionFile: `/tmp/${id}.jsonl`,
      cwd: "/tmp/project",
      pid: process.pid,
      socketPath: process.platform === "win32" ? `\\\\.\\pipe\\tau-test-${id}` : join(tmpdir(), `tau-test-${id}.sock`),
      token: randomUUID(),
      startedAt: Date.now(),
    },
    snapshot: {
      sessionId: id,
      sessionFile: `/tmp/${id}.jsonl`,
      cwd: "/tmp/project",
      messages: [],
      isStreaming: false,
      models: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      activeTools: [],
      allTools: [],
      supportsImageInput: false,
    },
  };
}

function serve(descriptor: PiBridgeDescriptor, snapshot: PiBridgeSnapshot) {
  const server = createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const frame = JSON.parse(line) as PiBridgeClientFrame;
        if (frame.type === "hello") {
          socket.write(encodePiBridgeFrame({
            protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
            type: "ready",
            id: frame.id,
            epoch: descriptor.epoch,
            snapshot,
          }));
        } else {
          socket.write(encodePiBridgeFrame({
            protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
            type: "response",
            id: frame.id,
            epoch: descriptor.epoch,
            ok: true,
            result: { command: "command" in frame ? frame.command : undefined },
          }));
        }
      }
    });
  });
  return new Promise<typeof server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(descriptor.socketPath, () => resolve(server));
  });
}

describe("PiBridgeReconnectLoop", () => {
  it("keeps retrying with backoff until the bridge returns", async () => {
    vi.useFakeTimers();
    cleanup.push(() => { vi.useRealTimers(); });
    const attempt = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const recovered = vi.fn();
    const loop = new PiBridgeReconnectLoop();
    cleanup.push(() => loop.cancel());

    loop.start(attempt, recovered);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(recovered).toHaveBeenCalledOnce();
  });
});

describe("PiBridgeClient", () => {
  it("authenticates, receives the authoritative snapshot, and correlates commands", async () => {
    const { descriptor, snapshot } = fixture();
    const server = await serve(descriptor, snapshot);
    cleanup.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") await rm(descriptor.socketPath, { force: true });
    });
    const client = new PiBridgeClient(descriptor);
    cleanup.push(() => client.close());

    await expect(client.open()).resolves.toEqual(snapshot);
    expect(snapshot.supportsImageInput).toBe(false);
    await expect(client.command({ command: "ping" })).resolves.toEqual({ command: "ping" });
  });

  it("refuses a server frame from a different ownership epoch", async () => {
    const { descriptor, snapshot } = fixture();
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (chunk: string) => {
        const frame = JSON.parse(chunk.trim()) as PiBridgeClientFrame;
        socket.write(`${JSON.stringify({
          protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
          type: "ready",
          id: frame.id,
          epoch: "stale-owner",
          snapshot,
        })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(descriptor.socketPath, resolve);
    });
    cleanup.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") await rm(descriptor.socketPath, { force: true });
    });
    const client = new PiBridgeClient(descriptor);
    cleanup.push(() => client.close());

    await expect(client.open(40)).rejects.toThrow("handshake timed out");
  });
});
