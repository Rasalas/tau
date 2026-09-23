import { describe, expect, it } from "vitest";
import { detectProviderLimit, limitResetTime } from "./provider-limits.js";

const now = Date.parse("2026-09-23T12:00:00Z");

describe("provider limits", () => {
  it("recognizes the limit messages providers send", () => {
    for (const message of [
      "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.",
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}',
      "Claude AI usage limit reached|1790000000",
      "You exceeded your current quota, please check your plan and billing details. insufficient_quota",
      "GoUsageLimitError: Monthly usage limit reached",
      "Too Many Requests",
      "RESOURCE_EXHAUSTED: Quota exceeded for quota metric",
    ]) expect(detectProviderLimit(message, now), message).toBeDefined();
  });

  it("leaves every other failure alone", () => {
    for (const message of [undefined, "", "Connection refused", "The model returned an error.", "prompt is too long: 250000 tokens > 200000 maximum", "Error 4290 in tool"]) {
      expect(detectProviderLimit(message, now), String(message)).toBeUndefined();
    }
  });

  it("reads the reset in every spelling providers use", () => {
    expect(limitResetTime("Try again in ~42 min.", now)).toBe(now + 42 * 60_000);
    expect(limitResetTime("Your limit resets in 2 hours 5 minutes", now)).toBe(now + 2 * 3_600_000 + 5 * 60_000);
    expect(limitResetTime("retry after 30 seconds", now)).toBe(now + 30_000);
    const inAnHour = now / 1000 + 3600;
    expect(limitResetTime(`{"resets_at": ${inAnHour}}`, now)).toBe(inAnHour * 1000);
    expect(limitResetTime(`usage limit reached|${inAnHour}`, now)).toBe(inAnHour * 1000);
    expect(limitResetTime("resets at 2026-09-23T15:14:00Z", now)).toBe(Date.parse("2026-09-23T15:14:00Z"));
    const clock = limitResetTime("You've hit your usage limit. Try again at 3:14 PM.", now)!;
    expect(new Date(clock).getHours()).toBe(15);
    expect(new Date(clock).getMinutes()).toBe(14);
    expect(clock).toBeGreaterThan(now);
  });

  it("names no reset it cannot trust", () => {
    expect(detectProviderLimit("rate_limit_error: slow down", now)).toEqual({});
    expect(limitResetTime("resets_at 1000000000", now)).toBeUndefined();
    expect(limitResetTime("try again in 90 days", now)).toBeUndefined();
  });
});
