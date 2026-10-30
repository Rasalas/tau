import { describe, expect, it } from "vitest";
import { codexLimitWindows, codexReadSnapshot, codexSnapshotUpdate, mergeCodexSnapshot } from "./limits.js";
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

  it("does not replay session-cached windows over a newer account read", () => {
    const cached = {
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_790_000_000 },
      secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_790_400_000 },
    };
    expect(codexSnapshotUpdate(undefined, cached)).toEqual(cached);
    expect(codexSnapshotUpdate(cached, structuredClone(cached))).toBeUndefined();
    expect(codexSnapshotUpdate(cached, { primary: cached.primary })).toBeUndefined();

    const refreshed = { ...cached, primary: { ...cached.primary, usedPercent: 5, resetsAt: 1_790_001_000 } };
    const secondary = { ...cached.secondary, usedPercent: 21 };
    const update = codexSnapshotUpdate(cached, { ...cached, secondary });
    expect(update).toEqual({ secondary });
    expect(mergeCodexSnapshot(refreshed, update)).toEqual({ ...refreshed, secondary });
    expect(codexSnapshotUpdate(cached, { primary: refreshed.primary })).toEqual({ primary: refreshed.primary });
  });

  it("carries changed resets, cleared windows and plan types, and ignores other buckets", () => {
    const cached = { planType: "plus", primary: { usedPercent: 20, resetsAt: 1_790_000_000 } };
    expect(codexSnapshotUpdate(cached, { primary: { ...cached.primary, resetsAt: 1_790_001_000 } })).toEqual({ primary: { ...cached.primary, resetsAt: 1_790_001_000 } });
    expect(codexSnapshotUpdate(cached, { primary: null })).toEqual({ primary: null });
    expect(codexSnapshotUpdate(cached, { planType: "go" })).toEqual({ planType: "go" });
    expect(codexSnapshotUpdate(cached, { limitId: "codex_spark", primary: { usedPercent: 99 } })).toBeUndefined();
  });
});
