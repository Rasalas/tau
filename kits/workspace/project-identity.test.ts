import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { isNestedProject, mainCheckoutOf, repositoryDisplayName } from "./workspace-git.js";

// Reproduce a Git executable that cannot answer under host load. Project
// identity must still come from the small metadata files already on disk.
vi.mock("tau/host-extension", async (original) => ({
  ...await original<Record<string, unknown>>(),
  gitExecutable: () => "/missing-tau-test-git",
}));

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it("names and classifies a linked worktree without starting Git", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-project-identity-")));
  folders.push(root);
  const repository = join(root, "Widgets");
  const worktree = join(root, "tau-d5b34bc9");
  const gitDir = join(repository, ".git", "worktrees", "fix");
  await mkdir(gitDir, { recursive: true });
  await mkdir(worktree);
  await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  await writeFile(join(gitDir, "commondir"), "../..\n");

  expect(await repositoryDisplayName(worktree)).toBe("Widgets");
  expect(await mainCheckoutOf(worktree)).toBe(repository);
  expect(await isNestedProject(worktree)).toBe(true);
  expect(await isNestedProject(repository)).toBe(false);
});

it("resolves relative gitdir paths and folders inside a worktree", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-project-identity-")));
  folders.push(root);
  const repository = join(root, "Widgets");
  const worktree = join(root, "tau-linked");
  const gitDir = join(repository, ".git", "worktrees", "fix");
  await mkdir(gitDir, { recursive: true });
  await mkdir(join(worktree, "src"), { recursive: true });
  await writeFile(join(worktree, ".git"), "gitdir: ../Widgets/.git/worktrees/fix\n");
  await writeFile(join(gitDir, "commondir"), "../..\n");
  expect(await repositoryDisplayName(join(worktree, "src"))).toBe("Widgets");
  expect(await mainCheckoutOf(join(worktree, "src"))).toBe(repository);
});
