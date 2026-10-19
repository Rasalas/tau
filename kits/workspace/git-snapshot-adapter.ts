import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { DiffLoadOptions, UiFileDiff } from "tau/host-extension";
import { runGitCommand, type SnapshotGitRunner } from "./git-command.js";
import { diffGitTrees, diffViewArguments, streamFilePatch, parseUnifiedDiff, MAX_DIFF_HUNKS } from "./git-diff.js";
import { normalizeDiffLoadOptions } from "./turn-checkpoint-diff.js";
import { isTurnSnapshotId } from "./turn-checkpoint-codec.js";
import {
  CHECKPOINT_REF_GRACE_MS,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotOptions,
} from "./workspace-snapshot-types.js";
import type { SnapshotAdapter, SnapshotObjects } from "./snapshot-adapter.js";

const SNAPSHOT_GIT_BUFFER = 64 * 1024 * 1024;

async function captureGitSnapshot(
  cwd: string,
  options: WorkspaceSnapshotOptions,
  ref: string,
  runGit: SnapshotGitRunner,
): Promise<WorkspaceSnapshot | undefined> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "tau-turn-snapshot-"));
  const temporaryIndex = join(temporaryDirectory, "index");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: temporaryIndex,
    GIT_OPTIONAL_LOCKS: "0",
  };
  const run = (args: string[], maxBuffer = SNAPSHOT_GIT_BUFFER): Promise<string> =>
    runGit(cwd, ["read-tree", "add", "write-tree"].includes(args[0] ?? "")
      ? ["-c", "core.splitIndex=false", "-c", "splitIndex.sharedIndexExpire=never", ...args]
      : args, maxBuffer, undefined, env);
  try {
    // Fallback is allowed only before Git recognizes this workspace. Capture
    // failures in a repository must never become filesystem checkpoints.
    const inside = await run(["rev-parse", "--is-inside-work-tree"]).catch(() => undefined);
    if (inside === undefined) return undefined;
    if (inside.trim() !== "true") throw new Error("Git workspace snapshots are unavailable for bare repositories.");

    const head = (await run(["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim();
    const headBranch = (await run(["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "")).trim();
    await run(head ? ["read-tree", head] : ["read-tree", "--empty"]);
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
    return { id: ref, ref, treeId, cwd, backend: "git", complete: true, head, ...(headBranch ? { headBranch } : {}) };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function validObjectId(value: string): boolean {
  return /^[0-9a-f]{40,64}$/iu.test(value.trim());
}

async function gitFileDiff(cwd: string, before: string, after: string, path: string, options: DiffLoadOptions): Promise<UiFileDiff> {
  const empty = (note: string): UiFileDiff => ({ path, added: 0, removed: 0, hunks: [], note });
  const streamed = await streamFilePatch(
    cwd,
    ["diff", "--no-ext-diff", "--find-renames", ...diffViewArguments(options), before, after, "--", path],
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
}

export function gitSnapshotAdapter(cwd: string, runGit: SnapshotGitRunner = runGitCommand): SnapshotAdapter {
  return {
    kind: "git",
    capture: (options, ref) => captureGitSnapshot(cwd, options, ref, options.runGit ?? runGit),
    async pair(before, after, validate) {
      let beforeTreeId = before;
      let afterTreeId = after;
      if (validate) {
        const [beforeTree, afterTree, beforeType, afterType] = await Promise.all([
          runGit(cwd, ["rev-parse", "--verify", `${before}^{tree}`]),
          runGit(cwd, ["rev-parse", "--verify", `${after}^{tree}`]),
          runGit(cwd, ["cat-file", "-t", before]),
          runGit(cwd, ["cat-file", "-t", after]),
        ]);
        beforeTreeId = beforeTree.trim();
        afterTreeId = afterTree.trim();
        if (!validObjectId(beforeTreeId) || !validObjectId(afterTreeId)
          || beforeType.trim() !== "tree" || afterType.trim() !== "tree") {
          throw new Error("Turn checkpoint snapshot refs are missing or do not address trees.");
        }
      }
      return {
        beforeTreeId,
        afterTreeId,
        assertRestorable: async () => undefined,
        async applyAfter(onCleaned) {
          const ensureWindowsCwd = async () => {
            if (process.platform === "win32" && !existsSync(cwd)) await mkdir(cwd, { recursive: true });
          };
          await ensureWindowsCwd();
          // Match capture's non-ignored files. Ignored folders survive restore.
          await runGit(cwd, ["clean", "-fd", "--"], SNAPSHOT_GIT_BUFFER);
          await ensureWindowsCwd();
          await onCleaned?.();
          await runGit(cwd, ["read-tree", "--reset", "-u", afterTreeId], SNAPSHOT_GIT_BUFFER);
          await ensureWindowsCwd();
        },
        diff: (branch) => diffGitTrees(cwd, before, after, branch, runGit),
        fileDiff: (path, options) => gitFileDiff(cwd, before, after, path, options),
        async clone(phase, id) {
          const treeId = phase === "before" ? beforeTreeId : afterTreeId;
          const existing = (await runGit(cwd, ["rev-parse", "--verify", id]).catch(() => "")).trim();
          if (existing && existing !== treeId) throw new Error(`Fork snapshot ref ${id} already points to another tree.`);
          if (existing) {
            const type = (await runGit(cwd, ["cat-file", "-t", id]).catch(() => "")).trim();
            if (type !== "tree") throw new Error(`Fork snapshot ref ${id} does not address a tree.`);
            return false;
          }
          await runGit(cwd, ["update-ref", id, treeId, "0".repeat(treeId.length)]);
          return true;
        },
      };
    },
    async remove(id, expectedTreeId) {
      if (expectedTreeId) {
        const current = (await runGit(cwd, ["rev-parse", "--verify", id]).catch(() => "")).trim();
        if (current && current !== expectedTreeId) return;
      }
      await runGit(cwd, ["update-ref", "-d", id]).catch(() => undefined);
    },
    async objects(prefix) {
      const objects: SnapshotObjects = new Map();
      const listed = await runGit(cwd, ["for-each-ref", "--format=%(refname) %(objectname) %(objecttype)", prefix]).catch(() => undefined);
      const lines = listed ?? await runGit(cwd, ["for-each-ref", "--format=%(refname)", prefix]).catch(() => "");
      for (const line of lines.split("\n")) {
        const [ref, id, type] = line.trim().split(" ");
        if (ref && isTurnSnapshotId(ref)) objects.set(ref, listed === undefined ? {} : { id, type });
      }
      return objects;
    },
    async recent(refs, options) {
      const graceMs = options.graceMs ?? CHECKPOINT_REF_GRACE_MS;
      const recent = new Set<string>();
      if (graceMs <= 0 || refs.length === 0) return recent;
      const now = options.now ?? Date.now();
      // Packed tree refs have no loose timestamp and are never young.
      const commonDir = (await runGit(cwd, ["rev-parse", "--git-common-dir"]).catch(() => "")).trim();
      if (!commonDir) return recent;
      await Promise.all(refs.map(async (ref) => {
        const stamp = await stat(join(resolve(cwd, commonDir), ref)).catch(() => undefined);
        if (stamp && now - stamp.mtimeMs < graceMs) recent.add(ref);
      }));
      return recent;
    },
    async removeSession(sessionId) {
      const prefix = `refs/tau/checkpoints/${sessionId}/`;
      const refs = (await runGit(cwd, ["for-each-ref", "--format=%(refname)", prefix]).catch(() => ""))
        .split("\n").map((ref) => ref.trim()).filter(isTurnSnapshotId);
      await Promise.all(refs.map((ref) => runGit(cwd, ["update-ref", "-d", ref]).catch(() => undefined)));
    },
    gc: async () => undefined,
  };
}
