import type { Platform } from "./protocol.js";

export const MAX_VIDEO_PACKET = 1024 * 1024;
export interface VideoPacket { kind: "config" | "key" | "delta"; data: string; codec?: string; timestamp: number }
export interface VideoBatch { packets: VideoPacket[]; error?: string }
export interface VideoTarget { origin: string; platform: Platform; deviceId: string }

export function avcCodec(bytes: Uint8Array): string {
  if (bytes.length < 4) throw new Error("Invalid H.264 configuration.");
  return `avc1.${Array.from(bytes.subarray(1, 4), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Split Annex-B NAL units without retaining bytes beyond this access unit. */
export function annexB(bytes: Uint8Array): { key: boolean; sps?: Uint8Array } {
  let key = false, sps: Uint8Array | undefined;
  for (let offset = 0; offset + 3 < bytes.length; offset++) {
    if (bytes[offset] !== 0 || bytes[offset + 1] !== 0) continue;
    const prefix = bytes[offset + 2] === 1 ? 3 : bytes[offset + 2] === 0 && bytes[offset + 3] === 1 ? 4 : 0;
    if (!prefix || offset + prefix >= bytes.length) continue;
    const type = bytes[offset + prefix] & 31;
    if (type === 5) key = true;
    if (type === 7 && !sps) sps = bytes.subarray(offset + prefix);
    offset += prefix;
  }
  return { key, sps };
}

/** serve-sim 0.12.0 envelopes: u32be length, one tag, then AVCC payload. */
export class IosVideoParser {
  private pending = new Uint8Array(0);
  push(bytes: Uint8Array): Array<{ tag: number; bytes: Uint8Array }> {
    if (bytes.length + this.pending.length > MAX_VIDEO_PACKET * 2) throw new Error("Device video exceeded its packet limit.");
    const combined = new Uint8Array(this.pending.length + bytes.length);
    combined.set(this.pending); combined.set(bytes, this.pending.length);
    const packets: Array<{ tag: number; bytes: Uint8Array }> = [];
    let offset = 0;
    while (combined.length - offset >= 4) {
      const length = new DataView(combined.buffer).getUint32(offset);
      if (length < 1 || length > MAX_VIDEO_PACKET) throw new Error("Invalid device video envelope length.");
      if (combined.length - offset < length + 4) break;
      packets.push({ tag: combined[offset + 4], bytes: combined.slice(offset + 5, offset + 4 + length) });
      offset += 4 + length;
    }
    this.pending = combined.slice(offset);
    return packets;
  }
}
