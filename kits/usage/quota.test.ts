import { describe, expect, it } from "vitest";
import type { UsageLimitAccount, UsageLimitSample, UsageLimitWindow } from "./protocol.js";
import { measuredRate, quotaState, steadyPercent } from "./quota.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
// 5-hour window, 3h 20m in: steady is 33.3 %.
const window: UsageLimitWindow = { id: "w", kind: "session", label: "5-hour", usedPercent: 30, resetsAt: NOW + 200 * MIN, windowMinutes: 300 };
const account: UsageLimitAccount = { id: "codex:a", runtime: "codex", label: "Codex", checkedAt: NOW, windows: [window] };

/** Readings five minutes apart, the last at NOW. */
function readings(values: number[], base: UsageLimitAccount = account, reset = window.resetsAt): UsageLimitSample[] {
  return values.map((usedPercent, index) => ({
    source: "tau.codex",
    account: { ...base, checkedAt: NOW - (values.length - 1 - index) * 5 * MIN, windows: [{ ...window, usedPercent, resetsAt: reset }] },
  }));
}
const at = (usedPercent: number): UsageLimitWindow => ({ ...window, usedPercent });

describe("a window's state", () => {
  it("puts a passed reset and an old or failed reading before everything else", () => {
    expect(quotaState(account, { ...window, usedPercent: 100, resetsAt: NOW }, [], NOW).kind).toBe("expired");
    expect(quotaState({ ...account, checkedAt: NOW - 11 * MIN }, at(100), [], NOW).kind).toBe("stale");
    expect(quotaState({ ...account, unavailable: { reason: "failed" } }, at(100), [], NOW).kind).toBe("stale");
    expect(quotaState(account, at(100), [], NOW).kind).toBe("exhausted");
  });

  it("forecasts running out from three rising readings, only within two hours and before the reset", () => {
    expect(quotaState(account, at(90), readings([70, 80, 90]), NOW)).toEqual({ kind: "forecast", at: NOW + 5 * MIN });
    // 1 point per 5 minutes: 60 points take 300 minutes, past the reset.
    expect(quotaState(account, at(40), readings([38, 39, 40]), NOW).kind).toBe("lasts");
    expect(measuredRate(account, at(80), readings([70, 80]), NOW)).toBeUndefined();
    expect(measuredRate(account, at(80), readings([80, 80, 80]), NOW)).toBeUndefined();
    expect(measuredRate(account, at(80), readings([90, 70, 80]), NOW)).toBeUndefined();
  });

  it("compares readings of the same source and reset only, even when another runtime reads the same account", () => {
    const other = { ...account, id: "codex:b" };
    expect(measuredRate(account, at(90), readings([70, 80, 90], other), NOW)).toBeUndefined();
    expect(measuredRate(account, at(90), readings([70, 80, 90], account, NOW + 400 * MIN), NOW)).toBeUndefined();
    const identity = { provider: "openai", key: "a".repeat(64) };
    const pi = { ...account, id: "pi:openai-codex", runtime: "pi", identity };
    expect(measuredRate({ ...account, identity }, at(90), readings([70, 80, 90], pi), NOW)).toBeUndefined();
    expect(measuredRate({ ...account, identity }, at(90), readings([70, 80, 90], { ...account, identity }), NOW)).toBeGreaterThan(0);
  });

  it("starts again after a gap in the readings and says nothing once usage has stopped rising", () => {
    const gap = readings([60, 70, 80, 90]);
    gap[0]!.account.checkedAt -= 20 * MIN;
    gap[1]!.account.checkedAt -= 20 * MIN;
    expect(measuredRate(account, at(90), gap, NOW)).toBeUndefined();
    expect(measuredRate(account, at(90), readings([70, 90, 90, 90, 90]), NOW)).toBeUndefined();
  });

  it("weights recent intervals more", () => {
    const speeding = measuredRate(account, at(40), readings([30, 31, 40]), NOW)!;
    const slowing = measuredRate(account, at(40), readings([30, 39, 40]), NOW)!;
    expect(speeding).toBeGreaterThan(slowing);
  });

  it("says when usage will pass the steady line, which moves on as well", () => {
    // Steady 33.3 %, used 30 %, rising .4 points a minute against the line's 1/3: past it in about 50 minutes.
    const state = quotaState(account, at(30), readings([26, 28, 30]), NOW);
    expect(state.kind).toBe("pace");
    expect((state as { at: number }).at - NOW).toBeGreaterThan(45 * MIN);
    expect((state as { at: number }).at - NOW).toBeLessThan(55 * MIN);
  });

  it("tells ahead of the steady line from on it, and needs a length and reset for either", () => {
    expect(quotaState(account, at(30), [], NOW).kind).toBe("steady");
    expect(quotaState(account, at(50), [], NOW)).toEqual({ kind: "ahead", steady: steadyPercent(window, NOW) });
    expect(quotaState(account, { ...window, windowMinutes: undefined }, [], NOW).kind).toBe("unknown");
  });
});
