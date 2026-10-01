import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  mergeBranchIntoCheckout,
  previewBranchMerge,
  readBranchBase,
  runAgentGit,
  type AgentGitRunner,
  type BranchMergeOutcome,
  type BranchMergePreview,
} from "./agent-worktrees.js";
import { countUntrackedLines, readDefaultBranch } from "./workspace-git.js";
import { readConflictFiles, resolveTree, type ConflictFile, type HunkPick } from "./merge-picks.js";

/**
 * A thread's worktree branch as Review Kit's Reviews page reads it: what it
 * carries against the branch its main checkout has out, and what merging it
 * there would do. Read with `git merge-tree` only; nothing is touched.
 */
export interface ThreadBranch {
  /** The folder asked about, inside the linked worktree the branch is checked out in. */
  path: string;
  /** The repository's main checkout, where Merge lands. */
  root: string;
  branch: string;
  /** The branch the main checkout has out; absent when it is detached. */
  target?: string;
  tip: string;
  /** Commits on the branch the target lacks. */
  ahead: number;
  /** Commits on the target since the branch left it. */
  behind: number;
  files: number;
  added: number;
  removed: number;
  /** Changed files with their counts, the first `THREAD_BRANCH_PATHS`. */
  paths: Array<{ path: string; added: number; removed: number; uncommitted?: true }>;
  /** Files in the worktree not committed yet, counted in `files`, `added`, `removed` and `paths`; Merge takes commits only. */
  uncommitted: number;
  /** When the tip was committed, in ms. */
  committedAt?: number;
  /** The target already holds the branch's own commits, or their changes. */
  merged: boolean;
  /** Merged without its own commits: the same patches (cherry-pick, rebase, rewritten history) or the same tree (squash). */
  mergedBy?: "patches" | "tree";
  /** The repository's default branch, when a local branch has that name. */
  defaultBranch?: string;
  /** Files `merge-tree` reports conflicted. */
  conflicts: string[];
  /** Why no merge can be checked (a detached main checkout, the same branch). */
  unavailable?: string;
}

export const THREAD_BRANCH_PATHS = 200;

interface WorktreeEntry { path: string; branch?: string }

function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      entries.push(current);
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return entries;
}

function parseNumstat(output: string): ThreadBranch["paths"] {
  const paths: ThreadBranch["paths"] = [];
  for (const line of output.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/u.exec(line);
    if (match) paths.push({ path: match[3]!, added: Number(match[1]) || 0, removed: Number(match[2]) || 0 });
  }
  return paths;
}

const totals = (paths: ThreadBranch["paths"]) => ({
  files: paths.length,
  added: paths.reduce((sum, entry) => sum + entry.added, 0),
  removed: paths.reduce((sum, entry) => sum + entry.removed, 0),
  paths: paths.slice(0, THREAD_BRANCH_PATHS),
});

const PENDING_STATS = 500;

/**
 * The worktree's own files not committed yet: tracked changes against HEAD
 * and untracked files, with lines. Past `PENDING_STATS` files only count.
 */
async function readPending(top: string, runGit: AgentGitRunner): Promise<{ total: number; paths: ThreadBranch["paths"] }> {
  const [tracked, others] = await Promise.all([
    runGit(top, ["diff", "--numstat", "--no-renames", "HEAD"]).catch(() => ""),
    runGit(top, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""),
  ]);
  const paths: ThreadBranch["paths"] = parseNumstat(tracked).map((entry) => ({ ...entry, uncommitted: true as const }));
  const seen = new Set(paths.map((entry) => entry.path));
  const untracked = others.split("\n").map((line) => line.trim()).filter((line) => line && !seen.has(line));
  const counted = await Promise.all(untracked.slice(0, PENDING_STATS).map(async (path) => ({ path, added: await countUntrackedLines(top, path), removed: 0, uncommitted: true as const })));
  return { total: paths.length + untracked.length, paths: [...paths, ...counted] };
}

/** The branch's committed changes plus the worktree's uncommitted ones; a file in both keeps its committed counts. */
function withPending(committed: ThreadBranch["paths"], pending: ThreadBranch["paths"], total: number) {
  const known = new Set(committed.map((entry) => entry.path));
  const extra = pending.filter((entry) => !known.has(entry.path));
  const all = [...committed, ...extra];
  return {
    files: committed.length + (total - pending.length) + extra.length,
    added: all.reduce((sum, entry) => sum + entry.added, 0),
    removed: all.reduce((sum, entry) => sum + entry.removed, 0),
    paths: all.slice(0, THREAD_BRANCH_PATHS),
  };
}

const real = (path: string) => realpath(path).catch(() => resolve(path));

/**
 * Where the branch started, when it has moved since: its oldest reflog entry
 * is where it was created, and a tip still there is a branch that never did
 * anything, not a merged one. An agent's branch records that commit as its
 * base as well.
 */
async function ownStart(root: string, branch: string, tip: string, runGit: AgentGitRunner): Promise<string | undefined> {
  const created = (await runGit(root, ["reflog", "show", "--format=%H", `refs/heads/${branch}`, "--"]).catch(() => "")).trim().split("\n").filter(Boolean).at(-1);
  const base = created ?? await readBranchBase(root, branch, runGit);
  return base && /^[0-9a-f]{40,64}$/u.test(base) && base !== tip ? base : undefined;
}

/** `git cherry` answers by tip and target; both are commits, so an answer never goes stale. */
const cherries = new Map<string, boolean>();
const CHERRIES = 500;

/**
 * Whether the target holds the branch's changes under other commits: the
 * merge would leave the target's tree as it is, or every commit's patch is
 * already there.
 */
async function alreadyIn(root: string, head: string, tip: string, preview: BranchMergePreview, runGit: AgentGitRunner): Promise<ThreadBranch["mergedBy"]> {
  if (preview.conflicts.length === 0 && preview.tree === (await runGit(root, ["rev-parse", `${head}^{tree}`])).trim()) return "tree";
  const key = `${head}\0${tip}`;
  let same = cherries.get(key);
  if (same === undefined) {
    const lines = (await runGit(root, ["cherry", head, tip]).catch(() => "")).split("\n").filter(Boolean);
    same = lines.length > 0 && lines.every((line) => line.startsWith("-"));
    if (cherries.size >= CHERRIES) cherries.delete(cherries.keys().next().value!);
    cherries.set(key, same);
  }
  return same ? "patches" : undefined;
}

async function defaultBranchOf(root: string, runGit: AgentGitRunner): Promise<string | undefined> {
  const name = await readDefaultBranch(root, (cwd, args) => runGit(cwd, args)).catch(() => undefined);
  const known = name && await runGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).then(() => true, () => false);
  return known ? name : undefined;
}

/** Whether `path` is inside a linked worktree: its git dir is not the repository's common one. */
export async function isLinkedWorktree(path: string, runGit: AgentGitRunner = runAgentGit): Promise<boolean> {
  const [gitDir, commonDir] = (await runGit(path, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]).catch(() => "")).trim().split("\n");
  return Boolean(gitDir && commonDir && resolve(gitDir) !== resolve(commonDir));
}

/** One worktree's branch against its main checkout; undefined for a main checkout or a detached worktree. */
export async function readThreadBranch(path: string, runGit: AgentGitRunner = runAgentGit): Promise<ThreadBranch | undefined> {
  const entries = parseWorktreeList(await runGit(path, ["worktree", "list", "--porcelain"]));
  const main = entries[0];
  const top = await real((await runGit(path, ["rev-parse", "--show-toplevel"])).trim());
  const reals = await Promise.all(entries.map((entry) => real(entry.path)));
  const own = entries[reals.indexOf(top)];
  if (!main || !own?.branch || reals[0] === top) return undefined;
  const branch = own.branch;
  const root = main.path;
  const tip = (await runGit(root, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])).trim();
  const pending = await readPending(top, runGit);
  const uncommitted = pending.total;
  const committedAt = Number((await runGit(root, ["log", "-1", "--format=%ct", tip]).catch(() => "")).trim()) * 1000 || undefined;
  const base = { path: resolve(path), root, branch, tip, uncommitted, ...(committedAt ? { committedAt } : {}) };
  const empty = { ahead: 0, behind: 0, files: 0, added: 0, removed: 0, paths: [], merged: false, conflicts: [] };
  const target = main.branch;
  if (!target) return { ...base, ...empty, unavailable: "The main checkout is not on a branch." };
  if (target === branch) return { ...base, target, ...empty, unavailable: "The main checkout has this branch out." };
  const defaultBranch = await defaultBranchOf(root, runGit);
  const into = { target, ...(defaultBranch ? { defaultBranch } : {}) };

  const head = (await runGit(root, ["rev-parse", "--verify", "HEAD"])).trim();
  const counts = (await runGit(root, ["rev-list", "--left-right", "--count", `${head}...${tip}`])).trim().split(/\s+/u).map(Number);
  const [behind = 0, ahead = 0] = counts;
  if (ahead === 0) {
    // Nothing the target lacks: either merged, with what it carried from where it started, or a branch that never did anything.
    const start = await ownStart(root, branch, tip, runGit);
    if (!start) return { ...base, ...into, ...empty, behind, ...withPending([], pending.paths, pending.total) };
    const paths = parseNumstat(await runGit(root, ["diff", "--numstat", "--no-renames", start, tip]).catch(() => ""));
    return { ...base, ...into, ...empty, behind, merged: true, ...totals(paths) };
  }
  const forkPoint = (await runGit(root, ["merge-base", head, tip])).trim();
  const paths = parseNumstat(await runGit(root, ["diff", "--numstat", "--no-renames", forkPoint, tip]));
  const preview = await previewBranchMerge(root, tip, runGit);
  const mergedBy = preview.merged ? undefined : await alreadyIn(root, head, tip, preview, runGit);
  const merged = preview.merged || Boolean(mergedBy);
  return {
    ...base,
    ...into,
    ahead,
    behind,
    ...(merged ? totals(paths) : withPending(paths, pending.paths, pending.total)),
    merged,
    conflicts: mergedBy ? [] : preview.conflicts,
    ...(mergedBy ? { mergedBy } : {}),
  };
}

/**
 * Several worktrees at once; one that cannot be read is left out, and a main
 * checkout too. `plain` remembers the folders that are no linked worktree, so
 * a later read asks Git once per worktree only; it is the caller's to expire.
 */
export async function readThreadBranches(paths: readonly string[], runGit: AgentGitRunner = runAgentGit, plain?: Set<string>): Promise<ThreadBranch[]> {
  const read = await Promise.all([...new Set(paths.map((path) => resolve(path)))].map(async (path) => {
    if (plain?.has(path)) return undefined;
    if (!(await isLinkedWorktree(path, runGit))) {
      plain?.add(path);
      return undefined;
    }
    return readThreadBranch(path, runGit).catch(() => undefined);
  }));
  return read.filter((entry): entry is ThreadBranch => Boolean(entry));
}

export interface ThreadBranchMerge extends BranchMergeOutcome {
  into: string;
  root: string;
}

/**
 * Merges a thread's worktree branch into its main checkout: `merge-tree`
 * first, then `merge --no-ff` (`mergeBranchIntoCheckout`). Refused when the
 * tip moved since `expectedTip` was read, and while the worktree holds work
 * not committed yet, which a merge would leave behind.
 */
export async function mergeThreadBranch(path: string, options: { expectedTip?: string; picks?: Record<string, HunkPick[]>; runGit?: AgentGitRunner } = {}): Promise<ThreadBranchMerge> {
  const runGit = options.runGit ?? runAgentGit;
  const branch = await readThreadBranch(path, runGit);
  if (!branch) throw new Error("This folder is no worktree on a branch of its own.");
  if (!branch.target || branch.unavailable) throw new Error(branch.unavailable ?? "The main checkout is not on a branch.");
  if (options.expectedTip && options.expectedTip !== branch.tip) throw new Error(`${branch.branch} moved since it was read; look at it again before merging.`);
  if (branch.uncommitted > 0) throw new Error(`${branch.branch} has ${branch.uncommitted} file${branch.uncommitted === 1 ? "" : "s"} not committed; ask the thread to commit first.`);
  // A spawned thread's base is a state commit carrying the checkout's work of then; a ref like origin/main is not.
  const recorded = await readBranchBase(branch.root, branch.branch, runGit);
  const base = recorded && /^[0-9a-f]{40,64}$/u.test(recorded) ? recorded : undefined;
  const picks = options.picks;
  const resolved = picks ? { resolve: (tree: string, conflicts: readonly string[]) => resolveTree(branch.root, tree, conflicts, picks, runGit) } : {};
  const outcome = await mergeBranchIntoCheckout({ cwd: branch.root, branch: branch.branch, ...(base ? { base } : {}), ...resolved, runGit });
  return { ...outcome, into: branch.target, root: branch.root };
}

/** The hunks a merge of the thread's branch would conflict in, for picks per hunk. */
export async function readThreadConflicts(path: string, runGit: AgentGitRunner = runAgentGit): Promise<{ tip: string; files: ConflictFile[] }> {
  const branch = await readThreadBranch(path, runGit);
  if (!branch?.target || branch.unavailable) throw new Error(branch?.unavailable ?? "This folder is no worktree on a branch of its own.");
  const preview = await previewBranchMerge(branch.root, branch.tip, runGit);
  return { tip: branch.tip, files: await readConflictFiles(branch.root, preview.tree, preview.conflicts, runGit) };
}

/**
 * Removes a merged thread branch's worktree, then the branch. Refused while
 * the target lacks its work (unless its pull request merged elsewhere) or the
 * worktree holds anything not committed.
 */
export async function removeThreadBranch(path: string, options: { requestMerged?: boolean; runGit?: AgentGitRunner } = {}): Promise<{ branch: string; root: string }> {
  const runGit = options.runGit ?? runAgentGit;
  const branch = await readThreadBranch(path, runGit);
  if (!branch) throw new Error("This folder is no worktree on a branch of its own.");
  if (!branch.merged && !options.requestMerged) throw new Error(`${branch.target ?? "The main checkout"} does not hold ${branch.branch} yet; nothing was removed.`);
  if (branch.uncommitted > 0) throw new Error(`${branch.branch} has ${branch.uncommitted} file${branch.uncommitted === 1 ? "" : "s"} not committed; nothing was removed.`);
  const top = (await runGit(path, ["rev-parse", "--show-toplevel"])).trim();
  await runGit(branch.root, ["worktree", "remove", top]);
  await runGit(branch.root, ["branch", "-D", branch.branch]);
  return { branch: branch.branch, root: branch.root };
}
