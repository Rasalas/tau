import { spawn } from "node:child_process";
import { appendFile, lstat, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecutable, HostCommandError } from "tau/host-extension";

/*
 * Git objects another kit asks this one to write into a project: a first
 * commit made from a tree it keeps elsewhere, and a commit of chosen files on
 * a new branch. Both work through a temporary index; neither touches the
 * working tree, and the second leaves HEAD and the real index alone too.
 */

interface GitResult { code: number | null; stdout: Buffer; stderr: string }
interface GitOptions { cwd?: string; env?: Record<string, string>; input?: string | Buffer }

// Variables that would point git at another repository than the one named.
const REPOSITORY_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES)$/u;

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!REPOSITORY_ENV.test(key)) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}

function spawnGit(args: readonly string[], options: GitOptions = {}) {
  return spawn(gitExecutable(), ["-c", "core.quotePath=false", ...args], {
    cwd: options.cwd, env: gitEnv(options.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
}

function gitRun(args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawnGit(args, options);
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString("utf8"); });
    child.stdin.on("error", () => undefined);
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr }));
    child.stdin.end(options.input ?? "");
  });
}

function failure(args: readonly string[], result: GitResult): HostCommandError {
  const command = args[0] === "--git-dir" ? args[2] : args[0];
  return new HostCommandError(`git ${command ?? ""} failed: ${result.stderr.trim().split("\n").at(-1) ?? `exit ${result.code}`}`);
}

async function git(args: readonly string[], options: GitOptions = {}): Promise<string> {
  const result = await gitRun(args, options);
  if (result.code !== 0) throw failure(args, result);
  return result.stdout.toString("utf8").trim();
}

/** Streams a pack of `wanted` from one repository into another; `revs` walks a tree, else each line is an object. */
function copyObjects(fromGitDir: string, toRepo: string, wanted: string, revs: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const packArgs = ["--git-dir", fromGitDir, "pack-objects", "--stdout", ...(revs ? ["--revs"] : [])];
    const pack = spawnGit(packArgs);
    const index = spawnGit(["index-pack", "--stdin"], { cwd: toRepo });
    let packErr = "";
    let indexErr = "";
    pack.stderr.on("data", (chunk: Buffer) => { if (packErr.length < 16_384) packErr += chunk.toString("utf8"); });
    index.stderr.on("data", (chunk: Buffer) => { if (indexErr.length < 16_384) indexErr += chunk.toString("utf8"); });
    index.stdout.resume();
    pack.stdout.pipe(index.stdin);
    index.stdin.on("error", () => undefined);
    pack.stdin.on("error", () => undefined);
    let pending = 2;
    let failed: Error | undefined;
    const settle = (error?: Error) => {
      failed ??= error;
      if (--pending === 0) {
        if (failed) reject(failed); else resolve();
      }
    };
    pack.once("error", (error) => settle(error));
    index.once("error", (error) => settle(error));
    pack.once("close", (code) => settle(code === 0 ? undefined : new HostCommandError(`Could not read the objects to copy: ${packErr.trim().split("\n").at(-1) ?? code}`)));
    index.once("close", (code) => settle(code === 0 ? undefined : new HostCommandError(`Could not store the copied objects: ${indexErr.trim().split("\n").at(-1) ?? code}`)));
    pack.stdin.end(wanted);
  });
}

/** The user's own name and email; without them git would refuse, so the commit names Tau. */
async function identityEnv(repo: string): Promise<Record<string, string>> {
  const read = async (key: string) => (await gitRun(["config", "--get", key], { cwd: repo })).stdout.toString("utf8").trim();
  const [name, email] = await Promise.all([read("user.name"), read("user.email")]);
  return {
    ...(name ? {} : { GIT_AUTHOR_NAME: "Tau", GIT_COMMITTER_NAME: "Tau" }),
    ...(email ? {} : { GIT_AUTHOR_EMAIL: "tau@localhost", GIT_COMMITTER_EMAIL: "tau@localhost" }),
  };
}

async function withTempIndex<T>(run: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tau-index-"));
  try {
    return await run({ GIT_INDEX_FILE: join(dir, "index") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A path inside the repository: relative, forward slashes, no `..`, nothing below `.git`. */
export function isRepoPath(path: unknown): path is string {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  return parts.every((part) => part && part !== "." && part !== "..") && !parts.some((part) => part.toLowerCase() === ".git");
}

const isRef = (value: unknown): value is string => typeof value === "string" && /^refs\/[A-Za-z0-9._/-]+$/u.test(value) && !value.includes("..") && !value.endsWith("/");

export interface TreeSource {
  /** A repository (bare or not) that holds the tree. */
  gitDir: string;
  /** The ref whose tree is read, `refs/…`. */
  ref: string;
  /** Where the tree goes in the new repository; `""` for the top. */
  prefix: string;
}

export interface RepoFromTreeInput {
  path: string;
  trees: TreeSource[];
  /** Working-tree files added on top of the trees (a `.gitignore` the caller wrote). */
  files: string[];
  /** Lines for `.git/info/exclude`: ignored here without a file in the working tree. */
  exclude: string[];
  message: string;
}

export interface RepoFromTreeResult {
  commit: string;
  branch: string;
  files: number;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});
const text = (value: unknown, key: string): string => {
  const found = record(value)[key];
  if (typeof found !== "string" || !found.trim()) throw new HostCommandError(`Workspace command needs "${key}".`);
  return found;
};
const lines = (value: unknown): string[] => (Array.isArray(value) ? value.filter((line): line is string => typeof line === "string" && !/[\r\n]/u.test(line)) : []);

export function decodeRepoFromTree(input: unknown): Omit<RepoFromTreeInput, "path"> {
  const raw = record(input);
  if (!Array.isArray(raw.trees) || raw.trees.length === 0) throw new HostCommandError("Name the tree the repository starts from.");
  const prefixes = new Set<string>();
  const trees = raw.trees.map((entry): TreeSource => {
    const tree = record(entry);
    if (typeof tree.gitDir !== "string" || !tree.gitDir) throw new HostCommandError("Each tree needs its repository.");
    if (!isRef(tree.ref)) throw new HostCommandError("Each tree needs a ref under refs/.");
    const prefix = typeof tree.prefix === "string" ? tree.prefix.replace(/^\/+|\/+$/gu, "") : "";
    if (prefix && !isRepoPath(prefix)) throw new HostCommandError(`"${prefix}" is no folder inside the project.`);
    if (prefixes.has(prefix)) throw new HostCommandError(`Two trees go to "${prefix || "the top"}".`);
    prefixes.add(prefix);
    return { gitDir: tree.gitDir, ref: tree.ref, prefix };
  });
  const files = Array.isArray(raw.files) ? raw.files : [];
  if (!files.every(isRepoPath)) throw new HostCommandError("Name files by their path inside the project.");
  return { trees, files: files as string[], exclude: lines(raw.exclude), message: text(input, "message") };
}

/**
 * `git init` in a folder without Git, then one commit whose tree is the named
 * trees (and files), on the branch a new repository starts on. The index
 * matches that commit afterwards; the working tree is left as it was, so
 * `git status` shows exactly where it differs.
 */
export async function repoFromTree(input: RepoFromTreeInput): Promise<RepoFromTreeResult> {
  const { path } = input;
  if (!(await stat(path).catch(() => undefined))?.isDirectory()) throw new HostCommandError(`${path} is not a folder.`);
  if (await lstat(join(path, ".git")).catch(() => undefined)) throw new HostCommandError(`${path} already has a Git repository.`);
  const branch = (await gitRun(["config", "--get", "init.defaultBranch"], { cwd: path })).stdout.toString("utf8").trim() || "main";
  await git(["init", "--quiet", `--initial-branch=${branch}`], { cwd: path });
  try {
    const trees: Array<{ tree: string; prefix: string }> = [];
    for (const source of input.trees) {
      const tree = await git(["--git-dir", source.gitDir, "rev-parse", "--verify", "--end-of-options", `${source.ref}^{tree}`]);
      await copyObjects(source.gitDir, path, `${tree}\n`, true);
      trees.push({ tree, prefix: source.prefix });
    }
    // The top goes first: `read-tree` without a prefix replaces what the index holds.
    trees.sort((a, b) => (a.prefix === "" ? -1 : b.prefix === "" ? 1 : a.prefix.localeCompare(b.prefix)));
    const tree = await withTempIndex(async (env) => {
      for (const { tree: id, prefix } of trees) await git(["read-tree", ...(prefix ? [`--prefix=${prefix}/`] : []), id], { cwd: path, env });
      for (const file of input.files) {
        const info = await lstat(join(path, ...file.split("/"))).catch(() => undefined);
        if (!info?.isFile()) throw new HostCommandError(`${file} is not a file in the folder.`);
        const blob = await git(["hash-object", "-w", "--", file], { cwd: path });
        await git(["update-index", "--add", "--cacheinfo", `${info.mode & 0o111 ? "100755" : "100644"},${blob},${file}`], { cwd: path, env });
      }
      return git(["write-tree"], { cwd: path, env });
    });
    const commit = await git(["commit-tree", tree, "-F", "-"], { cwd: path, env: await identityEnv(path), input: input.message });
    await git(["update-ref", "-m", "tau: first commit", `refs/heads/${branch}`, commit, ""], { cwd: path });
    if (input.exclude.length) {
      const info = join(path, ".git", "info");
      await mkdir(info, { recursive: true });
      const existing = await readFile(join(info, "exclude"), "utf8").catch(() => "");
      await appendFile(join(info, "exclude"), `${existing && !existing.endsWith("\n") ? "\n" : ""}${input.exclude.join("\n")}\n`);
    }
    await git(["read-tree", commit], { cwd: path });
    // Fills in the stat data; exit 1 only says some files differ.
    await gitRun(["update-index", "-q", "--refresh"], { cwd: path });
    const listed = await git(["ls-tree", "-r", "-z", "--name-only", commit], { cwd: path });
    return { commit, branch, files: listed ? listed.split("\0").filter(Boolean).length : 0 };
  } catch (error) {
    // The folder had no Git before; a half-made repository would only block the next try.
    await rm(join(path, ".git"), { recursive: true, force: true });
    throw error;
  }
}

export interface BranchFile {
  path: string;
  /** The content; absent for a deletion. */
  blob?: string;
  mode?: "100644" | "100755";
  delete?: boolean;
}

export interface CommitFilesInput {
  repo: string;
  branch: string;
  /** The parent commit; `HEAD` when absent. */
  base: string;
  message: string;
  /** A repository the blobs are copied from; without one they must be in the project already. */
  objects?: string;
  files: BranchFile[];
  /** `suffix` (the default) takes `<branch>-2`, `-3`, … when the name is taken. */
  onExists: "suffix" | "fail";
}

export interface CommitFilesResult {
  branch: string;
  commit: string;
  parent: string;
}

export function decodeCommitFiles(input: unknown): Omit<CommitFilesInput, "repo"> {
  const raw = record(input);
  if (!Array.isArray(raw.files) || raw.files.length === 0) throw new HostCommandError("Name the files to commit.");
  const seen = new Set<string>();
  const files = raw.files.map((entry): BranchFile => {
    const file = record(entry);
    if (!isRepoPath(file.path)) throw new HostCommandError("Name files by their path inside the project.");
    if (seen.has(file.path)) throw new HostCommandError(`${file.path} is named twice.`);
    seen.add(file.path);
    if (file.delete === true) return { path: file.path, delete: true };
    if (typeof file.blob !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(file.blob)) throw new HostCommandError(`${file.path} needs a blob id.`);
    return { path: file.path, blob: file.blob, mode: file.mode === "100755" ? "100755" : "100644" };
  });
  const base = typeof raw.base === "string" && raw.base.trim() ? raw.base.trim() : "HEAD";
  if (base.startsWith("-")) throw new HostCommandError("The base is a commit or a ref.");
  return {
    branch: text(input, "branch").trim(),
    base,
    message: text(input, "message"),
    ...(typeof raw.objects === "string" && raw.objects ? { objects: raw.objects } : {}),
    files,
    onExists: raw.onExists === "fail" ? "fail" : "suffix",
  };
}

/**
 * One commit on a new branch: the base's tree with `files` put in or taken
 * out. The working tree, the index and HEAD stay as they are.
 */
export async function commitFilesToBranch(input: CommitFilesInput): Promise<CommitFilesResult> {
  const { repo } = input;
  const format = await gitRun(["check-ref-format", "--branch", input.branch], { cwd: repo });
  if (format.code !== 0) throw new HostCommandError(`"${input.branch}" is not a branch name.`);
  const parent = await git(["rev-parse", "--verify", "--end-of-options", `${input.base}^{commit}`], { cwd: repo });
  const blobs = [...new Set(input.files.flatMap((file) => (file.blob ? [file.blob] : [])))];
  if (input.objects && blobs.length) await copyObjects(input.objects, repo, `${blobs.join("\n")}\n`, false);
  if (blobs.length) {
    const check = await git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { cwd: repo, input: `${blobs.join("\n")}\n` });
    const missing = check.split("\n").filter((line) => !line.endsWith(" blob"));
    if (missing.length) throw new HostCommandError(`The project has no blob ${missing[0]!.split(" ")[0]}.`);
  }
  const zero = "0".repeat(parent.length);
  const tree = await withTempIndex(async (env) => {
    await git(["read-tree", parent], { cwd: repo, env });
    const records = input.files.map((file) => (file.delete ? `0 ${zero}\t${file.path}` : `${file.mode ?? "100644"} ${file.blob}\t${file.path}`));
    await git(["update-index", "-z", "--index-info"], { cwd: repo, env, input: `${records.join("\0")}\0` });
    return git(["write-tree"], { cwd: repo, env });
  });
  const commit = await git(["commit-tree", tree, "-p", parent, "-F", "-"], { cwd: repo, env: await identityEnv(repo), input: input.message });
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const branch = attempt === 1 ? input.branch : `${input.branch}-${attempt}`;
    // An empty old value: create only, never move a branch that is there.
    const created = await gitRun(["update-ref", "-m", "tau: commit files", `refs/heads/${branch}`, commit, ""], { cwd: repo });
    if (created.code === 0) return { branch, commit, parent };
    const taken = (await gitRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo })).code === 0;
    if (!taken) throw failure(["update-ref"], created);
    if (input.onExists === "fail") throw new HostCommandError(`The branch ${branch} exists already.`);
  }
  throw new HostCommandError(`No free name for ${input.branch}.`);
}
