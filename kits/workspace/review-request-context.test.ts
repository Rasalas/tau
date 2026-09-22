import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readReviewRequestContext } from "./review-request-context.js";

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
    expect(context.commits).toEqual([{ subject: "feat: add the feature", body: "It explains itself." }]);
    expect(context.diffStat).toContain("feature.txt");
    expect(context.template).toBe("## Summary\n\n## Testing");
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
