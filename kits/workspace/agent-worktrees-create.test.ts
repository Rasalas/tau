import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentBranchName, createAgentWorktree, readBranchBase, runAgentGit, type AgentGitRunner } from "./agent-worktrees.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return { ...original, realpath: vi.fn(original.realpath) };
});

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

function sharedMutation(args: string[]): boolean {
  return args[0] === "worktree" && ["add", "remove", "prune"].includes(args[1])
    || args[0] === "config" && !args[1].startsWith("--")
    || args[0] === "branch" && args[1] === "-D";
}

async function alignPreparations(parent: string, count: number): Promise<() => void> {
  const { realpath } = await vi.importActual<typeof fs>("node:fs/promises");
  let prepared = 0;
  let release!: () => void;
  const allPrepared = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(fs.realpath).mockImplementation(async (...args) => {
    const canonical = await realpath(...args);
    if (args[0] === parent) {
      if (++prepared === count) release();
      await allPrepared;
    }
    return canonical;
  });
  return release;
}

afterEach(async () => {
  vi.mocked(fs.realpath).mockImplementation((await vi.importActual<typeof fs>("node:fs/promises")).realpath);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("parallel worktree creation", () => {
  it("records the base and target of every concurrent child across the repository's checkouts", async () => {
    const { root, cwd, worktreeParent } = await repository();
    const childCount = 8;
    const linked = join(root, "linked");
    git(cwd, "worktree", "add", "-b", "feature/parent", linked);
    await writeFile(join(cwd, "README.md"), "main advanced\n");
    git(cwd, "commit", "-qam", "advance main");
    const startPoint = git(cwd, "rev-parse", "HEAD");
    await writeFile(join(linked, "draft.txt"), "parent draft\n");
    vi.resetModules();
    const copy = await import("./agent-worktrees.js");
    expect(copy.createAgentWorktree).not.toBe(createAgentWorktree);

    // Align callers after their private preparation, before any shared Git
    // mutations. Unlike a barrier inside a config write, this does not require
    // another mutation to enter while the first one holds the queue.
    const release = await alignPreparations(worktreeParent, childCount);
    let mutating = false;
    const collisions: string[] = [];
    const runGit: AgentGitRunner = async (path, args, options) => {
      if (!sharedMutation(args)) return runAgentGit(path, args, options);
      if (mutating) {
        collisions.push(args.join(" "));
        throw new Error(`Overlapping worktree metadata mutation: ${args.join(" ")}`);
      }
      mutating = true;
      try {
        // The preparation barrier has released every caller. One event-loop
        // turn lets all of their ready continuations attempt admission.
        await new Promise<void>((resolve) => setImmediate(resolve));
        return await runAgentGit(path, args, options);
      } finally {
        mutating = false;
      }
    };
    const results = await Promise.allSettled(Array.from({ length: childCount }, (_, index) => (index % 2 ? copy.createAgentWorktree : createAgentWorktree)({
      parentCwd: index % 2 ? linked : cwd,
      agentId: index.toString(16).padStart(8, "0"),
      worktreeParent,
      ...(index === 3 ? { startPoint } : {}),
      runGit,
    }).catch((error: unknown) => {
      release();
      throw error;
    })));
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    expect(collisions).toEqual([]);
    for (const [index, result] of results.entries()) {
      if (result.status !== "fulfilled") continue;
      const child = result.value;
      const inheritedDraft = index % 2 === 1 && index !== 3;
      expect(child.withUncommitted).toBe(inheritedDraft);
      if (inheritedDraft) expect(git(child.path, "show", "HEAD:draft.txt")).toBe("parent draft");
      else expect(child.baseCommit).toBe(startPoint);
      expect(await readBranchBase(child.path, child.branch)).toBe(child.baseCommit);
      expect(git(child.path, "config", "--get", `branch.${child.branch}.tau-review-target`)).toBe(index % 2 ? "feature/parent" : "main");
    }
    expect(git(cwd, "status", "--porcelain")).toBe("");
    expect(git(linked, "status", "--porcelain")).toBe("?? draft.txt");
    expect(git(cwd, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(childCount + 2);
    expect(await readdir(worktreeParent)).toHaveLength(childCount);
  }, 60_000);

  it.each(["add", "metadata", "rollback"])("releases queued creations after a failure in %s", async (failure) => {
    const { cwd, worktreeParent } = await repository();
    const release = await alignPreparations(worktreeParent, 2);
    vi.resetModules();
    const copy = await import("./agent-worktrees.js");
    const mutations: string[][] = [];
    let failedBranch = "";
    const runGit: AgentGitRunner = async (path, args, options) => {
      if (sharedMutation(args)) mutations.push(args);
      if (args[0] === "worktree" && args[1] === "add" && !failedBranch) {
        failedBranch = args[3];
        if (failure === "add") throw new Error("injected add failure");
      }
      if (args[0] === "config" && args[1] === `branch.${failedBranch}.tau-review-target`) throw new Error("injected metadata failure");
      if (failure === "rollback" && args[0] === "worktree" && args[1] === "remove") throw new Error("injected rollback failure");
      return runAgentGit(path, args, options);
    };
    const results = await Promise.allSettled([createAgentWorktree, copy.createAgentWorktree].map((create, index) => create({
      parentCwd: cwd, agentId: `0000000${index}`, worktreeParent, runGit,
    }).catch((error: unknown) => { release(); throw error; })));
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected");
    expect(failed?.reason.message).toContain(`injected ${failure === "add" ? "add" : "metadata"} failure`);
    if (failure === "rollback") expect(failed?.reason).toBeInstanceOf(AggregateError);
    const successful = results.find((result) => result.status === "fulfilled");
    expect(successful).toBeDefined();
    if (!successful) return;
    expect(await readBranchBase(successful.value.path, successful.value.branch)).toBe(successful.value.baseCommit);
    expect(git(cwd, "config", "--get", `branch.${successful.value.branch}.tau-review-target`)).toBe("main");
    const nextAdd = mutations.findIndex((args) => args[0] === "worktree" && args[1] === "add" && args[3] !== failedBranch);
    if (failure !== "add") {
      expect(mutations.findIndex((args) => args[0] === "worktree" && args[1] === "remove")).toBeLessThan(nextAdd);
      if (failure !== "rollback") expect(mutations.findIndex((args) => args[0] === "branch" && args[1] === "-D")).toBeLessThan(nextAdd);
    }
    if (failure === "rollback") expect(git(cwd, "branch", "--list", failedBranch)).toContain(failedBranch);
    else expect(git(cwd, "branch", "--list", failedBranch)).toBe("");
    expect(git(cwd, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(failure === "rollback" ? 3 : 2);
    expect(await readdir(worktreeParent)).toHaveLength(failure === "rollback" ? 2 : 1);
  });

  it("allows another repository to create while an add is held", async () => {
    const repo = await repository();
    const other = await repository();
    vi.resetModules();
    const copy = await import("./agent-worktrees.js");
    let entered!: () => void;
    const adding = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const runGit: AgentGitRunner = async (path, args, options) => {
      if (args[0] === "worktree" && args[1] === "add") { entered(); await held; }
      return runAgentGit(path, args, options);
    };
    const first = Promise.allSettled([createAgentWorktree({ parentCwd: repo.cwd, agentId: "11111111", worktreeParent: repo.worktreeParent, runGit })]);
    await adding;
    try {
      const child = await copy.createAgentWorktree({ parentCwd: other.cwd, agentId: "11111111", worktreeParent: other.worktreeParent });
      expect(await readBranchBase(child.path, child.branch)).toBe(child.baseCommit);
    } finally {
      release();
      expect((await first)[0].status).toBe("fulfilled");
    }
  });

  it("queues removal and picker pruning behind an add, across linked and aliased checkouts", async () => {
    const { cwd, root, worktreeParent } = await repository();
    const linked = join(root, "linked");
    git(cwd, "worktree", "add", "-b", "feature/parent", linked);
    const alias = join(root, "alias");
    await fs.symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    const old = await createAgentWorktree({ parentCwd: cwd, agentId: "00000000", worktreeParent });
    vi.resetModules();
    const copy = await import("./agent-worktrees.js");
    const { readWorktreeStatuses } = await import("./workspace-worktrees.js");
    let entered!: () => void;
    const adding = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let released = false;
    const overlaps: string[][] = [];
    const runGit: AgentGitRunner = async (path, args, options) => {
      if (args[0] === "worktree" && args[1] === "add") { entered(); await held; }
      else if (sharedMutation(args) && !released) overlaps.push(args);
      return runAgentGit(path, args, options);
    };
    const first = Promise.allSettled([createAgentWorktree({ parentCwd: cwd, agentId: "11111111", worktreeParent, runGit })]);
    await adding;
    // Observe each contender finishing canonical resolution. Their continuation
    // can now enqueue without further filesystem reads before admission.
    const { realpath } = await vi.importActual<typeof fs>("node:fs/promises");
    const common = await realpath(join(cwd, ".git"));
    let resolved = 0;
    let ready!: () => void;
    const contendersReady = new Promise<void>((resolve) => { ready = resolve; });
    vi.mocked(fs.realpath).mockImplementation(async (...args) => {
      const canonical = await realpath(...args);
      if (canonical === common && ++resolved === 2) ready();
      return canonical;
    });
    const contenders = Promise.allSettled([
      copy.removeAgentWorktree({ parentCwd: alias, worktree: old, runGit }),
      readWorktreeStatuses([{ path: linked, name: "parent", isMain: false, isCurrent: true }], [], [], (path, args) => runGit(path, args)),
    ]);
    try {
      await contendersReady;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(overlaps).toEqual([]);
    } finally {
      released = true;
      release();
      expect((await first)[0].status).toBe("fulfilled");
      expect((await contenders).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    }
    expect(git(cwd, "branch", "--list", old.branch)).toBe("");
    expect(git(cwd, "worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(3);
    expect(await readdir(worktreeParent)).toEqual(["tau-agent-11111111"]);
  });

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
