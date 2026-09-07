import { describe, expect, it } from "vitest";
import { modelLogin } from "./model-login.js";

describe("modelLogin", () => {
  it("marks a provider the runtime reaches through a subscription login", () => {
    const runtime = { isUsingSubscription: (provider: string) => provider === "anthropic" };
    expect(modelLogin(runtime, "anthropic")).toBe("subscription");
    expect(modelLogin(runtime, "opencode-go")).toBeUndefined();
  });

  it("stays quiet for a runtime that cannot say, or that throws", () => {
    expect(modelLogin(undefined, "anthropic")).toBeUndefined();
    expect(modelLogin({}, "anthropic")).toBeUndefined();
    expect(modelLogin({ isUsingSubscription: () => { throw new Error("no snapshot"); } }, "anthropic")).toBeUndefined();
  });
});
