import { describe, expect, it } from "vitest";
import { hostTokenPath } from "./host-token.js";

describe("hostTokenPath", () => {
  it("lives in ~/.tau unless TAU_HOST_TOKEN_FILE moves it", () => {
    expect(hostTokenPath("/home/u", {})).toBe("/home/u/.tau/host-token");
    expect(hostTokenPath("/home/u", { TAU_HOST_TOKEN_FILE: "/w/.tau-dev/host-token" })).toBe("/w/.tau-dev/host-token");
    expect(hostTokenPath("/home/u", { TAU_HOST_TOKEN_FILE: "  " })).toBe("/home/u/.tau/host-token");
  });
});
