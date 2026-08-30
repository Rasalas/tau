import { execFile } from "node:child_process";
import { mkdir, open, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  ChangeStatus,
  CommitResult,
  DiffLoadOptions,
  UiChangedFile,
  UiDiffHunk,
  UiDiffLine,
  UiEditor,
  UiFileDiff,
  UiRef,
  UiWorktree,
  UiWorkspaceChanges,
  WorkspaceInfo,
} from "../shared/contracts.js";

const execFileAsync = promisify(execFile);

const EMPTY_CHANGES: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };

// Diff ceilings keep generated files from turning one review into an unbounded IPC payload.
export const MAX_DIFF_BYTES = 1_024 * 1_024;
export const MAX_DIFF_LINES = 10_000;
export const MAX_DIFF_HUNKS = 120;

/** Editors we know how to launch, in the order the "Open in…" menu offers them. */
const KNOWN_EDITORS: ReadonlyArray<UiEditor> = [
  { id: "zed", name: "Zed" },
  { id: "cursor", name: "Cursor" },
  { id: "code", name: "VS Code" },
  { id: "subl", name: "Sublime Text" },
  { id: "idea", name: "IntelliJ IDEA" },
  { id: "nvim", name: "Neovim" },
];

export type GitRunner = (cwd: string, args: string[], maxBuffer?: number, signal?: AbortSignal) => Promise<string>;

export async function runGitCommand(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    maxBuffer,
    timeout: 10_000,
    signal,
  });
  return stdout;
}

const git: GitRunner = runGitCommand;

function statusFromCode(code: string): ChangeStatus {
  if (code.includes("?")) return "untracked";
  if (code.includes("R")) return "renamed";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  return "modified";
}

function describe(path: string): Pick<UiChangedFile, "name" | "directory"> {
  const directory = dirname(path);
  return { name: basename(path), directory: directory === "." ? "" : directory };
}

/**
 * `git status --porcelain -z` emits `XY path\0`, and for renames a second
 * `\0`-terminated field holding the original path.
 */
function parseStatus(stdout: string): Map<string, ChangeStatus> {
  const statuses = new Map<string, ChangeStatus>();
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (!path) continue;
    statuses.set(path, statusFromCode(code));
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return statuses;
}

/**
 * `git diff --numstat -z` emits `added\tremoved\tpath\0`; for renames the path
 * field is empty and the old and new paths follow as their own records.
 */
function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>();
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/u.exec(tokens[index] ?? "");
    if (!match) continue;
    let path = match[3];
    if (!path) {
      index += 2;
      path = tokens[index] ?? "";
      if (!path) continue;
    }
    counts.set(path, {
      added: match[1] === "-" ? 0 : Number(match[1]),
      removed: match[2] === "-" ? 0 : Number(match[2]),
    });
  }
  return counts;
}

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

/** A starting point for the commit box — the shape of the change, not a summary of it. */
function proposeMessage(files: UiChangedFile[]): string | undefined {
  if (files.length === 0) return undefined;
  const areas = [...new Set(files.map((file) => file.directory.split("/")[0] || file.name))];
  const scope = areas.length === 1 ? areas[0] : `${areas.length} areas`;
  const subject = files.length === 1 ? files[0].name : `${files.length} files`;
  return `chore(${scope}): update ${subject}`;
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
      worktreeParent: worktreeParentFor(cwd),
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
    const [rootOut, branchOut, statusOut, numstatOut, worktreeOut, refOut] = await Promise.all([
      run(["rev-parse", "--show-toplevel"]),
      run(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
      run(["status", "--porcelain", "-z"]),
      run(["diff", "--numstat", "-z", "HEAD"]).catch(() => ""),
      run(["worktree", "list", "--porcelain"]),
      run(["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", "refs/heads"]),
    ]);
    const workspaceRoot = rootOut.trim() || cwd;
    const branch = branchOut.trim() && branchOut.trim() !== "HEAD" ? branchOut.trim() : branchOut.trim() ? "detached" : undefined;
    const statuses = parseStatus(statusOut);
    const counts = parseNumstat(numstatOut);
    const files: UiChangedFile[] = [];
    const untracked = [...statuses].filter(([, status]) => status === "untracked");
    const stats = new Map<string, number>();
    const limit = 4;
    for (let index = 0; index < untracked.length; index += limit) {
      await Promise.all(untracked.slice(index, index + limit).map(async ([path]) => {
        stats.set(path, await countUntrackedLines(cwd, path, options.untrackedStats));
      }));
    }
    for (const [path, status] of statuses) {
      const counted = counts.get(path);
      const added = counted?.added ?? (status === "untracked" ? stats.get(path) ?? 0 : 0);
      files.push({ path, ...describe(path), status, added, removed: counted?.removed ?? 0 });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const changes: UiWorkspaceChanges = {
      branch,
      files,
      added: files.reduce((total, file) => total + file.added, 0),
      removed: files.reduce((total, file) => total + file.removed, 0),
      proposedMessage: proposeMessage(files),
    };

    const worktrees = parseWorktrees(worktreeOut, workspaceRoot);
    const heldByWorktree = new Map(
      worktrees.filter((tree) => tree.branch).map((tree) => [tree.branch as string, tree.path]),
    );
    const refs: UiRef[] = refOut.split("\\n").map((line) => line.trim()).filter(Boolean).map((name) => ({
      name,
      isCurrent: name === branch,
      worktreePath: heldByWorktree.get(name),
    }));
    const mainRoot = worktrees.find((tree) => tree.isMain)?.path ?? workspaceRoot;
    const workspace: WorkspaceInfo = {
      root: workspaceRoot,
      isRepo: true,
      isDirty: statusOut.trim().length > 0,
      branch,
      worktrees,
      refs,
      worktreeParent: worktreeParentFor(mainRoot),
    };
    return { changes, workspace, branch };
  } catch (error) {
    if (options.throwOnError) throw error;
    return emptyProjectGitState(cwd);
  }
}

export function parseUnifiedDiff(path: string, patch: string, options: DiffLoadOptions = {}): UiFileDiff {
  const hunks: UiDiffHunk[] = [];
  let current: UiDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;

  const byteTruncated = Buffer.byteLength(patch, "utf8") > MAX_DIFF_BYTES;
  const boundedPatch = patch.slice(0, MAX_DIFF_BYTES);
  const rawLines = boundedPatch.split("\n");
  const lineTruncated = rawLines.length > MAX_DIFF_LINES;
  const boundedLines = rawLines.slice(0, MAX_DIFF_LINES);
  for (const raw of boundedLines) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { header: raw.slice(0, raw.indexOf("@@", 2) + 2) + header[3], lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    // "" is the artifact of the patch's trailing newline; a blank context line is " ".
    if (raw === "" || raw.startsWith("\\")) continue;

    let line: UiDiffLine;
    if (raw.startsWith("+")) {
      line = { kind: "added", newLine: newLine++, text: raw.slice(1) };
      added += 1;
    } else if (raw.startsWith("-")) {
      line = { kind: "removed", oldLine: oldLine++, text: raw.slice(1) };
      removed += 1;
    } else {
      line = { kind: "context", oldLine: oldLine++, newLine: newLine++, text: raw.slice(1) };
    }
    current.lines.push(line);
  }

  const offset = Math.max(0, options.hunkOffset ?? 0);
  const limit = Math.min(MAX_DIFF_HUNKS, Math.max(1, options.hunkLimit ?? MAX_DIFF_HUNKS));
  const visibleHunks = hunks.slice(offset, offset + limit);
  const truncated = byteTruncated || lineTruncated || hunks.length > offset + limit;
  return {
    path,
    added,
    removed,
    hunks: visibleHunks,
    truncated,
    nextHunkOffset: truncated ? offset + visibleHunks.length : undefined,
    note: truncated ? `Showing ${visibleHunks.length} of a large diff. Load more to continue.` : undefined,
  };
}

export async function getFileDiff(cwd: string, path: string, options: DiffLoadOptions = {}): Promise<UiFileDiff> {
  const empty = (note: string): UiFileDiff => ({ path, added: 0, removed: 0, hunks: [], note });
  try {
    let patch = await git(cwd, ["diff", "--no-ext-diff", "-U3", "HEAD", "--", path]);
    if (!patch.trim()) {
      // Untracked files have no HEAD side; diff them against an empty tree.
      patch = await git(cwd, ["diff", "--no-ext-diff", "-U3", "--no-index", "--", "/dev/null", path])
        .catch((error: { stdout?: string }) => error.stdout ?? "");
    }
    if (!patch.trim()) return empty("No textual changes.");
    if (/^Binary files /mu.test(patch)) return empty("Binary file — no line diff.");
    return parseUnifiedDiff(path, patch, options);
  } catch {
    return empty("Could not read this diff.");
  }
}

export async function commit(
  cwd: string,
  message: string,
  push: boolean,
  readChanges: (cwd: string) => Promise<UiWorkspaceChanges> = async (path) => (await readProjectGitState(path)).changes,
): Promise<CommitResult> {
  const subject = message.trim();
  if (!subject) throw new Error("A commit message is required.");
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", subject]);
  const committed = (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  let pushed = false;
  let detail = `Committed ${committed}`;
  if (push) {
    await git(cwd, ["push"], 8 * 1024 * 1024);
    pushed = true;
    detail = `Committed ${committed} and pushed`;
  }
  return { changes: await readChanges(cwd), pushed, detail };
}

export async function listEditors(): Promise<UiEditor[]> {
  const found = await Promise.all(KNOWN_EDITORS.map(async (editor) => {
    try {
      await execFileAsync("which", [editor.id]);
      return editor;
    } catch {
      return undefined;
    }
  }));
  return found.filter((editor): editor is UiEditor => Boolean(editor));
}

export async function openInEditor(cwd: string, editorId: string, path?: string): Promise<void> {
  if (!KNOWN_EDITORS.some((editor) => editor.id === editorId)) {
    throw new Error(`Unknown editor: ${editorId}`);
  }
  await execFileAsync(editorId, [path ? join(cwd, path) : cwd], { cwd });
}

/** Where added worktrees live: beside the repository, never inside it. */
function worktreeParentFor(mainRoot: string): string {
  return join(dirname(mainRoot), `${basename(mainRoot)}-worktrees`);
}

export function worktreeSlug(branch: string): string {
  return branch.replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "") || "worktree";
}

/**
 * `git worktree list --porcelain` emits blank-line separated records; the first
 * record is always the repository's primary checkout.
 */
function parseWorktrees(stdout: string, cwd: string): UiWorktree[] {
  const worktrees: UiWorktree[] = [];
  for (const block of stdout.split("\n\n")) {
    const path = /^worktree (.+)$/mu.exec(block)?.[1];
    if (!path) continue;
    const branch = /^branch refs\/heads\/(.+)$/mu.exec(block)?.[1];
    worktrees.push({
      path,
      name: basename(path),
      branch,
      isMain: worktrees.length === 0,
      isCurrent: path === cwd,
    });
  }
  return worktrees;
}

/** Defers to git's own rules rather than guessing at them. */
async function assertValidBranchName(cwd: string, name: string): Promise<void> {
  const invalid = new Error(`"${name}" is not a valid branch name.`);
  if (name.startsWith("-") || /[\s~^:?*[\\]/u.test(name)) throw invalid;
  try {
    await git(cwd, ["check-ref-format", "--branch", name]);
  } catch {
    throw invalid;
  }
}

/** Creates a branch and a worktree for it, and returns the new worktree path. */
export async function createWorktree(
  cwd: string,
  branch: string,
  readWorkspace: (cwd: string) => Promise<WorkspaceInfo> = async (path) => (await readProjectGitState(path)).workspace,
): Promise<string> {
  const name = branch.trim();
  if (!name) throw new Error("A branch name is required.");
  await assertValidBranchName(cwd, name);
  const info = await readWorkspace(cwd);
  if (!info.isRepo) throw new Error("This workspace is not a Git repository.");

  const existing = info.refs.find((ref) => ref.name === name);
  if (existing?.worktreePath) throw new Error(`${name} is already checked out in a worktree.`);

  const destination = join(info.worktreeParent, worktreeSlug(name));
  await mkdir(info.worktreeParent, { recursive: true });
  // Reuse the branch when it already exists; otherwise create it here.
  await git(cwd, existing
    ? ["worktree", "add", destination, name]
    : ["worktree", "add", "-b", name, destination]);
  return destination;
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
