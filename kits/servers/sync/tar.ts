/*
 * Reads the tar stream a download asks the server for: ustar, GNU long names
 * and pax headers, archives back to back (xargs may start tar more than once).
 * It only yields entries; the caller decides which names it asked for and
 * writes nothing the stream names on its own.
 */

export interface TarEntry {
  name: string;
  /** `file` for regular files; links and folders are `other` and carry no data. */
  type: "file" | "other";
  size: number;
  mode: number;
  mtime: number;
  data: Buffer;
}

const BLOCK = 512;

class ByteQueue {
  private chunks: Buffer[] = [];
  length = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  take(count: number): Buffer {
    const parts: Buffer[] = [];
    let needed = count;
    while (needed > 0) {
      const head = this.chunks[0]!;
      if (head.length <= needed) {
        parts.push(head);
        this.chunks.shift();
        needed -= head.length;
      } else {
        parts.push(head.subarray(0, needed));
        this.chunks[0] = head.subarray(needed);
        needed = 0;
      }
    }
    this.length -= count;
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, count);
  }
}

function text(block: Buffer, start: number, end: number): string {
  const field = block.subarray(start, end);
  const nul = field.indexOf(0);
  return (nul >= 0 ? field.subarray(0, nul) : field).toString("utf8");
}

/** Octal, or GNU base-256 when the high bit of the first byte is set. */
function number(block: Buffer, start: number, end: number): number {
  const field = block.subarray(start, end);
  if (field[0]! & 0x80) {
    let value = field[0]! & 0x7f;
    for (let index = 1; index < field.length; index += 1) value = value * 256 + field[index]!;
    return value;
  }
  const digits = text(block, start, end).trim();
  return digits ? parseInt(digits, 8) : 0;
}

function checksumOk(block: Buffer): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 32 : block[index]!;
  return sum === number(block, 148, 156);
}

/** `<length> <key>=<value>\n` records. */
export function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    if (space < 0) break;
    const length = parseInt(data.subarray(position, space).toString("ascii"), 10);
    if (!Number.isFinite(length) || length <= 0 || position + length > data.length) break;
    const record = data.subarray(space + 1, position + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    position += length;
  }
  return records;
}

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

export async function* readTar(source: AsyncIterable<Buffer>): AsyncGenerator<TarEntry> {
  const queue = new ByteQueue();
  let header: Buffer | undefined;
  let pax: Map<string, string> | undefined;
  let longName: string | undefined;

  const next = function* (): Generator<TarEntry> {
    for (;;) {
      if (!header) {
        if (queue.length < BLOCK) return;
        const block = queue.take(BLOCK);
        // Zero blocks end one archive; another may follow.
        if (block.every((byte) => byte === 0)) continue;
        if (!checksumOk(block)) throw new TarError("The tar stream is damaged (header checksum).");
        header = block;
      }
      const block = header;
      const flag = String.fromCharCode(block[156]!);
      const paxSize = "xgLK".includes(flag) ? undefined : pax?.get("size");
      const size = paxSize !== undefined ? Number(paxSize) : number(block, 124, 136);
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      if (queue.length < padded) return;
      const body = queue.take(padded).subarray(0, size);
      header = undefined;
      if (flag === "x") { pax = parsePax(body); continue; }
      if (flag === "g") continue;
      if (flag === "L") { longName = text(body, 0, body.length); continue; }
      if (flag === "K") continue;
      const ustar = block.subarray(257, 263).toString("latin1") === "ustar\0";
      const prefix = ustar ? text(block, 345, 500) : "";
      const plain = text(block, 0, 100);
      const name = pax?.get("path") ?? longName ?? (prefix ? `${prefix}/${plain}` : plain);
      const mtime = Math.floor(Number(pax?.get("mtime") ?? number(block, 136, 148)));
      pax = undefined;
      longName = undefined;
      const regular = flag === "0" || flag === "\0" || flag === "7";
      yield { name, type: regular ? "file" : "other", size, mode: number(block, 100, 108) & 0o7777, mtime, data: regular ? body : Buffer.alloc(0) };
    }
  };

  for await (const chunk of source) {
    queue.push(chunk);
    yield* next();
  }
  yield* next();
  if (header || queue.length > 0) throw new TarError("The tar stream ended in the middle of a file.");
}
