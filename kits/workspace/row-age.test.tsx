// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionAge } from "./navigation.js";
import { ROW_AGE_TICK_MS, useRowAge } from "./row-age.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("useRowAge", () => {
  it("keeps a row's age current while nothing else redraws the rail", () => {
    vi.useFakeTimers();
    const modifiedAt = Date.now() - 60_000;
    const first = renderHook(() => useRowAge(modifiedAt, sessionAge));
    const second = renderHook(() => useRowAge(modifiedAt - 3_600_000, sessionAge));
    expect(first.result.current).toBe("1m");
    expect(second.result.current).toBe("1h");
    act(() => { vi.advanceTimersByTime(3 * 60_000); });
    expect(first.result.current).toBe("4m");
    expect(second.result.current).toBe("1h");
    // One shared timer serves every row, and none runs once the rows are gone.
    expect(vi.getTimerCount()).toBe(1);
    first.unmount();
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads again no later than a tick after a minute turns", () => {
    vi.useFakeTimers();
    const modifiedAt = Date.now();
    const view = renderHook(() => useRowAge(modifiedAt, sessionAge));
    expect(view.result.current).toBe("now");
    act(() => { vi.advanceTimersByTime(60_000 + ROW_AGE_TICK_MS); });
    expect(view.result.current).toBe("1m");
  });
});
