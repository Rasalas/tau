import { describe, expect, it } from "vitest";
import { diffStatLabel } from "./rail-details.js";

describe("diffStatLabel", () => {
  it("writes a diff stat with a real minus sign", () => {
    expect(diffStatLabel({ added: 0, removed: 7, files: 2, at: 0 })).toBe("+0 −7");
  });
});
