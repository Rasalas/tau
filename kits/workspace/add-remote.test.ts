import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addFirstRemote } from "./workspace-git.js";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Tau", ...args], { cwd, stdio: "pipe" }).toString().trim();
let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "tau-add-remote-"));
  git(repo, "init", "-q", "-b", "main");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("the first remote of a published repository", () => {
  it("adds origin and says whether there is a commit to push", async () => {
    await expect(addFirstRemote(repo, "origin", "https://example.com/acme/app.git")).resolves.toEqual({ hasCommits: false });
    expect(git(repo, "remote", "get-url", "origin")).toBe("https://example.com/acme/app.git");
    git(repo, "remote", "remove", "origin");
    await writeFile(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    await expect(addFirstRemote(repo, "origin", "git@example.com:acme/app.git")).resolves.toEqual({ hasCommits: true });
  });

  it("never replaces or joins an existing remote, and refuses what reads as an option", async () => {
    git(repo, "remote", "add", "upstream", "https://example.com/other.git");
    await expect(addFirstRemote(repo, "origin", "https://example.com/acme/app.git")).rejects.toThrow(/already has a remote \(upstream\)/u);
    expect(git(repo, "remote")).toBe("upstream");
    await expect(addFirstRemote(repo, "--mirror", "x")).rejects.toThrow(/not a remote name/u);
    await expect(addFirstRemote(repo, "origin", "--upload-pack=touch /tmp/x")).rejects.toThrow(/not a remote URL/u);
  });
});
