import { describe, expect, it } from "vitest";
import { boundedToolOutput, MAX_HOST_TOOL_OUTPUT_BYTES } from "./pi-host.js";

describe("host tool output bounds", () => {
  it("keeps cumulative IPC payloads bounded and marks truncation", () => {
    const output = "x".repeat(MAX_HOST_TOOL_OUTPUT_BYTES * 3);
    const bounded = boundedToolOutput(output);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThan(MAX_HOST_TOOL_OUTPUT_BYTES + 200);
    expect(bounded).toContain("Earlier tool output truncated");
    expect(bounded.endsWith("x".repeat(100))).toBe(true);
  });
});
