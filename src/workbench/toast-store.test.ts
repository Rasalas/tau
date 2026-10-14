import { describe, expect, it, vi } from "vitest";
import { ToastStore, tapActionOf } from "./toast-store";

/** A clock the test moves by hand: timers fire only when `advance` passes them. */
function manualClock() {
  let now = 0;
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  const schedule = (run: () => void, ms: number) => {
    const timer = { at: now + ms, run, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers.filter((entry) => !entry.cancelled && entry.at <= now)) {
      timer.cancelled = true;
      timer.run();
    }
  };
  return { schedule, advance, now: () => now };
}

const ids = (store: ToastStore) => store.getToasts().map((toast) => toast.id);

describe("ToastStore", () => {
  it("shows the newest first and lets a toast go after five seconds", () => {
    const clock = manualClock();
    const store = new ToastStore(clock);
    store.show({ id: "a", description: "first" });
    clock.advance(2_000);
    store.show({ id: "b", description: "second" });
    expect(ids(store)).toEqual(["b", "a"]);
    clock.advance(3_000);
    expect(ids(store)).toEqual(["b"]);
    clock.advance(2_000);
    expect(ids(store)).toEqual([]);
  });

  it("stops every clock while held and runs on with the time that was left", () => {
    const clock = manualClock();
    const store = new ToastStore(clock);
    store.show({ id: "a" });
    clock.advance(4_000);
    store.hold("hover");
    clock.advance(60_000);
    expect(ids(store)).toEqual(["a"]);
    store.hold("focus");
    store.release("hover");
    clock.advance(60_000);
    expect(ids(store)).toEqual(["a"]);
    store.release("focus");
    clock.advance(999);
    expect(ids(store)).toEqual(["a"]);
    clock.advance(1);
    expect(ids(store)).toEqual([]);
  });

  it("gives a covered toast its whole time again instead of letting it go unseen", () => {
    const clock = manualClock();
    const store = new ToastStore(clock);
    let covered = true;
    const stop = store.deferExpiry(() => covered);
    store.show({ id: "a" });
    clock.advance(5_000);
    expect(ids(store)).toEqual(["a"]);
    covered = false;
    clock.advance(4_999);
    expect(ids(store)).toEqual(["a"]);
    clock.advance(1);
    expect(ids(store)).toEqual([]);
    stop();
    store.show({ id: "b" });
    covered = true;
    clock.advance(5_000);
    expect(ids(store)).toEqual([]);
  });

  it("keeps the ones beyond the visible three waiting, their clocks stopped", () => {
    const clock = manualClock();
    const store = new ToastStore(clock);
    store.show({ id: "a" });
    store.show({ id: "b" });
    store.show({ id: "c" });
    store.show({ id: "d", timeoutMs: 12_000 });
    clock.advance(5_000);
    // "a" was pushed out of sight before its time ran; it comes back with all five seconds.
    expect(ids(store)).toEqual(["d", "a"]);
    clock.advance(4_999);
    expect(ids(store)).toEqual(["d", "a"]);
    clock.advance(1);
    expect(ids(store)).toEqual(["d"]);
    clock.advance(2_000);
    expect(ids(store)).toEqual([]);
  });

  it("replaces a toast shown again under its id and starts its time again", () => {
    const clock = manualClock();
    const store = new ToastStore(clock);
    store.show({ id: "notice", description: "one" });
    clock.advance(4_000);
    store.show({ id: "notice", description: "two" });
    clock.advance(4_000);
    expect(store.getToasts()).toMatchObject([{ id: "notice", description: "two" }]);
  });

  it("keeps a sticky or loading toast until it is dismissed or turns into something else", () => {
    const clock = manualClock();
    const store = new ToastStore(clock);
    const onClose = vi.fn();
    store.show({ id: "update", timeoutMs: 0, onClose });
    const work = store.show({ id: "work", type: "loading", title: "Cloning…" });
    clock.advance(60_000);
    expect(ids(store)).toEqual(["work", "update"]);
    work.update({ type: "success", title: "Cloned" });
    clock.advance(5_000);
    expect(ids(store)).toEqual(["update"]);
    store.dismiss("update");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ids(store)).toEqual([]);
  });

  it("keeps an error until it is dismissed, unless it names a time", () => {
    const clock = manualClock();
    const store = new ToastStore(clock);
    store.show({ id: "failed", type: "error", description: "Push rejected" });
    store.show({ id: "timed", type: "error", description: "Build failed", timeoutMs: 8_000 });
    store.show({ id: "info", description: "Saved" });
    clock.advance(5_000);
    expect(ids(store)).toEqual(["timed", "failed"]);
    clock.advance(3_000);
    expect(ids(store)).toEqual(["failed"]);
    clock.advance(60_000);
    expect(ids(store)).toEqual(["failed"]);
    store.dismiss("failed");
    expect(ids(store)).toEqual([]);
  });

  it("keeps a loading toast that fails, and one that is replaced by an error", () => {
    const clock = manualClock();
    const store = new ToastStore(clock);
    store.show({ id: "work", type: "loading", title: "Pushing…" }).update({ type: "error", title: "Push failed" });
    store.show({ id: "info", description: "Saved" });
    store.show({ id: "info", type: "error", description: "Saved nothing" });
    clock.advance(60_000);
    expect(ids(store)).toEqual(["info", "work"]);
  });
});

describe("tapActionOf", () => {
  const open = { label: "Details", opens: true, run: () => undefined };
  const undo = { label: "Undo", run: () => undefined };

  it("is the only action, when it only opens something", () => {
    expect(tapActionOf({ type: "error", actions: [open] })).toBe(open);
    expect(tapActionOf({ type: "success", actions: [{ ...open, keepOpen: true }] })).toMatchObject({ label: "Details" });
  });

  it("is nothing for an action that does something, two actions, a question or no actions", () => {
    expect(tapActionOf({ type: "success", actions: [undo] })).toBeUndefined();
    expect(tapActionOf({ type: "info", actions: [open, { ...open, label: "Machines" }] })).toBeUndefined();
    expect(tapActionOf({ type: "info", actions: [open, undo] })).toBeUndefined();
    expect(tapActionOf({ type: "question", actions: [open] })).toBeUndefined();
    expect(tapActionOf({ type: "info", actions: [] })).toBeUndefined();
    expect(tapActionOf({ type: "info" })).toBeUndefined();
  });
});
