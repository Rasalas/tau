// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockSnapshot } from "../workbench/app-state";
import { createMemoryStorage } from "../workbench/client-storage";
import { ThreadStore } from "../workbench/thread-store";
import { ThreadViewStore } from "../workbench/thread-view-store";
import { readCachedTurnActivity, writeCachedTurnActivity } from "../workbench/turn-activity";
import { createLocalStorageAdapter } from "./browser-storage";
import { useTurnActivityCache } from "./use-turn-activity-cache";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  vi.useFakeTimers();
  const storage = createMemoryStorage();
  const view = new ThreadViewStore({ ...mockSnapshot, sessionId: "session" });
  const threads = new ThreadStore();
  threads.setActiveThread("session");
  const rendered = renderHook(() => useTurnActivityCache(view, storage, threads));
  act(() => {
    threads.setThreadRunning("session", true);
    view.dispatch({ type: "agent-status", sessionId: "session", running: true });
    view.dispatch({ type: "tool-start", sessionId: "session", tool: { id: "tool", name: "bash", args: {}, status: "running", startedAt: 1, output: "first" } });
  });
  const persisted = () => readCachedTurnActivity({ ...storage }, "session");
  return { ...rendered, storage, view, threads, persisted };
}

describe("turn activity persistence lifecycle", () => {
  it("keeps the same thread id on two machines separate, including pruning and reloads", () => {
    const memory = createMemoryStorage();
    vi.stubGlobal("localStorage", {
      getItem: memory.get,
      setItem: memory.set,
      removeItem: memory.remove,
      key: (index: number) => memory.keys()[index] ?? null,
      get length() { return memory.keys().length; },
    });
    const own = createLocalStorageAdapter();
    const remote = createLocalStorageAdapter("remote");
    const ownView = new ThreadViewStore({ ...mockSnapshot, sessionId: "session" });
    const remoteView = new ThreadViewStore({ ...mockSnapshot, sessionId: "session" });
    const threads = new ThreadStore();
    const first = renderHook(() => useTurnActivityCache(ownView, own, threads));
    const second = renderHook(() => useTurnActivityCache(remoteView, remote, threads));
    act(() => {
      for (const [view, output] of [[ownView, "own"], [remoteView, "remote"]] as const) {
        view.dispatch({ type: "agent-status", sessionId: "session", running: true });
        view.setTools([{ id: "tool", name: "read", args: {}, status: "done", startedAt: 1, output }]);
      }
    });
    first.unmount();
    second.unmount();
    expect(readCachedTurnActivity(createLocalStorageAdapter(), "session")?.tools[0].output).toBe("own");
    expect(readCachedTurnActivity(createLocalStorageAdapter("remote"), "session")?.tools[0].output).toBe("remote");
    expect(own.keys()).toHaveLength(1);
    expect(remote.keys()).toHaveLength(1);
    for (let index = 0; index < 12; index += 1) writeCachedTurnActivity(remote, { sessionId: `other-${index}`, tools: [] });
    expect(readCachedTurnActivity(createLocalStorageAdapter("remote"), "session")).toBeUndefined();
    expect(readCachedTurnActivity(createLocalStorageAdapter(), "session")?.tools[0].output).toBe("own");
  });

  it("does not flush the visible run when a background run ends", async () => {
    const { storage, threads } = setup();
    await act(async () => {
      threads.setThreadRunning("background", true);
      threads.setThreadRunning("background", false);
      await Promise.resolve();
    });
    expect(storage.keys()).toEqual([]);
  });

  it("flushes the final animation-frame output after the run ends", async () => {
    const { storage, view, threads, persisted } = setup();
    act(() => view.dispatch({ type: "tool-update", sessionId: "session", id: "tool", output: "final pending output" }));
    expect(storage.keys()).toEqual([]);
    await act(async () => {
      threads.setThreadRunning("session", false);
      view.dispatch({ type: "agent-status", sessionId: "session", running: false });
      await Promise.resolve();
    });
    expect(persisted()?.tools[0].output).toBe("final pending output");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes the latest turn when the page becomes hidden, and skips unchanged repeats", () => {
    const { storage, view, persisted } = setup();
    const set = vi.spyOn(storage, "set");
    act(() => view.dispatch({ type: "tool-update", sessionId: "session", id: "tool", output: "last frame before hiding" }));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(persisted()?.tools[0].output).toBe("last frame before hiding");
    expect(set).toHaveBeenCalledOnce();
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(set).toHaveBeenCalledOnce();
  });

  it("flushes on pagehide and removes subscriptions and timers on unmount", () => {
    const { storage, unmount, threads, persisted } = setup();
    const set = vi.spyOn(storage, "set");
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(persisted()?.tools[0].output).toBe("first");
    unmount();
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
      threads.setThreadRunning("session", false);
      vi.advanceTimersByTime(2_000);
    });
    expect(set).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("persists a pending update on unmount", () => {
    const { unmount, view, persisted } = setup();
    act(() => view.dispatch({ type: "tool-update", sessionId: "session", id: "tool", output: "last frame before unmount" }));
    unmount();
    expect(persisted()?.tools[0].output).toBe("last frame before unmount");
  });
});
