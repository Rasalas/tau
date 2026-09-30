import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { Target } from "./protocol.js";
import { annexB, avcCodec, IosVideoParser, MAX_VIDEO_PACKET, type VideoBatch, type VideoPacket, type VideoTarget } from "./stream-protocol.js";

const MAX_QUEUE = 4 * MAX_VIDEO_PACKET;
const LEASE_MS = 15_000;
interface Stream {
  principal: string; controller: AbortController; socket?: WebSocket;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  packets: VideoPacket[]; bytes: number; touched: number; reading: boolean;
  error?: string; wake?: () => void;
}

/** Only authenticated commands reach these leases. No upstream URL or socket reaches a client. */
export class DeviceStreams {
  private streams = new Map<string, Stream>();
  private generation = 0;
  private closed = false;
  private reaper = setInterval(() => {
    for (const [id, stream] of this.streams) if (Date.now() - stream.touched > LEASE_MS) this.remove(id);
  }, 1000);
  constructor(private resolve: (target: Target) => Promise<VideoTarget>, private request: typeof fetch = fetch) { this.reaper.unref(); }
  async open(target: Target, principal: string): Promise<{ id: string }> {
    const generation = this.generation;
    if (this.closed) throw new Error("Device video is stopped.");
    if (this.streams.size >= 12 || [...this.streams.values()].filter((stream) => stream.principal === principal).length >= 3) throw new Error("Close another device video before opening this one.");
    const source = await this.resolve(target);
    if (this.closed || generation !== this.generation) throw new Error("Device configuration changed. Reopen the screen.");
    // The manager supplies a hub it owns, never a user-provided media URL.
    const origin = new URL(source.origin);
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/") throw new Error("Invalid device video source.");
    // Resolve can start a hub asynchronously. Recheck the limits before allocating.
    if (this.streams.size >= 12 || [...this.streams.values()].filter((stream) => stream.principal === principal).length >= 3) throw new Error("Device video limit reached.");
    const id = randomUUID();
    const stream: Stream = { principal, controller: new AbortController(), packets: [], bytes: 0, touched: Date.now(), reading: false };
    this.streams.set(id, stream);
    const work = source.platform === "ios" ? this.ios(source, stream) : this.android(source, stream);
    void work.catch((error: unknown) => this.fail(stream, error));
    return { id };
  }
  private get(id: string, principal: string): Stream {
    const stream = this.streams.get(id);
    if (!stream || stream.principal !== principal) throw new Error("Device video session expired. Reopen the screen.");
    stream.touched = Date.now();
    return stream;
  }
  async read(id: string, principal: string): Promise<VideoBatch> {
    const stream = this.get(id, principal);
    if (stream.reading) throw new Error("A device video read is already pending.");
    stream.reading = true;
    try {
      if (!stream.packets.length && !stream.error && !stream.controller.signal.aborted) await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 500);
        function done() { clearTimeout(timer); stream.wake = undefined; resolve(); }
        stream.wake = done;
      });
      let bytes = 0;
      const packets: VideoPacket[] = [];
      while (stream.packets.length && bytes + stream.packets[0].data.length <= MAX_VIDEO_PACKET * 1.4) {
        const packet = stream.packets.shift()!;
        bytes += packet.data.length; stream.bytes -= packet.data.length; packets.push(packet);
      }
      return { packets, ...(stream.error ? { error: stream.error } : {}) };
    } finally { stream.reading = false; }
  }
  close(id: string, principal: string): void { this.get(id, principal); this.remove(id); }
  private remove(id: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id); stream.controller.abort(); stream.socket?.close(); void stream.reader?.cancel().catch(() => undefined); stream.wake?.();
    stream.packets = []; stream.bytes = 0;
  }
  closeAll(): void { this.generation++; for (const id of this.streams.keys()) this.remove(id); }
  dispose(): void { this.closed = true; clearInterval(this.reaper); this.closeAll(); }
  private fail(stream: Stream, error: unknown): void {
    if (stream.controller.signal.aborted) return;
    stream.error = error instanceof Error ? error.message : "Device video stopped.";
    stream.controller.abort(); stream.socket?.close(); void stream.reader?.cancel().catch(() => undefined); stream.wake?.();
  }
  private enqueue(stream: Stream, packet: VideoPacket): void {
    if (stream.controller.signal.aborted) return;
    if (packet.data.length > MAX_VIDEO_PACKET * 1.4 || stream.bytes + packet.data.length > MAX_QUEUE) throw new Error("Device video viewer fell behind. Reopen the screen.");
    stream.packets.push(packet); stream.bytes += packet.data.length; stream.wake?.();
  }
  private async ios(source: VideoTarget, stream: Stream): Promise<void> {
    const response = await this.request(`${source.origin}/vendor/serve-sim/helper/${encodeURIComponent(source.deviceId)}/stream.avcc`, { signal: stream.controller.signal });
    if (!response.ok || !response.body) throw new Error(`Device video failed (${response.status}).`);
    const reader = response.body.getReader(), parser = new IosVideoParser();
    stream.reader = reader;
    let timestamp = 0;
    try {
      while (!stream.controller.signal.aborted) {
        const result = await reader.read();
        if (result.done) throw new Error("Device video ended.");
        for (const packet of parser.push(result.value)) {
          if (packet.tag === 1) this.enqueue(stream, { kind: "config", data: Buffer.from(packet.bytes).toString("base64"), codec: avcCodec(packet.bytes), timestamp });
          else if (packet.tag === 2 || packet.tag === 3) {
            this.enqueue(stream, { kind: packet.tag === 2 ? "key" : "delta", data: Buffer.from(packet.bytes).toString("base64"), timestamp });
            timestamp += 16_667;
          }
        }
      }
    } finally { await reader.cancel().catch(() => undefined); }
  }
  private android(source: VideoTarget, stream: Stream): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${source.origin.replace("http:", "ws:")}/vendor/serve-emu/ws?device=${encodeURIComponent(source.deviceId)}&frame-meta=1`, { maxPayload: MAX_VIDEO_PACKET, handshakeTimeout: 10_000 });
      stream.socket = socket;
      let configured = false, timestamp = 0;
      socket.on("open", () => socket.send(JSON.stringify({ type: "reset-video", ack: false })));
      socket.on("message", (data, binary) => {
        try {
          if (!binary) {
            if (JSON.parse(data.toString()).type === "video-session") { configured = false; socket.send(JSON.stringify({ type: "reset-video", ack: false })); }
            return;
          }
          const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          let payload = bytes, key: boolean | undefined;
          if (bytes.length > 16 && bytes.readUInt32BE(0) === 0x53454d55 && bytes[4] === 1) {
            payload = bytes.subarray(16); key = (bytes[5] & 1) !== 0;
            const pts = bytes.readBigUInt64BE(8);
            if (pts <= BigInt(Number.MAX_SAFE_INTEGER)) timestamp = Number(pts);
          }
          const scanned = annexB(payload);
          if (scanned.sps && (!configured || (key ?? scanned.key))) {
            this.enqueue(stream, { kind: "config", data: "", codec: avcCodec(scanned.sps), timestamp }); configured = true;
          }
          if (!configured) return;
          this.enqueue(stream, { kind: (key ?? scanned.key) ? "key" : "delta", data: payload.toString("base64"), timestamp });
          timestamp += 16_667;
        } catch (error) { reject(error); socket.close(); }
      });
      socket.on("error", reject);
      socket.on("close", () => stream.controller.signal.aborted ? resolve() : reject(new Error("Device video disconnected.")));
    });
  }
}
