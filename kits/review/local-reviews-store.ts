import { useEffect, useMemo, useSyncExternalStore } from "react";
import { errorMessage, useThreadStore, type HostExtensionClient, type ThreadStore, type ThreadStoreSnapshot } from "tau";
import {
  countReviews,
  deriveReviews,
  LOCAL_REVIEWS_EVENT,
  type LocalReview,
  type LocalReviewsAnswer,
  type ReviewChecks,
  type ReviewCounts,
  type ThreadBranchMerge,
} from "./local-reviews.js";

/** Project Scripts' run, mirrored: the part the Checks column reads. */
interface ScriptRun { id: string; scriptId: string; name?: string; directory: string; trigger?: string; status: "running" | "succeeded" | "failed" | "stopped"; startedAt: number }

// A worktree's setup run is no check of the work.
const isRun = (value: unknown): value is ScriptRun => Boolean(value && typeof (value as ScriptRun).id === "string" && typeof (value as ScriptRun).directory === "string" && (value as ScriptRun).trigger !== "worktree-create");

/** One script's last run in a review's worktree: a check. */
export interface ReviewRun { name: string; status: ScriptRun["status"]; at: number }

export interface LocalReviewsSnapshot {
  answer?: LocalReviewsAnswer;
  loading: boolean;
  error?: string;
  runs: readonly ScriptRun[];
}

/** The host's answer with every list a list, whatever an older or a stand-in host sent. */
function decodeAnswer(value: unknown): LocalReviewsAnswer {
  const fields = value && typeof value === "object" ? value as Partial<LocalReviewsAnswer> : {};
  return {
    branches: Array.isArray(fields.branches) ? fields.branches : [],
    asks: fields.asks && typeof fields.asks === "object" && !Array.isArray(fields.asks) ? fields.asks : {},
    merged: Array.isArray(fields.merged) ? fields.merged : [],
  };
}

/** What the thread said last, and its prompts by their first line. */
export interface ReviewSummary { summary?: string; turns?: number; prompts?: string[] }

/** A thread's end is followed by its commit; the read waits a moment for both. */
const SETTLE_MS = 800;

/**
 * The window's copy of the host's answer: read when the set of finished
 * threads changes, when the host says an ask or a merge changed the book,
 * and when the page opens. The sidebar's badge and the page share it.
 */
export class LocalReviewsStore {
  private snapshot: LocalReviewsSnapshot = { loading: false, runs: [] };
  private readonly listeners = new Set<() => void>();
  private workspaces: string[] = [];
  private key = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reading: Promise<void> | undefined;
  private again = false;
  private readonly stops: Array<() => void> = [];

  constructor(private readonly host: HostExtensionClient, private readonly scripts?: HostExtensionClient) {
    this.stops.push(host.onEvent(LOCAL_REVIEWS_EVENT, () => { void this.refresh(); }));
    if (scripts) {
      this.stops.push(scripts.onEvent("run", (payload) => {
        if (!isRun(payload)) return;
        this.set({ runs: [...this.snapshot.runs.filter((run) => run.id !== payload.id), payload] });
      }));
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): LocalReviewsSnapshot => this.snapshot;

  /** Names the threads' workspaces and what is busy; a change reads again after a moment. */
  follow(workspaces: readonly string[], key: string): void {
    if (key === this.key) return;
    this.key = key;
    this.workspaces = [...workspaces];
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, this.snapshot.answer ? SETTLE_MS : 0);
  }

  async refresh(): Promise<void> {
    if (this.reading) { this.again = true; return this.reading; }
    this.set({ loading: true });
    this.reading = (async () => {
      try {
        const [answer] = await Promise.all([
          this.host.invoke("local-reviews", { workspaces: this.workspaces }).then(decodeAnswer),
          this.readRuns(),
        ]);
        this.set({ answer, loading: false, error: undefined });
      } catch (error) {
        this.set({ loading: false, error: errorMessage(error) });
      } finally {
        this.reading = undefined;
        if (this.again) { this.again = false; void this.refresh(); }
      }
    })();
    return this.reading;
  }

  private async readRuns(): Promise<void> {
    if (!this.scripts) return;
    try {
      const runs = await this.scripts.invoke("runs") as unknown[];
      this.set({ runs: (Array.isArray(runs) ? runs : []).filter(isRun) });
    } catch {
      // Without Project Scripts every row reads "no checks".
    }
  }

  /** The last run of each script in a worktree. */
  latestRuns = (path: string): ReviewRun[] => {
    const latest = new Map<string, ScriptRun>();
    for (const run of this.snapshot.runs) {
      if (run.directory !== path) continue;
      const held = latest.get(run.scriptId);
      if (!held || held.startedAt <= run.startedAt) latest.set(run.scriptId, run);
    }
    return [...latest.values()].map((run) => ({ name: run.name ?? run.scriptId, status: run.status, at: run.startedAt }));
  };

  /** The last run of each script in a worktree, summed. */
  checks = (path: string): ReviewChecks | undefined => {
    const runs = this.latestRuns(path);
    if (runs.length === 0) return undefined;
    return {
      passed: runs.filter((run) => run.status === "succeeded").length,
      failed: runs.filter((run) => run.status === "failed").length,
      running: runs.filter((run) => run.status === "running").length,
      names: runs.map((run) => run.name),
    };
  };

  async merge(review: LocalReview): Promise<ThreadBranchMerge> {
    return await this.host.invoke("local-review-merge", {
      ...(review.remote ? { link: review.remote.link, branch: review.branch, target: review.target } : { workspace: review.workspace }),
      tip: review.tip,
      rootWorkspace: review.project.key,
      threadId: review.threadId,
      title: review.title,
      project: review.project.name,
      files: review.files,
      added: review.added,
      removed: review.removed,
      ...(review.costUsd !== undefined ? { costUsd: review.costUsd } : {}),
      ...(review.modelProvider ? { modelProvider: review.modelProvider } : {}),
      ...(review.model ? { model: review.model } : {}),
    }) as ThreadBranchMerge;
  }

  async ask(review: LocalReview, kind: "rebase" | "note", text?: string): Promise<void> {
    await this.host.invoke("local-review-ask", {
      kind,
      ...(review.remote ? { link: review.remote.link } : { threadId: review.threadId }),
      root: review.root,
      branch: review.branch,
      target: review.target,
      tip: review.tip,
      conflicts: review.conflicts,
      ...(text ? { text } : {}),
    });
  }

  /** A merged branch's worktree and the branch go; the host checks it is merged. */
  async remove(review: LocalReview): Promise<void> {
    await this.host.invoke("local-review-remove", { workspace: review.workspace });
  }

  async withdraw(review: LocalReview): Promise<void> {
    await this.host.invoke("local-review-withdraw", { root: review.root, branch: review.branch, ...(review.remote ? { link: review.remote.link } : {}) });
  }

  summary(review: LocalReview): Promise<ReviewSummary> {
    // The thread there keeps its own history; what is here is the branch that came back.
    if (review.remote) return Promise.resolve({ summary: `Ran on ${review.remote.machine} and came back as \`${review.branch}\` here.` });
    return this.host.invoke("local-review-summary", { threadId: review.threadId, workspace: review.workspace, target: review.target }) as Promise<ReviewSummary>;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const stop of this.stops.splice(0)) stop();
  }

  private set(patch: Partial<LocalReviewsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}

/** The thread store, or none outside a workbench (a test of the foot alone). */
function useOptionalThreadStore(): ThreadStore | undefined {
  try { return useThreadStore(); } catch { return undefined; }
}

const EMPTY_THREADS: ThreadStoreSnapshot["threads"] = [];

/**
 * The reviews the window can show, from the store's answer and the threads the
 * window knows. It tells the store which workspaces to read and reads again
 * when a thread there finishes a turn.
 */
export function useLocalReviews(store: LocalReviewsStore): { reviews: LocalReview[]; counts: ReviewCounts; snapshot: LocalReviewsSnapshot } {
  const threads = useOptionalThreadStore();
  const threadSnapshot = useSyncExternalStore(threads?.subscribe ?? noSubscribe, threads?.getSnapshot ?? noSnapshot);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const list = threadSnapshot?.threads ?? EMPTY_THREADS;
  const busy = useMemo(() => new Set([...(threadSnapshot?.runningThreadIds ?? []), ...(threadSnapshot?.waitingThreadIds ?? [])]), [threadSnapshot?.runningThreadIds, threadSnapshot?.waitingThreadIds]);
  const workspaces = useMemo(() => [...new Set(list.flatMap((thread) => thread.workspaceId ? [thread.workspaceId] : []))].sort(), [list]);
  // Reads again when a workspace arrives, or a thread in a worktree starts or ends a turn; others cost nothing.
  const worktrees = useMemo(() => new Set(snapshot.answer?.branches.map((branch) => branch.workspace) ?? []), [snapshot.answer]);
  const turning = list.filter((thread) => busy.has(thread.id) && thread.workspaceId && worktrees.has(thread.workspaceId)).map((thread) => thread.id).sort();
  const key = `${workspaces.join("|")}#${turning.join("|")}`;
  useEffect(() => { store.follow(workspaces, key); }, [store, workspaces, key]);
  return useMemo(() => {
    const reviews = snapshot.answer ? deriveReviews({ answer: snapshot.answer, threads: list, projects: threadSnapshot?.projects ?? [], busy, checks: store.checks }) : [];
    return { reviews, counts: countReviews(reviews), snapshot };
  }, [snapshot, list, threadSnapshot?.projects, busy, store]);
}

const noSubscribe = () => () => undefined;
const noSnapshot = (): ThreadStoreSnapshot | undefined => undefined;
