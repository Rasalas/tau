import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gitExecutable } from "tau/host-extension";
import { TURN_CHECKPOINT_CUSTOM_TYPE } from "./turn-checkpoint-codec.js";

const execFileAsync = promisify(execFile);
const PATCH_BUFFER = 64 * 1024 * 1024;

/**
 * Worktrees for the threads an agent spawns. It is Workspace Kit's, because
 * every Git sequence in Tau is, and Agents Kit calls into it: a child works in
 * its own checkout, and the parent takes the result back with one apply.
 *
 * The module carries its own Git runner on purpose. It is the one file another
 * kit imports, so it stays a leaf: nothing here reaches the kit's Git engine,
 * its cache or its checkpoint machinery.
 */
export interface AgentGitOptions {
  /** Fed to the command on standard input, for `git apply`. */
  stdin?: string;
  /** A private index file, so capturing a tree never touches the user's own. */
  indexFile?: string;
}

export type AgentGitRunner = (cwd: string, args: string[], options?: AgentGitOptions) => Promise<string>;

export const runAgentGit: AgentGitRunner = async (cwd, args, options = {}) => {
  const child = execFileAsync(gitExecutable(), ["-c", "core.quotePath=false", ...args], {
    cwd,
    maxBuffer: PATCH_BUFFER,
    timeout: 120_000,
    ...(options.indexFile ? { env: { ...process.env, GIT_INDEX_FILE: options.indexFile, GIT_OPTIONAL_LOCKS: "0" } } : {}),
  });
  if (options.stdin !== undefined) child.child.stdin?.end(options.stdin);
  const { stdout } = await child;
  return stdout;
};

/** The base a branch started from, in the repository's own config. */
export function branchBaseConfigKey(branch: string): string {
  return `branch.${branch}.tau-base`;
}

export async function readBranchBase(
  cwd: string,
  branch: string,
  runGit: (cwd: string, args: string[]) => Promise<string> = runAgentGit,
): Promise<string | undefined> {
  const value = (await runGit(cwd, ["config", "--get", branchBaseConfigKey(branch)]).catch(() => "")).trim();
  return value || undefined;
}

/** One checkout a spawned thread works in. */
export interface AgentWorktree {
  path: string;
  branch: string;
  /** What it started from: the parent's checkpoint tree, or the parent's HEAD. */
  baseCommit: string;
  /** Whether that state came from a checkpoint snapshot rather than from HEAD. */
  fromCheckpoint: boolean;
}

/** What a child changed, as the parent's tools and the Agents panel read it. */
export interface AgentWorktreeChanges {
  branch: string;
  files: number;
  added: number;
  removed: number;
  /** Commits the child made beyond the state it started from. */
  commits: number;
  /** Files the child has not committed. */
  uncommitted: number;
  paths: string[];
}

/**
 * The newest checkpoint the parent's session recorded. Its `after` ref holds
 * the tree of the parent's working copy at the end of that turn, which is a
 * closer starting point for a child than HEAD: the parent's uncommitted work
 * is what it just asked the child to build on.
 */
export function latestCheckpointSnapshotRef(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (item.type !== "custom" || item.customType !== TURN_CHECKPOINT_CUSTOM_TYPE) continue;
    const after = (item.data as { afterSnapshotId?: unknown } | undefined)?.afterSnapshotId;
    if (typeof after === "string" && after.startsWith("refs/tau/checkpoints/")) return after;
  }
  return undefined;
}

/**
 * Resolves the parent directory where worktrees live for a repository.
 * Defaults to `<repo>-worktrees` beside the repository.
 * If configured (e.g. `~/.tau/worktrees` or `/path/to/worktrees`), worktrees
 * are nested by repository name (or by `{project}` placeholder) to prevent cross-repo collisions.
 */
export function resolveWorktreeParent(mainRoot: string, configured?: string): string {
  const trimmed = configured?.trim();
  if (!trimmed || trimmed === "beside") {
    return join(dirname(mainRoot), `${basename(mainRoot)}-worktrees`);
  }
  const repoName = basename(mainRoot);
  let expanded = trimmed;
  if (expanded === "~") {
    expanded = homedir();
  } else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(homedir(), expanded.slice(2));
  } else if (!isAbsolute(expanded)) {
    expanded = resolve(mainRoot, expanded);
  }
  if (expanded.includes("{project}")) {
    return resolve(expanded.replaceAll("{project}", repoName));
  }
  if (basename(expanded) === repoName) {
    return resolve(expanded);
  }
  return resolve(join(expanded, repoName));
}

/**
 * Reads the configured worktree directory for a repository.
 * Checks `.tau/project.json` in the workspace/mainRoot, then `TAU_WORKTREES_DIR` env var,
 * and finally global `~/.tau/project.json` or `~/.tau/config.json`.
 */
export async function readWorktreeConfig(mainRoot: string, cwd?: string): Promise<string | undefined> {
  const candidates = [
    ...(cwd && cwd !== mainRoot ? [join(cwd, ".tau", "project.json")] : []),
    join(mainRoot, ".tau", "project.json"),
    join(mainRoot, ".tau", "config.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(await readFile(candidate, "utf8")) as Record<string, unknown>;
      if (typeof raw.worktreeDirectory === "string" && raw.worktreeDirectory.trim()) {
        return raw.worktreeDirectory.trim();
      }
      const options = raw.options as Record<string, unknown> | undefined;
      if (typeof options?.["worktree-directory"] === "string" && (options["worktree-directory"] as string).trim()) {
        return (options["worktree-directory"] as string).trim();
      }
    } catch {
      // ignore
    }
  }

  if (process.env.TAU_WORKTREES_DIR?.trim()) {
    return process.env.TAU_WORKTREES_DIR.trim();
  }

  const globalCandidates = [
    join(homedir(), ".tau", "project.json"),
    join(homedir(), ".tau", "config.json"),
  ];
  for (const candidate of globalCandidates) {
    try {
      const raw = JSON.parse(await readFile(candidate, "utf8")) as Record<string, unknown>;
      if (typeof raw.worktreeDirectory === "string" && raw.worktreeDirectory.trim()) {
        return raw.worktreeDirectory.trim();
      }
      const options = raw.options as Record<string, unknown> | undefined;
      if (typeof options?.["worktree-directory"] === "string" && (options["worktree-directory"] as string).trim()) {
        return (options["worktree-directory"] as string).trim();
      }
    } catch {
      // ignore
    }
  }

  return undefined;
}

/** Where linked worktrees live for a repository, from any of its checkouts. */
export async function worktreeParentOf(
  cwd: string,
  runGit: AgentGitRunner = runAgentGit,
  configured?: string,
): Promise<string> {
  const commonDir = (await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const mainRoot = commonDir ? dirname(resolve(cwd, commonDir)) : cwd;
  const config = configured ?? await readWorktreeConfig(mainRoot, cwd);
  return resolveWorktreeParent(mainRoot, config);
}

export function agentBranchName(agentId: string): string {
  return `tau/agent-${agentId.replace(/[^a-z0-9]/giu, "").slice(0, 8).toLowerCase() || "child"}`;
}

/**
 * Captures a checkout's whole working copy as a Git tree without touching its
 * index — the same trick turn checkpoints use. It is what makes a child's
 * uncommitted work applyable and its diff readable.
 */
export async function captureWorktreeTree(cwd: string, runGit: AgentGitRunner = runAgentGit): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-agent-tree-"));
  const indexFile = join(directory, "index");
  try {
    const head = (await runGit(cwd, ["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim();
    await runGit(cwd, head ? ["read-tree", head] : ["read-tree", "--empty"], { indexFile });
    await runGit(cwd, ["add", "-A"], { indexFile });
    return (await runGit(cwd, ["write-tree"], { indexFile })).trim();
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The checkout a spawned thread works in. It starts from the parent's current
 * state, not from origin: the child continues the work the parent is doing, so
 * a checkpoint tree (or HEAD) becomes one commit on a branch of its own.
 */
export async function createAgentWorktree(options: {
  parentCwd: string;
  agentId: string;
  /** `refs/tau/checkpoints/…/after` of the parent's last turn, when it has one. */
  snapshotRef?: string;
  runGit?: AgentGitRunner;
  worktreeParent?: string;
}): Promise<AgentWorktree> {
  const runGit = options.runGit ?? runAgentGit;
  const { parentCwd } = options;
  const head = (await runGit(parentCwd, ["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim();
  if (!head) throw new Error("This project has no commit yet, so a worktree cannot start from it.");
  const tree = options.snapshotRef
    ? (await runGit(parentCwd, ["rev-parse", "--verify", "--quiet", `${options.snapshotRef}^{tree}`]).catch(() => "")).trim()
    : "";
  const fromCheckpoint = Boolean(tree);
  const baseCommit = fromCheckpoint
    ? (await runGit(parentCwd, ["commit-tree", tree, "-p", head, "-m", `tau: state of ${basename(parentCwd)} for a spawned thread`])).trim()
    : head;
  const branch = agentBranchName(options.agentId);
  const parent = options.worktreeParent ?? await worktreeParentOf(parentCwd, runGit);
  const path = join(parent, branch.replace(/[^a-z0-9._-]+/giu, "-"));
  await mkdir(parent, { recursive: true });
  await runGit(parentCwd, ["worktree", "add", "-b", branch, path, baseCommit]);
  // The base is the child's own starting point, so its diff is exactly what it
  // changed — never what the parent had already changed before it started.
  await runGit(parentCwd, ["config", branchBaseConfigKey(branch), baseCommit]).catch(() => "");
  return { path, branch, baseCommit, fromCheckpoint };
}

function parseNumstat(stdout: string): { files: number; added: number; removed: number; paths: string[] } {
  const paths: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of stdout.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/u.exec(line.trim());
    if (!match) continue;
    added += Number(match[1]) || 0;
    removed += Number(match[2]) || 0;
    paths.push(match[3]);
  }
  return { files: paths.length, added, removed, paths };
}

/** What a child changed since it started, committed and uncommitted alike. */
export async function readAgentWorktreeChanges(
  worktree: Pick<AgentWorktree, "path" | "branch">,
  runGit: AgentGitRunner = runAgentGit,
): Promise<AgentWorktreeChanges> {
  const base = await readBranchBase(worktree.path, worktree.branch, runGit);
  if (!base) throw new Error(`${worktree.branch} does not record the state it started from.`);
  const tree = await captureWorktreeTree(worktree.path, runGit);
  const numstat = parseNumstat(await runGit(worktree.path, ["diff", "--numstat", base, tree]));
  const commits = Number((await runGit(worktree.path, ["rev-list", "--count", `${base}..HEAD`]).catch(() => "0")).trim()) || 0;
  const uncommitted = (await runGit(worktree.path, ["status", "--porcelain"]).catch(() => ""))
    .split("\n").filter((line) => line.trim().length > 0).length;
  return { branch: worktree.branch, ...numstat, commits, uncommitted };
}

export interface AgentApplyResult {
  branch: string;
  /** How the changes reached the parent. */
  strategy: "merge" | "patch" | "nothing";
  files: number;
  added: number;
  removed: number;
  detail: string;
}

/**
 * Takes a child's work into the parent's checkout. A child that committed
 * everything is merged, so its history survives; anything else travels as one
 * patch of its whole working copy. A patch that does not apply cleanly changes
 * nothing at all — the parent is never left half-merged, and the branch is
 * still there to merge by hand.
 */
export async function applyAgentWorktree(options: {
  parentCwd: string;
  worktree: Pick<AgentWorktree, "path" | "branch">;
  runGit?: AgentGitRunner;
}): Promise<AgentApplyResult> {
  const runGit = options.runGit ?? runAgentGit;
  const { parentCwd, worktree } = options;
  const changes = await readAgentWorktreeChanges(worktree, runGit);
  if (changes.files === 0) {
    return { branch: worktree.branch, strategy: "nothing", files: 0, added: 0, removed: 0, detail: "This thread changed nothing." };
  }
  const summary = `${changes.files} file${changes.files === 1 ? "" : "s"}, +${changes.added} −${changes.removed}`;
  if (changes.commits > 0 && changes.uncommitted === 0) {
    try {
      await runGit(parentCwd, ["merge", "--no-ff", "--no-edit", worktree.branch]);
    } catch (error) {
      await runGit(parentCwd, ["merge", "--abort"]).catch(() => "");
      throw new Error(`${worktree.branch} does not merge cleanly: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, { cause: error });
    }
    return { branch: worktree.branch, strategy: "merge", files: changes.files, added: changes.added, removed: changes.removed, detail: `Merged ${worktree.branch} (${summary}).` };
  }
  const base = await readBranchBase(worktree.path, worktree.branch, runGit);
  const tree = await captureWorktreeTree(worktree.path, runGit);
  const patch = await runGit(worktree.path, ["diff", "--binary", base ?? "HEAD", tree]);
  try {
    await runGit(parentCwd, ["apply", "--check", "--binary", "-"], { stdin: patch });
  } catch (error) {
    throw new Error(
      `The changes of ${worktree.branch} do not apply to this checkout: ${error instanceof Error ? error.message.split("\n").slice(0, 3).join(" ") : String(error)}`,
      { cause: error },
    );
  }
  await runGit(parentCwd, ["apply", "--binary", "-"], { stdin: patch });
  return { branch: worktree.branch, strategy: "patch", files: changes.files, added: changes.added, removed: changes.removed, detail: `Applied ${summary} from ${worktree.branch}.` };
}

/** Removes a child's checkout and the branch it held; a folder already gone is pruned. */
export async function removeAgentWorktree(options: {
  parentCwd: string;
  worktree: Pick<AgentWorktree, "path" | "branch">;
  runGit?: AgentGitRunner;
}): Promise<void> {
  const runGit = options.runGit ?? runAgentGit;
  const { parentCwd, worktree } = options;
  const exists = await stat(worktree.path).then((entry) => entry.isDirectory()).catch(() => false);
  if (exists) await runGit(parentCwd, ["worktree", "remove", "--force", worktree.path]).catch(() => "");
  await runGit(parentCwd, ["worktree", "prune"]).catch(() => "");
  await runGit(parentCwd, ["branch", "-D", worktree.branch]).catch(() => "");
}
