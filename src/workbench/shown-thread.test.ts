import { describe, expect, it } from "vitest";
import { followShownThread } from "./shown-thread";

function fakeThreads(active: string) {
  const listeners = new Set<() => void>();
  let snapshot = { activeThreadId: active };
  return {
    getSnapshot: () => snapshot as never,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    show(id: string) { snapshot = { activeThreadId: id }; for (const listener of listeners) listener(); },
  };
}

function fakeClient() {
  const watched = new Map<string, number>();
  let limited = 0;
  return {
    watched,
    limited: () => limited,
    watchThread(id: string) {
      watched.set(id, (watched.get(id) ?? 0) + 1);
      return () => { const left = watched.get(id)! - 1; if (left) watched.set(id, left); else watched.delete(id); };
    },
    limitPushesToWatched() { limited += 1; },
  };
}

describe("followShownThread", () => {
  it("watches the thread on screen, one at a time, and limits pushes once it knows one", () => {
    const threads = fakeThreads("s1");
    const client = fakeClient();
    const stop = followShownThread(client, threads);
    expect([...client.watched.keys()]).toEqual(["s1"]);
    expect(client.limited()).toBeGreaterThan(0);
    threads.show("s2");
    expect([...client.watched.keys()]).toEqual(["s2"]);
    // A new draft on screen keeps the last thread: its turn may still be streaming there.
    threads.show("");
    expect([...client.watched.keys()]).toEqual(["s2"]);
    stop();
    expect(client.watched.size).toBe(0);
  });

  it("does not limit pushes while no thread is known", () => {
    const threads = fakeThreads("");
    const client = fakeClient();
    followShownThread(client, threads);
    expect(client.limited()).toBe(0);
    threads.show("s1");
    expect(client.limited()).toBe(1);
  });
});
