import { publishedHead } from "./published-head.js";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { mergeThreadBranch, readThreadBranch, readThreadBranches, readThreadConflicts, removeThreadBranch, threadWorkIntegrated } from "./thread-branches.js";
import { applyPicks, parseConflictText } from "./merge-picks.js";

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
  it("completes reviews published on origin while the local target stays behind", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/published");
    const localHead = repo.run(repo.cwd, "rev-parse", "main");
    await repo.commit(dir, "b.txt", "published work\n");
    repo.run(repo.cwd, "update-ref", "refs/remotes/origin/main", "tau/published");

    expect((await readThreadBranches([dir]))[0]).toMatchObject({ target: "main", merged: true, uncommitted: 0, conflicts: [] });
    // Local merge operations still compare against the checkout they would change.
    expect(await readThreadBranch(dir)).toMatchObject({ merged: false });
    expect(repo.run(repo.cwd, "rev-parse", "main")).toBe(localHead);

    await writeFile(join(dir, "follow-up.txt"), "new work\n");
    expect((await readThreadBranches([dir]))[0]).toMatchObject({ merged: true, uncommitted: 1 });
    repo.run(dir, "add", "-A");
    repo.run(dir, "commit", "-qm", "follow-up");
    expect((await readThreadBranches([dir]))[0]).toMatchObject({ merged: false, uncommitted: 0 });
  });

  it("recognizes a historical squash on origin without advancing the local target", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/squashed-remotely");
    const published = repo.worktree("published");
    await repo.commit(dir, "a.txt", "changed\n");
    await repo.commit(dir, "b.txt", "finished\n");
    repo.run(published, "merge", "--squash", "tau/squashed-remotely");
    repo.run(published, "commit", "-qm", "squashed work");
    await repo.commit(published, "a.txt", "later target edit\n");
    repo.run(repo.cwd, "update-ref", "refs/remotes/origin/main", "published");

    expect((await readThreadBranches([dir]))[0]).toMatchObject({ merged: true, mergedBy: "squash", conflicts: [] });
    // Evidence on main must not complete a review targeting another branch.
    repo.run(repo.cwd, "branch", "release", "main");
    expect((await readThreadBranches([dir], undefined, undefined, new Map([[dir, "release"]])))[0])
      .toMatchObject({ target: "release", merged: false });
  });

  it("retains local completion when origin has not received the merge", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/local-merge");
    repo.run(repo.cwd, "update-ref", "refs/remotes/origin/main", "main");
    await repo.commit(dir, "b.txt", "local work\n");
    repo.run(repo.cwd, "merge", "--ff-only", "tau/local-merge");
    expect((await readThreadBranches([dir]))[0]).toMatchObject({ merged: true });
    expect(await threadWorkIntegrated(dir)).toBe(false);
  });

  it("allows auto-settling only when origin holds the work and the checkout stays clean", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/continued");
    repo.run(repo.cwd, "update-ref", "refs/remotes/origin/main", "main");
    await repo.commit(dir, "b.txt", "first change\n");
    repo.run(repo.cwd, "merge", "--squash", "tau/continued");
    repo.run(repo.cwd, "commit", "-qm", "squashed PR");
    // A local merge is not a published merge.
    expect(await threadWorkIntegrated(dir)).toBe(false);
    repo.run(repo.cwd, "update-ref", "refs/remotes/origin/main", "main");
    expect(await threadWorkIntegrated(dir)).toBe(true);
    await writeFile(join(dir, "untracked.txt"), "follow-up\n");
    expect(await threadWorkIntegrated(dir)).toBe(false);
    repo.run(dir, "add", "-A");
    expect(await threadWorkIntegrated(dir)).toBe(false);
    repo.run(dir, "commit", "-qm", "new follow-up");
    expect(await threadWorkIntegrated(dir)).toBe(false);
    repo.run(repo.cwd, "merge", "--squash", "tau/continued");
    repo.run(repo.cwd, "commit", "-qm", "follow-up PR");
    repo.run(repo.cwd, "update-ref", "refs/remotes/origin/main", "main");
    expect(await threadWorkIntegrated(dir)).toBe(true);
  });

  it("accepts work merged into a request's base other than the saved review target", async () => {
    const repo = await repository();
    repo.run(repo.cwd, "branch", "feature-base");
    repo.run(repo.cwd, "update-ref", "refs/remotes/origin/feature-base", "feature-base");
    const dir = repo.worktree("tau/rebased");
    repo.run(dir, "config", "branch.tau/rebased.tau-review-target", "feature-base");
    await repo.commit(dir, "b.txt", "fix\n");
    repo.run(repo.cwd, "merge", "--squash", "tau/rebased");
    repo.run(repo.cwd, "commit", "-qm", "squashed PR");
    repo.run(repo.cwd, "update-ref", "refs/remotes/origin/main", "main");
    expect(await threadWorkIntegrated(dir)).toBe(false);
    expect(await threadWorkIntegrated(dir, undefined, ["main"])).toBe(true);
    expect(await threadWorkIntegrated(dir, undefined, ["feature-base"])).toBe(false);
  });

  it("checks new work in a shared checkout against origin too", async () => {
    const repo = await repository();
    repo.run(repo.cwd, "update-ref", "refs/remotes/origin/main", "main");
    expect(await threadWorkIntegrated(repo.cwd)).toBe(true);
    await writeFile(join(repo.cwd, "a.txt"), "dirty\n");
    expect(await threadWorkIntegrated(repo.cwd)).toBe(false);
    repo.run(repo.cwd, "checkout", "--", "a.txt");
    repo.run(repo.cwd, "checkout", "-qb", "feature");
    await repo.commit(repo.cwd, "b.txt", "new work\n");
    expect(await threadWorkIntegrated(repo.cwd)).toBe(false);
    repo.run(repo.cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(await threadWorkIntegrated(repo.cwd)).toBe(true);
  });

  it("keeps a thread active when the published target cannot be verified", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/unverified");
    await repo.commit(dir, "b.txt", "change\n");
    repo.run(repo.cwd, "merge", "--no-ff", "-q", "-m", "local only", "tau/unverified");
    expect(await threadWorkIntegrated(dir)).toBe(false);
    expect(await threadWorkIntegrated(repo.cwd)).toBe(false);
  });

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

  it("counts new files and uncommitted edits in the files it carries, beside the committed ones", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/pending");
    const fresh = async () => {
      await mkdir(join(dir, "fresh"));
      await writeFile(join(dir, "fresh", "one.txt"), "x\ny\n");
      await writeFile(join(dir, "fresh", "two.txt"), "z\n");
    };
    await fresh();
    // Only new files: a branch with no commit still carries them.
    expect(await readThreadBranch(dir)).toMatchObject({ ahead: 0, files: 2, added: 3, removed: 0, uncommitted: 2 });

    await rm(join(dir, "fresh"), { recursive: true });
    await repo.commit(dir, "b.txt", "bee\nbee\n");
    await fresh();
    await writeFile(join(dir, "a.txt"), "one\nTWO\nthree\n");
    const branch = await readThreadBranch(dir);
    expect(branch).toMatchObject({ ahead: 1, files: 4, added: 6, removed: 1, uncommitted: 3 });
    expect(branch?.paths.map(({ path, uncommitted }) => [path, uncommitted ?? false]).sort())
      .toEqual([["a.txt", true], ["b.txt", false], ["fresh/one.txt", true], ["fresh/two.txt", true]]);
  });

  it("reads the intended target while the main checkout is detached, and blocks integration", async () => {
    const repo = await repository();
    const dir = repo.worktree("tau/x");
    repo.run(repo.cwd, "checkout", "-q", "--detach");
    expect(await readThreadBranch(dir)).toMatchObject({ target: "main", mergeBlocked: expect.stringContaining("a detached HEAD") });
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
    repo.run(repo.cwd, "config", "branch.tau/aside.tau-review-target", "feat/elsewhere");
    expect(await readThreadBranch(dir)).toMatchObject({ target: "feat/elsewhere", defaultBranch: "main" });
  });

  it("keeps a squash merge completed after later edits and a switch to an old feature branch", async () => {
    const repo = await repository();
    repo.run(repo.cwd, "branch", "fix/privacy");
    const dir = repo.worktree("fix/tablet");
    await repo.commit(dir, "a.txt", "one\nTWO\nthree\n");
    await repo.commit(dir, "b.txt", "tablet\n");
    repo.run(repo.cwd, "merge", "--squash", "fix/tablet");
    repo.run(repo.cwd, "commit", "-qm", "squashed tablet work");
    await repo.commit(repo.cwd, "a.txt", "one\ntwo, revised again\nthree\n");
    repo.run(repo.cwd, "switch", "-q", "fix/privacy");
    const head = repo.run(repo.cwd, "rev-parse", "HEAD");

    expect(await readThreadBranch(dir)).toMatchObject({ target: "main", files: 2, merged: true, mergedBy: "squash", conflicts: [] });
    expect(await mergeThreadBranch(dir)).toMatchObject({ state: "already-merged", into: "main" });
    expect(repo.run(repo.cwd, "rev-parse", "HEAD")).toBe(head);

    await repo.commit(dir, "c.txt", "new work after the merge\n");
    expect(await readThreadBranch(dir)).toMatchObject({ target: "main", merged: false });
    await expect(mergeThreadBranch(dir)).rejects.toThrow(/Check out main/u);
    await expect(removeThreadBranch(dir)).rejects.toThrow(/does not hold/u);
    expect(repo.run(repo.cwd, "rev-parse", "HEAD")).toBe(head);
  });

  it("recognizes a squash after the branch incorporated newer target commits", async () => {
    const repo = await repository();
    const dir = repo.worktree("fix/rebased");
    await repo.commit(dir, "a.txt", "one\nTWO\nthree\n");
    await repo.commit(repo.cwd, "unrelated.txt", "target moved\n");
    repo.run(dir, "rebase", "main");
    await repo.commit(dir, "b.txt", "finished\n");
    repo.run(repo.cwd, "merge", "--squash", "fix/rebased");
    repo.run(repo.cwd, "commit", "-qm", "squashed work");
    await repo.commit(repo.cwd, "a.txt", "one\nrevised\nthree\n");

    expect(await readThreadBranch(dir)).toMatchObject({ merged: true, mergedBy: "squash", conflicts: [] });
    await repo.commit(dir, "new.txt", "not integrated\n");
    expect(await readThreadBranch(dir)).toMatchObject({ merged: false });
  });

  it("recognizes a precursor incorporated into a squashed integration branch", async () => {
    const repo = await repository();
    const precursor = repo.worktree("fix/precursor");
    await repo.commit(precursor, "a.txt", "one\nTWO\nthree\n");
    const submitted = repo.worktree("fix/submitted");
    repo.run(submitted, "cherry-pick", "-x", repo.run(precursor, "rev-parse", "HEAD"));
    await repo.commit(submitted, "a.txt", "one\nfinal revision\nthree\n");
    await repo.commit(submitted, "b.txt", "additional work\n");
    repo.run(repo.cwd, "merge", "--squash", "fix/submitted");
    repo.run(repo.cwd, "commit", "-qm", "squashed integration");
    await repo.commit(repo.cwd, "a.txt", "one\nlater edit\nthree\n");

    const branches = await readThreadBranches([precursor, submitted]);
    expect(branches.map(({ merged, conflicts }) => ({ merged, conflicts }))).toEqual([
      { merged: true, conflicts: [] }, { merged: true, conflicts: [] },
    ]);
    repo.run(repo.cwd, "branch", "release");
    expect((await readThreadBranches([precursor, submitted], undefined, undefined, new Map([[submitted, "release"]])))[0])
      .toMatchObject({ merged: false });
    await repo.commit(precursor, "new.txt", "not integrated\n");
    expect((await readThreadBranches([precursor, submitted]))[0]).toMatchObject({ merged: false });
  });

  it("previews conflicts against the fixed target and refuses picks on another checkout", async () => {
    const repo = await repository();
    const dir = repo.worktree("fix/tablet");
    await repo.commit(dir, "a.txt", "one\nTWO\nthree\n");
    await repo.commit(repo.cwd, "a.txt", "one\nzwei\nthree\n");
    repo.run(repo.cwd, "switch", "-q", "-c", "fix/privacy", "main~1");
    const head = repo.run(repo.cwd, "rev-parse", "HEAD");
    const read = await readThreadConflicts(dir);
    expect(read.files[0]?.hunks[0]).toMatchObject({ main: ["zwei"], thread: ["TWO"] });
    await expect(mergeThreadBranch(dir, { picks: { "a.txt": ["thread"] } })).rejects.toThrow(/Check out main/u);
    expect(repo.run(repo.cwd, "rev-parse", "HEAD")).toBe(head);
  });

  it("only accepts external integration evidence for the exact tip being removed", async () => {
    const repo = await repository();
    const dir = repo.worktree("fix/tablet");
    await repo.commit(dir, "a.txt", "one\nTWO\nthree\n");
    const completed = repo.run(dir, "rev-parse", "HEAD");
    await repo.commit(dir, "c.txt", "new work\n");
    await expect(removeThreadBranch(dir, { integratedTip: completed })).rejects.toThrow(/does not hold/u);
    await expect(removeThreadBranch(dir, { expectedTip: completed })).rejects.toThrow(/moved since/u);
    expect(existsSync(dir)).toBe(true);
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

const MIDDLE = ["2", "3", "4", "5", "6", "7", "8", "9"];

describe("picking a side per conflicting hunk", () => {
  async function conflicted() {
    const repo = await repository();
    const file = (first: string, last: string) => [first, ...MIDDLE, last, ""].join("\n");
    await repo.commit(repo.cwd, "a.txt", file("one", "ten"));
    const dir = repo.worktree("tau/picks");
    await repo.commit(dir, "a.txt", file("ONE", "TEN"));
    await repo.commit(repo.cwd, "a.txt", file("uno", "diez"));
    await repo.commit(repo.cwd, "b.txt", "bee\n");
    return { repo, dir };
  }

  it("reads each hunk with both sides and their line numbers, touching nothing", async () => {
    const { repo, dir } = await conflicted();
    const head = repo.run(repo.cwd, "rev-parse", "HEAD");
    const read = await readThreadConflicts(dir);
    expect(read.tip).toBe(repo.run(dir, "rev-parse", "HEAD"));
    expect(read.files).toEqual([{ path: "a.txt", hunks: [
      { main: ["uno"], thread: ["ONE"], mainLine: 1, threadLine: 1, after: "2" },
      { main: ["diez"], thread: ["TEN"], mainLine: 10, threadLine: 10, before: "9", after: "" },
    ] }]);
    expect(repo.run(repo.cwd, "rev-parse", "HEAD")).toBe(head);
    expect(repo.run(repo.cwd, "status", "--porcelain")).toBe("");
  });

  it("merges with the picks as a merge commit of both sides", async () => {
    const { repo, dir } = await conflicted();
    const tip = repo.run(dir, "rev-parse", "HEAD");
    const outcome = await mergeThreadBranch(dir, { expectedTip: tip, picks: { "a.txt": ["thread", { text: "10" }] } });
    expect(outcome).toMatchObject({ state: "merged", into: "main" });
    expect(await readFile(join(repo.cwd, "a.txt"), "utf8")).toBe(["ONE", ...MIDDLE, "10", ""].join("\n"));
    expect(await readFile(join(repo.cwd, "b.txt"), "utf8")).toBe("bee\n");
    expect(repo.run(repo.cwd, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1)).toContain(tip);
    expect(repo.run(repo.cwd, "status", "--porcelain")).toBe("");
    expect(await readThreadBranch(dir)).toMatchObject({ merged: true });
  });

  it("refuses picks that miss a hunk and leaves the checkout as it was", async () => {
    const { repo, dir } = await conflicted();
    const head = repo.run(repo.cwd, "rev-parse", "HEAD");
    await expect(mergeThreadBranch(dir, { picks: { "a.txt": ["both"] } })).rejects.toThrow(/do not match/u);
    await expect(mergeThreadBranch(dir, { picks: {} })).rejects.toThrow(/a.txt has no picks/u);
    expect(repo.run(repo.cwd, "rev-parse", "HEAD")).toBe(head);
    expect(repo.run(repo.cwd, "status", "--porcelain")).toBe("");
  });

  it("keeps both sides, the thread's first, and reads a diff3 base section past", () => {
    const parts = parseConflictText("a\n<<<<<<< ours\nmain\n||||||| base\nold\n=======\nthread\n>>>>>>> theirs\nz");
    expect(parts && applyPicks(parts, ["both"])).toBe("a\nthread\nmain\nz");
    expect(parseConflictText("no markers\n")).toBeUndefined();
    expect(parseConflictText("<<<<<<< ours\nopen")).toBeUndefined();
  });
});


it("proves a direct push against the actual remote and hides dirty or unpublished work", async () => {
  const repo = await repository();
  const origin = join(repo.root, "origin.git");
  repo.run(repo.root, "init", "--bare", "-q", origin);
  repo.run(repo.cwd, "remote", "add", "origin", origin);
  repo.run(repo.cwd, "push", "origin", "main");
  const original = repo.run(repo.cwd, "rev-parse", "HEAD");
  const dir = repo.worktree("feature/publication");
  await repo.commit(dir, "b.txt", "published work");
  expect(await publishedHead(dir)).toBeUndefined();
  repo.run(dir, "push", "origin", "HEAD:main");
  expect(await publishedHead(dir)).toEqual({ commit: repo.run(dir, "rev-parse", "HEAD"), target: "origin/main", remote: origin });
  await writeFile(join(dir, "dirty.txt"), "pending");
  expect(await publishedHead(dir)).toBeUndefined();
  await rm(join(dir, "dirty.txt"));
  // Simulate a remote rollback without updating this checkout's tracking ref.
  repo.run(origin, "update-ref", "refs/heads/main", original);
  expect(await publishedHead(dir)).toBeUndefined();
});
