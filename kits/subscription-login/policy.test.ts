import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage, PreferencesStore, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
import { acknowledge, hasAcknowledged, isRestrictedSubscriptionLogin, subscriptionLoginWarning, subscriptionProviderName, warnsAbout } from "./policy.js";

beforeEach(() => setClientStorage(createMemoryStorage()));

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

  it("warns about a model only when it rides on the runtime's subscription login", () => {
    expect(warnsAbout({ provider: "anthropic", id: "m", name: "M", login: "subscription" })).toBe(true);
    expect(warnsAbout({ provider: "anthropic", id: "m", name: "M" })).toBe(false);
    expect(warnsAbout({ provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", login: "subscription" })).toBe(false);
    expect(warnsAbout(undefined)).toBe(false);
  });

  it("remembers each acknowledged provider once, across reloads", () => {
    const preferences = new PreferencesStore();
    expect(hasAcknowledged(preferences, "anthropic")).toBe(false);
    acknowledge(preferences, "anthropic");
    acknowledge(preferences, "anthropic");
    acknowledge(preferences, "google");
    const reloaded = new PreferencesStore();
    expect(hasAcknowledged(reloaded, "anthropic")).toBe(true);
    expect(reloaded.value("tau.subscription-login", "acknowledged")).toBe("anthropic,google");
  });
});
