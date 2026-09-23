import type { HostExtensionClient } from "tau";
import {
  THREAD_LINKS_EVENT,
  type PendingReviewComment,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestFiles,
  type PullRequestLabel,
  type PullRequestList,
  type PullRequestListState,
  type PullRequestReviewEvent,
  type PullRequestThread,
  type PullRequestViewedState,
  type ThreadPullRequestLink,
} from "./protocol.js";

export interface PullRequestCommentInput {
  body: string;
  /** A reply to this thread. */
  threadId?: string;
  /** A new comment on this line of the diff. */
  path?: string;
  line?: number;
  side?: "new" | "old";
}

/** Review Kit's host commands for one request, typed. */
export interface PullRequestClient {
  view(url: string, fresh?: boolean): Promise<PullRequestDetail>;
  checks(url: string): Promise<PullRequestCheck[]>;
  threads(url: string, fresh?: boolean): Promise<PullRequestThread[]>;
  files(url: string, fresh?: boolean): Promise<PullRequestFiles>;
  comment(url: string, input: PullRequestCommentInput): Promise<void>;
  update(url: string, input: { title?: string; body?: string }): Promise<PullRequestDetail>;
  viewed(url: string, path: string, viewed: boolean): Promise<PullRequestViewedState>;
  review(url: string, input: { event: PullRequestReviewEvent; body: string; comments: readonly PendingReviewComment[] }): Promise<PullRequestDetail>;
  resolve(url: string, threadId: string, resolved: boolean): Promise<PullRequestThread[]>;
  editComment(url: string, comment: Pick<PullRequestComment, "id" | "kind">, body: string): Promise<void>;
  reviewers(url: string, change: { add?: string[]; remove?: string[] }): Promise<PullRequestDetail>;
  labels(url: string, change: { add?: string[]; remove?: string[] }): Promise<PullRequestDetail>;
  candidates(url: string): Promise<{ labels: PullRequestLabel[]; reviewers: string[] }>;
  list(input: { workspace?: string; state: PullRequestListState; limit: number; search?: string }): Promise<PullRequestList>;
  links(threadId: string, refresh?: boolean | "force"): Promise<ThreadPullRequestLink[]>;
  link(threadId: string, reference: string, cwd?: string): Promise<{ link: ThreadPullRequestLink; alreadyLinked: boolean }>;
  unlink(threadId: string, url: string): Promise<boolean>;
  onLinksChanged(listener: (threadId: string) => void): () => void;
}

export function pullRequestClient(host: HostExtensionClient): PullRequestClient {
  const read = (fresh?: boolean) => fresh ? { fresh: true } : {};
  return {
    view: (url, fresh) => host.invoke("pr-view", { url, ...read(fresh) }) as Promise<PullRequestDetail>,
    checks: (url) => host.invoke("pr-checks", { url }) as Promise<PullRequestCheck[]>,
    threads: (url, fresh) => host.invoke("pr-comments", { url, ...read(fresh) }) as Promise<PullRequestThread[]>,
    files: (url, fresh) => host.invoke("pr-files", { url, ...read(fresh) }) as Promise<PullRequestFiles>,
    comment: async (url, input) => { await host.invoke("pr-comment", { url, ...input }); },
    update: (url, input) => host.invoke("pr-update", { url, ...input }) as Promise<PullRequestDetail>,
    viewed: async (url, path, viewed) => ((await host.invoke("pr-viewed", { url, path, viewed })) as { viewed: PullRequestViewedState }).viewed,
    review: (url, input) => host.invoke("pr-review", { url, ...input }) as Promise<PullRequestDetail>,
    resolve: (url, threadId, resolved) => host.invoke("pr-resolve", { url, threadId, resolved }) as Promise<PullRequestThread[]>,
    editComment: async (url, comment, body) => { await host.invoke("pr-edit-comment", { url, id: comment.id, kind: comment.kind, body }); },
    reviewers: (url, change) => host.invoke("pr-reviewers", { url, ...change }) as Promise<PullRequestDetail>,
    labels: (url, change) => host.invoke("pr-labels", { url, ...change }) as Promise<PullRequestDetail>,
    candidates: (url) => host.invoke("pr-candidates", { url }) as Promise<{ labels: PullRequestLabel[]; reviewers: string[] }>,
    list: (input) => host.invoke("pr-list", input) as Promise<PullRequestList>,
    links: async (threadId, refresh) => {
      const links = await host.invoke("thread-links", { threadId, ...(refresh ? { refresh } : {}) });
      return Array.isArray(links) ? links as ThreadPullRequestLink[] : [];
    },
    link: (threadId, reference, cwd) => host.invoke("link-pr", { threadId, reference, ...(cwd ? { cwd } : {}) }) as Promise<{ link: ThreadPullRequestLink; alreadyLinked: boolean }>,
    unlink: async (threadId, url) => ((await host.invoke("unlink-pr", { threadId, url })) as { wasLinked: boolean }).wasLinked,
    onLinksChanged: (listener) => host.onEvent(THREAD_LINKS_EVENT, (payload) => {
      const threadId = (payload as { threadId?: unknown } | undefined)?.threadId;
      if (typeof threadId === "string") listener(threadId);
    }),
  };
}
