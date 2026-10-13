import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadRuntimeRegistry } from "./thread-runtimes.js";
import { LifecycleQueue } from "./lifecycle-queue.js";

interface Fake { name: string }

function registry(maxLive = 3) {
  const disposed: string[] = [];
  const reg = new ThreadRuntimeRegistry<Fake>({
    maxLive,
    dispose: async (record) => { disposed.push(record.threadId); },
  });
  return { reg, disposed };
}

const record = (threadId: string) => ({
  threadId, cwd: `/w/${threadId}`, runtime: { name: threadId }, isolation: "in-process" as const,
});

describe("thread runtime registry", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["replace", "idle", "evict", "release", "all"])("bounds a hung dispose during %s and frees the exclusive lane", async (mode) => {
    vi.useFakeTimers();
    const timedOut = vi.fn();
    const reg = new ThreadRuntimeRegistry<Fake>({ maxLive: 1, dispose: () => new Promise(() => undefined), onDisposeTimeout: timedOut });
    const queue = new LifecycleQueue();
    await reg.adopt(record("old"));
    const release = queue.run("dispose", async () => {
      if (mode === "replace") await reg.adopt({ ...record("old"), runtime: { name: "replacement" } });
      else if (mode === "idle") await reg.releaseIdle(0);
      else if (mode === "evict") await reg.adopt(record("new"));
      else if (mode === "release") await reg.release("old");
      else await reg.releaseAll();
    });
    let available = false;
    const next = queue.run("next", async () => { available = true; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(available).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(available).toBe(true);
    await release;
    await next;
    expect(timedOut).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ threadId: "old" }));
    expect(reg.get("old")?.runtime.name).toBe(mode === "replace" ? "replacement" : undefined);
  });

  it("handles a late disposal rejection after its deadline", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const reg = new ThreadRuntimeRegistry<Fake>({ dispose: () => new Promise((_resolve, fail) => { reject = fail; }) });
    await reg.adopt(record("old"));
    const closing = reg.release("old");
    await vi.advanceTimersByTimeAsync(30_000);
    await closing;
    await reg.adopt(record("old"));
    reject(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(reg.run("old", async () => "works")).resolves.toBe("works");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("runs work on different threads concurrently, and serialises per thread", async () => {
    const { reg } = registry();
    await reg.adopt(record("a"));
    await reg.adopt(record("b"));

    const order: string[] = [];
    const gate = (ms: number, tag: string) => async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(tag);
      return tag;
    };

    // Two operations on "a" must not overlap; "b" runs alongside them.
    const a1 = reg.run("a", gate(30, "a1"));
    const a2 = reg.run("a", gate(1, "a2"));
    const b1 = reg.run("b", gate(5, "b1"));
    await Promise.all([a1, a2, b1]);

    expect(order.indexOf("a1")).toBeLessThan(order.indexOf("a2"));
    expect(order.indexOf("b1")).toBeLessThan(order.indexOf("a2"));
  });

  it("keeps the thread usable after an operation throws", async () => {
    const { reg } = registry();
    await reg.adopt(record("a"));
    await expect(reg.run("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(reg.run("a", async () => "next")).resolves.toBe("next");
  });

  it("releases the least recently used idle runtime beyond the budget", async () => {
    const { reg, disposed } = registry(2);
    await reg.adopt(record("old"));
    await reg.run("old", async () => undefined);
    await reg.adopt(record("mid"));
    await reg.run("mid", async () => undefined);
    await reg.adopt(record("new"));

    expect(disposed).toEqual(["old"]);
    expect(reg.has("old")).toBe(false);
    expect(reg.has("mid")).toBe(true);
    expect(reg.has("new")).toBe(true);
  });

  it("never evicts the thread on screen", async () => {
    const { reg, disposed } = registry(2);
    await reg.adopt(record("viewed"));
    reg.setActive("viewed");
    await reg.adopt(record("second"));
    await reg.run("second", async () => undefined);
    await reg.adopt(record("third"));

    expect(disposed).toEqual(["second"]);
    expect(reg.has("viewed")).toBe(true);
  });

  it("reports which threads are busy", async () => {
    const { reg } = registry();
    await reg.adopt(record("a"));
    const pending = reg.run("a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 1;
    });
    expect(reg.isBusy("a")).toBe(true);
    await pending;
    expect(reg.isBusy("a")).toBe(false);
    expect(reg.busyCount).toBe(0);
  });

  it("disposes a replaced runtime for the same session", async () => {
    const { reg, disposed } = registry();
    await reg.adopt(record("a"));
    await reg.adopt({ ...record("a"), runtime: { name: "a-replacement" } });
    expect(disposed).toEqual(["a"]);
    expect(reg.get("a")?.runtime.name).toBe("a-replacement");
  });

  it("never evicts a runtime its owner reports as busy", async () => {
    const disposed: string[] = [];
    const busy = new Set(["a"]);
    const reg = new ThreadRuntimeRegistry<Fake>({
      maxLive: 1,
      dispose: async (entry) => { disposed.push(entry.threadId); },
      canEvict: (entry) => !busy.has(entry.threadId),
    });
    await reg.adopt(record("a"));
    await reg.adopt(record("b"));
    await reg.adopt(record("c"));
    // "a" is over budget and oldest, but still working; "b" goes instead.
    expect(disposed).toEqual(["b"]);
    expect(reg.has("a")).toBe(true);
    expect(reg.has("c")).toBe(true);
  });

  it("releases runtimes nobody used for the idle time, never the one on screen or a busy one", async () => {
    let now = 0;
    const disposed: string[] = [];
    const busy = new Set<string>();
    const reg = new ThreadRuntimeRegistry<Fake>({
      maxLive: 6,
      dispose: async (entry) => { disposed.push(entry.threadId); },
      canEvict: (entry) => !busy.has(entry.threadId),
      now: () => now,
    });
    for (const id of ["shown", "stale", "working", "recent"]) await reg.adopt(record(id));
    reg.setActive("shown");
    busy.add("working");
    now = 5_000;
    reg.touch("recent");
    now = 10_000;
    expect(reg.idleThreadIds(10_000)).toEqual(["stale"]);
    await expect(reg.releaseIdle(10_000)).resolves.toEqual(["stale"]);
    expect(disposed).toEqual(["stale"]);
    expect(reg.has("stale")).toBe(false);
    expect(reg.has("shown") && reg.has("working") && reg.has("recent")).toBe(true);
    // Work in flight on the thread keeps it, however old its last use.
    now = 20_000;
    let finish!: () => void;
    const running = reg.run("recent", () => new Promise<void>((resolve) => { finish = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));
    now = 40_000;
    expect(reg.idleThreadIds(10_000)).toEqual([]);
    finish();
    await running;
    expect(reg.idleThreadIds(10_000)).toEqual([]);
    now = 50_000;
    expect(reg.idleThreadIds(10_000)).toEqual(["recent"]);
  });
});
