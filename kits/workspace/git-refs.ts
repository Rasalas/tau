import { runGitCommand as git, type GitRunner } from "./git-command.js";

/** The first candidate that names a commit in this checkout, e.g. `origin/main` before `main`. */
export async function firstExistingRef(cwd: string, candidates: string[], runGit: GitRunner = git): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await runGit(cwd, ["rev-parse", "--verify", "--quiet", candidate]).then(() => true).catch(() => false)) return candidate;
  }
  return undefined;
}

/** Defers to git's own rules rather than guessing at them. */
export async function assertValidBranchName(cwd: string, name: string, runGit: GitRunner = git): Promise<void> {
  const invalid = new Error(`"${name}" is not a valid branch name.`);
  if (name.startsWith("-") || /[\s~^:?*[\\]/u.test(name)) throw invalid;
  try {
    await runGit(cwd, ["check-ref-format", "--branch", name]);
  } catch {
    throw invalid;
  }
}

/**
 * The branch a new worktree starts from when nobody named one: what
 * `origin/HEAD` points at, then the usual main lines, then this checkout's own
 * branch. A repository without any of them still answers, with `HEAD`.
 */
export async function resolveDefaultBaseRef(cwd: string, runGit: GitRunner = git): Promise<string> {
  const originHead = (await runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  if (originHead) return originHead;
  const known = await firstExistingRef(cwd, ["origin/main", "origin/master", "main", "master"], runGit);
  if (known) return known;
  const branch = (await runGit(cwd, ["branch", "--show-current"]).catch(() => "")).trim();
  return branch || "HEAD";
}

/**
 * The branch a project calls its main line, by name: the one `origin/HEAD`
 * points at, else `init.defaultBranch`, else `main`.
 */
export async function readDefaultBranch(cwd: string, runGit: GitRunner = git): Promise<string> {
  const originHead = (await runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  if (originHead) return originHead.replace(/^origin\//u, "");
  const configured = (await runGit(cwd, ["config", "--get", "init.defaultBranch"]).catch(() => "")).trim();
  return configured || "main";
}
