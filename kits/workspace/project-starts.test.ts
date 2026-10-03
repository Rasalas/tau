import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNamedProject, createScratchWorkspace, isScratchWorkspace, projectFolderName } from "./project-starts";
const roots: string[] = [];
async function fixture() { const path = await mkdtemp(join(tmpdir(), "tau-project-starts-")); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
describe("project starts", () => {
  it("gives each thread its own durable private workspace", async () => {
    const root = await fixture();
    const a = await createScratchWorkspace(root), b = await createScratchWorkspace(root);
    expect(a).not.toBe(b);
    await writeFile(join(a, "notes.txt"), "saved work");
    expect(isScratchWorkspace(root, a)).toBe(true);
    expect(isScratchWorkspace(root, b)).toBe(true);
    expect(isScratchWorkspace(root, join(root, "scratch", ".."))).toBe(false);
    expect(isScratchWorkspace(root, root)).toBe(false);
    expect(await readFile(join(a, "notes.txt"), "utf8")).toBe("saved work");
    expect((await stat(a)).mode & 0o777).toBe(0o700);
  });
  it("recognizes canonical allocations through symlinked host storage", async () => {
    const root = await fixture();
    const alias = join(root, "alias");
    await symlink(root, alias);
    const scratch = await createScratchWorkspace(alias);
    expect(isScratchWorkspace(alias, scratch)).toBe(true);
    expect(isScratchWorkspace(root, scratch)).toBe(true);
  });
  it("refuses scratch roots that inherit a repository", async () => {
    const root = await fixture();
    await promisify(execFile)("git", ["init", "--quiet", root]);
    await expect(createScratchWorkspace(join(root, "host-data"))).rejects.toThrow("inside a Git repository");
  });
  it.each(["", "../other", "a/b", "a\\b", "NUL", "COM1.txt", "trail.", "bad\u0000name"])("refuses unsafe folder name %j", (name) => {
    expect(() => projectFolderName(name)).toThrow();
  });
  it("creates a real first commit with the README and portable icon", async () => {
    const root = await fixture();
    const git = join(root, "fixture-git");
    await writeFile(git, '#!/bin/sh\nexec git -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false "$@"\n');
    await chmod(git, 0o700);
    const created = await createNamedProject(root, "Quiet Lake", git);
    expect(created.warning).toBeUndefined();
    const result = await promisify(execFile)(git, ["ls-tree", "--name-only", "HEAD"], { cwd: created.path });
    expect(result.stdout.trim().split("\n")).toEqual(["README.md", "project-icon.svg", "t3.json"]);
  });
  it("keeps the initialized repository when the commit identity is missing", async () => {
    const root = await fixture();
    const git = join(root, "git-without-identity");
    await writeFile(git, '#!/bin/sh\nexec git -c user.name= -c user.email= -c commit.gpgsign=false "$@"\n');
    await chmod(git, 0o700);
    const created = await createNamedProject(root, "Uncommitted Project", git);
    expect(created.warning).toContain("Project created");
    expect((await stat(join(created.path, ".git"))).isDirectory()).toBe(true);
    await expect(promisify(execFile)(git, ["rev-parse", "--verify", "HEAD"], { cwd: created.path })).rejects.toThrow();
    expect(await readFile(join(created.path, "README.md"), "utf8")).toBe("# Uncommitted Project\n");
  });
  it("keeps a usable project when Git setup fails and never overwrites a collision", async () => {
    const root = await fixture();
    const created = await createNamedProject(root, "Garden Notes", "/missing/git");
    expect(created.warning).toContain("Project created");
    expect(await readFile(join(created.path, "README.md"), "utf8")).toBe("# Garden Notes\n");
    expect(JSON.parse(await readFile(join(created.path, "t3.json"), "utf8"))).toEqual({ iconPath: "project-icon.svg" });
    expect(await readFile(join(created.path, "project-icon.svg"), "utf8")).toContain(">GA</text>");
    await expect(createNamedProject(root, "Garden Notes", "/missing/git")).rejects.toThrow();
    expect(await readFile(join(created.path, "README.md"), "utf8")).toBe("# Garden Notes\n");
  });
});
