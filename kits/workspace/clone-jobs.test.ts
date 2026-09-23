import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloneJobs, parseCloneProgress, repositoryFolderName } from "./clone-jobs.js";
import type { CloneSnapshot } from "./protocol.js";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Tau", ...args], { cwd, stdio: "pipe" }).toString();
const exists = (path: string) => stat(path).then(() => true, () => false);

let root: string;
let bare: string;

/** A stand-in for git that reports progress, then waits until it is stopped. */
async function fakeGit(name: string, prepare: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, [
    "#!/bin/sh",
    'dest="$5"',
    prepare,
    "printf \"Cloning into '%s'...\\n\" \"$dest\" >&2",
    "printf 'Receiving objects:  10%% (1/10)\\r' >&2",
    "printf 'Receiving objects:  20%% (2/10), 1.00 MiB | 2.00 MiB/s\\r' >&2",
    "trap 'exit 143' TERM",
    "while :; do sleep 0.05; done",
  ].join("\n"));
  await chmod(path, 0o755);
  return path;
}

/** Collects the pushes of one clone and resolves once it reaches `phase`. */
function recorder() {
  const seen: CloneSnapshot[] = [];
  const waiting: Array<{ test(snapshot: CloneSnapshot): boolean; resolve(snapshot: CloneSnapshot): void }> = [];
  return {
    seen,
    emit(snapshot: CloneSnapshot) {
      seen.push(snapshot);
      for (const entry of [...waiting]) if (entry.test(snapshot)) { waiting.splice(waiting.indexOf(entry), 1); entry.resolve(snapshot); }
    },
    until(test: (snapshot: CloneSnapshot) => boolean): Promise<CloneSnapshot> {
      const found = seen.find(test);
      return found ? Promise.resolve(found) : new Promise((resolve) => waiting.push({ test, resolve }));
    },
  };
}

const identify = (path: string) => ({ workspaceId: `ws_${path}`, displayPath: path });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tau-clone-jobs-"));
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", "seed");
  await writeFile(join(seed, "readme.txt"), "hello\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "init");
  git(root, "clone", "-q", "--bare", seed, "project.git");
  bare = join(root, "project.git");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("clone progress lines", () => {
  it("reads the stage, the percent and the transfer detail", () => {
    expect(parseCloneProgress("remote: Counting objects:  33% (1/3)")).toEqual({ stage: "counting", percent: 33 });
    expect(parseCloneProgress("Receiving objects:  45% (450/1000), 12.30 MiB | 5.00 MiB/s")).toEqual({ stage: "receiving", percent: 45, detail: "12.30 MiB | 5.00 MiB/s" });
    expect(parseCloneProgress("Resolving deltas: 100% (3/3), done.")).toEqual({ stage: "resolving", percent: 100 });
    expect(parseCloneProgress("Updating files: 100% (12/12), done.")).toEqual({ stage: "checkout", percent: 100 });
    expect(parseCloneProgress("fatal: repository 'x' does not exist")).toBeUndefined();
  });

  it("names the folder after the repository", () => {
    expect(repositoryFolderName("https://github.com/acme/app.git")).toBe("app");
    expect(repositoryFolderName("git@example.com:acme/tools/")).toBe("tools");
  });
});

describe("clone jobs", () => {
  it("clones with progress and hands back the project", async () => {
    const parent = await mkdtemp(join(root, "parent-"));
    const events = recorder();
    const jobs = new CloneJobs({ git: "git", emit: events.emit, identify });
    const started = await jobs.start(`file://${bare}`, parent);
    expect(started).toMatchObject({ name: "project", destination: join(parent, "project"), phase: "running", stage: "connecting" });
    const done = await events.until((snapshot) => snapshot.phase !== "running");
    expect(done).toMatchObject({ phase: "done", workspace: identify(join(parent, "project")) });
    expect(events.seen.some((snapshot) => snapshot.phase === "running" && snapshot.stage === "receiving")).toBe(true);
    expect(await readFile(join(parent, "project", "readme.txt"), "utf8")).toBe("hello\n");
  });

  it("refuses a destination that exists and a parent that does not", async () => {
    const parent = await mkdtemp(join(root, "parent-"));
    await mkdir(join(parent, "project"));
    await writeFile(join(parent, "project", "mine.txt"), "keep\n");
    const jobs = new CloneJobs({ git: "git", emit: () => undefined, identify });
    await expect(jobs.start(`file://${bare}`, parent)).rejects.toThrow(/already exists/u);
    await expect(jobs.start(`file://${bare}`, join(parent, "missing"))).rejects.toThrow(/existing parent folder/u);
    expect(await readFile(join(parent, "project", "mine.txt"), "utf8")).toBe("keep\n");
  });

  it("cancels a running clone and removes only the folder it made", async () => {
    const parent = await mkdtemp(join(root, "parent-"));
    const events = recorder();
    const jobs = new CloneJobs({ git: await fakeGit("slow-git", 'mkdir -p "$dest/.git"'), emit: events.emit, identify });
    const started = await jobs.start("https://example.com/acme/slow.git", parent);
    await events.until((snapshot) => snapshot.percent === 20);
    expect(await exists(join(parent, "slow", ".git"))).toBe(true);
    expect(jobs.cancel(started.id)).toBe(true);
    const settled = await events.until((snapshot) => snapshot.phase !== "running");
    expect(settled).toMatchObject({ phase: "cancelled" });
    expect(settled.leftover).toBeUndefined();
    expect(await exists(join(parent, "slow"))).toBe(false);
    expect(await exists(parent)).toBe(true);
    expect(jobs.cancel(started.id)).toBe(false);
  });

  it("leaves a folder that holds anything but git's own, and says so", async () => {
    const parent = await mkdtemp(join(root, "parent-"));
    const events = recorder();
    const jobs = new CloneJobs({ git: await fakeGit("odd-git", 'mkdir -p "$dest" && echo keep > "$dest/notes.txt"'), emit: events.emit, identify });
    const started = await jobs.start("https://example.com/acme/odd.git", parent);
    await events.until((snapshot) => snapshot.percent === 20);
    jobs.cancel(started.id);
    const settled = await events.until((snapshot) => snapshot.phase !== "running");
    expect(settled).toMatchObject({ phase: "cancelled", leftover: join(parent, "odd") });
    expect(await readFile(join(parent, "odd", "notes.txt"), "utf8")).toBe("keep\n");
  });

  it("reports why a clone failed and leaves nothing behind", async () => {
    const parent = await mkdtemp(join(root, "parent-"));
    const events = recorder();
    const jobs = new CloneJobs({ git: "git", emit: events.emit, identify });
    await jobs.start(`file://${join(root, "missing.git")}`, parent);
    const settled = await events.until((snapshot) => snapshot.phase !== "running");
    expect(settled.phase).toBe("failed");
    expect(settled.error).toMatch(/does not appear to be a git repository|not found|does not exist/iu);
    expect(await exists(join(parent, "missing"))).toBe(false);
    jobs.forget(settled.id);
    expect(jobs.list()).toEqual([]);
  });
});
