import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtensionContext, HostExtensionServices } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createWorkspaceHostExtension } from "./host.js";
import { decodeRepoFromTree, repoFromTree } from "./repo-writes.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function folder(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `tau-repo-writes-${name}-`));
  directories.push(path);
  return path;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const gitAs = (cwd: string, ...args: string[]) => git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args);

/** A bare repository whose `refs/tau/server` holds `files`, the way the Servers kit keeps a server's state. */
async function shadow(files: Record<string, string>, executable: string[] = []): Promise<string> {
  const work = await folder("shadow-work");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(work, path, ".."), { recursive: true });
    await writeFile(join(work, path), text);
    if (executable.includes(path)) await chmod(join(work, path), 0o755);
  }
  gitAs(work, "init", "-q", "-b", "main");
  gitAs(work, "add", "-A");
  gitAs(work, "commit", "-q", "-m", "server state");
  const bare = await folder("shadow");
  git(bare, "init", "-q", "--bare");
  gitAs(work, "push", "-q", bare, "HEAD:refs/tau/server");
  return bare;
}

async function place(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

describe("repo-from-tree", () => {
  it("makes the first commit from the tree and leaves the working tree as it was", async () => {
    const server = { "index.php": "<?php echo 1;\n", "lib/a.php": "a\n", "bin/run": "#!/bin/sh\n" };
    const mirror = await shadow(server, ["bin/run"]);
    const project = await folder("project");
    await place(project, { ...server, "index.php": "<?php echo 2;\n", ".gitignore": "/uploads/\n" });
    await chmod(join(project, "bin/run"), 0o755);
    await mkdir(join(project, "uploads"));
    await writeFile(join(project, "uploads", "big.jpg"), "jpg");
    const stamp = new Date("2020-01-02T03:04:05Z");
    await utimes(join(project, "index.php"), stamp, stamp);

    const result = await repoFromTree({
      path: project,
      trees: [{ gitDir: mirror, ref: "refs/tau/server", prefix: "" }],
      files: [".gitignore"],
      exclude: ["/.vscode/sftp.json"],
      message: "Server state fake:/site 2026-09-25",
    });

    expect(result).toMatchObject({ branch: "main", files: 4 });
    expect(git(project, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(project, "log", "-1", "--format=%s%n%an")).toBe("Server state fake:/site 2026-09-25\nTau");
    expect(git(project, "ls-tree", "-r", "--name-only", "HEAD").split("\n").sort()).toEqual([".gitignore", "bin/run", "index.php", "lib/a.php"]);
    expect(git(project, "ls-tree", "HEAD", "bin/run")).toMatch(/^100755 /u);
    // Only the local deviation shows; the ignored folder does not.
    expect(git(project, "status", "--porcelain")).toBe("M index.php");
    expect(await readFile(join(project, "index.php"), "utf8")).toBe("<?php echo 2;\n");
    expect((await stat(join(project, "index.php"))).mtime.getTime()).toBe(stamp.getTime());
    expect(await readFile(join(project, ".git", "info", "exclude"), "utf8")).toMatch(/\/\.vscode\/sftp\.json\n$/u);
    expect(git(project, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  });

  it("puts each tree under its folder", async () => {
    const top = await shadow({ "index.php": "top\n" });
    const app = await shadow({ "main.py": "app\n" });
    const project = await folder("project");
    await place(project, { "index.php": "top\n", "app/main.py": "app\n" });
    await repoFromTree({
      path: project,
      trees: [{ gitDir: app, ref: "refs/tau/server", prefix: "app" }, { gitDir: top, ref: "refs/tau/server", prefix: "" }],
      files: [],
      exclude: [],
      message: "Server state",
    });
    expect(git(project, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).toEqual(["app/main.py", "index.php"]);
    expect(git(project, "status", "--porcelain")).toBe("");
  });

  it("refuses a folder that has Git and removes the repository it could not finish", async () => {
    const mirror = await shadow({ "a.txt": "a\n" });
    const withGit = await folder("with-git");
    git(withGit, "init", "-q");
    await expect(repoFromTree({ path: withGit, trees: [{ gitDir: mirror, ref: "refs/tau/server", prefix: "" }], files: [], exclude: [], message: "m" }))
      .rejects.toThrow("already has a Git repository");

    const project = await folder("project");
    await expect(repoFromTree({ path: project, trees: [{ gitDir: mirror, ref: "refs/tau/missing", prefix: "" }], files: [], exclude: [], message: "m" }))
      .rejects.toThrow(/rev-parse/u);
    await expect(stat(join(project, ".git"))).rejects.toThrow();
  });

  it("reads its input strictly", () => {
    expect(() => decodeRepoFromTree({ trees: [], message: "m" })).toThrow("Name the tree");
    expect(() => decodeRepoFromTree({ trees: [{ gitDir: "/x", ref: "HEAD" }], message: "m" })).toThrow("ref under refs/");
    expect(() => decodeRepoFromTree({ trees: [{ gitDir: "/x", ref: "refs/a", prefix: "../out" }], message: "m" })).toThrow("no folder inside");
    expect(() => decodeRepoFromTree({ trees: [{ gitDir: "/x", ref: "refs/a" }], files: [".git/config"], message: "m" })).toThrow("inside the project");
    expect(() => decodeRepoFromTree({ trees: [{ gitDir: "/x", ref: "refs/a" }, { gitDir: "/y", ref: "refs/a", prefix: "/" }], message: "m" })).toThrow("Two trees");
    expect(decodeRepoFromTree({ trees: [{ gitDir: "/x", ref: "refs/a", prefix: "/app/" }], exclude: ["ok", "two\nlines"], message: "m" }))
      .toEqual({ trees: [{ gitDir: "/x", ref: "refs/a", prefix: "app" }], files: [], exclude: ["ok"], message: "m" });
  });
});

describe("the command", () => {
  async function registryWith(project: string) {
    const services: Partial<HostExtensionServices> = {
      knownWorkspacePath: async (path) => path,
      workspaceRef: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
      describeProjects: () => () => undefined,
      registerTurnObserver: () => () => undefined,
      registerThreadLifecycle: () => () => undefined,
      pinTranscriptEntries: () => () => undefined,
      registerRuntimeExtension: () => () => undefined,
      noteSubprocess: () => undefined,
      cwd: () => project,
    };
    const registry = await activateHostKit(createWorkspaceHostExtension(), services);
    const callers = new Map<string, HostExtensionContext>();
    for (const id of ["tau.servers", "tau.other"]) {
      await registry.activate({ id, name: id, permissions: [], activate(context) { callers.set(id, context); } });
    }
    return callers;
  }

  it("answers Servers Kit and no other kit", async () => {
    const mirror = await shadow({ "a.txt": "a\n" });
    const project = await folder("project");
    await place(project, { "a.txt": "a\n" });
    const callers = await registryWith(project);
    const input = { path: project, trees: [{ gitDir: mirror, ref: "refs/tau/server" }], message: "Server state" };
    await expect(callers.get("tau.other")!.invokeHostExtension("tau.workspace", "repo-from-tree", input)).rejects.toThrow();
    await expect(stat(join(project, ".git"))).rejects.toThrow();
    await expect(callers.get("tau.servers")!.invokeHostExtension("tau.workspace", "repo-from-tree", input))
      .resolves.toMatchObject({ branch: "main", files: 1, workspace: { workspaceId: `ws1_${project}` } });
  });
});
