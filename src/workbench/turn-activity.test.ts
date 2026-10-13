import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiToolRun } from "../shared/contracts";
import type { UiChangedFile, UiWorkspaceChanges } from "../shared/workspace-kit-types";
import { createMemoryStorage, type ClientStorage } from "./client-storage";
import { STORAGE_KEYS } from "./storage-keys";
import { changesSinceTurn, changesTouchedByTools, clearCachedTurnActivity, followTurnActivity, readCachedTurnActivity, writeCachedTurnActivity, type TurnActivitySource } from "./turn-activity";

const reloaded = (storage: ClientStorage): ClientStorage => ({ ...storage });

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

    expect(readCachedTurnActivity(reloaded(storage), "session")).toEqual({
      sessionId: "session",
      baseline,
      anchorMessageId: "user-message",
      tools: [{ id: "tool", name: "read", args: {}, status: "done", output: "ok", startedAt: 1, endedAt: 2 }],
    });
  });

  it("migrates the legacy blob once and writes only the changed thread afterwards", () => {
    const storage = createMemoryStorage();
    storage.set(STORAGE_KEYS.turnActivityCache, JSON.stringify({
      old: { sessionId: "old", tools: [], anchorMessageId: "prompt" },
      other: { sessionId: "other", tools: [] },
    }));
    expect(readCachedTurnActivity(storage, "old")?.anchorMessageId).toBe("prompt");
    expect(storage.get(STORAGE_KEYS.turnActivityCache)).toBeNull();
    const get = vi.spyOn(storage, "get");
    const set = vi.spyOn(storage, "set");
    writeCachedTurnActivity(storage, { sessionId: "old", tools: [] });
    expect(get).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledOnce();
    expect(set.mock.calls[0][0]).toBe(`${STORAGE_KEYS.threadTurnActivity}:old`);
    clearCachedTurnActivity(storage, "old");
    expect(readCachedTurnActivity(reloaded(storage), "old")).toBeUndefined();
    expect(readCachedTurnActivity(reloaded(storage), "other")).toMatchObject({ sessionId: "other" });
  });

  it("keeps twelve threads and bounds persisted tool counts and output", () => {
    const storage = createMemoryStorage();
    for (let index = 0; index < 13; index += 1) {
      writeCachedTurnActivity(storage, {
        sessionId: `thread-${index}`,
        tools: Array.from({ length: 201 }, (_, id) => ({ id: `${id}`, name: "read", args: {}, status: "done", startedAt: 1, output: "x".repeat(9_000) })),
      });
    }
    expect(storage.keys(`${STORAGE_KEYS.threadTurnActivity}:`)).toHaveLength(12);
    const fresh = reloaded(storage);
    expect(readCachedTurnActivity(fresh, "thread-0")).toBeUndefined();
    const tools = readCachedTurnActivity(fresh, "thread-12")!.tools;
    expect(tools).toHaveLength(200);
    expect(tools[0].id).toBe("1");
    expect(tools[0].output).toBe(`${"x".repeat(8_192)}\n[Cached output truncated]`);
  });

  it("keeps the in-memory state when persistence is full or blocked", () => {
    const storage = createMemoryStorage();
    vi.spyOn(storage, "set").mockImplementation(() => { throw new Error("quota exceeded"); });
    expect(() => writeCachedTurnActivity(storage, { sessionId: "session", tools: [] })).not.toThrow();
    expect(readCachedTurnActivity(storage, "session")).toMatchObject({ sessionId: "session" });
    expect(() => clearCachedTurnActivity(storage, "session")).not.toThrow();
    expect(readCachedTurnActivity(storage, "session")).toBeUndefined();
  });

  it("preserves thread recency across reloads when pruning", () => {
    const storage = createMemoryStorage();
    for (let index = 0; index < 12; index += 1) writeCachedTurnActivity(storage, { sessionId: `thread-${index}`, tools: [] });
    writeCachedTurnActivity(storage, { sessionId: "thread-0", tools: [], anchorMessageId: "recent" });
    const fresh = reloaded(storage);
    writeCachedTurnActivity(fresh, { sessionId: "new", tools: [] });
    expect(readCachedTurnActivity(reloaded(storage), "thread-0")?.anchorMessageId).toBe("recent");
    expect(readCachedTurnActivity(reloaded(storage), "thread-1")).toBeUndefined();
    expect(storage.keys(`${STORAGE_KEYS.threadTurnActivity}:`)).toHaveLength(12);
  });

  it("ignores a damaged thread record without losing another thread", () => {
    const storage = createMemoryStorage();
    storage.set(`${STORAGE_KEYS.threadTurnActivity}:bad`, "{broken");
    writeCachedTurnActivity(storage, { sessionId: "good", tools: [] });
    expect(readCachedTurnActivity(reloaded(storage), "good")).toMatchObject({ sessionId: "good" });
    expect(readCachedTurnActivity(storage, "bad")).toBeUndefined();
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
  afterEach(() => vi.useRealTimers());
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

  it("writes at most once per second for 200 tools with 8 KB outputs and fresh arrays each frame", () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const set = vi.spyOn(storage, "set");
    const get = vi.spyOn(storage, "get");
    const fake = source();
    const stop = followTurnActivity(fake.value, storage);
    const tools = Array.from({ length: 200 }, (_, index) => ({ ...bash("x".repeat(8_192)), id: `tool-${index}` }));
    const reads = get.mock.calls.length;
    set.mockClear();
    try {
      for (let second = 0; second < 3; second += 1) {
        const writes = set.mock.calls.length;
        for (let frame = 0; frame < 50; frame += 1) {
          fake.setView({ tools: tools.map((tool) => ({ ...tool, output: `${second}:${frame}`.padEnd(8_192, "x") })), turnActivitySessionId: "session" });
          vi.advanceTimersByTime(20);
        }
        expect(set.mock.calls.length - writes).toBeLessThanOrEqual(1);
      }
      expect(get.mock.calls.length).toBe(reads);
      expect(set).toHaveBeenCalledTimes(3);
      expect(readCachedTurnActivity(reloaded(storage), "session")?.tools[0].output).toBe("2:49".padEnd(8_192, "x"));
    } finally {
      stop();
    }
  });

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
    const stop = followTurnActivity(fake.value, storage);
    fake.setView({ tools: [bash("elsewhere")], turnActivitySessionId: "other" });
    expect(readCachedTurnActivity(storage, "session")?.tools ?? []).toEqual([]);
    expect(readCachedTurnActivity(storage, "other")).toBeUndefined();
    stop();
  });

  it("flushes a thread being left and keeps the next thread's pending state separate", () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const fake = source();
    const stop = followTurnActivity(fake.value, storage);
    fake.setView({ tools: [bash("first")], turnActivitySessionId: "session" });
    expect(storage.keys()).toEqual([]);
    fake.setSnapshot({ sessionId: "other" });
    expect(readCachedTurnActivity(reloaded(storage), "session")?.tools[0].output).toBe("first");
    fake.setView({ tools: [bash("second")], turnActivitySessionId: "other" });
    stop();
    expect(readCachedTurnActivity(reloaded(storage), "other")?.tools[0].output).toBe("second");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resurrect cleared activity when the pending timer fires", () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const fake = source();
    const stop = followTurnActivity(fake.value, storage);
    fake.setView({ tools: [bash("failed")], turnActivitySessionId: "session" });
    clearCachedTurnActivity(storage, "session");
    vi.advanceTimersByTime(1_000);
    stop();
    expect(readCachedTurnActivity(reloaded(storage), "session")).toBeUndefined();
  });

  it("limits failed quota writes too, without retrying unchanged snapshots", () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const set = vi.spyOn(storage, "set").mockImplementation(() => { throw new Error("quota exceeded"); });
    const fake = source();
    const stop = followTurnActivity(fake.value, storage);
    for (let frame = 0; frame < 50; frame += 1) {
      fake.setView({ tools: [bash(`${frame}`)], turnActivitySessionId: "session" });
      vi.advanceTimersByTime(20);
    }
    expect(set).toHaveBeenCalledOnce();
    fake.setSnapshot({ sessionId: "session" });
    vi.advanceTimersByTime(2_000);
    expect(set).toHaveBeenCalledOnce();
    expect(readCachedTurnActivity(storage, "session")?.tools[0].output).toBe("49");
    stop();
  });
});
