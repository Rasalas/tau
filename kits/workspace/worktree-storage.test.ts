import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktree } from "./workspace-git.js";
import { WorktreeStorage, storageGit, type WorktreeStorageOptions, type WorktreeStorageThread } from "./worktree-storage.js";

const made: string[] = [];
afterEach(async () => { await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });

/** A repository whose worktrees go to a folder of this test's own. */
async function fixture(requestState?: (path: string) => Promise<"open" | "closed" | "merged" | undefined>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-storage-")));
  made.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".tau"), { recursive: true });
  await writeFile(join(repo, ".tau", "project.json"), JSON.stringify({ worktreeDirectory: join(root, "worktrees") }));
  await writeFile(join(repo, ".gitignore"), "node_modules/\n.env\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "tau@example.com");
  git(repo, "config", "user.name", "Tau");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "initial commit");
  const threads: WorktreeStorageThread[] = [];
  const open = new Set<string>();
  const removed: string[] = [];
  const storageOptions: WorktreeStorageOptions = {
    stateDir: join(root, "state"),
    runGit: storageGit,
    sessions: async () => threads,
    threadOpen: (id) => open.has(id),
    hostCwd: () => repo,
    log: () => undefined,
    removed: (repository) => { removed.push(repository); },
    measure: async () => 1024,
    ...(requestState ? { requestState } : {}),
  };
  const storage = new WorktreeStorage(storageOptions);
  /** A worktree the way Workspace Kit makes one, recorded like `create-worktree` does. */
  const tauWorktree = async (branch: string) => {
    const path = await createWorktree(repo, branch);
    await storage.remember(path, repo, branch);
    return path;
  };
  return { root, repo, storage, threads, open, removed, tauWorktree, reopen: () => new WorktreeStorage(storageOptions) };
}

const listed = (repo: string) => git(repo, "worktree", "list", "--porcelain");

describe("worktree storage", () => {
  it("restores a missing worktree from its recorded branch after restart, once for concurrent turns", async () => {
    const { repo, tauWorktree, reopen } = await fixture();
    const path = await tauWorktree("saved-thread");
    await writeFile(join(path, "work.txt"), "thread work\n");
    git(path, "add", "work.txt");
    git(path, "commit", "-qm", "thread work");
    const tip = git(path, "rev-parse", "HEAD").trim();
    await rm(path, { recursive: true });
    const restarted = reopen();
    const results = await Promise.all([restarted.restoreMissing(path), restarted.restoreMissing(path)]);
    expect(results).toEqual([expect.objectContaining({ path, repository: repo, branch: "saved-thread" }), expect.objectContaining({ path })]);
    expect(git(path, "rev-parse", "HEAD").trim()).toBe(tip);
    expect(await readFile(join(path, "work.txt"), "utf8")).toBe("thread work\n");
    expect(git(repo, "branch", "--show-current").trim()).toBe("main");
    await writeFile(join(path, "draft.txt"), "keep my uncommitted work\n");
    expect(await restarted.restoreMissing(path)).toBeUndefined();
    expect(await readFile(join(path, "draft.txt"), "utf8")).toBe("keep my uncommitted work\n");
  });

  it("refuses to guess a deleted branch and can retry once that branch is restored", async () => {
    const { repo, storage, tauWorktree } = await fixture();
    const path = await tauWorktree("deleted-branch");
    git(repo, "worktree", "remove", path);
    git(repo, "branch", "-D", "deleted-branch");
    await expect(storage.restoreMissing(path)).rejects.toThrow(/restore.*deleted-branch/u);
    expect(existsSync(path)).toBe(false);
    git(repo, "branch", "deleted-branch", "main");
    expect(await storage.restoreMissing(path)).toMatchObject({ path, branch: "deleted-branch" });
  });

  it("restores a worktree removed by cleanup and clears its removal record", async () => {
    const { storage, tauWorktree } = await fixture();
    const path = await tauWorktree("cleaned-thread");
    await storage.setPolicy({ rules: { unchanged: true } });
    expect((await storage.sweep()).removed).toContain(path);
    expect((await storage.list())[0]?.removedAt).toBeTypeOf("number");
    expect(await storage.restoreMissing(path)).toMatchObject({ path });
    expect((await storage.list())[0]?.removedAt).toBeUndefined();
  });

  it("leaves a missing folder alone when it is not a recorded worktree", async () => {
    const { root, storage } = await fixture();
    const path = join(root, "unrecorded");
    expect(await storage.restoreMissing(path)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it("reports what the rules would remove and removes exactly that", async () => {
    const { repo, storage, tauWorktree } = await fixture();
    const idle = await tauWorktree("idle");
    const committed = await tauWorktree("committed");
    await writeFile(join(committed, "work.txt"), "work\n");
    git(committed, "add", "work.txt");
    git(committed, "commit", "-qm", "work");
    const dirty = await tauWorktree("dirty");
    await writeFile(join(dirty, "draft.txt"), "draft\n");
    const secrets = await tauWorktree("secrets");
    await writeFile(join(secrets, ".env"), "TOKEN=1\n");
    const installed = await tauWorktree("installed");
    await mkdir(join(installed, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(installed, "node_modules", "left-pad", "index.js"), "\n");

    await storage.setPolicy({ rules: { unchanged: true } });
    const report = await storage.report();
    const verdict = (path: string) => report.worktrees.find((tree) => tree.path === path)?.verdict;
    expect(verdict(idle)).toEqual({ remove: true, reasons: ["unchanged"], blockers: [] });
    expect(verdict(installed)).toEqual({ remove: true, reasons: ["unchanged"], blockers: [] });
    expect(verdict(committed)).toEqual({ remove: false, reasons: [], blockers: ["unpushed"] });
    expect(verdict(dirty)?.blockers).toEqual(["uncommitted"]);
    expect(verdict(secrets)?.blockers).toEqual(["ignored-files"]);
    expect(report.totalBytes).toBe(5 * 1024);

    const result = await storage.sweep();
    expect(result.removed.sort()).toEqual([idle, installed].sort());
    for (const path of [idle, installed]) expect(existsSync(path)).toBe(false);
    for (const path of [committed, dirty, secrets]) expect(existsSync(path)).toBe(true);
    // The branch outlives its checkout, so a thread can have it back.
    expect(git(repo, "branch", "--list", "idle").trim()).toContain("idle");
    expect(listed(repo)).not.toContain(idle);
    expect((await storage.report()).worktrees.map((tree) => tree.path)).not.toContain(idle);
  });

  it("takes a branch whose request was merged by squash, and asks the host only while the rule is on", async () => {
    const asked: string[] = [];
    const { repo, storage, tauWorktree } = await fixture(async (path) => { asked.push(path); return "merged"; });
    const squashed = await tauWorktree("squashed");
    await writeFile(join(squashed, "work.txt"), "work\n");
    git(squashed, "add", "work.txt");
    git(squashed, "commit", "-qm", "work");
    // The pushed branch still holds the commits; the default branch has only the squash.
    git(repo, "branch", "pushed-copy", "squashed");
    const verdict = async () => (await storage.report({ sizes: false })).worktrees.find((tree) => tree.path === squashed)?.verdict;
    expect(await verdict()).toEqual({ remove: false, reasons: [], blockers: [] });
    expect(asked).toEqual([]);
    await storage.setPolicy({ rules: { onMerge: true } });
    expect(await verdict()).toEqual({ remove: true, reasons: ["merged"], blockers: [] });
    expect(asked).toEqual([squashed]);
  });

  it("leaves worktrees Tau did not record or that lie outside the worktrees folder", async () => {
    const { root, repo, storage } = await fixture();
    const foreign = join(root, "worktrees", "repo", "foreign");
    git(repo, "worktree", "add", "-q", "-b", "foreign", foreign);
    const outside = join(root, "elsewhere");
    git(repo, "worktree", "add", "-q", "-b", "elsewhere", outside);
    await storage.remember(outside, repo, "elsewhere");
    await storage.setPolicy({ rules: { unchanged: true, afterDays: 1 } });

    const report = await storage.report();
    expect(report.worktrees.map((tree) => tree.path)).toEqual([outside]);
    expect(report.worktrees[0]?.verdict.blockers).toEqual(["outside-worktrees-dir"]);
    expect((await storage.sweep()).removed).toEqual([]);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(outside)).toBe(true);
    await expect(storage.removeByHand(foreign, true)).rejects.toThrow(/did not make/u);
    await expect(storage.removeByHand(outside, true)).rejects.toThrow(/outside/u);
  });

  it("keeps a worktree while a thread there is open, and takes a deleted thread's once no thread is left", async () => {
    const { storage, threads, open, tauWorktree } = await fixture();
    const path = await tauWorktree("deleted");
    threads.push({ sessionId: "t1", path: join(path, "session.jsonl"), cwd: path });
    open.add("t1");
    await storage.setPolicy({ rules: { onThreadDelete: true, unchanged: true } });
    expect((await storage.report()).worktrees[0]?.verdict.blockers).toEqual(["thread-open"]);

    open.delete("t1");
    // The index still lists the thread while its deletion hook runs.
    expect(await storage.threadDeleted("t1", path)).toBe(true);
    const result = await storage.sweep();
    expect(result.removed).toEqual([path]);
  });

  it("asks before removing uncommitted work by hand", async () => {
    const { storage, removed, repo, tauWorktree } = await fixture();
    const path = await tauWorktree("by-hand");
    await writeFile(join(path, "draft.txt"), "draft\n");
    expect(await storage.removeByHand(path, false)).toEqual({ removed: false, confirm: ["uncommitted"], dirtyFiles: 1, unpushedCommits: 0 });
    expect(existsSync(path)).toBe(true);
    expect(await storage.removeByHand(path, true)).toEqual({ removed: true });
    expect(existsSync(path)).toBe(false);
    expect(removed).toEqual([repo]);
  });

  it("keeps its record and policy across a restart", async () => {
    const { root, repo, storage, tauWorktree } = await fixture();
    const path = await tauWorktree("persisted");
    await storage.setPolicy({ project: repo, mode: "custom", rules: { afterDays: 3 } });
    const again = new WorktreeStorage({
      stateDir: join(root, "state"),
      runGit: storageGit,
      sessions: async () => [],
      threadOpen: () => false,
      hostCwd: () => repo,
      log: () => undefined,
      removed: () => undefined,
    });
    expect((await again.list()).map((entry) => [entry.path, entry.repository, entry.branch])).toEqual([[path, repo, "persisted"]]);
    expect((await again.getPolicy()).projects[repo]).toEqual({ mode: "custom", rules: { afterDays: 3 } });
  });
});
