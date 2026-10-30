import { describe, expect, it, vi } from "vitest";
import type { PaletteSearchContext, HostExtensionClient } from "tau";
import type { SearchHost } from "./dialogs.js";
import { MessageIndexFeed } from "./index-feed.js";
import { ThreadSearchFeed } from "./thread-search-feed.js";
import type { MessageIndexStatus, ThreadSearchPage } from "./protocol.js";
const status: MessageIndexStatus = { enabled: true, state: "indexing", done: 1, total: 2, threads: 0, bytes: 0, revision: 1 };

describe("thread search feed", () => {
  it("returns partial rows before completion and refreshes the same query without starting a second job", async () => {
    const controller = new AbortController();
    let resume!: (page: ThreadSearchPage) => void;
    const host = vi.fn(async (command: string, input: unknown) => {
      if (command !== "thread-search") return;
      if ((input as { continuation?: string }).continuation) return new Promise<ThreadSearchPage>(resolve => { resume = resolve; });
      return { matches: [{ sessionId: "first", path: "", role: "user", snippet: "beacon" }], complete: false, continuation: "next", status };
    });
    const index = new MessageIndexFeed({ invoke: vi.fn(), onEvent: () => () => undefined } as unknown as HostExtensionClient);
    const feed = new ThreadSearchFeed(host as SearchHost, index);
    const changed = vi.fn(); feed.subscribe(changed);
    const context = { signal: controller.signal } as PaletteSearchContext;
    const input = { query: "beacon", sessionIds: ["first", "second"] };
    expect((await feed.search(input, context)).map(match => match.sessionId)).toEqual(["first"]);
    expect((await feed.search(input, context)).map(match => match.sessionId)).toEqual(["first"]);
    expect(host.mock.calls.filter(([command]) => command === "thread-search")).toHaveLength(1);
    await vi.waitFor(() => expect(resume).toBeTypeOf("function"));
    resume({ matches: [{ sessionId: "second", path: "", role: "assistant", snippet: "beacon" }], complete: true, status: { ...status, state: "ready", revision: 2 } });
    await vi.waitFor(async () => expect((await feed.search(input, context))[0]?.sessionId).toBe("second"));
    expect(changed).toHaveBeenCalled();
    controller.abort(); feed.dispose(); index.dispose();
  });
  it("cancels an abandoned channel and ignores its late response", async () => {
    let resolve!: (page: ThreadSearchPage) => void;
    const host = vi.fn((command: string) => command === "thread-search" ? new Promise<ThreadSearchPage>(done => { resolve = done; }) : Promise.resolve());
    const index = new MessageIndexFeed({ onEvent: () => () => undefined } as unknown as HostExtensionClient);
    const feed = new ThreadSearchFeed(host as SearchHost, index);
    const controller = new AbortController();
    const request = feed.search({ query: "beacon" }, { signal: controller.signal } as PaletteSearchContext);
    controller.abort();
    resolve({ matches: [{ sessionId: "late", path: "", role: "user", snippet: "beacon" }], complete: true, status });
    await request;
    expect(host).toHaveBeenCalledWith("thread-search-cancel", { channel: expect.any(String) });
    expect(index.loaded).toBe(false);
    feed.dispose(); index.dispose();
  });
});

it("drops completed full-index rows immediately when indexing is disabled on another device", async () => {
  const host = vi.fn(async (command: string) => command === "thread-search" ? { matches: [{ sessionId: "full", path: "", role: "user", snippet: "middle beacon" }], complete: true, status: { ...status, state: "ready", revision: 2 } } : undefined);
  const index = new MessageIndexFeed({ onEvent: () => () => undefined } as unknown as HostExtensionClient);
  index.accept({ ...status, state: "ready", revision: 1 });
  const feed = new ThreadSearchFeed(host as SearchHost, index);
  const context = { signal: new AbortController().signal } as PaletteSearchContext;
  await feed.search({ query: "beacon" }, context);
  const changed = vi.fn(); feed.subscribe(changed);
  index.accept({ ...status, enabled: false, state: "disabled", revision: 3 });
  expect(host).toHaveBeenCalledWith("thread-search-cancel", { channel: expect.any(String) });
  expect(changed).toHaveBeenCalled();
  feed.dispose(); index.dispose();
});
