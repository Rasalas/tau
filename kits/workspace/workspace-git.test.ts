import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commit as commitWorkspace,
  getBranchChanges,
  getFileDiff,
  pull,
  push,
  readProjectGitState,
  revertFile,
  stageFile,
  unstageFile,
} from "./workspace-git.js";
import { runGitCommand } from "./git-command.js";

// The host's global and system Git config (LFS filters, credential helpers)
// would otherwise be read by every fixture process here.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

describe("workspace reads beside index writers", () => {
  async function repository() {
    const cwd = await mkdtemp(join(tmpdir(), "tau-git-read-locks-"));
    execFileSync("git", ["init", "-q"], { cwd });
    await writeFile(join(cwd, "clean.txt"), "unchanged\n");
    await writeFile(join(cwd, "changed.txt"), "before\n");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"], { cwd });
    await writeFile(join(cwd, "changed.txt"), "after\n");
    // Changed stat metadata forces porcelain Git to try saving its refreshed index.
    await utimes(join(cwd, "clean.txt"), 1_000_000_000, 1_000_000_000);
    return cwd;
  }

  it.each(["status", "project refresh", "file diff"])("%s leaves the index untouched", async (operation) => {
    const cwd = await repository();
    try {
      const index = join(cwd, ".git", "index");
      const before = await readFile(index);
      if (operation === "status") {
        expect(await runGitCommand(cwd, ["status", "--porcelain"])).toContain("changed.txt");
      } else if (operation === "project refresh") {
        expect((await readProjectGitState(cwd, { throwOnError: true })).changes.files).toEqual([
          expect.objectContaining({ path: "changed.txt", added: 1, removed: 1 }),
        ]);
      } else {
        expect((await getFileDiff(cwd, "changed.txt")).hunks).toHaveLength(1);
        await getFileDiff(cwd, "clean.txt");
      }
      expect(await readFile(index)).toEqual(before);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("refreshes status while git add stages a file without a lock error", async () => {
    const cwd = await repository();
    try {
      const [state] = await Promise.all([
        readProjectGitState(cwd, { throwOnError: true }),
        runGitCommand(cwd, ["add", "--", "changed.txt"]),
      ]);
      expect(state.changes.files).toContainEqual(expect.objectContaining({ path: "changed.txt" }));
      expect((await readProjectGitState(cwd, { throwOnError: true })).changes.files).toEqual([
        expect.objectContaining({ path: "changed.txt", staged: true, added: 1, removed: 1 }),
      ]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});

describe("selective workspace changes", () => {
  it("commits successfully with a fifteen-second pre-commit hook", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-slow-commit-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      const hook = join(cwd, ".git", "hooks", "pre-commit");
      await writeFile(hook, "#!/bin/sh\nsleep 15\n");
      await chmod(hook, 0o755);
      await writeFile(join(cwd, "tracked.txt"), "change\n");

      const result = await commitWorkspace(cwd, "slow hook", false);

      expect(result).toMatchObject({ pushed: false, changes: { files: [] } });
      expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd, encoding: "utf8" }).trim()).toBe("slow hook");
      expect(execFileSync("git", ["show", "HEAD:tracked.txt"], { cwd, encoding: "utf8" })).toBe("change\n");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 90_000);

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

      await mkdir(join(cwd, "src", "nested"), { recursive: true });
      await writeFile(join(cwd, "src", "a.ts"), "one\ntwo\n");
      await writeFile(join(cwd, "src", "nested", "b.ts"), "three\n");
      expect((await readProjectGitState(cwd)).changes.files).toEqual([
        expect.objectContaining({ path: "src/a.ts", status: "untracked", added: 2 }),
        expect.objectContaining({ path: "src/nested/b.ts", status: "untracked", added: 1 }),
      ]);
      await rm(join(cwd, "src"), { recursive: true, force: true });

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
