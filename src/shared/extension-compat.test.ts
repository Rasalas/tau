import { describe, expect, it } from "vitest";
import { assertEngineRanges, describeIncompatibility, EXTENSION_API_VERSION, parseVersion, satisfiesRange } from "./extension-compat.js";

describe("extension compatibility", () => {
  it("parses versions with and without prerelease", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("v0.84.4-beta.1+build")).toEqual([0, 84, 4]);
    expect(parseVersion("1.2")).toEqual([1, 2, 0]);
    expect(parseVersion("latest")).toBeUndefined();
    expect(parseVersion(EXTENSION_API_VERSION)).toBeDefined();
  });

  it("matches the range forms a manifest may use", () => {
    expect(satisfiesRange("1.4.2", "*")).toBe(true);
    expect(satisfiesRange("1.4.2", "1.4.2")).toBe(true);
    expect(satisfiesRange("1.4.2", "1.4")).toBe(true);
    expect(satisfiesRange("1.5.0", "1.4")).toBe(false);
    expect(satisfiesRange("1.4.2", "1")).toBe(true);
    expect(satisfiesRange("2.0.0", "1")).toBe(false);
    expect(satisfiesRange("1.4.2", "^1.2.0")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfiesRange("0.84.4", "^0.84.0")).toBe(true);
    expect(satisfiesRange("0.85.0", "^0.84.0")).toBe(false);
    expect(satisfiesRange("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfiesRange("0.0.4", "^0.0.3")).toBe(false);
    expect(satisfiesRange("1.4.9", "~1.4.2")).toBe(true);
    expect(satisfiesRange("1.5.0", "~1.4.2")).toBe(false);
    expect(satisfiesRange("1.4.2", ">=1.2.0 <2")).toBe(true);
    expect(satisfiesRange("2.1.0", ">=1.2.0 <2")).toBe(false);
    expect(satisfiesRange("3.0.0", "^1.0.0 || ^3.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0-rc.1", ">=1.0.0")).toBe(true);
  });

  it("rejects ranges and versions it cannot read", () => {
    expect(() => satisfiesRange("1.0.0", "latest")).toThrow("is not a version range");
    expect(() => satisfiesRange("1.0.0", "^1 ||")).toThrow("is not a version range");
    expect(() => satisfiesRange("banana", "*")).toThrow("is not a version");
    expect(() => assertEngineRanges({ tau: "*", api: ">=1 <2" })).not.toThrow();
    expect(() => assertEngineRanges({ pi: "0.84.x.y" })).toThrow("is not a version range");
  });

  it("names the first engine a package cannot run on", () => {
    const versions = { tau: "0.0.0", pi: "0.84.4", api: "1.0.0" };
    expect(describeIncompatibility(undefined, versions)).toBeUndefined();
    expect(describeIncompatibility({ api: "^1.0.0", pi: ">=0.80" }, versions)).toBeUndefined();
    expect(describeIncompatibility({ api: "^2.0.0" }, versions)).toBe("needs the extension API ^2.0.0, this Tau has 1.0.0");
    expect(describeIncompatibility({ pi: "^0.90.0" }, versions)).toBe("needs Pi ^0.90.0, this Tau has 0.84.4");
    expect(describeIncompatibility({ tau: ">=1.0.0" }, versions)).toBe("needs Tau >=1.0.0, this Tau has 0.0.0");
  });

  it("keeps a package written against an older minor loading, per ADR 0008's additive rule", () => {
    // EXTENSION_API_VERSION is 1.20.0: same major as 1.0.0, minor grew. A package
    // that asks for "^1.0.0" (the README's own convention) still loads; one
    // that needs a minor Tau has not shipped yet, or a different major, does not.
    const versions = { tau: "0.0.0", pi: "0.84.4", api: EXTENSION_API_VERSION };
    expect(describeIncompatibility({ api: "^1.0.0" }, versions)).toBeUndefined();
    expect(describeIncompatibility({ api: "^1.5.0" }, versions)).toBeUndefined();
    expect(describeIncompatibility({ api: "1.5.0" }, versions)).toBe(
      `needs the extension API 1.5.0, this Tau has ${EXTENSION_API_VERSION}`,
    );
    expect(describeIncompatibility({ api: "1.20.0" }, versions)).toBeUndefined();
    expect(describeIncompatibility({ api: "2.0.0" }, versions)).toBe(
      `needs the extension API 2.0.0, this Tau has ${EXTENSION_API_VERSION}`,
    );
    // No engines field at all, or no "api" inside it, is still unconstrained.
    expect(describeIncompatibility(undefined, versions)).toBeUndefined();
    expect(describeIncompatibility({ pi: ">=0.80" }, versions)).toBeUndefined();
  });
});
