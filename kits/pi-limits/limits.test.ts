import { describe, expect, it } from "vitest";
import { windowsFromHeaders } from "./limits.js";

describe("Pi limits from response headers", () => {
  it("reads the ChatGPT backend's two windows", () => {
    expect(windowsFromHeaders({
      "X-Codex-Primary-Used-Percent": "34.0",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1790000000",
      "x-codex-secondary-used-percent": "12",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-after-seconds": "3600",
      "content-type": "text/event-stream",
    }, 1_000)).toEqual([
      { id: "primary", kind: "session", label: "5-hour", usedPercent: 34, windowMinutes: 300, resetsAt: 1_790_000_000_000 },
      { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 12, windowMinutes: 10_080, resetsAt: 3_601_000 },
    ]);
  });

  it("reads Anthropic's plan windows, whose utilization is a fraction", () => {
    expect(windowsFromHeaders({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": "1790000000",
      "anthropic-ratelimit-unified-7d-utilization": "1.2",
    })).toEqual([
      { id: "five_hour", kind: "session", label: "5-hour", usedPercent: 42, windowMinutes: 300, resetsAt: 1_790_000_000_000 },
      { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 100, windowMinutes: 10_080 },
    ]);
  });

  it("finds nothing in an API key's response", () => {
    expect(windowsFromHeaders({ "x-ratelimit-remaining-requests": "499", "content-type": "application/json" })).toEqual([]);
  });
});
