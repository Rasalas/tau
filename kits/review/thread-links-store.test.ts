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
