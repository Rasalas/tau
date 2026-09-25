import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isWorkspaceRelativePath } from "tau/host-extension";
import { runGitCommand } from "./workspace-git.js";

/*
 * Commits a kit hands in without touching the checkout: a new branch whose
 * commit is its parent's tree with some files replaced or removed, and the
 * merge of such a branch on the user's click. Server drift uses both (ADR 0028).
 */

export interface BranchFile {
  /** Repository-relative POSIX path. */
  path: string;
  /** Base64 content; absent with `delete`. */
  content?: string;
  executable?: boolean;
  delete?: boolean;
}

export interface CommitFilesInput {
  /** Branch to create; with `unique`, `-2`, `-3` … follow when it exists. */
  branch: string;
  message: string;
  files: BranchFile[];
  /** Commit-ish the new commit sits on; HEAD by default. */
  parent?: string;
  unique?: boolean;
}

export interface CommitFilesResult {
  branch?: string;
  /** Absent when the files already read so on the parent: nothing to commit. */
  commit?: string;
  parent: string;
  /** Paths whose content or presence differs from the parent. */
  changed: string[];
}

export interface MergeBranchResult {
  /** Already contained in HEAD: nothing merged. */
  alreadyMerged: boolean;
  commit: string;
  into: string;
}

type Env = NodeJS.ProcessEnv;
const git = (cwd: string, args: string[], env?: Env, timeout = 60_000) => runGitCommand(cwd, args, 64 * 1024 * 1024, undefined, env, timeout);
const ok = (cwd: string, args: string[], env?: Env) => git(cwd, args, env).then(() => true, () => false);
const lastLine = (error: unknown) => (error as { stderr?: string }).stderr?.trim().split("\n").at(-1) ?? (error as Error).message;

export function decodeBranchFiles(value: unknown): BranchFile[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Name the files to commit.");
  const seen = new Set<string>();
  return value.map((raw) => {
    const file = (raw ?? {}) as Record<string, unknown>;
    const path = file.path;
    if (typeof path !== "string" || !isWorkspaceRelativePath(path) || path.split("/").some((part) => part === "." || part.toLowerCase() === ".git"))throw new Error(`Not a path inside the repository: ${String(path)}`);
    if (seen.has(path)) throw new Error(`Named twice: ${path}`);
    seen.add(path);
    if (file.delete === true) return { path, delete: true };
    if (typeof file.content !== "string") throw new Error(`No content for ${path}.`);
    return { path, content: file.content, executable: file.executable === true };
  });
}

async function createBranch(cwd: string, base: string, commit: string, unique: boolean): Promise<string> {
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const name = attempt === 1 ? base : `${base}-${attempt}`;
    await git(cwd, ["check-ref-format", "--branch", name]).catch(() => { throw new Error(`Not a branch name: ${name}`); });
    // A zero old value creates the ref only if nobody holds the name.
    if (await ok(cwd, ["update-ref", "-m", "tau: new branch", `refs/heads/${name}`, commit, "0".repeat(commit.length)])) return name;
    if (!unique) throw new Error(`Branch ${name} already exists.`);
  }
  throw new Error(`No free name after ${base}-99.`);
}

/**
 * The parent's tree with `files` put in, committed on a new branch. A scratch
 * work tree and index take the files, so `git add` applies the project's
 * attributes and filters; the checkout, its index and HEAD stay as they are.
 */
export async function commitFilesToBranch(cwd: string, input: CommitFilesInput): Promise<CommitFilesResult> {
  const parent = (await git(cwd, ["rev-parse", "--verify", "--quiet", `${input.parent ?? "HEAD"}^{commit}`]).catch(() => "")).trim();
  if (!parent) throw new Error("The repository has no commit to build on yet.");
  const gitDir = (await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim();
  const scratch = await mkdtemp(join(tmpdir(), "tau-branch-commit-"));
  try {
    const tree = join(scratch, "tree");
    await mkdir(tree);
    const env: Env = {
      ...process.env,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: tree,
      GIT_INDEX_FILE: join(scratch, "index"),
      GIT_LITERAL_PATHSPECS: "1",
      GIT_OPTIONAL_LOCKS: "0",
    };
    const quiet = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];
    await git(tree, [...quiet, "read-tree", parent], env);
    const added = input.files.filter((file) => !file.delete);
    const removed = input.files.filter((file) => file.delete).map((file) => file.path);
    for (const file of added) {
      const target = join(tree, ...file.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.content ?? "", "base64"));
      if (file.executable) await chmod(target, 0o755);
    }
    if (added.length) await git(tree, [...quiet, "add", "--force", "--", ...added.map((file) => file.path)], env);
    if (removed.length) await git(tree, [...quiet, "rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...removed], env);
    const written = (await git(tree, [...quiet, "write-tree"], env)).trim();
    const changed = (await git(cwd, ["diff-tree", "-r", "--name-only", "-z", "--no-renames", parent, written])).split("\0").filter(Boolean);
    if (!changed.length) return { parent, changed };
    const commit = (await git(cwd, ["commit-tree", written, "-p", parent, "-m", input.message])).trim();
    const branch = await createBranch(cwd, input.branch, commit, input.unique === true);
    return { branch, commit, parent, changed };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * A normal merge commit of `branch` into the checkout's branch. A conflict is
 * backed out and named: a click never leaves a half-done merge behind.
 */
export async function mergeBranch(cwd: string, branch: string): Promise<MergeBranchResult> {
  const commit = (await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).catch(() => "")).trim();
  if (!commit) throw new Error(`Branch ${branch} is gone.`);
  const into = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
  if (!into) throw new Error("This checkout is not on a branch; check one out first.");
  if (await ok(cwd, ["merge-base", "--is-ancestor", commit, "HEAD"])) return { alreadyMerged: true, commit: (await git(cwd, ["rev-parse", "HEAD"])).trim(), into };
  try {
    await git(cwd, ["merge", "--no-ff", "--no-edit", "-m", `Merge branch '${branch}'`, `refs/heads/${branch}`]);
  } catch (error) {
    if (!(await ok(cwd, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]))) throw new Error(`Git did not merge ${branch}: ${lastLine(error)}`, { cause: error });
    const conflicts = (await git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]).catch(() => "")).split("\0").filter(Boolean);
    await git(cwd, ["merge", "--abort"]).catch(() => undefined);
    throw new Error(`Merging ${branch} into ${into} conflicts in ${conflicts.join(", ") || "some files"}; nothing was changed. Merge it by hand or ask the agent.`, { cause: error });
  }
  return { alreadyMerged: false, commit: (await git(cwd, ["rev-parse", "HEAD"])).trim(), into };
}
