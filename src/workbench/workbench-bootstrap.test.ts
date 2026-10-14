import { afterEach, expect, it, vi } from "vitest";
import { followWorkbenchBootstrap } from "./workbench-bootstrap";
import type { HostBootstrap } from "../shared/contracts";
import type { HostConnectionState } from "./host-connection";

afterEach(() => vi.useRealTimers());

it("silently retries a dropped read by code even before a connection-state callback arrives", async () => {
  vi.useFakeTimers();
  const bootstrap = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error("A replacement link is opening."), { code: "connection-dropped" }))
    .mockResolvedValue({} as HostBootstrap);
  const applyBootstrap = vi.fn(() => true);
  const onError = vi.fn();
  const stop = followWorkbenchBootstrap({
    bootstrap, onConnectionState: () => () => {}, watchThread: () => () => {}, limitPushesToWatched: () => {},
  }, {
    history: { beginBootstrap: () => ({}), isCurrentBootstrap: () => true } as never,
    threads: { getSnapshot: () => ({}), subscribe: () => () => {} } as never,
    applyBootstrap,
  }, onError);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(applyBootstrap).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  stop();
});

it.each([3_000, 30_000])("retries an initial load timed out after %d ms without notifying the user", async (timeoutMs) => {
  vi.useFakeTimers();
  const bootstrap = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error(`timeout: request timed out after ${timeoutMs}ms`), { code: "timeout" }))
    .mockResolvedValue({} as HostBootstrap);
  const applyBootstrap = vi.fn(() => true);
  const onLoaded = vi.fn();
  const onError = vi.fn();
  const stop = followWorkbenchBootstrap({
    bootstrap,
    onConnectionState: () => () => {},
    watchThread: () => () => {},
    limitPushesToWatched: () => {},
  }, {
    history: { beginBootstrap: () => ({}), isCurrentBootstrap: () => true } as never,
    threads: { getSnapshot: () => ({}), subscribe: () => () => {} } as never,
    applyBootstrap,
  }, onError, onLoaded);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(applyBootstrap).toHaveBeenCalledOnce();
  expect(onLoaded).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  stop();
});

it("does not lose recovery when connected arrives before the failed request settles", async () => {
  vi.useFakeTimers();
  let connected!: (state: HostConnectionState) => void;
  let reject!: (error: Error) => void;
  const bootstrap = vi.fn()
    .mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }))
    .mockResolvedValue({} as HostBootstrap);
  const applyBootstrap = vi.fn(() => true);
  const onError = vi.fn();
  const stop = followWorkbenchBootstrap({
    bootstrap,
    onConnectionState: (listener) => { connected = listener; return () => {}; },
    watchThread: () => () => {},
    limitPushesToWatched: () => {},
  }, {
    history: { beginBootstrap: () => ({}), isCurrentBootstrap: () => true } as never,
    threads: { getSnapshot: () => ({}), subscribe: () => () => {} } as never,
    applyBootstrap,
  }, onError);
  connected("reconnecting");
  connected("connected");
  reject(new Error("The connection dropped"));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(applyBootstrap).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  stop();
});

it("cancels retries when disposed", async () => {
  vi.useFakeTimers();
  const bootstrap = vi.fn().mockRejectedValue(new Error("Request timed out"));
  const stop = followWorkbenchBootstrap({
    bootstrap, onConnectionState: () => () => {}, watchThread: () => () => {}, limitPushesToWatched: () => {},
  }, {
    history: { beginBootstrap: () => ({}), isCurrentBootstrap: () => true } as never,
    threads: {} as never, applyBootstrap: vi.fn(),
  }, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  stop();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(bootstrap).toHaveBeenCalledOnce();
});

it("still reports a real bootstrap failure while retrying the read", async () => {
  vi.useFakeTimers();
  const bootstrap = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error("The thread index could not be read."), { code: "failed" }))
    .mockResolvedValue({} as HostBootstrap);
  const applyBootstrap = vi.fn(() => true);
  const onError = vi.fn();
  const stop = followWorkbenchBootstrap({
    bootstrap, onConnectionState: () => () => {}, watchThread: () => () => {}, limitPushesToWatched: () => {},
  }, {
    history: { beginBootstrap: () => ({}), isCurrentBootstrap: () => true } as never,
    threads: { getSnapshot: () => ({}), subscribe: () => () => {} } as never,
    applyBootstrap,
  }, onError);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(onError).toHaveBeenCalledExactlyOnceWith("The thread index could not be read.");
  expect(applyBootstrap).toHaveBeenCalledOnce();
  stop();
});

it("revalidates previously loaded content after reconnect", async () => {
  vi.useFakeTimers();
  let connection!: (state: HostConnectionState) => void;
  const bootstrap = vi.fn().mockResolvedValue({} as HostBootstrap);
  const onLoaded = vi.fn();
  const stop = followWorkbenchBootstrap({
    bootstrap, onConnectionState: (listener) => { connection = listener; return () => {}; },
    watchThread: () => () => {}, limitPushesToWatched: () => {},
  }, {
    history: { beginBootstrap: () => ({}), isCurrentBootstrap: () => true } as never,
    threads: { getSnapshot: () => ({}), subscribe: () => () => {} } as never,
    applyBootstrap: () => true,
  }, vi.fn(), onLoaded);
  await vi.advanceTimersByTimeAsync(0);
  connection("reconnecting");
  connection("connected");
  await vi.advanceTimersByTimeAsync(0);
  expect(bootstrap).toHaveBeenCalledTimes(2);
  expect(onLoaded).toHaveBeenCalledTimes(2);
  stop();
});

it("ignores duplicate connected notifications while an initial read is pending", async () => {
  let connection!: (state: HostConnectionState) => void;
  let resolve!: (value: HostBootstrap) => void;
  const bootstrap = vi.fn(() => new Promise<HostBootstrap>((done) => { resolve = done; }));
  const applied = vi.fn(() => true);
  const stop = followWorkbenchBootstrap({
    bootstrap, onConnectionState: (listener) => { connection = listener; return () => {}; },
    watchThread: () => () => {}, limitPushesToWatched: () => {},
  }, {
    history: { beginBootstrap: () => ({}), isCurrentBootstrap: () => true } as never,
    threads: { getSnapshot: () => ({}), subscribe: () => () => {} } as never,
    applyBootstrap: applied,
  }, vi.fn());
  connection("connected");
  resolve({} as HostBootstrap);
  await Promise.resolve();
  expect(applied).toHaveBeenCalledOnce();
  expect(bootstrap).toHaveBeenCalledOnce();
  stop();
});
