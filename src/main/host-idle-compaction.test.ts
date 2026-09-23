import { describe, expect, it, vi } from "vitest";
import { IdleHeapCompactor } from "./host-idle-compaction.js";

const MiB = 1024 * 1024;

function setup(options: { heap?: number } = {}) {
  let now = 0;
  let heap = options.heap ?? 40 * MiB;
  const collect = vi.fn(() => { heap = 45 * MiB; });
  const compactor = new IdleHeapCompactor({ quietMs: 2_000, minGrowthBytes: 32 * MiB, heapBytes: () => heap, collect, now: () => now });
  return {
    compactor,
    collect,
    advance: (ms: number) => { now += ms; },
    grow: (bytes: number) => { heap += bytes; },
  };
}

describe("IdleHeapCompactor", () => {
  it("compacts once the host has been quiet and the heap grew", () => {
    const { compactor, collect, advance, grow } = setup();
    grow(100 * MiB);
    advance(1_999);
    expect(compactor.tick()).toBe(false);
    advance(1);
    expect(compactor.tick()).toBe(true);
    expect(collect).toHaveBeenCalledTimes(1);
    // Nothing grew since: the next quiet tick leaves the heap alone.
    advance(10_000);
    expect(compactor.tick()).toBe(false);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it("leaves a heap that barely grew alone", () => {
    const { compactor, collect, advance, grow } = setup();
    grow(31 * MiB);
    advance(5_000);
    expect(compactor.tick()).toBe(false);
    expect(collect).not.toHaveBeenCalled();
  });

  it("waits while a call is in flight and after any activity", async () => {
    const { compactor, collect, advance, grow } = setup();
    grow(100 * MiB);
    let finish!: () => void;
    const call = compactor.during(() => new Promise<void>((resolve) => { finish = resolve; }));
    advance(10_000);
    expect(compactor.tick()).toBe(false);
    finish();
    await call;
    advance(1_000);
    expect(compactor.tick()).toBe(false);
    compactor.noteActivity();
    advance(1_999);
    expect(compactor.tick()).toBe(false);
    advance(1);
    expect(compactor.tick()).toBe(true);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it("brackets every method of a table and keeps its answers and errors", async () => {
    const { compactor } = setup();
    const during = vi.spyOn(compactor, "during");
    const methods = compactor.observe({
      ok: async (params) => params[0],
      fails: async () => { throw new Error("no"); },
    });
    const context = {} as Parameters<typeof methods.ok>[1];
    await expect(methods.ok(["a"], context)).resolves.toBe("a");
    await expect(methods.fails([], context)).rejects.toThrow("no");
    expect(during).toHaveBeenCalledTimes(2);
  });

  it("runs V8's own memory-reducing collector without --expose-gc", () => {
    const compactor = new IdleHeapCompactor({ quietMs: 0, minGrowthBytes: 0, heapBytes: () => 1 });
    expect(compactor.tick()).toBe(true);
  });
});
