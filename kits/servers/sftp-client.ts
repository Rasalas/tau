import type { Readable, Writable } from "node:stream";

/*
 * An SFTP version 3 client over any byte stream pair: the stdio of
 * `ssh -s <host> sftp`, or of a local `sftp-server` in tests. Requests are
 * pipelined; `readFile`/`writeFile` keep up to `concurrency` reads or writes
 * in flight. Spec: draft-ietf-secsh-filexfer-02, plus OpenSSH's extensions.
 */

const FXP = {
  INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, LSTAT: 7, FSTAT: 8, SETSTAT: 9, FSETSTAT: 10,
  OPENDIR: 11, READDIR: 12, REMOVE: 13, MKDIR: 14, RMDIR: 15, REALPATH: 16, STAT: 17, RENAME: 18,
  STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105, EXTENDED: 200, EXTENDED_REPLY: 201,
} as const;

export const SFTP_STATUS = {
  OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, BAD_MESSAGE: 5,
  NO_CONNECTION: 6, CONNECTION_LOST: 7, OP_UNSUPPORTED: 8,
} as const;

const ATTR = { SIZE: 0x1, UIDGID: 0x2, PERMISSIONS: 0x4, ACMODTIME: 0x8, EXTENDED: 0x80000000 } as const;

export const OPEN_FLAGS = { READ: 0x1, WRITE: 0x2, APPEND: 0x4, CREAT: 0x8, TRUNC: 0x10, EXCL: 0x20 } as const;

/** File attributes; each field only when the server sent it. Times in seconds. */
export interface SftpAttrs {
  size?: number;
  uid?: number;
  gid?: number;
  /** Includes the file type bits (`S_IFMT`). */
  mode?: number;
  atime?: number;
  mtime?: number;
}

export interface SftpName {
  filename: string;
  longname: string;
  attrs: SftpAttrs;
}

export class SftpError extends Error {
  constructor(readonly code: number, message: string, readonly path?: string) {
    super(path ? `${message}: ${path}` : message);
    this.name = "SftpError";
  }
}

export const isNoSuchFile = (error: unknown): boolean => error instanceof SftpError && error.code === SFTP_STATUS.NO_SUCH_FILE;

export interface SftpClientOptions {
  /** Requests in flight per `readFile`/`writeFile`. */
  concurrency?: number;
  /** Bytes per READ/WRITE; OpenSSH's own client uses 32 KiB. */
  chunkSize?: number;
}

interface Pending {
  resolve(reply: Reply): void;
  reject(error: Error): void;
}

interface Reply {
  type: number;
  body: Buffer;
}

class Writer {
  private parts: Buffer[] = [];
  byte(value: number): this { this.parts.push(Buffer.from([value])); return this; }
  u32(value: number): this { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0); this.parts.push(b); return this; }
  u64(value: number): this { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); this.parts.push(b); return this; }
  string(value: string | Buffer): this {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    return this.u32(bytes.length).raw(bytes);
  }
  raw(bytes: Buffer): this { this.parts.push(bytes); return this; }
  attrs(attrs: SftpAttrs): this {
    let flags = 0;
    if (attrs.size !== undefined) flags |= ATTR.SIZE;
    if (attrs.uid !== undefined && attrs.gid !== undefined) flags |= ATTR.UIDGID;
    if (attrs.mode !== undefined) flags |= ATTR.PERMISSIONS;
    if (attrs.atime !== undefined && attrs.mtime !== undefined) flags |= ATTR.ACMODTIME;
    this.u32(flags);
    if (flags & ATTR.SIZE) this.u64(attrs.size!);
    if (flags & ATTR.UIDGID) this.u32(attrs.uid!).u32(attrs.gid!);
    if (flags & ATTR.PERMISSIONS) this.u32(attrs.mode!);
    if (flags & ATTR.ACMODTIME) this.u32(attrs.atime!).u32(attrs.mtime!);
    return this;
  }
  done(): Buffer { return Buffer.concat(this.parts); }
}

class Reader {
  private offset = 0;
  constructor(private readonly buffer: Buffer) {}
  get remaining(): number { return this.buffer.length - this.offset; }
  u32(): number { const v = this.buffer.readUInt32BE(this.offset); this.offset += 4; return v; }
  u64(): number { const v = this.buffer.readBigUInt64BE(this.offset); this.offset += 8; return Number(v); }
  bytes(): Buffer {
    const length = this.u32();
    const v = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return v;
  }
  string(): string { return this.bytes().toString("utf8"); }
  attrs(): SftpAttrs {
    const flags = this.u32();
    const attrs: SftpAttrs = {};
    if (flags & ATTR.SIZE) attrs.size = this.u64();
    if (flags & ATTR.UIDGID) { attrs.uid = this.u32(); attrs.gid = this.u32(); }
    if (flags & ATTR.PERMISSIONS) attrs.mode = this.u32();
    if (flags & ATTR.ACMODTIME) { attrs.atime = this.u32(); attrs.mtime = this.u32(); }
    if (flags & ATTR.EXTENDED) {
      const count = this.u32();
      for (let i = 0; i < count; i += 1) { this.bytes(); this.bytes(); }
    }
    return attrs;
  }
}

const abortError = (signal: AbortSignal): Error => (signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));

/** The SFTP protocol over one stream pair; `init` first. */
export class SftpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffered: Buffer = Buffer.alloc(0);
  private closedWith: Error | undefined;
  private versionReply: ((reply: Reply) => void) | undefined;
  /** What the server announced in VERSION, name to version string. */
  extensions: Readonly<Record<string, string>> = {};
  version = 0;
  readonly concurrency: number;
  readonly chunkSize: number;

  constructor(private readonly input: Readable, private readonly output: Writable, options: SftpClientOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 16);
    this.chunkSize = Math.max(1024, options.chunkSize ?? 32 * 1024);
    input.on("data", (chunk: Buffer) => this.receive(chunk));
    input.once("end", () => this.fail(new SftpError(SFTP_STATUS.CONNECTION_LOST, "The SFTP session ended")));
    input.once("error", (error) => this.fail(error));
    output.once("error", (error) => this.fail(error));
  }

  get closed(): boolean { return this.closedWith !== undefined; }

  async init(): Promise<void> {
    const reply = await new Promise<Reply>((resolve, reject) => {
      this.versionReply = resolve;
      this.pending.set(0, { resolve, reject });
      this.send(new Writer().byte(FXP.INIT).u32(3).done());
    });
    const reader = new Reader(reply.body);
    this.version = reader.u32();
    const extensions: Record<string, string> = {};
    while (reader.remaining > 0) extensions[reader.string()] = reader.string();
    this.extensions = extensions;
  }

  /** Ends the session: every request still waiting fails. */
  end(): void {
    this.fail(new SftpError(SFTP_STATUS.NO_CONNECTION, "The SFTP session was closed"));
    this.output.end();
  }

  private fail(error: Error): void {
    if (this.closedWith) return;
    this.closedWith = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private send(packet: Buffer): void {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(packet.length);
    this.output.write(Buffer.concat([length, packet]));
  }

  private receive(chunk: Buffer): void {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (this.buffered.length < 4 + length) return;
      const packet = this.buffered.subarray(4, 4 + length);
      this.buffered = this.buffered.subarray(4 + length);
      const type = packet[0]!;
      if (type === FXP.VERSION) {
        this.pending.delete(0);
        this.versionReply?.({ type, body: packet.subarray(1) });
        this.versionReply = undefined;
        continue;
      }
      const id = packet.readUInt32BE(1);
      const waiting = this.pending.get(id);
      // An aborted request's late reply has nobody waiting.
      if (!waiting) continue;
      this.pending.delete(id);
      waiting.resolve({ type, body: packet.subarray(5) });
    }
  }

  private request(type: number, payload: Buffer, signal?: AbortSignal): Promise<Reply> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
    return new Promise<Reply>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(abortError(signal!));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (reply) => { signal?.removeEventListener("abort", onAbort); resolve(reply); },
        reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); },
      });
      const packet = new Writer().byte(type).u32(id).raw(payload).done();
      this.send(packet);
    });
  }

  private static status(reply: Reply, path?: string): SftpError {
    const reader = new Reader(reply.body);
    const code = reader.u32();
    const message = reader.remaining >= 4 ? reader.string() : "";
    return new SftpError(code, message || `SFTP status ${code}`, path);
  }

  private async expectStatus(type: number, payload: Buffer, path?: string, signal?: AbortSignal): Promise<void> {
    const reply = await this.request(type, payload, signal);
    if (reply.type !== FXP.STATUS) throw new SftpError(SFTP_STATUS.BAD_MESSAGE, `Unexpected reply ${reply.type}`, path);
    const error = SftpClient.status(reply, path);
    if (error.code !== SFTP_STATUS.OK) throw error;
  }

  private async expectHandle(type: number, payload: Buffer, path: string, signal?: AbortSignal): Promise<Buffer> {
    const reply = await this.request(type, payload, signal);
    if (reply.type === FXP.HANDLE) return Buffer.from(new Reader(reply.body).bytes());
    if (reply.type === FXP.STATUS) throw SftpClient.status(reply, path);
    throw new SftpError(SFTP_STATUS.BAD_MESSAGE, `Unexpected reply ${reply.type}`, path);
  }

  private async expectAttrs(type: number, payload: Buffer, path?: string, signal?: AbortSignal): Promise<SftpAttrs> {
    const reply = await this.request(type, payload, signal);
    if (reply.type === FXP.ATTRS) return new Reader(reply.body).attrs();
    if (reply.type === FXP.STATUS) throw SftpClient.status(reply, path);
    throw new SftpError(SFTP_STATUS.BAD_MESSAGE, `Unexpected reply ${reply.type}`, path);
  }

  /** NAME replies; `undefined` at EOF (READDIR). */
  private async expectNames(type: number, payload: Buffer, path?: string, signal?: AbortSignal): Promise<SftpName[] | undefined> {
    const reply = await this.request(type, payload, signal);
    if (reply.type === FXP.STATUS) {
      const error = SftpClient.status(reply, path);
      if (error.code === SFTP_STATUS.EOF) return undefined;
      throw error;
    }
    if (reply.type !== FXP.NAME) throw new SftpError(SFTP_STATUS.BAD_MESSAGE, `Unexpected reply ${reply.type}`, path);
    const reader = new Reader(reply.body);
    const count = reader.u32();
    const names: SftpName[] = [];
    for (let i = 0; i < count; i += 1) names.push({ filename: reader.string(), longname: reader.string(), attrs: reader.attrs() });
    return names;
  }

  open(path: string, flags: number, attrs: SftpAttrs = {}, signal?: AbortSignal): Promise<Buffer> {
    return this.expectHandle(FXP.OPEN, new Writer().string(path).u32(flags).attrs(attrs).done(), path, signal);
  }

  close(handle: Buffer, signal?: AbortSignal): Promise<void> {
    return this.expectStatus(FXP.CLOSE, new Writer().string(handle).done(), undefined, signal);
  }

  /** `undefined` at end of file; fewer bytes than asked is not the end. */
  async read(handle: Buffer, offset: number, length: number, signal?: AbortSignal): Promise<Buffer | undefined> {
    const reply = await this.request(FXP.READ, new Writer().string(handle).u64(offset).u32(length).done(), signal);
    if (reply.type === FXP.DATA) return Buffer.from(new Reader(reply.body).bytes());
    if (reply.type === FXP.STATUS) {
      const error = SftpClient.status(reply);
      if (error.code === SFTP_STATUS.EOF) return undefined;
      throw error;
    }
    throw new SftpError(SFTP_STATUS.BAD_MESSAGE, `Unexpected reply ${reply.type}`);
  }

  write(handle: Buffer, offset: number, data: Buffer, signal?: AbortSignal): Promise<void> {
    return this.expectStatus(FXP.WRITE, new Writer().string(handle).u64(offset).string(data).done(), undefined, signal);
  }

  lstat(path: string, signal?: AbortSignal): Promise<SftpAttrs> { return this.expectAttrs(FXP.LSTAT, new Writer().string(path).done(), path, signal); }
  stat(path: string, signal?: AbortSignal): Promise<SftpAttrs> { return this.expectAttrs(FXP.STAT, new Writer().string(path).done(), path, signal); }
  fstat(handle: Buffer, signal?: AbortSignal): Promise<SftpAttrs> { return this.expectAttrs(FXP.FSTAT, new Writer().string(handle).done(), undefined, signal); }

  setstat(path: string, attrs: SftpAttrs, signal?: AbortSignal): Promise<void> {
    return this.expectStatus(FXP.SETSTAT, new Writer().string(path).attrs(attrs).done(), path, signal);
  }

  fsetstat(handle: Buffer, attrs: SftpAttrs, signal?: AbortSignal): Promise<void> {
    return this.expectStatus(FXP.FSETSTAT, new Writer().string(handle).attrs(attrs).done(), undefined, signal);
  }

  opendir(path: string, signal?: AbortSignal): Promise<Buffer> { return this.expectHandle(FXP.OPENDIR, new Writer().string(path).done(), path, signal); }

  /** One batch of entries; `undefined` once the directory is exhausted. */
  readdir(handle: Buffer, signal?: AbortSignal): Promise<SftpName[] | undefined> {
    return this.expectNames(FXP.READDIR, new Writer().string(handle).done(), undefined, signal);
  }

  remove(path: string, signal?: AbortSignal): Promise<void> { return this.expectStatus(FXP.REMOVE, new Writer().string(path).done(), path, signal); }

  mkdir(path: string, attrs: SftpAttrs = {}, signal?: AbortSignal): Promise<void> {
    return this.expectStatus(FXP.MKDIR, new Writer().string(path).attrs(attrs).done(), path, signal);
  }

  rmdir(path: string, signal?: AbortSignal): Promise<void> { return this.expectStatus(FXP.RMDIR, new Writer().string(path).done(), path, signal); }

  async realpath(path: string, signal?: AbortSignal): Promise<string> {
    const names = await this.expectNames(FXP.REALPATH, new Writer().string(path).done(), path, signal);
    if (!names?.[0]) throw new SftpError(SFTP_STATUS.FAILURE, "realpath answered no name", path);
    return names[0].filename;
  }

  /** SFTP v3 RENAME fails when `to` exists; `posixRename` replaces it. */
  rename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    return this.expectStatus(FXP.RENAME, new Writer().string(from).string(to).done(), from, signal);
  }

  get hasPosixRename(): boolean { return "posix-rename@openssh.com" in this.extensions; }

  posixRename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    if (!this.hasPosixRename) return Promise.reject(new SftpError(SFTP_STATUS.OP_UNSUPPORTED, "The server has no posix-rename", from));
    return this.expectStatus(FXP.EXTENDED, new Writer().string("posix-rename@openssh.com").string(from).string(to).done(), from, signal);
  }

  /** OpenSSH 8.7+: `~` and `~user` expanded as the server's user sees them. */
  async expandPath(path: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!("expand-path@openssh.com" in this.extensions)) return undefined;
    const names = await this.expectNames(FXP.EXTENDED, new Writer().string("expand-path@openssh.com").string(path).done(), path, signal);
    return names?.[0]?.filename;
  }

  /** Every entry of a directory but `.` and `..`. */
  async list(path: string, signal?: AbortSignal): Promise<SftpName[]> {
    const handle = await this.opendir(path, signal);
    const entries: SftpName[] = [];
    try {
      for (;;) {
        const batch = await this.readdir(handle, signal);
        if (!batch) break;
        for (const entry of batch) if (entry.filename !== "." && entry.filename !== "..") entries.push(entry);
      }
    } finally {
      await this.close(handle).catch(() => undefined);
    }
    return entries;
  }

  /** The whole file, `concurrency` reads in flight. */
  async readFile(path: string, signal?: AbortSignal): Promise<Buffer> {
    const handle = await this.open(path, OPEN_FLAGS.READ, {}, signal);
    try {
      const chunks = new Map<number, Buffer>();
      // Ranges still to fetch; a short read puts its remainder back.
      const queue: Array<{ offset: number; length: number }> = [];
      let next = 0;
      let eof = Number.POSITIVE_INFINITY;
      const take = () => {
        const range = queue.shift();
        if (range) return range;
        if (next >= eof) return undefined;
        const range2 = { offset: next, length: this.chunkSize };
        next += this.chunkSize;
        return range2;
      };
      const worker = async () => {
        for (let range = take(); range; range = take()) {
          if (range.offset >= eof) continue;
          const data = await this.read(handle, range.offset, range.length, signal);
          if (!data || data.length === 0) {
            eof = Math.min(eof, range.offset);
            continue;
          }
          chunks.set(range.offset, data);
          if (data.length < range.length) queue.push({ offset: range.offset + data.length, length: range.length - data.length });
        }
      };
      await Promise.all(Array.from({ length: this.concurrency }, worker));
      const offsets = [...chunks.keys()].filter((offset) => offset < eof).sort((a, b) => a - b);
      return Buffer.concat(offsets.map((offset) => chunks.get(offset)!));
    } finally {
      await this.close(handle).catch(() => undefined);
    }
  }

  /** Creates or truncates `path`; `mode` applies to a new file only, as open(2) does. */
  async writeFile(path: string, data: Buffer, options: { mode?: number; exclusive?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const flags = OPEN_FLAGS.WRITE | OPEN_FLAGS.CREAT | (options.exclusive ? OPEN_FLAGS.EXCL : OPEN_FLAGS.TRUNC);
    const handle = await this.open(path, flags, options.mode === undefined ? {} : { mode: options.mode }, options.signal);
    let failed = false;
    try {
      let next = 0;
      const worker = async () => {
        while (next < data.length) {
          const offset = next;
          next += this.chunkSize;
          await this.write(handle, offset, data.subarray(offset, Math.min(offset + this.chunkSize, data.length)), options.signal);
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, Math.ceil(data.length / this.chunkSize))) }, worker));
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // A close error after a good write is a failed write (NFS reports there).
      const closing = this.close(handle);
      if (failed) await closing.catch(() => undefined);
      else await closing;
    }
  }
}

export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;

export function fileType(mode: number | undefined): "file" | "directory" | "symlink" | "other" {
  switch ((mode ?? 0) & S_IFMT) {
    case S_IFREG: return "file";
    case S_IFDIR: return "directory";
    case S_IFLNK: return "symlink";
    default: return "other";
  }
}
