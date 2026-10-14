import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentBranchName, createAgentWorktree, readBranchBase, runAgentGit, type AgentGitRunner } from "./agent-worktrees.js";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "tau-worktree-create-"));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.name", "Tau");
  git(cwd, "config", "user.email", "tau@example.com");
  await writeFile(join(cwd, "README.md"), "start\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "first");
  return { root, cwd, worktreeParent: join(root, "children") };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("parallel worktree creation", () => {
  it("records the base and target of every concurrent child across the repository's checkouts", async () => {
    const { root, cwd, worktreeParent } = await repository();
    // The barrier forces contention; more children only add Git subprocess load.
    const childCount = 8;
    const linked = join(root, "linked");
    git(cwd, "worktree", "add", "-b", "feature/parent", linked);
    let added = 0;
    let writing = false;
    let collisions = 0;
    let release!: () => void;
    const allAdded = new Promise<void>((resolve) => { release = resolve; });
    const runGit: AgentGitRunner = async (path, args, options) => {
      if (args[0] === "config" && !args[1].startsWith("--")) {
        // Hold the first write until every child can contend for the same config.
        if (writing) {
          collisions += 1;
          throw new Error("could not lock config file: File exists");
        }
        writing = true;
        try {
          await allAdded;
          return await runAgentGit(path, args, options);
        } finally {
          writing = false;
        }
      }
      const output = await runAgentGit(path, args, options);
      if (args[0] === "worktree" && args[1] === "add" && ++added === childCount) release();
      return output;
    };
    const results = await Promise.allSettled(Array.from({ length: childCount }, (_, index) => createAgentWorktree({
      parentCwd: index % 2 ? linked : cwd,
      agentId: index.toString(16).padStart(8, "0"),
      worktreeParent,
      runGit,
    })));
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    expect(collisions).toBe(0);
    for (const [index, result] of results.entries()) {
      if (result.status !== "fulfilled") continue;
      const child = result.value;
      expect(await readBranchBase(child.path, child.branch)).toBe(child.baseCommit);
      expect(git(child.path, "config", "--get", `branch.${child.branch}.tau-review-target`)).toBe(index % 2 ? "feature/parent" : "main");
    }
    expect(git(cwd, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(childCount + 2);
    expect(await readdir(worktreeParent)).toHaveLength(childCount);
  }, 60_000);

  it("retries actual config lock errors for both required metadata writes", async () => {
    const { cwd, worktreeParent } = await repository();
    const attempts = new Map<string, number>();
    const runGit: AgentGitRunner = async (path, args, options) => {
      if (args[0] !== "config") return runAgentGit(path, args, options);
      const count = (attempts.get(args[1]) ?? 0) + 1;
      attempts.set(args[1], count);
      if (count > 1) return runAgentGit(path, args, options);
      const lock = join(cwd, ".git", "config.lock");
      await writeFile(lock, "", { flag: "wx" });
      try {
        return await runAgentGit(path, args, options);
      } finally {
        await rm(lock);
      }
    };
    const child = await createAgentWorktree({ parentCwd: cwd, agentId: "12345678", worktreeParent, runGit });
    expect(await readBranchBase(child.path, child.branch)).toBe(child.baseCommit);
    expect(git(cwd, "config", "--get", `branch.${child.branch}.tau-review-target`)).toBe("main");
    expect([...attempts.values()]).toEqual([2, 2]);
  });

  it.each(["tau-base", "tau-review-target"])("removes the worktree and branch when %s cannot be recorded, and allows another creation", async (key) => {
    const { cwd, worktreeParent } = await repository();
    let attempts = 0;
    const runGit: AgentGitRunner = (path, args, options) => {
      if (args[0] === "config" && args[1].endsWith(key)) {
        attempts += 1;
        return Promise.reject(new Error("config is read-only"));
      }
      return runAgentGit(path, args, options);
    };
    await expect(createAgentWorktree({ parentCwd: cwd, agentId: "12345678", worktreeParent, runGit })).rejects.toThrow("config is read-only");
    expect(attempts).toBe(1);
    expect(git(cwd, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
    expect(git(cwd, "branch", "--list", agentBranchName("12345678"))).toBe("");
    expect(await readdir(worktreeParent)).toEqual([]);
    const child = await createAgentWorktree({ parentCwd: cwd, agentId: "12345678", worktreeParent });
    expect(await readBranchBase(child.path, child.branch)).toBe(child.baseCommit);
  });

  it("bounds retries for a persistent lock and leaves no worktree behind", async () => {
    const { cwd, worktreeParent } = await repository();
    let attempts = 0;
    const runGit: AgentGitRunner = (path, args, options) => {
      if (args[0] === "config") {
        attempts += 1;
        return Promise.reject(new Error("could not lock config file: File exists"));
      }
      return runAgentGit(path, args, options);
    };
    await expect(createAgentWorktree({ parentCwd: cwd, agentId: "12345678", worktreeParent, runGit })).rejects.toThrow("could not lock config file");
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(10);
    expect(git(cwd, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
    expect(await readdir(worktreeParent)).toEqual([]);
  });

  it("keeps an existing child's worktree when worktree add refuses a duplicate branch", async () => {
    const { cwd, worktreeParent } = await repository();
    const child = await createAgentWorktree({ parentCwd: cwd, agentId: "12345678", worktreeParent });
    await writeFile(join(child.path, "draft.txt"), "keep this\n");
    await expect(createAgentWorktree({ parentCwd: cwd, agentId: "12345678", worktreeParent })).rejects.toThrow();
    expect(git(cwd, "worktree", "list")).toContain(child.branch);
    expect(git(child.path, "status", "--porcelain")).toBe("?? draft.txt");
    expect(await readBranchBase(child.path, child.branch)).toBe(child.baseCommit);
  });
});
