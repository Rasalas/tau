import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleQueue } from "./lifecycle-queue.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("LifecycleQueue", () => {
  it("serialises independent operations", async () => {
    const queue = new LifecycleQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = queue.run("first", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push("first:end");
    });
    const second = queue.run("second", async () => {
      order.push("second:start");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    expect(queue.currentOperation).toBe("first");
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(queue.currentOperation).toBeUndefined();
  });

  it("runs a reentrant operation inline so a hook cannot deadlock the host", async () => {
    const queue = new LifecycleQueue();
    const order: string[] = [];
    // The shape of a lifecycle hook that calls services.sessions.exclusive().
    const hook = () => queue.run("exclusive", async () => { order.push("hook"); });
    await queue.run("open", async () => {
      order.push("open");
      await hook();
      order.push("open:done");
    });
    expect(order).toEqual(["open", "hook", "open:done"]);
  });

  it("keeps the reentrant answer inside nested async work", async () => {
    const queue = new LifecycleQueue();
    let reentrantInside = false;
    await queue.run("open", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      reentrantInside = queue.reentrant;
    });
    expect(reentrantInside).toBe(true);
    expect(queue.reentrant).toBe(false);
  });

  it("reports an operation that holds the queue too long without aborting it", async () => {
    vi.useFakeTimers();
    const onSlow = vi.fn();
    let clock = 0;
    const queue = new LifecycleQueue({ slowAfterMs: 30_000, onSlow, now: () => clock });
    let release!: () => void;
    const pending = queue.run("switch", () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    clock = 31_000;
    vi.advanceTimersByTime(30_000);
    expect(onSlow).toHaveBeenCalledWith("switch", 31_000);
    release();
    await expect(pending).resolves.toBeUndefined();
  });

  it("keeps running after a failed operation", async () => {
    const queue = new LifecycleQueue();
    await expect(queue.run("boom", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(queue.run("next", async () => "ok")).resolves.toBe("ok");
  });
});
