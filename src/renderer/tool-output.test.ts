import { describe, expect, it } from "vitest";
import { ACTIVE_TOOL_OUTPUT_LIMIT, SETTLED_TOOL_OUTPUT_LIMIT, boundToolOutput } from "./tool-output";

describe("tool output bounds", () => {
  it("keeps a visible tail and marks truncation", () => {
    const result = boundToolOutput(`${"x".repeat(ACTIVE_TOOL_OUTPUT_LIMIT)}\nlast line`, ACTIVE_TOOL_OUTPUT_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("last line");
    expect(result.text.length).toBeLessThanOrEqual(ACTIVE_TOOL_OUTPUT_LIMIT);
  });

  it("uses a smaller settled limit", () => {
    expect(boundToolOutput("x".repeat(SETTLED_TOOL_OUTPUT_LIMIT + 1), SETTLED_TOOL_OUTPUT_LIMIT).truncated).toBe(true);
  });
});
