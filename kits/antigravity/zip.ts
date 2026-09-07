import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createInflateRaw } from "node:zlib";

/**
 * Just enough of the zip format for a Google release archive: a flat set of
 * stored or deflated files, no zip64, no encryption. Every field the loader
 * relies on is read from the central directory and checked against what the
 * release table promised, so a wrong archive fails before anything runs.
 */
export interface ZipEntry {
  name: string;
  compressionMethod: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttributes: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_MARKER = 0xffffffff;

export async function readZipDirectory(path: string): Promise<ZipEntry[]> {
  const size = (await stat(path)).size;
  const handle = await open(path, "r");
  try {
    const tailLength = Math.min(size, EOCD_MIN + MAX_COMMENT);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let offset = tailLength - EOCD_MIN; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) { eocd = offset; break; }
    }
    if (eocd < 0) throw new Error("The archive has no end-of-central-directory record.");
    const entryCount = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || directorySize === ZIP64_MARKER || directoryOffset === ZIP64_MARKER) throw new Error("The archive uses zip64, which this loader does not read.");
    if (directoryOffset + directorySize > size) throw new Error("The archive's central directory lies outside the file.");
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
    const entries: ZipEntry[] = [];
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > directorySize || directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error("The archive's central directory is malformed.");
      const flags = directory.readUInt16LE(cursor + 8);
      const compressionMethod = directory.readUInt16LE(cursor + 10);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const externalAttributes = directory.readUInt32LE(cursor + 38);
      const localHeaderOffset = directory.readUInt32LE(cursor + 42);
      if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER || localHeaderOffset === ZIP64_MARKER) throw new Error("The archive uses zip64, which this loader does not read.");
      const name = directory.toString("utf8", cursor + 46, cursor + 46 + nameLength);
      entries.push({ name, compressionMethod, flags, compressedSize, uncompressedSize, localHeaderOffset, externalAttributes });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** A plain file entry: not a directory, not encrypted, stored or deflated. */
export function isPlainFileEntry(entry: ZipEntry): boolean {
  const unixType = (entry.externalAttributes >>> 16) & 0o170000;
  return !entry.name.includes("/") && !entry.name.includes("\\")
    && (unixType === 0 || unixType === 0o100000)
    && (entry.externalAttributes & 0x10) === 0
    && (entry.flags & 1) === 0
    && (entry.compressionMethod === 0 || entry.compressionMethod === 8);
}

/** Writes one entry to `destination` (mode 0o700, never over an existing file) and returns the bytes written; more than `expectedBytes` aborts. */
export async function extractZipEntry(archivePath: string, entry: ZipEntry, destination: string, expectedBytes: number): Promise<number> {
  const handle = await open(archivePath, "r");
  let dataStart: number;
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.localHeaderOffset);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`The archive member "${entry.name}" has no local header.`);
    dataStart = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
  if (entry.compressedSize === 0 && expectedBytes > 0) throw new Error(`The archive member "${entry.name}" is empty.`);
  let written = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > expectedBytes) { callback(new Error(`The archive member "${entry.name}" is larger than its release record.`)); return; }
      callback(null, chunk);
    },
  });
  const source = createReadStream(archivePath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  const sink = createWriteStream(destination, { flags: "wx", mode: 0o700 });
  if (entry.compressionMethod === 8) await pipeline(source, createInflateRaw(), counter, sink);
  else await pipeline(source, counter, sink);
  if (written !== expectedBytes) throw new Error(`The archive member "${entry.name}" is ${written} bytes, not the ${expectedBytes} its release record names.`);
  return written;
}
