import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitCoordinator } from "./git-coordinator.js";
import { readProjectGitState } from "./workspace-git.js";

function fakeGit(overrides: Record<string, string> = {}, delay = 0) {
  const calls: string[][] = [];
  const run = async (_cwd: string, args: string[], _maxBuffer?: number, signal?: AbortSignal) => {
    calls.push(args);
    if (delay) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
    });
    const key = args.join(" ");
    if (key in overrides) return overrides[key];
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/project";
    if (args[0] === "rev-parse") return "main\n";
    if (args[0] === "status") return " M src/index.ts\0?? notes.txt\0";
    if (args[0] === "diff") return "2\t1\tsrc/index.ts\0";
    if (args[0] === "worktree") return "worktree /project\nbranch refs/heads/main\n";
    return "main\n";
  };
  return { run, calls };
}

describe("GitCoordinator", () => {
  it("shares a bundled, versioned scan between status, workspace, and branch readers", async () => {
    const fake = fakeGit();
    const coordinator = new GitCoordinator({ runGit: fake.run, cacheTtlMs: 10_000 });
    const [changes, workspace, branch] = await Promise.all([
      coordinator.getChanges("/project"),
      coordinator.getWorkspaceInfo("/project"),
      coordinator.getBranch("/project"),
    ]);

    expect(branch).toBe("main");
    expect(changes.files.map((file) => file.path)).toEqual(["notes.txt", "src/index.ts"]);
    expect(workspace.isRepo).toBe(true);
    expect(fake.calls).toHaveLength(6);
    expect(coordinator.metrics().maxParallelSubprocesses).toBeLessThanOrEqual(4);
  });

  it("does not let an invalidated older scan overwrite a newer result", async () => {
    let releaseFirst: (() => void) | undefined;
    let scan = 0;
    const run = async (_cwd: string, args: string[], _maxBuffer?: number, signal?: AbortSignal) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        scan += 1;
        if (scan === 1) await new Promise<void>((resolve, reject) => {
          releaseFirst = resolve;
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/project";
      if (args[0] === "rev-parse") return scan === 1 ? "old\n" : "new\n";
      if (args[0] === "status") return "";
      if (args[0] === "diff") return "";
      if (args[0] === "worktree") return "worktree /project\nbranch refs/heads/main\n";
      return "main\n";
    };
    const coordinator = new GitCoordinator({ runGit: run, timeoutMs: 5_000 });
    const old = coordinator.getBranch("/project");
    await new Promise((resolve) => setTimeout(resolve, 0));
    coordinator.invalidate("/project", ["branch"]);
    const current = await coordinator.getBranch("/project");
    releaseFirst?.();
    await old;
    expect(current).toBe("new");
    expect(await coordinator.getBranch("/project")).toBe("new");
  });

  it("keeps the last valid state when a refresh times out", async () => {
    let fail = false;
    const fake = fakeGit();
    const coordinator = new GitCoordinator({
      runGit: async (...args) => {
        if (fail) await new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error("slow Git")), 100));
        return fake.run(...args);
      },
      timeoutMs: 10,
    });
    expect((await coordinator.getChanges("/project")).files).toHaveLength(2);
    fail = true;
    coordinator.invalidate("/project");
    const stale = await coordinator.getChanges("/project");
    expect(stale.files).toHaveLength(2);
    expect(stale.refreshStatus?.state).toBe("error");
  });

  it("bounds branch fan-out and preserves unrelated project caches", async () => {
    let active = 0;
    let maximum = 0;
    const calls = new Map<string, number>();
    const run = async (cwd: string, args: string[]) => {
      calls.set(cwd, (calls.get(cwd) ?? 0) + 1);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${cwd}\n`;
      if (args[0] === "rev-parse") return `branch-${cwd.slice(-1)}\n`;
      if (args[0] === "status" || args[0] === "diff") return "";
      if (args[0] === "worktree") return `worktree ${cwd}\nbranch refs/heads/main\n`;
      return "main\n";
    };
    const coordinator = new GitCoordinator({ runGit: run, maxConcurrency: 3 });
    await Promise.all(Array.from({ length: 10 }, (_, index) => coordinator.getBranch(`/project-${index}`)));
    expect(maximum).toBeLessThanOrEqual(3);
    const before = calls.get("/project-9");
    coordinator.invalidate("/project-0", ["branch"]);
    await coordinator.getBranch("/project-9");
    expect(calls.get("/project-9")).toBe(before);
    coordinator.invalidate("/project-9", ["status"]);
    await coordinator.getBranch("/project-9");
    expect(calls.get("/project-9")).toBe(before);
  });

  it("removes aborted queued work without starving later projects", async () => {
    const fake = fakeGit({}, 2);
    const coordinator = new GitCoordinator({ runGit: fake.run, maxConcurrency: 1, timeoutMs: 1_000 });
    const first = coordinator.getBranch("/project-a");
    const aborted = coordinator.getBranch("/project-b");
    coordinator.invalidate("/project-b");
    const later = coordinator.getBranch("/project-c");
    await expect(Promise.race([
      later,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("starved")), 500)),
    ])).resolves.toBe("main");
    await first;
    await aborted;
  });

  it("returns a safe non-repository state after a Git error", async () => {
    const coordinator = new GitCoordinator({ runGit: async () => { throw new Error("not a repository"); } });
    const workspace = await coordinator.getWorkspaceInfo("/plain-folder");
    expect(workspace.isRepo).toBe(false);
    expect(workspace.refreshStatus?.state).toBe("error");
    expect(await coordinator.getBranch("/plain-folder")).toBeUndefined();
  });

  it("cancels an individual reader without cancelling the shared scan", async () => {
    const fake = fakeGit({}, 5);
    const coordinator = new GitCoordinator({ runGit: fake.run });
    const controller = new AbortController();
    const cancelled = coordinator.getBranch("/project", controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    expect(await coordinator.getBranch("/project")).toBe("main");
  });
});

describe("bounded untracked statistics", () => {
  it("does not load binary or oversized untracked files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-git-"));
    try {
      await writeFile(join(cwd, "binary.bin"), Buffer.alloc(300_000, 0));
      await writeFile(join(cwd, "large.txt"), Buffer.alloc(300_000, 65));
      let bytes = 0;
      const result = await readProjectGitState(cwd, {
        untrackedStats: { onBytesRead: (count) => { bytes += count; } },
        runGit: async (_path, args) => {
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${cwd}\n`;
          if (args[0] === "rev-parse") return "main\n";
          if (args[0] === "status") return "?? binary.bin\0?? large.txt\0";
          if (args[0] === "diff") return "";
          if (args[0] === "worktree") return `worktree ${cwd}\nbranch refs/heads/main\n`;
          return "main\n";
        },
      });
      expect(result.changes.files.every((file) => file.added === 0)).toBe(true);
      expect(bytes).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
