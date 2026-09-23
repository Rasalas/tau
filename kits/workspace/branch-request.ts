import type { UiReviewRequest } from "tau/host-extension";
import { primaryRemote, runGitCommand, type GitRunner } from "./workspace-git.js";

/** Review Kit's `branch-request`: the request of a branch, asked of the provider its remote belongs to. */
export type AskBranchRequest = (input: { root: string; branch: string; remote: string; fresh?: boolean }) => Promise<unknown>;

const isRequest = (value: unknown): value is UiReviewRequest => {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return typeof raw.number === "number" && typeof raw.url === "string" && typeof raw.baseRef === "string";
};

/**
 * The pull or merge request of a checkout's branch. Git names the branch and
 * the remote; Review Kit knows the hosts, so without it (or without a branch,
 * a remote or a request) the answer is undefined and the caller goes by Git.
 */
export function createBranchRequests(ask: AskBranchRequest, runGit: GitRunner = runGitCommand) {
  return async (cwd: string, options: { fresh?: boolean } = {}): Promise<UiReviewRequest | undefined> => {
    const branch = (await runGit(cwd, ["branch", "--show-current"]).catch(() => "")).trim();
    if (!branch) return undefined;
    const remote = await primaryRemote(cwd, runGit);
    const url = remote ? (await runGit(cwd, ["remote", "get-url", remote]).catch(() => "")).trim() : "";
    if (!url) return undefined;
    try {
      const answer = await ask({ root: cwd, branch, remote: url, ...(options.fresh ? { fresh: true } : {}) });
      return isRequest(answer) ? answer : undefined;
    } catch {
      return undefined;
    }
  };
}
