import type { ThreadPullRequestLink } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { RequestRefresh } from "./request-refresh.js";

const EMPTY: readonly ThreadPullRequestLink[] = [];
/** A rail row asks for its thread's links at most this often; a change on the host reloads at once. */
const ROW_TTL_MS = 60_000;

/**
 * The requests each thread links, as the window last read them: one read per
 * thread however many surfaces show it, and a reload whenever the host says a
 * thread's links changed (the agent's tool, another window, a create).
 */
export class ThreadLinkRows {
  private entries = new Map<string, { at: number; links: readonly ThreadPullRequestLink[] }>();
  private pending = new Set<string>();
  private listeners = new Set<() => void>();
  private readonly stop: () => void;
  private readonly refresh = new RequestRefresh((threadId) => { void this.load(threadId, true); });
  private readonly reread = new Map<string, boolean | "force">();

  constructor(private readonly client: Pick<PullRequestClient, "links" | "onLinksChanged">, private readonly now: () => number = Date.now) {
    this.stop = client.onLinksChanged((threadId) => { void this.load(threadId); });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get(threadId: string | undefined): readonly ThreadPullRequestLink[] {
    return threadId ? this.entries.get(threadId)?.links ?? EMPTY : EMPTY;
  }

  /** Whether the thread's links were read at least once. */
  has(threadId: string): boolean {
    return this.entries.has(threadId);
  }

  ensure(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (entry && this.now() - entry.at < ROW_TTL_MS) return;
    void this.load(threadId);
  }

  watch(threadId: string): () => void { return this.refresh.watch(threadId); }

  /** Reads again; `refresh` also asks the host for the state of the links still open. */
  async load(threadId: string, refresh?: boolean | "force"): Promise<void> {
    if (this.pending.has(threadId)) {
      if (refresh) this.reread.set(threadId, refresh === "force" || this.reread.get(threadId) === "force" ? "force" : true);
      return;
    }
    this.pending.add(threadId);
    try {
      this.set(threadId, await this.client.links(threadId, refresh));
    } catch {
      // A thread whose links cannot be read shows none.
    } finally {
      this.pending.delete(threadId);
      const again = this.reread.get(threadId);
      this.reread.delete(threadId);
      if (again) await this.load(threadId, again);
    }
  }

  set(threadId: string, links: readonly ThreadPullRequestLink[]): void {
    this.entries.set(threadId, { at: this.now(), links });
    for (const listener of [...this.listeners]) listener();
  }

  dispose(): void {
    this.refresh.dispose();
    this.reread.clear();
    this.stop();
  }
}
