import { describe, expect, it } from "vitest";
import { EnvironmentThreadWatches, THREAD_WATCH_LEASE_MS, THREAD_WATCH_THROTTLE_MS } from "./environment-thread-watch.js";

function harness() {
  let now = 1_000;
  const timers = new Map<number, { at: number; run(): void }>();
  let next = 0;
  const resubscribed: string[] = [];
  const published: Array<[string, string, number]> = [];
  const watches = new EnvironmentThreadWatches({
    resubscribe: (machine) => resubscribed.push(machine),
    publish: (machine, sessionId) => published.push([machine, sessionId, watches.get(machine, sessionId)!.revision]),
    now: () => now,
    setTimer: (run, ms) => { next += 1; timers.set(next, { at: now + ms, run }); return next; },
    clearTimer: (handle) => { timers.delete(handle as number); },
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = until;
  };
  return { watches, resubscribed, published, advance };
}

describe("threads a page looks in on", () => {
  it("subscribes once per thread and lets a watch go when the page stops renewing it", () => {
    const { watches, resubscribed, advance } = harness();
    expect(watches.watch("rex", "t1")).toBe(true);
    expect(watches.watch("rex", "t1")).toBe(false);
    expect(watches.threads("rex")).toEqual(["t1"]);
    expect(resubscribed).toEqual(["rex"]);
    advance(THREAD_WATCH_LEASE_MS - 1);
    watches.watch("rex", "t1");
    advance(THREAD_WATCH_LEASE_MS - 1);
    expect(watches.threads("rex")).toEqual(["t1"]);
    advance(1);
    expect(watches.threads("rex")).toEqual([]);
    expect(resubscribed).toEqual(["rex", "rex"]);
  });

  it("folds a stream's pushes into a few changes a second, and only for watched threads", () => {
    const { watches, published, advance } = harness();
    watches.watch("rex", "t1");
    watches.onPush("rex", { type: "assistant-delta", sessionId: "t1", id: "a", delta: "x" });
    // Never within the push itself: the connection applies an index change after handing it on.
    expect(published).toEqual([]);
    advance(0);
    expect(published).toEqual([["rex", "t1", 1]]);
    for (let index = 0; index < 5; index += 1) watches.onPush("rex", { type: "tool-update", sessionId: "t1", id: "tool", partial: {} });
    watches.onPush("rex", { type: "assistant-delta", sessionId: "t2", id: "b", delta: "y" });
    watches.onPush("studio", { type: "assistant-delta", sessionId: "t1", id: "c", delta: "z" });
    advance(THREAD_WATCH_THROTTLE_MS - 1);
    expect(published).toHaveLength(1);
    advance(1);
    expect(published).toEqual([["rex", "t1", 1], ["rex", "t1", 6]]);
  });

  it("follows the thread's run state, its index entry and a question it asks and is answered", () => {
    const { watches, published, advance } = harness();
    watches.watch("rex", "t1");
    watches.onPush("rex", { type: "agent-status", sessionId: "t1", running: true });
    advance(THREAD_WATCH_THROTTLE_MS);
    watches.onPush("rex", { type: "host-update", update: { version: 1, type: "thread-shell", update: { sessionId: "t1" } } });
    advance(THREAD_WATCH_THROTTLE_MS);
    watches.onPush("rex", { type: "extension-ui-prompt", sessionId: "t1", prompt: { id: "q1", sessionId: "t1", kind: "input", title: "Name?" } });
    advance(THREAD_WATCH_THROTTLE_MS);
    expect(watches.get("rex", "t1")?.asking).toEqual({ id: "q1", title: "Name?" });
    // Another dialog's end leaves the question.
    watches.onPush("rex", { type: "extension-ui-resolved", id: "q0", sessionId: "t1" });
    watches.onPush("rex", { type: "extension-ui-resolved", id: "q1", sessionId: "t1" });
    advance(THREAD_WATCH_THROTTLE_MS);
    expect(watches.get("rex", "t1")?.asking).toBeUndefined();
    expect(published.map(([, , revision]) => revision)).toEqual([1, 2, 3, 4]);
  });

  it("reads again when the machine's connection changes, and forgets a question it can no longer vouch for", () => {
    const { watches, published, advance } = harness();
    watches.watch("rex", "t1");
    watches.onStatus("rex", "connected");
    watches.onPush("rex", { type: "extension-ui-prompt", sessionId: "t1", prompt: { id: "q1", sessionId: "t1", kind: "input", title: "Name?" } });
    advance(THREAD_WATCH_THROTTLE_MS);
    watches.onStatus("rex", "connected");
    watches.onStatus("rex", "offline");
    advance(THREAD_WATCH_THROTTLE_MS);
    expect(watches.get("rex", "t1")?.asking).toBeUndefined();
    expect(published).toHaveLength(2);
    watches.unwatch("rex", "t1");
    watches.onPush("rex", { type: "assistant-delta", sessionId: "t1", id: "a", delta: "x" });
    advance(THREAD_WATCH_THROTTLE_MS);
    expect(published).toHaveLength(2);
  });
});
