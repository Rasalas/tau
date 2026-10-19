import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceSnapshot,
  cleanupClonedTurnCheckpointRefs,
  CHECKPOINT_REF_GRACE_MS,
  cleanupCheckpointRefsForLiveSessions,
  cleanupOrphanTurnCheckpointRefs,
  cleanupTurnCheckpointRefs,
  cleanupTurnCheckpointSessionRefs,
  cloneTurnCheckpointRefs,
  diffWorkspaceSnapshots,
  diffWorkspaceSnapshotPage,
  getSnapshotFileDiff,
  previewWorkspaceRestore,
  restoreWorkspaceSnapshot,
  validateWorkspaceSnapshotRefs,
} from "./workspace-snapshots.js";
import { runGitCommand } from "./git-command.js";
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

describe("immutable turn snapshots", () => {
  it.each([
    ["clean", false], ["read-tree", false], ["clean", true], ["read-tree", true],
  ] as const)("keeps a nested Windows workspace after %s with rollback=%s", async (removedBy, rollback) => {
    const root = await mkdtemp(join(tmpdir(), "tau-restore-nested-"));
    const cwd = join(root, "nested", "workspace");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      await writeFile(join(root, "outside.txt"), "outside\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"], { cwd: root });
      await mkdir(cwd, { recursive: true });
      const empty = await createWorkspaceSnapshot(cwd, { namespace: "empty/turn", phase: "before" });
      await createWorkspaceSnapshot(cwd, { namespace: "empty/turn", phase: "after" });
      await writeFile(join(cwd, "current.txt"), "unsaved\n");
      await createWorkspaceSnapshot(cwd, { namespace: "full/turn", phase: "before" });
      const full = await createWorkspaceSnapshot(cwd, { namespace: "full/turn", phase: "after" });
      const target = rollback && removedBy === "read-tree" ? "full" : "empty";
      const backup = target === "empty" ? "full" : "empty";
      if (backup === "empty") await rm(join(cwd, "current.txt"));
      const phases: string[] = [];
      const runGit = async (path: string, args: string[], maxBuffer?: number): Promise<string> => {
        // Real Git supplies the trees; only Windows directory removal is simulated.
        await stat(path);
        if (rollback && removedBy === "clean" && args[0] === "read-tree" && args.at(-1) === empty.treeId) {
          await rm(path, { recursive: true, force: true });
          throw new Error("simulated restore write failure");
        }
        const output = execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: path, encoding: "utf8", maxBuffer });
        if (args[0] === "clean" && removedBy === "clean") await rm(path, { recursive: true, force: true });
        if (args[0] === "read-tree" && removedBy === "read-tree" && args.at(-1) === empty.treeId) {
          await rmdir(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        }
        return output;
      };
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      const restore = restoreWorkspaceSnapshot(cwd, turnSnapshotRef(target, "turn", "after"), {
        target: { sessionId: target, turnId: "turn" },
        rollback: { sessionId: backup, turnId: "turn" },
        runGit,
        onPhase: async (phase) => {
          phases.push(phase);
          if (phase !== "rolling-back") expect((await stat(cwd)).isDirectory()).toBe(true);
          if (rollback && removedBy === "read-tree" && phase === "applied") throw new Error("simulated post-apply failure");
        },
      });
      if (rollback) await expect(restore).rejects.toThrow(/original workspace was restored.*simulated (restore write|post-apply) failure/u);
      else await restore;
      expect((await stat(cwd)).isDirectory()).toBe(true);
      if (rollback && removedBy === "clean") {
        expect(await readFile(join(cwd, "current.txt"), "utf8")).toBe("unsaved\n");
        expect(full.treeId).not.toBe(empty.treeId);
      } else {
        await expect(stat(join(cwd, "current.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(phases).toEqual(rollback
        ? ["apply-started", "cleaned", ...(removedBy === "read-tree" ? ["applied"] : []), "rolling-back"]
        : ["apply-started", "cleaned", "applied"]);
      expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("outside\n");
    } finally {
      Object.defineProperty(process, "platform", platform);
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

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
      const known = [{ sessionId: LIVE_LINKED_SESSION, checkpoints: [] }];

      await cleanupCheckpointRefsForLiveSessions(cwd, known, undefined, { graceMs: 0 });
      await expect(validateWorkspaceSnapshotRefs(cwd, before.id, after.id, {
        sessionId: LIVE_LINKED_SESSION,
        turnId: "turn",
      })).resolves.toMatchObject({ beforeTreeId: before.treeId, afterTreeId: after.treeId });

      await lease.release();
      await cleanupCheckpointRefsForLiveSessions(cwd, known, undefined, { graceMs: 0 });
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

      const known = [{ sessionId: RACE_WRITER_SESSION, checkpoints: [] }];
      await cleanupCheckpointRefsForLiveSessions(cwd, known, runGitDuringSweep, { graceMs: 0 });
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
      await cleanupCheckpointRefsForLiveSessions(cwd, known, undefined, { graceMs: 0 });
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

      // An absent session may belong to another host's session directory.
      await cloneTurnCheckpointRefs(cwd, "source", "fork", [checkpoint]);
      await cleanupCheckpointRefsForLiveSessions(cwd, [{
        sessionId: "source",
        cwd,
        checkpoints: [checkpoint],
      }]);
      await expect(validateWorkspaceSnapshotRefs(cwd, forkBefore, forkAfter, { sessionId: "fork", turnId: "turn" }))
        .resolves.toMatchObject({ beforeTreeId: before.treeId, afterTreeId: after.treeId });

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

  it("checks a thread's checkpoints before it opens with one Git call, however many there are", { timeout: 60_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-open-sweep-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["-c", "user.email=tau@example.test", "-c", "user.name=Tau Test", "commit", "-q", "--allow-empty", "-m", "fixture"], { cwd });
      const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, encoding: "utf8" }).trim();
      const commitId = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
      const checkpoint = (turnId: string): StoredTurnCheckpoint => ({
        id: turnId, turnId, sessionId: "thread", anchorMessageId: `prompt-${turnId}`,
        beforeSnapshotId: turnSnapshotRef("thread", turnId, "before"), afterSnapshotId: turnSnapshotRef("thread", turnId, "after"),
        startedAt: 1, endedAt: 2, files: [], added: 1, removed: 1,
      });
      const kept = Array.from({ length: 30 }, (_, index) => checkpoint(`turn-${index}`));
      const refs = kept.flatMap((entry) => [entry.beforeSnapshotId, entry.afterSnapshotId]);
      // A pair whose "after" names a commit, not a tree, and a ref no entry claims.
      const broken = checkpoint("broken");
      const orphan = turnSnapshotRef("thread", "orphan", "before");
      const lines = [...refs.map((ref) => `create ${ref} ${tree}`), `create ${broken.beforeSnapshotId} ${tree}`, `create ${broken.afterSnapshotId} ${commitId}`, `create ${orphan} ${tree}`];
      execFileSync("git", ["update-ref", "--stdin"], { cwd, input: `${lines.join("\n")}\n` });
      const calls: string[][] = [];
      const counted = (dir: string, args: string[], maxBuffer?: number, signal?: AbortSignal) => {
        calls.push(args);
        return runGitCommand(dir, args, maxBuffer, signal);
      };

      await cleanupOrphanTurnCheckpointRefs(cwd, "thread", [...kept, broken], counted, [], { graceMs: 0 });

      const left = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/tau/checkpoints/thread/"], { cwd, encoding: "utf8" }).trim().split("\n");
      expect(left.sort()).toEqual([...refs].sort());
      // The listing, the broken pair's own check (four calls) and deleting three refs; none per kept checkpoint.
      expect(calls.filter((args) => args[0] === "for-each-ref")).toHaveLength(1);
      expect(calls.filter((args) => args[0] === "rev-parse" || args[0] === "cat-file")).toHaveLength(4);
      expect(calls.filter((args) => args[0] === "update-ref")).toHaveLength(3);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("sweeps every session's checkpoints in a workspace with one listing", { timeout: 60_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-live-sweep-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["-c", "user.email=tau@example.test", "-c", "user.name=Tau Test", "commit", "-q", "--allow-empty", "-m", "fixture"], { cwd });
      const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, encoding: "utf8" }).trim();
      const sessions = ["first", "second"].map((sessionId) => ({
        sessionId,
        cwd,
        checkpoints: Array.from({ length: 20 }, (_, index): StoredTurnCheckpoint => ({
          id: `turn-${index}`, turnId: `turn-${index}`, sessionId, anchorMessageId: `prompt-${index}`,
          beforeSnapshotId: turnSnapshotRef(sessionId, `turn-${index}`, "before"), afterSnapshotId: turnSnapshotRef(sessionId, `turn-${index}`, "after"),
          startedAt: 1, endedAt: 2, files: [], added: 1, removed: 1,
        })),
      }));
      const refs = sessions.flatMap((session) => session.checkpoints.flatMap((entry) => [entry.beforeSnapshotId, entry.afterSnapshotId]));
      const gone = turnSnapshotRef("deleted", "turn", "before");
      sessions.push({ sessionId: "deleted", cwd, checkpoints: [] });
      execFileSync("git", ["update-ref", "--stdin"], { cwd, input: `${[...refs, gone].map((ref) => `create ${ref} ${tree}`).join("\n")}\n` });
      const calls: string[][] = [];
      const counted = (dir: string, args: string[], maxBuffer?: number, signal?: AbortSignal) => {
        calls.push(args);
        return runGitCommand(dir, args, maxBuffer, signal);
      };

      await cleanupCheckpointRefsForLiveSessions(cwd, sessions, counted, { graceMs: 0 });

      const left = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/tau/checkpoints/"], { cwd, encoding: "utf8" }).trim().split("\n");
      expect(left.sort()).toEqual([...refs].sort());
      expect(calls.filter((args) => args[0] === "for-each-ref")).toHaveLength(1);
      expect(calls.filter((args) => args[0] === "rev-parse" || args[0] === "cat-file")).toHaveLength(0);
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

describe.each(["git", "filesystem"] as const)("%s snapshot contract", (backend) => {
  async function workspace(run: (cwd: string) => Promise<void>): Promise<void> {
    const cwd = await mkdtemp(join(tmpdir(), "tau-snapshot-contract-"));
    try {
      if (backend === "git") execFileSync("git", ["init", "-q"], { cwd });
      await run(cwd);
    } finally {
      await cleanupTurnCheckpointSessionRefs(cwd, "contract");
      await rm(cwd, { recursive: true, force: true });
    }
  }

  it("uses immutable history and validates the owner for every historical read", async () => workspace(async (cwd) => {
    await writeFile(join(cwd, "note.txt"), "before\n");
    const before = await createWorkspaceSnapshot(cwd, { namespace: "contract/turn", phase: "before" });
    await writeFile(join(cwd, "note.txt"), "after\n");
    const after = await createWorkspaceSnapshot(cwd, { namespace: "contract/turn", phase: "after" });
    expect(after.backend).toBe(backend);
    await writeFile(join(cwd, "note.txt"), "later\n");
    await expect(createWorkspaceSnapshot(cwd, { namespace: "contract/turn", phase: "after" }))
      .rejects.toThrow("already points to another tree");

    const expected = { sessionId: "contract", turnId: "turn" };
    const historical = await getSnapshotFileDiff(cwd, before.id, after.id, "note.txt", {}, expected);
    expect(historical.hunks.flatMap((hunk) => hunk.lines).map((line) => line.text)).toEqual(["before", "after"]);
    const foreign = { sessionId: "someone-else", turnId: "turn" };
    await expect(diffWorkspaceSnapshots(cwd, before.id, after.id, { expected: foreign })).rejects.toThrow("session and turn");
    await expect(diffWorkspaceSnapshotPage(cwd, before.id, after.id, foreign)).rejects.toThrow("session and turn");
    expect(await getSnapshotFileDiff(cwd, before.id, after.id, "note.txt", {}, foreign))
      .toMatchObject({ hunks: [], note: "Could not read this historical diff." });
  }));

  it("leaves out what a .gitignore names, in its folder and below, and keeps it through a restore", async () => workspace(async (cwd) => {
    await mkdir(join(cwd, "pkg", ".tau-types"), { recursive: true });
    await mkdir(join(cwd, "pkg", "src"), { recursive: true });
    await writeFile(join(cwd, "pkg", ".gitignore"), ".tau-types/\n*.log\n");
    await writeFile(join(cwd, "pkg", "desktop.tsx"), "one\n");
    await writeFile(join(cwd, "pkg", ".tau-types", "tau.d.ts"), "types\n");
    await createWorkspaceSnapshot(cwd, { namespace: "contract/target", phase: "before" });
    const target = await createWorkspaceSnapshot(cwd, { namespace: "contract/target", phase: "after" });
    const before = await createWorkspaceSnapshot(cwd, { namespace: "contract/ignored", phase: "before" });
    await writeFile(join(cwd, "pkg", "desktop.tsx"), "two\n");
    await writeFile(join(cwd, "pkg", "src", "debug.log"), "noise\n");
    await writeFile(join(cwd, "pkg", ".tau-types", "tau.d.ts"), "newer types\n");
    await writeFile(join(cwd, "pkg", ".tau-types", "extra.d.ts"), "more types\n");
    const after = await createWorkspaceSnapshot(cwd, { namespace: "contract/ignored", phase: "after" });
    const summary = await diffWorkspaceSnapshots(cwd, before.id, after.id);
    expect(summary.files.map((file) => file.path)).toEqual(["pkg/desktop.tsx"]);
    await createWorkspaceSnapshot(cwd, { namespace: "contract/rollback", phase: "before" });
    await createWorkspaceSnapshot(cwd, { namespace: "contract/rollback", phase: "after" });
    await restoreWorkspaceSnapshot(cwd, target.id, {
      target: { sessionId: "contract", turnId: "target" },
      rollback: { sessionId: "contract", turnId: "rollback" },
    });
    expect(await readFile(join(cwd, "pkg", "desktop.tsx"), "utf8")).toBe("one\n");
    expect(await readFile(join(cwd, "pkg", ".tau-types", "extra.d.ts"), "utf8")).toBe("more types\n");
    expect(await readFile(join(cwd, "pkg", "src", "debug.log"), "utf8")).toBe("noise\n");
  }));

  it("rolls back a failure after apply and preserves excluded folders", async () => workspace(async (cwd) => {
    await writeFile(join(cwd, "note.txt"), "before\n");
    if (backend === "git") await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
    await createWorkspaceSnapshot(cwd, { namespace: "contract/target", phase: "before" });
    await writeFile(join(cwd, "note.txt"), "target\n");
    const target = await createWorkspaceSnapshot(cwd, { namespace: "contract/target", phase: "after" });
    await writeFile(join(cwd, "note.txt"), "current\n");
    await writeFile(join(cwd, "current.txt"), "unsaved\n");
    await mkdir(join(cwd, "node_modules"));
    await writeFile(join(cwd, "node_modules", "kept.txt"), "kept\n");
    await createWorkspaceSnapshot(cwd, { namespace: "contract/rollback", phase: "before" });
    await createWorkspaceSnapshot(cwd, { namespace: "contract/rollback", phase: "after" });
    const phases: string[] = [];
    await expect(restoreWorkspaceSnapshot(cwd, target.id, {
      target: { sessionId: "contract", turnId: "target" },
      rollback: { sessionId: "contract", turnId: "rollback" },
      onPhase: (phase) => {
        phases.push(phase);
        if (phase === "applied" || phase === "rolling-back") throw new Error("phase persistence failed");
      },
    })).rejects.toThrow("original workspace was restored");
    expect(phases).toContain("rolling-back");
    expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("current\n");
    expect(await readFile(join(cwd, "current.txt"), "utf8")).toBe("unsaved\n");
    expect(await readFile(join(cwd, "node_modules", "kept.txt"), "utf8")).toBe("kept\n");
  }));

  it("retains recent publication, then collects unrooted history", async () => workspace(async (cwd) => {
    await writeFile(join(cwd, "note.txt"), "before\n");
    const before = await createWorkspaceSnapshot(cwd, { namespace: "contract/orphan", phase: "before" });
    await writeFile(join(cwd, "note.txt"), "after\n");
    const after = await createWorkspaceSnapshot(cwd, { namespace: "contract/orphan", phase: "after" });
    const sessions = [{ sessionId: "contract", cwd, checkpoints: [] }];
    const expected = { sessionId: "contract", turnId: "orphan" };
    await cleanupCheckpointRefsForLiveSessions(cwd, sessions);
    await expect(validateWorkspaceSnapshotRefs(cwd, before.id, after.id, expected)).resolves.toBeDefined();
    await cleanupCheckpointRefsForLiveSessions(cwd, sessions, undefined, { now: Date.now() + CHECKPOINT_REF_GRACE_MS + 1_000 });
    await expect(validateWorkspaceSnapshotRefs(cwd, before.id, after.id, expected)).rejects.toThrow();
  }));

  it("retains a half-published rollback until recovery has committed", async () => workspace(async (cwd) => {
    await writeFile(join(cwd, "note.txt"), "backup\n");
    const before = await createWorkspaceSnapshot(cwd, { namespace: "contract/backup", phase: "before" });
    const transaction: TurnRestoreTransaction = {
      version: 1, kind: "backup-open", transactionId: "pending", state: "workspace-applied",
      sessionId: "contract", backupSessionId: "contract", backupTurnId: "backup",
      sourceSessionId: "contract", sourceTurnId: "target", sourceCheckpointId: "target",
      targetSessionId: "contract", cwd,
      targetAfterSnapshotId: turnSnapshotRef("contract", "target", "after"),
      backupAfterSnapshotId: turnSnapshotRef("contract", "backup", "after"), createdAt: Date.now(),
    };
    const sessions = [{ sessionId: "contract", cwd, checkpoints: [], restoreTransactions: [transaction] }];
    await cleanupCheckpointRefsForLiveSessions(cwd, sessions, undefined, { graceMs: 0 });
    const after = await createWorkspaceSnapshot(cwd, { namespace: "contract/backup", phase: "after" });
    const expected = { sessionId: "contract", turnId: "backup" };
    await expect(validateWorkspaceSnapshotRefs(cwd, before.id, after.id, expected)).resolves.toBeDefined();
    transaction.state = "committed";
    await cleanupCheckpointRefsForLiveSessions(cwd, sessions, undefined, { graceMs: 0 });
    await expect(validateWorkspaceSnapshotRefs(cwd, before.id, after.id, expected)).rejects.toThrow();
  }));
});

it("keeps Git capture failures visible after recognizing a repository", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tau-capture-failure-"));
  try {
    await writeFile(join(cwd, "note.txt"), "before\n");
    await expect(createWorkspaceSnapshot(cwd, {
      namespace: "capture-failure/turn", phase: "before",
      runGit: async (_cwd, args) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
        throw new Error("Git storage failure");
      },
    })).rejects.toThrow("Git storage failure");
    const after = await createWorkspaceSnapshot(cwd, { namespace: "capture-failure/turn", phase: "after" });
    await expect(validateWorkspaceSnapshotRefs(cwd, turnSnapshotRef("capture-failure", "turn", "before"), after.id,
      { sessionId: "capture-failure", turnId: "turn" })).rejects.toThrow();
  } finally {
    await cleanupTurnCheckpointSessionRefs(cwd, "capture-failure");
    await rm(cwd, { recursive: true, force: true });
  }
});
