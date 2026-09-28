import { describe, expect, it } from "vitest";
import type { UsageLimitAccount, UsageLimitSample } from "./protocol.js";
import { projectedLimit, quotaState } from "./quota.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const account: UsageLimitAccount = { id: "a", runtime: "codex", label: "Codex", checkedAt: NOW, windows: [{ id: "w", kind: "session", label: "5-hour", usedPercent: 80, resetsAt: NOW + 60 * MIN, windowMinutes: 300 }] };
const window = account.windows[0]!;
const samples = (values: number[]): UsageLimitSample[] => values.map((usedPercent, i) => ({ source: "tau.codex", account: { ...account, checkedAt: NOW - (values.length - 1 - i) * 5 * MIN, windows: [{ ...window, usedPercent }] } }));

describe("quota status", () => {
  it("prioritizes expiry and stale/failed data over exhaustion and pace", () => {
    expect(quotaState(account, { ...window, usedPercent: 100, resetsAt: NOW }, [], NOW).kind).toBe("expired");
    expect(quotaState({ ...account, checkedAt: NOW - 11 * MIN }, window, [], NOW).kind).toBe("stale");
    expect(quotaState({ ...account, unavailable: { reason: "failed" } }, { ...window, usedPercent: 100 }, [], NOW).kind).toBe("stale");
    expect(quotaState(account, { ...window, usedPercent: 100 }, [], NOW).kind).toBe("exhausted");
  });
  it("projects only a short imminent limit from three increasing observations", () => {
    expect(projectedLimit(account, window, samples([60, 70, 80]), NOW)).toBe(NOW + 10 * MIN);
    expect(quotaState(account, window, samples([60, 70, 80]), NOW).kind).toBe("forecast");
    expect(projectedLimit(account, window, samples([70, 80]), NOW)).toBeUndefined();
    expect(projectedLimit(account, window, samples([80, 80, 80]), NOW)).toBeUndefined();
    expect(projectedLimit(account, window, samples([90, 70, 80]), NOW)).toBeUndefined();
    expect(projectedLimit(account, window, samples([60, 70, 80]).map((s) => ({ ...s, account: { ...s.account, id: "another" } })), NOW)).toBeUndefined();
    expect(projectedLimit(account, window, samples([60, 70, 80]).map((s) => ({ ...s, account: { ...s.account, windows: [{ ...window, resetsAt: NOW + 2 * 60 * MIN }] } })), NOW)).toBeUndefined();
  });
  it("does not extrapolate across a polling gap or long inactivity", () => {
    const history = samples([60, 70, 80]);
    history[0]!.account.checkedAt -= 20 * MIN;
    expect(projectedLimit(account, window, history, NOW)).toBeUndefined();
    expect(projectedLimit(account, window, samples([60, 80, 80, 80, 80]), NOW)).toBeUndefined();
  });
  it("distinguishes pacing from unknown window lengths", () => {
    expect(quotaState(account, window, [], NOW).kind).toBe("steady");
    expect(quotaState(account, { ...window, usedPercent: 90 }, [], NOW).kind).toBe("ahead");
    expect(quotaState(account, { ...window, windowMinutes: undefined }, [], NOW).kind).toBe("unknown");
  });
});
