import { describe, expect, it } from "vitest";
import { clientReleaseQuery, readClientRelease } from "./client-release.js";

describe("this device's installed release", () => {
  it("excludes source, isolated, development and opted-out instances", () => {
    expect(clientReleaseQuery(false, "0.7.39", "darwin", {})).toEqual({});
    for (const env of [{ TAU_USER_DATA: "/test" }, { TAU_DEV_SERVER_URL: "http://localhost:5173" }, { TAU_USAGE_STATISTICS: "0" }, { TAU_NO_FOCUS: "1" }]) {
      expect(clientReleaseQuery(true, "0.7.39", "darwin", env)).toEqual({});
    }
  });
  it("uses the client's release rather than any connected host's version", () => {
    const query = clientReleaseQuery(true, "0.7.39-nightly.20261009.12", "linux", {});
    expect(readClientRelease(new URLSearchParams(query))).toEqual({ version: "0.7.39-nightly.20261009.12", platform: "linux", channel: "nightly" });
    expect(readClientRelease(new URLSearchParams())).toBeUndefined();
    expect(readClientRelease(new URLSearchParams({ clientRelease: "0.7.39", clientPlatform: "unknown" }))).toBeUndefined();
  });
});
