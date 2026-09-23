import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorktree,
  createWorkspaceSnapshot,
  cleanupClonedTurnCheckpointRefs,
  CHECKPOINT_REF_GRACE_MS,
  cleanupCheckpointRefsForLiveSessions,
  cleanupOrphanTurnCheckpointRefs,
  cleanupTurnCheckpointRefs,
  cloneTurnCheckpointRefs,
  commit as commitWorkspace,
  diffWorkspaceSnapshots,
  diffWorkspaceSnapshotPage,
  getBranchChanges,
  getFileDiff,
  getSnapshotFileDiff,
  isLinkedWorktree,
  isNestedProject,
  MAX_DIFF_BYTES,
  MAX_DIFF_HUNKS,
  parseUnifiedDiff,
  pull,
  push,
  previewWorkspaceRestore,
  ensureWorktree,
  readDefaultBranch,
  readProjectGitState,
  readWorktreeStatuses,
  removeWorktree,
  resolveDefaultBaseRef,
  resolveWorktreeBase,
  revertFile,
  restoreWorkspaceSnapshot,
  repositoryDisplayName,
  runGitCommand,
  stageFile,
  unstageFile,
  validateWorkspaceSnapshotRefs,
} from "./workspace-git.js";
import { turnSnapshotRef, type StoredTurnCheckpoint } from "./turn-checkpoint-codec.js";
import type { TurnRestoreTransaction } from "./turn-checkpoint-types.js";
import { WorkspaceCheckpointLeaseManager } from "./workspace-checkpoint-lease.js";

// The host's global and system Git config (LFS filters, credential helpers)
// would otherwise be read by every fixture process here.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

// Checkpoint leases share one machine-wide temp root and protect refs by
// session id alone, so a second test process must not match these names.
const LIVE_LINKED_SESSION = `live-linked-${process.pid}`;
const RACE_WRITER_SESSION = `race-writer-${process.pid}`;

describe("selective workspace changes", () => {
  it("stages, unstages, and reverts one exact path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-selective-changes-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "tracked.txt"), "base\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      await writeFile(join(cwd, "tracked.txt"), "changed\n");

      expect((await readProjectGitState(cwd)).changes.files[0]).toMatchObject({ path: "tracked.txt", staged: false });
      await stageFile(cwd, "tracked.txt");
      expect((await readProjectGitState(cwd)).changes.files[0]).toMatchObject({ path: "tracked.txt", staged: true });
      await unstageFile(cwd, "tracked.txt");
      expect((await readProjectGitState(cwd)).changes.files[0]).toMatchObject({ path: "tracked.txt", staged: false });
      await revertFile(cwd, "tracked.txt");
      expect((await readProjectGitState(cwd)).changes.files).toHaveLength(0);

      await writeFile(join(cwd, "new.txt"), "new\n");
      await revertFile(cwd, "new.txt");
      await expect(readFile(join(cwd, "new.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 90_000);

  it("compares committed branch changes from the merge base", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-branch-changes-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "base.txt"), "base\n");
      execFileSync("git", ["add", "."], { cwd });
      execFileSync("git", ["commit", "-qm", "base"], { cwd });
      execFileSync("git", ["branch", "-M", "main"], { cwd });
      execFileSync("git", ["switch", "-qc", "feat/review"], { cwd });
      await writeFile(join(cwd, "branch.txt"), "branch\n");
      execFileSync("git", ["add", "."], { cwd });
      execFileSync("git", ["commit", "-qm", "branch"], { cwd });
      await writeFile(join(cwd, "worktree-only.txt"), "draft\n");

      const changes = await getBranchChanges(cwd, { baseRef: "main" });
      expect(changes).toMatchObject({ branch: "feat/review", scope: "branch", baseRef: "main" });
      expect(changes.files.map((file) => file.path)).toEqual(["branch.txt"]);
      const diff = await getFileDiff(cwd, "branch.txt", { scope: "branch", baseRef: "main" });
      expect(diff.hunks.flatMap((hunk) => hunk.lines)).toContainEqual(expect.objectContaining({ kind: "added", text: "branch" }));
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 90_000);

  it("commits only the staged selection when the index is not empty", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-selective-commit-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "a.txt"), "base\n");
      await writeFile(join(cwd, "b.txt"), "base\n");
      execFileSync("git", ["add", "."], { cwd });
      execFileSync("git", ["commit", "-qm", "base"], { cwd });
      await writeFile(join(cwd, "a.txt"), "selected\n");
      await writeFile(join(cwd, "b.txt"), "left behind\n");
      await stageFile(cwd, "a.txt");

      await commitWorkspace(cwd, "selected change", false);

      expect(execFileSync("git", ["show", "--pretty=format:", "--name-only", "HEAD"], { cwd, encoding: "utf8" }).trim()).toBe("a.txt");
      expect((await readProjectGitState(cwd)).changes.files).toEqual([expect.objectContaining({ path: "b.txt", staged: false })]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 90_000);
});

describe("large diff bounds", () => {
  it("pages hunks and marks the bounded payload", () => {
    const patch = Array.from({ length: MAX_DIFF_HUNKS + 8 }, (_, index) =>
      `@@ -${index + 1},1 +${index + 1},1 @@ generated\n+line ${index}\n`,
    ).join("");
    const first = parseUnifiedDiff("generated.txt", patch, { hunkLimit: 40 });
    expect(first.hunks).toHaveLength(40);
    expect(first.truncated).toBe(true);
    expect(first.nextHunkOffset).toBe(40);
    const second = parseUnifiedDiff("generated.txt", patch, { hunkOffset: first.nextHunkOffset, hunkLimit: 40 });
    expect(second.hunks[0]?.header).toContain("-41");
  });

  it("stops offering paging when the host byte limit is terminal", () => {
    const patch = `@@ -1,1 +1,1 @@ large\n+${"x".repeat(MAX_DIFF_BYTES + 100)}\n`;
    const result = parseUnifiedDiff("large.txt", patch, { hunkLimit: 1 });
    expect(result.truncated).toBe(true);
    expect(result.nextHunkOffset).toBeUndefined();
    expect(result.note).toContain("host byte or line limit");
  });

  it("streams and pages hunks from git without retaining the complete patch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-diff-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      const before = Array.from({ length: 80 }, (_, index) => `line ${index}`);
      await writeFile(join(cwd, "large.txt"), `${before.join("\n")}\n`);
      execFileSync("git", ["add", "large.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      const after = before.map((line, index) => index % 10 === 0 ? `${line} changed` : line);
      await writeFile(join(cwd, "large.txt"), `${after.join("\n")}\n`);

      const first = await getFileDiff(cwd, "large.txt", { hunkLimit: 2 });
      expect(first.hunks).toHaveLength(2);
      expect(first.nextHunkOffset).toBe(2);
      const second = await getFileDiff(cwd, "large.txt", { hunkOffset: first.nextHunkOffset, hunkLimit: 2 });
      expect(second.hunks).toHaveLength(2);
      expect(second.hunks[0]?.header).not.toBe(first.hunks[0]?.header);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps context bounded by default and expands it only when requested", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-diff-context-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      const before = Array.from({ length: 30 }, (_, index) => `line ${index}`);
      await writeFile(join(cwd, "context.txt"), `${before.join("\n")}\n`);
      execFileSync("git", ["add", "context.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      const after = before.map((line, index) => index === 15 ? `${line} changed` : line);
      await writeFile(join(cwd, "context.txt"), `${after.join("\n")}\n`);

      const collapsed = await getFileDiff(cwd, "context.txt");
      const expanded = await getFileDiff(cwd, "context.txt", { contextLines: 100_000 });
      expect(collapsed.hunks[0]?.lines.length).toBeLessThan(expanded.hunks[0]?.lines.length ?? 0);
      expect(expanded.hunks[0]?.lines.some((line) => line.text === "line 0")).toBe(true);
      expect(expanded.hunks[0]?.lines.some((line) => line.text === "line 29")).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("leaves out whitespace-only changes on request, and still diffs an untracked file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-diff-whitespace-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "spaces.txt"), "if (a) {\n  run();\n}\n");
      await writeFile(join(cwd, "mixed.txt"), "one\ntwo\n");
      execFileSync("git", ["add", "."], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      await writeFile(join(cwd, "spaces.txt"), "if (a) {\n    run();\n}\n");
      await writeFile(join(cwd, "mixed.txt"), "one \nthree\n");
      await writeFile(join(cwd, "new.txt"), "fresh\n");

      expect((await getFileDiff(cwd, "spaces.txt")).hunks).toHaveLength(1);
      await expect(getFileDiff(cwd, "spaces.txt", { ignoreWhitespace: true })).resolves.toMatchObject({ hunks: [], note: "Only whitespace changed." });
      const mixed = await getFileDiff(cwd, "mixed.txt", { ignoreWhitespace: true });
      expect(mixed.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind !== "context").map((line) => line.text)).toEqual(["two", "three"]);
      expect((await getFileDiff(cwd, "new.txt", { ignoreWhitespace: true })).hunks[0]?.lines).toEqual([expect.objectContaining({ kind: "added", text: "fresh" })]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * Every test here spawns real `git` processes several times over — a snapshot is
 * an `add`/`commit`/`write-tree` triple — and the vitest pool runs four files at
 * once. Isolated the suite needs about a minute; under the full suite's own load
 * the same tests have taken four times that, which is what the 90 s budget below
 * is for. A shorter one turns ordinary load into a red CI run. The per-test
 * numbers are deliberately uniform: they say "this suite is expensive", not
 * "this one test is expensive".
 */
describe("immutable turn snapshots", () => {
  it("restores a verified Git checkpoint and can replay the backup", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-restore-snapshots-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "tracked.txt"), "base\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });

      await createWorkspaceSnapshot(cwd, { namespace: "source/turn", phase: "before" });
      await writeFile(join(cwd, "tracked.txt"), "checkpoint\n");
      await writeFile(join(cwd, "checkpoint.txt"), "kept\n");
      const targetAfter = await createWorkspaceSnapshot(cwd, { namespace: "source/turn", phase: "after" });

      await writeFile(join(cwd, "tracked.txt"), "current\n");
      await writeFile(join(cwd, "current.txt"), "unsaved\n");
      const backupBefore = await createWorkspaceSnapshot(cwd, { namespace: "backup/restore", phase: "before" });
      const backupAfter = await createWorkspaceSnapshot(cwd, { namespace: "backup/restore", phase: "after" });

      await restoreWorkspaceSnapshot(cwd, targetAfter.id, {
        target: { sessionId: "source", turnId: "turn" },
        rollback: { sessionId: "backup", turnId: "restore" },
      });
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("checkpoint\n");
      expect(await readFile(join(cwd, "checkpoint.txt"), "utf8")).toBe("kept\n");
      await expect(readFile(join(cwd, "current.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await restoreWorkspaceSnapshot(cwd, backupAfter.id, {
        target: { sessionId: "backup", turnId: "restore" },
        rollback: { sessionId: "source", turnId: "turn" },
      });
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("current\n");
      expect(await readFile(join(cwd, "current.txt"), "utf8")).toBe("unsaved\n");
      expect(backupBefore.treeId).toBe(backupAfter.treeId);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 90_000);

  it("rolls back a failed Git restore before reporting the error", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-restore-rollback-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "tracked.txt"), "base\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      const targetBefore = await createWorkspaceSnapshot(cwd, { namespace: "source/turn", phase: "before" });
      await writeFile(join(cwd, "tracked.txt"), "checkpoint\n");
      const targetAfter = await createWorkspaceSnapshot(cwd, { namespace: "source/turn", phase: "after" });
      await writeFile(join(cwd, "tracked.txt"), "current\n");
      const backupBefore = await createWorkspaceSnapshot(cwd, { namespace: "backup/restore", phase: "before" });
      const backupAfter = await createWorkspaceSnapshot(cwd, { namespace: "backup/restore", phase: "after" });
      const phases: string[] = [];
      const failingGit = async (path: string, args: string[], maxBuffer?: number, signal?: AbortSignal): Promise<string> => {
        if (args[0] === "read-tree" && args.at(-1) === targetAfter.treeId) throw new Error("simulated restore write failure");
        return runGitCommand(path, args, maxBuffer, signal);
      };

      await expect(restoreWorkspaceSnapshot(cwd, targetAfter.id, {
        target: { sessionId: "source", turnId: "turn" },
        rollback: { sessionId: "backup", turnId: "restore" },
        runGit: failingGit,
        onPhase: (phase) => { phases.push(phase); },
      })).rejects.toThrow(/original workspace was restored/u);
      expect(phases).toEqual(["apply-started", "cleaned", "rolling-back"]);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("current\n");
      await expect(readFile(join(cwd, "missing.txt"), "utf8")).rejects.toBeDefined();
      expect(targetBefore.treeId).not.toBe(targetAfter.treeId);
      expect(backupBefore.treeId).toBe(backupAfter.treeId);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 90_000);

  it("previews the live workspace delta against the selected checkpoint", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-restore-preview-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "tracked.txt"), "base\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      const before = await createWorkspaceSnapshot(cwd, { namespace: "preview-source/turn", phase: "before" });
      await writeFile(join(cwd, "tracked.txt"), "checkpoint\n");
      await writeFile(join(cwd, "checkpoint.txt"), "kept\n");
      const after = await createWorkspaceSnapshot(cwd, { namespace: "preview-source/turn", phase: "after" });
      await writeFile(join(cwd, "tracked.txt"), "current\n");
      await rm(join(cwd, "checkpoint.txt"), { force: true });
      await writeFile(join(cwd, "current.txt"), "unsaved\n");

      const preview = await previewWorkspaceRestore(
        cwd,
        before.id,
        after.id,
        { sessionId: "preview-source", turnId: "turn" },
      );
      expect(preview.files.map((file) => file.path)).toEqual(["checkpoint.txt", "current.txt", "tracked.txt"]);
      expect(preview.files.find((file) => file.path === "checkpoint.txt")?.status).toBe("deleted");
      expect(preview.files.find((file) => file.path === "current.txt")?.status).toBe("added");
      expect(preview.files.find((file) => file.path === "tracked.txt")?.status).toBe("modified");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 90_000);

  it("restores a complete plain-folder checkpoint and rejects partial history", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-folder-restore-"));
    try {
      await writeFile(join(cwd, "tracked.txt"), "base\n");
      await createWorkspaceSnapshot(cwd, { namespace: "source/turn", phase: "before" });
      await writeFile(join(cwd, "tracked.txt"), "checkpoint\n");
      const targetAfter = await createWorkspaceSnapshot(cwd, { namespace: "source/turn", phase: "after" });
      await writeFile(join(cwd, "tracked.txt"), "current\n");
      await writeFile(join(cwd, "current.txt"), "unsaved\n");
      await createWorkspaceSnapshot(cwd, { namespace: "backup/restore", phase: "before" });
      await createWorkspaceSnapshot(cwd, { namespace: "backup/restore", phase: "after" });

      await restoreWorkspaceSnapshot(cwd, targetAfter.id, {
        target: { sessionId: "source", turnId: "turn" },
        rollback: { sessionId: "backup", turnId: "restore" },
      });
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("checkpoint\n");
      await expect(readFile(join(cwd, "current.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const partial = await createWorkspaceSnapshot(cwd, { namespace: "partial/turn", phase: "before" });
      await writeFile(join(cwd, "large.bin"), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
      const partialAfter = await createWorkspaceSnapshot(cwd, { namespace: "partial/turn", phase: "after" });
      await expect(restoreWorkspaceSnapshot(cwd, partialAfter.id, {
        target: { sessionId: "partial", turnId: "turn" },
        rollback: { sessionId: "backup", turnId: "restore" },
      })).rejects.toThrow(/incomplete/u);
      expect(partial.treeId).not.toBe(partialAfter.treeId);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 90_000);

  it("preserves executable file modes and marks symlink snapshots incomplete", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-folder-metadata-"));
    try {
      const executable = join(cwd, "run.sh");
      await writeFile(executable, "#!/bin/sh\necho ok\n");
      await chmod(executable, 0o754);
      const emptyDirectory = join(cwd, "empty");
      await mkdir(emptyDirectory);
      await chmod(emptyDirectory, 0o751);
      const targetBefore = await createWorkspaceSnapshot(cwd, { namespace: "metadata-source/source", phase: "before" });
      await chmod(executable, 0o600);
      await chmod(emptyDirectory, 0o700);
      const targetAfter = await createWorkspaceSnapshot(cwd, { namespace: "metadata-source/source", phase: "after" });
      await chmod(executable, 0o644);
      await chmod(emptyDirectory, 0o755);
      const modeChanges = await diffWorkspaceSnapshots(cwd, targetBefore.id, targetAfter.id, {
        expected: { sessionId: "metadata-source", turnId: "source" },
      });
      expect(modeChanges.files.find((file) => file.path === "run.sh")).toMatchObject({ status: "modified", added: 0, removed: 0 });
      expect(modeChanges.files.find((file) => file.path === "empty")).toMatchObject({ status: "modified", added: 0, removed: 0 });
      const rollbackBefore = await createWorkspaceSnapshot(cwd, { namespace: "metadata-rollback/rollback", phase: "before" });
      const rollbackAfter = await createWorkspaceSnapshot(cwd, { namespace: "metadata-rollback/rollback", phase: "after" });

      // Restoring must remain possible when the currently materialized tree
      // itself made a directory read-only.
      await chmod(emptyDirectory, 0o500);
      await restoreWorkspaceSnapshot(cwd, targetAfter.id, {
        target: { sessionId: "metadata-source", turnId: "source" },
        rollback: { sessionId: "metadata-rollback", turnId: "rollback" },
      });
      expect((await lstat(executable)).mode & 0o7777).toBe(0o600);
      expect((await stat(emptyDirectory)).mode & 0o7777).toBe(0o700);
      expect(targetBefore.treeId).not.toBe(targetAfter.treeId);
      expect(rollbackBefore.treeId).toBe(rollbackAfter.treeId);

      await symlink("run.sh", join(cwd, "run-link"));
      const symlinkBefore = await createWorkspaceSnapshot(cwd, { namespace: "metadata-symlink/symlink", phase: "before" });
      await writeFile(join(cwd, "symlink-change.txt"), "not restorable\n");
      const symlinkAfter = await createWorkspaceSnapshot(cwd, { namespace: "metadata-symlink/symlink", phase: "after" });
      expect(symlinkBefore.complete).toBe(false);
      expect(symlinkBefore.backend).toBe("filesystem");
      expect(symlinkAfter.complete).toBe(false);
      await expect(restoreWorkspaceSnapshot(cwd, symlinkAfter.id, {
        target: { sessionId: "metadata-symlink", turnId: "symlink" },
        rollback: { sessionId: "metadata-rollback", turnId: "rollback" },
      })).rejects.toThrow(/incomplete/u);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 90_000);

  // ~36 Git processes, two of them worktree add/remove; 30 s is not enough headroom under full-suite load.
  it("does not sweep refs published by a live linked-worktree writer", { timeout: 60_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-snapshot-linked-root-"));
    const linked = await mkdtemp(join(tmpdir(), "tau-snapshot-linked-child-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "seed.txt"), "base\n");
      execFileSync("git", ["add", "seed.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      execFileSync("git", ["worktree", "add", "-q", "-b", "linked", linked, "HEAD"], { cwd });

      const manager = new WorkspaceCheckpointLeaseManager({ pollMs: 5, staleAfterMs: 500 });
      const lease = await manager.acquire(linked, { sessionId: LIVE_LINKED_SESSION, turnId: "turn" });
      const before = await createWorkspaceSnapshot(linked, { namespace: `${LIVE_LINKED_SESSION}/turn`, phase: "before" });
      await writeFile(join(linked, "seed.txt"), "turn\n");
      const after = await createWorkspaceSnapshot(linked, { namespace: `${LIVE_LINKED_SESSION}/turn`, phase: "after" });

      await cleanupCheckpointRefsForLiveSessions(cwd, []);
      await expect(validateWorkspaceSnapshotRefs(cwd, before.id, after.id, {
        sessionId: LIVE_LINKED_SESSION,
        turnId: "turn",
      })).resolves.toMatchObject({ beforeTreeId: before.treeId, afterTreeId: after.treeId });

      await lease.release();
      await cleanupCheckpointRefsForLiveSessions(cwd, []);
      await expect(validateWorkspaceSnapshotRefs(cwd, before.id, after.id, {
        sessionId: LIVE_LINKED_SESSION,
        turnId: "turn",
      })).rejects.toThrow();
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", linked], { cwd, stdio: "ignore" });
      await Promise.all([
        rm(linked, { recursive: true, force: true }),
        rm(cwd, { recursive: true, force: true }),
      ]);
    }
  });

  it("gives a known session's unrooted refs a grace period, and reclaims them after it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-ref-grace-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "tracked.txt"), "before\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      const before = await createWorkspaceSnapshot(cwd, { namespace: "known/turn", phase: "before" });
      await writeFile(join(cwd, "tracked.txt"), "after\n");
      const after = await createWorkspaceSnapshot(cwd, { namespace: "known/turn", phase: "after" });
      // The session is in the index but its journal does not name this pair —
      // exactly what a checkpoint appended a moment ago looks like from here.
      const known = [{ sessionId: "known", cwd, checkpoints: [] }];
      const expected = { sessionId: "known", turnId: "turn" };

      await cleanupCheckpointRefsForLiveSessions(cwd, known);
      await expect(validateWorkspaceSnapshotRefs(cwd, before.id, after.id, expected))
        .resolves.toMatchObject({ beforeTreeId: before.treeId, afterTreeId: after.treeId });

      await cleanupCheckpointRefsForLiveSessions(cwd, known, undefined, { now: Date.now() + CHECKPOINT_REF_GRACE_MS + 1_000 });
      await expect(validateWorkspaceSnapshotRefs(cwd, before.id, after.id, expected)).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 90_000);

  it("roots rollback refs from pending restore transactions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-restore-gc-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "tracked.txt"), "before\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      const rollbackBefore = await createWorkspaceSnapshot(cwd, { namespace: "journal/rollback", phase: "before" });
      await writeFile(join(cwd, "tracked.txt"), "after\n");
      const rollbackAfter = await createWorkspaceSnapshot(cwd, { namespace: "journal/rollback", phase: "after" });
      const transaction: TurnRestoreTransaction = {
        version: 1,
        kind: "backup-open",
        transactionId: "pending-restore",
        state: "workspace-applied",
        sessionId: "journal",
        backupSessionId: "journal",
        backupTurnId: "rollback",
        sourceSessionId: "source",
        sourceTurnId: "turn",
        sourceCheckpointId: "backup",
        targetSessionId: "journal",
        cwd,
        targetAfterSnapshotId: turnSnapshotRef("source", "turn", "after"),
        backupAfterSnapshotId: rollbackAfter.id,
        createdAt: Date.now(),
      };

      await cleanupCheckpointRefsForLiveSessions(cwd, [{
        sessionId: "journal",
        cwd,
        checkpoints: [],
        restoreTransactions: [transaction],
      }]);

      await expect(validateWorkspaceSnapshotRefs(
        cwd,
        rollbackBefore.id,
        rollbackAfter.id,
        { sessionId: "journal", turnId: "rollback" },
      )).resolves.toMatchObject({ beforeTreeId: rollbackBefore.treeId, afterTreeId: rollbackAfter.treeId });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 90_000);

  it("revalidates linked-worktree writers that start during ref enumeration", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-snapshot-race-root-"));
    const linked = await mkdtemp(join(tmpdir(), "tau-snapshot-race-child-"));
    let linkedLease: Awaited<ReturnType<WorkspaceCheckpointLeaseManager["acquire"]>> | undefined;
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "seed.txt"), "base\n");
      execFileSync("git", ["add", "seed.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      execFileSync("git", ["worktree", "add", "-q", "-b", "linked", linked, "HEAD"], { cwd });

      const manager = new WorkspaceCheckpointLeaseManager({ pollMs: 5, staleAfterMs: 500 });
      let writerStarted = false;
      const runGitDuringSweep = async (
        path: string,
        args: string[],
        maxBuffer?: number,
        signal?: AbortSignal,
      ): Promise<string> => {
        if (!writerStarted && args[0] === "for-each-ref") {
          writerStarted = true;
          // This lease is acquired after the sweep's first writer snapshot,
          // but before its ref enumeration. The second lease observation must
          // therefore protect the pair that is about to be deleted.
          linkedLease = await manager.acquire(linked, { sessionId: RACE_WRITER_SESSION, turnId: "turn" });
          const before = await createWorkspaceSnapshot(linked, { namespace: `${RACE_WRITER_SESSION}/turn`, phase: "before" });
          await writeFile(join(linked, "seed.txt"), "turn\n");
          const after = await createWorkspaceSnapshot(linked, { namespace: `${RACE_WRITER_SESSION}/turn`, phase: "after" });
          expect(before.treeId).not.toBe(after.treeId);
        }
        return runGitCommand(path, args, maxBuffer, signal);
      };

      await cleanupCheckpointRefsForLiveSessions(cwd, [], runGitDuringSweep);
      expect(writerStarted).toBe(true);
      await expect(validateWorkspaceSnapshotRefs(
        cwd,
        turnSnapshotRef(RACE_WRITER_SESSION, "turn", "before"),
        turnSnapshotRef(RACE_WRITER_SESSION, "turn", "after"),
        { sessionId: RACE_WRITER_SESSION, turnId: "turn" },
      )).resolves.toBeDefined();

      if (!linkedLease) throw new Error("Linked writer did not acquire its lease.");
      await linkedLease.release();
      linkedLease = undefined;
      await cleanupCheckpointRefsForLiveSessions(cwd, []);
      await expect(validateWorkspaceSnapshotRefs(
        cwd,
        turnSnapshotRef(RACE_WRITER_SESSION, "turn", "before"),
        turnSnapshotRef(RACE_WRITER_SESSION, "turn", "after"),
        { sessionId: RACE_WRITER_SESSION, turnId: "turn" },
      )).rejects.toThrow();
    } finally {
      await linkedLease?.release().catch(() => undefined);
      execFileSync("git", ["worktree", "remove", "--force", linked], { cwd, stdio: "ignore" });
      await Promise.all([
        rm(linked, { recursive: true, force: true }),
        rm(cwd, { recursive: true, force: true }),
      ]);
    }
  }, 90_000);

  it("diffs the complete before/after trees and excludes a pre-existing dirty base", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-snapshot-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });

      // This is the dirty state that existed before the turn started. It is
      // intentionally staged to prove the real index is not touched.
      await writeFile(join(cwd, "tracked.txt"), "one\npreexisting\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd });
      await writeFile(join(cwd, "preexisting.txt"), "keep\n");
      const stagedBefore = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf8" });
      const before = await createWorkspaceSnapshot(cwd, { namespace: "session/turn", phase: "before" });

      // Same numstat as the dirty base, but different content. A status/count
      // comparison would miss this edit; a tree diff must report it.
      await writeFile(join(cwd, "tracked.txt"), "one\nturn\n");
      await writeFile(join(cwd, "new.txt"), "new\n");
      const after = await createWorkspaceSnapshot(cwd, { namespace: "session/turn", phase: "after" });
      const summary = await diffWorkspaceSnapshots(cwd, before.id, after.id);
      await expect(validateWorkspaceSnapshotRefs(cwd, before.id, after.id, { sessionId: "session", turnId: "turn" })).resolves.toMatchObject({
        beforeTreeId: before.treeId,
        afterTreeId: after.treeId,
      });
      await expect(validateWorkspaceSnapshotRefs(cwd, after.id, before.id, { sessionId: "session", turnId: "turn" }))
        .rejects.toThrow("do not match");

      // A stable turn ref is write-once; a later retry cannot silently move the
      // historical boundary to a different worktree state.
      await expect(createWorkspaceSnapshot(cwd, { namespace: "session/turn", phase: "before" }))
        .rejects.toThrow("already points to another tree");

      expect(summary.files.map((file) => file.path)).toEqual(["new.txt", "tracked.txt"]);
      expect(summary.files.find((file) => file.path === "tracked.txt")).toMatchObject({
        status: "modified",
        added: 1,
        removed: 1,
      });
      expect(summary.files.find((file) => file.path === "new.txt")).toMatchObject({ status: "added", added: 1, removed: 0 });
      expect(summary.files.some((file) => file.path === "preexisting.txt")).toBe(false);
      expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf8" })).toBe(stagedBefore);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("one\nturn\n");

      const historical = await getSnapshotFileDiff(cwd, before.id, after.id, "tracked.txt");
      const lines = historical.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.kind}:${line.text}`));
      expect(lines).toEqual(expect.arrayContaining(["removed:preexisting", "added:turn"]));
      expect(before.id).toMatch(/^refs\/tau\/checkpoints\/session\/turn\/before$/u);
      expect(after.id).toMatch(/^refs\/tau\/checkpoints\/session\/turn\/after$/u);
      const page = await diffWorkspaceSnapshotPage(cwd, before.id, after.id, {
        sessionId: "session",
        turnId: "turn",
        limit: 1,
      });
      expect(page.fileCount).toBe(2);
      expect(page.files).toHaveLength(1);
      expect(page.hasMore).toBe(true);
      await cleanupTurnCheckpointRefs(cwd, [{ sessionId: "session", turnId: "turn" }]);
      expect(() => execFileSync("git", ["show-ref", "--verify", before.id], { cwd, encoding: "utf8" })).toThrow();
      expect(() => execFileSync("git", ["show-ref", "--verify", after.id], { cwd, encoding: "utf8" })).toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 90_000);

  it("keeps every changed file in the summary while opening one file lazily", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-many-snapshots-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "seed.txt"), "seed\n");
      execFileSync("git", ["add", "seed.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      const before = await createWorkspaceSnapshot(cwd, { namespace: "session/many", phase: "before" });
      await Promise.all(Array.from({ length: 300 }, (_, index) => writeFile(join(cwd, `file-${index}.txt`), `${index}\n`)));
      const after = await createWorkspaceSnapshot(cwd, { namespace: "session/many", phase: "after" });
      const summary = await diffWorkspaceSnapshots(cwd, before.id, after.id);
      expect(summary.files).toHaveLength(300);
      expect(summary.files.at(-1)?.path).toBe("file-99.txt");
      const one = await getSnapshotFileDiff(cwd, before.id, after.id, "file-299.txt");
      expect(one.hunks.flatMap((hunk) => hunk.lines).some((line) => line.kind === "added" && line.text === "299")).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 90_000);

  // ~110 Git processes for four clone/cleanup rounds; 30 s is not enough headroom under full-suite load.
  it("clones immutable refs into a fork namespace and removes incomplete copies", { timeout: 60_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-fork-snapshots-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "seed.txt"), "before\n");
      execFileSync("git", ["add", "seed.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      const before = await createWorkspaceSnapshot(cwd, { namespace: "source/turn", phase: "before" });
      await writeFile(join(cwd, "seed.txt"), "after\n");
      const after = await createWorkspaceSnapshot(cwd, { namespace: "source/turn", phase: "after" });
      const checkpoint: StoredTurnCheckpoint = {
        id: "turn",
        turnId: "turn",
        sessionId: "source",
        anchorMessageId: "assistant",
        beforeSnapshotId: before.id,
        afterSnapshotId: after.id,
        startedAt: 1,
        endedAt: 2,
        files: [],
        added: 1,
        removed: 1,
      };

      await cloneTurnCheckpointRefs(cwd, "source", "fork", [checkpoint]);
      const forkBefore = turnSnapshotRef("fork", "turn", "before");
      const forkAfter = turnSnapshotRef("fork", "turn", "after");
      await expect(validateWorkspaceSnapshotRefs(cwd, forkBefore, forkAfter, { sessionId: "fork", turnId: "turn" }))
        .resolves.toMatchObject({ beforeTreeId: before.treeId, afterTreeId: after.treeId });
      await cleanupClonedTurnCheckpointRefs(cwd, "source", "fork", [checkpoint]);
      await expect(validateWorkspaceSnapshotRefs(cwd, forkBefore, forkAfter, { sessionId: "fork", turnId: "turn" }))
        .rejects.toThrow();

      // A ref left by a crash before the custom entry is appended is removed
      // on the next session open, while a valid pair remains untouched. The
      // age backstop is off here; a real crash leaves refs older than it.
      await cloneTurnCheckpointRefs(cwd, "source", "fork", [checkpoint]);
      await cleanupOrphanTurnCheckpointRefs(cwd, "fork", [], undefined, [], { graceMs: 0 });
      await expect(validateWorkspaceSnapshotRefs(cwd, forkBefore, forkAfter, { sessionId: "fork", turnId: "turn" }))
        .rejects.toThrow();

      // A startup sweep must reclaim refs for a session that was deleted while
      // the host was offline, but it must leave a known sibling session alone.
      await cloneTurnCheckpointRefs(cwd, "source", "fork", [checkpoint]);
      await cleanupCheckpointRefsForLiveSessions(cwd, [{
        sessionId: "source",
        cwd,
        checkpoints: [checkpoint],
      }]);
      await expect(validateWorkspaceSnapshotRefs(cwd, forkBefore, forkAfter, { sessionId: "fork", turnId: "turn" }))
        .rejects.toThrow();

      // A checkpoint entry does not make a half-written ref pair valid. If a
      // process dies after publishing only one phase, the next session open
      // must remove that dangling phase as well.
      await cloneTurnCheckpointRefs(cwd, "source", "fork", [checkpoint]);
      execFileSync("git", ["update-ref", "-d", forkAfter], { cwd });
      await cleanupOrphanTurnCheckpointRefs(cwd, "fork", [{
        ...checkpoint,
        sessionId: "fork",
        beforeSnapshotId: forkBefore,
        afterSnapshotId: forkAfter,
      }], undefined, [], { graceMs: 0 });
      await expect(validateWorkspaceSnapshotRefs(cwd, forkBefore, forkAfter, { sessionId: "fork", turnId: "turn" }))
        .rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("provides immutable snapshots and fork history for a plain folder", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-folder-snapshots-"));
    try {
      await writeFile(join(cwd, "existing.txt"), "base\n");
      const before = await createWorkspaceSnapshot(cwd, { namespace: "folder-session/turn", phase: "before" });
      await writeFile(join(cwd, "existing.txt"), "turn\n");
      await writeFile(join(cwd, "added.txt"), "new\n");
      const after = await createWorkspaceSnapshot(cwd, { namespace: "folder-session/turn", phase: "after" });
      expect(before.backend).toBe("filesystem");
      expect(after.backend).toBe("filesystem");

      const summary = await diffWorkspaceSnapshots(cwd, before.id, after.id, {
        expected: { sessionId: "folder-session", turnId: "turn" },
      });
      expect(summary.files.map((file) => file.path)).toEqual(["added.txt", "existing.txt"]);
      expect(summary.files.find((file) => file.path === "existing.txt")).toMatchObject({ added: 1, removed: 1 });
      const historical = await getSnapshotFileDiff(cwd, before.id, after.id, "existing.txt", {}, {
        sessionId: "folder-session",
        turnId: "turn",
      });
      expect(historical.hunks.flatMap((hunk) => hunk.lines).map((line) => `${line.kind}:${line.text}`))
        .toEqual(expect.arrayContaining(["removed:base", "added:turn"]));
      const page = await diffWorkspaceSnapshotPage(cwd, before.id, after.id, {
        sessionId: "folder-session",
        turnId: "turn",
        limit: 1,
      });
      expect(page.fileCount).toBe(2);
      expect(page.files).toHaveLength(1);
      expect(page.hasMore).toBe(true);

      const checkpoint: StoredTurnCheckpoint = {
        id: "turn",
        turnId: "turn",
        sessionId: "folder-session",
        anchorMessageId: "assistant",
        beforeSnapshotId: before.id,
        afterSnapshotId: after.id,
        startedAt: 1,
        endedAt: 2,
        files: [],
        added: 2,
        removed: 1,
      };
      await cloneTurnCheckpointRefs(cwd, "folder-session", "folder-fork", [checkpoint]);
      await expect(validateWorkspaceSnapshotRefs(
        cwd,
        turnSnapshotRef("folder-fork", "turn", "before"),
        turnSnapshotRef("folder-fork", "turn", "after"),
        { sessionId: "folder-fork", turnId: "turn" },
      )).resolves.toMatchObject({ beforeTreeId: before.treeId, afterTreeId: after.treeId });
      await cleanupClonedTurnCheckpointRefs(cwd, "folder-session", "folder-fork", [checkpoint]);
      await expect(validateWorkspaceSnapshotRefs(
        cwd,
        turnSnapshotRef("folder-fork", "turn", "before"),
        turnSnapshotRef("folder-fork", "turn", "after"),
        { sessionId: "folder-fork", turnId: "turn" },
      )).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps large plain-folder changes visible with explicit content limits", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-folder-large-snapshot-"));
    const largePath = join(cwd, "large.bin");
    try {
      const size = 8 * 1024 * 1024 + 1;
      await writeFile(largePath, Buffer.alloc(size, 65));
      const before = await createWorkspaceSnapshot(cwd, { namespace: "large-session/turn", phase: "before" });
      await writeFile(largePath, Buffer.alloc(size, 66));
      const after = await createWorkspaceSnapshot(cwd, { namespace: "large-session/turn", phase: "after" });

      const summary = await diffWorkspaceSnapshots(cwd, before.id, after.id, {
        expected: { sessionId: "large-session", turnId: "turn" },
      });
      expect(summary.completeness).toBe("partial");
      expect(summary.incompleteReason).toContain("content limit");
      expect(summary.files).toHaveLength(1);
      expect(summary.files[0]).toMatchObject({ path: "large.bin" });
      expect(summary.files[0]?.note).toContain("8 MiB");
      const page = await diffWorkspaceSnapshotPage(cwd, before.id, after.id, {
        sessionId: "large-session",
        turnId: "turn",
      });
      expect(page.completeness).toBe("partial");
      expect(page.files[0]?.note).toContain("8 MiB");
      const historical = await getSnapshotFileDiff(cwd, before.id, after.id, "large.bin", {}, {
        sessionId: "large-session",
        turnId: "turn",
      });
      expect(historical.hunks).toHaveLength(0);
      expect(historical.note).toContain("8 MiB");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 90_000);
});

describe("worktree cleanup suggestions", () => {
  it("suggests only old, clean, pushed worktrees with no threads", async () => {
    const now = Date.UTC(2026, 8, 20);
    const old = now - 30 * 24 * 60 * 60 * 1_000;
    const recent = now - 2 * 24 * 60 * 60 * 1_000;
    const tree = (name: string, patch: Record<string, unknown> = {}) => ({
      path: `/repo-worktrees/${name}`,
      name,
      branch: `feat/${name}`,
      isMain: false,
      isCurrent: false,
      ...patch,
    });
    const worktrees = [
      tree("main", { path: "/repo", branch: "main", isMain: true, isCurrent: true }),
      tree("safe"), tree("dirty"), tree("ahead"), tree("no-upstream"), tree("recent"), tree("used"),
    ];
    const refs = worktrees.map((worktree) => ({
      name: worktree.branch,
      isCurrent: worktree.isCurrent,
      upstream: worktree.name === "no-upstream" ? undefined : `origin/${worktree.branch}`,
      ahead: worktree.name === "ahead" ? 1 : 0,
      behind: 0,
      lastCommitAt: worktree.name === "recent" ? recent : old,
    }));
    const statuses = await readWorktreeStatuses(
      worktrees,
      refs,
      ["/repo", "/repo-worktrees/used"],
      async (cwd, args) => args[0] === "status" && cwd.endsWith("/dirty") ? " M file.ts\0" : "",
      now,
    );

    expect(statuses.filter((status) => status.cleanupCandidate).map((status) => status.path))
      .toEqual(["/repo-worktrees/safe"]);
    expect(statuses.find((status) => status.path.endsWith("/dirty"))?.isDirty).toBe(true);
    expect(statuses.find((status) => status.path.endsWith("/used"))?.threadCount).toBe(1);
  });
});

describe("worktree classification", () => {
  it("separates a linked worktree from a main checkout and a plain folder", async () => {
    const gitDirs = async (_cwd: string, args: string[]) => {
      expect(args).toEqual(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
      return "/repos/tau/.git/worktrees/feat\n/repos/tau/.git\n";
    };
    await expect(isLinkedWorktree("/repos/tau-worktrees/feat", gitDirs)).resolves.toBe(true);

    await expect(isLinkedWorktree("/repos/tau", async () => "/repos/tau/.git\n/repos/tau/.git\n"))
      .resolves.toBe(false);

    // A folder that is not a repository has no answer at all; the caller, not
    // this helper, decides what to do with that.
    await expect(isLinkedWorktree("/tmp/plain", async () => { throw new Error("not a git repository"); }))
      .rejects.toThrow("not a git repository");
    await expect(isLinkedWorktree("/tmp/plain", async () => "\n")).rejects.toThrow("not a Git repository");
  });

  it("keeps vanished worktree paths out of the project picker", async () => {
    let gitCalled = false;
    await expect(isNestedProject(
      "/repos/tau-worktrees/deleted",
      async () => { gitCalled = true; return ""; },
      async () => false,
    )).resolves.toBe(true);
    expect(gitCalled).toBe(false);
  });
});

describe("default branch", () => {
  it("names origin/HEAD's branch, then init.defaultBranch, then main", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-default-branch-"));
    const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
    try {
      const origin = join(root, "origin");
      await mkdir(origin);
      run(origin, "init", "-q", "-b", "trunk");
      run(origin, "-c", "user.email=tau@example.test", "-c", "user.name=Tau", "commit", "-q", "--allow-empty", "-m", "first");
      run(root, "clone", "-q", origin, "clone");
      await expect(readDefaultBranch(join(root, "clone"))).resolves.toBe("trunk");

      const configured = join(root, "configured");
      await mkdir(configured);
      run(configured, "init", "-q", "-b", "work");
      run(configured, "config", "init.defaultBranch", "develop");
      await expect(readDefaultBranch(configured)).resolves.toBe("develop");

      const plain = join(root, "plain");
      await mkdir(plain);
      run(plain, "init", "-q", "-b", "master");
      await expect(readDefaultBranch(plain)).resolves.toBe("main");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("worktree base", () => {
  const runner = (answers: Record<string, string>, calls: string[][] = []) => async (_cwd: string, args: string[]) => {
    calls.push(args);
    const answer = answers[args.join(" ")];
    // `rev-parse --verify --quiet` exits non-zero for a ref that is not there.
    if (answer === undefined || (answer === "" && args[0] === "rev-parse")) throw new Error(`no answer for ${args.join(" ")}`);
    return answer;
  };

  it("reads the default branch from origin/HEAD and falls back down the list", async () => {
    await expect(resolveDefaultBaseRef("/repo", runner({
      "symbolic-ref --short refs/remotes/origin/HEAD": "origin/trunk\n",
    }))).resolves.toBe("origin/trunk");

    await expect(resolveDefaultBaseRef("/repo", runner({
      "symbolic-ref --short refs/remotes/origin/HEAD": "",
      "rev-parse --verify --quiet main": "abc\n",
    }))).resolves.toBe("main");

    // No remote and no conventional branch: this checkout's own branch answers.
    await expect(resolveDefaultBaseRef("/repo", async (_cwd, args) => {
      if (args[0] === "branch") return "work\n";
      throw new Error("no such ref");
    })).resolves.toBe("work");
  });

  it("starts from the fetched remote commit and falls back to the local base", async () => {
    const calls: string[][] = [];
    await expect(resolveWorktreeBase("/repo", { requested: "main" }, runner({
      "remote": "origin\n",
      "fetch --prune origin": "",
      "rev-parse --verify --quiet origin/main^{commit}": "1111111111111111111111111111111111111111\n",
    }, calls))).resolves.toEqual({
      ref: "origin/main",
      commit: "1111111111111111111111111111111111111111",
      fromOrigin: true,
    });
    expect(calls).toContainEqual(["fetch", "--prune", "origin"]);

    const local = await resolveWorktreeBase("/repo", { requested: "main" }, runner({
      "remote": "origin\n",
      "fetch --prune origin": "",
      "rev-parse --verify --quiet main^{commit}": "2222222222222222222222222222222222222222\n",
    }));
    expect(local).toMatchObject({ ref: "main", fromOrigin: false });
    expect(local.note).toContain("origin/main does not exist");

    // Switched off, nothing is fetched at all.
    const offline: string[][] = [];
    await expect(resolveWorktreeBase("/repo", { requested: "main", startFromOrigin: false }, runner({
      "remote": "origin\n",
      "rev-parse --verify --quiet main^{commit}": "3333333333333333333333333333333333333333\n",
    }, offline))).resolves.toMatchObject({ ref: "main", fromOrigin: false });
    expect(offline.some((args) => args[0] === "fetch")).toBe(false);
  });

  it("keeps offering the local base when origin cannot be reached", async () => {
    const base = await resolveWorktreeBase("/repo", { requested: "main" }, async (_cwd, args) => {
      if (args[0] === "remote") return "origin\n";
      if (args[0] === "fetch") throw new Error("could not read from remote repository");
      if (args.join(" ") === "rev-parse --verify --quiet main^{commit}") return "4444444444444444444444444444444444444444\n";
      throw new Error(`no answer for ${args.join(" ")}`);
    });
    expect(base).toMatchObject({ ref: "main", fromOrigin: false });
    expect(base.note).toContain("origin is unreachable");
  });

  it("refuses a base that names no commit", async () => {
    await expect(resolveWorktreeBase("/repo", { requested: "nope", startFromOrigin: false }, runner({
      "remote": "",
    }))).rejects.toThrow(/The worktree base "nope" does not exist/u);
  });
});

describe("a worktree whose folder vanished", () => {
  it("is recreated on open, and an existing one is left alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-worktree-gone-"));
    const cwd = join(root, "project");
    try {
      execFileSync("git", ["init", "-q", "-b", "main", cwd]);
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "first"], { cwd });
      const linked = join(root, "worktrees", "feat");
      execFileSync("git", ["worktree", "add", "-q", "-b", "feat", linked, "HEAD"], { cwd });

      await expect(ensureWorktree(cwd, linked, "feat")).resolves.toBe(false);
      await rm(linked, { recursive: true, force: true });
      await expect(ensureWorktree(cwd, linked, "feat")).resolves.toBe(true);
      await expect(stat(join(linked, ".git")).then(() => true)).resolves.toBe(true);

      // Without a branch there is nothing to check out again, and guessing would be wrong.
      await rm(linked, { recursive: true, force: true });
      await expect(ensureWorktree(cwd, linked, undefined)).rejects.toThrow(/no branch names what it held/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("worktree removal", () => {
  it("removes the worktree and its branch, and prunes when the folder is already gone", async () => {
    const calls: string[][] = [];
    await removeWorktree("/repo", "/repo-worktrees/feat", { branch: "feat" }, async (_cwd, args) => {
      calls.push(args);
      return "";
    });
    expect(calls).toEqual([
      ["worktree", "remove", "--force", "/repo-worktrees/feat"],
      ["branch", "-D", "feat"],
    ]);

    const pruned: string[][] = [];
    await removeWorktree("/repo", "/repo-worktrees/gone", {}, async (_cwd, args) => {
      pruned.push(args);
      if (args[1] === "remove") throw new Error("is not a working tree");
      return "";
    });
    expect(pruned.map((args) => args.slice(0, 2))).toContainEqual(["worktree", "prune"]);
  });
});

describe("worktree creation", () => {
  it("creates a new branch from freshly fetched origin/main", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-worktree-"));
    const calls: string[][] = [];
    try {
      const destination = await createWorktree(cwd, "feat/fresh-main", { baseRef: "origin/main" }, async () => ({
        root: cwd,
        isRepo: true,
        isDirty: true,
        branch: "feature/in-progress",
        hasRemote: true,
        worktrees: [],
        refs: [],
        worktreeParent: join(cwd, "worktrees"),
      }), async (_path, args) => {
        calls.push(args);
        if (args[0] === "remote") return "origin\n";
        if (args[0] === "rev-parse") return "origin/main\n";
        return "";
      });

      expect(destination).toBe(join(cwd, "worktrees", "feat-fresh-main"));
      expect(calls).toContainEqual(["fetch", "--prune", "origin"]);
      expect(calls).toContainEqual(["worktree", "add", "-b", "feat/fresh-main", destination, "origin/main"]);
      // The base a later diff compares against is recorded on the branch.
      expect(calls).toContainEqual(["config", "branch.feat/fresh-main.tau-base", "origin/main"]);
      expect(calls.findIndex((args) => args[0] === "fetch"))
        .toBeLessThan(calls.findIndex((args) => args[0] === "worktree"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uses the selected local base without fetching", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-worktree-"));
    const calls: string[][] = [];
    try {
      await createWorktree(cwd, "feat/local-main", { baseRef: "main", startFromOrigin: false }, async () => ({
        root: cwd,
        isRepo: true,
        isDirty: false,
        branch: "feature/current",
        hasRemote: true,
        worktrees: [],
        refs: [{ name: "main", isCurrent: false }],
        worktreeParent: join(cwd, "worktrees"),
      }), async (_path, args) => {
        calls.push(args);
        if (args[0] === "remote") return "origin\n";
        if (args[0] === "rev-parse") return "main\n";
        return "";
      });

      expect(calls.some((args) => args[0] === "fetch")).toBe(false);
      expect(calls.find((args) => args[0] === "worktree")?.at(-1)).toBe("main");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not silently create from stale state when fetching fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-worktree-"));
    const calls: string[][] = [];
    try {
      await expect(createWorktree(cwd, "feat/offline", { baseRef: "origin/main" }, async () => ({
        root: cwd,
        isRepo: true,
        isDirty: false,
        worktrees: [],
        refs: [],
        worktreeParent: join(cwd, "worktrees"),
      }), async (_path, args) => {
        calls.push(args);
        if (args[0] === "remote") return "origin\n";
        if (args[0] === "fetch") throw new Error("network unavailable");
        return "";
      })).rejects.toThrow("network unavailable");
      expect(calls.some((args) => args[0] === "worktree")).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uses the main checkout name for a linked worktree", async () => {
    const name = await repositoryDisplayName(
      "/repos/tau-worktrees/feat-race",
      async () => "/repos/tau/.git\n",
    );
    expect(name).toBe("tau");
  });
});

describe("workspace publishing", () => {
  it("pulls upstream changes with fast-forward-only semantics", async () => {
    const calls: string[][] = [];
    const result = await pull("/project", async (_cwd, args) => {
      calls.push(args);
      return args[0] === "rev-parse" ? "def456\n" : "";
    });
    expect(calls).toEqual([["pull", "--ff-only"], ["rev-parse", "--short", "HEAD"]]);
    expect(result.detail).toBe("Pulled def456");
  });

  it("pushes the current upstream without creating another commit", async () => {
    const calls: string[][] = [];
    const result = await push("/project", async (_cwd, args) => {
      calls.push(args);
      if (args.includes("@{u}")) return "origin/feature\n";
      return args[0] === "rev-parse" ? "abc123\n" : "";
    });
    expect(calls).toEqual([
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      ["push"],
      ["rev-parse", "--short", "HEAD"],
    ]);
    expect(result.detail).toBe("Pushed abc123");
  });

  it("publishes a branch without an upstream to origin and tracks it", async () => {
    const calls: string[][] = [];
    await push("/project", async (_cwd, args) => {
      calls.push(args);
      if (args.includes("@{u}")) throw new Error("no upstream");
      if (args[0] === "branch") return "feature/pr\n";
      if (args[0] === "remote") return "backup\norigin\n";
      return args[0] === "rev-parse" ? "abc123\n" : "";
    });
    expect(calls).toContainEqual(["push", "--set-upstream", "origin", "HEAD:refs/heads/feature/pr"]);
  });

  it("says what is missing when there is no remote or no branch", async () => {
    await expect(push("/project", async (_cwd, args) => {
      if (args.includes("@{u}")) throw new Error("no upstream");
      if (args[0] === "branch") return "feature/pr\n";
      return "";
    })).rejects.toThrow("no remote");
    await expect(push("/project", async (_cwd, args) => {
      if (args.includes("@{u}")) throw new Error("no upstream");
      return "";
    })).rejects.toThrow("detached");
  });
});

describe("workspace refs", () => {
  it("reports detached HEAD without inventing a stale branch", async () => {
    const state = await readProjectGitState("/project", { runGit: async (_cwd, args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/project\n";
      if (args[0] === "rev-parse") return "HEAD\n";
      if (args[0] === "worktree") return "worktree /project\ndetached\n";
      return "";
    }, throwOnError: true });
    expect(state.branch).toBe("detached");
    expect(state.workspace.branch).toBe("detached");
  });

  it("reports upstream divergence without adding another Git process", async () => {
    let commands = 0;
    const state = await readProjectGitState("/project", { runGit: async (_cwd, args) => {
      commands += 1;
      if (args[0] === "rev-parse") return "/project\n";
      if (args[0] === "worktree") return "worktree /project\nbranch refs/heads/main\n";
      if (args[0] === "for-each-ref") return "main\torigin/main\t[ahead 2, behind 1]\n";
      if (args[0] === "remote") return "origin\n";
      return "";
    }, throwOnError: true });
    expect(commands).toBe(6);
    expect(state.workspace).toMatchObject({
      branch: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      hasRemote: true,
    });
  });

  it("parses multiple real newline-delimited refs", async () => {
    const state = await readProjectGitState("/project", { runGit: async (_cwd, args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/project\n";
      if (args[0] === "rev-parse") return "main\n";
      if (args[0] === "for-each-ref") return "feature\nmain\n";
      if (args[0] === "worktree") return "worktree /project\nbranch refs/heads/main\n";
      return "";
    }, throwOnError: true });
    expect(state.workspace.refs.map((ref) => ref.name)).toEqual(["feature", "main"]);
  });
});
