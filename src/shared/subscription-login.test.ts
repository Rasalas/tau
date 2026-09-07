import { describe, expect, it } from "vitest";
import { subscriptionLoginWarning, subscriptionProviderName } from "./subscription-login.js";

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
});
