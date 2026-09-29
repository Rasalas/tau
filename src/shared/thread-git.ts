/**
 * The Git facts of a thread that a package of its own may read (K112): the
 * branch Workspace Kit follows and the pull requests Review Kit links. Two
 * services, each provided by the kit that knows it; a package reaches them
 * with `context.useService` and gets nothing while that kit is off.
 */

/** Workspace Kit's service: the branch of the thread or draft on screen. */
export const THREAD_BRANCH_SERVICE = "tau.workspace/branch";

export interface ThreadBranch {
  /** The project folder the thread works in; a worktree's own folder for a thread in one. */
  cwd: string;
  isRepo: boolean;
  /** The checked-out branch; undefined on a detached HEAD and outside a repository. */
  branch?: string;
  /** The branch it tracks, `origin/main`, when it tracks one. */
  upstream?: string;
}

export interface ThreadBranchService {
  /** As Workspace Kit last read it; the same object until something changes. Undefined with no project on screen. */
  current(): ThreadBranch | undefined;
  subscribe(listener: () => void): () => void;
}

/** Review Kit's service: the pull or merge requests linked to a thread. */
export const THREAD_PULL_REQUESTS_SERVICE = "tau.review/pull-requests";

export interface ThreadPullRequest {
  url: string;
  number: number;
  /** The Git host, `github.com`, and the repository on it, `owner/name`. */
  host: string;
  repo: string;
  title?: string;
  state?: "open" | "closed" | "merged";
  draft?: boolean;
  /** The branch it merges, and the one it merges into. */
  headRef?: string;
  baseRef?: string;
}

export interface ThreadPullRequestsService {
  /**
   * The requests linked to a thread, as the window last read them; asking
   * reads them when it has not. The same array until they change.
   */
  forThread(sessionId: string): readonly ThreadPullRequest[];
  subscribe(listener: () => void): () => void;
}
