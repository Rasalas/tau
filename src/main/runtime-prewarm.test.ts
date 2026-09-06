import { describe, expect, it, vi } from "vitest";
import type { UiSession } from "../shared/contracts.js";
import { RuntimePrewarm, type RuntimePrewarmPort } from "./runtime-prewarm.js";
import type { ThreadRuntime } from "./thread-runtime.js";

function fakeThread(cwd = "/repo"): ThreadRuntime {
  return {
    cwd,
    sessionId: "spare",
    threadId: "spare",
    backend: { abort: vi.fn(async () => undefined) },
  } as unknown as ThreadRuntime;
}

function makePrewarm(overrides: Partial<RuntimePrewarmPort> = {}) {
  const opened: string[] = [];
  const disposed: ThreadRuntime[] = [];
  const prewarmed: string[] = [];
  const logs: string[] = [];
  const port: RuntimePrewarmPort = {
    automatic: true,
    safeMode: false,
    maxLiveThreads: 6,
    cwd: () => "/repo",
    sessionsDir: undefined,
    runtimes: {
      open: vi.fn(async () => { opened.push("open"); return fakeThread(); }),
      dispose: vi.fn(async (thread: ThreadRuntime) => { disposed.push(thread); }),
      isOpening: () => false,
    } as never,
    extensionUi: { cancelFor: vi.fn() } as never,
    liveThreadIds: () => new Set<string>(),
    hasLocalActive: () => true,
    indexedSessions: () => [],
    prewarmSession: async (path) => { prewarmed.push(path); },
    recordBackground: () => undefined,
    log: (label) => { logs.push(label); },
    fail: () => undefined,
    errorMessage: (error) => String(error),
    ...overrides,
  };
  return { prewarm: new RuntimePrewarm(port), port, opened, disposed, prewarmed, logs };
}

function shell(id: string, path: string, projectPath = "/repo"): UiSession {
  return { id, path, projectPath, title: id, modifiedAt: 1, projectName: "repo", messageCount: 0 } as UiSession;
}

describe("RuntimePrewarm", () => {
  it("builds no spare in safe mode or with automatic prewarm off", async () => {
    const off = makePrewarm({ automatic: false });
    off.prewarm.scheduleSpare("/repo");
    expect(off.opened).toEqual([]);
    // A forced request still builds one: the client asked for the capability.
    off.prewarm.scheduleSpare("/repo", true);
    expect(off.port.runtimes.open).toHaveBeenCalledOnce();

    const safe = makePrewarm({ safeMode: true });
    safe.prewarm.scheduleSpare("/repo", true);
    expect(safe.port.runtimes.open).not.toHaveBeenCalled();
  });

  it("keeps one spare per project and hands it over once", async () => {
    const { prewarm, port } = makePrewarm();
    prewarm.scheduleSpare("/repo");
    prewarm.scheduleSpare("/repo");
    expect(port.runtimes.open).toHaveBeenCalledOnce();
    expect(await prewarm.takeSpare("/repo")).toBeTruthy();
    expect(await prewarm.takeSpare("/repo")).toBeUndefined();
  });

  it("does not hand the spare of one project to another", async () => {
    const { prewarm } = makePrewarm();
    prewarm.scheduleSpare("/repo");
    expect(await prewarm.takeSpare("/other")).toBeUndefined();
  });

  it("discards the spare of the previous project when the project changes", async () => {
    const { prewarm, disposed } = makePrewarm();
    prewarm.scheduleSpare("/repo");
    prewarm.scheduleSpare("/other");
    await prewarm.awaitSpare("/other");
    expect(disposed).toHaveLength(1);
  });

  it("takes an untouched candidate back", async () => {
    const { prewarm } = makePrewarm();
    const returned = fakeThread();
    prewarm.retainSpare(returned);
    expect(await prewarm.takeSpare("/repo")).toBe(returned);
  });

  it("builds a spare on demand and keeps it", async () => {
    const { prewarm, port } = makePrewarm({ automatic: false });
    expect(await prewarm.awaitSpare("/repo")).toBeTruthy();
    expect(port.runtimes.open).toHaveBeenCalledOnce();
    expect(await prewarm.awaitSpare("/repo")).toBeTruthy();
    expect(port.runtimes.open).toHaveBeenCalledOnce();
  });

  it("reports a failed spare as no spare at all", async () => {
    const { prewarm, logs } = makePrewarm({
      runtimes: { open: async () => { throw new Error("no runtime"); }, dispose: async () => undefined, isOpening: () => false } as never,
    });
    expect(await prewarm.awaitSpare("/repo")).toBeUndefined();
    expect(logs).toContain("runtime.spare.failed");
  });

  it("opens the neighbours of the thread on screen, up to the live budget", async () => {
    vi.useFakeTimers();
    try {
      const { prewarm, prewarmed } = makePrewarm({
        maxLiveThreads: 4,
        liveThreadIds: () => new Set(["live"]),
        indexedSessions: () => [
          shell("live", "/live.jsonl"),
          shell("a", "/a.jsonl"),
          shell("b", "/b.jsonl"),
          shell("c", "/c.jsonl"),
          shell("elsewhere", "/elsewhere.jsonl", "/other"),
        ],
      });
      prewarm.scheduleThreads();
      prewarm.scheduleThreads();
      vi.advanceTimersByTime(1_000);
      expect(prewarmed).toEqual(["/a.jsonl"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prewarms nothing while another runtime owns the visible thread", () => {
    vi.useFakeTimers();
    try {
      const { prewarm, prewarmed } = makePrewarm({
        hasLocalActive: () => false,
        indexedSessions: () => [shell("a", "/a.jsonl")],
      });
      prewarm.scheduleThreads();
      vi.advanceTimersByTime(1_000);
      expect(prewarmed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
