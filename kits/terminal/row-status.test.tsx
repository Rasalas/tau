// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRowStatus, busyShells, runningShells, shellLabel, watchForegrounds } from "./row-status.js";
import { terminalStore } from "./store.js";

afterEach(() => { cleanup(); terminalStore.forgetSessions(); busyShells.set(new Set()); vi.useRealTimers(); });

const shell = (id: string, sessionId?: string, exitCode?: number) => ({ id, label: id, cols: 80, rows: 24, ...(sessionId ? { sessionId } : {}), ...(exitCode === undefined ? {} : { exitCode }) });

describe("the terminal mark on a rail row", () => {
  it("counts a thread's live shells that run a program", () => {
    const busy = new Set(["1", "2", "3"]);
    expect(runningShells([shell("1", "a"), shell("2", "a", 0), shell("3", "b"), shell("4", "a")], busy, "a")).toBe(1);
    expect(shellLabel(2)).toBe("2 terminal processes running");
  });

  it("asks only a thread's live shells, and the mark follows what they run", async () => {
    vi.useFakeTimers();
    const running = new Set<string>();
    const foreground = vi.fn(async (id: string) => (running.has(id) ? { process: "npm" } : {}));
    const stop = watchForegrounds(foreground, 1_000);
    const view = render(<TerminalRowStatus session={{ id: "a" }} />);
    act(() => terminalStore.setSessions([shell("1", "a"), shell("2", "a"), shell("3"), shell("4", "a", 0)]));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(foreground.mock.calls.map((call) => call[0])).toEqual(["1", "2"]);
    expect(view.queryByRole("img")).toBeNull();
    running.add("1").add("2");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const mark = view.getByRole("img", { name: "2 terminal processes running" });
    expect(mark.textContent).toBe("2");
    running.clear();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(view.queryByRole("img")).toBeNull();
    stop();
  });
});
