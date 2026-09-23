import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultBranchPuller, fastForwardDefaultBranch, type FastForwardOutcome } from "./default-branch-pull.js";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Tau", ...args], { cwd, stdio: "pipe" }).toString().trim();

let root: string;
let checkout: string;
let other: string;

async function commitIn(cwd: string, file: string, text: string): Promise<string> {
  await writeFile(join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", `change ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

/** Another clone moves `main` on the bare "remote"; `checkout` is the one kept current. */
async function remoteMoves(): Promise<string> {
  const head = await commitIn(other, `remote-${Date.now()}-${Math.random()}.txt`, "upstream\n");
  git(other, "push", "-q", "origin", "main");
  return head;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tau-auto-pull-"));
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", "seed");
  await commitIn(seed, "readme.txt", "hello\n");
  git(root, "clone", "-q", "--bare", seed, "origin.git");
  git(root, "clone", "-q", join(root, "origin.git"), "checkout");
  git(root, "clone", "-q", join(root, "origin.git"), "other");
  checkout = join(root, "checkout");
  other = join(root, "other");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("fast-forwarding the default branch", () => {
  it("fast-forwards a clean checkout of the default branch to its upstream", async () => {
    const target = await remoteMoves();
    const outcome = await fastForwardDefaultBranch(checkout);
    expect(outcome).toEqual({ status: "pulled", branch: "main", upstream: "origin/main", commits: 1, head: target });
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target);
    // A fast-forward leaves no merge commit behind.
    expect(git(checkout, "rev-list", "--merges", "--count", "HEAD")).toBe("0");
  });

  it("refuses a checkout with a changed or an untracked file and leaves it as it was", async () => {
    await remoteMoves();
    const before = git(checkout, "rev-parse", "HEAD");
    await writeFile(join(checkout, "scratch.txt"), "mine\n");
    expect(await fastForwardDefaultBranch(checkout)).toEqual({ status: "skipped", reason: "dirty" });
    await rm(join(checkout, "scratch.txt"));
    await writeFile(join(checkout, "readme.txt"), "edited\n");
    expect(await fastForwardDefaultBranch(checkout)).toEqual({ status: "skipped", reason: "dirty" });
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before);
    expect(git(checkout, "status", "--porcelain")).toBe("M readme.txt");
  });

  it("refuses a diverged checkout: no merge, no rebase, no reset", async () => {
    await remoteMoves();
    const local = await commitIn(checkout, "local.txt", "local\n");
    const outcome = await fastForwardDefaultBranch(checkout);
    expect(outcome).toMatchObject({ status: "skipped", reason: "local-commits" });
    expect(git(checkout, "rev-parse", "HEAD")).toBe(local);
    expect(git(checkout, "rev-list", "--count", "HEAD")).toBe("2");
  });

  it("leaves another branch, a branch without upstream and a detached HEAD alone", async () => {
    await remoteMoves();
    git(checkout, "switch", "-q", "-c", "feature");
    expect(await fastForwardDefaultBranch(checkout)).toMatchObject({ status: "skipped", reason: "not-default-branch" });
    git(checkout, "switch", "-q", "main");
    git(checkout, "branch", "--unset-upstream");
    expect(await fastForwardDefaultBranch(checkout)).toEqual({ status: "skipped", reason: "no-upstream" });
    git(checkout, "switch", "-q", "--detach");
    expect(await fastForwardDefaultBranch(checkout)).toEqual({ status: "skipped", reason: "detached" });
  });

  it("says a current checkout is up to date and a folder that is no repository is none", async () => {
    expect(await fastForwardDefaultBranch(checkout)).toEqual({ status: "skipped", reason: "up-to-date" });
    const plain = await mkdtemp(join(tmpdir(), "tau-auto-pull-plain-"));
    try {
      expect(await fastForwardDefaultBranch(plain)).toEqual({ status: "skipped", reason: "not-a-repository" });
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe("DefaultBranchPuller", () => {
  it("runs one attempt per checkout at a time and waits a minute before the next", async () => {
    let now = 0;
    let calls = 0;
    let finish: (outcome: FastForwardOutcome) => void = () => undefined;
    const puller = new DefaultBranchPuller(() => { calls += 1; return new Promise((resolve) => { finish = resolve; }); }, () => now);
    const first = puller.run("/repo");
    const second = puller.run("/repo");
    expect(second).toBe(first);
    finish({ status: "skipped", reason: "up-to-date" });
    await first;
    now = 30_000;
    expect(await puller.run("/repo")).toEqual({ status: "skipped", reason: "recently-checked" });
    now = 61_000;
    const third = puller.run("/repo");
    finish({ status: "skipped", reason: "up-to-date" });
    await third;
    expect(calls).toBe(2);
  });
});
