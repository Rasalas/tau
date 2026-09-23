import { describe, expect, it } from "vitest";
import { defaultUpdateChannel, isNightlyVersion, isUpdateChannel, versionSkew } from "./app-version.js";

describe("app version", () => {
  it("knows the two channels", () => {
    expect(isUpdateChannel("stable")).toBe(true);
    expect(isUpdateChannel("nightly")).toBe(true);
    expect(isUpdateChannel("latest")).toBe(false);
    expect(isUpdateChannel(undefined)).toBe(false);
  });

  it("recognises the version a nightly build carries", () => {
    expect(isNightlyVersion("0.4.1-nightly.20260922.17")).toBe(true);
    expect(isNightlyVersion("0.4.1")).toBe(false);
    expect(isNightlyVersion("0.4.1-beta.1")).toBe(false);
    expect(defaultUpdateChannel("0.4.1-nightly.20260922.17")).toBe("nightly");
    expect(defaultUpdateChannel("0.4.1")).toBe("stable");
    expect(defaultUpdateChannel(undefined)).toBe("stable");
  });

  it("reports a skew only when both sides are known and differ", () => {
    expect(versionSkew("0.4.1", "0.4.0")).toEqual({ window: "0.4.1", host: "0.4.0" });
    expect(versionSkew("0.4.1", "0.4.1")).toBeUndefined();
    expect(versionSkew(undefined, "0.4.0")).toBeUndefined();
    expect(versionSkew("0.4.1", "")).toBeUndefined();
    expect(versionSkew("0.4.1-nightly.20260922.17", "0.4.1")).toEqual({ window: "0.4.1-nightly.20260922.17", host: "0.4.1" });
  });
});
