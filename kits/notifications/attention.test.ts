import { describe, expect, it } from "vitest";
import { AttentionBook } from "./attention.js";

function book(debounceMs = 5_000) {
  let now = 1_000;
  const value = new AttentionBook({ now: () => now, debounceMs });
  return { book: value, tick: (ms: number) => { now += ms; } };
}

describe("which thread needs the user, and who tells them", () => {
  it("notifies the attached client when the thread is not on screen", () => {
    const { book: attention } = book();
    attention.report("a", { focused: false, threadId: "t1" });
    const change = attention.raise({ threadId: "t1", reason: "completed", title: "Fix the build" });
    expect(change.changed).toBe(true);
    expect(change.delivery).toEqual({ clientKey: "a", items: [{ threadId: "t1", reason: "completed", title: "Fix the build", at: 1_000 }] });
    expect(attention.list().map((item) => item.threadId)).toEqual(["t1"]);
  });

  it("notifies when a focused window shows another thread", () => {
    const { book: attention } = book();
    attention.report("a", { focused: true, threadId: "t2" });
    expect(attention.raise({ threadId: "t1", reason: "question" }).delivery?.clientKey).toBe("a");
  });

  it("counts nothing when a focused window shows the thread, and tells that window it was seen", () => {
    const { book: attention } = book();
    attention.report("a", { focused: false, threadId: "t1" });
    attention.report("b", { focused: true, threadId: "t1" });
    expect(attention.raise({ threadId: "t1", reason: "completed" })).toEqual({
      changed: false,
      delivery: { clientKey: "b", items: [{ threadId: "t1", reason: "completed", at: 1_000 }], seen: true },
    });
    expect(attention.list()).toEqual([]);
  });

  it("tells one client only: the one that had focus last", () => {
    const { book: attention, tick } = book();
    attention.report("a", { focused: true, threadId: "t2" });
    tick(10);
    attention.report("b", { focused: true, threadId: "t3" });
    tick(10);
    attention.report("b", { focused: false, threadId: "t3" });
    attention.report("a", { focused: false, threadId: "t2" });
    expect(attention.raise({ threadId: "t1", reason: "completed" }).delivery?.clientKey).toBe("b");
  });

  it("debounces a thread's news: the badge follows, the notification does not repeat", () => {
    const { book: attention, tick } = book(5_000);
    attention.report("a", { focused: false });
    expect(attention.raise({ threadId: "t1", reason: "question" }).delivery).toBeDefined();
    tick(1_000);
    const again = attention.raise({ threadId: "t1", reason: "completed" });
    expect(again).toEqual({ changed: true });
    expect(attention.list()[0]?.reason).toBe("completed");
    expect(attention.raise({ threadId: "t2", reason: "completed" }).delivery).toBeDefined();
    tick(5_000);
    expect(attention.raise({ threadId: "t1", reason: "completed" }).delivery).toBeDefined();
  });

  it("counts one entry per thread, newest first, and clears a thread once it is seen", () => {
    const { book: attention, tick } = book();
    attention.report("a", { focused: false, threadId: "t1" });
    attention.raise({ threadId: "t1", reason: "completed" });
    tick(1);
    attention.raise({ threadId: "t2", reason: "failed" });
    expect(attention.list().map((item) => item.threadId)).toEqual(["t2", "t1"]);
    // Focus alone is not seeing it; focus with the thread on screen is.
    expect(attention.report("a", { focused: true, threadId: "t3" }).changed).toBe(false);
    expect(attention.report("a", { focused: true, threadId: "t1" }).changed).toBe(true);
    expect(attention.list().map((item) => item.threadId)).toEqual(["t2"]);
    expect(attention.report("a", { focused: false, threadId: "t2" }).changed).toBe(false);
  });

  it("holds news while no client is attached and hands it to the first one that reports", () => {
    const { book: attention, tick } = book();
    expect(attention.raise({ threadId: "t1", reason: "completed" })).toEqual({ changed: true });
    tick(1);
    attention.raise({ threadId: "t2", reason: "question" });
    const change = attention.report("a", { focused: false });
    expect(change.delivery?.clientKey).toBe("a");
    expect(change.delivery?.items.map((item) => item.threadId)).toEqual(["t2", "t1"]);
    expect(attention.report("b", { focused: false }).delivery).toBeUndefined();
  });

  it("does not hand over held news the arriving client already shows", () => {
    const { book: attention } = book();
    attention.raise({ threadId: "t1", reason: "completed" });
    const change = attention.report("a", { focused: true, threadId: "t1" });
    expect(change).toEqual({ changed: true });
    expect(attention.visible("t1")).toBe(true);
    expect(attention.list()).toEqual([]);
  });

  it("forgets every client's presence, so the next news waits for one to report again", () => {
    const { book: attention } = book();
    attention.report("a", { focused: true, threadId: "t1" });
    attention.forgetClients();
    expect(attention.visible("t1")).toBe(false);
    expect(attention.raise({ threadId: "t1", reason: "completed" }).delivery).toBeUndefined();
    expect(attention.report("a", { focused: false, threadId: "t1" }).delivery?.items).toHaveLength(1);
  });

  it("drops a deleted thread with its held news", () => {
    const { book: attention } = book();
    attention.raise({ threadId: "t1", reason: "completed" });
    expect(attention.drop("t1")).toEqual({ changed: true });
    expect(attention.drop("t1")).toEqual({ changed: false });
    expect(attention.report("a", { focused: false }).delivery).toBeUndefined();
  });

  it("counts an older client, which tells no use, as attending only while focused and not idle", () => {
    const { book: attention } = book();
    expect(attention.attended(300_000)).toBe(false);
    attention.report("phone", { focused: false, threadId: "t1" });
    expect(attention.attended(300_000)).toBe(false);
    attention.report("window", { focused: true, threadId: "t2", idle: true });
    expect(attention.attended(300_000)).toBe(false);
    attention.report("window", { focused: true, threadId: "t2" });
    expect(attention.attended(300_000)).toBe(true);
    expect(attention.awayIn(300_000)).toBeUndefined();
    attention.leave("window");
    expect(attention.attended(300_000)).toBe(false);
  });

  it("counts the user away once no client was used for the away time, focused or not", () => {
    const { book: attention, tick } = book();
    attention.report("window", { focused: true, threadId: "t1", usedAgoMs: 0 });
    tick(60_000);
    // Left Tau for the browser: still at the desk, for the rest of the five minutes.
    attention.report("window", { focused: false, threadId: "t1", usedAgoMs: 60_000 });
    expect(attention.attended(300_000)).toBe(true);
    expect(attention.awayIn(300_000)).toBe(240_000);
    tick(240_000);
    expect(attention.attended(300_000)).toBe(false);
    expect(attention.awayIn(300_000)).toBe(0);
    // A touch on the phone counts as much as a click at the desk.
    attention.report("phone", { focused: true, usedAgoMs: 10_000 });
    expect(attention.awayIn(300_000)).toBe(290_000);
  });

  it("keeps news unseen until a focused client shows the thread", () => {
    const { book: attention } = book();
    attention.report("window", { focused: true, threadId: "t2", usedAgoMs: 0 });
    attention.raise({ threadId: "t1", reason: "completed" });
    expect(attention.unseen("t1")).toBe(true);
    attention.report("window", { focused: true, threadId: "t1", usedAgoMs: 0 });
    expect(attention.unseen("t1")).toBe(false);
  });

  it("stops asking a client that left", () => {
    const { book: attention } = book();
    attention.report("a", { focused: true, threadId: "t1" });
    attention.leave("a");
    expect(attention.visible("t1")).toBe(false);
  });
});
