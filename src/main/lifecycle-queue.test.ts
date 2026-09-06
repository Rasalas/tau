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

  it("queues a callback that was created inside an operation but fires after it ended", async () => {
    const queue = new LifecycleQueue();
    const order: string[] = [];
    let later: Promise<void> | undefined;
    await queue.run("first", async () => {
      // A timer inherits the operation's async context; once "first" is over it must not run inline.
      later = new Promise<void>((resolve) => setTimeout(() => {
        void queue.run("from-timer", async () => { order.push("timer-start"); await new Promise((r) => setTimeout(r, 20)); order.push("timer-end"); }).then(resolve);
      }, 0));
    });
    const blocker = queue.run("second", async () => { order.push("second-start"); await new Promise((r) => setTimeout(r, 30)); order.push("second-end"); });
    await Promise.all([blocker, later]);
    expect(order).toEqual(["second-start", "second-end", "timer-start", "timer-end"]);
  });

  it("runs background operations together up to the limit and queues the rest", async () => {
    const queue = new LifecycleQueue({ backgroundLimit: 3 });
    let peak = 0;
    let inFlight = 0;
    const releases: Array<() => void> = [];
    const runs = Array.from({ length: 8 }, (_, index) => queue.runBackground(`start-${index}`, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      inFlight -= 1;
    }));
    await Promise.resolve();
    expect(inFlight).toBe(3);
    while (releases.length > 0) {
      releases.pop()!();
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all(runs);
    expect(peak).toBe(3);
  });

  it("keeps an exclusive operation out of the background lane, in both directions", async () => {
    const queue = new LifecycleQueue({ backgroundLimit: 4 });
    const order: string[] = [];
    let releaseBackground!: () => void;
    const background = queue.runBackground("start-thread", async () => {
      order.push("background:start");
      await new Promise<void>((resolve) => { releaseBackground = resolve; });
      order.push("background:end");
    });
    const exclusive = queue.run("switch-thread", async () => { order.push("switch"); });
    // A background start queued behind the switch waits for it, so a burst of
    // spawns cannot keep the thread on screen waiting indefinitely.
    const later = queue.runBackground("start-thread", async () => { order.push("later"); });
    await Promise.resolve();
    expect(order).toEqual(["background:start"]);
    releaseBackground();
    await Promise.all([background, exclusive, later]);
    expect(order).toEqual(["background:start", "background:end", "switch", "later"]);
  });

  it("keeps running after a failed background operation", async () => {
    const queue = new LifecycleQueue({ backgroundLimit: 1 });
    await expect(queue.runBackground("boom", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(queue.runBackground("next", async () => "ok")).resolves.toBe("ok");
    await expect(queue.run("exclusive", async () => "ok")).resolves.toBe("ok");
  });

  it("keeps running after a failed operation", async () => {
    const queue = new LifecycleQueue();
    await expect(queue.run("boom", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(queue.run("next", async () => "ok")).resolves.toBe("ok");
  });
});
