import { afterEach, expect, it, vi } from "vitest";
import { HostPreparationQueue } from "./host-preparation-queue.js";
import { RuntimeCatalogs } from "./runtime-catalogs.js";

afterEach(() => vi.useRealTimers());

it.each([false, true])("honors catalog revalidation and disposal during a fingerprint check (dispose: %s)", async (dispose) => {
  vi.useFakeTimers();
  const queue = new HostPreparationQueue();
  let now = 0;
  let release!: (key: string) => void;
  const programKey = vi.fn(async () => "same").mockImplementationOnce(async () => "same")
    .mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
  const load = vi.fn(async () => ({ models: [], thinkingLevels: {} }));
  const source = { kind: "test", owner: {}, complete: true, load, programKey };
  const catalogs = new RuntimeCatalogs({ sources: () => [source], priceBook: async () => undefined,
    publish: () => {}, log: () => {}, automatic: true, startDelayMs: 1, preparation: queue, now: () => now });
  await catalogs.get("test");
  now = 3 * 60 * 60_000;
  catalogs.start();
  await vi.advanceTimersByTimeAsync(5);
  expect(programKey).toHaveBeenCalledTimes(2);
  await catalogs.list(true);
  if (dispose) catalogs.dispose();
  release("same");
  await vi.advanceTimersByTimeAsync(5);
  expect(load).toHaveBeenCalledTimes(dispose ? 1 : 2);
  catalogs.dispose();
  queue.dispose();
});

it("waits for foreground work, shares one background slot and promotes explicit demand", async () => {
  vi.useFakeTimers();
  let ready = false;
  const queue = new HostPreparationQueue(() => ready);
  const calls: string[] = [];
  let release!: () => void;
  const first = queue.schedule(async () => { calls.push("spare"); await new Promise<void>((done) => { release = done; }); return 1; });
  const second = queue.schedule(async () => { calls.push("neighbour"); return 2; });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(calls).toEqual([]);
  ready = true;
  await vi.advanceTimersByTimeAsync(100);
  expect(calls).toEqual(["spare"]);
  second.start();
  await expect(second.result).resolves.toBe(2);
  expect(calls).toEqual(["spare", "neighbour"]);
  release();
  await expect(first.result).resolves.toBe(1);
  queue.dispose();
});

it("cancels queued jobs and still progresses after a failed job", async () => {
  vi.useFakeTimers();
  const queue = new HostPreparationQueue();
  const failed = queue.schedule(async () => { throw new Error("broken"); });
  const rejection = expect(failed.result).rejects.toThrow("broken");
  const unused = vi.fn(async () => 2);
  const cancelled = queue.schedule(unused);
  cancelled.cancel();
  const next = queue.schedule(async () => 3);
  await vi.advanceTimersByTimeAsync(5);
  await rejection;
  await expect(cancelled.result).resolves.toBeUndefined();
  await expect(next.result).resolves.toBe(3);
  expect(unused).not.toHaveBeenCalled();
  queue.dispose();
});

it("catalog warming waits behind preparation, but an explicit catalog read stays immediate", async () => {
  vi.useFakeTimers();
  const queue = new HostPreparationQueue();
  let release!: () => void;
  const first = queue.schedule(async () => { await new Promise<void>((done) => { release = done; }); });
  const load = vi.fn(async () => ({ models: [], thinkingLevels: {} }));
  const source = { kind: "test", owner: {}, complete: true, load };
  const catalogs = new RuntimeCatalogs({ sources: () => [source], priceBook: async () => undefined,
    publish: () => {}, log: () => {}, automatic: true, startDelayMs: 1, preparation: queue });
  catalogs.start();
  await vi.advanceTimersByTimeAsync(10);
  expect(load).not.toHaveBeenCalled();
  await catalogs.get("test");
  expect(load).toHaveBeenCalledOnce();
  release();
  await first.result;
  await vi.advanceTimersByTimeAsync(10);
  expect(load).toHaveBeenCalledOnce();
  catalogs.dispose();
  queue.dispose();
});
