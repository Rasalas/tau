import { describe, expect, it, vi } from "vitest";
import { FollowUpQueueStore } from "./follow-up-queue";

describe("FollowUpQueueStore", () => {
  it("keeps one ordered queue per thread and notifies on every change", () => {
    const store = new FollowUpQueueStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const first = store.enqueue("a", { text: "first", attachments: [] });
    const second = store.enqueue("a", { text: "second", attachments: [] });
    store.enqueue("b", { text: "other", attachments: [] });

    expect(store.list("a").map((entry) => entry.text)).toEqual(["first", "second"]);
    expect(store.list("b").map((entry) => entry.text)).toEqual(["other"]);
    expect(store.sessionIds()).toEqual(["a", "b"]);
    expect(listener).toHaveBeenCalledTimes(3);

    store.move("a", second.id, 0);
    expect(store.list("a").map((entry) => entry.text)).toEqual(["second", "first"]);
    store.move("a", first.id, 99);
    expect(store.list("a").map((entry) => entry.text)).toEqual(["second", "first"]);

    expect(store.shift("a")?.id).toBe(second.id);
    expect(store.remove("a", first.id)?.id).toBe(first.id);
    expect(store.list("a")).toEqual([]);
    expect(store.sessionIds()).toEqual(["b"]);
  });

  it("pauses a thread after a rejected delivery until its queue changes", () => {
    const store = new FollowUpQueueStore();
    const item = store.enqueue("a", { text: "first", attachments: [] });
    store.shift("a");
    store.unshift("a", item);
    store.pause("a");
    expect(store.isPaused("a")).toBe(true);

    store.enqueue("a", { text: "second", attachments: [] });
    expect(store.isPaused("a")).toBe(false);
    store.pause("a");
    store.resume("a");
    expect(store.isPaused("a")).toBe(false);
  });
});
