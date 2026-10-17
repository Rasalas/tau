import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ChangeStatus,
  CommitResult,
  DiffLoadOptions,
  UiChangedFile,
  UiFileDiff,
  PullResult,
  PushResult,
  UiRef,
  UiWorkspaceChanges,
  WorkspaceChangesQuery,
  WorkspaceInfo,
} from "tau/host-extension";
import { runGitCommand as git, type GitRunner } from "./git-command.js";
import { assertWorkspacePath } from "./workspace-paths.js";
import {
  describe,
  parseNumstat,
  proposeMessage,
  diffGitTrees,
  diffViewArguments,
  streamFilePatch,
  parseUnifiedDiff,
  MAX_DIFF_HUNKS,
} from "./git-diff.js";
import { assertValidBranchName } from "./git-refs.js";
import { parseWorktrees } from "./worktree-layout.js";
import { readBranchBase, readWorktreeConfig, resolveWorktreeParent } from "./agent-worktrees.js";

const EMPTY_CHANGES: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };

function statusFromCode(code: string): ChangeStatus {
  if (code.includes("?")) return "untracked";
  if (code.includes("R")) return "renamed";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  return "modified";
}

/**
 * `git status --porcelain -z` emits `XY path\0`, and for renames a second
 * `\0`-terminated field holding the original path.
 */
interface ParsedStatus { status: ChangeStatus; staged: boolean }

function parseStatus(stdout: string): Map<string, ParsedStatus> {
  const statuses = new Map<string, ParsedStatus>();
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (!path) continue;
    statuses.set(path, { status: statusFromCode(code), staged: code !== "??" && code[0] !== " " });
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return statuses;
}

const UNTRACKED_STAT_LIMIT = 500;

export interface UntrackedStatsOptions {
  /** Never read a complete large file just to produce a review statistic. */
  maxBytes?: number;
  onBytesRead?: (bytes: number) => void;
  signal?: AbortSignal;
}

/**
 * Counts only a bounded UTF-8 text prefix. NUL bytes identify binary content,
 * for which line statistics are intentionally omitted. This keeps status scans
 * from loading large artifacts into memory or serially decoding them in full.
 */
export async function countUntrackedLines(
  cwd: string,
  path: string,
  options: UntrackedStatsOptions = {},
): Promise<number> {
  const maxBytes = options.maxBytes ?? 256 * 1024;
  try {
    const file = await stat(join(cwd, path));
    if (!file.isFile() || file.size > maxBytes) return 0;
    const handle = await open(join(cwd, path), "r");
    try {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes));
      let offset = 0;
      let lines = 0;
      let pending = 0;
      while (offset < file.size) {
        if (options.signal?.aborted) return 0;
        const length = Math.min(buffer.length, file.size - offset);
        const result = await handle.read(buffer, 0, length, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
        options.onBytesRead?.(result.bytesRead);
        const chunk = buffer.subarray(0, result.bytesRead);
        if (chunk.includes(0)) return 0;
        for (const byte of chunk) {
          if (byte === 10) lines += 1;
          pending = byte;
        }
      }
      return file.size === 0 ? 0 : lines + (pending === 10 ? 0 : 1);
    } finally {
      await handle.close();
    }
  } catch {
    return 0;
  }
}

export interface ProjectGitState {
  changes: UiWorkspaceChanges;
  workspace: WorkspaceInfo;
  branch?: string;
}

export interface ProjectScanOptions {
  runGit?: GitRunner;
  untrackedStats?: UntrackedStatsOptions;
  onGitCommand?: () => void;
  signal?: AbortSignal;
  throwOnError?: boolean;
  worktreeParent?: string;
}

export function emptyProjectGitState(cwd: string): ProjectGitState {
  return {
    changes: EMPTY_CHANGES,
    workspace: {
      root: cwd,
      isRepo: false,
      isDirty: false,
      worktrees: [],
      refs: [],
      worktreeParent: resolveWorktreeParent(cwd),
    },
  };
}

/** One bounded scan supplies all project metadata consumers need. */
export async function readProjectGitState(
  cwd: string,
  options: ProjectScanOptions = {},
): Promise<ProjectGitState> {
  const runGit = options.runGit ?? git;
  const run = (args: string[], maxBuffer?: number): Promise<string> => {
    options.onGitCommand?.();
    return runGit(cwd, args, maxBuffer, options.signal);
  };
  try {
    const [rootOut, remoteOut, statusOut, numstatOut, worktreeOut, refOut] = await Promise.all([
      run(["rev-parse", "--show-toplevel"]),
      run(["remote"]).catch(() => ""),
      // Every untracked file, so a new folder lists its files rather than one row the review cannot open.
      run(["status", "--porcelain", "-z", "--untracked-files=all"]),
      // Porcelain diff refreshes the index even with optional locks disabled.
      run(["diff-index", "--find-renames", "--numstat", "-z", "HEAD", "--"]).catch(() => ""),
      run(["worktree", "list", "--porcelain"]),
      run(["for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)", "--sort=-committerdate", "refs/heads"]),
    ]);
    const workspaceRoot = rootOut.trim() || cwd;
    const worktrees = parseWorktrees(worktreeOut, workspaceRoot);
    const branch = worktrees.find((tree) => tree.isCurrent)?.branch;
    const statuses = parseStatus(statusOut);
    const counts = parseNumstat(numstatOut);
    const files: UiChangedFile[] = [];
    // A new build folder can hold thousands of files; line counts stop after the first few hundred.
    const untracked = [...statuses].filter(([, value]) => value.status === "untracked").slice(0, UNTRACKED_STAT_LIMIT);
    const stats = new Map<string, number>();
    const limit = 4;
    for (let index = 0; index < untracked.length; index += limit) {
      await Promise.all(untracked.slice(index, index + limit).map(async ([path]) => {
        stats.set(path, await countUntrackedLines(cwd, path, options.untrackedStats));
      }));
    }
    for (const [path, value] of statuses) {
      const { status, staged } = value;
      const counted = counts.get(path);
      const added = counted?.added ?? (status === "untracked" ? stats.get(path) ?? 0 : 0);
      files.push({ path, ...describe(path), status, added, removed: counted?.removed ?? 0, staged });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const changes: UiWorkspaceChanges = {
      branch,
      files,
      added: files.reduce((total, file) => total + file.added, 0),
      removed: files.reduce((total, file) => total + file.removed, 0),
      proposedMessage: proposeMessage(files),
    };

    const heldByWorktree = new Map(
      worktrees.filter((tree) => tree.branch && tree.branch !== "detached").map((tree) => [tree.branch as string, tree.path]),
    );
    const refMetadata = refOut.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name, upstream, tracking = "", committedAt = ""] = line.split("\t");
      const commitSeconds = Number(committedAt);
      return {
        name,
        upstream: upstream || undefined,
        ahead: Number(/ahead (\d+)/u.exec(tracking)?.[1] ?? 0),
        behind: Number(/behind (\d+)/u.exec(tracking)?.[1] ?? 0),
        lastCommitAt: Number.isFinite(commitSeconds) && commitSeconds > 0 ? commitSeconds * 1_000 : undefined,
      };
    });
    const refs: UiRef[] = refMetadata.map((metadata) => ({
      ...metadata,
      isCurrent: metadata.name === branch,
      worktreePath: heldByWorktree.get(metadata.name),
    }));
    const currentRef = refMetadata.find((ref) => ref.name === branch);
    const mainRoot = worktrees.find((tree) => tree.isMain)?.path ?? workspaceRoot;
    const configuredParent = options.worktreeParent ?? await readWorktreeConfig(mainRoot, workspaceRoot);
    const worktreeParent = resolveWorktreeParent(mainRoot, configuredParent);
    const workspace: WorkspaceInfo = {
      root: workspaceRoot,
      isRepo: true,
      isDirty: statusOut.trim().length > 0,
      branch,
      upstream: currentRef?.upstream,
      ahead: currentRef?.ahead,
      behind: currentRef?.behind,
      hasRemote: remoteOut.trim().length > 0,
      worktrees,
      refs,
      worktreeParent,
    };
    return { changes, workspace, branch };
  } catch (error) {
    if (options.throwOnError) throw error;
    return emptyProjectGitState(cwd);
  }
}

export async function getFileDiff(cwd: string, path: string, options: DiffLoadOptions = {}): Promise<UiFileDiff> {
  const empty = (note: string): UiFileDiff => ({ path, added: 0, removed: 0, hunks: [], note });
  try {
    const branchBase = options.scope === "branch"
      ? options.baseCommit ? { ref: options.baseRef ?? options.baseCommit, mergeBase: options.baseCommit } : await resolveBranchBase(cwd, options.baseRef)
      : undefined;
    const view = diffViewArguments(options);
    const diffArgs = branchBase
      ? ["diff", "--no-ext-diff", ...view, branchBase.mergeBase, "HEAD", "--", path]
      : ["diff-index", "-p", "--no-ext-diff", ...view, "HEAD", "--", path];
    let streamed = await streamFilePatch(cwd, diffArgs, options);
    if (!streamed.patch.trim()) {
      const whitespaceOnly = options.ignoreWhitespace === true
        && (Boolean(branchBase) || await git(cwd, ["ls-files", "--error-unmatch", "--", path]).then(() => true, () => false));
      if (whitespaceOnly) return empty("Only whitespace changed.");
      if (branchBase) return empty("No textual changes.");
      // Untracked files have no HEAD side; diff them against an empty tree.
      streamed = await streamFilePatch(cwd, ["diff", "--no-ext-diff", ...view, "--no-index", "--", "/dev/null", path], options, true);
    }
    if (!streamed.patch.trim()) return empty("No textual changes.");
    if (/^Binary files /mu.test(streamed.patch)) return empty("Binary file — no line diff.");
    const result = parseUnifiedDiff(path, streamed.patch, { hunkLimit: MAX_DIFF_HUNKS }, streamed.terminalTruncation);
    if (streamed.hasMoreHunks) {
      const offset = Math.max(0, options.hunkOffset ?? 0);
      return {
        ...result,
        truncated: true,
        nextHunkOffset: offset + streamed.capturedHunks,
        note: `Showing ${streamed.capturedHunks} hunks. Load more to continue.`,
      };
    }
    return result;
  } catch {
    return empty("Could not read this diff.");
  }
}

async function resolveBranchBase(cwd: string, requested?: string, runGit: GitRunner = git): Promise<{ ref: string; mergeBase: string }> {
  const remoteDefault = requested ? "" : (await runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  const upstream = requested ? "" : (await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "")).trim();
  // A worktree Tau created recorded the base it started from; it beats guessing.
  const branch = requested ? "" : (await runGit(cwd, ["branch", "--show-current"]).catch(() => "")).trim();
  const recorded = branch ? await readBranchBase(cwd, branch, runGit) : undefined;
  const candidates = requested
    ? [requested]
    : [
        recorded ?? "",
        remoteDefault,
        "origin/main",
        "main",
        "origin/master",
        "master",
        "origin/develop",
        "develop",
        upstream,
      ].filter(Boolean);
  for (const candidate of candidates) {
    const exists = await runGit(cwd, ["rev-parse", "--verify", "--quiet", candidate]).then(() => true).catch(() => false);
    if (!exists) continue;
    const mergeBase = (await runGit(cwd, ["merge-base", candidate, "HEAD"]).catch(() => "")).trim();
    if (mergeBase) return { ref: candidate, mergeBase };
  }
  throw new Error("No branch comparison base is available.");
}

export async function getBranchChanges(
  cwd: string,
  query: WorkspaceChangesQuery = {},
  runGit: GitRunner = git,
): Promise<UiWorkspaceChanges> {
  const branch = (await runGit(cwd, ["branch", "--show-current"]).catch(() => "")).trim() || undefined;
  const base = await resolveBranchBase(cwd, query.baseRef, runGit);
  const changes = await diffGitTrees(cwd, base.mergeBase, "HEAD", branch, runGit);
  return { ...changes, scope: "branch", baseRef: base.ref, baseCommit: base.mergeBase };
}

export async function stageFile(cwd: string, path: string, runGit: GitRunner = git): Promise<void> {
  await assertWorkspacePath(cwd, path);
  await runGit(cwd, ["add", "--", path]);
}

export async function unstageFile(cwd: string, path: string, runGit: GitRunner = git): Promise<void> {
  await assertWorkspacePath(cwd, path);
  await runGit(cwd, ["restore", "--staged", "--", path]);
}

export async function stageAll(cwd: string, runGit: GitRunner = git): Promise<void> {
  await runGit(cwd, ["add", "-A"]);
}

export async function revertFile(cwd: string, path: string, runGit: GitRunner = git): Promise<void> {
  await assertWorkspacePath(cwd, path);
  const tracked = await runGit(cwd, ["ls-files", "--error-unmatch", "--", path]).then(() => true).catch(() => false);
  if (tracked) {
    await runGit(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", path]);
  } else {
    await runGit(cwd, ["clean", "-fd", "--", path]);
  }
}

export async function commit(
  cwd: string,
  message: string,
  shouldPush: boolean,
  readChanges: (cwd: string) => Promise<UiWorkspaceChanges> = async (path) => (await readProjectGitState(path)).changes,
): Promise<CommitResult> {
  const subject = message.trim();
  if (!subject) throw new Error("A commit message is required.");
  const staged = (await git(cwd, ["diff", "--cached", "--name-only"])).trim();
  if (!staged) await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", subject]);
  const committed = (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  let pushed = false;
  let detail = `Committed ${committed}`;
  if (shouldPush) {
    await pushCurrentBranch(cwd);
    pushed = true;
    detail = `Committed ${committed} and pushed`;
  }
  return { changes: await readChanges(cwd), pushed, detail };
}

export async function pull(cwd: string, runGit: GitRunner = git): Promise<PullResult> {
  await runGit(cwd, ["pull", "--ff-only"], 8 * 1024 * 1024);
  const committed = (await runGit(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  return { detail: `Pulled ${committed}` };
}

/**
 * Pushes the checked-out branch. A branch without an upstream is published to
 * `origin` (or the only remote) and starts tracking it, which is what a new
 * pull request needs; a repository without a remote says so.
 */
export async function pushCurrentBranch(cwd: string, runGit: GitRunner = git): Promise<void> {
  const upstream = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => "")).trim();
  if (upstream) {
    await runGit(cwd, ["push"], 8 * 1024 * 1024);
    return;
  }
  const branch = (await runGit(cwd, ["branch", "--show-current"]).catch(() => "")).trim();
  if (!branch) throw new Error("Check out a branch before pushing; HEAD is detached.");
  const remote = await primaryRemote(cwd, runGit);
  if (!remote) throw new Error("This repository has no remote to push to. Add one with `git remote add origin <url>`.");
  await runGit(cwd, ["push", "--set-upstream", remote, `HEAD:refs/heads/${branch}`], 8 * 1024 * 1024);
}

/** `origin` when it exists, else the only remote; undefined without one. */
export async function primaryRemote(cwd: string, runGit: GitRunner = git): Promise<string | undefined> {
  const remotes = (await runGit(cwd, ["remote"]).catch(() => "")).split(/\r?\n/u).map((name) => name.trim()).filter(Boolean);
  return remotes.includes("origin") ? "origin" : remotes[0];
}

/**
 * The first remote of a repository that has none, for a repository just
 * published. It never replaces or adds beside an existing remote; whether
 * there is a commit to push afterwards is the answer.
 */
export async function addFirstRemote(cwd: string, name: string, url: string, runGit: GitRunner = git): Promise<{ hasCommits: boolean }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) throw new Error(`"${name}" is not a remote name.`);
  if (!url || url.startsWith("-") || /[\s\0]/u.test(url)) throw new Error("That is not a remote URL.");
  const remotes = (await runGit(cwd, ["remote"])).split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
  if (remotes.length > 0) throw new Error(`This repository already has a remote (${remotes.join(", ")}).`);
  await runGit(cwd, ["remote", "add", name, url]);
  const head = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).catch(() => "");
  return { hasCommits: head.trim().length > 0 };
}

export async function push(cwd: string, runGit: GitRunner = git): Promise<PushResult> {
  await pushCurrentBranch(cwd, runGit);
  const committed = (await runGit(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  return { detail: `Pushed ${committed}` };
}

/** A new branch at HEAD, checked out in place; uncommitted work comes along. */
export async function createBranch(cwd: string, branch: string, runGit: GitRunner = git): Promise<void> {
  const name = branch.trim();
  if (!name) throw new Error("A branch name is required.");
  await assertValidBranchName(cwd, name, runGit);
  await runGit(cwd, ["switch", "-c", name]);
}
