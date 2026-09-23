import { describe, expect, it, vi } from "vitest";
import type { UiToolRun } from "../shared/contracts";
import type { UiChangedFile, UiWorkspaceChanges } from "../shared/workspace-kit-types";
import { createMemoryStorage } from "./client-storage";
import { changesSinceTurn, changesTouchedByTools, followTurnActivity, readCachedTurnActivity, writeCachedTurnActivity, type TurnActivitySource } from "./turn-activity";

function file(path: string, added: number, removed: number): UiChangedFile {
  const parts = path.split("/");
  return {
    path,
    name: parts.at(-1)!,
    directory: parts.slice(0, -1).join("/"),
    status: "modified",
    added,
    removed,
  };
}

function changes(files: UiChangedFile[]): UiWorkspaceChanges {
  return {
    files,
    added: files.reduce((sum, item) => sum + item.added, 0),
    removed: files.reduce((sum, item) => sum + item.removed, 0),
  };
}

describe("turn activity cache", () => {
  it("restores the last turn after a renderer reload", () => {
    const storage = createMemoryStorage();
    const baseline = changes([file("already-dirty.ts", 2, 0)]);
    writeCachedTurnActivity(storage, {
      sessionId: "session",
      baseline,
      anchorMessageId: "user-message",
      tools: [{ id: "tool", name: "read", args: {}, status: "done", output: "ok", startedAt: 1, endedAt: 2 }],
    });

    expect(readCachedTurnActivity(storage, "session")).toEqual({
      sessionId: "session",
      baseline,
      anchorMessageId: "user-message",
      tools: [{ id: "tool", name: "read", args: {}, status: "done", output: "ok", startedAt: 1, endedAt: 2 }],
    });
  });
});

describe("changesTouchedByTools", () => {
  it("reconstructs changed files after a reload without showing older dirty files", () => {
    const current = changes([file("src/old.ts", 20, 3), file("src/edited.ts", 4, 1)]);
    const result = changesTouchedByTools([
      { id: "edit", name: "edit", args: { path: "/repo/src/edited.ts" }, status: "done", startedAt: 1 },
    ], current);

    expect(result).toMatchObject({ files: [file("src/edited.ts", 4, 1)], added: 4, removed: 1 });
  });
});

describe("changesSinceTurn", () => {
  it("excludes worktree changes that existed before the turn", () => {
    const baseline = changes([file("old.ts", 20, 3), file("edited.ts", 4, 1)]);
    const current = changes([
      file("old.ts", 20, 3),
      file("edited.ts", 7, 2),
      file("new.ts", 5, 0),
    ]);

    expect(changesSinceTurn(baseline, current)).toMatchObject({
      files: [file("edited.ts", 3, 1), file("new.ts", 5, 0)],
      added: 8,
      removed: 1,
    });
  });

  it("treats reversing an earlier dirty change as turn activity", () => {
    const result = changesSinceTurn(changes([file("edited.ts", 10, 4)]), changes([file("edited.ts", 7, 2)]));

    expect(result.files[0]).toMatchObject({ path: "edited.ts", added: 2, removed: 3 });
  });

  it("shows no global worktree summary before Tau observes a turn", () => {
    expect(changesSinceTurn(undefined, changes([file("old.ts", 20, 3)]))).toMatchObject({
      files: [], added: 0, removed: 0,
    });
  });
});

describe("followTurnActivity", () => {
  function source() {
    const listeners = new Set<() => void>();
    let snapshot: { sessionId: string } | undefined = { sessionId: "session" };
    let view: ReturnType<TurnActivitySource["getToolView"]> = { tools: [], turnActivitySessionId: "session" };
    const value: TurnActivitySource = {
      getSnapshot: () => snapshot,
      getToolView: () => view,
      subscribeToSnapshot: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      subscribeToTools: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    return {
      value,
      listeners,
      setView(next: typeof view) { view = next; listeners.forEach((listener) => listener()); },
      setSnapshot(next: typeof snapshot) { snapshot = next; listeners.forEach((listener) => listener()); },
    };
  }
  const bash = (output: string): UiToolRun => ({ id: "t", name: "bash", args: {}, status: "running", output, startedAt: 1 });

  it("caches each new tool state of the visible thread's turn and stops when told", () => {
    const storage = createMemoryStorage();
    const set = vi.spyOn(storage, "set");
    const fake = source();
    const stop = followTurnActivity(fake.value, storage);

    fake.setView({ tools: [bash("one")], toolAnchorId: "m1", turnActivitySessionId: "session" });
    expect(readCachedTurnActivity(storage, "session")).toMatchObject({ anchorMessageId: "m1", tools: [{ output: "one" }] });
    const writes = set.mock.calls.length;

    // The same tool state reached through the other slice is not written again.
    fake.setSnapshot({ sessionId: "session" });
    expect(set.mock.calls.length).toBe(writes);

    stop();
    expect(fake.listeners.size).toBe(0);
  });

  it("leaves the cache alone while the turn belongs to another thread", () => {
    const storage = createMemoryStorage();
    const fake = source();
    followTurnActivity(fake.value, storage);
    fake.setView({ tools: [bash("elsewhere")], turnActivitySessionId: "other" });
    expect(readCachedTurnActivity(storage, "session")?.tools ?? []).toEqual([]);
    expect(readCachedTurnActivity(storage, "other")).toBeUndefined();
  });
});
