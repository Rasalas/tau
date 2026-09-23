import { describe, expect, it } from "vitest";
import { mergeWindows, rateLimitEventWindow, usageReadWindows } from "./limits.js";

// Shaped like the SDK's `SDKControlGetUsageResponse` for a Max plan.
const read = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 42, resets_at: "2026-09-23T21:00:00.000Z" },
    seven_day: { utilization: 17.5, resets_at: "2026-09-28T08:00:00.000Z" },
    seven_day_opus: null,
    model_scoped: [{ display_name: "Fable", utilization: 3, resets_at: "2026-09-28T08:00:00.000Z" }],
  },
};

describe("Agent SDK limits", () => {
  it("reads the plan's windows from a usage read", () => {
    expect(usageReadWindows(read)).toEqual([
      { id: "five_hour", kind: "session", label: "5-hour", windowMinutes: 300, usedPercent: 42, resetsAt: Date.parse("2026-09-23T21:00:00.000Z") },
      { id: "seven_day", kind: "weekly", label: "Weekly", windowMinutes: 10_080, usedPercent: 17.5, resetsAt: Date.parse("2026-09-28T08:00:00.000Z") },
      { id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", windowMinutes: 10_080, usedPercent: 3, resetsAt: Date.parse("2026-09-28T08:00:00.000Z") },
    ]);
  });

  it("has no windows for a login without plan limits", () => {
    expect(usageReadWindows({ ...read, subscription_type: null, rate_limits_available: false, rate_limits: null })).toBeUndefined();
    expect(usageReadWindows(undefined)).toBeUndefined();
  });

  it("puts a turn's rate-limit event on the row the read drew", () => {
    const event = rateLimitEventWindow({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.81, resetsAt: 1_790_000_000 });
    expect(event).toEqual({ id: "five_hour", kind: "session", label: "5-hour", windowMinutes: 300, usedPercent: 81, resetsAt: 1_790_000_000_000 });
    expect(rateLimitEventWindow({ status: "rejected", rateLimitType: "overage" })).toBeUndefined();
    expect(mergeWindows(usageReadWindows(read)!, [event!]).map((window) => [window.id, window.usedPercent])).toEqual([["five_hour", 81], ["seven_day", 17.5], ["seven_day_fable", 3]]);
  });
});
