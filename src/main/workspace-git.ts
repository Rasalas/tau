import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
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
  PushResult,
  UiRef,
  UiWorktree,
  UiWorkspaceChanges,
  UiWorkspaceChangesPage,
  WorkspaceInfo,
} from "../shared/contracts.js";
import {
  type StoredTurnCheckpoint,
  isTurnSnapshotId,
  namespacedSnapshotRef,
  sanitizeTurnSnapshotComponent,
  turnSnapshotRef,
} from "../shared/turn-checkpoint-codec.js";
import { normalizeDiffLoadOptions } from "../shared/turn-checkpoint-diff.js";

const execFileAsync = promisify(execFile);

const EMPTY_CHANGES: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

/** Rejects traversal and symlink escapes before any path is passed to Git. */
export async function assertWorkspacePath(cwd: string, path: string): Promise<void> {
  const target = resolve(cwd, path);
  if (!within(cwd, target)) throw new Error("Path is outside the workspace.");
  const rootReal = await realpath(cwd);
  let probe = target;
  while (true) {
    try {
      if (!within(rootReal, await realpath(probe))) throw new Error("Path is outside the workspace.");
      return;
    } catch (error) {
      if (error instanceof Error && error.message === "Path is outside the workspace.") throw error;
      if (probe === cwd) throw error;
      probe = dirname(probe);
    }
  }
}

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
export type SnapshotGitRunner = (
  cwd: string,
  args: string[],
  maxBuffer?: number,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

export async function runGitCommand(
  cwd: string,
  args: string[],
  maxBuffer = 4 * 1024 * 1024,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    maxBuffer,
    timeout: 10_000,
    signal,
    env,
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

export interface WorkspaceSnapshot {
  /** Stable namespaced ref persisted in the turn checkpoint. */
  id: string;
  ref: string;
  /** The tree object addressed by the ref, useful for diagnostics and tests. */
  treeId: string;
  /** Capture location/identity, used to clean provisional refs after a switch. */
  cwd?: string;
  sessionId?: string;
  turnId?: string;
  phase?: "before" | "after";
}

export interface WorkspaceSnapshotOptions {
  /** Session/turn namespace. It must not contain an empty or `..` component. */
  namespace: string;
  phase: "before" | "after";
  runGit?: SnapshotGitRunner;
}

export interface SnapshotDiffOptions {
  branch?: string;
  runGit?: GitRunner;
  expected?: SnapshotRefExpectation;
}

export interface SnapshotRefExpectation {
  sessionId: string;
  turnId: string;
}

export interface SnapshotPageOptions extends SnapshotRefExpectation {
  branch?: string;
  cursor?: string;
  limit?: number;
  runGit?: GitRunner;
}

const SNAPSHOT_GIT_BUFFER = 64 * 1024 * 1024;

function snapshotRef(namespace: string, phase: WorkspaceSnapshotOptions["phase"]): string {
  return namespacedSnapshotRef(namespace, phase);
}

/**
 * Captures the complete worktree into a temporary Git index and publishes only
 * its tree as a namespaced ref. The user's index and worktree are never used as
 * write targets. `git add -A` also folds tracked, deleted, and non-ignored
 * untracked files into the immutable tree, so a pre-existing dirty base is
 * naturally part of the before snapshot and drops out of the later diff.
 */
export async function createWorkspaceSnapshot(
  cwd: string,
  options: WorkspaceSnapshotOptions,
): Promise<WorkspaceSnapshot> {
  const runGit = options.runGit ?? git;
  const ref = snapshotRef(options.namespace, options.phase);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "tau-turn-snapshot-"));
  const temporaryIndex = join(temporaryDirectory, "index");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: temporaryIndex,
    GIT_OPTIONAL_LOCKS: "0",
  };
  const run = (args: string[], maxBuffer = SNAPSHOT_GIT_BUFFER): Promise<string> =>
    runGit(cwd, args, maxBuffer, undefined, env);
  try {
    await run(["rev-parse", "--is-inside-work-tree"]);
    const head = await run(["rev-parse", "--verify", "HEAD"]).catch(() => "");
    await run(head.trim() ? ["read-tree", head.trim()] : ["read-tree", "--empty"]);
    await run(["add", "-A"]);
    const treeId = (await run(["write-tree"])).trim();
    if (!/^[0-9a-f]{40,64}$/iu.test(treeId)) throw new Error("Git did not return a valid workspace snapshot tree.");
    // Publish once. A retry for the same turn may observe the existing tree,
    // but a ref that already points somewhere else must never be overwritten:
    // the IDs stored in a checkpoint are immutable historical boundaries.
    const existing = (await run(["rev-parse", "--verify", ref]).catch(() => "")).trim();
    if (existing && existing !== treeId) throw new Error(`Snapshot ref ${ref} already points to another tree.`);
    if (!existing) {
      try {
        // An all-zero old value makes creation conditional and remains valid
        // for both SHA-1 and SHA-256 repositories.
        await run(["update-ref", ref, treeId, "0".repeat(treeId.length)]);
      } catch (error) {
        // Another process may have won the create race. Accept it only when it
        // published the exact same tree; otherwise preserve the first value.
        const published = (await run(["rev-parse", "--verify", ref]).catch(() => "")).trim();
        if (published !== treeId) throw error;
      }
    }
    return { id: ref, ref, treeId, cwd };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Turn-specific wrapper that makes the persisted ref name derivation explicit. */
export async function createTurnWorkspaceSnapshot(
  cwd: string,
  sessionId: string,
  turnId: string,
  phase: "before" | "after",
  runGit?: SnapshotGitRunner,
): Promise<WorkspaceSnapshot> {
  const snapshot = await createWorkspaceSnapshot(cwd, {
    namespace: `${sanitizeTurnSnapshotComponent(sessionId)}/${sanitizeTurnSnapshotComponent(turnId)}`,
    phase,
    ...(runGit ? { runGit } : {}),
  });
  return { ...snapshot, cwd, sessionId, turnId, phase };
}

function validObjectId(value: string): boolean {
  return /^[0-9a-f]{40,64}$/iu.test(value.trim());
}

/**
 * Resolves both exact namespaced refs and verifies that each ref currently
 * addresses a tree. This is the restore/diff trust boundary: arbitrary refs,
 * swapped phases, and foreign session snapshots are rejected before Git sees
 * a historical operation.
 */
export async function validateWorkspaceSnapshotRefs(
  cwd: string,
  beforeSnapshotId: string,
  afterSnapshotId: string,
  expected: SnapshotRefExpectation,
  runGit: GitRunner = git,
): Promise<{ beforeTreeId: string; afterTreeId: string }> {
  const expectedBefore = turnSnapshotRef(expected.sessionId, expected.turnId, "before");
  const expectedAfter = turnSnapshotRef(expected.sessionId, expected.turnId, "after");
  if (beforeSnapshotId !== expectedBefore || afterSnapshotId !== expectedAfter) {
    throw new Error("Turn checkpoint snapshot refs do not match their session and turn.");
  }
  const [beforeTree, afterTree, beforeType, afterType] = await Promise.all([
    runGit(cwd, ["rev-parse", "--verify", `${expectedBefore}^{tree}`]),
    runGit(cwd, ["rev-parse", "--verify", `${expectedAfter}^{tree}`]),
    runGit(cwd, ["cat-file", "-t", expectedBefore]),
    runGit(cwd, ["cat-file", "-t", expectedAfter]),
  ]);
  const beforeTreeId = beforeTree.trim();
  const afterTreeId = afterTree.trim();
  if (!validObjectId(beforeTreeId) || !validObjectId(afterTreeId)
    || beforeType.trim() !== "tree" || afterType.trim() !== "tree") {
    throw new Error("Turn checkpoint snapshot refs are missing or do not address trees.");
  }
  return { beforeTreeId, afterTreeId };
}

function snapshotPairShape(
  beforeSnapshotId: string,
  afterSnapshotId: string,
): { namespace: string } | undefined {
  if (!isTurnSnapshotId(beforeSnapshotId) || !isTurnSnapshotId(afterSnapshotId)) return undefined;
  const beforeParts = beforeSnapshotId.split("/");
  const afterParts = afterSnapshotId.split("/");
  const beforePhase = beforeParts.at(-1);
  const afterPhase = afterParts.at(-1);
  const beforeNamespace = beforeParts.slice(3, -1).join("/");
  const afterNamespace = afterParts.slice(3, -1).join("/");
  if (beforePhase !== "before" || afterPhase !== "after" || beforeNamespace !== afterNamespace) return undefined;
  return { namespace: beforeNamespace };
}

/**
 * Forks inherit the conversation tree, but their checkpoint refs must live in
 * the new session namespace. Copy the immutable tree targets atomically and
 * remove only refs created by this operation if the second phase fails.
 */
export async function cloneTurnCheckpointRefs(
  cwd: string,
  sourceSessionId: string,
  targetSessionId: string,
  checkpoints: readonly StoredTurnCheckpoint[],
  runGit: GitRunner = git,
): Promise<void> {
  const created: Array<{ id: string; treeId: string }> = [];
  try {
    for (const checkpoint of checkpoints) {
      if (checkpoint.sessionId !== sourceSessionId
        || checkpoint.beforeSnapshotId !== turnSnapshotRef(sourceSessionId, checkpoint.turnId, "before")
        || checkpoint.afterSnapshotId !== turnSnapshotRef(sourceSessionId, checkpoint.turnId, "after")) {
        throw new Error("Cannot clone a checkpoint with a foreign snapshot namespace.");
      }
      const trees = await validateWorkspaceSnapshotRefs(
        cwd,
        checkpoint.beforeSnapshotId,
        checkpoint.afterSnapshotId,
        { sessionId: sourceSessionId, turnId: checkpoint.turnId },
        runGit,
      );
      for (const [phase, treeId] of [["before", trees.beforeTreeId], ["after", trees.afterTreeId]] as const) {
        const id = turnSnapshotRef(targetSessionId, checkpoint.turnId, phase);
        const existing = (await runGit(cwd, ["rev-parse", "--verify", id]).catch(() => "")).trim();
        if (existing && existing !== treeId) throw new Error(`Fork snapshot ref ${id} already points to another tree.`);
        if (existing) {
          const existingType = (await runGit(cwd, ["cat-file", "-t", id]).catch(() => "")).trim();
          if (existingType !== "tree") throw new Error(`Fork snapshot ref ${id} does not address a tree.`);
        }
        if (!existing) {
          await runGit(cwd, ["update-ref", id, treeId, "0".repeat(treeId.length)]);
          created.push({ id, treeId });
        }
      }
      await validateWorkspaceSnapshotRefs(
        cwd,
        turnSnapshotRef(targetSessionId, checkpoint.turnId, "before"),
        turnSnapshotRef(targetSessionId, checkpoint.turnId, "after"),
        { sessionId: targetSessionId, turnId: checkpoint.turnId },
        runGit,
      );
    }
  } catch (error) {
    await Promise.all(created.map(({ id, treeId }) => deleteWorkspaceSnapshot(
      cwd,
      id,
      { sessionId: targetSessionId, turnId: id.split("/").at(-2) ?? "", phase: id.endsWith("/after") ? "after" : "before", treeId },
      runGit,
    )));
    throw error;
  }
}

/** Removes only target refs whose trees match the source fork copy. */
export async function cleanupClonedTurnCheckpointRefs(
  cwd: string,
  sourceSessionId: string,
  targetSessionId: string,
  checkpoints: readonly StoredTurnCheckpoint[],
  runGit: GitRunner = git,
): Promise<void> {
  await Promise.all(checkpoints.map(async (checkpoint) => {
    if (checkpoint.sessionId !== sourceSessionId) return;
    const source = await validateWorkspaceSnapshotRefs(
      cwd,
      checkpoint.beforeSnapshotId,
      checkpoint.afterSnapshotId,
      { sessionId: sourceSessionId, turnId: checkpoint.turnId },
      runGit,
    ).catch(() => undefined);
    if (!source) return;
    await deleteWorkspaceSnapshot(
      cwd,
      turnSnapshotRef(targetSessionId, checkpoint.turnId, "before"),
      { sessionId: targetSessionId, turnId: checkpoint.turnId, phase: "before", treeId: source.beforeTreeId },
      runGit,
    );
    await deleteWorkspaceSnapshot(
      cwd,
      turnSnapshotRef(targetSessionId, checkpoint.turnId, "after"),
      { sessionId: targetSessionId, turnId: checkpoint.turnId, phase: "after", treeId: source.afterTreeId },
      runGit,
    );
  }));
}

/** Delete only a verified, namespaced snapshot ref. The real index/worktree are untouched. */
export async function deleteWorkspaceSnapshot(
  cwd: string,
  snapshotId: string,
  expected?: SnapshotRefExpectation & { phase?: "before" | "after"; treeId?: string },
  runGit: GitRunner = git,
): Promise<void> {
  if (!isTurnSnapshotId(snapshotId)) return;
  if (expected) {
    const phase = expected.phase ?? (snapshotId.endsWith("/after") ? "after" : "before");
    if (snapshotId !== turnSnapshotRef(expected.sessionId, expected.turnId, phase)) return;
    if (expected.treeId) {
      const current = (await runGit(cwd, ["rev-parse", "--verify", snapshotId]).catch(() => "")).trim();
      if (current && current !== expected.treeId) return;
    }
  }
  await runGit(cwd, ["update-ref", "-d", snapshotId]).catch(() => undefined);
}

/** Session/pruning hook: remove all refs owned by a completed checkpoint. */
export async function cleanupTurnCheckpointRefs(
  cwd: string,
  checkpoints: readonly SnapshotRefExpectation[],
  runGit: GitRunner = git,
): Promise<void> {
  for (const checkpoint of checkpoints) {
    await deleteWorkspaceSnapshot(cwd, turnSnapshotRef(checkpoint.sessionId, checkpoint.turnId, "before"), checkpoint, runGit);
    await deleteWorkspaceSnapshot(cwd, turnSnapshotRef(checkpoint.sessionId, checkpoint.turnId, "after"), { ...checkpoint, phase: "after" }, runGit);
  }
}

/** Garbage-collect every checkpoint ref owned by a session file that was deleted. */
export async function cleanupTurnCheckpointSessionRefs(
  cwd: string,
  sessionId: string,
  runGit: GitRunner = git,
): Promise<void> {
  const prefix = `refs/tau/checkpoints/${sanitizeTurnSnapshotComponent(sessionId)}/`;
  const refs = (await runGit(cwd, ["for-each-ref", "--format=%(refname)", prefix]).catch(() => ""))
    .split("\n")
    .map((ref) => ref.trim())
    .filter((ref) => isTurnSnapshotId(ref));
  await Promise.all(refs.map((ref) => runGit(cwd, ["update-ref", "-d", ref]).catch(() => undefined)));
}

/**
 * Crash recovery for the two-phase checkpoint write. A process can publish
 * immutable trees and die before its session custom entry is appended; those
 * refs are not discoverable by the UI and must not live forever. Keep only
 * complete, namespace-validated pairs represented by the durable entries.
 */
export async function cleanupOrphanTurnCheckpointRefs(
  cwd: string,
  sessionId: string,
  checkpoints: readonly StoredTurnCheckpoint[],
  runGit: GitRunner = git,
): Promise<void> {
  const prefix = `refs/tau/checkpoints/${sanitizeTurnSnapshotComponent(sessionId)}/`;
  const refs = (await runGit(cwd, ["for-each-ref", "--format=%(refname)", prefix]).catch(() => ""))
    .split("\n")
    .map((ref) => ref.trim())
    .filter((ref) => isTurnSnapshotId(ref));
  const refSet = new Set(refs);
  const valid = new Set<string>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.sessionId !== sessionId) continue;
    try {
      const before = turnSnapshotRef(sessionId, checkpoint.turnId, "before");
      const after = turnSnapshotRef(sessionId, checkpoint.turnId, "after");
      // A durable entry is valid only when both deterministic refs still
      // exist and both resolve to trees in the expected namespace. This also
      // removes half-written pairs left by a crash or a failed ref update.
      if (!refSet.has(before) || !refSet.has(after)) continue;
      await validateWorkspaceSnapshotRefs(cwd, before, after, { sessionId, turnId: checkpoint.turnId }, runGit);
      valid.add(before);
      valid.add(after);
    } catch {
      // Malformed or incomplete persisted entries are ignored; their refs are
      // intentionally treated as orphaned and removed below.
    }
  }
  await Promise.all(refs.filter((ref) => !valid.has(ref)).map((ref) => runGit(cwd, ["update-ref", "-d", ref]).catch(() => undefined)));
}

function snapshotStatus(value: string): ChangeStatus {
  if (value.startsWith("A")) return "added";
  if (value.startsWith("D")) return "deleted";
  if (value.startsWith("R") || value.startsWith("C")) return "renamed";
  return "modified";
}

/** Parse `git diff --name-status -z` without interpreting file contents. */
function parseSnapshotNameStatus(stdout: string): Map<string, ChangeStatus> {
  const statuses = new Map<string, ChangeStatus>();
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++] ?? "";
    if (!code) continue;
    const oldPath = tokens[index++] ?? "";
    const isRename = code.startsWith("R") || code.startsWith("C");
    const path = isRename ? (tokens[index++] ?? oldPath) : oldPath;
    if (path) statuses.set(path, snapshotStatus(code));
  }
  return statuses;
}

/**
 * Produces one checkpoint summary from the two immutable trees. It performs a
 * numstat and a name-status scan, but never opens a per-file patch; the latter
 * is reserved for `getSnapshotFileDiff` when a user explicitly opens a file.
 */
export async function diffWorkspaceSnapshots(
  cwd: string,
  beforeSnapshotId: string,
  afterSnapshotId: string,
  options: SnapshotDiffOptions = {},
): Promise<UiWorkspaceChanges> {
  if (!isTurnSnapshotId(beforeSnapshotId) || !isTurnSnapshotId(afterSnapshotId)) {
    throw new Error("Invalid turn checkpoint snapshot ID.");
  }
  if (!snapshotPairShape(beforeSnapshotId, afterSnapshotId)) {
    throw new Error("Turn checkpoint snapshot refs must be an ordered before/after pair in one namespace.");
  }
  const runGit = options.runGit ?? git;
  if (options.expected) await validateWorkspaceSnapshotRefs(cwd, beforeSnapshotId, afterSnapshotId, options.expected, runGit);
  const args = ["diff", "--no-ext-diff", "--find-renames", "--numstat", "-z", beforeSnapshotId, afterSnapshotId, "--"];
  const statusArgs = ["diff", "--no-ext-diff", "--find-renames", "--name-status", "-z", beforeSnapshotId, afterSnapshotId, "--"];
  const [numstat, nameStatus] = await Promise.all([
    runGit(cwd, args, SNAPSHOT_GIT_BUFFER),
    runGit(cwd, statusArgs, SNAPSHOT_GIT_BUFFER),
  ]);
  const counts = parseNumstat(numstat);
  const statuses = parseSnapshotNameStatus(nameStatus);
  const paths = new Set([...counts.keys(), ...statuses.keys()]);
  const files: UiChangedFile[] = [...paths].filter(Boolean).map((path) => {
    const counted = counts.get(path) ?? { added: 0, removed: 0 };
    return {
      path,
      ...describe(path),
      status: statuses.get(path) ?? "modified",
      added: counted.added,
      removed: counted.removed,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return {
    ...(options.branch ? { branch: options.branch } : {}),
    files,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
    proposedMessage: proposeMessage(files),
  };
}

const MAX_SNAPSHOT_FILE_PAGE = 40;

function snapshotCursor(cursor: string | undefined, total: number): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/u.test(cursor)) throw new Error("Invalid turn file cursor.");
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new Error("Invalid turn file cursor.");
  return offset;
}

/** Loads a bounded file-list page from Git; no complete list crosses the API seam. */
export async function diffWorkspaceSnapshotPage(
  cwd: string,
  beforeSnapshotId: string,
  afterSnapshotId: string,
  options: SnapshotPageOptions,
): Promise<UiWorkspaceChangesPage> {
  const runGit = options.runGit ?? git;
  const changes = await diffWorkspaceSnapshots(cwd, beforeSnapshotId, afterSnapshotId, {
    branch: options.branch,
    runGit,
    expected: { sessionId: options.sessionId, turnId: options.turnId },
  });
  const offset = snapshotCursor(options.cursor, changes.files.length);
  const requestedLimit = Number.isFinite(options.limit) ? Math.floor(options.limit as number) : MAX_SNAPSHOT_FILE_PAGE;
  const limit = Math.min(MAX_SNAPSHOT_FILE_PAGE, Math.max(1, requestedLimit));
  const files = changes.files.slice(offset, offset + limit).map((file) => ({ ...file }));
  const nextCursor = offset + files.length < changes.files.length ? String(offset + files.length) : undefined;
  return {
    branch: changes.branch,
    files,
    fileCount: changes.files.length,
    added: changes.added,
    removed: changes.removed,
    proposedMessage: changes.proposedMessage,
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(nextCursor ? { nextCursor } : {}),
    hasMore: Boolean(nextCursor),
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
      run(["status", "--porcelain", "-z"]),
      run(["diff", "--numstat", "-z", "HEAD"]).catch(() => ""),
      run(["worktree", "list", "--porcelain"]),
      run(["for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)", "--sort=-committerdate", "refs/heads"]),
    ]);
    const workspaceRoot = rootOut.trim() || cwd;
    const worktrees = parseWorktrees(worktreeOut, workspaceRoot);
    const branch = worktrees.find((tree) => tree.isCurrent)?.branch;
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

    const heldByWorktree = new Map(
      worktrees.filter((tree) => tree.branch && tree.branch !== "detached").map((tree) => [tree.branch as string, tree.path]),
    );
    const refMetadata = refOut.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name, upstream, tracking = ""] = line.split("\t");
      return {
        name,
        upstream: upstream || undefined,
        ahead: Number(/ahead (\d+)/u.exec(tracking)?.[1] ?? 0),
        behind: Number(/behind (\d+)/u.exec(tracking)?.[1] ?? 0),
      };
    });
    const refs: UiRef[] = refMetadata.map(({ name }) => ({
      name,
      isCurrent: name === branch,
      worktreePath: heldByWorktree.get(name),
    }));
    const currentRef = refMetadata.find((ref) => ref.name === branch);
    const mainRoot = worktrees.find((tree) => tree.isMain)?.path ?? workspaceRoot;
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
      worktreeParent: worktreeParentFor(mainRoot),
    };
    return { changes, workspace, branch };
  } catch (error) {
    if (options.throwOnError) throw error;
    return emptyProjectGitState(cwd);
  }
}

export function parseUnifiedDiff(path: string, patch: string, options: DiffLoadOptions = {}, sourceTruncated = false): UiFileDiff {
  const hunks: UiDiffHunk[] = [];
  let current: UiDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;

  const patchBytes = Buffer.from(patch, "utf8");
  const byteTruncated = sourceTruncated || patchBytes.length > MAX_DIFF_BYTES;
  const bytePrefix = byteTruncated ? patchBytes.subarray(0, MAX_DIFF_BYTES).toString("utf8") : patch;
  const boundedPatch = byteTruncated ? bytePrefix.slice(0, bytePrefix.lastIndexOf("\n") + 1) : bytePrefix;
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

  const { hunkOffset: offset, hunkLimit: limit } = normalizeDiffLoadOptions(options, MAX_DIFF_HUNKS);
  const visibleHunks = hunks.slice(offset, offset + limit);
  const hasMoreParsedHunks = hunks.length > offset + visibleHunks.length;
  const truncated = byteTruncated || lineTruncated || hasMoreParsedHunks;
  return {
    path,
    added,
    removed,
    hunks: visibleHunks,
    truncated,
    nextHunkOffset: hasMoreParsedHunks ? offset + visibleHunks.length : undefined,
    note: hasMoreParsedHunks
      ? `Showing ${visibleHunks.length} hunks. Load more to continue.`
      : byteTruncated || lineTruncated
        ? "Diff truncated at the host byte or line limit. Open the file in an editor for the complete patch."
        : undefined,
  };
}

interface StreamedPatch {
  patch: string;
  capturedHunks: number;
  hasMoreHunks: boolean;
  terminalTruncation: boolean;
}

/**
 * Reads only the requested hunk window from git's stdout. Earlier hunks are
 * scanned but never retained, and the child is stopped as soon as the next
 * page or a terminal byte/line ceiling is known.
 */
async function streamFilePatch(
  cwd: string,
  args: string[],
  options: DiffLoadOptions,
  allowNoIndexDifference = false,
): Promise<StreamedPatch> {
  const { hunkOffset: offset, hunkLimit: limit } = normalizeDiffLoadOptions(options, MAX_DIFF_HUNKS);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.quotePath=false", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let pending = "";
    let stderr = "";
    let header = "";
    let selected = "";
    let hunkIndex = -1;
    let capturedHunks = 0;
    let selectedLines = 0;
    let selectedBytes = 0;
    let hasMoreHunks = false;
    let terminalTruncation = false;
    let stopped = false;
    let discardingLine = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
    };
    const appendSelected = (line: string) => {
      const bytes = Buffer.byteLength(`${line}\n`, "utf8");
      if (selectedLines >= MAX_DIFF_LINES || selectedBytes + bytes > MAX_DIFF_BYTES) {
        terminalTruncation = true;
        stop();
        return;
      }
      selected += `${line}\n`;
      selectedLines += 1;
      selectedBytes += bytes;
    };
    const consumeLine = (line: string) => {
      if (line.startsWith("@@")) {
        hunkIndex += 1;
        if (hunkIndex >= offset + limit) {
          hasMoreHunks = true;
          stop();
          return;
        }
        if (hunkIndex >= offset) capturedHunks += 1;
      }
      if (hunkIndex < 0) {
        if (Buffer.byteLength(header, "utf8") < 64 * 1024) header += `${line}\n`;
      } else if (hunkIndex >= offset) {
        appendSelected(line);
      }
    };
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      if (discardingLine) {
        const newline = pending.indexOf("\n");
        if (newline < 0) { pending = ""; return; }
        pending = pending.slice(newline + 1);
        discardingLine = false;
      }
      let newline = pending.indexOf("\n");
      while (!stopped && newline >= 0) {
        consumeLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (stopped) return;
      const pendingBytes = Buffer.byteLength(pending, "utf8");
      if (hunkIndex >= 0 && hunkIndex < offset && pendingBytes > 64 * 1024) {
        pending = "";
        discardingLine = true;
      } else if (hunkIndex >= offset && selectedBytes + pendingBytes > MAX_DIFF_BYTES) {
        pending = "";
        terminalTruncation = true;
        stop();
      } else if (hunkIndex < 0 && pendingBytes > 64 * 1024) {
        pending = "";
        terminalTruncation = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    const timeout = setTimeout(() => {
      terminalTruncation = true;
      stop();
    }, 10_000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (!stopped && pending) consumeLine(pending);
      if (!stopped && code !== 0 && !(allowNoIndexDifference && code === 1)) {
        reject(new Error(stderr.trim() || `git diff exited with ${code}`));
        return;
      }
      resolve({ patch: header + selected, capturedHunks, hasMoreHunks, terminalTruncation });
    });
  });
}

export async function getFileDiff(cwd: string, path: string, options: DiffLoadOptions = {}): Promise<UiFileDiff> {
  const empty = (note: string): UiFileDiff => ({ path, added: 0, removed: 0, hunks: [], note });
  try {
    let streamed = await streamFilePatch(cwd, ["diff", "--no-ext-diff", "-U3", "HEAD", "--", path], options);
    if (!streamed.patch.trim()) {
      // Untracked files have no HEAD side; diff them against an empty tree.
      streamed = await streamFilePatch(cwd, ["diff", "--no-ext-diff", "-U3", "--no-index", "--", "/dev/null", path], options, true);
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

/**
 * Loads one file's historical patch directly from the immutable before/after
 * snapshots. No checkpoint entry contains patch bytes, and this call performs
 * one `git diff <before> <after> -- <path>` on demand.
 */
export async function getSnapshotFileDiff(
  cwd: string,
  beforeSnapshotId: string,
  afterSnapshotId: string,
  path: string,
  options: DiffLoadOptions = {},
  expected?: SnapshotRefExpectation,
): Promise<UiFileDiff> {
  const empty = (note: string): UiFileDiff => ({ path, added: 0, removed: 0, hunks: [], note });
  if (!isTurnSnapshotId(beforeSnapshotId) || !isTurnSnapshotId(afterSnapshotId)) {
    return empty("This turn checkpoint is no longer available.");
  }
  if (!snapshotPairShape(beforeSnapshotId, afterSnapshotId)) {
    return empty("This turn checkpoint is no longer available.");
  }
  try {
    if (expected) await validateWorkspaceSnapshotRefs(cwd, beforeSnapshotId, afterSnapshotId, expected);
    const streamed = await streamFilePatch(
      cwd,
      ["diff", "--no-ext-diff", "--find-renames", "-U3", beforeSnapshotId, afterSnapshotId, "--", path],
      options,
    );
    if (!streamed.patch.trim()) return empty("No textual changes.");
    if (/^Binary files /mu.test(streamed.patch)) return empty("Binary file — no line diff.");
    const result = parseUnifiedDiff(path, streamed.patch, {}, streamed.terminalTruncation);
    if (streamed.hasMoreHunks) {
      const offset = normalizeDiffLoadOptions(options, MAX_DIFF_HUNKS).hunkOffset;
      return {
        ...result,
        truncated: true,
        nextHunkOffset: offset + streamed.capturedHunks,
        note: `Showing ${streamed.capturedHunks} hunks. Load more to continue.`,
      };
    }
    return result;
  } catch {
    return empty("Could not read this historical diff.");
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

export async function push(cwd: string, runGit: GitRunner = git): Promise<PushResult> {
  await runGit(cwd, ["push"], 8 * 1024 * 1024);
  const committed = (await runGit(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  return { detail: `Pushed ${committed}` };
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
    const branch = /^branch refs\/heads\/(.+)$/mu.exec(block)?.[1] ?? (/^detached$/mu.test(block) ? "detached" : undefined);
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
async function assertValidBranchName(cwd: string, name: string, runGit: GitRunner = git): Promise<void> {
  const invalid = new Error(`"${name}" is not a valid branch name.`);
  if (name.startsWith("-") || /[\s~^:?*[\\]/u.test(name)) throw invalid;
  try {
    await runGit(cwd, ["check-ref-format", "--branch", name]);
  } catch {
    throw invalid;
  }
}

async function prepareWorktreeBase(cwd: string, baseRef: string, runGit: GitRunner): Promise<string> {
  const base = baseRef.trim() || "HEAD";
  const remotes = (await runGit(cwd, ["remote"]).catch(() => ""))
    .split("\n")
    .map((remote) => remote.trim())
    .filter(Boolean);
  const remote = remotes.find((candidate) => base.startsWith(`${candidate}/`));
  if (remote) await runGit(cwd, ["fetch", "--prune", remote], 8 * 1024 * 1024);
  try {
    await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  } catch {
    throw new Error(`The worktree base "${base}" does not exist.`);
  }
  return base;
}

/** Returns one stable project name for a repository and all of its linked worktrees. */
export async function repositoryDisplayName(cwd: string, runGit: GitRunner = git): Promise<string> {
  try {
    const commonDir = (await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const absoluteCommonDir = resolve(cwd, commonDir);
    return basename(dirname(absoluteCommonDir)) || basename(cwd) || cwd;
  } catch {
    return basename(cwd) || cwd;
  }
}

/** Creates a branch and a worktree for it, and returns the new worktree path. */
export async function createWorktree(
  cwd: string,
  branch: string,
  baseRef?: string,
  readWorkspace: (cwd: string) => Promise<WorkspaceInfo> = async (path) => (await readProjectGitState(path)).workspace,
  runGit: GitRunner = git,
): Promise<string> {
  const name = branch.trim();
  if (!name) throw new Error("A branch name is required.");
  await assertValidBranchName(cwd, name, runGit);
  const info = await readWorkspace(cwd);
  if (!info.isRepo) throw new Error("This workspace is not a Git repository.");

  const existing = info.refs.find((ref) => ref.name === name);
  if (existing?.worktreePath) throw new Error(`${name} is already checked out in a worktree.`);

  const destination = join(info.worktreeParent, worktreeSlug(name));
  await mkdir(info.worktreeParent, { recursive: true });
  if (existing) {
    await runGit(cwd, ["worktree", "add", destination, name]);
  } else {
    const base = await prepareWorktreeBase(cwd, baseRef || info.branch || "HEAD", runGit);
    await runGit(cwd, ["worktree", "add", "-b", name, destination, base]);
  }
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
