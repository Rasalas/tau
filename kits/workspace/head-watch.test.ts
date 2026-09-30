import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitDirOf, HeadWatch } from "./head-watch.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fakeWatch() {
  const listeners = new Map<string, (event: string, filename: string | null) => void>();
  const closed: string[] = [];
  const watch = vi.fn((path: string, listener: (event: string, filename: string | null) => void) => {
    listeners.set(path, listener);
    return Object.assign(new EventEmitter(), { close: () => closed.push(path) }) as unknown as FSWatcher;
  });
  return { watch, listeners, closed };
}

describe("HeadWatch", () => {
  it("reports a HEAD rename once per burst and ignores the rest of the git dir", () => {
    vi.useFakeTimers();
    const { watch, listeners } = fakeWatch();
    const changed = vi.fn();
    const heads = new HeadWatch({ changed, watch, gitDir: (root) => `${root}/.git` });
    heads.follow("/repo");
    heads.follow("/repo");
    expect(watch).toHaveBeenCalledTimes(1);

    const fire = listeners.get("/repo/.git")!;
    fire("rename", "index.lock");
    fire("rename", "HEAD");
    fire("change", "HEAD");
    vi.advanceTimersByTime(200);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith("/repo");
  });

  it("keeps a bounded number of watches, dropping the one asked about longest ago", () => {
    const { watch, closed } = fakeWatch();
    const heads = new HeadWatch({ changed: vi.fn(), watch, gitDir: (root) => `${root}/.git`, limit: 2 });
    heads.follow("/a");
    heads.follow("/b");
    heads.follow("/a");
    heads.follow("/c");
    expect(closed).toEqual(["/b/.git"]);
    heads.close();
    expect(closed).toEqual(["/b/.git", "/a/.git", "/c/.git"]);
  });

  it("finds a worktree's git dir through its .git file", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-head-watch-"));
    directories.push(root);
    await mkdir(join(root, "main", ".git"), { recursive: true });
    await mkdir(join(root, "linked"));
    await writeFile(join(root, "linked", ".git"), "gitdir: ../main/.git/worktrees/linked\n");
    expect(gitDirOf(join(root, "main"))).toBe(join(root, "main", ".git"));
    expect(gitDirOf(join(root, "linked"))).toBe(join(root, "main", ".git", "worktrees", "linked"));
    expect(gitDirOf(join(root, "missing"))).toBeUndefined();
  });
});
