import { useEffect, useMemo, useSyncExternalStore } from "react";
import { errorMessage } from "tau";
import type { PullRequestClient } from "./pull-request-client.js";
import type { PullRequestLists } from "./protocol.js";
import { listAcrossMachines, useProjects, type ProjectsByMachine } from "./pull-request-lists.js";
import { buildInbox, openPulls } from "./inbox.js";
import { useLocalReviews, type LocalReviewsStore } from "./local-reviews-store.js";

/** The open requests the inbox reads, the same question the open list of All pull requests asks. */
const ASKING = { state: "open" as const, limit: 100 };
/** An answer this old is read again when the page or its sidebar mounts. */
const STALE_MS = 30_000;

export interface InboxPullsSnapshot {
  answer?: PullRequestLists;
  at?: number;
  loading: boolean;
  error?: string;
}

/**
 * The open requests of every project, shared by the inbox and its sidebar:
 * the cached answer at once, the hosts' after. A failed read keeps the last
 * answer and says why; the local rows never wait for it.
 */
export class InboxPullsStore {
  private snapshot: InboxPullsSnapshot = { loading: false };
  private readonly listeners = new Set<() => void>();
  private key = "";
  private asked = 0;

  constructor(private readonly client: PullRequestClient | undefined) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): InboxPullsSnapshot => this.snapshot;

  /** The cached answer for these machines' projects, without asking any host; the badge starts from it. */
  prime(machines: ProjectsByMachine): void {
    if (this.snapshot.answer || !this.client?.cache) return;
    const cached = this.client.cache.peek<PullRequestLists>("pr-list-many", { ...ASKING, workspaces: machines.get("")?.workspaces ?? [] });
    if (cached) this.set({ answer: cached.value });
  }

  /** Reads when the machines changed, the answer is stale, or `fresh` asks for it. */
  async load(machines: ProjectsByMachine, fresh = false, now = Date.now()): Promise<void> {
    const client = this.client;
    if (!client?.listMany) return;
    const key = JSON.stringify([...machines]);
    const current = key === this.key && (this.snapshot.loading || (this.snapshot.at !== undefined && now - this.snapshot.at < STALE_MS));
    if (current && !fresh) return;
    this.key = key;
    const request = ++this.asked;
    this.prime(machines);
    this.set({ loading: true });
    try {
      const answer = await listAcrossMachines(client, machines, ASKING);
      if (request === this.asked) this.set({ answer, at: Date.now(), loading: false, error: undefined });
    } catch (error) {
      if (request === this.asked) this.set({ at: Date.now(), loading: false, error: errorMessage(error) });
    }
  }

  private set(patch: Partial<InboxPullsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}

/** The store's snapshot; `read` asks the hosts when the projects or their machines change, else only the cache is used. */
export function useInboxPulls(store: InboxPullsStore, read = true): InboxPullsSnapshot & ReturnType<typeof useProjects> {
  const projects = useProjects();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    if (read) void store.load(projects.machines);
    else store.prime(projects.machines);
  }, [store, projects.machines, read]);
  return { ...snapshot, ...projects };
}

/**
 * The inbox's rows, for the page, its sidebar and the page's badge alike: one
 * count for one thing. Without `read` (the badge) no host is asked; it counts
 * the cached requests and follows the page's read when that lands.
 */
export function useInboxRows(reviews: LocalReviewsStore, pulls: InboxPullsStore, read = true) {
  const local = useLocalReviews(reviews);
  const snapshot = useInboxPulls(pulls, read);
  const open = useMemo(() => openPulls(snapshot.answer), [snapshot.answer]);
  const sections = useMemo(() => buildInbox(local.reviews, open, (review) => reviews.latestRuns(review.path ?? "")), [local.reviews, open, reviews]);
  // Before the branches are read a request is not matched to its branch yet; no count beats a wrong one.
  const total = local.snapshot.answer ? sections.reduce((sum, section) => sum + section.items.length, 0) : 0;
  return { ...local, pulls: snapshot, sections, total };
}
