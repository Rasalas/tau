import { describe, expect, it, vi } from "vitest";
import { PendingThreadFind } from "./transcript-find";

describe("thread-bound pending find", () => {
  it("retains query and mode through foreign mounts, then consumes them once", () => {
    const pending = new PendingThreadFind();
    const foreign = vi.fn();
    const target = vi.fn();
    const request = { sessionId: "target", query: "quartz moon", mode: "all-words" as const };
    pending.request(request);
    const stop = pending.answer("foreign", foreign);
    expect(foreign).not.toHaveBeenCalled();
    stop();
    pending.answer("target", target)();
    expect(target).toHaveBeenCalledExactlyOnceWith(request);
    pending.answer("target", target);
    expect(target).toHaveBeenCalledTimes(1);
  });

  it("delivers after registration and lets the latest pending target replace an earlier one", () => {
    const pending = new PendingThreadFind();
    const target = vi.fn();
    pending.request({ sessionId: "obsolete", query: "old" });
    pending.request({ sessionId: "target", query: "new", mode: "all-words" });
    pending.answer("obsolete", vi.fn(() => { throw new Error("obsolete request delivered"); }));
    const stop = pending.answer("target", target);
    expect(target).toHaveBeenCalledExactlyOnceWith({ sessionId: "target", query: "new", mode: "all-words" });
    target.mockClear();
    pending.request({ sessionId: "target", query: "next" });
    expect(target).toHaveBeenCalledExactlyOnceWith({ sessionId: "target", query: "next" });
    stop();
  });

  it("a manual Find clears an undelivered global request", () => {
    const pending = new PendingThreadFind();
    pending.request({ sessionId: "target", query: "quartz moon", mode: "all-words" });
    pending.clear();
    const target = vi.fn();
    pending.answer("target", target);
    expect(target).not.toHaveBeenCalled();
  });
});
