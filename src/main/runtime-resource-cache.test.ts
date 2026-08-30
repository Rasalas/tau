import { describe, expect, it } from "vitest";
import { RuntimeResourceCache, runtimeResourceFingerprint } from "./runtime-resource-cache.js";

describe("runtime resource cache", () => {
  it("fingerprints nested configuration independent of object key order", () => {
    expect(runtimeResourceFingerprint({ cwd: "/a", settings: { b: 2, a: 1 }, extensions: [], providerState: {} }))
      .toBe(runtimeResourceFingerprint({ providerState: {}, extensions: [], settings: { a: 1, b: 2 }, cwd: "/a" }));
  });

  it("does not retain failed creation", async () => {
    const cache = new RuntimeResourceCache<number>();
    await expect(cache.getOrCreate("broken", async () => { throw new Error("discovery failed"); })).rejects.toThrow("discovery failed");
    expect(cache.get("broken")).toBeUndefined();
  });

  it("is bounded and expires entries", () => {
    let now = 0;
    const cache = new RuntimeResourceCache<number>({ maxEntries: 2, ttlMs: 10, now: () => now });
    cache.set("a", 1); cache.set("b", 2); cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(2);
    now = 11;
    expect(cache.get("b")).toBeUndefined();
    expect(cache.size).toBe(1);
  });
});
