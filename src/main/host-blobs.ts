import { createHash, randomUUID, type Hash } from "node:crypto";
import { appendFile, mkdir, rename, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { HOST_ERROR } from "../shared/host-transport.js";
import type { HostBlob, HostBlobServices, HostBlobTakeOptions, HostBlobSource, HostBlobUploadOptions, HostUploadedBlob } from "./host-extensions.js";
import type { HostInvocationPrincipal } from "./host-invocation.js";
import type { HostMethodContext } from "./host-jobs.js";
import type { HostLogger } from "./host-log.js";

/** The largest piece `blob-put` takes, and the size a sender cuts. Base64 makes it about 11 MB on the wire. */
export const BLOB_PIECE_BYTES = 8 * 1024 * 1024;
export const BLOB_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** A blob nobody took, or an upload that stalled, is gone after this long. */
export const BLOB_TTL_MS = 60 * 60 * 1000;
/** What one device may keep here at once, received and not yet taken. */
export const BLOB_DEVICE_QUOTA_BYTES = 4 * 1024 * 1024 * 1024;
const BLOB_MAX_OPEN_PER_DEVICE = 4;
/** An upload never takes the disk below this. */
const BLOB_FREE_RESERVE_BYTES = 512 * 1024 * 1024;
const BLOB_SWEEP_MS = 60 * 1000;
/** Per piece: 11 MB over a slow link takes a while. */
const PIECE_TIMEOUT_MS = 120_000;

const BLOB_ID = /^[A-Za-z0-9_-]{16,64}$/u;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

export const BLOB_METHODS = { put: "blob-put", commit: "blob-commit", abort: "blob-abort" } as const;

const failure = (message: string, code: string = HOST_ERROR.failed): Error => Object.assign(new Error(message), { code });
const invalid = (message: string): Error => failure(message, HOST_ERROR.invalidRequest);
/** One sentence for unknown, expired, taken and someone else's, so an id reveals nothing. */
const missing = (id: string): Error => failure(`No file ${id} is waiting here: it expired, was taken already, or never arrived.`, HOST_ERROR.invalidRequest);

interface Entry {
  id: string;
  /** Whose quota it counts against: a paired device, or `host` for the host token and the host itself. */
  owner: string;
  device?: string;
  state: "receiving" | "ready";
  path: string;
  /** Bytes received so far; reserved before each write so a quota check sees them. */
  size: number;
  next: number;
  hash: Hash;
  sha256?: string;
  touchedAt: number;
  /** Serializes this blob's operations in the order they arrived. */
  chain: Promise<unknown>;
}

export interface HostBlobStoreOptions {
  /** `<userData>/blobs`; emptied at start, since nothing in it survives a restart. */
  dir: string;
  logger?: HostLogger;
  now?(): number;
  maxBytes?: number;
  pieceBytes?: number;
  ttlMs?: number;
  quotaBytes?: number;
  maxOpenPerDevice?: number;
  /** Bytes free on the disk under `dir`; test seam. */
  freeBytes?(dir: string): Promise<number>;
  /** Runs `sweep` every minute by default; answers a stop. */
  scheduleSweep?(sweep: () => void): () => void;
}

/** The paired device a call came from, or `undefined` for the host token, the window and the host. */
function deviceOf(principal: HostInvocationPrincipal): string | undefined {
  return principal.kind === "workbench-client" ? principal.pairedClient : undefined;
}

async function diskFree(dir: string): Promise<number> {
  const stats = await statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * Files another machine sends this host (plan-H §1): `blob-put` appends a
 * piece, `blob-commit` checks size and sha256, and a kit here takes the file
 * once with `services.blobs.take`. Pieces arrive in order; a blob lives an
 * hour after its last piece or its commit, and counts against its device's
 * quota until it is taken or gone.
 */
export class HostBlobStore {
  private readonly entries = new Map<string, Entry>();
  private readonly stopSweep: () => void;
  private closed = false;

  private constructor(private readonly options: HostBlobStoreOptions) {
    const sweep = () => { void this.sweep(); };
    this.stopSweep = options.scheduleSweep?.(sweep) ?? every(sweep, BLOB_SWEEP_MS);
  }

  static async open(options: HostBlobStoreOptions): Promise<HostBlobStore> {
    await rm(options.dir, { recursive: true, force: true });
    await mkdir(options.dir, { recursive: true, mode: 0o700 });
    return new HostBlobStore(options);
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private get ttl(): number { return this.options.ttlMs ?? BLOB_TTL_MS; }

  /** Appends piece `index` of blob `id`; index 0 starts it. Answers how many bytes arrived so far. */
  put(principal: HostInvocationPrincipal, id: string, index: number, base64: string): Promise<{ received: number }> {
    if (!BLOB_ID.test(id)) return Promise.reject(invalid("blob-put: the id has 16 to 64 letters, digits, - or _."));
    if (!Number.isSafeInteger(index) || index < 0) return Promise.reject(invalid("blob-put: index must be a whole number from 0."));
    const pieceBytes = this.options.pieceBytes ?? BLOB_PIECE_BYTES;
    if (base64.length > Math.ceil(pieceBytes / 3) * 4 || base64.length % 4 !== 0 || !BASE64.test(base64)) {
      return Promise.reject(invalid(`blob-put: a piece is base64 of at most ${pieceBytes} bytes.`));
    }
    const owner = deviceOf(principal) ?? "host";
    let entry = this.entries.get(id);
    if (index === 0) {
      if (entry) return Promise.reject(entry.owner === owner ? invalid(`blob-put: ${id} was started already.`) : missing(id));
      const open = [...this.entries.values()].filter((other) => other.owner === owner && other.state === "receiving").length;
      if (open >= (this.options.maxOpenPerDevice ?? BLOB_MAX_OPEN_PER_DEVICE)) {
        return Promise.reject(failure(`This device is already sending ${open} files here; wait for one to finish.`));
      }
      const device = deviceOf(principal);
      entry = {
        id, owner, ...(device ? { device } : {}), state: "receiving", path: join(this.options.dir, `${id}.part`),
        size: 0, next: 0, hash: createHash("sha256"), touchedAt: this.now(), chain: Promise.resolve(),
      };
      this.entries.set(id, entry);
    } else if (!entry || entry.owner !== owner) {
      return Promise.reject(missing(id));
    }
    const current = entry;
    return this.enqueue(current, async () => {
      if (this.entries.get(id) !== current || current.state !== "receiving") throw missing(id);
      if (index !== current.next) throw invalid(`blob-put: expected piece ${current.next} of ${id}, got ${index}.`);
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length === 0 && index > 0) throw invalid("blob-put: only the first piece may be empty.");
      const max = this.options.maxBytes ?? BLOB_MAX_BYTES;
      if (current.size + bytes.length > max) {
        await this.drop(current, "too-large");
        throw failure(`The file is larger than the ${formatBytes(max)} a host takes; nothing was kept.`);
      }
      const free = await (this.options.freeBytes ?? diskFree)(this.options.dir);
      if (free - bytes.length < BLOB_FREE_RESERVE_BYTES) {
        await this.drop(current, "disk-full");
        throw failure(`This machine's disk has ${formatBytes(free)} free; the file does not fit. Nothing was kept.`);
      }
      const quota = this.options.quotaBytes ?? BLOB_DEVICE_QUOTA_BYTES;
      const held = [...this.entries.values()].reduce((sum, other) => sum + (other.owner === owner ? other.size : 0), 0);
      if (held + bytes.length > quota) {
        await this.drop(current, "quota");
        throw failure(`This device already keeps ${formatBytes(held)} of files here, and ${formatBytes(quota)} is its limit. Nothing was kept of ${id}.`);
      }
      current.size += bytes.length;
      try {
        await appendFile(current.path, bytes, { mode: 0o600 });
      } catch (error) {
        await this.drop(current, "write-failed");
        throw error;
      }
      current.hash.update(bytes);
      current.next += 1;
      current.touchedAt = this.now();
      return { received: current.size };
    });
  }

  /** Ends an upload: the size and sha256 the sender computed must match what arrived, or nothing is kept. */
  commit(principal: HostInvocationPrincipal, id: string, sha256: string, size: number): Promise<{ id: string; size: number; sha256: string }> {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== (deviceOf(principal) ?? "host")) return Promise.reject(missing(id));
    return this.enqueue(entry, async () => {
      if (this.entries.get(id) !== entry || entry.state !== "receiving") throw missing(id);
      if (entry.next === 0) throw invalid(`blob-commit: nothing of ${id} arrived.`);
      if (size !== entry.size) {
        await this.drop(entry, "size-mismatch");
        throw failure(`${formatBytes(entry.size)} of ${id} arrived, the sender sent ${formatBytes(size)}; nothing was kept.`);
      }
      const digest = entry.hash.digest("hex");
      if (digest !== sha256.toLowerCase()) {
        await this.drop(entry, "checksum-mismatch");
        throw failure(`${id} arrived damaged: its sha256 is ${digest}, the sender's ${sha256}. Nothing was kept.`);
      }
      const path = join(this.options.dir, `${id}.blob`);
      await rename(entry.path, path);
      Object.assign(entry, { state: "ready", path, sha256: digest, touchedAt: this.now() });
      this.options.logger?.info("blobs.received", { id, size, ...(entry.device ? { device: entry.device } : {}) });
      return { id, size, sha256: digest };
    });
  }

  /** The sender gave up; whatever arrived goes. */
  abort(principal: HostInvocationPrincipal, id: string): Promise<{ aborted: boolean }> {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== (deviceOf(principal) ?? "host")) return Promise.resolve({ aborted: false });
    return this.enqueue(entry, async () => {
      if (this.entries.get(id) !== entry) return { aborted: false };
      await this.drop(entry, "aborted");
      return { aborted: true };
    });
  }

  /**
   * Hands a received file to `use` and deletes it when `use` settles. Only
   * one caller ever gets it. With `caller`, a blob another device sent stays
   * where it is and reads as missing.
   */
  async take<T>(id: string, use: (blob: HostBlob) => Promise<T> | T, options: HostBlobTakeOptions = {}): Promise<T> {
    const entry = this.entries.get(id);
    if (!entry || entry.state !== "ready" || this.expired(entry)) throw missing(id);
    if (options.caller && options.caller.device !== entry.device) throw missing(id);
    this.entries.delete(id);
    const path = join(this.options.dir, `${id}.taken`);
    await entry.chain.catch(() => undefined);
    await rename(entry.path, path);
    try {
      return await use({ id, path, size: entry.size, sha256: entry.sha256!, ...(entry.device ? { device: entry.device } : {}) });
    } finally {
      await rm(path, { force: true });
    }
  }

  /** Deletes what outlived its hour. Answers how many went. */
  async sweep(): Promise<number> {
    const stale = [...this.entries.values()].filter((entry) => this.expired(entry));
    await Promise.all(stale.map((entry) => this.enqueue(entry, async () => {
      if (this.entries.get(entry.id) === entry && this.expired(entry)) await this.drop(entry, "expired");
    }).catch(() => undefined)));
    return stale.length;
  }

  /** What each device keeps here right now, for tests and the log. */
  usage(): Record<string, { bytes: number; files: number }> {
    const usage: Record<string, { bytes: number; files: number }> = {};
    for (const entry of this.entries.values()) {
      const row = usage[entry.owner] ??= { bytes: 0, files: 0 };
      row.bytes += entry.size;
      row.files += 1;
    }
    return usage;
  }

  close(): void {
    this.closed = true;
    this.stopSweep();
  }

  /** `services.blobs` as a kit sees it. */
  get services(): HostBlobServices {
    return { take: (id, use, options) => this.take(id, use, options) };
  }

  private expired(entry: Entry): boolean {
    return entry.touchedAt + this.ttl <= this.now();
  }

  private enqueue<T>(entry: Entry, work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(failure("This host is shutting down.", HOST_ERROR.unsupported));
    const run = entry.chain.catch(() => undefined).then(work);
    entry.chain = run;
    return run;
  }

  private async drop(entry: Entry, reason: string): Promise<void> {
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    await rm(entry.path, { force: true });
    this.options.logger?.info("blobs.dropped", { id: entry.id, reason, size: entry.size });
  }
}

function every(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

type Method = (params: readonly unknown[], context: HostMethodContext) => Promise<unknown>;

/** `blob-*`: another machine's host sends a file here in pieces. Full access only (`write`). */
export function createBlobMethods(store: () => HostBlobStore | undefined): Record<string, Method> {
  const handled = (run: (blobs: HostBlobStore, params: readonly unknown[], principal: HostInvocationPrincipal) => Promise<unknown>): Method => async (params, context) => {
    const blobs = store();
    if (!blobs) throw failure("This host takes no files from other machines; a host in the window's process has no store.", HOST_ERROR.unsupported);
    return run(blobs, params, context.principal);
  };
  const text = (method: string, field: string, value: unknown): string => {
    if (typeof value !== "string") throw invalid(`${method}: ${field} must be a string.`);
    return value;
  };
  const whole = (method: string, field: string, value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid(`${method}: ${field} must be a whole number from 0.`);
    return value;
  };
  return {
    [BLOB_METHODS.put]: handled((blobs, params, principal) =>
      blobs.put(principal, text("blob-put", "id", params[0]), whole("blob-put", "index", params[1]), text("blob-put", "data", params[2]))),
    [BLOB_METHODS.commit]: handled((blobs, params, principal) => {
      const sha256 = text("blob-commit", "sha256", params[1]);
      if (!/^[0-9a-f]{64}$/iu.test(sha256)) throw invalid("blob-commit: sha256 is 64 hex digits.");
      return blobs.commit(principal, text("blob-commit", "id", params[0]), sha256, whole("blob-commit", "size", params[2]));
    }),
    [BLOB_METHODS.abort]: handled((blobs, params, principal) => blobs.abort(principal, text("blob-abort", "id", params[0]))),
  };
}

/** How a sender reaches the other host: one protocol request, with a timeout. */
export type BlobRequest = (method: string, params: readonly unknown[], timeoutMs: number) => Promise<unknown>;

/** Cuts any source into pieces of exactly `size` bytes, the last one shorter. */
async function* pieces(source: HostBlobSource, size: number): AsyncGenerator<Buffer> {
  if (source instanceof Uint8Array) {
    for (let offset = 0; offset < source.length; offset += size) yield Buffer.from(source.buffer, source.byteOffset + offset, Math.min(size, source.length - offset));
    return;
  }
  let held: Buffer[] = [];
  let length = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("An upload reads bytes; open the stream without an encoding.");
    held.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
    length += chunk.length;
    while (length >= size) {
      const joined = Buffer.concat(held, length);
      yield joined.subarray(0, size);
      held = length > size ? [joined.subarray(size)] : [];
      length -= size;
    }
  }
  if (length > 0) yield Buffer.concat(held, length);
}

/**
 * Sends `source` to another host through `request`, piece by piece, and
 * commits it with its sha256. Stops at an abort or the first refusal and asks
 * the other host to drop what it has; whatever is left there expires anyway.
 */
export async function sendBlob(request: BlobRequest, source: HostBlobSource, options: HostBlobUploadOptions = {}): Promise<HostUploadedBlob> {
  const id = randomUUID().replace(/-/gu, "");
  const total = options.size ?? (source instanceof Uint8Array ? source.length : undefined);
  if (total !== undefined && total > BLOB_MAX_BYTES) throw failure(`The file is larger than the ${formatBytes(BLOB_MAX_BYTES)} a host takes.`);
  const timeout = options.timeoutMs ?? PIECE_TIMEOUT_MS;
  const hash = createHash("sha256");
  const cancelled = () => failure("The upload was cancelled.", HOST_ERROR.cancelled);
  const signal = options.signal;
  // An abort answers at once; the piece in flight still lands there and the abort drops it.
  const send = (method: string, params: readonly unknown[]): Promise<unknown> => {
    if (!signal) return request(method, params, timeout);
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const stop = () => reject(cancelled());
      signal.addEventListener("abort", stop, { once: true });
      request(method, params, timeout).then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
  };
  let sent = 0;
  let index = 0;
  let started = false;
  try {
    for await (const piece of pieces(source, BLOB_PIECE_BYTES)) {
      if (sent + piece.length > BLOB_MAX_BYTES) throw failure(`The file is larger than the ${formatBytes(BLOB_MAX_BYTES)} a host takes.`);
      hash.update(piece);
      started = true;
      await send(BLOB_METHODS.put, [id, index, piece.toString("base64")]);
      index += 1;
      sent += piece.length;
      options.onProgress?.({ sent, ...(total !== undefined ? { total } : {}) });
    }
    started = true;
    if (index === 0) await send(BLOB_METHODS.put, [id, 0, ""]);
    const sha256 = hash.digest("hex");
    await send(BLOB_METHODS.commit, [id, sha256, sent]);
    return { id, size: sent, sha256 };
  } catch (error) {
    if (started) void request(BLOB_METHODS.abort, [id], timeout).catch(() => undefined);
    throw error;
  }
}
