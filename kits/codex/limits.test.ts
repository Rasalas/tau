import { describe, expect, it } from "vitest";
import { codexLimitWindows, codexReadSnapshot, mergeCodexSnapshot } from "./limits.js";
import read from "./fixtures/rate-limits-read.json" with { type: "json" };

describe("Codex limits", () => {
  it("reads the main allowance's windows from a rate-limit read, never a model's own bucket", () => {
    expect(codexLimitWindows(codexReadSnapshot(read))).toEqual([
      { id: "primary", kind: "session", label: "5-hour", usedPercent: 34, windowMinutes: 300, resetsAt: 1_790_000_000_000 },
      { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 12.5, windowMinutes: 10_080, resetsAt: 1_790_400_000_000 },
    ]);
    expect(codexLimitWindows(read.rateLimitsByLimitId.codex_spark)).toEqual([]);
    expect(codexLimitWindows(undefined)).toEqual([]);
  });

  it("gives a Free or Go plan without window lengths one monthly allowance", () => {
    expect(codexLimitWindows({ planType: "go", primary: { usedPercent: 120, resetsAt: null } })).toEqual([
      { id: "primary", kind: "monthly", label: "Monthly", usedPercent: 100, windowMinutes: 43_200 },
    ]);
  });

  it("merges a turn's partial update into what was read, and ignores another bucket", () => {
    const base = codexReadSnapshot(read);
    const merged = mergeCodexSnapshot(base, { limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_790_000_100 } });
    expect(codexLimitWindows(merged).map((window) => window.usedPercent)).toEqual([40, 12.5]);
    expect(mergeCodexSnapshot(base, { limitId: "codex_spark", primary: { usedPercent: 99 } })).toBe(base);
  });
});
