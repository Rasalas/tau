import { describe, expect, it } from "vitest";
import { plural } from "./plural.js";

describe("plural", () => {
  it("counts one in the singular and everything else in the plural", () => {
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(2, "file")).toBe("2 files");
    expect(plural(1, "entry", "entries")).toBe("1 entry");
    expect(plural(3, "entry", "entries")).toBe("3 entries");
  });
});
