import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mergeThreadBranch, readThreadBranch, readThreadBranches, removeThreadBranch } from "./thread-branches.js";

const created: string[] = [];

afterEach(async () => {
  for (const root of created.splice(0)) await rm(root, { recursive: true, force: true });
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "tau-thread-branches-"));
  created.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  const run = (dir: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "pipe" }).toString().trim();
  run(cwd, "init", "-q", "-b", "main");
  run(cwd, "config", "user.email", "tau@example.com");
  run(cwd, "config", "user.name", "Tau");
  run(cwd, "config", "commit.gpgsign", "false");
  await writeFile(join(cwd, "a.txt"), "one\ntwo\nthree\n");
  run(cwd, "add", "-A");
  run(cwd, "commit", "-qm", "first");
  /** A worktree on a new branch, as Workspace Kit's `create-worktree` makes one. */
  const worktree = (branch: string) => {
    const dir = join(root, branch.replaceAll("/", "-"));
    run(cwd, "worktree", "add", "-q", "-b", branch, dir, "main");
    run(cwd, "config", `branch.${branch}.tau-base`, "main");
    return dir;
  };
  const commit = async (dir: string, file: string, text: string, message = `edit ${file}`) => {
    await writeFile(join(dir, file), text);
    run(dir, "add", "-A");
    run(dir, "commit", "-qm", message);
  };
  return { cwd, root, run, worktree, commit };
}

describe("a thread's worktree branch", () => {
  it("reads what the branch carries against the main checkout's branch, without touching either", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/fix-flake");
    await repo.commit(dir, "b.txt", "bee\nbee\n");
    await repo.commit(dir, "a.txt", "one\n2\nthree\n");
    const head = repo.run(repo.cwd, "rev-parse", "HEAD");

    const branch = await readThreadBranch(dir);
    expect(branch).toMatchObject({ branch: "tau/fix-flake", target: "main", ahead: 2, behind: 0, files: 2, added: 3, removed: 1, uncommitted: 0, merged: false, conflicts: [] });
    expect(branch?.paths.map((entry) => entry.path).sort()).toEqual(["a.txt", "b.txt"]);
    expect(branch?.committedAt).toBeGreaterThan(0);
    expect(repo.run(repo.cwd, "rev-parse", "HEAD")).toBe(head);
  });

  it("names the files that conflict with what the target gained since", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/pagination");
    await repo.commit(dir, "a.txt", "one\nTWO\nthree\n");
    await repo.commit(repo.cwd, "a.txt", "one\nzwei\nthree\n");
    expect(await readThreadBranch(dir)).toMatchObject({ ahead: 1, behind: 1, conflicts: ["a.txt"], merged: false });
  });

  it("tells a merged branch from one that never did anything", async () => {
    const repo = await repository();
    const idle = repo.worktree("tau/idle");
    const done = repo.worktree("tau/done");
    await repo.commit(done, "c.txt", "see\n");
    repo.run(repo.cwd, "merge", "--no-ff", "-q", "-m", "merge", "tau/done");
    expect(await readThreadBranch(idle)).toMatchObject({ ahead: 0, merged: false });
    expect(await readThreadBranch(done)).toMatchObject({ ahead: 0, merged: true, files: 1, added: 1, removed: 0 });
  });

  it("counts uncommitted work and leaves out the main checkout", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/dirty");
    await writeFile(join(dir, "new.txt"), "x\n");
    const branches = await readThreadBranches([dir, repo.cwd, join(repo.root, "missing")]);
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({ branch: "tau/dirty", uncommitted: 1, ahead: 0 });
  });

  it("says why nothing can be checked while the main checkout is detached", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/x");
    repo.run(repo.cwd, "checkout", "-q", "--detach");
    expect(await readThreadBranch(dir)).toMatchObject({ unavailable: "The main checkout is not on a branch." });
  });
});

describe("a branch the target holds under other commits", () => {
  it("is merged by its patches after a cherry-pick the target changed again", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/picked");
    await repo.commit(dir, "c.txt", "see\n");
    repo.run(repo.cwd, "cherry-pick", "-x", repo.run(dir, "rev-parse", "HEAD"));
    await repo.commit(repo.cwd, "c.txt", "SEE\n");
    expect(await readThreadBranch(dir)).toMatchObject({ ahead: 1, merged: true, mergedBy: "patches", conflicts: [] });
  });

  it("is merged by its tree after a squash merge", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/squashed");
    await repo.commit(dir, "c.txt", "see\n");
    await repo.commit(dir, "a.txt", "one\n2\nthree\n");
    repo.run(repo.cwd, "merge", "--squash", "tau/squashed");
    repo.run(repo.cwd, "commit", "-qm", "squash");
    await repo.commit(repo.cwd, "d.txt", "dee\n");
    expect(await readThreadBranch(dir)).toMatchObject({ ahead: 2, merged: true, mergedBy: "tree" });
  });

  it("is merged after a rebase merge onto a target that moved", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/rebased");
    await repo.commit(repo.cwd, "d.txt", "dee\n");
    await repo.commit(dir, "c.txt", "see\n");
    await repo.commit(dir, "e.txt", "e\n");
    repo.run(repo.cwd, "cherry-pick", "-x", "main..tau/rebased");
    expect(await readThreadBranch(dir)).toMatchObject({ ahead: 2, merged: true });
  });

  it("is merged by its patches when the target's history was written anew", async () => {
    const repo = await repository();
    const first = repo.run(repo.cwd, "rev-parse", "HEAD");
    await repo.commit(repo.cwd, "b.txt", "bee\n");
    const dir = repo.worktree("tau/old-history");
    await repo.commit(dir, "a.txt", "one\nTWO\nthree\n");
    // The same two changes on new commits from `first`, then the target edits the line again.
    repo.run(repo.cwd, "reset", "-q", "--hard", first);
    await repo.commit(repo.cwd, "b.txt", "bee\n", "b, rewritten");
    await repo.commit(repo.cwd, "a.txt", "one\nTWO\nthree\n", "a, rewritten");
    await repo.commit(repo.cwd, "a.txt", "one\nzwei\nthree\n");
    expect(await readThreadBranch(dir)).toMatchObject({ ahead: 2, merged: true, mergedBy: "patches", conflicts: [] });
  });

  it("stays open while one of its commits is not in the target", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/half");
    await repo.commit(dir, "c.txt", "see\n");
    repo.run(repo.cwd, "cherry-pick", "-x", repo.run(dir, "rev-parse", "HEAD"));
    await repo.commit(dir, "e.txt", "e\n");
    await repo.commit(repo.cwd, "c.txt", "SEE\n");
    const branch = await readThreadBranch(dir);
    expect(branch).toMatchObject({ ahead: 2, merged: false });
    expect(branch?.mergedBy).toBeUndefined();
  });

  it("names the default branch beside a target that is another one", async () => {
    const repo = await repository();
    repo.run(repo.cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    repo.run(repo.cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const dir = repo.worktree("tau/aside");
    await repo.commit(dir, "c.txt", "see\n");
    expect(await readThreadBranch(dir)).toMatchObject({ target: "main", defaultBranch: "main" });
    repo.run(repo.cwd, "switch", "-q", "-c", "feat/elsewhere");
    expect(await readThreadBranch(dir)).toMatchObject({ target: "feat/elsewhere", defaultBranch: "main" });
  });
});

describe("removing a merged thread's branch", () => {
  it("removes the worktree and the branch once the target holds it, and refuses before", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/cleanup");
    await repo.commit(dir, "c.txt", "see\n");
    await expect(removeThreadBranch(dir)).rejects.toThrow(/main does not hold tau\/cleanup yet/u);
    repo.run(repo.cwd, "cherry-pick", "-x", repo.run(dir, "rev-parse", "HEAD"));
    await writeFile(join(dir, "loose.txt"), "x\n");
    await expect(removeThreadBranch(dir)).rejects.toThrow(/1 file not committed/u);
    await rm(join(dir, "loose.txt"));
    expect(await removeThreadBranch(dir)).toMatchObject({ branch: "tau/cleanup" });
    expect(existsSync(dir)).toBe(false);
    expect(repo.run(repo.cwd, "branch", "--list", "tau/cleanup")).toBe("");
  });
});

describe("merging a thread's branch", () => {
  it("merges a clean branch into the main checkout with a merge commit", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/clean");
    await repo.commit(dir, "c.txt", "see\n");
    const tip = repo.run(dir, "rev-parse", "HEAD");
    const outcome = await mergeThreadBranch(dir, { expectedTip: tip });
    expect(outcome).toMatchObject({ state: "merged", into: "main" });
    expect(repo.run(repo.cwd, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(await readThreadBranch(dir)).toMatchObject({ merged: true });
  });

  it("leaves the checkout alone on a conflict and names the files", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/conflict");
    await repo.commit(dir, "a.txt", "one\nTWO\nthree\n");
    await repo.commit(repo.cwd, "a.txt", "one\nzwei\nthree\n");
    const head = repo.run(repo.cwd, "rev-parse", "HEAD");
    const outcome = await mergeThreadBranch(dir);
    expect(outcome).toMatchObject({ state: "conflict", files: ["a.txt"] });
    expect(repo.run(repo.cwd, "rev-parse", "HEAD")).toBe(head);
    expect(repo.run(repo.cwd, "status", "--porcelain")).toBe("");
  });

  it("refuses a branch that moved since it was read, or holds uncommitted work", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/moving");
    await repo.commit(dir, "c.txt", "see\n");
    const read = repo.run(dir, "rev-parse", "HEAD");
    await repo.commit(dir, "d.txt", "dee\n");
    await expect(mergeThreadBranch(dir, { expectedTip: read })).rejects.toThrow(/moved since it was read/u);
    await writeFile(join(dir, "e.txt"), "e\n");
    await expect(mergeThreadBranch(dir)).rejects.toThrow(/1 file not committed/u);
  });
});
