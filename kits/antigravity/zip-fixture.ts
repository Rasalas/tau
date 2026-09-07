import { crc32, deflateRawSync } from "node:zlib";

/** Assembles a small zip in memory: enough for tests of the loader, nothing more. */
export function buildZip(files: ReadonlyArray<{ name: string; data: Buffer; method?: 0 | 8; directory?: boolean; encrypted?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const method = file.method ?? 8;
    const payload = method === 8 ? deflateRawSync(file.data) : file.data;
    const name = Buffer.from(file.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.encrypted ? 1 : 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(file.data), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(file.encrypted ? 1 : 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(file.data), 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(file.directory ? (0o040755 << 16) | 0x10 : (0o100755 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}
