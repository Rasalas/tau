import type { UsageLimitAccount, UsageLimitSample, UsageLimitWindow } from "./protocol.js";
import { elapsedShare, formatWait, runtimeFamily } from "./view-model.js";

export const FRESH_MS = 10 * 60_000;
export type QuotaState = { kind: "expired" | "stale" | "exhausted" | "forecast" | "ahead" | "steady" | "unknown"; label: string; detail: string };

export function providerOf(account: Pick<UsageLimitAccount, "id" | "runtime">): string {
  return account.runtime === "pi" ? account.id.replace(/^pi:/u, "") : runtimeFamily(account.runtime);
}

export function providerTone(provider: string): string {
  if (/codex|openai/u.test(provider)) return "openai";
  if (/claude|anthropic/u.test(provider)) return "anthropic";
  if (/google|gemini|antigravity/u.test(provider)) return "google";
  return "neutral";
}

/** Only compare the same account/window/reset, with uninterrupted recent observations. */
export function projectedLimit(account: UsageLimitAccount, window: UsageLimitWindow, history: readonly UsageLimitSample[], now: number): number | undefined {
  if (account.unavailable || now - account.checkedAt > FRESH_MS || account.checkedAt > now || !window.resetsAt || window.resetsAt <= now || window.usedPercent >= 100) return;
  const values = new Map<number, number>();
  for (const { account: sample } of history) {
    if (sample.id !== account.id || sample.runtime !== account.runtime || sample.plan !== account.plan || sample.label !== account.label || sample.unavailable || sample.checkedAt < now - 3_600_000 || sample.checkedAt > account.checkedAt) continue;
    const previous = sample.windows.find((entry) => entry.id === window.id && entry.resetsAt === window.resetsAt);
    if (previous) values.set(sample.checkedAt, previous.usedPercent);
  }
  values.set(account.checkedAt, window.usedPercent);
  let points = [...values].sort((a, b) => a[0] - b[0]);
  for (let i = points.length - 1; i > 0; i--) {
    if (points[i]![0] - points[i - 1]![0] > FRESH_MS || points[i]![1] < points[i - 1]![1]) { points = points.slice(i); break; }
  }
  if (points.length < 3) return;
  const first = points[0]!;
  const last = points.at(-1)!;
  if (last[0] - first[0] < 5 * 60_000 || last[1] <= first[1]) return;
  const lastIncrease = points.filter((point, index) => index > 0 && point[1] > points[index - 1]![1]).at(-1);
  if (!lastIncrease || now - lastIncrease[0] > FRESH_MS) return;
  const rate = (last[1] - first[1]) / (last[0] - first[0]);
  const at = now + (100 - window.usedPercent) / rate;
  return at < window.resetsAt && at - now <= 2 * 3_600_000 ? at : undefined;
}

export function quotaState(account: UsageLimitAccount, window: UsageLimitWindow, history: readonly UsageLimitSample[], now: number): QuotaState {
  if (window.resetsAt !== undefined && window.resetsAt <= now) return { kind: "expired", label: "Waiting for a new reading", detail: "Reset reached. The previous reading no longer describes this window." };
  if (account.unavailable || now - account.checkedAt > FRESH_MS || account.checkedAt > now) return { kind: "stale", label: "Last known reading", detail: account.unavailable?.message ?? "This reading is more than 10 minutes old. Refresh to check the current limit." };
  if (window.usedPercent >= 100) return { kind: "exhausted", label: "Limit reached", detail: "This quota is exhausted. Wait for the reset or use another account." };
  const projected = projectedLimit(account, window, history, now);
  if (projected) return { kind: "forecast", label: `Limit in about ${formatWait(projected - now)}`, detail: "Estimated from recent measurements, if your current pace continues. The limit would be reached before the reset." };
  const elapsed = elapsedShare(window, now);
  if (elapsed === undefined) return { kind: "unknown", label: "Usage reported", detail: "The window duration or reset time is unknown, so a steady pace cannot be calculated." };
  if (window.usedPercent > elapsed * 100 + 5) return { kind: "ahead", label: "Above steady pace", detail: "More quota used than at an even pace across this window. This is not a prediction that you will hit the limit." };
  return { kind: "steady", label: "Within steady pace", detail: "Usage is within the allowance for an even pace across this window." };
}
