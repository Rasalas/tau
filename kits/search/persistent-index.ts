import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { foldSearchText } from "./relevance.js";
import { piTextRecords, TEXT_CHUNK, type TextRecord } from "./pi-text-stream.js";
import { RecordMatcher } from "./stream-match.js";
import type { ThreadText } from "./threads.js";

// Bump when extraction, Unicode folding, boundaries or the record format change.
const VERSION = 1;
const FOOTER_BYTES = 4096;
const BLOOM_BYTES = 2048;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export interface IndexIdentity { source: string; id: string; path: string }
interface Header { version: number; identity: IndexIdentity; fingerprint: string; updatedAt: number }
interface Footer { digest: string; bloom: string; check: string }
export interface IndexedThread extends IndexIdentity { updatedAt: number }
const identityKey = (identity: IndexIdentity) => JSON.stringify([identity.source, identity.id, identity.path]);

/** Fixed-size trigram prefilter. Collisions can only cause extra reads. */
class Bloom {
  readonly bits: Buffer;
  private tail = "";
  constructor(bits = Buffer.alloc(BLOOM_BYTES)) { this.bits = bits; }
  private positions(text: string, at: number): number[] {
    const a = text.charCodeAt(at), b = text.charCodeAt(at + 1), c = text.charCodeAt(at + 2);
    return [(Math.imul(a, 31) + Math.imul(b, 17) + c) >>> 0, (Math.imul(a, 65599) ^ Math.imul(b, 131) ^ c) >>> 0].map((value) => value % (BLOOM_BYTES * 8));
  }
  add(text: string): void {
    const input = this.tail + text;
    const folded = foldSearchText(input);
    for (let at = 0; at + 2 < folded.length; at += 1) for (const bit of this.positions(folded, at)) this.bits[bit >> 3]! |= 1 << (bit & 7);
    // Original characters, including a possible split surrogate pair, are folded
    // together next time. Duplicate trigrams are harmless.
    this.tail = input.slice(-4);
  }
  mayHave(tokens: readonly string[]): boolean {
    return tokens.every((token) => {
      for (let at = 0; at + 2 < token.length; at += 1) for (const bit of this.positions(token, at)) if (!(this.bits[bit >> 3]! & (1 << (bit & 7)))) return false;
      return true;
    });
  }
}

async function fingerprint(path: string): Promise<{ value: string; updatedAt: number }> {
  const info = await stat(path, { bigint: true });
  if (!info.isFile()) throw new Error("Session is not a file");
  return { value: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":"), updatedAt: Number(info.mtimeNs) / 1e6 };
}

/** Unlike readline, a corrupt index cannot allocate one unbounded line. */
async function* lines(file: FileHandle, end: number): AsyncGenerator<string> {
  let rest = "";
  const stream = file.createReadStream({ encoding: "utf8", start: 0, end, autoClose: false, highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      const pieces = (rest + String(chunk)).split("\n");
      rest = pieces.pop()!;
      for (const piece of pieces) {
        if (piece.length > TEXT_CHUNK * 6 + 8192) throw new Error("Invalid index record");
        yield piece;
      }
      if (rest.length > TEXT_CHUNK * 6 + 8192) throw new Error("Invalid index record");
    }
    if (rest) throw new Error("Incomplete index record");
  } finally { stream.destroy(); }
}

export class PersistentMessageIndex {
  private ready: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  readonly directory: string;
  /** Counters for repeatable cold/warm/restart measurements; no transcript data. */
  readonly stats = { sourceReads: 0, rebuilds: 0 };
  constructor(stateDir: string) { this.directory = join(stateDir, `messages-v${VERSION}`); }

  /** Serialize writers, pruning and readers inside one activation. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }
  idle(): Promise<unknown> { return this.queue; }

  private init(): Promise<void> {
    return this.ready ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe search index directory");
      await chmod(this.directory, 0o700);
      // Only old scratch files are garbage. A second activation may still own
      // a recent one; never follow a scratch symlink or recursively remove it.
      for (const name of await readdir(this.directory)) {
        if (!/^\.write-[\da-f-]+$/u.test(name)) continue;
        const path = join(this.directory, name);
        const entry = await lstat(path).catch(() => undefined);
        if (entry && Date.now() - entry.mtimeMs > 24 * 60 * 60_000) await unlink(path).catch(() => undefined);
      }
    })();
  }
  private path(identity: IndexIdentity): string { return join(this.directory, `${hash(identityKey(identity))}.index`); }

  private async metadata(file: FileHandle): Promise<{ header: Header; footer: Footer; end: number }> {
    const info = await file.stat();
    if (!info.isFile() || info.size < FOOTER_BYTES) throw new Error("Incomplete index");
    const head = Buffer.alloc(Math.min(info.size - FOOTER_BYTES, 8192));
    await file.read(head, 0, head.length, 0);
    const newline = head.indexOf(10);
    if (newline < 0) throw new Error("Missing index header");
    const header = JSON.parse(head.subarray(0, newline).toString("utf8")) as Header;
    const tail = Buffer.alloc(FOOTER_BYTES);
    await file.read(tail, 0, tail.length, info.size - FOOTER_BYTES);
    const footer = JSON.parse(tail.toString("utf8").trim()) as Footer;
    if (header.version !== VERSION || typeof header.fingerprint !== "string" || !Number.isFinite(header.updatedAt)
      || !header.identity || typeof header.identity.source !== "string" || typeof header.identity.id !== "string" || typeof header.identity.path !== "string"
      || typeof footer.digest !== "string" || typeof footer.bloom !== "string"
      || Buffer.from(footer.bloom, "base64").length !== BLOOM_BYTES
      || footer.check !== hash(JSON.stringify([header, footer.digest, footer.bloom]))) throw new Error("Invalid index version or footer");
    return { header, footer, end: info.size - FOOTER_BYTES - 1 };
  }

  private async write(header: Header, records: AsyncIterable<TextRecord>): Promise<void> {
    await this.init();
    const temporary = join(this.directory, `.write-${randomUUID()}`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const digest = createHash("sha256");
      const bloom = new Bloom();
      let buffer = JSON.stringify(header) + "\n";
      for await (const record of records) {
        if (record.kind === "text") bloom.add(record.text);
        const line = JSON.stringify(record) + "\n";
        digest.update(line);
        buffer += line;
        if (buffer.length >= 64 * 1024) { await file.writeFile(buffer); buffer = ""; }
      }
      if (buffer) await file.writeFile(buffer);
      const footer: Footer = { digest: digest.digest("hex"), bloom: bloom.bits.toString("base64"), check: "" };
      footer.check = hash(JSON.stringify([header, footer.digest, footer.bloom]));
      const tail = JSON.stringify(footer);
      await file.writeFile(tail.padEnd(FOOTER_BYTES - 1, " ") + "\n");
      await file.sync();
      await file.close();
      await rename(temporary, this.path(header.identity));
      // Persist the rename where the platform supports directory fsync.
      const directory = await open(this.directory, constants.O_RDONLY).catch(() => undefined);
      if (directory) { try { await directory.sync(); } catch { /* Windows */ } finally { await directory.close(); } }
    } finally {
      await file.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  /** Build only changed Pi files. A change during extraction never publishes. */
  private async ensurePi(identity: IndexIdentity, version: Awaited<ReturnType<typeof fingerprint>>): Promise<void> {
    const file = await open(this.path(identity), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
    if (file) {
      try {
        const { header } = await this.metadata(file);
        if (identityKey(header.identity) === identityKey(identity) && header.fingerprint === version.value) return;
      } catch { /* rebuild invalid caches */ } finally { await file.close(); }
    }
    this.stats.sourceReads += 1;
    const source = await open(identity.path, constants.O_RDONLY);
    const stream = source.createReadStream({ encoding: "utf8", autoClose: false, highWaterMark: 64 * 1024 });
    const records = async function* (): AsyncGenerator<TextRecord> {
      try {
        yield* piTextRecords(stream as AsyncIterable<string>);
        const opened = await source.stat({ bigint: true });
        const value = [opened.dev, opened.ino, opened.size, opened.mtimeNs, opened.ctimeNs].join(":");
        if (value !== version.value || (await fingerprint(identity.path)).value !== version.value) throw new Error("Session changed while indexing");
      } finally { stream.destroy(); await source.close().catch(() => undefined); }
    };
    try {
      await this.write({ version: VERSION, identity, fingerprint: version.value, updatedAt: version.updatedAt }, records());
      this.stats.rebuilds += 1;
    } finally { stream.destroy(); await source.close().catch(() => undefined); }
  }

  private async search(identity: IndexIdentity, tokens: readonly string[], expected?: string) {
    const file = await open(this.path(identity), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const { header, footer, end } = await this.metadata(file);
      if (identityKey(header.identity) !== identityKey(identity) || (expected !== undefined && header.fingerprint !== expected)) throw new Error("Wrong index identity/version");
      if (!new Bloom(Buffer.from(footer.bloom, "base64")).mayHave(tokens)) return undefined;
      const digest = createHash("sha256");
      const matcher = new RecordMatcher(tokens);
      let first = true;
      for await (const line of lines(file, end)) {
        if (first) { first = false; continue; }
        digest.update(line + "\n");
        const record = JSON.parse(line) as TextRecord;
        if (record.kind === "text" ? typeof record.text !== "string" || record.text.length > TEXT_CHUNK
          : record.kind === "block" || record.kind === "message" ? typeof record.visible !== "boolean" : true) throw new Error("Invalid text record");
        matcher.add(record);
      }
      if (digest.digest("hex") !== footer.digest) throw new Error("Corrupt index body");
      const match = matcher.result();
      return match ? { match, updatedAt: header.updatedAt } : undefined;
    } finally { await file.close(); }
  }

  async searchPi(identity: IndexIdentity, tokens: readonly string[]) {
    await this.init();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const version = await fingerprint(identity.path);
        await this.ensurePi(identity, version);
        const found = await this.search(identity, tokens, version.value);
        if ((await fingerprint(identity.path)).value === version.value) return found;
      } catch { await unlink(this.path(identity)).catch(() => undefined); }
    }
    return undefined;
  }

  /** Legacy exports remain prefixes; their timestamp is never a paged revision. */
  async putRuntime(source: string, id: string, updatedAt: number, texts: readonly ThreadText[]): Promise<void> {
    async function* records(): AsyncGenerator<TextRecord> {
      for (const entry of texts) {
        for (let at = 0; at < entry.text.length; at += TEXT_CHUNK) yield { kind: "text", text: entry.text.slice(at, at + TEXT_CHUNK) };
        yield { kind: "block", visible: true };
        yield { kind: "message", role: entry.role, visible: true };
      }
    }
    await this.write({ version: VERSION, identity: { source, id, path: "" }, fingerprint: String(updatedAt), updatedAt }, records());
  }

  /**
   * Atomically publish a complete paged export. The factory is lazy: after a
   * restart a matching committed revision needs a catalog read, no text export.
   * Interrupted, changed or malformed streams leave the old file untouched.
   */
  async putRuntimeStream(source: string, id: string, updatedAt: number, version: string,
    chunks: () => AsyncIterable<import("tau/host-extension").ThreadTextChunk>): Promise<void> {
    await this.init();
    const identity = { source, id, path: "" };
    const exportFingerprint = `runtime-v2:${version}`;
    const file = await open(this.path(identity), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
    if (file) {
      try {
        const { header } = await this.metadata(file);
        if (identityKey(header.identity) === identityKey(identity) && header.fingerprint === exportFingerprint && header.updatedAt === updatedAt) return;
      } catch { /* Replace invalid generations. */ } finally { await file.close(); }
    }
    async function* records(): AsyncGenerator<TextRecord> {
      let message: { id: string; role: "user" | "assistant"; offset: number } | undefined;
      let previous = -1;
      for await (const chunk of chunks()) {
        const ordinal = Number(chunk.messageId);
        if (typeof chunk.messageId !== "string" || !/^\d+$/u.test(chunk.messageId) || !Number.isSafeInteger(ordinal)
          || (chunk.role !== "user" && chunk.role !== "assistant") || !Number.isSafeInteger(chunk.offset) || chunk.offset < 0
          || typeof chunk.text !== "string" || chunk.text.length > TEXT_CHUNK || typeof chunk.end !== "boolean"
          || !chunk.end && !chunk.text.length) throw new Error("Invalid runtime text chunk");
        if (!message) {
          if (ordinal <= previous || chunk.offset !== 0) throw new Error("Invalid runtime message order");
          message = { id: chunk.messageId, role: chunk.role, offset: 0 };
        }
        if (message.id !== chunk.messageId || message.role !== chunk.role || message.offset !== chunk.offset) throw new Error("Incomplete runtime message");
        message.offset += chunk.text.length;
        if (chunk.text) yield { kind: "text", text: chunk.text };
        if (chunk.end) {
          yield { kind: "block", visible: true };
          yield { kind: "message", role: message.role, visible: true };
          previous = ordinal; message = undefined;
        }
      }
      if (message) throw new Error("Unfinished runtime message");
    }
    await this.write({ version: VERSION, identity, fingerprint: exportFingerprint, updatedAt }, records());
  }
  async searchRuntime(source: string, id: string, tokens: readonly string[]) { return this.search({ source, id, path: "" }, tokens); }
  async drop(identity: IndexIdentity): Promise<void> { await unlink(this.path(identity)).catch(() => undefined); }

  async catalog(): Promise<IndexedThread[]> {
    await this.init();
    const catalog: IndexedThread[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[\da-f]{64}\.index$/u.test(name)) continue;
      const file = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
      if (!file) continue;
      try {
        const { header } = await this.metadata(file);
        if (this.path(header.identity) !== join(this.directory, name)) continue;
        catalog.push({ ...header.identity, updatedAt: header.updatedAt });
      } catch { await unlink(join(this.directory, name)).catch(() => undefined); } finally { await file.close(); }
    }
    return catalog;
  }
  async prunePi(present: readonly IndexIdentity[]): Promise<void> {
    const keep = new Set(present.map((identity) => this.path(identity)));
    for (const entry of await this.catalog()) if (entry.source === "pi" && !keep.has(this.path(entry))) await this.drop(entry);
  }

  /** Control-plane build; failures must reach Settings instead of looking ready. */
  async indexPi(identity: IndexIdentity): Promise<void> {
    await this.init();
    for (let attempt = 0; ; attempt += 1) {
      const version = await fingerprint(identity.path);
      try {
        await this.ensurePi(identity, version);
        if ((await fingerprint(identity.path)).value !== version.value) throw new Error("Session changed while indexing");
        return;
      } catch (error) { if (attempt >= 1) throw error; }
    }
  }

  /** Read an already published generation without exposing replacement files. */
  async searchCommittedPi(identity: IndexIdentity, tokens: readonly string[]) {
    return this.search(identity, tokens);
  }

  async usage(): Promise<{ threads: number; bytes: number }> {
    const catalog = await this.catalog();
    let bytes = 0;
    for (const entry of catalog) bytes += (await lstat(this.path(entry))).size;
    return { threads: new Set(catalog.map(entry => entry.id)).size, bytes };
  }

  /** Call only after writers and readers have drained; never follow directories. */
  async reset(): Promise<void> {
    const info = await lstat(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe search index directory");
    for (const name of await readdir(this.directory)) {
      if (/^[\da-f]{64}\.index$/u.test(name) || /^\.write-[\da-f-]+$/u.test(name)) await unlink(join(this.directory, name));
    }
    this.ready = undefined;
  }

}
