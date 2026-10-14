import { afterEach, expect, it, vi } from "vitest";
import { ProviderReadCache } from "./provider-read-cache.js";

afterEach(() => vi.useRealTimers());

it("releases an expired answer even when no further lookup or wall clock advance occurs", async () => {
  vi.useFakeTimers();
  const cache = new ProviderReadCache(() => 0, 60_000);
  const read = vi.fn(async () => "diff");
  await cache.read("one", false, read, false);
  await cache.read("one", false, read, false);
  expect(read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  await cache.read("one", false, read, false);
  expect(read).toHaveBeenCalledTimes(2);
  cache.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds retained payload while leaving callers' answers intact", async () => {
  const cache = new ProviderReadCache(Date.now, 60_000, 2, 12);
  const read = vi.fn(async () => "1234");
  await cache.read("one", false, read, false);
  await cache.read("two", false, read, false);
  await cache.read("one", false, read, false);
  expect(read).toHaveBeenCalledTimes(3);
  const oversized = vi.fn(async () => "too large for this cache");
  expect(await cache.read("big", false, oversized, false)).toContain("too large");
  await cache.read("big", false, oversized, false);
  expect(oversized).toHaveBeenCalledTimes(2);
  cache.dispose();
});

it("evicts the least recently used entry when the entry limit is reached", async () => {
  const cache = new ProviderReadCache(Date.now, 60_000, 2);
  const read = vi.fn(async () => "answer");
  await cache.read("one", false, read, false);
  await cache.read("two", false, read, false);
  await cache.read("one", false, read, false);
  await cache.read("three", false, read, false);
  await cache.read("one", false, read, false);
  expect(read).toHaveBeenCalledTimes(3);
  await cache.read("two", false, read, false);
  expect(read).toHaveBeenCalledTimes(4);
  cache.dispose();
});

it("coalesces refreshes and never lets an old failure evict their replacement", async () => {
  const cache = new ProviderReadCache(Date.now);
  let reject!: (error: Error) => void;
  const old = cache.read("key", false, () => new Promise<string>((_done, fail) => { reject = fail; }), false);
  let resolve!: (value: string) => void;
  const next = cache.read("key", true, () => new Promise<string>((done) => { resolve = done; }), true);
  const unused = vi.fn(async () => "unused");
  expect(cache.read("key", true, unused, true)).toBe(next);
  reject(new Error("old"));
  await expect(old).rejects.toThrow("old");
  resolve("current");
  await next;
  expect(await cache.read("key", false, unused, false)).toBe("current");
  expect(unused).not.toHaveBeenCalled();
  cache.dispose();
});
