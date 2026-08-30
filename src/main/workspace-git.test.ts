import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getFileDiff, MAX_DIFF_BYTES, MAX_DIFF_HUNKS, parseUnifiedDiff, readProjectGitState } from "./workspace-git.js";

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
