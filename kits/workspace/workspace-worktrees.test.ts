import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorktree,
  isLinkedWorktree,
  isNestedProject,
  mainCheckoutOf,
  ensureWorktree,
  readWorktreeStatuses,
  removeWorktree,
  readBaseChoices,
  resolveWorktreeBase,
  repositoryDisplayName,
} from "./workspace-worktrees.js";
import { readProjectGitState } from "./workspace-git.js";
import { readDefaultBranch, resolveDefaultBaseRef } from "./git-refs.js";
import { runGitCommand } from "./git-command.js";

// The host's global and system Git config (LFS filters, credential helpers)
// would otherwise be read by every fixture process here.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

describe("worktree cleanup suggestions", () => {
  it("suggests only old, clean, pushed worktrees with no threads", async () => {
    const now = Date.UTC(2026, 8, 20);
    const old = now - 30 * 24 * 60 * 60 * 1_000;
    const recent = now - 2 * 24 * 60 * 60 * 1_000;
    const tree = (name: string, patch: Record<string, unknown> = {}) => ({
      path: `/repo-worktrees/${name}`,
      name,
      branch: `feat/${name}`,
      isMain: false,
      isCurrent: false,
      ...patch,
    });
    const worktrees = [
      tree("main", { path: "/repo", branch: "main", isMain: true, isCurrent: true }),
      tree("safe"), tree("dirty"), tree("ahead"), tree("no-upstream"), tree("recent"), tree("used"),
    ];
    const refs = worktrees.map((worktree) => ({
      name: worktree.branch,
      isCurrent: worktree.isCurrent,
      upstream: worktree.name === "no-upstream" ? undefined : `origin/${worktree.branch}`,
      ahead: worktree.name === "ahead" ? 1 : 0,
      behind: 0,
      lastCommitAt: worktree.name === "recent" ? recent : old,
    }));
    const statuses = await readWorktreeStatuses(
      worktrees,
      refs,
      ["/repo", "/repo-worktrees/used"],
      async (cwd, args) => args[0] === "status" && cwd.endsWith("/dirty") ? " M file.ts\0" : "",
      now,
    );

    expect(statuses.filter((status) => status.cleanupCandidate).map((status) => status.path))
      .toEqual(["/repo-worktrees/safe"]);
    expect(statuses.find((status) => status.path.endsWith("/dirty"))?.isDirty).toBe(true);
    expect(statuses.find((status) => status.path.endsWith("/used"))?.threadCount).toBe(1);
  });
});

describe("worktree classification", () => {
  it("separates a linked worktree from a main checkout and a plain folder", async () => {
    const gitDirs = async (_cwd: string, args: string[]) => {
      expect(args).toEqual(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
      return "/repos/tau/.git/worktrees/feat\n/repos/tau/.git\n";
    };
    await expect(isLinkedWorktree("/repos/tau-worktrees/feat", gitDirs)).resolves.toBe(true);

    await expect(isLinkedWorktree("/repos/tau", async () => "/repos/tau/.git\n/repos/tau/.git\n"))
      .resolves.toBe(false);

    // A folder that is not a repository has no answer at all; the caller, not
    // this helper, decides what to do with that.
    await expect(isLinkedWorktree("/tmp/plain", async () => { throw new Error("not a git repository"); }))
      .rejects.toThrow("not a git repository");
    await expect(isLinkedWorktree("/tmp/plain", async () => "\n")).rejects.toThrow("not a Git repository");
  });

  it("names the main checkout a linked worktree was made from, and nothing for any other folder", async () => {
    const run = async (_cwd: string, args: string[]) => args.includes("--git-dir")
      ? "/repos/tau/.git/worktrees/feat\n/repos/tau/.git\n"
      : "/repos/tau/.git\n";
    await expect(mainCheckoutOf("/repos/tau-worktrees/feat", run)).resolves.toBe("/repos/tau");
    await expect(mainCheckoutOf("/repos/tau", async () => "/repos/tau/.git\n/repos/tau/.git\n")).resolves.toBeUndefined();
    await expect(mainCheckoutOf("/tmp/plain", async () => { throw new Error("not a git repository"); })).resolves.toBeUndefined();
  });

  it("keeps vanished worktree paths out of the project picker", async () => {
    let gitCalled = false;
    await expect(isNestedProject(
      "/repos/tau-worktrees/deleted",
      async () => { gitCalled = true; return ""; },
      async () => false,
    )).resolves.toBe(true);
    expect(gitCalled).toBe(false);
  });
});

describe("default branch", () => {
  it("names origin/HEAD's branch, then init.defaultBranch, then main", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-default-branch-"));
    const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
    try {
      const origin = join(root, "origin");
      await mkdir(origin);
      run(origin, "init", "-q", "-b", "trunk");
      run(origin, "-c", "user.email=tau@example.test", "-c", "user.name=Tau", "commit", "-q", "--allow-empty", "-m", "first");
      run(root, "clone", "-q", origin, "clone");
      await expect(readDefaultBranch(join(root, "clone"))).resolves.toBe("trunk");

      const configured = join(root, "configured");
      await mkdir(configured);
      run(configured, "init", "-q", "-b", "work");
      run(configured, "config", "init.defaultBranch", "develop");
      await expect(readDefaultBranch(configured)).resolves.toBe("develop");

      const plain = join(root, "plain");
      await mkdir(plain);
      run(plain, "init", "-q", "-b", "master");
      await expect(readDefaultBranch(plain)).resolves.toBe("main");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("worktree base", () => {
  const runner = (answers: Record<string, string>, calls: string[][] = []) => async (_cwd: string, args: string[]) => {
    calls.push(args);
    const answer = answers[args.join(" ")];
    // `rev-parse --verify --quiet` exits non-zero for a ref that is not there.
    if (answer === undefined || (answer === "" && args[0] === "rev-parse")) throw new Error(`no answer for ${args.join(" ")}`);
    return answer;
  };

  it("reads the default branch from origin/HEAD and falls back down the list", async () => {
    await expect(resolveDefaultBaseRef("/repo", runner({
      "symbolic-ref --short refs/remotes/origin/HEAD": "origin/trunk\n",
    }))).resolves.toBe("origin/trunk");

    await expect(resolveDefaultBaseRef("/repo", runner({
      "symbolic-ref --short refs/remotes/origin/HEAD": "",
      "rev-parse --verify --quiet main": "abc\n",
    }))).resolves.toBe("main");

    // No remote and no conventional branch: this checkout's own branch answers.
    await expect(resolveDefaultBaseRef("/repo", async (_cwd, args) => {
      if (args[0] === "branch") return "work\n";
      throw new Error("no such ref");
    })).resolves.toBe("work");
  });

  it("starts from the fetched remote commit and falls back to the local base", async () => {
    const calls: string[][] = [];
    await expect(resolveWorktreeBase("/repo", { requested: "main" }, runner({
      "remote": "origin\n",
      "fetch --prune origin": "",
      "rev-parse --verify --quiet origin/main^{commit}": "1111111111111111111111111111111111111111\n",
    }, calls))).resolves.toEqual({
      ref: "origin/main",
      commit: "1111111111111111111111111111111111111111",
      fromOrigin: true,
    });
    expect(calls).toContainEqual(["fetch", "--prune", "origin"]);

    const local = await resolveWorktreeBase("/repo", { requested: "main" }, runner({
      "remote": "origin\n",
      "fetch --prune origin": "",
      "rev-parse --verify --quiet main^{commit}": "2222222222222222222222222222222222222222\n",
    }));
    expect(local).toMatchObject({ ref: "main", fromOrigin: false });
    expect(local.note).toContain("origin/main does not exist");

    // Switched off, nothing is fetched at all.
    const offline: string[][] = [];
    await expect(resolveWorktreeBase("/repo", { requested: "main", startFromOrigin: false }, runner({
      "remote": "origin\n",
      "rev-parse --verify --quiet main^{commit}": "3333333333333333333333333333333333333333\n",
    }, offline))).resolves.toMatchObject({ ref: "main", fromOrigin: false });
    expect(offline.some((args) => args[0] === "fetch")).toBe(false);
  });

  it("starts from the project's main line when no base is asked, whatever the checkout is on", async () => {
    await expect(resolveWorktreeBase("/repo", {}, runner({
      "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main\n",
      "remote": "origin\n",
      "fetch --prune origin": "",
      "rev-parse --verify --quiet origin/main^{commit}": "5555555555555555555555555555555555555555\n",
    }))).resolves.toMatchObject({ ref: "origin/main", fromOrigin: true });

    // Without origin and without a local main, the first base that exists answers.
    await expect(resolveWorktreeBase("/repo", { startFromOrigin: false }, async (_cwd, args) => {
      if (args[0] === "remote") return "";
      if (args[0] === "branch") return "work\n";
      if (args.join(" ") === "rev-parse --verify --quiet work^{commit}") return "6666666666666666666666666666666666666666\n";
      throw new Error("no such ref");
    })).resolves.toMatchObject({ ref: "work", fromOrigin: false });
  });

  it("lists origin's other branches for Based on (design 1k)", async () => {
    await expect(readBaseChoices("/repo", "origin/main", runner({
      "for-each-ref --sort=-committerdate --count=500 --format=%(refname:short) refs/remotes/origin": "origin/develop\norigin/main\norigin\norigin/feat/a\norigin/feat/b\norigin/feat/c\n",
    }))).resolves.toEqual({ others: ["origin/develop", "origin/feat/a", "origin/feat/b", "origin/feat/c"] });
    // No remote: nothing but the default.
    await expect(readBaseChoices("/repo", "main", runner({}))).resolves.toEqual({ others: [] });
  });

  it("keeps offering the local base when origin cannot be reached", async () => {
    const base = await resolveWorktreeBase("/repo", { requested: "main" }, async (_cwd, args) => {
      if (args[0] === "remote") return "origin\n";
      if (args[0] === "fetch") throw new Error("could not read from remote repository");
      if (args.join(" ") === "rev-parse --verify --quiet main^{commit}") return "4444444444444444444444444444444444444444\n";
      throw new Error(`no answer for ${args.join(" ")}`);
    });
    expect(base).toMatchObject({ ref: "main", fromOrigin: false });
    expect(base.note).toContain("origin is unreachable");
  });

  it("retries a ref conflict before falling back from origin to a local base", async () => {
    let fetches = 0;
    const base = await resolveWorktreeBase("/repo", { requested: "main" }, async (_cwd, args) => {
      if (args[0] === "remote") return "origin\n";
      if (args[0] === "fetch" && ++fetches === 1) throw new Error("error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def");
      if (args.join(" ") === "rev-parse --verify --quiet origin/main^{commit}") return "fresh\n";
      if (args.join(" ") === "rev-parse --verify --quiet main^{commit}") return "stale\n";
      return "";
    });
    expect(base).toEqual({ ref: "origin/main", commit: "fresh", fromOrigin: true });
    expect(fetches).toBe(2);
  });

  it.each([
    ["persistent ref lock", "error: cannot lock ref 'refs/remotes/origin/main': File exists", 2],
    ["network failure", "network unavailable", 1],
    ["permission failure", "fatal: could not read from remote repository", 1],
  ])("preserves the fetch error for a %s", async (_name, message, attempts) => {
    let fetches = 0;
    const error = new Error(message);
    await expect(resolveWorktreeBase("/repo", { requested: "origin/main" }, async (_cwd, args) => {
      if (args[0] === "remote") return "origin\n";
      if (args[0] === "fetch") { fetches++; throw error; }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    })).rejects.toBe(error);
    expect(fetches).toBe(attempts);
  });

  it("refuses a base that names no commit", async () => {
    await expect(resolveWorktreeBase("/repo", { requested: "nope", startFromOrigin: false }, runner({
      "remote": "",
    }))).rejects.toThrow(/The worktree base "nope" does not exist/u);
  });
});

describe("a worktree whose folder vanished", () => {
  it("is recreated on open, and an existing one is left alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-worktree-gone-"));
    const cwd = join(root, "project");
    try {
      execFileSync("git", ["init", "-q", "-b", "main", cwd]);
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "first"], { cwd });
      const linked = join(root, "worktrees", "feat");
      execFileSync("git", ["worktree", "add", "-q", "-b", "feat", linked, "HEAD"], { cwd });

      await expect(ensureWorktree(cwd, linked, "feat")).resolves.toBe(false);
      await rm(linked, { recursive: true, force: true });
      await expect(ensureWorktree(cwd, linked, "feat")).resolves.toBe(true);
      await expect(stat(join(linked, ".git")).then(() => true)).resolves.toBe(true);

      // Without a branch there is nothing to check out again, and guessing would be wrong.
      await rm(linked, { recursive: true, force: true });
      await expect(ensureWorktree(cwd, linked, undefined)).rejects.toThrow(/no branch names what it held/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("worktree removal", () => {
  it("keeps Git's removal refusal for a worktree whose path porcelain quotes", async () => {
    const path = '/trees/quoted\t"worktree"';
    const calls: string[][] = [];
    const refusal = new Error("contains modified or untracked files");
    await expect(removeWorktree("/repo", path, { branch: "feature" }, async (_cwd, args) => {
      calls.push(args);
      if (args[1] === "remove") throw refusal;
      if (args[1] === "list") return `worktree /repo\nbranch refs/heads/main\n\nworktree ${JSON.stringify(path)}\nbranch refs/heads/feature\n\n`;
      return "";
    })).rejects.toBe(refusal);
    expect(calls.some((args) => args[0] === "branch")).toBe(false);
  });

  it("passes destructive flags only when each is explicitly confirmed", async () => {
    const calls: string[][] = [];
    await removeWorktree("/repo", "/trees/feat", { branch: "feat", force: true, forceBranch: true }, async (_cwd, args) => {
      calls.push(args);
      return "";
    });
    expect(calls).toEqual([
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["worktree", "remove", "--force", "/trees/feat"],
      ["branch", "-D", "--", "feat"],
    ]);
  });

  it("removes the worktree and its branch, and prunes when the folder is already gone", async () => {
    const calls: string[][] = [];
    await removeWorktree("/repo", "/repo-worktrees/feat", { branch: "feat" }, async (_cwd, args) => {
      calls.push(args);
      return "";
    });
    expect(calls).toEqual([
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["worktree", "remove", "/repo-worktrees/feat"],
      ["branch", "-d", "--", "feat"],
    ]);

    const pruned: string[][] = [];
    await removeWorktree("/repo", "/repo-worktrees/gone", {}, async (_cwd, args) => {
      pruned.push(args);
      if (args[1] === "remove") throw new Error("is not a working tree");
      return "";
    });
    expect(pruned.map((args) => args.slice(0, 2))).toContainEqual(["worktree", "prune"]);
  });
});

describe("worktree creation", () => {
  it.each([
    "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def",
    "error: unable to update local ref",
    "fatal: Unable to create '/repo/.git/FETCH_HEAD.lock': File exists.",
    "error: fetching ref refs/remotes/origin/main failed: incorrect old value provided",
    "error: fetching ref refs/remotes/origin/main failed: reference already exists",
  ])("creates from origin/main after a competing fetch fails with %s", async (message) => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-worktree-fetch-race-"));
    const calls: string[][] = [];
    let fetches = 0;
    const commit = "8888888888888888888888888888888888888888";
    try {
      const destination = await createWorktree(cwd, "feat/retry", { baseRef: "origin/main" }, async () => ({
        root: cwd, isRepo: true, isDirty: false, hasRemote: true,
        worktrees: [], refs: [], worktreeParent: join(cwd, "worktrees"),
      }), async (_path, args, maxBuffer) => {
        calls.push(args);
        if (args[0] === "remote") return "origin\n";
        if (args[0] === "fetch") {
          expect(maxBuffer).toBe(8 * 1024 * 1024);
          if (++fetches === 1) throw Object.assign(new Error("git fetch failed"), { stderr: message });
        }
        if (args.join(" ") === "rev-parse --verify --quiet origin/main^{commit}") {
          expect(fetches).toBe(2);
          return `${commit}\n`;
        }
        if (args[1] === "--symbolic-full-name") return "refs/remotes/origin/main\n";
        return "";
      });
      expect(destination).toBe(join(cwd, "worktrees", "feat-retry"));
      expect(calls.filter((args) => args[0] === "fetch")).toEqual([
        ["fetch", "--prune", "origin"], ["fetch", "--prune", "origin"],
      ]);
      expect(calls).toContainEqual(["worktree", "add", "-b", "feat/retry", destination, commit]);
      expect(calls).toContainEqual(["config", "branch.feat/retry.tau-base", "origin/main"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps automatically named threads isolated when their workspace metadata is stale", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-worktree-name-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "base"], { cwd });
      const stale = { ...(await readProjectGitState(cwd)).workspace, worktreeParent: join(cwd, "worktrees") };
      const options = { startFromOrigin: false, uniqueBranch: true };
      const first = await createWorktree(cwd, "fix/prevent-chat-scroll-jumps", options, async () => stale);
      const second = await createWorktree(cwd, "fix/prevent-chat-scroll-jumps", options, async () => stale);
      expect(second).not.toBe(first);
      expect((await runGitCommand(second, ["branch", "--show-current"])).trim()).toBe("fix/prevent-chat-scroll-jumps-2");
      expect((await runGitCommand(first, ["branch", "--show-current"])).trim()).toBe("fix/prevent-chat-scroll-jumps");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("uses distinct folders for branch names that have the same worktree slug", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-worktree-slug-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "base"], { cwd });
      const stale = { ...(await readProjectGitState(cwd)).workspace, worktreeParent: join(cwd, "worktrees") };
      const options = { startFromOrigin: false, uniqueBranch: true };
      const first = await createWorktree(cwd, "fix/chat-scroll", options, async () => stale);
      const second = await createWorktree(cwd, "fix-chat-scroll", options, async () => stale);
      expect(second).not.toBe(first);
      expect((await runGitCommand(second, ["branch", "--show-current"])).trim()).toBe("fix-chat-scroll-2");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("gives simultaneous automatically named threads distinct branches and folders", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-worktree-concurrent-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "base"], { cwd });
      const stale = { ...(await readProjectGitState(cwd)).workspace, worktreeParent: join(cwd, "worktrees") };
      // Keep branch allocation concurrent; unrelated metadata writes share one config lock.
      let configWrite: Promise<string> = Promise.resolve("");
      const runGit = (path: string, args: string[]) => {
        if (args[0] !== "config" || args[1]?.startsWith("--")) return runGitCommand(path, args);
        const writing = configWrite.then(() => runGitCommand(path, args));
        configWrite = writing.catch(() => "");
        return writing;
      };
      const created = await Promise.all(Array.from({ length: 3 }, () => createWorktree(cwd, "fix/chat-scroll", { startFromOrigin: false, uniqueBranch: true }, async () => stale, runGit)));
      expect(new Set(created).size).toBe(3);
      const branches = await Promise.all(created.map(async (path) => (await runGitCommand(path, ["branch", "--show-current"])).trim()));
      expect(branches.sort()).toEqual(["fix/chat-scroll", "fix/chat-scroll-2", "fix/chat-scroll-3"]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("creates a new branch from freshly fetched origin/main", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-worktree-"));
    const calls: string[][] = [];
    try {
      const destination = await createWorktree(cwd, "feat/fresh-main", { baseRef: "origin/main" }, async () => ({
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
        if (args[1] === "--symbolic-full-name") return "refs/remotes/origin/main\n";
        if (args[0] === "rev-parse") return "origin/main\n";
        return "";
      });

      expect(destination).toBe(join(cwd, "worktrees", "feat-fresh-main"));
      expect(calls).toContainEqual(["fetch", "--prune", "origin"]);
      expect(calls).toContainEqual(["worktree", "add", "-b", "feat/fresh-main", destination, "origin/main"]);
      // The base a later diff compares against is recorded on the branch.
      expect(calls).toContainEqual(["config", "branch.feat/fresh-main.tau-base", "origin/main"]);
      expect(calls).toContainEqual(["config", "branch.feat/fresh-main.tau-review-target", "main"]);
      expect(calls.findIndex((args) => args[0] === "fetch"))
        .toBeLessThan(calls.findIndex((args) => args[0] === "worktree"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("starts from origin's main line, not the checkout's branch, when no base is chosen", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-worktree-"));
    const calls: string[][] = [];
    try {
      const destination = await createWorktree(cwd, "feat/default", {}, async () => ({
        root: cwd,
        isRepo: true,
        isDirty: false,
        branch: "feature/current",
        hasRemote: true,
        worktrees: [],
        refs: [],
        worktreeParent: join(cwd, "worktrees"),
      }), async (_path, args) => {
        calls.push(args);
        if (args[0] === "symbolic-ref") return "origin/main\n";
        if (args[0] === "remote") return "origin\n";
        if (args.join(" ") === "rev-parse --verify --quiet origin/main^{commit}") return "7777777777777777777777777777777777777777\n";
        return "";
      });
      expect(calls).toContainEqual(["worktree", "add", "-b", "feat/default", destination, "7777777777777777777777777777777777777777"]);
      expect(calls).toContainEqual(["config", "branch.feat/default.tau-base", "origin/main"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uses the selected local base without fetching", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-worktree-"));
    const calls: string[][] = [];
    try {
      await createWorktree(cwd, "feat/local-main", { baseRef: "main", startFromOrigin: false }, async () => ({
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
        if (args[1] === "--symbolic-full-name") return "refs/heads/main\n";
        if (args[0] === "rev-parse") return "main\n";
        return "";
      });

      expect(calls.some((args) => args[0] === "fetch")).toBe(false);
      expect(calls.find((args) => args[0] === "worktree")?.at(-1)).toBe("main");
      expect(calls).toContainEqual(["config", "branch.feat/local-main.tau-review-target", "main"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not silently create from stale state when fetching fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-worktree-"));
    const calls: string[][] = [];
    try {
      await expect(createWorktree(cwd, "feat/offline", { baseRef: "origin/main" }, async () => ({
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

  it("adds the folder's path below the working tree root when Git has to answer", async () => {
    const run = (toplevel: string) => async (_path: string, args: string[]) => {
      if (args.includes("--git-common-dir")) return "/repos/tau/.git\n";
      if (args.includes("--show-toplevel")) return toplevel;
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    expect(await repositoryDisplayName("/repos/tau/apps/server", run("/repos/tau\n"))).toBe("tau/apps/server");
    expect(await repositoryDisplayName("/repos/tau", run("/repos/tau\n"))).toBe("tau");
    // No working tree to measure from: the plain repository name stands.
    expect(await repositoryDisplayName("/repos/tau/apps/server", async (_path, args) => {
      if (args.includes("--show-toplevel")) throw new Error("this operation must be run in a work tree");
      return "/repos/tau/.git\n";
    })).toBe("tau");
  });
});
