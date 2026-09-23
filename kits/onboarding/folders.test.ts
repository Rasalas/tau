import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { excludedFolders, folderGit, isExcludedFolder, originUrl, remoteIdentity } from "./folders.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("a found folder's Git identity", () => {
  it("gives every spelling of one remote the same key", () => {
    const github = { key: "github.com/acme/app", label: "acme/app" };
    expect(remoteIdentity("git@github.com:acme/app.git")).toEqual(github);
    expect(remoteIdentity("https://github.com/acme/app")).toEqual(github);
    expect(remoteIdentity("https://token@GitHub.com/acme/app.git/")).toEqual(github);
    expect(remoteIdentity("ssh://git@github.com:22/acme/app.git")).toEqual(github);
    expect(remoteIdentity("git@gitlab.example.com:group/sub/tool.git")).toEqual({ key: "gitlab.example.com/group/sub/tool", label: "group/sub/tool" });
    expect(remoteIdentity("file:///srv/git/app.git")).toBeUndefined();
    expect(remoteIdentity("/srv/git/app.git")).toBeUndefined();
  });

  it("reads origin's URL and no other remote's", () => {
    const config = "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = git@github.com:up/app.git\n[remote \"origin\"]\n\turl = git@github.com:acme/app.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n";
    expect(originUrl(config)).toBe("git@github.com:acme/app.git");
    expect(originUrl("[remote \"upstream\"]\n\turl = x\n")).toBeUndefined();
  });

  it("tells a repository from a linked worktree and from a plain folder, without running Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-onboarding-git-"));
    directories.push(root);
    const repo = join(root, "app");
    await mkdir(join(repo, ".git", "worktrees", "feature"), { recursive: true });
    await writeFile(join(repo, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/acme/app.git\n");
    const worktree = join(root, "app-feature");
    await mkdir(worktree);
    await writeFile(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "feature")}\n`);
    const submodule = join(repo, "vendor", "lib");
    await mkdir(join(repo, ".git", "modules", "lib"), { recursive: true });
    await mkdir(submodule, { recursive: true });
    await writeFile(join(submodule, ".git"), "gitdir: ../../.git/modules/lib\n");
    await writeFile(join(repo, ".git", "modules", "lib", "config"), "[remote \"origin\"]\n\turl = git@github.com:acme/lib.git\n");

    await expect(folderGit(repo)).resolves.toEqual({ kind: "repository", remote: { key: "github.com/acme/app", label: "acme/app" } });
    await expect(folderGit(worktree)).resolves.toEqual({ kind: "worktree" });
    await expect(folderGit(submodule)).resolves.toEqual({ kind: "repository", remote: { key: "github.com/acme/lib", label: "acme/lib" } });
    await expect(folderGit(root)).resolves.toEqual({ kind: "none" });
  });
});

describe("folders that are never offered as projects", () => {
  const excluded = excludedFolders("/Users/me", { TAU_WORKTREES_DIR: "/Users/me/.tau-dev/worktrees" }, "/var/folders/xy/T");

  it("leaves out home and the temporary folders themselves, and anything inside Downloads, Codex's scratch and Tau's worktrees", () => {
    for (const path of ["/Users/me", "/Users/me/", "/tmp", "/private/tmp", "/var/folders/xy/T", "/Users/me/Downloads/tool-1.2", "/Users/me/Documents/Codex/2026-09-01/fix", "/Users/me/.tau-dev/worktrees/app/wt-1"]) {
      expect(isExcludedFolder(path, excluded, false), path).toBe(true);
    }
    for (const path of ["/Users/me/code/app", "/tmp/project", "/Users/me/Downloads-archive", "/Users/me/Documents/notes"]) {
      expect(isExcludedFolder(path, excluded, false), path).toBe(false);
    }
  });

  it("folds case where the file system does", () => {
    expect(isExcludedFolder("/users/ME/downloads/thing", excluded, true)).toBe(true);
    expect(isExcludedFolder("/users/ME/downloads/thing", excluded, false)).toBe(false);
  });
});
