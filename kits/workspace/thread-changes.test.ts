import { describe, expect, it, vi } from "vitest";
import type { UiChangedFile } from "tau/host-extension";
import { countThreadChanges } from "./thread-changes.js";
import type { UiTurnCheckpoint } from "./turn-checkpoint-types.js";

const file = (path: string): UiChangedFile => ({ path, name: path, directory: "", status: "modified", added: 1, removed: 0 });
const status = (...paths: string[]) => ({ files: paths.map(file), added: paths.length, removed: 0 });
const turn = (id: string, paths: string[], fileCount = paths.length) => ({
  id, turnId: id, sessionId: "s", anchorMessageId: "a", beforeSnapshotId: "b", afterSnapshotId: "c", startedAt: 1, endedAt: 2,
  files: paths.map(file), fileCount, added: 0, removed: 0,
}) as UiTurnCheckpoint;

describe("the header's count", () => {
  it("counts a worktree's branch against its base, uncommitted files included once", async () => {
    const count = await countThreadChanges(status("a.ts", "b.ts"), true, { branchPaths: async () => ["b.ts", "c.ts"] });
    expect(count).toEqual({ files: 3, scope: "branch", uncommitted: 2 });
  });

  it("counts only the uncommitted files this thread's turns changed in a shared checkout", async () => {
    const turnPaths = vi.fn(async () => ["big-1.ts", "big-2.ts"]);
    const count = await countThreadChanges(status("mine.ts", "big-2.ts", "someone-else.ts"), false, {
      checkpoints: async () => [turn("t1", ["mine.ts", "committed-since.ts"]), turn("t2", ["big-1.ts"], 2)],
      turnPaths,
    });
    expect(count).toEqual({ files: 2, scope: "thread", uncommitted: 3 });
    expect(turnPaths).toHaveBeenCalledOnce();
  });

  it("reads a large turn's files once", async () => {
    const cache = new Map<string, readonly string[]>();
    const turnPaths = vi.fn(async () => ["x.ts"]);
    const sources = { checkpoints: async () => [turn("t", ["x.ts"], 9)], turnPaths };
    await countThreadChanges(status("x.ts"), false, sources, cache);
    await countThreadChanges(status("x.ts"), false, sources, cache);
    expect(turnPaths).toHaveBeenCalledOnce();
  });

  it("falls back to every uncommitted file when nothing narrower is known", async () => {
    expect(await countThreadChanges(status("a.ts", "b.ts"), false, {})).toEqual({ files: 2, scope: "checkout", uncommitted: 2 });
    expect(await countThreadChanges(status("a.ts"), false, { checkpoints: async () => [] })).toMatchObject({ scope: "checkout" });
    expect(await countThreadChanges(status("a.ts"), true, { branchPaths: async () => undefined })).toMatchObject({ scope: "checkout", files: 1 });
  });
});
