import { describe, expect, it } from "vitest";
import { isRestrictedSubscriptionLogin, subscriptionLoginWarning, subscriptionProviderName } from "./subscription-login.js";

describe("subscription login warning", () => {
  it("names the vendor's own statement for Anthropic", () => {
    const warning = subscriptionLoginWarning("anthropic");
    expect(warning.message).toMatch(/enforces this without notice/u);
    expect(warning.message).toMatch(/API key/u);
    expect(warning.source).toMatch(/^https:\/\//u);
  });

  it("stays generic, and unsourced, for a vendor it has not researched", () => {
    const warning = subscriptionLoginWarning("openai-codex");
    expect(warning.message).toContain("OpenAI");
    expect(warning.source).toBeUndefined();
    expect(subscriptionProviderName("something-else")).toBe("something-else");
  });

  it("warns only for vendors that allow subscription logins in their own apps alone", () => {
    expect(isRestrictedSubscriptionLogin("anthropic")).toBe(true);
    expect(isRestrictedSubscriptionLogin("google")).toBe(true);
    expect(isRestrictedSubscriptionLogin("google-antigravity")).toBe(true);
    expect(isRestrictedSubscriptionLogin("openai-codex")).toBe(false);
    expect(isRestrictedSubscriptionLogin("github-copilot")).toBe(false);
    expect(subscriptionLoginWarning("google").message).toMatch(/Antigravity/u);
  });
});
