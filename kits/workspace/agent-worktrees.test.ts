import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentBranchName,
  applyAgentWorktree,
  createAgentWorktree,
  latestCheckpointSnapshotRef,
  readAgentWorktreeChanges,
  removeAgentWorktree,
  worktreeSetupCommand,
} from "./agent-worktrees.js";
import { TURN_CHECKPOINT_CUSTOM_TYPE } from "./turn-checkpoint-codec.js";

const created: string[] = [];

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tau-agent-worktree-"));
  created.push(root);
  const cwd = join(root, "project");
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  execFileSync("mkdir", ["-p", cwd]);
  execFileSync("git", ["init", "-q", "-b", "main", cwd]);
  git("config", "user.email", "tau@example.com");
  git("config", "user.name", "Tau");
  await writeFile(join(cwd, "README.md"), "start\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  return cwd;
}

afterEach(async () => {
  for (const root of created.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("a spawned thread's worktree", () => {
  it("starts from the parent's checkpoint tree, and from HEAD without one", async () => {
    const parent = await repository();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: parent, stdio: "pipe" }).toString();
    // A checkpoint ref is a tree of the parent's working copy, uncommitted work included.
    await writeFile(join(parent, "draft.txt"), "work in progress\n");
    git("add", "-A");
    const tree = git("write-tree").trim();
    git("update-ref", "refs/tau/checkpoints/session/turn/after", tree);
    git("reset", "-q");

    const worktree = await createAgentWorktree({
      parentCwd: parent,
      agentId: "abcdef1234",
      snapshotRef: "refs/tau/checkpoints/session/turn/after",
    });

    expect(worktree.branch).toBe(agentBranchName("abcdef1234"));
    expect(worktree.fromCheckpoint).toBe(true);
    // The parent's uncommitted file is there, because the child continues its work.
    await expect(readFile(join(worktree.path, "draft.txt"), "utf8")).resolves.toBe("work in progress\n");

    const plain = await createAgentWorktree({ parentCwd: parent, agentId: "99999999" });
    expect(plain.fromCheckpoint).toBe(false);
    expect(plain.baseCommit).toBe(git("rev-parse", "--verify", "HEAD").trim());
  });

  it("reports what the child changed and applies it to the parent", async () => {
    const parent = await repository();
    const worktree = await createAgentWorktree({ parentCwd: parent, agentId: "11111111" });
    await writeFile(join(worktree.path, "answer.md"), "the child wrote this\n");

    const changes = await readAgentWorktreeChanges(worktree);
    expect(changes).toMatchObject({ files: 1, added: 1, removed: 0, commits: 0, uncommitted: 1 });
    expect(changes.paths).toEqual(["answer.md"]);

    const applied = await applyAgentWorktree({ parentCwd: parent, worktree });
    expect(applied.strategy).toBe("patch");
    await expect(readFile(join(parent, "answer.md"), "utf8")).resolves.toBe("the child wrote this\n");

    await removeAgentWorktree({ parentCwd: parent, worktree });
    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: parent }).toString();
    expect(worktrees).not.toContain(worktree.path);
    expect(execFileSync("git", ["branch", "--list"], { cwd: parent }).toString()).not.toContain(worktree.branch);
  });

  it("merges a child that committed, and refuses a patch that collides", async () => {
    const parent = await repository();
    const committed = await createAgentWorktree({ parentCwd: parent, agentId: "22222222" });
    await writeFile(join(committed.path, "feature.txt"), "done\n");
    execFileSync("git", ["add", "-A"], { cwd: committed.path });
    execFileSync("git", ["commit", "-qm", "feature"], { cwd: committed.path });

    const merged = await applyAgentWorktree({ parentCwd: parent, worktree: committed });
    expect(merged.strategy).toBe("merge");
    await expect(readFile(join(parent, "feature.txt"), "utf8")).resolves.toBe("done\n");

    // The parent changed the same line the child changed: nothing is applied.
    const colliding = await createAgentWorktree({ parentCwd: parent, agentId: "33333333" });
    await writeFile(join(colliding.path, "README.md"), "child version\n");
    await writeFile(join(parent, "README.md"), "parent version\n");
    await expect(applyAgentWorktree({ parentCwd: parent, worktree: colliding }))
      .rejects.toThrow(/do not apply to this checkout/u);
    await expect(readFile(join(parent, "README.md"), "utf8")).resolves.toBe("parent version\n");
  });

  it("finds the newest checkpoint ref a session recorded", () => {
    const entry = (afterSnapshotId: string) => ({ type: "custom", customType: TURN_CHECKPOINT_CUSTOM_TYPE, data: { afterSnapshotId } });
    expect(latestCheckpointSnapshotRef([
      entry("refs/tau/checkpoints/s/1/after"),
      { type: "message" },
      entry("refs/tau/checkpoints/s/2/after"),
    ])).toBe("refs/tau/checkpoints/s/2/after");
    expect(latestCheckpointSnapshotRef([{ type: "custom", customType: "other", data: {} }])).toBeUndefined();
    // A ref outside the checkpoint namespace is never taken from an entry.
    expect(latestCheckpointSnapshotRef([entry("refs/heads/main")])).toBeUndefined();
  });
});

describe("worktreeSetupCommand", () => {
  it("runs the setup line in a POSIX login shell", () => {
    expect(worktreeSetupCommand("npm ci && npm run build", "darwin")).toEqual({ command: "/bin/sh", args: ["-lc", "npm ci && npm run build"] });
  });

  it("runs it through cmd.exe on Windows, where there is no /bin/sh", () => {
    expect(worktreeSetupCommand("npm ci && npm run build", "win32", { ComSpec: "C:\\Windows\\system32\\cmd.exe" })).toEqual({
      command: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", "\"npm ci && npm run build\""],
      windowsVerbatimArguments: true,
    });
    expect(worktreeSetupCommand("x", "win32", {}).command).toBe("cmd.exe");
  });
});
