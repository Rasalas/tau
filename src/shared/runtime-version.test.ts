import { describe, expect, it } from "vitest";
import { compareVersions, updateAvailable } from "./runtime-version.js";

describe("compareVersions", () => {
  it("orders numeric parts, not strings", () => {
    expect(compareVersions("0.154.0", "0.155.1")).toBe(-1);
    expect(compareVersions("0.99.0", "0.100.0")).toBe(-1);
    expect(compareVersions("2.1.280", "2.1.28")).toBe(1);
    expect(compareVersions("v1.2", "1.2.0")).toBe(0);
  });

  it("puts a prerelease before its release and ignores build metadata", () => {
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.9")).toBe(1);
    expect(compareVersions("1.0.0+abc", "1.0.0")).toBe(0);
  });

  it("calls unreadable versions equal", () => {
    expect(compareVersions("nightly", "1.0.0")).toBe(0);
  });
});

describe("updateAvailable", () => {
  it("is true only when both versions are known and the installed one is older", () => {
    expect(updateAvailable({ tool: "codex", installed: "0.154.0", latest: "0.155.1" })).toBe(true);
    expect(updateAvailable({ tool: "codex", installed: "0.155.1", latest: "0.155.1" })).toBe(false);
    expect(updateAvailable({ tool: "codex", installed: "0.156.0", latest: "0.155.1" })).toBe(false);
    expect(updateAvailable({ tool: "codex", installed: "0.154.0" })).toBe(false);
    expect(updateAvailable(undefined)).toBe(false);
  });
});
