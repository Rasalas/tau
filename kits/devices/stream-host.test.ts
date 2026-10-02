import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceStreams } from "./stream-host.js";
import { IosVideoParser, MAX_VIDEO_PACKET } from "./stream-protocol.js";

const target = { hostId: "local", deviceId: "simulator" };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function envelope(tag: number, bytes: Uint8Array): Buffer {
  const result = Buffer.alloc(bytes.length + 5); result.writeUInt32BE(bytes.length + 1); result[4] = tag; result.set(bytes, 5); return result;
}
function ios(body: ReadableStream<Uint8Array>) {
  const request = vi.fn(async () => new Response(body)) as unknown as typeof fetch;
  const streams = new DeviceStreams(async () => ({ origin: "http://127.0.0.1:1234", platform: "ios", deviceId: "device/one" }), request);
  cleanups.push(() => streams.dispose());
  return { streams, request };
}

it("demuxes fragmented native AVCC envelopes and rejects an oversized length before retaining the body", () => {
  const parser = new IosVideoParser(), packet = envelope(2, new Uint8Array([1, 2, 3]));
  expect(parser.push(packet.subarray(0, 3))).toEqual([]);
  expect(parser.push(packet.subarray(3))).toEqual([{ tag: 2, bytes: new Uint8Array([1, 2, 3]) }]);
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(MAX_VIDEO_PACKET + 1);
  expect(() => parser.push(oversized)).toThrow(/length/u);
});

it("transports native config and video through caller-bound reads and cancels upstream on close", async () => {
  const cancelled = vi.fn();
  const { streams, request } = ios(new ReadableStream({ start(controller) {
    controller.enqueue(envelope(1, new Uint8Array([1, 66, 0, 30])));
    controller.enqueue(envelope(2, new Uint8Array([0, 0, 0, 1, 101])));
  }, cancel: cancelled }));
  const { id } = await streams.open(target, "owner");
  await expect(streams.read(id, "other-device")).rejects.toThrow(/expired/u);
  const first = await streams.read(id, "owner");
  const second = first.packets.some((packet) => packet.kind === "key") ? { packets: [] } : await streams.read(id, "owner");
  expect([...first.packets, ...second.packets].map((packet) => packet.kind)).toEqual(["config", "key"]);
  expect(first.packets[0].codec).toBe("avc1.42001e");
  expect(request).toHaveBeenCalledWith("http://127.0.0.1:1234/vendor/serve-sim/helper/device%2Fone/stream.avcc", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(() => streams.close(id, "other-device")).toThrow(/expired/u);
  streams.close(id, "owner");
  await expect(streams.read(id, "owner")).rejects.toThrow(/expired/u);
  // Closing the reader cancels a stalled HTTP source, too.
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
});

it("bounds sessions, expires abandoned leases and permits only one read at a time", async () => {
  vi.useFakeTimers();
  const { streams } = ios(new ReadableStream());
  const first = await streams.open(target, "owner");
  const pending = streams.read(first.id, "owner");
  await expect(streams.read(first.id, "owner")).rejects.toThrow(/already pending/u);
  await streams.open(target, "owner"); await streams.open(target, "owner");
  await expect(streams.open(target, "owner")).rejects.toThrow(/Close another/u);
  await vi.advanceTimersByTimeAsync(16_000);
  await pending;
  await expect(streams.read(first.id, "owner")).rejects.toThrow(/expired/u);
});

it("ends the stream on a slow viewer instead of accumulating or dropping dependent delta frames", async () => {
  const { streams } = ios(new ReadableStream({ start(controller) {
    for (let index = 0; index < 8; index++) controller.enqueue(envelope(3, new Uint8Array(800_000)));
  } }));
  const { id } = await streams.open(target, "owner");
  await vi.waitFor(async () => expect((await streams.read(id, "owner")).error).toMatch(/fell behind/u));
});

it("reads actual SEMU websocket packets and requests an upstream keyframe", async () => {
  const server = createServer(), hub = new WebSocketServer({ server });
  cleanups.push(() => new Promise<void>((resolve) => { hub.close(() => server.close(() => resolve())); }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No hub port.");
  const upstream = vi.fn();
  hub.on("connection", (socket, request) => {
    upstream(request.url);
    socket.once("message", (message) => {
      upstream(JSON.parse(message.toString()));
      const nal = Buffer.from([0, 0, 0, 1, 103, 66, 0, 30, 0, 0, 0, 1, 101]);
      const packet = Buffer.alloc(16 + nal.length); packet.writeUInt32BE(0x53454d55); packet[4] = 1; packet[5] = 1; packet.writeBigUInt64BE(1234n, 8); packet.set(nal, 16);
      socket.send(packet);
    });
  });
  const streams = new DeviceStreams(async () => ({ origin: `http://127.0.0.1:${address.port}`, platform: "android", deviceId: "emulator-5554" }));
  cleanups.push(() => streams.dispose());
  const { id } = await streams.open(target, "device:phone");
  const batch = await streams.read(id, "device:phone");
  expect(upstream).toHaveBeenCalledWith("/vendor/serve-emu/ws?device=emulator-5554&frame-meta=1");
  expect(upstream).toHaveBeenCalledWith({ type: "reset-video", ack: false });
  expect(batch.packets.map((packet) => packet.kind)).toEqual(["config", "key"]);
  expect(batch.packets[1].timestamp).toBe(1234);
  streams.close(id, "device:phone");
});
