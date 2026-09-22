import type { HostExtensionClient } from "tau";
import type { PullRequestCheck, PullRequestDetail, PullRequestFiles, PullRequestThread, PullRequestViewedState } from "./protocol.js";

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
  };
}
