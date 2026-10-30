import { lstat, mkdir, realpath, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { UiRef, UiWorktree, UiWorktreeStatus, WorkspaceInfo } from "tau/host-extension";
import { runGitCommand as git, type GitRunner } from "./git-command.js";
import { assertValidBranchName, readDefaultBranch, resolveDefaultBaseRef } from "./git-refs.js";
import { readProjectGitState } from "./workspace-git.js";
import { parseWorktrees } from "./worktree-layout.js";
import {
  branchBaseConfigKey,
  branchReviewTargetConfigKey,
  branchTargetOfRef,
  prepareWorktreeParent,
  resolveWorktreeParent,
  worktreeParentOf,
  withRepositoryWorktreeMutation,
} from "./agent-worktrees.js";
import { readRepositoryIdentity } from "./repository-identity.js";

/** Where added worktrees live: Tau's central folder by default, or a configured location. */
export function worktreeParentFor(mainRoot: string, configured?: string): string {
  return resolveWorktreeParent(mainRoot, configured);
}

export function worktreeSlug(branch: string): string {
  return branch.replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "") || "worktree";
}

export const WORKTREE_CLEANUP_MIN_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

/** Cleanup stays a suggestion and fails closed when any safety fact is missing. */
export function isWorktreeCleanupCandidate(
  tree: UiWorktree,
  status: Omit<UiWorktreeStatus, "path" | "cleanupCandidate">,
  now = Date.now(),
): boolean {
  return !tree.isMain
    && !tree.isCurrent
    && status.isDirty === false
    && status.threadCount === 0
    && Boolean(status.upstream)
    && status.ahead === 0
    && status.lastCommitAt !== undefined
    && now - status.lastCommitAt >= WORKTREE_CLEANUP_MIN_AGE_MS
    && !status.inspectionError;
}

/**
 * Reads dirty state only on demand. Normal project refreshes remain one bounded
 * scan even when a repository has many linked worktrees.
 */
export async function readWorktreeStatuses(
  worktrees: readonly UiWorktree[],
  refs: readonly UiRef[],
  threadCwds: readonly string[],
  runGit: GitRunner = git,
  now = Date.now(),
): Promise<UiWorktreeStatus[]> {
  // The picker is the one place worth pruning: a worktree whose folder went
  // away is a row the user is about to act on.
  const main = worktrees.find((tree) => tree.isMain) ?? worktrees[0];
  if (main) await withRepositoryWorktreeMutation(main.path, runGit, () => runGit(main.path, ["worktree", "prune"])).catch(() => "");
  return Promise.all(worktrees.map(async (tree) => {
    const ref = refs.find((candidate) => candidate.name === tree.branch);
    const base = {
      upstream: ref?.upstream,
      ahead: ref?.ahead ?? 0,
      behind: ref?.behind ?? 0,
      threadCount: threadCwds.filter((path) => resolve(path) === resolve(tree.path)).length,
      lastCommitAt: ref?.lastCommitAt,
    };
    try {
      const status: Omit<UiWorktreeStatus, "path" | "cleanupCandidate"> = {
        ...base,
        isDirty: (await runGit(tree.path, ["status", "--porcelain", "-z"])).length > 0,
      };
      return { path: tree.path, ...status, cleanupCandidate: isWorktreeCleanupCandidate(tree, status, now) };
    } catch (error) {
      return {
        path: tree.path,
        ...base,
        ahead: base.ahead,
        behind: base.behind,
        cleanupCandidate: false,
        inspectionError: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

export interface WorktreeBase {
  /** `origin/main`, `main`, a tag — whatever names the base for a human. */
  ref: string;
  /** The commit the worktree is created at; empty in a repository without commits. */
  commit: string;
  /** The commit came from a freshly fetched remote-tracking ref. */
  fromOrigin: boolean;
  /** Why the resolved base is not the one that was asked for. */
  note?: string;
}

const REMOTE_PREFIX = /^([^/]+)\//u;

async function fetchWorktreeRemote(cwd: string, remote: string, runGit: GitRunner): Promise<void> {
  const fetch = () => runGit(cwd, ["fetch", "--prune", remote], 8 * 1024 * 1024);
  try {
    await fetch();
  } catch (error: unknown) {
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    const diagnostic = typeof stderr === "string" ? stderr : error instanceof Error ? error.message : String(error);
    const refConflict = /\bcannot lock ref\b|\bunable to update local ref\b/iu.test(diagnostic)
      || /\bfetching ref \S+ failed: (incorrect old value provided|reference already exists)\b/iu.test(diagnostic)
      || /\bunable to create [^\n]*\.lock['"]?: file exists\b/iu.test(diagnostic);
    if (!refConflict) throw error;
    // A concurrent fetch can finish updating the shared refs before the retry.
    await delay(75);
    await fetch();
  }
}

/**
 * Resolves the base of a new worktree: with "start from
 * origin" the remote is fetched and the worktree is created at that SHA, so a
 * stale local branch never becomes the starting point. A repository without the
 * remote branch falls back to the local base rather than failing.
 */
export async function resolveWorktreeBase(
  cwd: string,
  options: { requested?: string; startFromOrigin?: boolean } = {},
  runGit: GitRunner = git,
): Promise<WorktreeBase> {
  const requested = options.requested?.trim();
  // Unasked, a worktree starts from the project's main line, `origin/main` when origin is wanted.
  const base = requested || await readDefaultBranch(cwd, runGit);
  const remotes = (await runGit(cwd, ["remote"]).catch(() => ""))
    .split("\n")
    .map((remote) => remote.trim())
    .filter(Boolean);
  const named = REMOTE_PREFIX.exec(base)?.[1];
  const remote = named && remotes.includes(named) ? named : undefined;
  // Only a base that names a remote is fetched unasked; "start from origin"
  // additionally looks for the local base's remote-tracking ref.
  const tracking = !remote && options.startFromOrigin !== false && remotes.includes("origin")
    ? `origin/${base}`
    : undefined;
  // A base the caller named is fetched or the creation fails; the remote a
  // default base is only *hoped* to have must not break a picker that is
  // offline, so its fetch failure degrades to the local base.
  if (remote) await fetchWorktreeRemote(cwd, remote, runGit);
  let fetchError: string | undefined;
  if (tracking) {
    fetchError = await fetchWorktreeRemote(cwd, "origin", runGit)
      .then(() => undefined)
      .catch((error: unknown) => error instanceof Error ? error.message.split("\n")[0] : String(error));
  }
  const commitOf = async (ref: string) => (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "")).trim();
  if (tracking && !fetchError) {
    const remoteCommit = await commitOf(tracking);
    if (remoteCommit) return { ref: tracking, commit: remoteCommit, fromOrigin: true };
  }
  const resolved = await commitOf(base);
  if (!resolved && !requested) return resolveWorktreeBase(cwd, { requested: await resolveDefaultBaseRef(cwd, runGit), startFromOrigin: false }, runGit);
  if (!resolved) throw new Error(`The worktree base "${base}" does not exist.`);
  return {
    ref: base,
    commit: resolved,
    fromOrigin: Boolean(remote),
    ...(tracking ? { note: fetchError ? `origin is unreachable (${fetchError}); started from ${base}.` : `${tracking} does not exist; started from ${base}.` } : {}),
  };
}

const REMOTE_BASE_LIMIT = 500;

/** What "Based on" lists beside `base`: origin's other branches, latest first. */
export async function readBaseChoices(cwd: string, base: string, runGit: GitRunner = git): Promise<{ others: string[] }> {
  const listed = await runGit(cwd, ["for-each-ref", "--sort=-committerdate", `--count=${REMOTE_BASE_LIMIT}`, "--format=%(refname:short)", "refs/remotes/origin"]).catch(() => "");
  // `origin/HEAD` reads as plain `origin` in its short form.
  const others = listed.split("\n").map((ref) => ref.trim()).filter((ref) => ref.includes("/") && ref !== base && ref !== "origin/HEAD");
  return { others };
}

/**
 * Whether `cwd` is a linked worktree rather than a repository's main checkout.
 * A linked worktree's own git dir sits under the shared common dir; anything
 * that is not a repository at all is not a worktree.
 */
export async function isLinkedWorktree(cwd: string, runGit: GitRunner = git): Promise<boolean> {
  const identity = runGit === git ? await readRepositoryIdentity(cwd) : undefined;
  if (identity) return identity.gitDir !== identity.commonDir;
  const [gitDir, commonDir] = (await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]))
    .split("\n")
    .map((line) => line.trim());
  if (!gitDir || !commonDir) throw new Error(`${cwd} is not a Git repository.`);
  return resolve(cwd, gitDir) !== resolve(cwd, commonDir);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** The project list also withholds remembered worktrees after their folders have been removed. */
export async function isNestedProject(
  cwd: string,
  runGit: GitRunner = git,
  exists: (path: string) => Promise<boolean> = pathExists,
): Promise<boolean> {
  return !await exists(cwd) || isLinkedWorktree(cwd, runGit);
}

/** The main checkout a linked worktree was made from; undefined for any other folder. */
export async function mainCheckoutOf(cwd: string, runGit: GitRunner = git): Promise<string | undefined> {
  try {
    const identity = runGit === git ? await readRepositoryIdentity(cwd) : undefined;
    if (identity) return identity.gitDir !== identity.commonDir ? dirname(identity.commonDir) : undefined;
    if (!await isLinkedWorktree(cwd, runGit)) return undefined;
    const commonDir = (await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    return commonDir ? dirname(resolve(cwd, commonDir)) : undefined;
  } catch {
    return undefined;
  }
}

/** The repository's name, then the folder's path below the working tree root (`acme/apps/server`), so two folders of one repository differ. */
function nameWithinRepository(repository: string, root: string | undefined, folder: string): string {
  const below = root ? relativePath(root, folder) : "";
  if (!below || below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below)) return repository;
  return [repository, ...below.split(sep)].join("/");
}

/** Returns one stable project name for a repository and all of its linked worktrees; a folder below the working tree root adds its path. */
export async function repositoryDisplayName(cwd: string, runGit: GitRunner = git): Promise<string> {
  try {
    const identity = runGit === git ? await readRepositoryIdentity(cwd) : undefined;
    if (identity) return nameWithinRepository(basename(dirname(identity.commonDir)) || basename(cwd) || cwd, identity.root, identity.folder);
    const commonDir = (await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const repository = basename(dirname(resolve(cwd, commonDir))) || basename(cwd) || cwd;
    // Best effort: a bare repository has no working tree, and the plain name still stands.
    const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
    return nameWithinRepository(repository, root || undefined, await realpath(cwd).catch(() => resolve(cwd)));
  } catch {
    return basename(cwd) || cwd;
  }
}

export interface CreateWorktreeOptions {
  /** The base the user picked; the repository's default branch when absent. */
  baseRef?: string;
  /** Fetch and start from the remote-tracking commit; on by default. */
  startFromOrigin?: boolean;
  /** An automatically named thread must get a new branch and folder, even if the suggested name is taken. */
  uniqueBranch?: boolean;
  /** Told when a step begins, for a setup card that follows it. */
  onStep?(step: "fetch" | "checkout"): void;
}

/** Reserves a folder atomically, so simultaneous clients cannot claim the same generated name. */
async function addUniqueWorktree(cwd: string, suggested: string, parent: string, base: string, runGit: GitRunner): Promise<{ name: string; destination: string }> {
  const [branches, worktrees] = await Promise.all([
    runGit(cwd, ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"]),
    runGit(cwd, ["worktree", "list", "--porcelain", "-z"]),
  ]);
  const taken = new Set(branches.trim().split("\n"));
  const registered = new Set(parseWorktrees(worktrees, cwd).map((tree) => resolve(tree.path)));
  for (let suffix = 1; suffix <= 1000; suffix += 1) {
    const name = suffix === 1 ? suggested : `${suggested}-${suffix}`;
    const destination = join(parent, worktreeSlug(name));
    if (taken.has(name) || registered.has(resolve(destination))) continue;
    try { await mkdir(destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await runGit(cwd, ["worktree", "add", "-b", name, destination, base]);
      return { name, destination };
    } catch (error) {
      // Only remove our empty reservation. Git may have populated the folder before failing.
      await rmdir(destination).catch(() => undefined);
      if (!/a branch named .+ already exists/u.test(error instanceof Error ? error.message : String(error))) throw error;
      const exists = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).catch(() => "");
      if (!exists.trim()) throw error;
      taken.add(name);
    }
  }
  throw new Error(`No available worktree name for ${suggested}.`);
}

/** Creates a branch and a worktree for it, and returns the new worktree path. */
export async function createWorktree(
  cwd: string,
  branch: string,
  options: CreateWorktreeOptions = {},
  readWorkspace: (cwd: string) => Promise<WorkspaceInfo> = async (path) => (await readProjectGitState(path)).workspace,
  runGit: GitRunner = git,
): Promise<string> {
  let name = branch.trim();
  if (!name) throw new Error("A branch name is required.");
  await assertValidBranchName(cwd, name, runGit);
  const info = await readWorkspace(cwd);
  if (!info.isRepo) throw new Error("This workspace is not a Git repository.");

  const existing = options.uniqueBranch ? undefined : info.refs.find((ref) => ref.name === name);
  if (existing?.worktreePath) throw new Error(`${name} is already checked out in a worktree.`);

  let destination = join(info.worktreeParent, worktreeSlug(name));
  const mainPath = info.worktrees.find((tree) => tree.isMain)?.path ?? info.root;
  const mainRoot = await realpath(mainPath).catch(() => mainPath);
  await prepareWorktreeParent(info.worktreeParent, { defaultParent: resolveWorktreeParent(mainRoot) });
  if (existing) {
    options.onStep?.("checkout");
    await withRepositoryWorktreeMutation(cwd, runGit, () => runGit(cwd, ["worktree", "add", destination, name]));
    return destination;
  }
  options.onStep?.("fetch");
  const base = await resolveWorktreeBase(cwd, {
    ...(options.baseRef ? { requested: options.baseRef } : {}),
    ...(options.startFromOrigin === undefined ? {} : { startFromOrigin: options.startFromOrigin }),
  }, runGit);
  // The commit, not the ref: a worktree started at `origin/main` would follow
  // that ref's next move, and the base recorded below would stop describing it.
  return withRepositoryWorktreeMutation(cwd, runGit, async () => {
    options.onStep?.("checkout");
    if (options.uniqueBranch) {
      ({ name, destination } = await addUniqueWorktree(cwd, name, info.worktreeParent, base.commit || base.ref, runGit));
    } else {
      await runGit(cwd, ["worktree", "add", "-b", name, destination, base.commit || base.ref]);
    }
    await runGit(cwd, ["config", branchBaseConfigKey(name), base.ref]).catch(() => "");
    // A remote-tracking ref names the same destination branch on its remote.
    const target = await branchTargetOfRef(cwd, base.ref, runGit);
    if (target) await runGit(cwd, ["config", branchReviewTargetConfigKey(name), target]);
    return destination;
  });
}

/** Removes a linked worktree; destructive flags require the caller's confirmation. */
export async function removeWorktree(
  cwd: string,
  worktreePath: string,
  options: { branch?: string; force?: boolean; forceBranch?: boolean } = {},
  runGit: GitRunner = git,
): Promise<void> {
  return withRepositoryWorktreeMutation(cwd, runGit, async () => {
    await runGit(cwd, ["worktree", "remove", ...(options.force ? ["--force"] : []), worktreePath]).catch(async (error: unknown) => {
      // A worktree whose directory is already gone is removed by pruning it.
      await runGit(cwd, ["worktree", "prune"]);
      const still = await runGit(cwd, ["worktree", "list", "--porcelain", "-z"]);
      if (parseWorktrees(still, cwd).some((tree) => tree.path === worktreePath)) throw error;
    });
    // Git keeps an unmerged branch when deletion was not explicitly forced.
    if (options.branch) await runGit(cwd, ["branch", options.forceBranch ? "-D" : "-d", "--", options.branch]).catch(() => "");
  });
}

/**
 * The worktree a thread expects, recreated silently when its directory
 * vanished: a missing folder is an accident, not a decision.
 */
export async function ensureWorktree(
  cwd: string,
  worktreePath: string,
  branch: string | undefined,
  runGit: GitRunner = git,
  approvedParent?: string,
): Promise<boolean> {
  if (await stat(worktreePath).then((entry) => entry.isDirectory()).catch(() => false)) return false;
  if (!branch) throw new Error(`${worktreePath} is gone and no branch names what it held.`);
  return withRepositoryWorktreeMutation(cwd, runGit, async () => {
    if (await stat(worktreePath).then((entry) => entry.isDirectory()).catch(() => false)) return false;
    await runGit(cwd, ["worktree", "prune"]);
    const defaultParent = process.platform === "linux"
      ? await worktreeParentOf(cwd, (path, args) => runGit(path, args), "") : undefined;
    await prepareWorktreeParent(dirname(worktreePath), { approvedParent, defaultParent });
    await runGit(cwd, ["worktree", "add", worktreePath, branch]);
    return true;
  });
}

/**
 * Resolves a ref to a workspace path. A ref already held by a worktree is opened
 * there; otherwise it is checked out in place, which requires a clean tree.
 */

export async function resolveRefTarget(
  cwd: string,
  ref: string,
  readWorkspace: (cwd: string) => Promise<WorkspaceInfo> = async (path) => (await readProjectGitState(path)).workspace,
): Promise<string> {
  const info = await readWorkspace(cwd);
  if (!info.isRepo) throw new Error("This workspace is not a Git repository.");

  const target = info.refs.find((entry) => entry.name === ref);
  if (target?.worktreePath) return target.worktreePath;
  if (info.isDirty) {
    throw new Error(
      `${cwd} has uncommitted changes. Commit them, or create a worktree for ${ref} instead.`,
    );
  }
  await git(cwd, ["switch", ref]);
  return info.root;
}
