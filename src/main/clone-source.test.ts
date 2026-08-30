import { describe, expect, it } from "vitest";
import { assertAllowedCloneSource } from "./clone-source.js";

describe("clone source policy", () => {
  it("allows HTTPS and SSH while rejecting local and unsafe protocols", () => {
    expect(assertAllowedCloneSource("https://example.com/team/repo.git")).toContain("https://");
    expect(assertAllowedCloneSource("git@example.com:team/repo.git")).toContain("git@");
    expect(() => assertAllowedCloneSource("file:///tmp/private")).toThrow("HTTPS or SSH");
    expect(() => assertAllowedCloneSource("/tmp/private")).toThrow("HTTPS or SSH");
    expect(() => assertAllowedCloneSource("git://example.com/repo.git")).toThrow("HTTPS or SSH");
  });
});
