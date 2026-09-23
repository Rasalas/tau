import { describe, expect, it } from "vitest";
import { parseVersionPolicy, satisfiesVersionRange, versionCompatibility } from "./version-policy.js";

describe("version policy", () => {
  it("reads comparators, carets, tildes and alternatives", () => {
    expect(satisfiesVersionRange("0.154.0", "<0.154.0")).toBe(false);
    expect(satisfiesVersionRange("0.153.9", "<0.154.0")).toBe(true);
    expect(satisfiesVersionRange("0.155.1", ">=0.154.0 <0.156.0")).toBe(true);
    expect(satisfiesVersionRange("0.156.0", ">=0.154.0 <0.156.0")).toBe(false);
    expect(satisfiesVersionRange("0.154.7", "^0.154.0")).toBe(true);
    expect(satisfiesVersionRange("0.155.0", "^0.154.0")).toBe(false);
    expect(satisfiesVersionRange("2.9.0", "^2.1")).toBe(true);
    expect(satisfiesVersionRange("3.0.0", "^2.1")).toBe(false);
    expect(satisfiesVersionRange("1.4.9", "~1.4.2")).toBe(true);
    expect(satisfiesVersionRange("1.5.0", "~1.4.2")).toBe(false);
    expect(satisfiesVersionRange("1.2.7", "=1.2")).toBe(true);
    expect(satisfiesVersionRange("1.2.7", "1.2.6 || 1.2.7")).toBe(true);
    expect(satisfiesVersionRange("v1.2.7", ">1.2.0")).toBe(true);
  });

  it("never matches a prerelease, a tag or a malformed range", () => {
    expect(satisfiesVersionRange("1.2.3-beta.1", ">=1.0.0")).toBe(false);
    expect(satisfiesVersionRange("agy_acp_server_20260818_01", ">=1.0.0")).toBe(false);
    expect(satisfiesVersionRange("1.2.3", ">=1.x")).toBe(false);
    expect(satisfiesVersionRange("1.2.3", "")).toBe(false);
  });

  it("gives the first matching range's verdict and the release to install unless it is installed", () => {
    const policy = { ranges: [{ range: "<0.154.0", status: "broken" as const, message: "Too old." }, { range: "<0.156.0", status: "unsafe" as const }], recommendedVersion: "0.156.2" };
    expect(versionCompatibility(policy, "0.150.0")).toEqual({ status: "broken", message: "Too old.", recommendedVersion: "0.156.2" });
    expect(versionCompatibility(policy, "0.155.0")).toEqual({ status: "unsafe", recommendedVersion: "0.156.2" });
    expect(versionCompatibility(policy, "0.157.0")).toBeUndefined();
    expect(versionCompatibility({ ranges: [{ range: ">=0.1.0", status: "supported" }], recommendedVersion: "0.156.2" }, "0.156.2")).toEqual({ status: "supported" });
    expect(versionCompatibility(undefined, "0.155.0")).toBeUndefined();
    expect(versionCompatibility(policy, undefined)).toBeUndefined();
  });

  it("parses a policy from JSON and refuses a malformed one", () => {
    expect(parseVersionPolicy({ ranges: [{ range: "<1.0.0", status: "unsafe" }], recommendedVersion: "1.0.0" })).toEqual({ ranges: [{ range: "<1.0.0", status: "unsafe" }], recommendedVersion: "1.0.0" });
    expect(parseVersionPolicy({ ranges: [{ range: "<1.0.0", status: "graceful" }] })).toBeUndefined();
    expect(parseVersionPolicy({ ranges: "nope" })).toBeUndefined();
    expect(parseVersionPolicy({ ranges: [], recommendedVersion: "latest" })).toEqual({ ranges: [] });
  });
});
