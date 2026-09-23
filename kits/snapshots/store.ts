import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SnapShotAccessibility, SnapShotCapture, SnapShotContent, SnapShotMeta } from "./protocol.js";

/** A capture nobody sent is gone after a week. */
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** The oldest go first beyond this many. */
export const MAX_KEPT = 24;

const ID = /^snap-[a-z0-9-]+$/u;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg" };

interface StoredCapture {
  meta: SnapShotMeta;
  accessibility?: SnapShotAccessibility;
}

/**
 * The captures a composer has not sent yet, in the kit's own state folder on
 * this machine: the picture beside a JSON file with its metadata and its
 * accessibility tree. Nothing else reads them; a sent or removed one is deleted.
 */
export class SnapShotStore {
  private readonly records = new Map<string, StoredCapture>();
  private loaded: Promise<void> | undefined;

  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {}

  /** Reads what an earlier run left, dropping the stale and anything it cannot parse. */
  load(): Promise<void> {
    return this.loaded ??= (async () => {
      const names = await readdir(this.directory).catch(() => [] as string[]);
      for (const name of names.filter((entry) => entry.endsWith(".json"))) {
        const id = name.slice(0, -5);
        try {
          const record = JSON.parse(await readFile(join(this.directory, name), "utf8")) as StoredCapture;
          if (!ID.test(id) || record.meta?.id !== id) throw new Error("not a capture");
          if (this.now() - record.meta.capturedAt > KEEP_MS) throw new Error("stale");
          this.records.set(id, record);
        } catch {
          await this.remove(id);
        }
      }
      await this.trim();
    })();
  }

  list(): SnapShotMeta[] {
    return [...this.records.values()].map((record) => record.meta).sort((a, b) => a.capturedAt - b.capturedAt);
  }

  meta(id: string): SnapShotMeta | undefined {
    return this.records.get(id)?.meta;
  }

  async add(capture: SnapShotCapture): Promise<SnapShotMeta> {
    await this.load();
    const id = `snap-${this.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const bytes = Buffer.from(capture.image.data, "base64");
    const meta: SnapShotMeta = {
      id,
      app: capture.app,
      title: capture.title,
      capturedAt: capture.capturedAt,
      width: capture.image.width,
      height: capture.image.height,
      mimeType: capture.image.mimeType,
      size: bytes.length,
      ...(capture.accessibility ? { accessibility: { nodes: capture.accessibility.nodes, truncated: capture.accessibility.truncated } } : {}),
      ...(capture.accessibilityNote ? { accessibilityNote: capture.accessibilityNote } : {}),
      claimed: false,
    };
    const record: StoredCapture = { meta, ...(capture.accessibility ? { accessibility: capture.accessibility } : {}) };
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.imagePath(meta), bytes);
    await writeFile(join(this.directory, `${id}.json`), JSON.stringify(record));
    this.records.set(id, record);
    await this.trim();
    return meta;
  }

  /** The first client to ask gets it; later ones hear `undefined`. */
  async claim(id: string): Promise<SnapShotMeta | undefined> {
    const record = this.records.get(id);
    if (!record || record.meta.claimed) return undefined;
    record.meta = { ...record.meta, claimed: true };
    await writeFile(join(this.directory, `${id}.json`), JSON.stringify(record)).catch(() => undefined);
    return record.meta;
  }

  async read(id: string): Promise<SnapShotContent | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;
    const data = await readFile(this.imagePath(record.meta)).catch(() => undefined);
    if (!data) return undefined;
    return { meta: record.meta, data: data.toString("base64"), ...(record.accessibility ? { accessibility: record.accessibility } : {}) };
  }

  async remove(id: string): Promise<void> {
    if (!ID.test(id)) return;
    this.records.delete(id);
    await rm(join(this.directory, `${id}.json`), { force: true });
    for (const extension of Object.values(EXTENSIONS)) await rm(join(this.directory, `${id}.${extension}`), { force: true });
  }

  private imagePath(meta: SnapShotMeta): string {
    return join(this.directory, `${meta.id}.${EXTENSIONS[meta.mimeType] ?? "png"}`);
  }

  private async trim(): Promise<void> {
    const excess = this.list().length - MAX_KEPT;
    for (const meta of this.list().slice(0, Math.max(0, excess))) await this.remove(meta.id);
  }
}
