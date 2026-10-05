import { branchReviewTargetConfigKey, runAgentGit, type AgentGitRunner } from "./agent-worktrees.js";
import { readDefaultBranch } from "./workspace-git.js";

/** Proof of publication, not a reason to settle: remote-tracking refs alone can be stale. */
export async function publishedHead(path: string, run: AgentGitRunner = runAgentGit): Promise<{ commit: string; target: string; remote: string } | undefined> {
  if ((await run(path, ["status", "--porcelain", "--untracked-files=normal"])).trim()) return undefined;
  const branch = (await run(path, ["symbolic-ref", "--short", "HEAD"])).trim();
  const saved = (await run(path, ["config", "--get", branchReviewTargetConfigKey(branch)]).catch(() => "")).trim();
  const base = saved || await readDefaultBranch(path, (cwd, args) => run(cwd, args));
  const commit = (await run(path, ["rev-parse", "HEAD"])).trim();
  const ref = `refs/heads/${base}`;
  const remoteTip = (await run(path, ["ls-remote", "--exit-code", "origin", ref])).trim().split(/\s+/u)[0];
  if (!remoteTip || !/^[a-f0-9]{40,64}$/u.test(remoteTip)) return undefined;
  // When the remote advanced beyond our known objects, fail closed until the next fetch.
  if (commit !== remoteTip) {
    try { await run(path, ["merge-base", "--is-ancestor", commit, remoteTip]); } catch { return undefined; }
  }
  const remote = (await run(path, ["remote", "get-url", "origin"])).trim();
  return { commit, target: `origin/${base}`, remote };
}
