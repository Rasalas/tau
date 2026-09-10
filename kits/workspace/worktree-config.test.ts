import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentWorktree,
  readWorktreeConfig,
  removeAgentWorktree,
  resolveWorktreeParent,
  worktreeParentOf,
} from "./agent-worktrees.js";
import { createWorktree, readProjectGitState } from "./workspace-git.js";

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
  it("defaults to beside repository when unconfigured or 'beside'", () => {
    const root = "/repos/project";
    expect(resolveWorktreeParent(root)).toBe("/repos/project-worktrees");
    expect(resolveWorktreeParent(root, undefined)).toBe("/repos/project-worktrees");
    expect(resolveWorktreeParent(root, "")).toBe("/repos/project-worktrees");
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
