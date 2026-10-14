import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readReviewRequestContext } from "./review-request-context.js";
import { createWorktree } from "./workspace-git.js";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=Tau", "-c", "user.email=tau@example.com", ...args], { cwd });
const folders: string[] = [];

async function repositoryWithRemote(): Promise<{ work: string; remote: string }> {
  const root = await mkdtemp(join(tmpdir(), "tau-request-context-"));
  folders.push(root);
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  await run("git", ["init", "--bare", "-b", "main", remote]);
  await mkdir(work);
  await git(work, "init", "-b", "main");
  await mkdir(join(work, ".github"));
  await writeFile(join(work, ".github", "pull_request_template.md"), "## Summary\n\n## Testing\n");
  await writeFile(join(work, "README.md"), "hello\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-m", "chore: start");
  await git(work, "remote", "add", "origin", remote);
  await git(work, "push", "-u", "origin", "main");
  await git(work, "remote", "set-head", "origin", "main");
  await git(work, "switch", "-c", "feature/pr");
  await writeFile(join(work, "feature.txt"), "one\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-m", "feat: add the feature", "-m", "It explains itself.");
  return { work, remote };
}

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("review request context", () => {
  it("names the branch, remote and base, and without an upstream reports none", async () => {
    const { work, remote } = await repositoryWithRemote();
    const context = await readReviewRequestContext(work);
    expect(context).toMatchObject({ branch: "feature/pr", remote: { name: "origin", url: remote }, base: "main" });
    expect(context.upstream).toBeUndefined();
    expect(context.commits).toBeUndefined();
  });

  it("adds the commits since the base, a diff stat and the template from the base tree", async () => {
    const { work } = await repositoryWithRemote();
    await git(work, "push", "-u", "origin", "feature/pr");
    const context = await readReviewRequestContext(work, { detail: true });
    expect(context).toMatchObject({ upstream: "origin/feature/pr", ahead: 0 });
    expect(context.commits).toEqual([{ subject: "feat: add the feature", body: "It explains itself.", sha: expect.stringMatching(/^[0-9a-f]{40}$/u), at: expect.any(Number), author: "Tau" }]);
    expect(context.forkedAt).toBeLessThanOrEqual(context.commits![0]!.at!);
    expect(context.diffStat).toContain("feature.txt");
    expect(context.template).toBe("## Summary\n\n## Testing");
  });

  it.each(["local", "remote"])("uses a worktree's saved %s start branch for a new request and its description", async (location) => {
    const { work } = await repositoryWithRemote();
    await git(work, "switch", "-c", "release/v2", "main");
    await writeFile(join(work, ".github", "pull_request_template.md"), "## Release testing\n");
    await git(work, "add", "-A");
    await git(work, "commit", "-m", "chore: prepare release");
    await git(work, "push", "origin", "release/v2");
    await git(work, "switch", "main");
    const tree = await createWorktree(work, "feature/release", { baseRef: "origin/release/v2" }, async () => ({
      root: work, isRepo: true, isDirty: false, branch: "main", hasRemote: true,
      worktrees: [], refs: [], worktreeParent: join(work, "..", "worktrees"),
    }));
    if (location === "local") await git(work, "update-ref", "-d", "refs/remotes/origin/release/v2");
    else await git(work, "branch", "-D", "release/v2");
    await writeFile(join(tree, "fix.txt"), "release fix\n");
    await git(tree, "add", "-A");
    await git(tree, "commit", "-m", "fix: repair release");

    expect((await readReviewRequestContext(tree, { base: "" })).base).toBe("release/v2");
    const context = await readReviewRequestContext(tree, { detail: true });
    expect(context.base).toBe("release/v2");
    expect(context.commits?.map(({ subject }) => subject)).toEqual(["fix: repair release"]);
    expect(context.template).toBe("## Release testing");
    expect(context.diffStat).toContain("fix.txt");
    expect(context.diffStat).not.toContain("pull_request_template.md");
    expect((await readReviewRequestContext(tree, { base: "origin/main" })).base).toBe("main");
  });

  it.each(["missing", "tag"])("falls back to the default branch when the saved target is a %s", async (kind) => {
    const { work } = await repositoryWithRemote();
    await git(work, "config", "branch.feature/pr.tau-review-target", "release/v2");
    if (kind === "tag") await git(work, "tag", "release/v2");
    expect((await readReviewRequestContext(work)).base).toBe("main");
  });

  it("reads the template folders of Forgejo, Gitea and Azure DevOps", async () => {
    for (const path of [".gitea/pull_request_template.md", ".forgejo/PULL_REQUEST_TEMPLATE.md", ".azuredevops/pull_request_template.md"]) {
      const { work } = await repositoryWithRemote();
      await git(work, "switch", "main");
      await rm(join(work, ".github"), { recursive: true });
      await mkdir(join(work, path.split("/")[0]!));
      await writeFile(join(work, path), `## From ${path}\n`);
      await git(work, "add", "-A");
      await git(work, "commit", "-m", "chore: move the template");
      await git(work, "push");
      await git(work, "switch", "feature/pr");
      expect((await readReviewRequestContext(work, { detail: true })).template).toBe(`## From ${path}`);
    }
  });

  it("ignores a template that is a symlink in the base tree", async () => {
    const { work } = await repositoryWithRemote();
    await git(work, "switch", "main");
    await rm(join(work, ".github", "pull_request_template.md"));
    await symlink("/etc/hosts", join(work, ".github", "pull_request_template.md"));
    await git(work, "add", "-A");
    await git(work, "commit", "-m", "chore: link");
    await git(work, "push");
    await git(work, "switch", "feature/pr");
    const context = await readReviewRequestContext(work, { detail: true });
    expect(context.template).toBeUndefined();
  });
});
