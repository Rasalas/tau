import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentWorktree,
  prepareWorktreeParent,
  readWorktreeConfig,
  removeAgentWorktree,
  resolveWorktreeParent,
  worktreeParentOf,
} from "./agent-worktrees.js";
import { createWorktree } from "./workspace-worktrees.js";
import { readProjectGitState } from "./workspace-git.js";
import { tauHomeDir } from "tau/host-extension";

const created: string[] = [];

async function createTestRepo(name = "myrepo"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tau-wt-config-"));
  created.push(root);
  const cwd = join(root, name);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  execFileSync("mkdir", ["-p", cwd]);
  execFileSync("git", ["init", "-q", "-b", "main", cwd]);
  git("config", "user.email", "tau@example.com");
  git("config", "user.name", "Tau");
  await writeFile(join(cwd, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial commit");
  return cwd;
}

const originalEnv = process.env.TAU_WORKTREES_DIR;

beforeEach(() => {
  delete process.env.TAU_WORKTREES_DIR;
});

afterEach(async () => {
  if (originalEnv !== undefined) {
    process.env.TAU_WORKTREES_DIR = originalEnv;
  } else {
    delete process.env.TAU_WORKTREES_DIR;
  }
  for (const root of created.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("resolveWorktreeParent", () => {
  it("defaults to a central Spotlight-excluded bucket for each checkout", () => {
    const root = "/repos/project";
    const parent = resolveWorktreeParent(root);
    expect(parent).toMatch(/project-[a-f0-9]{12}\.noindex$/u);
    expect(parent.startsWith(join(tauHomeDir(), "worktrees"))).toBe(true);
    expect(resolveWorktreeParent(root, " ")).toBe(parent);
    expect(resolveWorktreeParent("/other/project")).not.toBe(parent);
    expect(resolveWorktreeParent("/repos/temp/../project")).toBe(parent);
  });

  it("keeps the explicit beside location", () => {
    const root = "/repos/project";
    expect(resolveWorktreeParent(root, "beside")).toBe("/repos/project-worktrees");
  });

  it("resolves ~/.tau/worktrees to nest under the repository name", () => {
    const root = "/repos/project";
    const expected = join(homedir(), ".tau", "worktrees", "project");
    expect(resolveWorktreeParent(root, "~/.tau/worktrees")).toBe(expected);
  });

  it("resolves configured paths containing {project} placeholder", () => {
    const root = "/repos/project";
    const expected = join(homedir(), ".tau", "worktrees", "project-forks");
    expect(resolveWorktreeParent(root, "~/.tau/worktrees/{project}-forks")).toBe(expected);
  });

  it("does not duplicate repository name if path already ends with it", () => {
    const root = "/repos/project";
    const expected = join(homedir(), ".tau", "worktrees", "project");
    expect(resolveWorktreeParent(root, "~/.tau/worktrees/project")).toBe(expected);
  });

  it("resolves custom absolute directories", () => {
    const root = "/repos/project";
    expect(resolveWorktreeParent(root, "/custom/dir")).toBe("/custom/dir/project");
  });
});

describe("desktop indexing exclusions", () => {
  it("creates GNOME's marker in a central bucket before a worktree, without replacing it", async () => {
    const parent = resolveWorktreeParent("/repos/project");
    await prepareWorktreeParent(parent, { platform: "linux", defaultParent: parent });
    const marker = join(parent, ".nomedia");
    await expect(readFile(marker, "utf8")).resolves.toBe("");
    await writeFile(marker, "existing\n");
    await prepareWorktreeParent(parent, { platform: "linux", defaultParent: parent });
    await expect(readFile(marker, "utf8")).resolves.toBe("existing\n");
  });

  it("leaves custom folders and other platforms free of extra files", async () => {
    const parent = await mkdtemp(join(tmpdir(), "tau-custom-indexing-"));
    created.push(parent);
    await prepareWorktreeParent(parent, { platform: "linux" });
    await expect(readFile(join(parent, ".nomedia"))).rejects.toMatchObject({ code: "ENOENT" });
    const central = resolveWorktreeParent("/repos/other-platform");
    await prepareWorktreeParent(central, { platform: "darwin" });
    await expect(readFile(join(central, ".nomedia"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a central bucket redirected into an unrelated folder before writing a marker", async () => {
    const unrelated = await mkdtemp(join(tmpdir(), "tau-unrelated-indexing-"));
    created.push(unrelated);
    const parent = resolveWorktreeParent("/repos/redirected");
    await mkdir(join(parent, ".."), { recursive: true });
    await symlink(unrelated, parent, "junction");
    await expect(prepareWorktreeParent(parent, { platform: "linux", defaultParent: parent })).rejects.toThrow(/outside its storage folder/u);
    await expect(readFile(join(unrelated, ".nomedia"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a custom bucket symlink under the central root without indexing unrelated files", async () => {
    const unrelated = await mkdtemp(join(tmpdir(), "tau-custom-symlink-"));
    created.push(unrelated);
    const parent = resolveWorktreeParent("/repos/custom-repo", "~/.tau/worktrees");
    await mkdir(join(parent, ".."), { recursive: true });
    await symlink(unrelated, parent, "junction");
    await prepareWorktreeParent(parent, { platform: "linux", defaultParent: resolveWorktreeParent("/repos/custom-repo") });
    await expect(readFile(join(unrelated, ".nomedia"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("readWorktreeConfig", () => {
  it("reads worktreeDirectory from .tau/project.json", async () => {
    const repo = await createTestRepo();
    await mkdir(join(repo, ".tau"), { recursive: true });
    await writeFile(join(repo, ".tau", "project.json"), JSON.stringify({ worktreeDirectory: "~/.tau/worktrees" }));

    const config = await readWorktreeConfig(repo);
    expect(config).toBe("~/.tau/worktrees");
  });

  it("falls back to TAU_WORKTREES_DIR env var", async () => {
    const repo = await createTestRepo();
    process.env.TAU_WORKTREES_DIR = "~/.tau/env-worktrees";

    const config = await readWorktreeConfig(repo);
    expect(config).toBe("~/.tau/env-worktrees");
  });
});

describe("worktreeParentOf with configuration", () => {
  it("uses one default bucket from the main checkout, its alias and its linked worktree", async () => {
    const repo = await realpath(await createTestRepo("default-project"));
    const parent = await worktreeParentOf(repo);
    const worktree = await createWorktree(repo, "default-child");
    expect(worktree).toBe(join(parent, "default-child"));
    expect(await worktreeParentOf(worktree)).toBe(parent);
    expect((await readProjectGitState(worktree)).workspace.worktreeParent).toBe(parent);
    const alias = join(repo, "..", "alias");
    await symlink(repo, alias, "junction");
    expect(await worktreeParentOf(alias)).toBe(parent);
    expect((await readProjectGitState(alias)).workspace.worktreeParent).toBe(parent);
  });

  it("returns configured path for a repository", async () => {
    const repo = await createTestRepo("project-alpha");
    await mkdir(join(repo, ".tau"), { recursive: true });
    await writeFile(join(repo, ".tau", "project.json"), JSON.stringify({ worktreeDirectory: "~/.tau/worktrees" }));

    const parent = await worktreeParentOf(repo);
    expect(parent).toBe(join(homedir(), ".tau", "worktrees", "project-alpha"));
  });

  it("returns configured path even when called from inside a linked worktree", async () => {
    const repo = await createTestRepo("project-beta");
    await mkdir(join(repo, ".tau"), { recursive: true });
    await writeFile(join(repo, ".tau", "project.json"), JSON.stringify({ worktreeDirectory: "~/.tau/worktrees" }));

    const parent = await worktreeParentOf(repo);
    created.push(parent);
    const worktreePath = join(parent, "child-wt");
    execFileSync("git", ["worktree", "add", "-b", "child-branch", worktreePath, "HEAD"], { cwd: repo });

    const parentFromChild = await worktreeParentOf(worktreePath);
    expect(parentFromChild).toBe(join(homedir(), ".tau", "worktrees", "project-beta"));
  });
});

describe("agent worktrees in configured directory", () => {
  it("creates and removes an agent worktree in ~/.tau/worktrees", async () => {
    const repo = await createTestRepo("agent-test-repo");
    const customParent = await mkdtemp(join(tmpdir(), "custom-worktrees-"));
    created.push(customParent);

    await mkdir(join(repo, ".tau"), { recursive: true });
    await writeFile(join(repo, ".tau", "project.json"), JSON.stringify({ worktreeDirectory: customParent }));

    const worktree = await createAgentWorktree({
      parentCwd: repo,
      agentId: "testagent1",
    });

    expect(worktree.path.startsWith(join(customParent, "agent-test-repo"))).toBe(true);
    await expect(readFile(join(worktree.path, "README.md"), "utf8")).resolves.toBe("hello\n");

    await removeAgentWorktree({ parentCwd: repo, worktree });
    const worktreesList = execFileSync("git", ["worktree", "list"], { cwd: repo }).toString();
    expect(worktreesList).not.toContain(worktree.path);
  });
});

describe("readProjectGitState and createWorktree with configured directory", () => {
  it("reflects worktreeParent and creates worktree at destination", async () => {
    const repo = await createTestRepo("git-test-repo");
    const customParent = await mkdtemp(join(tmpdir(), "custom-git-worktrees-"));
    created.push(customParent);

    await mkdir(join(repo, ".tau"), { recursive: true });
    await writeFile(join(repo, ".tau", "project.json"), JSON.stringify({ worktreeDirectory: customParent }));

    const state = await readProjectGitState(repo);
    expect(state.workspace.worktreeParent).toBe(join(customParent, "git-test-repo"));

    const destination = await createWorktree(repo, "feat-config-test");
    expect(destination).toBe(join(customParent, "git-test-repo", "feat-config-test"));

    const worktreeList = execFileSync("git", ["worktree", "list"], { cwd: repo }).toString();
    expect(worktreeList).toContain(destination);
  });
});
