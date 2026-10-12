import { afterEach, expect, it, vi } from "vitest";
import { followWorkbenchBootstrap } from "./workbench-bootstrap";
import type { HostBootstrap } from "../shared/contracts";
import type { HostConnectionState } from "./host-connection";

afterEach(() => vi.useRealTimers());

it("retries a timed-out initial load even when the connection stays connected", async () => {
  vi.useFakeTimers();
  const bootstrap = vi.fn()
    .mockRejectedValueOnce(new Error("Request timed out"))
    .mockResolvedValue({} as HostBootstrap);
  const applyBootstrap = vi.fn(() => true);
  const onLoaded = vi.fn();
  const stop = followWorkbenchBootstrap({
    bootstrap,
    onConnectionState: () => () => {},
    watchThread: () => () => {},
    limitPushesToWatched: () => {},
  }, {
    history: { beginBootstrap: () => ({}), isCurrentBootstrap: () => true } as never,
    threads: { getSnapshot: () => ({}), subscribe: () => () => {} } as never,
    applyBootstrap,
  }, vi.fn(), onLoaded);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(applyBootstrap).toHaveBeenCalledOnce();
  expect(onLoaded).toHaveBeenCalledOnce();
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
  const stop = followWorkbenchBootstrap({
    bootstrap,
    onConnectionState: (listener) => { connected = listener; return () => {}; },
    watchThread: () => () => {},
    limitPushesToWatched: () => {},
  }, {
    history: { beginBootstrap: () => ({}), isCurrentBootstrap: () => true } as never,
    threads: { getSnapshot: () => ({}), subscribe: () => () => {} } as never,
    applyBootstrap,
  }, vi.fn());
  connected("connected");
  reject(new Error("The connection dropped"));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(applyBootstrap).toHaveBeenCalledOnce();
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
