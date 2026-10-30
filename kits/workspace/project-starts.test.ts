import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNamedProject, createScratchWorkspace, isScratchWorkspace, projectFolderName, publishNewProject } from "./project-starts";
import { githubRepositoryPath, readNewProjectGithub } from "./project-github";
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

describe("a new project's GitHub repository", () => {
  const project = { workspace: "ws1_new", name: "Quiet Lake" };
  it("names the repository as GitHub would and reads only a sane choice", () => {
    expect(githubRepositoryPath("Quiet Lake")).toBe("Quiet-Lake");
    expect(githubRepositoryPath("  my app (v2)! ", "acme")).toBe("acme/my-app-v2");
    expect(githubRepositoryPath("日本")).toBeUndefined();
    expect(readNewProjectGithub(undefined)).toBeUndefined();
    expect(readNewProjectGithub({})).toEqual({ visibility: "private" });
    expect(readNewProjectGithub({ owner: " acme ", visibility: "public" })).toEqual({ owner: "acme", visibility: "public" });
    for (const owner of ["-x", "a--b", "a/b", "x-"]) expect(() => readNewProjectGithub({ owner })).toThrow(/not a GitHub/u);
  });
  it("asks Review to create and push it, and reports what GitHub made", async () => {
    const publish = vi.fn(async () => ({ repository: "octo/Quiet-Lake", url: "https://github.com/octo/Quiet-Lake", remote: "https://github.com/octo/Quiet-Lake.git", pushed: true, branch: "main" }));
    await expect(publishNewProject(publish, project, { visibility: "private" })).resolves.toEqual({ github: { repository: "octo/Quiet-Lake", url: "https://github.com/octo/Quiet-Lake", pushed: true, branch: "main" } });
    expect(publish).toHaveBeenCalledWith({ workspace: "ws1_new", service: "github", repository: "Quiet-Lake", visibility: "private", confirm: true });
  });
  it.each([
    ["gh is missing", "GitHub CLI (gh) is not installed or not on your PATH."],
    ["gh is signed out", "GitHub CLI (gh) is not signed in. Run `gh auth login` in a terminal, then try again."],
    ["the name is taken", "A repository named acme/Quiet-Lake already exists on GitHub. Choose another name, or add the existing one as origin by hand."],
  ])("keeps the project with an actionable warning when %s", async (_case, problem) => {
    const answer = await publishNewProject(async () => { throw new Error(problem); }, project, { owner: "acme", visibility: "private" });
    expect(answer).toEqual({ warning: `Project created, but not its GitHub repository: ${problem} Publish it later with "Publish repository…" in the Changes panel.` });
  });
  it("keeps the repository and says why when the first push fails", async () => {
    const answer = await publishNewProject(async () => ({ repository: "octo/Quiet-Lake", url: "u", remote: "r", pushed: false, branch: "main", pushProblem: "SSH authentication was rejected. Add an SSH key to your account, then push again." }), project, { visibility: "private" });
    expect(answer.github).toMatchObject({ repository: "octo/Quiet-Lake", pushed: false });
    expect(answer.warning).toBe("Created octo/Quiet-Lake on GitHub and added it as origin, but the first push failed. SSH authentication was rejected. Add an SSH key to your account, then push again.");
  });
  it("asks nothing of GitHub without a first commit or a usable name", async () => {
    const publish = vi.fn(async () => ({}));
    const unborn = await publishNewProject(publish, { ...project, warning: "Project created. Git setup could not finish; check Git and your commit identity." }, { visibility: "private" });
    expect(unborn.warning).toMatch(/^Project created\. Git setup could not finish.*Its GitHub repository was not created; publish it with "Publish repository…" in the Changes panel once Git works\.$/u);
    expect((await publishNewProject(publish, { ...project, name: "日本" }, { visibility: "private" })).warning).toMatch(/letters or digits/u);
    expect(publish).not.toHaveBeenCalled();
  });
});
