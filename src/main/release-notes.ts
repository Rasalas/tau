import { readFile } from "node:fs/promises";
import { isNightlyVersion } from "../shared/app-version.js";
import type { ReleaseNotes } from "../shared/window-shell.js";
import { readPersistedJson, writePersistedJson } from "./persisted-json.js";

const MAX_ITEMS = 12;
const MAX_ITEM_LENGTH = 220;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** GitHub's generated notes end a line with " by @someone in <pull URL>"; the reader wants the change. */
const GENERATED_SUFFIX = /\s+by\s+@[\w-]+(?:\[bot\])?\s+in\s+\S+$/u;

/**
 * A release body as a short list of changes. The body is Markdown from the
 * GitHub API or HTML from the update feed; either becomes one line per item,
 * without headings, links, the contributor list and the compare link.
 */
export function parseReleaseNotes(body: string, version: string, url?: string): ReleaseNotes {
  const text = decodeEntities(body
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<li\b[^>]*>/giu, "\n- ")
    .replace(/<h[1-6]\b[^>]*>/giu, "\n# ")
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol)>/giu, "\n")
    .replace(/<[^>]*>/gu, ""));
  const items: string[] = [];
  let total = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const plain = line.replace(/[*_`#]/gu, "").trim().toLowerCase();
    if (plain === "new contributors" || plain.startsWith("full changelog")) break;
    if (!line || line.startsWith("#") || plain === "what's changed" || plain === "whats changed") continue;
    const item = line
      .replace(/^(?:[-*+]|\d+[.)])\s+/u, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .replace(/\*\*([^*]+)\*\*/gu, "$1")
      .replace(GENERATED_SUFFIX, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (!item) continue;
    total += 1;
    if (items.length < MAX_ITEMS) items.push(item.length > MAX_ITEM_LENGTH ? `${item.slice(0, MAX_ITEM_LENGTH - 1).trimEnd()}…` : item);
  }
  return { version, items, totalItems: total, ...(url ? { url } : {}) };
}

/** electron-updater's `releaseNotes`: a string, or one `{ version, note }` per release. */
export function releaseNoteText(notes: unknown, version: string): string | undefined {
  if (typeof notes === "string") return notes;
  if (!Array.isArray(notes)) return undefined;
  const entry = notes.find((note: unknown) => (note as { version?: unknown } | null)?.version === version) as { note?: unknown } | undefined;
  return typeof entry?.note === "string" ? entry.note : undefined;
}

/** Where the notes of a version are read from, when the update did not bring them along. */
export interface ReleaseNotesSource {
  read(version: string): Promise<{ body: string; url?: string } | undefined>;
}

/** The repository's release for a version, read-only through the public API. A nightly is the moving `nightly` tag. */
export function githubReleaseNotes(feed: { owner: string; repo: string }, fetchImpl: typeof fetch = fetch): ReleaseNotesSource {
  return {
    async read(version) {
      const tag = isNightlyVersion(version) ? "nightly" : `v${version}`;
      const response = await fetchImpl(`https://api.github.com/repos/${feed.owner}/${feed.repo}/releases/tags/${encodeURIComponent(tag)}`, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return undefined;
      const release = await response.json() as { body?: unknown; html_url?: unknown };
      if (typeof release.body !== "string") return undefined;
      return { body: release.body, ...(typeof release.html_url === "string" ? { url: release.html_url } : {}) };
    },
  };
}

/** A local file standing in for the release, for tests and a dev instance (`TAU_RELEASE_NOTES_FILE`). */
export function fileReleaseNotes(path: string): ReleaseNotesSource {
  return { read: async () => ({ body: await readFile(path, "utf8") }) };
}

const STATE_VERSION = 1;

interface ReleaseNotesState extends Record<string, unknown> {
  /** The version that ran last. */
  lastVersion?: string;
  /** A version whose notes are waiting to be shown once. */
  due?: string;
  /** Notes a finished download brought along, for the start that installs it. */
  downloaded?: { version: string; body: string };
}

function decodeState(value: unknown): ReleaseNotesState {
  const item = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const text = (key: string) => typeof item[key] === "string" && item[key] ? item[key] as string : undefined;
  const downloaded = item.downloaded as { version?: unknown; body?: unknown } | undefined;
  const lastVersion = text("lastVersion");
  const due = text("due");
  return {
    ...(lastVersion ? { lastVersion } : {}),
    ...(due ? { due } : {}),
    ...(typeof downloaded?.version === "string" && typeof downloaded.body === "string" ? { downloaded: { version: downloaded.version, body: downloaded.body } } : {}),
  };
}

export interface ReleaseNotesOptions {
  file: string;
  currentVersion: string;
  source?: ReleaseNotesSource;
  log?: (label: string, detail?: unknown) => void;
}

/**
 * The notes of the version that just started, shown once. A start whose
 * version differs from the last one's makes them due; the page takes them
 * with `pending` and marks them `seen`. The first start ever has none.
 */
export class ReleaseNotesStore {
  private state: ReleaseNotesState = {};
  private loaded: Promise<void> | undefined;
  private notes: Promise<ReleaseNotes | undefined> | undefined;

  constructor(private readonly options: ReleaseNotesOptions) {}

  /** Records this start; call once, early. */
  start(): Promise<void> {
    this.loaded ??= (async () => {
      const read = await readPersistedJson<ReleaseNotesState>(this.options.file, {
        expectedVersion: STATE_VERSION,
        decode: (value) => decodeState(value),
        logger: { warn: (message, detail) => this.options.log?.(message, detail) },
      }).catch(() => undefined);
      const state = read?.data ?? {};
      const { currentVersion } = this.options;
      const moved = state.lastVersion !== undefined && state.lastVersion !== currentVersion;
      this.state = {
        lastVersion: currentVersion,
        ...(moved ? { due: currentVersion } : state.due === currentVersion ? { due: currentVersion } : {}),
        ...(state.downloaded ? { downloaded: state.downloaded } : {}),
      };
      await this.save();
    })();
    return this.loaded;
  }

  /** The notes waiting to be shown, read once per start; undefined when none are due. */
  async pending(): Promise<ReleaseNotes | undefined> {
    await this.start();
    const version = this.state.due;
    if (!version) return undefined;
    this.notes ??= this.read(version);
    return this.notes;
  }

  async seen(version: string): Promise<void> {
    await this.start();
    if (this.state.due !== version) return;
    const { lastVersion, downloaded } = this.state;
    this.state = { ...(lastVersion ? { lastVersion } : {}), ...(downloaded && downloaded.version !== version ? { downloaded } : {}) };
    this.notes = undefined;
    await this.save();
  }

  /** Keeps what a download said about itself, so the restart into it does not have to ask. */
  async downloaded(version: string, notes: unknown): Promise<void> {
    await this.start();
    const body = releaseNoteText(notes, version);
    if (!body) return;
    this.state = { ...this.state, downloaded: { version, body } };
    await this.save();
  }

  private async read(version: string): Promise<ReleaseNotes | undefined> {
    const kept = this.state.downloaded?.version === version ? this.state.downloaded.body : undefined;
    try {
      const release = kept !== undefined ? { body: kept } : await this.options.source?.read(version);
      return parseReleaseNotes(release?.body ?? "", version, release?.url);
    } catch (error) {
      this.options.log?.("release-notes.read.failed", error);
      return parseReleaseNotes("", version);
    }
  }

  private async save(): Promise<void> {
    await writePersistedJson(this.options.file, STATE_VERSION, this.state).catch((error: unknown) => this.options.log?.("release-notes.save.failed", error));
  }
}
