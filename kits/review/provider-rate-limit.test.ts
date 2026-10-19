import { describe, expect, it } from "vitest";
import { isRateLimited, RateLimitGate, resetNote, retryAtFrom } from "./provider-rate-limit.js";

const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name.toLowerCase()] ?? null });

describe("the rate-limit pause", () => {
  it("reads the reset from Retry-After or X-RateLimit-Reset, and the CLIs' words", () => {
    expect(retryAtFrom(headers({ "retry-after": "12" }), 1_000)).toBe(13_000);
    expect(retryAtFrom(headers({ "x-ratelimit-reset": "100" }), 1_000)).toBe(100_000);
    expect(retryAtFrom(headers({}), 1_000)).toBeUndefined();
    expect(isRateLimited("HTTP 403: API rate limit exceeded for user ID 1")).toBe(true);
    expect(isRateLimited("HTTP 404: Not Found")).toBe(false);
  });

  it("pauses one provider on one host, longer each time, until a call after the pause succeeds", () => {
    let now = 0;
    const gate = new RateLimitGate(() => now);
    gate.record("github", "github.com");
    expect(() => gate.check("GitHub", "github", "github.com")).toThrow(/GitHub's rate limit for github.com is reached; Tau asks again in 60 seconds/u);
    expect(() => gate.check("GitHub", "github", "ghe.example.com")).not.toThrow();
    gate.succeeded("github", "github.com");
    now = 60_000;
    expect(() => gate.check("GitHub", "github", "github.com")).not.toThrow();
    gate.record("github", "github.com");
    expect(() => gate.check("GitHub", "github", "github.com")).toThrow(/2 minutes/u);
    now = 180_000;
    gate.succeeded("github", "github.com");
    gate.record("github", "github.com", now + 600_000);
    expect(() => gate.check("GitHub", "github", "github.com")).toThrow(/10 minutes/u);
  });
});
it("isolates exhausted quotas by credential and preserves long reset times", () => {
  const gate = new RateLimitGate(() => 0);
  gate.record("github", "github.com", 3_600_000, "first");
  expect(() => gate.check("GitHub", "github", "github.com", "first")).toThrow("60 minutes");
  expect(() => gate.check("GitHub", "github", "github.com", "second")).not.toThrow();
});
it("does not shorten a known reset when another already-started request fails without headers", () => {
  const gate = new RateLimitGate(() => 0);
  gate.record("github", "github.com", 3_600_000, "account");
  expect(gate.record("github", "github.com", undefined, "account")).toBe(3_600_000);
});

describe("the reset note", () => {
  it("says when the provider named a reset in the future, and nothing otherwise", () => {
    expect(resetNote(1_000 + 300_000, 1_000)).toBe(" The limit resets in about 5 minutes.");
    expect(resetNote(1_000 + 30_000, 1_000)).toBe(" The limit resets in about 30 seconds.");
    expect(resetNote(undefined, 1_000)).toBe("");
    expect(resetNote(500, 1_000)).toBe("");
  });
});
