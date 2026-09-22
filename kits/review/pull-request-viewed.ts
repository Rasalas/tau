import { join } from "node:path";
import { readPersistedJson, writePersistedJson } from "tau/host-extension";
import type { PullRequestViewedState } from "./protocol.js";

const VERSION = 1;
/** Requests kept; the least recently touched go first. */
const MAX_REQUESTS = 200;

interface Stored {
  requests: Record<string, { touchedAt: number; files: Record<string, string> }>;
}

function decode(value: unknown): Stored | undefined {
  const requests = (value as { requests?: unknown } | null)?.requests;
  if (!requests || typeof requests !== "object") return undefined;
  const clean: Stored["requests"] = {};
  for (const [url, entry] of Object.entries(requests as Record<string, unknown>)) {
    const files = (entry as { files?: unknown } | null)?.files;
    const touchedAt = (entry as { touchedAt?: unknown } | null)?.touchedAt;
    if (!files || typeof files !== "object") continue;
    clean[url] = {
      touchedAt: typeof touchedAt === "number" ? touchedAt : 0,
      files: Object.fromEntries(Object.entries(files as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === "string")),
    };
  }
  return { requests: clean };
}

/**
 * Viewed marks for a host that keeps none (GitLab): per request, the paths
 * the user ticked and a fingerprint of each file's change at that moment. A
 * file whose change moved on since reads as "dismissed", as GitHub's own do.
 */
export class LocalViewedStore {
  private loaded: Promise<Stored> | undefined;

  constructor(private readonly directory: string | undefined, private readonly now: () => number = Date.now) {}

  private get file(): string | undefined {
    return this.directory ? join(this.directory, "viewed-files.json") : undefined;
  }

  private load(): Promise<Stored> {
    const file = this.file;
    this.loaded ??= file
      ? readPersistedJson<Stored>(file, { expectedVersion: VERSION, decode }).then((read) => read?.data ?? { requests: {} })
      : Promise.resolve({ requests: {} });
    return this.loaded;
  }

  async states(url: string, fingerprints: ReadonlyMap<string, string>): Promise<Map<string, PullRequestViewedState>> {
    const files = (await this.load()).requests[url]?.files ?? {};
    const states = new Map<string, PullRequestViewedState>();
    for (const [path, fingerprint] of fingerprints) {
      const marked = files[path];
      states.set(path, marked === undefined ? "unviewed" : marked === fingerprint ? "viewed" : "dismissed");
    }
    return states;
  }

  async set(url: string, path: string, fingerprint: string, viewed: boolean): Promise<void> {
    const stored = await this.load();
    const entry = stored.requests[url] ?? { touchedAt: 0, files: {} };
    if (viewed) entry.files[path] = fingerprint;
    else delete entry.files[path];
    entry.touchedAt = this.now();
    stored.requests[url] = entry;
    const urls = Object.keys(stored.requests).sort((left, right) => stored.requests[right]!.touchedAt - stored.requests[left]!.touchedAt);
    for (const stale of urls.slice(MAX_REQUESTS)) delete stored.requests[stale];
    if (this.file) await writePersistedJson(this.file, VERSION, { requests: stored.requests });
  }
}
