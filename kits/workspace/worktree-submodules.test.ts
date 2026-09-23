import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGitCommand, type GitRunner } from "./workspace-git.js";
import { initWorktreeSubmodules } from "./worktree-submodules.js";
import { readProjectDefaults } from "./host.js";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

// Git refuses local submodule URLs by default; the fixtures are all local.
const FILE_PROTOCOL = ["-c", "protocol.file.allow=always"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...FILE_PROTOCOL, "-c", "user.email=t@example.com", "-c", "user.name=Tau", ...args], { cwd, stdio: "pipe" }).toString();
const runGit: GitRunner = (cwd, args) => runGitCommand(cwd, [...FILE_PROTOCOL, ...args], undefined, undefined, undefined, 60_000);
const exists = (path: string) => stat(path).then(() => true, () => false);

let root: string;
let superRepo: string;

async function repo(name: string, file: string): Promise<string> {
  const path = join(root, name);
  git(root, "init", "-q", "-b", "main", name);
  await writeFile(join(path, file), `${name}\n`);
  git(path, "add", "-A");
  git(path, "commit", "-qm", `init ${name}`);
  return path;
}

async function worktree(name: string): Promise<string> {
  const path = join(root, name);
  git(superRepo, "worktree", "add", "-q", "-b", name, path);
  return path;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tau-submodules-"));
  const nested = await repo("nested", "nested.txt");
  const child = await repo("child", "child.txt");
  git(child, "submodule", "add", "-q", nested, "nested");
  git(child, "commit", "-qm", "add nested");
  superRepo = await repo("super", "readme.txt");
  git(superRepo, "submodule", "add", "-q", child, "child");
  git(superRepo, "commit", "-qm", "add child");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("submodules in a new worktree", () => {
  it("initializes every level by default", async () => {
    const path = await worktree("wt-default");
    const started: string[] = [];
    expect(await exists(join(path, "child", "child.txt"))).toBe(false);
    const result = await initWorktreeSubmodules(path, undefined, { runGit, onStart: (mode) => started.push(mode) });
    expect(result).toEqual({ mode: "recursive", ok: true });
    expect(started).toEqual(["recursive"]);
    expect(await readFile(join(path, "child", "child.txt"), "utf8")).toBe("child\n");
    expect(await readFile(join(path, "child", "nested", "nested.txt"), "utf8")).toBe("nested\n");
  });

  it("stops at the repository's own submodules with top-level", async () => {
    const path = await worktree("wt-top");
    expect(await initWorktreeSubmodules(path, "top-level", { runGit })).toEqual({ mode: "top-level", ok: true });
    expect(await exists(join(path, "child", "child.txt"))).toBe(true);
    expect(await exists(join(path, "child", "nested", "nested.txt"))).toBe(false);
  });

  it("leaves them empty with none and runs no git at all", async () => {
    const path = await worktree("wt-none");
    const calls: string[][] = [];
    const result = await initWorktreeSubmodules(path, "none", { runGit: async (_cwd, args) => { calls.push(args); return ""; } });
    expect(result).toEqual({ mode: "none", ok: true });
    expect(calls).toEqual([]);
    expect(await exists(join(path, "child", "child.txt"))).toBe(false);
  });

  it("answers undefined for a checkout without submodules", async () => {
    const plain = await repo("plain", "a.txt");
    expect(await initWorktreeSubmodules(plain, "recursive", { runGit })).toBeUndefined();
  });

  it("reports a failure instead of throwing, so the worktree stays usable", async () => {
    const path = await worktree("wt-broken");
    // Without the file protocol allowed, git refuses the local submodule URL.
    const result = await initWorktreeSubmodules(path, "recursive", { runGit: (cwd, args) => runGitCommand(cwd, ["-c", "protocol.file.allow=never", ...args]) });
    expect(result).toMatchObject({ mode: "recursive", ok: false });
    expect(result?.detail).toBeTruthy();
    expect(await exists(join(path, "readme.txt"))).toBe(true);
  });

  it("reads worktreeSubmodules from the checkout's project file and ignores a value it does not know", async () => {
    const path = await worktree("wt-file");
    await mkdir(join(path, ".tau"), { recursive: true });
    await writeFile(join(path, ".tau", "project.json"), JSON.stringify({ worktreeSubmodules: "top-level" }));
    expect((await readProjectDefaults(path)).worktreeSubmodules).toBe("top-level");
    await writeFile(join(path, ".tau", "project.json"), JSON.stringify({ worktreeSubmodules: "some" }));
    expect((await readProjectDefaults(path)).worktreeSubmodules).toBeUndefined();
  });
});
