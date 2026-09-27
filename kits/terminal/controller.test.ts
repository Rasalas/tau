import { describe, expect, it } from "vitest";
import { splitDirectionFor } from "./controller.js";

describe("splitDirectionFor", () => {
  it("splits a shell taller than wide into top and bottom, any other side by side", () => {
    expect(splitDirectionFor(400, 700)).toBe("down");
    expect(splitDirectionFor(900, 300)).toBe("right");
    expect(splitDirectionFor(500, 500)).toBe("right");
  });
});
