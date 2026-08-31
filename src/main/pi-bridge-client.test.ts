import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiBridgeClient, PiBridgeReconnectLoop } from "./pi-bridge-client.js";
import {
  encodePiBridgeFrame,
  PI_BRIDGE_CLIENT_CAPABILITIES,
  PI_BRIDGE_PROTOCOL_VERSION,
  transcriptPagingNegotiated,
  type PiBridgeCommand,
  type PiBridgeClientFrame,
  type PiBridgeDescriptor,
  type PiBridgeServerFrame,
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

type PiBridgeHelloFrame = Extract<PiBridgeClientFrame, { type: "hello" }>;

interface ServeOptions {
  onHello?: (frame: PiBridgeHelloFrame) => void;
  snapshotForHello?: (frame: PiBridgeHelloFrame) => PiBridgeSnapshot;
  rejectCommand?: string;
}

function serve(descriptor: PiBridgeDescriptor, snapshot: PiBridgeSnapshot, options: ServeOptions = {}) {
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
          options.onHello?.(frame);
          socket.write(encodePiBridgeFrame({
            protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
            type: "ready",
            id: frame.id,
            epoch: descriptor.epoch,
            snapshot: options.snapshotForHello?.(frame) ?? snapshot,
          }));
        } else if (options.rejectCommand && frame.command === options.rejectCommand) {
          socket.write(encodePiBridgeFrame({
            protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
            type: "response",
            id: frame.id,
            epoch: descriptor.epoch,
            ok: false,
            error: `Unsupported Pi bridge command: ${frame.command}`,
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

  it("advertises transcript paging and accepts the negotiated paged snapshot", async () => {
    const { descriptor, snapshot } = fixture();
    const hello: PiBridgeHelloFrame[] = [];
    const server = await serve(descriptor, {
      ...snapshot,
      messagesOffset: 120,
      capabilities: PI_BRIDGE_CLIENT_CAPABILITIES,
    }, { onHello: (frame) => hello.push(frame) });
    cleanup.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") await rm(descriptor.socketPath, { force: true });
    });
    const client = new PiBridgeClient(descriptor);
    cleanup.push(() => client.close());

    const ready = await client.open();
    expect(hello[0]?.capabilities).toEqual({ transcriptPaging: true });
    expect(ready.capabilities).toEqual({ transcriptPaging: true });
    expect(transcriptPagingNegotiated(ready.capabilities)).toBe(true);
  });

  it("keeps the legacy v1 snapshot when an old host omits paging capabilities", async () => {
    const { descriptor, snapshot } = fixture();
    const legacyMessages = Array.from({ length: 160 }, (_, index) => ({ role: "user", content: String(index), timestamp: index }));
    const hello: PiBridgeHelloFrame[] = [];
    const server = await serve(descriptor, snapshot, {
      onHello: (frame) => hello.push(frame),
      snapshotForHello: (frame) => transcriptPagingNegotiated(frame.capabilities)
        ? { ...snapshot, capabilities: PI_BRIDGE_CLIENT_CAPABILITIES, messagesOffset: 120 }
        : { ...snapshot, messages: legacyMessages, capabilities: undefined, messagesOffset: undefined },
    });
    cleanup.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") await rm(descriptor.socketPath, { force: true });
    });

    const socket = connect(descriptor.socketPath);
    cleanup.push(() => { socket.destroy(); });
    socket.setEncoding("utf8");
    const ready = await new Promise<PiBridgeServerFrame>((resolve, reject) => {
      let buffer = "";
      const onError = (error: Error) => reject(error);
      socket.once("error", onError);
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const frame = JSON.parse(buffer.slice(0, newline)) as PiBridgeServerFrame;
        socket.off("error", onError);
        resolve(frame);
      });
      socket.once("connect", () => socket.write(encodePiBridgeFrame({
        protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
        type: "hello",
        id: "legacy-host",
        epoch: descriptor.epoch,
        token: descriptor.token,
        expectedSessionId: descriptor.sessionId,
      })));
    });

    expect(ready.type).toBe("ready");
    if (ready.type !== "ready") return;
    expect(hello[0]?.capabilities).toBeUndefined();
    expect(transcriptPagingNegotiated(hello[0]?.capabilities)).toBe(false);
    expect(ready.snapshot.messages).toHaveLength(160);
    expect(ready.snapshot.capabilities).toBeUndefined();
    expect(ready.snapshot.messagesOffset).toBeUndefined();
  });

  it("surfaces an explicit compatibility error for an unknown command", async () => {
    const { descriptor, snapshot } = fixture();
    const server = await serve(descriptor, snapshot, { rejectCommand: "unknown" });
    cleanup.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") await rm(descriptor.socketPath, { force: true });
    });
    const client = new PiBridgeClient(descriptor);
    cleanup.push(() => client.close());

    await client.open();
    await expect(client.command({ command: "unknown" } as unknown as PiBridgeCommand)).rejects.toThrow("Unsupported Pi bridge command");
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
