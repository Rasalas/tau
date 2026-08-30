import { describe, expect, it, vi } from "vitest";
import { ToolOutputBatcher } from "./tool-output-batcher.js";

describe("ToolOutputBatcher", () => {
  it("coalesces one tool to its latest output", () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const batcher = new ToolOutputBatcher((updates) => batches.push([...updates.values()]));
    batcher.push("tool", "a");
    batcher.push("tool", "ab");
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(batches).toEqual([["ab"]]);
    vi.useRealTimers();
  });

  it("flushes a terminal update before completion", () => {
    const batches: string[][] = [];
    const batcher = new ToolOutputBatcher((updates) => batches.push([...updates.values()]));
    batcher.push("tool", "complete");
    batcher.flushId("tool");
    expect(batches).toEqual([["complete"]]);
  });
});
