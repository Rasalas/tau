import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorktree,
  createWorkspaceSnapshot,
  cleanupClonedTurnCheckpointRefs,
  cleanupCheckpointRefsForLiveSessions,
  cleanupOrphanTurnCheckpointRefs,
  cleanupTurnCheckpointRefs,
  cloneTurnCheckpointRefs,
  diffWorkspaceSnapshots,
  diffWorkspaceSnapshotPage,
  getFileDiff,
  getSnapshotFileDiff,
  MAX_DIFF_BYTES,
  MAX_DIFF_HUNKS,
  parseUnifiedDiff,
  push,
  readProjectGitState,
  repositoryDisplayName,
  validateWorkspaceSnapshotRefs,
} from "./workspace-git.js";
import { turnSnapshotRef, type StoredTurnCheckpoint } from "../shared/turn-checkpoint-codec.js";

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
});

describe("immutable turn snapshots", () => {
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
  }, 30_000);

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
  }, 30_000);

  it("clones immutable refs into a fork namespace and removes incomplete copies", async () => {
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
      // on the next session open, while a valid pair remains untouched.
      await cloneTurnCheckpointRefs(cwd, "source", "fork", [checkpoint]);
      await cleanupOrphanTurnCheckpointRefs(cwd, "fork", []);
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
      }]);
      await expect(validateWorkspaceSnapshotRefs(cwd, forkBefore, forkAfter, { sessionId: "fork", turnId: "turn" }))
        .rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

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
});

describe("worktree creation", () => {
  it("creates a new branch from freshly fetched origin/main", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-worktree-"));
    const calls: string[][] = [];
    try {
      const destination = await createWorktree(cwd, "feat/fresh-main", "origin/main", async () => ({
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
      expect(calls.at(-1)).toEqual([
        "worktree", "add", "-b", "feat/fresh-main", destination, "origin/main",
      ]);
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
      await createWorktree(cwd, "feat/local-main", "main", async () => ({
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
      expect(calls.at(-1)?.at(-1)).toBe("main");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not silently create from stale state when fetching fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-worktree-"));
    const calls: string[][] = [];
    try {
      await expect(createWorktree(cwd, "feat/offline", "origin/main", async () => ({
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
  it("pushes the current upstream without creating another commit", async () => {
    const calls: string[][] = [];
    const result = await push("/project", async (_cwd, args) => {
      calls.push(args);
      return args[0] === "rev-parse" ? "abc123\n" : "";
    });
    expect(calls).toEqual([["push"], ["rev-parse", "--short", "HEAD"]]);
    expect(result.detail).toBe("Pushed abc123");
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
