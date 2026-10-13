import { expect, it, vi } from "vitest";
import { ThreadLinkRows } from "./thread-links-store.js";

it("coalesces fresh reads arriving during a thread lookup and preserves force", async () => {
  let finish!: (links: []) => void;
  const read = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue([]);
  const stop = vi.fn();
  const rows = new ThreadLinkRows({ links: read, onLinksChanged: () => stop });
  const pending = rows.load("thread-a");
  await rows.load("thread-a", true);
  await rows.load("thread-a", "force");
  await rows.load("thread-a", true);
  expect(read).toHaveBeenCalledTimes(1);
  finish([]);
  await pending;
  expect(read.mock.calls).toEqual([["thread-a", undefined], ["thread-a", "force"]]);
  rows.dispose();
  expect(stop).toHaveBeenCalledOnce();
});

it("lets a read whose answer never comes stop holding back the next", async () => {
  vi.useFakeTimers();
  try {
    const read = vi.fn().mockImplementationOnce(() => new Promise(() => undefined)).mockResolvedValue([{ url: "https://github.com/o/r/pull/1", state: "merged" }]);
    const rows = new ThreadLinkRows({ links: read, onLinksChanged: () => () => undefined });
    const lost = rows.load("thread-a", true);
    await rows.load("thread-a", true);
    await vi.advanceTimersByTimeAsync(120_000);
    await lost;
    expect(read).toHaveBeenCalledTimes(2);
    expect(rows.get("thread-a")).toMatchObject([{ state: "merged" }]);
    rows.dispose();
  } finally {
    vi.useRealTimers();
  }
});
