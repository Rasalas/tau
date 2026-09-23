import { join } from "node:path";
import { readPersistedJson, writePersistedJson } from "tau/host-extension";
import type { PreviewHistoryEntry } from "./protocol.js";

const VERSION = 1;
const MAX_ENTRIES = 30;
const SAVE_DELAY_MS = 1_000;

/** Pages worth offering again: web pages and workspace files, never `about:blank`. */
export function rememberable(url: string): boolean {
  return /^(?:https?|file):\/\//u.test(url);
}

function decode(value: unknown): PreviewHistoryEntry[] | undefined {
  const listed = value && typeof value === "object" && Array.isArray((value as { entries?: unknown }).entries) ? (value as { entries: unknown[] }).entries : [];
  return listed.flatMap((raw) => {
    const entry = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (typeof entry.url !== "string" || !rememberable(entry.url) || typeof entry.visitedAt !== "number") return [];
    return [{ url: entry.url, visitedAt: entry.visitedAt, ...(typeof entry.title === "string" && entry.title ? { title: entry.title } : {}) }];
  }).slice(0, MAX_ENTRIES);
}

/**
 * The pages the preview showed, newest first, 30 at most, in
 * `<stateDir>/history.json`. Writes wait a second so a page that loads, gets
 * its title and redirects is one write.
 */
export class PreviewHistory {
  private entries: PreviewHistoryEntry[] = [];

  private loaded: Promise<void> | undefined;

  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly stateDir: string, private readonly now: () => number = Date.now) {}

  private get file(): string {
    return join(this.stateDir, "history.json");
  }

  async list(): Promise<PreviewHistoryEntry[]> {
    this.loaded ??= (this.stateDir
      ? readPersistedJson<PreviewHistoryEntry[]>(this.file, { expectedVersion: VERSION, decode })
        .then((read) => {
          if (read) this.entries = [...this.entries, ...read.data.filter((stored) => !this.entries.some((entry) => entry.url === stored.url))].slice(0, MAX_ENTRIES);
        })
        .catch(() => undefined)
      : Promise.resolve());
    await this.loaded;
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** A page was shown: first in the list, with the newest title it had. */
  visit(url: string, title: string): void {
    if (!rememberable(url)) return;
    const previous = this.entries.find((entry) => entry.url === url);
    const named = title.trim() || previous?.title;
    this.entries = [{ url, visitedAt: this.now(), ...(named ? { title: named } : {}) }, ...this.entries.filter((entry) => entry.url !== url)].slice(0, MAX_ENTRIES);
    this.schedule();
  }

  async forget(url: unknown): Promise<PreviewHistoryEntry[]> {
    await this.list();
    this.entries = this.entries.filter((entry) => entry.url !== url);
    this.schedule();
    return this.list();
  }

  private schedule(): void {
    if (!this.stateDir || this.timer) return;
    this.timer = setTimeout(() => { void this.flush(); }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.stateDir) return;
    // A visit before the file was read must not drop what the file holds.
    await this.list();
    await writePersistedJson(this.file, VERSION, { entries: this.entries }).catch(() => undefined);
  }
}
