import { afterEach, expect, it, vi } from "vitest";
import { ConnectionTimers } from "./connection-timers.js";

let timers: ConnectionTimers | undefined;
afterEach(() => { timers?.close(); timers = undefined; vi.useRealTimers(); });

it("preserves the remaining deadline and gives a request made during sleep its full active time", async () => {
  vi.useFakeTimers();
  timers = new ConnectionTimers();
  const old = vi.fn();
  const queued = vi.fn();
  timers.after(10_000, old);
  await vi.advanceTimersByTimeAsync(4_000);
  timers.pause();
  timers.after(10_000, queued);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  timers.pause();
  expect(old).not.toHaveBeenCalled();
  timers.resume();
  await vi.advanceTimersByTimeAsync(5_999);
  expect(old).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(old).toHaveBeenCalledTimes(1);
  expect(queued).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(queued).toHaveBeenCalledTimes(1);
});

it("excludes an unannounced process freeze before its first overdue deadline can fire", async () => {
  vi.useFakeTimers();
  const resumed = vi.fn();
  timers = new ConnectionTimers({ onGap: resumed });
  const expired = vi.fn();
  timers.after(10_000, expired);
  await vi.advanceTimersByTimeAsync(4_000);
  vi.setSystemTime(Date.now() + 5 * 60_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(resumed).toHaveBeenCalledTimes(1);
  expect(expired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(6_000);
  expect(expired).toHaveBeenCalledTimes(1);
});

it("cancels paused deadlines and removes its clock when the connection closes", async () => {
  vi.useFakeTimers();
  timers = new ConnectionTimers();
  const expired = vi.fn();
  const deadline = timers.after(10_000, expired);
  timers.pause();
  timers.cancel(deadline);
  timers.resume();
  timers.after(10_000, expired);
  timers.close();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(expired).not.toHaveBeenCalled();
});

it("does not expire a new request early when the system clock was corrected backwards", async () => {
  vi.useFakeTimers();
  timers = new ConnectionTimers();
  const old = vi.fn();
  const fresh = vi.fn();
  timers.after(10_000, old);
  await vi.advanceTimersByTimeAsync(4_000);
  vi.setSystemTime(Date.now() - 60_000);
  timers.after(5_000, fresh);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(old).not.toHaveBeenCalled();
  expect(fresh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fresh).toHaveBeenCalledTimes(1);
});
