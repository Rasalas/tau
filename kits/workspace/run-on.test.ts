import { describe, expect, it } from "vitest";
import { branchFromField, fetchedAgo } from "./run-on.js";

describe("a new thread's Run on (design 1k)", () => {
  it("puts a name under tau/ unless it brings its own folder, and leaves an empty one to the prompt", () => {
    expect(branchFromField("pagination")).toBe("tau/pagination");
    expect(branchFromField(" feat/pagination ")).toBe("feat/pagination");
    expect(branchFromField("tau/x")).toBe("tau/x");
    expect(branchFromField("  ")).toBe("");
  });

  it("says how long ago the default base was fetched", () => {
    const now = 1_000_000_000;
    expect(fetchedAgo(undefined, now)).toBeUndefined();
    expect(fetchedAgo(now - 20_000, now)).toBe("fetched just now");
    expect(fetchedAgo(now - 2 * 60_000, now)).toBe("fetched 2m ago");
    expect(fetchedAgo(now - 3 * 3_600_000, now)).toBe("fetched 3h ago");
    expect(fetchedAgo(now - 2 * 86_400_000, now)).toBe("fetched 2d ago");
  });
});
