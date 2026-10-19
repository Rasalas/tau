import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { gitEnvironment } from "tau/host-extension";
import { runGitCommand } from "./git-command.js";
import { runAgentGit } from "./agent-worktrees.js";
import { storageGit } from "./worktree-storage.js";
import { getBranchChanges, getFileDiff } from "./workspace-git.js";
import { createWorkspaceSnapshot } from "./workspace-snapshots.js";

const isolated = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: isolated, encoding: "utf8" }).trim();

it("appends the bare repository policy after inherited config, including Windows casing", () => {
  const base = { git_config_count: "1", Git_Config_Key_0: "safe.bareRepository", git_config_value_0: "all", GIT_INDEX_FILE: "scratch", PATH: "kept" };
  expect(gitEnvironment(base)).toEqual({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "all", GIT_CONFIG_KEY_1: "safe.bareRepository", GIT_CONFIG_VALUE_1: "explicit", GIT_INDEX_FILE: "scratch", PATH: "kept" });
  expect(base.git_config_count).toBe("1");
  expect(gitEnvironment({})).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit" });
  for (const count of ["-1", "1.5", "invalid", "0x10"]) expect(() => gitEnvironment({ GIT_CONFIG_COUNT: count })).toThrow("Invalid GIT_CONFIG_COUNT");
});

it.each([["workspace", runGitCommand], ["worktrees", runAgentGit], ["storage", storageGit]] as const)("%s refuses discovery of an embedded bare repository", async (_name, run) => {
  const cwd = await mkdtemp(join(tmpdir(), "tau-bare-policy-"));
  try {
    git(cwd, "init", "-q");
    const embedded = join(cwd, "embedded.git");
    git(cwd, "init", "--bare", "-q", embedded);
    git(cwd, "--git-dir", embedded, "config", "safe.bareRepository", "all");
    await expect(run(embedded, ["rev-parse", "--is-bare-repository"])).rejects.toThrow();
    expect((await run(cwd, ["--git-dir", embedded, "rev-parse", "--is-bare-repository"])).trim()).toBe("true");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it("captures checkpoints without splitting the scratch index or expiring the real shared index", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tau-split-policy-"));
  try {
    git(cwd, "init", "-q");
    await writeFile(join(cwd, "file.txt"), "base\n");
    git(cwd, "add", ".");
    git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "base");
    git(cwd, "config", "core.splitIndex", "true");
    git(cwd, "config", "splitIndex.sharedIndexExpire", "now");
    git(cwd, "update-index", "--split-index");
    const index = await readFile(join(cwd, ".git/index"));
    const shared = (await readdir(join(cwd, ".git"))).filter((name) => name.startsWith("sharedindex."));
    await writeFile(join(cwd, "file.txt"), "changed\n");
    const snapshot = await createWorkspaceSnapshot(cwd, { namespace: "split-policy/turn", phase: "before", runGit: async (path, args, maxBuffer, signal, env) => {
      if (["read-tree", "add", "write-tree"].some((command) => args.includes(command))) {
        expect(args).toContain("core.splitIndex=false");
        expect(args).toContain("splitIndex.sharedIndexExpire=never");
      }
      return runGitCommand(path, args, maxBuffer, signal, env);
    } });
    expect(git(cwd, "show", `${snapshot.treeId}:file.txt`)).toBe("changed");
    expect(await readFile(join(cwd, ".git/index"))).toEqual(index);
    for (const name of shared) await expect(readFile(join(cwd, ".git", name))).resolves.toBeDefined();
    expect(git(cwd, "diff", "--name-only")).toBe("file.txt");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it.each(["refs/heads/origin/main", "refs/tags/origin/main"])("compares the exact remote base despite %s", async (shadow) => {
  const cwd = await mkdtemp(join(tmpdir(), "tau-remote-policy-"));
  try {
    git(cwd, "init", "-q");
    git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "base");
    git(cwd, "update-ref", shadow, "HEAD");
    await writeFile(join(cwd, "remote.txt"), "remote\n");
    git(cwd, "add", ".");
    git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "remote");
    git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    await writeFile(join(cwd, "feature.txt"), "feature\n");
    git(cwd, "add", ".");
    git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "feature");
    for (const query of [{}, { baseRef: "origin/main" }]) {
      const changes = await getBranchChanges(cwd, query);
      expect(changes.baseRef).toBe("origin/main");
      expect(changes.files.map((file) => file.path)).toEqual(["feature.txt"]);
    }
    const diff = await getFileDiff(cwd, "remote.txt", { scope: "branch", baseRef: "origin/main" });
    expect(diff.hunks).toEqual([]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
