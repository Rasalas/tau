import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRunner } from "./git.js";
import { collectIgnoredFiles, safeRelativePath, suggestIgnoredFiles, writeIgnoredFiles } from "./ignored-files.js";

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function put(root: string, path: string, content: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

/** A checkout with the ignored files a user has: secrets, an issue folder, dependencies, a build, a large log. */
async function checkout(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-ignored-"));
  created.push(dir);
  const root = join(dir, "work");
  await mkdir(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await put(root, ".gitignore", ".env*\n.scratch/\nnode_modules/\ndist/\n*.log\nlocal.json\nbig.txt\npicture.bin\n");
  await put(root, "README.md", "# app\n");
  await put(root, ".env", "TOKEN=abc\n");
  await put(root, ".env.local", "PORT=3000\n");
  await put(root, ".scratch/issues/01-first.md", "# First\n");
  await put(root, ".scratch/issues/02-second.md", "# Second\n");
  await put(root, "node_modules/left-pad/index.js", "module.exports = 1;\n");
  await put(root, "dist/app.js", "built\n");
  await put(root, "debug.log", "log\n");
  await put(root, "local.json", "{\"port\": 1}\n");
  await put(root, "big.txt", "x".repeat(300 * 1024));
  await put(root, "picture.bin", Buffer.from([1, 0, 2, 0]));
  return root;
}

describe("ignored files that go along", () => {
  it("offers .env files, issue folders and small text, and never dependencies, builds, logs, large or binary files", async () => {
    const root = await checkout();
    const { candidates, skipped } = await suggestIgnoredFiles(root, createGitRunner());
    expect(candidates.map((candidate) => [candidate.path, candidate.reason, candidate.files])).toEqual([
      [".env", "env", 1],
      [".env.local", "env", 1],
      [".scratch/", "issues", 2],
      ["local.json", "text", 1],
    ]);
    expect(Object.fromEntries(skipped.map((entry) => [entry.path, entry.why]))).toEqual({
      "node_modules/": "build", "dist/": "build", "debug.log": "system", "big.txt": "large", "picture.bin": "binary",
    });
  });

  it("reads only the chosen paths' ignored files, never a tracked one or one outside the checkout", async () => {
    const root = await checkout();
    const files = await collectIgnoredFiles(root, [".env", ".scratch/", "README.md", "../outside", "/etc/passwd"], createGitRunner());
    expect(files.map((file) => file.path).sort()).toEqual([".env", ".scratch/issues/01-first.md", ".scratch/issues/02-second.md"]);
    expect(Buffer.from(files.find((file) => file.path === ".env")!.data, "base64").toString()).toBe("TOKEN=abc\n");
  });

  it("writes what came into the new worktree and refuses paths that leave it, reach into .git or replace a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-ignored-write-"));
    created.push(dir);
    const worktree = join(dir, "worktree");
    await mkdir(worktree);
    await put(worktree, "tracked.txt", "from the bundle\n");
    await mkdir(join(dir, "elsewhere"));
    await symlink(join(dir, "elsewhere"), join(worktree, "link"));
    const data = (text: string) => Buffer.from(text).toString("base64");
    const result = await writeIgnoredFiles(worktree, [
      { path: ".env", mode: 0o644, data: data("TOKEN=abc\n") },
      { path: "bin/run", mode: 0o755, data: data("#!/bin/sh\n") },
      { path: "../escape", mode: 0o644, data: data("no") },
      { path: ".git/config", mode: 0o644, data: data("no") },
      { path: "tracked.txt", mode: 0o644, data: data("no") },
      { path: "link/inside", mode: 0o644, data: data("no") },
    ]);
    expect(result).toEqual({ written: 2, refused: ["../escape", ".git/config", "tracked.txt", "link/inside"] });
    expect(await readFile(join(worktree, ".env"), "utf8")).toBe("TOKEN=abc\n");
    expect(await readFile(join(worktree, "tracked.txt"), "utf8")).toBe("from the bundle\n");
    expect(existsSync(join(dir, "escape"))).toBe(false);
    expect(existsSync(join(dir, "elsewhere", "inside"))).toBe(false);
    if (process.platform !== "win32") expect((await stat(join(worktree, "bin/run"))).mode & 0o111).not.toBe(0);
  });

  it("takes only relative paths inside the folder", () => {
    expect(safeRelativePath(".scratch/")).toBe(".scratch");
    expect(safeRelativePath("a/b.txt")).toBe("a/b.txt");
    for (const path of ["", "..", "a/../b", "/abs", "C:/x", ".git", ".GIT/hooks", "a//b"]) expect(safeRelativePath(path)).toBeUndefined();
  });
});
