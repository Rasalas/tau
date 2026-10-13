import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGitCommand } from "./workspace-git.js";

const execute = vi.hoisted(() => vi.fn(async () => ({ stdout: "output", stderr: "" })));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});

describe("workspace Git command timeouts", () => {
  beforeEach(() => execute.mockClear());

  it.each([
    ["commit", "-m", "change"],
    ["pull", "--ff-only"],
    ["push"],
    ["push", "--set-upstream", "origin", "HEAD:refs/heads/topic"],
    ["clean", "-fd", "--"],
    ["read-tree", "--reset", "-u", "target-tree"],
    ["read-tree", "--reset", "-u", "rollback-tree"],
  ])("does not time out %j", async (...args) => {
    expect(await runGitCommand("/workspace", args)).toBe("output");
    expect(execute).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ timeout: 0 }));
  });

  it.each([
    ["worktree", "add", "-b", "topic", "/worktree", "HEAD"],
    ["worktree", "add", "/worktree", "topic"],
    ["worktree", "remove", "--force", "/worktree"],
  ])("allows five minutes for %j", async (...args) => {
    await runGitCommand("/workspace", args);
    expect(execute).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ timeout: 300_000 }));
  });

  it.each([
    ["status", "--porcelain"],
    ["diff", "--cached", "--name-only"],
    ["rev-parse", "HEAD"],
    ["worktree", "list", "--porcelain"],
  ])("keeps the ten-second limit for %j", async (...args) => {
    await runGitCommand("/workspace", args);
    expect(execute).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ timeout: 10_000 }));
  });

  it("preserves explicit timeouts and cancellation signals", async () => {
    const signal = new AbortController().signal;
    const env = { GIT_INDEX_FILE: "/scratch/index" };
    await runGitCommand("/workspace", ["commit", "-m", "change"], 1024, signal, env, 60_000);
    expect(execute).toHaveBeenCalledWith(expect.any(String), ["-c", "core.quotePath=false", "commit", "-m", "change"], expect.objectContaining({
      cwd: "/workspace", maxBuffer: 1024, signal, env, timeout: 60_000,
    }));
  });
});
