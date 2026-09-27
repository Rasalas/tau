import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REQUEST_SERVICES, type PullRequestRef, type RequestService, type ThreadPullRequestLink } from "./protocol.js";

const FILE = "thread-pull-requests.json";
/** A thread holds this many links at most; the oldest go first. */
const MAX_LINKS = 50;

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const time = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

const count = (value: unknown): number | undefined => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
const stackOf = (value: unknown): ThreadPullRequestLink["stack"] => {
  const raw = record(value);
  const number = count(raw.number);
  const size = count(raw.size);
  return number !== undefined && size !== undefined ? { number, size } : undefined;
};

function decodeLink(value: unknown): ThreadPullRequestLink | undefined {
  const raw = record(value);
  const url = text(raw.url);
  const host = text(raw.host);
  const repo = text(raw.repo);
  const service = REQUEST_SERVICES.find((candidate): candidate is RequestService => candidate === raw.service);
  const number = typeof raw.number === "number" && Number.isInteger(raw.number) && raw.number > 0 ? raw.number : undefined;
  if (!url || !host || !repo || !service || number === undefined) return undefined;
  const state = raw.state === "open" || raw.state === "closed" || raw.state === "merged" ? raw.state : undefined;
  const source = raw.source === "agent" || raw.source === "created" ? raw.source : "user";
  return {
    url, service, host, repo, number, source,
    linkedAt: time(raw.linkedAt) ?? 0,
    ...(text(raw.title) ? { title: text(raw.title) } : {}),
    ...(state ? { state } : {}),
    ...(typeof raw.draft === "boolean" ? { draft: raw.draft } : {}),
    ...(text(raw.headRef) ? { headRef: text(raw.headRef) } : {}),
    ...(text(raw.baseRef) ? { baseRef: text(raw.baseRef) } : {}),
    ...(stackOf(raw.stack) ? { stack: stackOf(raw.stack) } : {}),
    ...(time(raw.refreshedAt) !== undefined ? { refreshedAt: time(raw.refreshedAt) } : {}),
  };
}

/** Two spellings of one request are one link: host and repository compare without case. */
export const linkKey = (link: Pick<PullRequestRef, "host" | "repo" | "number">): string => `${link.host.toLowerCase()}/${link.repo.toLowerCase()}#${link.number}`;

/**
 * The requests each thread keeps beside it, in the kit's own state folder:
 * a thread of any runtime has them, and deleting the thread drops them.
 * Writes are queued, so two links in a row never lose one another.
 */
export class ThreadLinkStore {
  private threads: Map<string, ThreadPullRequestLink[]> | undefined;
  private loading: Promise<Map<string, ThreadPullRequestLink[]>> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly stateDir: string, private readonly now: () => number = Date.now) {}

  private async load(): Promise<Map<string, ThreadPullRequestLink[]>> {
    if (this.threads) return this.threads;
    this.loading ??= readFile(join(this.stateDir, FILE), "utf8").then(
      (raw) => {
        const threads = new Map<string, ThreadPullRequestLink[]>();
        for (const [threadId, links] of Object.entries(record(record(JSON.parse(raw)).threads))) {
          const decoded = (Array.isArray(links) ? links : []).map(decodeLink).filter((link): link is ThreadPullRequestLink => Boolean(link));
          if (decoded.length > 0) threads.set(threadId, decoded);
        }
        return threads;
      },
      () => new Map<string, ThreadPullRequestLink[]>(),
    );
    this.threads = await this.loading;
    return this.threads;
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, threads: Object.fromEntries(this.threads ?? []) }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(this.stateDir, { recursive: true });
      const temporary = join(this.stateDir, `${FILE}.${process.pid}.tmp`);
      await writeFile(temporary, snapshot);
      await rename(temporary, join(this.stateDir, FILE));
    }).catch(() => undefined);
    return this.writing;
  }

  async list(threadId: string): Promise<ThreadPullRequestLink[]> {
    return [...(await this.load()).get(threadId) ?? []];
  }

  /** Adds a link, or leaves the one already there; answers whether it was there. */
  async link(threadId: string, ref: PullRequestRef, source: ThreadPullRequestLink["source"], snapshot: Partial<ThreadPullRequestLink> = {}): Promise<{ link: ThreadPullRequestLink; alreadyLinked: boolean }> {
    const threads = await this.load();
    const links = threads.get(threadId) ?? [];
    const known = links.find((link) => linkKey(link) === linkKey(ref));
    if (known) return { link: known, alreadyLinked: true };
    const link: ThreadPullRequestLink = { ...snapshot, url: ref.url, service: ref.service, host: ref.host, repo: ref.repo, number: ref.number, source, linkedAt: this.now() };
    threads.set(threadId, [...links, link].slice(-MAX_LINKS));
    await this.save();
    return { link, alreadyLinked: false };
  }

  async unlink(threadId: string, ref: Pick<PullRequestRef, "host" | "repo" | "number">): Promise<boolean> {
    const threads = await this.load();
    const links = threads.get(threadId) ?? [];
    const kept = links.filter((link) => linkKey(link) !== linkKey(ref));
    if (kept.length === links.length) return false;
    if (kept.length > 0) threads.set(threadId, kept); else threads.delete(threadId);
    await this.save();
    return true;
  }

  /** Records what the host said about a linked request just now; false when nothing changed. */
  async update(threadId: string, key: string, snapshot: Pick<ThreadPullRequestLink, "title" | "state" | "draft" | "headRef" | "baseRef" | "stack">): Promise<boolean> {
    const threads = await this.load();
    const links = threads.get(threadId);
    const index = links?.findIndex((link) => linkKey(link) === key) ?? -1;
    if (!links || index < 0) return false;
    const current = links[index]!;
    const { stack: _left, ...kept } = current;
    // A snapshot without a stack means the request left it.
    const next: ThreadPullRequestLink = { ...kept, ...snapshot, refreshedAt: this.now() };
    const changed = (["title", "state", "draft", "headRef", "baseRef"] as const).some((field) => current[field] !== next[field])
      || current.stack?.number !== next.stack?.number || current.stack?.size !== next.stack?.size;
    links[index] = next;
    await this.save();
    return changed;
  }

  /** Every thread that links a request, whichever spelling it was linked by. */
  async threadsLinking(ref: Pick<PullRequestRef, "host" | "repo" | "number">): Promise<string[]> {
    const key = linkKey(ref);
    return [...(await this.load())].flatMap(([threadId, links]) => links.some((link) => linkKey(link) === key) ? [threadId] : []);
  }

  async forget(threadId: string): Promise<boolean> {
    const threads = await this.load();
    if (!threads.delete(threadId)) return false;
    await this.save();
    return true;
  }
}
