import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gitExecutable, tauHomeDir } from "tau/host-extension";

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
    windowsHide: true,
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
  /** What it started from: the parent's HEAD, or a state commit on it with the uncommitted work. */
  baseCommit: string;
  /** Whether the parent had uncommitted work, so the base is a state commit rather than HEAD. */
  withUncommitted: boolean;
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
 * How a project's `runOnWorktreeCreate` line runs: a POSIX login shell, or on
 * Windows `cmd.exe`, the way Node's `shell: true` would start it.
 */
export function worktreeSetupCommand(
  script: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform !== "win32") return { command: "/bin/sh", args: ["-lc", script] };
  const comSpec = Object.entries(env).find(([key]) => key.toUpperCase() === "COMSPEC")?.[1];
  return { command: comSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${script}"`], windowsVerbatimArguments: true };
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
    join(tauHomeDir(), "project.json"),
    join(tauHomeDir(), "config.json"),
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

/** A checkout's HEAD and its whole working copy as a tree; `dirty` when the two differ. */
export interface StartingState {
  head: string;
  tree: string;
  dirty: boolean;
}

/**
 * Where a spawned thread or a transfer to another machine starts: HEAD and
 * everything uncommitted, read now. Never a turn checkpoint's tree — one
 * captured before the user's latest commit would, set on the new HEAD,
 * silently revert that commit.
 */
export async function captureStartingState(cwd: string, runGit: AgentGitRunner = runAgentGit): Promise<StartingState> {
  const head = (await runGit(cwd, ["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim();
  if (!head) throw new Error("This project has no commit yet, so a worktree cannot start from it.");
  const tree = await captureWorktreeTree(cwd, runGit);
  const headTree = (await runGit(cwd, ["rev-parse", `${head}^{tree}`])).trim();
  return { head, tree, dirty: tree !== headTree };
}

/**
 * The checkout a spawned thread works in. It starts from the parent's current
 * state, not from origin: the child continues the work the parent is doing, so
 * HEAD and the uncommitted work become one commit on a branch of its own.
 */
export async function createAgentWorktree(options: {
  parentCwd: string;
  agentId: string;
  runGit?: AgentGitRunner;
  worktreeParent?: string;
}): Promise<AgentWorktree> {
  const runGit = options.runGit ?? runAgentGit;
  const { parentCwd } = options;
  const state = await captureStartingState(parentCwd, runGit);
  const baseCommit = state.dirty
    ? (await runGit(parentCwd, ["commit-tree", state.tree, "-p", state.head, "-m", `tau: state of ${basename(parentCwd)} for a spawned thread`])).trim()
    : state.head;
  const branch = agentBranchName(options.agentId);
  const parent = options.worktreeParent ?? await worktreeParentOf(parentCwd, runGit);
  const path = join(parent, branch.replace(/[^a-z0-9._-]+/giu, "-"));
  await mkdir(parent, { recursive: true });
  await runGit(parentCwd, ["worktree", "add", "-b", branch, path, baseCommit]);
  // The base is the child's own starting point, so its diff is exactly what it
  // changed — never what the parent had already changed before it started.
  await runGit(parentCwd, ["config", branchBaseConfigKey(branch), baseCommit]).catch(() => "");
  return { path, branch, baseCommit, withUncommitted: state.dirty };
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
    // The child's base carries the parent's uncommitted work, which `git merge` would refuse to overwrite.
    const parentDirty = (await runGit(parentCwd, ["status", "--porcelain"])).trim().length > 0;
    const base = parentDirty ? await readBranchBase(worktree.path, worktree.branch, runGit) : undefined;
    if (base) {
      const outcome = await mergeBranchIntoCheckout({ cwd: parentCwd, branch: worktree.branch, base, runGit });
      if (outcome.state !== "merged" && outcome.state !== "already-merged") throw new Error(`${worktree.branch} does not merge cleanly: ${outcome.detail}`);
      return { branch: worktree.branch, strategy: "merge", files: changes.files, added: changes.added, removed: changes.removed, detail: `Merged ${worktree.branch} (${summary}).` };
    }
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

/** What merging a branch into a checkout would do, read without touching the checkout. */
export interface BranchMergePreview {
  /** `merge-tree --write-tree`'s tree: the merge result, with conflict markers where it has conflicts. */
  tree: string;
  conflicts: string[];
  /** HEAD already contains the branch. */
  merged: boolean;
}

/** The exit code and output a runner's rejection carries, the way `execFile` rejects. */
function gitFailure(error: unknown): { code?: number; stdout?: string; message: string } {
  const failure = error as { code?: unknown; stdout?: unknown; message?: unknown };
  return {
    ...(typeof failure?.code === "number" ? { code: failure.code } : {}),
    ...(typeof failure?.stdout === "string" ? { stdout: failure.stdout } : {}),
    message: typeof failure?.message === "string" ? failure.message : String(error),
  };
}

/** Git 2.38's `merge-tree --write-tree`: the merge of HEAD and `branch` as a tree, and its conflicted paths. */
export async function previewBranchMerge(cwd: string, branch: string, runGit: AgentGitRunner = runAgentGit): Promise<BranchMergePreview> {
  const head = (await runGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
  const tip = (await runGit(cwd, ["rev-parse", "--verify", `${branch}^{commit}`])).trim();
  const merged = await runGit(cwd, ["merge-base", "--is-ancestor", tip, head]).then(() => true, () => false);
  if (merged) return { tree: (await runGit(cwd, ["rev-parse", `${head}^{tree}`])).trim(), conflicts: [], merged: true };
  let output: string;
  try {
    output = await runGit(cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", head, tip]);
  } catch (error) {
    const failure = gitFailure(error);
    // Exit 1 is a merge with conflicts, not a failure of the command.
    if (failure.code !== 1 || failure.stdout === undefined) {
      throw new Error(`Git could not check the merge of ${branch} (merge-tree --write-tree needs Git 2.38 or newer): ${failure.message.split("\n")[0]}`, { cause: error });
    }
    output = failure.stdout;
  }
  const [tree = "", ...paths] = output.split("\0");
  return { tree: tree.trim(), conflicts: [...new Set(paths.filter(Boolean))], merged: false };
}

export interface BranchMergeOutcome {
  branch: string;
  /**
   * `merged`: HEAD is now a merge commit with the branch. `already-merged`:
   * nothing to do. `conflict`: the branch and HEAD conflict in `files`.
   * `blocked`: the checkout holds work in `files` the merge would overwrite,
   * or a merge or rebase is in progress. Only `merged` touched the checkout.
   */
  state: "merged" | "already-merged" | "conflict" | "blocked";
  commit?: string;
  files: string[];
  detail: string;
}

const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"];

async function changedPaths(cwd: string, from: string, to: string, runGit: AgentGitRunner): Promise<Map<string, string>> {
  if (from === to) return new Map();
  const output = await runGit(cwd, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to]);
  const parts = output.split("\0");
  const paths = new Map<string, string>();
  for (let index = 0; index + 1 < parts.length; index += 2) {
    if (parts[index]) paths.set(parts[index + 1], parts[index]);
  }
  return paths;
}

/**
 * Merges `branch` into the checkout at `cwd` only when that is clean; nothing
 * is touched otherwise. A clean checkout gets `git merge --no-ff`. A checkout
 * with uncommitted work may still take the merge when everything it holds is
 * recorded somewhere the merge keeps: in HEAD, in the merge result, or in
 * `base` — the state commit the branch started from, which carries the work
 * this checkout had then. Such a checkout is moved to the merge commit
 * directly (`read-tree --reset -u`), because `git merge` refuses local changes
 * even where the result has them already.
 */
export async function mergeBranchIntoCheckout(options: {
  cwd: string;
  branch: string;
  /** The commit the branch started from, when it differs from what HEAD was then. */
  base?: string;
  message?: string;
  runGit?: AgentGitRunner;
}): Promise<BranchMergeOutcome> {
  const runGit = options.runGit ?? runAgentGit;
  const { cwd, branch } = options;
  const verify = (ref: string) => runGit(cwd, ["rev-parse", "-q", "--verify", ref]).then((out) => out.trim(), () => "");
  for (const ref of IN_PROGRESS) {
    if (await verify(ref)) return { branch, state: "blocked", files: [], detail: "A merge, rebase or cherry-pick is in progress in this checkout; finish it first." };
  }
  const unmerged = (await runGit(cwd, ["ls-files", "-u", "-z"])).split("\0").filter(Boolean);
  if (unmerged.length > 0) return { branch, state: "blocked", files: [], detail: "This checkout has unresolved conflicts; resolve them first." };

  const preview = await previewBranchMerge(cwd, branch, runGit);
  if (preview.merged) return { branch, state: "already-merged", files: [], detail: `${branch} is already merged.` };
  if (preview.conflicts.length > 0) {
    return { branch, state: "conflict", files: preview.conflicts, detail: `${branch} conflicts with this checkout in ${preview.conflicts.length} file${preview.conflicts.length === 1 ? "" : "s"}; nothing was applied.` };
  }
  const head = (await runGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
  const tip = (await runGit(cwd, ["rev-parse", "--verify", `${branch}^{commit}`])).trim();
  const headTree = (await runGit(cwd, ["rev-parse", `${head}^{tree}`])).trim();
  const worktreeTree = await captureWorktreeTree(cwd, runGit);
  const indexTree = (await runGit(cwd, ["write-tree"])).trim();
  const message = options.message ?? `Merge branch '${branch}'`;

  if (worktreeTree === headTree && indexTree === headTree) {
    try {
      await runGit(cwd, ["merge", "--no-ff", "--no-edit", "-m", message, tip]);
    } catch (error) {
      await runGit(cwd, ["merge", "--abort"]).catch(() => "");
      throw new Error(`${branch} did not merge: ${gitFailure(error).message.split("\n")[0]}`, { cause: error });
    }
    const commit = (await runGit(cwd, ["rev-parse", "HEAD"])).trim();
    return { branch, state: "merged", commit, files: [], detail: `Merged ${branch}.` };
  }

  // A path blocks when the checkout holds a version of it that neither HEAD, the base nor the result keeps.
  const keptIn = [headTree, preview.tree, ...(options.base ? [`${options.base}^{tree}`] : [])];
  const blocking = new Set<string>();
  for (const held of new Set([worktreeTree, indexTree])) {
    const lost = await Promise.all(keptIn.map((kept) => changedPaths(cwd, held, kept, runGit)));
    for (const path of lost[0].keys()) if (lost.every((paths) => paths.has(path))) blocking.add(path);
  }
  if (blocking.size > 0) {
    const files = [...blocking].sort();
    return { branch, state: "blocked", files, detail: `This checkout has changes the merge would overwrite: ${files.slice(0, 5).join(", ")}${files.length > 5 ? " …" : ""}. Commit or move them first; nothing was applied.` };
  }
  const commit = (await runGit(cwd, ["commit-tree", preview.tree, "-p", head, "-p", tip, "-m", message])).trim();
  // Files the checkout has that the result drops: untracked ones read-tree would leave behind.
  const dropped = [...(await changedPaths(cwd, worktreeTree, preview.tree, runGit))].filter(([, status]) => status === "D").map(([path]) => path);
  await runGit(cwd, ["read-tree", "--reset", "-u", commit]);
  for (const path of dropped) await rm(join(cwd, path), { force: true }).catch(() => undefined);
  await runGit(cwd, ["update-ref", "-m", `merge ${branch}: Merge made by Tau`, "HEAD", commit, head]);
  await runGit(cwd, ["update-ref", "ORIG_HEAD", head]).catch(() => "");
  return { branch, state: "merged", commit, files: [], detail: `Merged ${branch} over this checkout's uncommitted work, which it already held.` };
}
