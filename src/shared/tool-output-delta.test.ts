import { describe, expect, it } from "vitest";
import { applyToolOutputDelta, toolOutputDelta } from "./tool-output-delta.js";

const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `line ${from + index}\n`).join("");
const MARKER = "[Earlier output truncated.]\n";

describe("tool output deltas", () => {
  it("sends only what a growing output appended", () => {
    const previous = lines(0, 50);
    const next = lines(0, 52);
    const delta = toolOutputDelta(previous, next)!;
    expect(delta).toEqual({ keep: previous.length, drop: 0, text: "line 50\nline 51\n" });
    expect(applyToolOutputDelta(previous, delta)).toBe(next);
  });

  it("follows a tail window behind a fixed marker, even when the tails repeat", () => {
    const previous = MARKER + lines(100, 200);
    const next = MARKER + lines(103, 203);
    const delta = toolOutputDelta(previous, next)!;
    expect(delta.text).toBe(lines(200, 203));
    expect(delta.keep).toBeGreaterThanOrEqual(MARKER.length);
    expect(applyToolOutputDelta(previous, delta)).toBe(next);
  });

  it("sends the whole output when it is not a continuation or barely longer than the change", () => {
    expect(toolOutputDelta("abc", "xyz")).toBeUndefined();
    expect(toolOutputDelta(lines(0, 2), lines(0, 10))).toBeUndefined();
    expect(toolOutputDelta(MARKER + lines(0, 50), MARKER + lines(500, 550))).toBeUndefined();
  });

  it("refuses a delta the previous output cannot carry", () => {
    expect(applyToolOutputDelta("short", { keep: 4, drop: 3, text: "x" })).toBeUndefined();
  });
});
