/**
 * The quota windows a subscription provider sends with each response, read
 * from the headers Pi hands its extensions (`after_provider_response`). The
 * ChatGPT backend names two windows `x-codex-primary-*` and
 * `x-codex-secondary-*`; Anthropic's plan login names `anthropic-ratelimit-
 * unified-5h-*` and `-7d-*`. Nothing is asked for: these come with answers Pi
 * already received.
 */

/** One quota window, as the Usage kit reads it (`usage-limits`). */
export interface LimitWindow {
  id: string;
  kind: "session" | "weekly" | "monthly" | "other";
  label: string;
  usedPercent: number;
  /** Epoch ms. */
  resetsAt?: number;
  windowMinutes?: number;
}

/** One account's windows, as the Usage kit reads it. */
export interface LimitAccount {
  id: string;
  runtime: string;
  label: string;
  plan?: string;
  checkedAt: number;
  windows: LimitWindow[];
}

const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

function number(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function percent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function lower(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function codexWindow(headers: Record<string, string>, position: "primary" | "secondary", now: number): LimitWindow | undefined {
  const used = number(headers[`x-codex-${position}-used-percent`]);
  if (used === undefined) return undefined;
  const minutes = number(headers[`x-codex-${position}-window-minutes`]);
  const resetAt = number(headers[`x-codex-${position}-reset-at`]);
  const resetAfter = number(headers[`x-codex-${position}-reset-after-seconds`]);
  const resetsAt = resetAt !== undefined ? resetAt * 1000 : resetAfter !== undefined ? now + resetAfter * 1000 : undefined;
  const kind: LimitWindow["kind"] = minutes === undefined ? (position === "primary" ? "session" : "weekly") : minutes >= MONTH_MINS - 24 * 60 ? "monthly" : minutes >= WEEK_MINS - 24 * 60 ? "weekly" : "session";
  const label = kind === "session" ? `${Math.round((minutes ?? 300) / 60)}-hour` : kind === "weekly" ? "Weekly" : "Monthly";
  return { id: position, kind, label, usedPercent: percent(used), ...(minutes !== undefined ? { windowMinutes: minutes } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

function anthropicWindow(headers: Record<string, string>, span: "5h" | "7d"): LimitWindow | undefined {
  const utilization = number(headers[`anthropic-ratelimit-unified-${span}-utilization`]);
  if (utilization === undefined) return undefined;
  const reset = number(headers[`anthropic-ratelimit-unified-${span}-reset`]);
  return {
    id: span === "5h" ? "five_hour" : "seven_day",
    kind: span === "5h" ? "session" : "weekly",
    label: span === "5h" ? "5-hour" : "Weekly",
    usedPercent: percent(utilization * 100),
    windowMinutes: span === "5h" ? 300 : WEEK_MINS,
    ...(reset !== undefined ? { resetsAt: reset * 1000 } : {}),
  };
}

/** The windows a response's headers name; empty when they name none. */
export function windowsFromHeaders(raw: Record<string, string>, now = Date.now()): LimitWindow[] {
  const headers = lower(raw);
  return [
    codexWindow(headers, "primary", now),
    codexWindow(headers, "secondary", now),
    anthropicWindow(headers, "5h"),
    anthropicWindow(headers, "7d"),
  ].filter((window): window is LimitWindow => window !== undefined);
}
