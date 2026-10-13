import { afterEach, describe, expect, it, vi } from "vitest";
import { openDisplayPreview } from "./display-smoke-preview.mjs";

const unavailable = new Error("internal: Preview is unavailable because no Tau desktop window on the thread's home machine can draw it.");
const url = "http://127.0.0.1:1234/";
afterEach(() => vi.useRealTimers());

describe("display smoke preview readiness", () => {
  it("waits when the window half connects before its browser window exists", async () => {
    vi.useFakeTimers();
    let drawable = false;
    const preview = vi.fn(async () => {
      if (!drawable) throw unavailable;
      return { url };
    });
    const log = vi.fn();
    const answer = openDisplayPreview(preview, url, { log, windowState: () => "pid 42 running" })
      .then((value) => ({ value }), (error) => ({ error }));
    await vi.advanceTimersByTimeAsync(100);
    expect(preview).toHaveBeenCalledTimes(2);
    drawable = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(await answer).toEqual({ value: { url } });
    expect(preview).toHaveBeenLastCalledWith("open", { url });
    expect(log.mock.calls.flat().join("\n")).toContain("pid 42 running");
    expect(log.mock.calls.flat().join("\n")).toContain(unavailable.message);
  });

  it("returns immediately when the window can draw", async () => {
    const preview = vi.fn(async () => ({ url }));
    const log = vi.fn();
    await expect(openDisplayPreview(preview, url, { log })).resolves.toEqual({ url });
    expect(preview).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("fails on other preview errors without retrying", async () => {
    const preview = vi.fn().mockRejectedValue(new Error("navigation failed"));
    await expect(openDisplayPreview(preview, url)).rejects.toThrow("navigation failed");
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("fails within the readiness budget and retains the last unavailable error", async () => {
    vi.useFakeTimers();
    const preview = vi.fn().mockRejectedValue(unavailable);
    const answer = openDisplayPreview(preview, url, { timeoutMs: 300, log: () => undefined })
      .then((value) => ({ value }), (error) => ({ error }));
    await vi.advanceTimersByTimeAsync(300);
    const result = await answer;
    expect(result.error?.message).toMatch(/timed out.*Preview is unavailable/u);
    expect(result.error?.cause).toBe(unavailable);
    expect(preview).toHaveBeenCalledTimes(4);
  });
});
