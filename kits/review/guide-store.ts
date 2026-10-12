import { join } from "node:path";
import { readPersistedJson, writePersistedJson } from "tau/host-extension";
import { decodeGuideStops } from "./guide-normalize.js";
import type { PullRequestGuide } from "./guide-protocol.js";

const FILE = "guides.json";
const VERSION = 1;

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function decodeGuide(value: unknown): PullRequestGuide | undefined {
  const raw = record(value);
  if (typeof raw.headSha !== "string" || !raw.headSha || typeof raw.generatedAt !== "string") return undefined;
  const stops = decodeGuideStops(raw);
  if (stops.length === 0) return undefined;
  return { headSha: raw.headSha, generatedAt: raw.generatedAt, model: typeof raw.model === "string" && raw.model ? raw.model : null, stops };
}

/** The guides of this host, one per pull request, in the kit's state folder. A push never deletes one. */
export class GuideStore {
  private guides = new Map<string, PullRequestGuide>();
  private loaded?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly stateDir: string) {}

  private get file(): string { return join(this.stateDir, FILE); }

  private load(): Promise<void> {
    this.loaded ??= readPersistedJson<Map<string, PullRequestGuide>>(this.file, {
      expectedVersion: VERSION,
      decode: (value) => new Map(Object.entries(record(record(value).guides)).flatMap(([key, entry]) => {
        const guide = decodeGuide(entry);
        return guide ? [[key, guide] as const] : [];
      })),
    }).then((read) => { this.guides = read?.data ?? new Map(); });
    return this.loaded;
  }

  async get(key: string): Promise<PullRequestGuide | null> {
    await this.load();
    const guide = this.guides.get(key);
    return guide ? structuredClone(guide) : null;
  }

  async put(key: string, guide: PullRequestGuide): Promise<void> {
    await this.load();
    this.guides.set(key, structuredClone(guide));
    const snapshot = Object.fromEntries(this.guides);
    const write = this.writes.then(() => writePersistedJson(this.file, VERSION, { guides: snapshot }));
    this.writes = write.catch(() => undefined);
    await write;
  }

  async idle(): Promise<void> { await this.writes; }
}
