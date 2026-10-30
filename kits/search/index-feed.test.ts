import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient } from "tau";
import { MessageIndexFeed, indexStatusText, messageIndexNotice } from "./index-feed.js";
import type { MessageIndexStatus } from "./protocol.js";
const status = (update: Partial<MessageIndexStatus> = {}): MessageIndexStatus => ({ enabled: true, state: "indexing", done: 0, total: 412, bytes: 0, threads: 0, revision: 1, ...update });
afterEach(() => vi.useRealTimers());

describe("message index feed", () => {
  it("uses the required notices and machine-local settings wording", () => {
    expect(messageIndexNotice(status({ done: 120 }))).toBe("Indexing messages · 120 of 412 threads. Some results may be missing.");
    expect(messageIndexNotice(status({ enabled: false, state: "disabled" }))).toBe("Searching recent message text only. Turn on the message index in Settings → Threads.");
    expect(messageIndexNotice(status({ state: "error" }))).toBe("Message index unavailable. Searching recent message text only.");
    expect(messageIndexNotice(status({ state: "ready" }))).toBeUndefined();
    expect(indexStatusText(status({ state: "ready", threads: 412, bytes: 38_000_000 }))).toBe("Up to date · 412 threads · 38 MB");
    expect(indexStatusText(status({ state: "error", error: "Disk full" }))).toBe("Couldn't build the index: Disk full");
  });
  it("announces the latest progress at most once per five seconds and ignores stale replies", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let event!: (raw: unknown) => void;
    let resolve!: (raw: unknown) => void;
    const drop = vi.fn();
    const host = { invoke: () => new Promise(done => { resolve = done; }), onEvent: (_name, listener) => { event = listener; return drop; } } as HostExtensionClient;
    const feed = new MessageIndexFeed(host);
    const announce = vi.fn(); feed.subscribeStatus(announce);
    const loading = feed.load();
    event(status({ done: 20, revision: 2 }));
    resolve(status({ done: 0, revision: 1 })); await loading;
    expect(feed.snapshot().done).toBe(20);
    for (let done = 21; done < 120; done++) event(status({ done, revision: done }));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(feed.notice()).toContain("20 of 412");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(announce).toHaveBeenCalledTimes(2);
    expect(feed.notice()).toContain("119 of 412");
    event(status({ state: "ready", revision: 121 }));
    feed.dispose(); await vi.advanceTimersByTimeAsync(5_000);
    expect(announce).toHaveBeenCalledTimes(2); expect(drop).toHaveBeenCalledOnce();
  });
});

it("accepts a restarted host activation and ignores delayed updates from its predecessor", () => {
  const feed = new MessageIndexFeed({ onEvent: () => () => undefined } as unknown as HostExtensionClient);
  feed.accept(status({ activation: "old-host", revision: 99 }));
  feed.accept(status({ activation: "new-host", revision: 1, state: "ready" }));
  expect(feed.snapshot()).toMatchObject({ activation: "new-host", revision: 1, state: "ready" });
  feed.accept(status({ activation: "old-host", revision: 100 }));
  expect(feed.snapshot().activation).toBe("new-host"); feed.dispose();
});
