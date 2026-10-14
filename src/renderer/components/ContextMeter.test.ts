// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { compactTokens } from "./ContextMeter";

describe("compactTokens", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1k"],
    [200_000, "200k"],
    [999_499, "999k"],
    [999_500, "1M"],
    [999_999, "1M"],
    [1_000_000, "1M"],
    [1_250_000, "1.3M"],
    [2_000_000, "2M"],
  ])("formats %d tokens as %s", (tokens, expected) => {
    expect(compactTokens(tokens)).toBe(expected);
  });
});
