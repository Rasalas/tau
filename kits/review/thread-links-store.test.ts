import { expect, it, vi } from "vitest";
import { ThreadLinkRows } from "./thread-links-store.js";
import type { ThreadPullRequestLink } from "./protocol.js";

it("stops periodic reads for merged links and resumes after a host change", async () => {
  vi.useFakeTimers();
  try {
    const link = { url: "https://github.com/o/r/pull/1", state: "merged" } as ThreadPullRequestLink;
    const read = vi.fn().mockResolvedValue([link]);
    let changed!: (threadId: string) => void;
    const rows = new ThreadLinkRows({ links: read, onLinksChanged: (listener) => { changed = listener; return () => {}; } });
    await rows.load("thread");
    const unwatch = rows.watch("thread");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue([{ ...link, state: "open" }]);
    changed("thread");
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
    unwatch();
    rows.dispose();
  } finally { vi.useRealTimers(); }
});

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
