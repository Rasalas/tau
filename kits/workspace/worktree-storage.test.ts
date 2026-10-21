import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktree } from "./workspace-worktrees.js";
import { WorktreeStorage, storageGit, type WorktreeStorageOptions, type WorktreeStorageThread } from "./worktree-storage.js";
import { DAY_MS } from "./worktree-cleanup.js";
import { resolveWorktreeParent } from "./agent-worktrees.js";

const made: string[] = [];
afterEach(async () => { await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });

/** A repository whose worktrees go to a folder of this test's own. */
async function fixture(request?: WorktreeStorageOptions["request"], overrides: Partial<WorktreeStorageOptions> = {}) {
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
    ...(request ? { request } : {}),
    ...overrides,
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
  it("keeps recorded custom worktrees manageable after the setting changes and a restart", async () => {
    const { repo, storage, tauWorktree, reopen } = await fixture();
    const clean = await tauWorktree("old-custom");
    const dirty = await tauWorktree("old-custom-dirty");
    await writeFile(join(dirty, "draft.txt"), "keep\n");
    await writeFile(join(repo, ".tau", "project.json"), "{}\n");
    const restarted = reopen();
    await restarted.setPolicy({ rules: { unchanged: true } });
    expect((await restarted.report({ sizes: false })).worktrees.find((tree) => tree.path === clean)?.verdict.remove).toBe(true);
    expect((await restarted.sweep()).removed).toEqual([clean]);
    expect(existsSync(dirty)).toBe(true);
    expect((await storage.list()).find((entry) => entry.path === clean)?.worktreeParent).toBe(join(repo, "..", "worktrees", "repo"));
  });

  it("records the parent actually used by creation when its cached location is no longer configured", async () => {
    const { repo, root, storage, reopen } = await fixture();
    const original = join(root, "worktrees", "repo");
    await writeFile(join(repo, ".tau", "project.json"), "{}\n");
    const path = await createWorktree(repo, "cached-location", {}, async () => ({
      root: repo, isRepo: true, isDirty: false, worktrees: [], refs: [], worktreeParent: original,
    }));
    await storage.remember(path, repo, "cached-location", { worktreeParent: dirname(path) });
    const restarted = reopen();
    await restarted.setPolicy({ rules: { unchanged: true } });
    expect((await restarted.list())[0]?.worktreeParent).toBe(original);
    expect((await restarted.sweep()).removed).toEqual([path]);
  });

  it("refuses to restore through a recorded parent that now points at another folder", async () => {
    const { root, repo, storage, tauWorktree } = await fixture();
    const path = await tauWorktree("restore-parent");
    const parent = dirname(path);
    const unrelated = join(root, "unrelated");
    git(repo, "worktree", "remove", path);
    await rm(parent, { recursive: true });
    await mkdir(unrelated);
    await symlink(unrelated, parent, "junction");
    await expect(storage.restoreMissing(path)).rejects.toThrow(/storage folder has changed/u);
    expect(existsSync(join(unrelated, "restore-parent"))).toBe(false);
    expect(existsSync(join(unrelated, ".nomedia"))).toBe(false);
  });

  it("recognizes old beside records without moving them, and restores their original path", async () => {
    const { root, repo, storage, reopen } = await fixture();
    const parent = resolveWorktreeParent(repo, "beside");
    const legacy = join(parent, "old");
    git(repo, "worktree", "add", "-q", "-b", "old", legacy);
    // Version 1 registries predate the parent field and the central default.
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(root, "state", "worktrees.json"), JSON.stringify({ version: 1, worktrees: [{ path: legacy, repository: repo, branch: "old", createdAt: 0 }] }));
    await writeFile(join(repo, ".tau", "project.json"), "{}\n");
    await storage.setPolicy({ rules: { unchanged: true } });
    expect((await storage.report({ sizes: false })).worktrees[0]?.verdict.remove).toBe(true);
    expect((await storage.sweep()).removed).toEqual([legacy]);
    expect(await reopen().restoreMissing(legacy)).toMatchObject({ path: legacy, branch: "old" });
    expect(existsSync(legacy)).toBe(true);
  });

  it("does not follow a recorded parent after it is replaced by a link to another folder", async () => {
    const { root, repo, storage, tauWorktree } = await fixture();
    const path = await tauWorktree("linked-parent");
    const parent = join(path, "..");
    const outside = join(root, "outside");
    git(repo, "worktree", "move", path, outside);
    await rm(parent, { recursive: true });
    await symlink(root, parent, "junction");
    // A similarly named linked worktree reached through the replacement must stay outside.
    git(repo, "worktree", "move", outside, join(root, "linked-parent"));
    await storage.setPolicy({ rules: { unchanged: true } });
    expect((await storage.report({ sizes: false })).worktrees[0]?.verdict.blockers).toContain("outside-worktrees-dir");
    expect((await storage.sweep()).removed).toEqual([]);
    expect(existsSync(join(root, "linked-parent"))).toBe(true);
  });

  it("removes only old fully settled worktrees and restores their kept branches after restart", async () => {
    let now = Date.now();
    const started = now;
    const { repo, root, storage, threads, open, tauWorktree, reopen } = await fixture(undefined, { now: () => now, modifiedAt: async () => started });
    const clean = await tauWorktree("settled");
    const shared = await tauWorktree("shared");
    const dirty = await tauWorktree("dirty-settled");
    const ignored = await tauWorktree("ignored-settled");
    const unpushed = await tauWorktree("unpushed-settled");
    const live = await tauWorktree("live-settled");
    for (const [index, cwd] of [clean, shared, dirty, ignored, unpushed, live].entries()) threads.push({ sessionId: String(index), cwd, path: join(root, `session-${index}`), settledAt: started });
    threads.push({ sessionId: "active-shared", cwd: shared, path: join(root, "shared-active") });
    open.add("5");
    await writeFile(join(dirty, "draft.txt"), "keep\n");
    await writeFile(join(ignored, ".env"), "KEEP=1\n");
    await writeFile(join(unpushed, "commit.txt"), "keep\n");
    git(unpushed, "add", "commit.txt"); git(unpushed, "commit", "-qm", "exclusive work");
    await storage.setPolicy({ rules: { afterSettledDays: 7 } });
    now += 9 * DAY_MS;
    const report = await storage.report({ sizes: false });
    expect(report.worktrees.filter((tree) => tree.verdict.remove).map((tree) => tree.path)).toEqual([clean]);
    expect((await storage.sweep()).removed).toEqual([clean]);
    expect(threads).toHaveLength(7);
    expect(git(repo, "branch", "--list", "settled")).toContain("settled");
    expect(existsSync(clean)).toBe(false);
    for (const path of [shared, dirty, ignored, unpushed, live]) expect(existsSync(path)).toBe(true);
    const restarted = reopen();
    expect((await restarted.getPolicy()).host.afterSettledDays).toBe(7);
    expect(await restarted.restoreMissing(clean)).toMatchObject({ branch: "settled" });
    expect(existsSync(clean)).toBe(true);
    expect((await restarted.report({ sizes: false })).worktrees.find((tree) => tree.path === clean)?.verdict.remove).toBe(false);
  });

  it("uses the latest shared settlement, and keeps missing metadata, trash and empty worktrees", async () => {
    let now = Date.now();
    const started = now;
    const { storage, threads, tauWorktree } = await fixture(undefined, { now: () => now, modifiedAt: async () => started });
    const path = await tauWorktree("shared-retention");
    const first = { sessionId: "one", cwd: path, path: "/session-one", settledAt: started };
    const second: WorktreeStorageThread = { sessionId: "two", cwd: path, path: "/session-two", settledAt: started + 3 * DAY_MS };
    threads.push(first, second);
    await storage.setPolicy({ rules: { afterSettledDays: 7 } });
    now += 9 * DAY_MS;
    const due = async () => (await storage.report({ sizes: false })).worktrees[0]!.verdict.remove;
    expect(await due()).toBe(false);
    now += DAY_MS;
    expect(await due()).toBe(true);
    for (const at of [undefined, NaN, Infinity, -1]) {
      second.settledAt = at;
      expect(await due()).toBe(false);
    }
    second.path = ""; second.settledAt = undefined;
    expect(await due()).toBe(false);
    threads.splice(0);
    expect(await due()).toBe(false);
  });

  it.each(["reactivated", "activity", "shared"])("keeps a worktree after %s changes during the final Git inspection", async (change) => {
    let now = Date.now();
    const started = now;
    let inspections = 0;
    let shared = false;
    const thread: WorktreeStorageThread = { sessionId: "reactivated", cwd: "", path: "/session", settledAt: started };
    const { storage, tauWorktree } = await fixture(undefined, {
      now: () => now, modifiedAt: async () => started,
      sessions: async () => [{ ...thread }, ...(shared ? [{ sessionId: "new", cwd: thread.cwd, path: "/new" }] : [])],
      runGit: async (cwd, args, maxBuffer) => {
        const result = await storageGit(cwd, args, maxBuffer);
        if (args[0] === "log" && ++inspections === 2) {
          if (change === "reactivated") thread.settledAt = undefined;
          else if (change === "activity") thread.modifiedAt = now;
          else shared = true;
        }
        return result;
      },
    });
    const path = await tauWorktree("reactivated"); thread.cwd = path;
    await storage.setPolicy({ rules: { afterSettledDays: 7 } }); now += 9 * DAY_MS;
    expect((await storage.sweep()).removed).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

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

  it("refuses a concurrent picker restore that requested a different branch", async () => {
    const { repo, storage, tauWorktree } = await fixture();
    const path = await tauWorktree("first-choice");
    git(repo, "branch", "other-choice", "main");
    await rm(path, { recursive: true });
    const results = await Promise.allSettled([
      storage.restoreMissing(path, { branch: "first-choice" }),
      storage.restoreMissing(path, { branch: "other-choice" }),
    ]);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { branch: "first-choice" } });
    expect(results[1]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("another branch") }) });
    expect(git(path, "branch", "--show-current").trim()).toBe("first-choice");
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
    const { repo, storage, tauWorktree } = await fixture(async (path) => { asked.push(path); return { state: "merged", headSha: git(path, "rev-parse", "HEAD").trim(), baseRef: "main" }; });
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

  it("keeps a worktree whose merged request did not hold its commits, or was merged elsewhere", async () => {
    let answer: Awaited<ReturnType<NonNullable<WorktreeStorageOptions["request"]>>>;
    const { repo, storage, tauWorktree } = await fixture(async () => answer);
    const path = await tauWorktree("moved-on");
    await writeFile(join(path, "work.txt"), "work\n");
    git(path, "add", "work.txt");
    git(path, "commit", "-qm", "work");
    const head = git(path, "rev-parse", "HEAD").trim();
    git(repo, "branch", "pushed-copy", "moved-on");
    await storage.setPolicy({ rules: { onMerge: true } });
    const verdict = async () => (await storage.report({ sizes: false })).worktrees.find((tree) => tree.path === path)?.verdict;

    // Commits added after the squash are not in the merged request.
    answer = { state: "merged", headSha: "0".repeat(40), baseRef: "main" };
    expect(await verdict()).toEqual({ remove: false, reasons: [], blockers: ["request-differs"] });
    answer = { state: "merged", baseRef: "main" };
    expect(await verdict()).toEqual({ remove: false, reasons: [], blockers: ["request-differs"] });
    // Merged into another branch than the default one is not "merged into the default branch".
    answer = { state: "merged", headSha: head, baseRef: "release" };
    expect(await verdict()).toEqual({ remove: false, reasons: [], blockers: ["request-differs"] });
    answer = { state: "open", headSha: "0".repeat(40), baseRef: "main" };
    expect(await verdict()).toEqual({ remove: false, reasons: [], blockers: [] });
    answer = { state: "merged", headSha: head, baseRef: "main" };
    expect(await verdict()).toEqual({ remove: true, reasons: ["merged"], blockers: [] });
    answer = { state: "merged", headSha: head };
    expect(await verdict()).toEqual({ remove: true, reasons: ["merged"], blockers: [] });
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

  describe("untracked worktrees", () => {
    const later = () => Date.now() + 2 * 60 * 60_000;

    it("lists old beside orphans and previously recorded custom parents after switching to the default", async () => {
      const { repo, storage, tauWorktree } = await fixture(undefined, { now: later });
      await tauWorktree("known-custom-parent");
      const custom = await createWorktree(repo, "custom-orphan");
      const legacy = join(resolveWorktreeParent(repo, "beside"), "beside-orphan");
      git(repo, "worktree", "add", "-q", "-b", "beside-orphan", legacy);
      await writeFile(join(repo, ".tau", "project.json"), "{}\n");
      expect((await storage.report({ sizes: false })).untracked?.map((tree) => tree.path).sort()).toEqual([custom, legacy].sort());
      expect(await storage.removeByHand(custom, false)).toEqual({ removed: true });
      expect(await storage.removeByHand(legacy, false)).toEqual({ removed: true });
    });

    it("lists a linked worktree no record, thread or workspace names, and removes it by hand keeping the branch", async () => {
      const { repo, root, storage, threads, tauWorktree, removed } = await fixture(undefined, { now: later });
      const recorded = await tauWorktree("recorded");
      const used = await createWorktree(repo, "used");
      const orphan = await createWorktree(repo, "orphan");
      threads.push({ sessionId: "t", cwd: used, path: join(root, "session") });
      await mkdir(join(root, "worktrees", "plain-folder"));

      const report = await storage.report({ sizes: true });
      expect(report.untracked).toEqual([expect.objectContaining({ path: orphan, branch: "orphan", repository: repo, sizeBytes: 1024, dirtyFiles: 0 })]);
      expect(report.untracked).toHaveLength(1);
      expect(report.worktrees.map((tree) => tree.path)).toEqual([recorded]);
      expect(report.totalBytes).toBe(2 * 1024);

      expect(await storage.removeByHand(orphan, false)).toEqual({ removed: true });
      expect(existsSync(orphan)).toBe(false);
      expect(git(repo, "branch", "--list", "orphan")).toContain("orphan");
      expect(removed).toEqual([repo]);
      expect((await storage.report({ sizes: false })).untracked).toEqual([]);
    });

    it("waits out a grace period, names uncommitted files first, and refuses what it did not list", async () => {
      const { repo, root, storage } = await fixture();
      const recent = await createWorktree(repo, "recent");
      expect((await storage.report({ sizes: false })).untracked).toEqual([]);
      await expect(storage.removeByHand(recent, true)).rejects.toThrow("Tau did not make this worktree");
      await expect(storage.removeByHand(join(root, "elsewhere"), true)).rejects.toThrow("Tau did not make this worktree");

      const late = new WorktreeStorage({ stateDir: join(root, "state"), runGit: storageGit, sessions: async () => [], threadOpen: () => false, hostCwd: () => repo, log: () => undefined, removed: () => undefined, now: later });
      await writeFile(join(recent, "draft.txt"), "keep\n");
      expect((await late.report({ sizes: false })).untracked).toEqual([expect.objectContaining({ path: recent, dirtyFiles: 1 })]);
      expect(await late.removeByHand(recent, false)).toMatchObject({ removed: false, confirm: ["uncommitted"], dirtyFiles: 1 });
      expect(existsSync(recent)).toBe(true);
      expect(await late.removeByHand(recent, true)).toEqual({ removed: true });
      expect(existsSync(recent)).toBe(false);
    });

    it("never lists a worktree the host has open, and a sweep leaves an unrecorded one alone", async () => {
      const { repo, storage } = await fixture(undefined, { now: later });
      const orphan = await createWorktree(repo, "open-here");
      const open = new WorktreeStorage({ stateDir: join(repo, "..", "state"), runGit: storageGit, sessions: async () => [], threadOpen: () => false, hostCwd: () => orphan, log: () => undefined, removed: () => undefined, now: later });
      expect((await open.report({ sizes: false })).untracked).toEqual([]);
      await storage.setPolicy({ rules: { afterDays: 1, unchanged: true } });
      expect((await storage.sweep()).removed).toEqual([]);
      expect(existsSync(orphan)).toBe(true);
    });
  });
});
