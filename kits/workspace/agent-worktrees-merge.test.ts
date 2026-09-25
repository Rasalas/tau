import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureWorktreeTree, mergeBranchIntoCheckout, previewBranchMerge } from "./agent-worktrees.js";

const created: string[] = [];

afterEach(async () => {
  for (const root of created.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A checkout with one commit, and a helper to run git in it. */
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "tau-branch-merge-"));
  created.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "tau@example.com");
  git("config", "user.name", "Tau");
  git("config", "commit.gpgsign", "false");
  await writeFile(join(cwd, "a.txt"), "one\ntwo\nthree\n");
  await writeFile(join(cwd, "b.txt"), "bee\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  return { cwd, git, root };
}

/**
 * A branch that starts from the checkout's state — HEAD plus its uncommitted
 * work as one commit, as a transfer sends it — and adds `work` on top.
 */
async function branchFromState(repo: Awaited<ReturnType<typeof repository>>, branch: string, work: (dir: string) => Promise<void>): Promise<string> {
  const head = repo.git("rev-parse", "HEAD");
  const tree = await captureWorktreeTree(repo.cwd);
  const base = tree === repo.git("rev-parse", "HEAD^{tree}") ? head : repo.git("commit-tree", tree, "-p", head, "-m", "state");
  const dir = join(repo.root, branch.replaceAll("/", "-"));
  repo.git("worktree", "add", "-q", "-b", branch, dir, base);
  await work(dir);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "work"], { cwd: dir });
  return base;
}

describe("merging a branch back into a checkout", () => {
  it("checks a merge without touching the checkout, and merges a clean one with --no-ff", async () => {
    const repo = await repository();
    await branchFromState(repo, "tau/rex/clean", async (dir) => { await writeFile(join(dir, "c.txt"), "new\n"); });
    const before = repo.git("rev-parse", "HEAD");
    expect(await previewBranchMerge(repo.cwd, "tau/rex/clean")).toMatchObject({ conflicts: [], merged: false });
    expect(repo.git("rev-parse", "HEAD")).toBe(before);

    const outcome = await mergeBranchIntoCheckout({ cwd: repo.cwd, branch: "tau/rex/clean" });
    expect(outcome.state).toBe("merged");
    expect(repo.git("rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(await readFile(join(repo.cwd, "c.txt"), "utf8")).toBe("new\n");
    expect(await mergeBranchIntoCheckout({ cwd: repo.cwd, branch: "tau/rex/clean" })).toMatchObject({ state: "already-merged" });
  });

  it("takes the merge over uncommitted work the branch started from, and leaves a clean checkout", async () => {
    const repo = await repository();
    await writeFile(join(repo.cwd, "a.txt"), "one\ntwo\nthree\nfour\n");
    await writeFile(join(repo.cwd, "draft.md"), "untracked\n");
    const base = await branchFromState(repo, "tau/rex/over", async (dir) => {
      // The other side edits the file the checkout had changed, and one it had not.
      await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
      await writeFile(join(dir, "b.txt"), "bee\nbuzz\n");
    });
    const head = repo.git("rev-parse", "HEAD");
    const outcome = await mergeBranchIntoCheckout({ cwd: repo.cwd, branch: "tau/rex/over", base });
    expect(outcome).toMatchObject({ state: "merged" });
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(repo.git("rev-parse", "HEAD^1")).toBe(head);
    expect(repo.git("rev-parse", "ORIG_HEAD")).toBe(head);
    expect(await readFile(join(repo.cwd, "a.txt"), "utf8")).toBe("one\ntwo\nthree\nfour\nfive\n");
    expect(await readFile(join(repo.cwd, "draft.md"), "utf8")).toBe("untracked\n");
  });

  it("refuses when the checkout changed a file again after the branch started, and touches nothing", async () => {
    const repo = await repository();
    await writeFile(join(repo.cwd, "a.txt"), "one\ntwo\nthree\nfour\n");
    const base = await branchFromState(repo, "tau/rex/later", async (dir) => { await writeFile(join(dir, "b.txt"), "other\n"); });
    // Changed here since: that version is recorded nowhere else.
    await writeFile(join(repo.cwd, "a.txt"), "rewritten here\n");
    const head = repo.git("rev-parse", "HEAD");
    const status = repo.git("status", "--porcelain");
    const outcome = await mergeBranchIntoCheckout({ cwd: repo.cwd, branch: "tau/rex/later", base });
    expect(outcome).toMatchObject({ state: "blocked", files: ["a.txt"] });
    expect(repo.git("rev-parse", "HEAD")).toBe(head);
    expect(repo.git("status", "--porcelain")).toBe(status);
    expect(await readFile(join(repo.cwd, "a.txt"), "utf8")).toBe("rewritten here\n");
  });

  it("reports a conflict with its files and leaves HEAD, index and files as they were", async () => {
    const repo = await repository();
    await branchFromState(repo, "tau/rex/conflict", async (dir) => { await writeFile(join(dir, "a.txt"), "one\nTHERE\nthree\n"); });
    await writeFile(join(repo.cwd, "a.txt"), "one\nHERE\nthree\n");
    repo.git("commit", "-qam", "here");
    const head = repo.git("rev-parse", "HEAD");
    const preview = await previewBranchMerge(repo.cwd, "tau/rex/conflict");
    expect(preview.conflicts).toEqual(["a.txt"]);
    const outcome = await mergeBranchIntoCheckout({ cwd: repo.cwd, branch: "tau/rex/conflict" });
    expect(outcome).toMatchObject({ state: "conflict", files: ["a.txt"] });
    expect(repo.git("rev-parse", "HEAD")).toBe(head);
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(repo.git("rev-parse", "--verify", "tau/rex/conflict")).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("follows a rename on the other side and a binary file", async () => {
    const repo = await repository();
    await writeFile(join(repo.cwd, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    repo.git("add", "-A");
    repo.git("commit", "-qm", "binary");
    await branchFromState(repo, "tau/rex/rename", async (dir) => {
      execFileSync("git", ["mv", "b.txt", "renamed.txt"], { cwd: dir });
      await writeFile(join(dir, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
    });
    // Meanwhile here: the renamed file changes, in lines the rename does not touch.
    await writeFile(join(repo.cwd, "b.txt"), "bee\nand more\n");
    repo.git("commit", "-qam", "here");
    const outcome = await mergeBranchIntoCheckout({ cwd: repo.cwd, branch: "tau/rex/rename" });
    expect(outcome.state).toBe("merged");
    expect(existsSync(join(repo.cwd, "b.txt"))).toBe(false);
    expect(await readFile(join(repo.cwd, "renamed.txt"), "utf8")).toBe("bee\nand more\n");
    expect([...await readFile(join(repo.cwd, "pixel.png"))]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]);
  });

  it("names a binary file both sides changed as a conflict", async () => {
    const repo = await repository();
    await writeFile(join(repo.cwd, "pixel.png"), Buffer.from([0, 1, 2]));
    repo.git("add", "-A");
    repo.git("commit", "-qm", "binary");
    await branchFromState(repo, "tau/rex/binary", async (dir) => { await writeFile(join(dir, "pixel.png"), Buffer.from([0, 7, 7])); });
    await writeFile(join(repo.cwd, "pixel.png"), Buffer.from([0, 8, 8]));
    repo.git("commit", "-qam", "here");
    expect(await mergeBranchIntoCheckout({ cwd: repo.cwd, branch: "tau/rex/binary" })).toMatchObject({ state: "conflict", files: ["pixel.png"] });
    expect([...await readFile(join(repo.cwd, "pixel.png"))]).toEqual([0, 8, 8]);
  });

  it("drops an untracked file the other side deleted, when the checkout still has it as it went", async () => {
    const repo = await repository();
    await writeFile(join(repo.cwd, "scratch.md"), "went along\n");
    const base = await branchFromState(repo, "tau/rex/drop", async (dir) => { await rm(join(dir, "scratch.md")); });
    expect(await mergeBranchIntoCheckout({ cwd: repo.cwd, branch: "tau/rex/drop", base })).toMatchObject({ state: "merged" });
    expect(existsSync(join(repo.cwd, "scratch.md"))).toBe(false);
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  it("waits for a merge in progress", async () => {
    const repo = await repository();
    await branchFromState(repo, "tau/rex/wait", async (dir) => { await writeFile(join(dir, "c.txt"), "c\n"); });
    // A merge that stopped leaves MERGE_HEAD behind; git writes it as a plain file.
    await writeFile(join(repo.cwd, ".git", "MERGE_HEAD"), `${repo.git("rev-parse", "HEAD")}\n`);
    expect(await mergeBranchIntoCheckout({ cwd: repo.cwd, branch: "tau/rex/wait" })).toMatchObject({ state: "blocked" });
  });
});
