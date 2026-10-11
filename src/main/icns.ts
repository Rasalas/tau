const HEADER_BYTES = 8;
const ICNS_MAGIC = 0x69636e73; // "icns"
const PNG_MAGIC = 0x89504e47;
const PNG_WIDTH_OFFSET = 16;

function pngWidth(entry: Uint8Array): number | undefined {
  if (entry.length < PNG_WIDTH_OFFSET + 4) return undefined;
  const data = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
  return data.getUint32(0) === PNG_MAGIC ? data.getUint32(PNG_WIDTH_OFFSET) : undefined;
}

/**
 * The PNG inside an `.icns` app icon: the smallest one at least `minSize` wide,
 * else the largest; undefined when the file holds none (old entries are not PNG).
 */
export function extractIcnsPng(bytes: Uint8Array, minSize: number): Uint8Array | undefined {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < HEADER_BYTES || data.getUint32(0) !== ICNS_MAGIC) return undefined;
  const end = Math.min(data.getUint32(4), bytes.length);
  let best: { png: Uint8Array; width: number } | undefined;
  for (let offset = HEADER_BYTES; offset + HEADER_BYTES <= end;) {
    const length = data.getUint32(offset + 4);
    if (length < HEADER_BYTES || offset + length > end) break;
    const png = bytes.subarray(offset + HEADER_BYTES, offset + length);
    offset += length;
    const width = pngWidth(png);
    if (width === undefined) continue;
    if (!best || (best.width < minSize ? width > best.width : width >= minSize && width < best.width)) best = { png, width };
  }
  return best ? new Uint8Array(best.png) : undefined;
}
