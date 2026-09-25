import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRunner } from "./git.js";
import { REPO_KEY, normalizeOriginUrl, readRepoIdentity, repoKeyOf, shareableOrigin } from "./identity.js";

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("a project's identity across machines", () => {
  it.each([
    ["git@github.com:Acme/App.git", "github.com/acme/app"],
    ["https://github.com/acme/app", "github.com/acme/app"],
    ["https://user:token@GitHub.com/acme/app.git/", "github.com/acme/app"],
    ["ssh://git@github.com:22/acme/app.git", "github.com/acme/app"],
    ["ssh://git@gitlab.example.com:2222/group/sub/app.git", "gitlab.example.com/group/sub/app"],
    ["file:///srv/Repos/App.git", "file/srv/Repos/App"],
    ["/srv/Repos/App.git", "file/srv/Repos/App"],
  ])("reads %s as %s", (url, normalized) => {
    expect(normalizeOriginUrl(url)).toBe(normalized);
  });

  it("has no identity for what is not a remote", () => {
    for (const url of ["", "relative/path", "https://"]) expect(normalizeOriginUrl(url)).toBeUndefined();
  });

  it("makes a folder-safe key that keeps the end readable and the whole unique", () => {
    const key = repoKeyOf("github.com/acme/app");
    expect(key).toMatch(/^github\.com-acme-app-[0-9a-f]{10}$/u);
    expect(REPO_KEY.test(key)).toBe(true);
    expect(repoKeyOf("github.com/acme/app")).toBe(key);
    expect(repoKeyOf("github.com/other/app")).not.toBe(key);
    expect(REPO_KEY.test(repoKeyOf(`file/${"deep/".repeat(40)}x`))).toBe(true);
    // A CI checkout under /actions-runner/_work/…: cut to its end, the key began with "_" and rex refused it.
    expect(REPO_KEY.test(repoKeyOf("file/actions-runner/_work/tau/tau/.tau-dev/remote-work/smoke/origin"))).toBe(true);
  });

  it("sends origin without an https user or password, and an ssh URL without its password", () => {
    expect(shareableOrigin("https://user:token@github.com/acme/app.git")).toBe("https://github.com/acme/app.git");
    expect(shareableOrigin("ssh://git:secret@host/acme/app.git")).toBe("ssh://git@host/acme/app.git");
    expect(shareableOrigin("git@github.com:acme/app.git")).toBe("git@github.com:acme/app.git");
  });

  it("reads origin first, the oldest root commit without one, and refuses a repository without a commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-identity-"));
    created.push(dir);
    const cwd = join(dir, "My Project");
    await mkdir(join(cwd, "src"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
    git("init", "-q", "-b", "main");
    const runner = createGitRunner();
    await expect(readRepoIdentity(cwd, runner)).rejects.toThrow(/no commit yet/u);

    await writeFile(join(cwd, "a.txt"), "a\n");
    git("add", "-A");
    git("-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "first");
    const root = git("rev-parse", "HEAD");
    const byRoot = await readRepoIdentity(join(cwd, "src"), runner);
    expect(byRoot).toMatchObject({ key: `root-${root.slice(0, 16)}`, name: "My-Project", source: "root-commit" });
    expect(byRoot.origin).toBeUndefined();

    git("remote", "add", "origin", "https://user:token@github.com/acme/app.git");
    expect(await readRepoIdentity(cwd, runner)).toMatchObject({ key: repoKeyOf("github.com/acme/app"), origin: "https://github.com/acme/app.git", source: "origin" });
  });
});
