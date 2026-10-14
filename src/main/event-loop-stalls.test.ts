import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLoopStallHistory } from "./event-loop-stalls.js";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("host event-loop stall history", () => {
  it("retains scheduling stalls with bounded context and protects the history from consumers", async () => {
    vi.useFakeTimers();
    let now = 0;
    let utilization = { active: 0, idle: 0 };
    const logger = vi.fn();
    const events = Array.from({ length: 50 }, (_, i) => ({ label: `${i} ${"x".repeat(300)}`, timestamp: i }));
    const monitor = new EventLoopStallHistory({ now: () => now, wallNow: () => 10_000 + now, utilization: () => utilization, recentEvents: () => events, onStall: logger });
    monitor.start();
    monitor.start();
    expect(vi.getTimerCount()).toBe(1);
    now = 350;
    utilization = { active: 300, idle: 50 };
    await vi.advanceTimersByTimeAsync(100);
    const history = monitor.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ observedAt: 10_350, delayMs: 250, sampleWindowMs: 350, utilization: 300 / 350 });
    expect(history[0]?.recentEvents).toHaveLength(10);
    expect(history[0]?.recentEvents[0]?.label.length).toBe(120);
    history[0]!.recentEvents[0]!.label = "mutated";
    history[0]!.delayMs = 0;
    expect(monitor.getHistory()[0]?.delayMs).toBe(250);
    expect(monitor.getHistory()[0]?.recentEvents[0]?.label).not.toBe("mutated");
    // No backlog of catch-up stall records after one delayed callback.
    await vi.advanceTimersByTimeAsync(400);
    expect(logger).toHaveBeenCalledOnce();
    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops old history by age and keeps only the newest bounded records", async () => {
    vi.useFakeTimers();
    let now = 0;
    const monitor = new EventLoopStallHistory({ limit: 2, maxAgeMs: 2_000, now: () => now, wallNow: () => now, utilization: () => ({ active: 0, idle: 0 }) });
    monitor.start();
    for (const at of [300, 600, 900]) { now = at; await vi.advanceTimersByTimeAsync(100); }
    expect(monitor.getHistory().map((entry) => entry.observedAt)).toEqual([600, 900]);
    now = 3_000;
    expect(monitor.getHistory()).toEqual([]);
    monitor.stop();
  });

  it("uses monotonic delay even if the wall clock jumps, and resumes cleanly after stop", async () => {
    vi.useFakeTimers();
    let now = 0;
    let wall = 5_000;
    const monitor = new EventLoopStallHistory({ now: () => now, wallNow: () => wall });
    monitor.start();
    now = 100; wall = 50_000;
    await vi.advanceTimersByTimeAsync(100);
    expect(monitor.getHistory()).toEqual([]);
    monitor.stop();
    now = 10_000;
    monitor.start();
    now = 10_100;
    await vi.advanceTimersByTimeAsync(100);
    expect(monitor.getHistory()).toEqual([]);
    monitor.stop();
  });

  it("keeps monitoring after logger failure and permits stopping inside a stall callback", async () => {
    vi.useFakeTimers();
    let now = 0;
    const monitor = new EventLoopStallHistory({ now: () => now, onStall: () => { monitor.stop(); throw new Error("logger unavailable"); } });
    monitor.start();
    now = 300;
    await vi.advanceTimersByTimeAsync(100);
    expect(monitor.getHistory()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("keeps a single timer when a stall callback restarts the monitor", async () => {
  vi.useFakeTimers();
  let now = 0;
  const monitor = new EventLoopStallHistory({ now: () => now, onStall: () => { monitor.stop(); monitor.start(); } });
  monitor.start();
  now = 300;
  await vi.advanceTimersByTimeAsync(100);
  expect(vi.getTimerCount()).toBe(1);
  now = 400;
  await vi.advanceTimersByTimeAsync(100);
  expect(monitor.getHistory()).toHaveLength(1);
  monitor.stop();
});
