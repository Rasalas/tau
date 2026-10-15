import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFolderIndexCache, indexFolders } from "./folder-index.js";
import type { UiFolderIndex } from "./protocol.js";

let root: string;

async function repository(path: string, url?: string) {
  await mkdir(join(path, ".git"), { recursive: true });
  await writeFile(join(path, ".git", "config"), url ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : "[core]\n\tbare = false\n");
}

beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "folder-index-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("indexFolders", () => {
  it("lists folders below the root and names each repository's host", async () => {
    await repository(join(root, "work", "tau"), "git@github.com:Rasalas/tau.git");
    await repository(join(root, "work", "intranet"), "https://gitlab.example.de/team/intranet.git");
    await repository(join(root, "notes"));
    await mkdir(join(root, "work", "tau", "kits"), { recursive: true });
    await mkdir(join(root, "empty"));

    const index = await indexFolders(root);

    expect(index).toEqual({ root, truncated: false, folders: [
      { path: "empty" },
      { path: "notes", repository: "git" },
      { path: "work" },
      { path: "work/intranet", repository: "gitlab" },
      { path: "work/tau", repository: "github" },
    ] });
  });

  it("reads a linked worktree's host from the repository it belongs to", async () => {
    await repository(join(root, "main"), "https://codeberg.org/me/main.git");
    await mkdir(join(root, "main", ".git", "worktrees", "feature"), { recursive: true });
    await writeFile(join(root, "main", ".git", "worktrees", "feature", "commondir"), "../..\n");
    await mkdir(join(root, "feature"));
    await writeFile(join(root, "feature", ".git"), `gitdir: ${join(root, "main", ".git", "worktrees", "feature")}\n`);

    const index = await indexFolders(root);

    expect(index.folders).toContainEqual({ path: "feature", repository: "forgejo" });
  });

  it("skips hidden folders, dependency folders and symlinks", async () => {
    await mkdir(join(root, ".cache", "deep"), { recursive: true });
    await mkdir(join(root, "app", "node_modules", "lib"), { recursive: true });
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));

    const index = await indexFolders(root);

    expect(index.folders.map((entry) => entry.path)).toEqual(["app", "real"]);
  });

  it("stops at its depth and reports a walk cut short by its size", async () => {
    await mkdir(join(root, "a", "b", "c", "d"), { recursive: true });
    for (const name of ["x1", "x2", "x3", "x4"]) await mkdir(join(root, name));

    expect((await indexFolders(root, { maxDepth: 2 })).folders.map((entry) => entry.path)).toEqual(["a", "a/b", "x1", "x2", "x3", "x4"]);
    expect((await indexFolders(root, { maxFolders: 2 })).truncated).toBe(true);
  });

  it("refuses a relative path", async () => {
    await expect(indexFolders("repos")).rejects.toThrow("absolute");
  });
});

describe("createFolderIndexCache", () => {
  it("answers from memory and walks again behind a stale answer", async () => {
    let clock = 0;
    let walks = 0;
    const index = vi.fn(async (path: string): Promise<UiFolderIndex> => ({ root: path, truncated: false, folders: [{ path: `walk-${++walks}` }] }));
    const cached = createFolderIndexCache(index, () => clock);

    expect((await cached(root)).folders[0]!.path).toBe("walk-1");
    clock = 10_000;
    expect((await cached(root)).folders[0]!.path).toBe("walk-1");
    expect(index).toHaveBeenCalledTimes(1);

    clock = 40_000;
    expect((await cached(root)).folders[0]!.path).toBe("walk-1");
    await vi.waitFor(() => expect(index).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await cached(root)).folders[0]!.path).toBe("walk-2"));
  });
});
