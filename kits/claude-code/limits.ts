/**
 * The plan's windows for the Usage kit. The SDK's usage read reports every
 * window at once (0–100, ISO resets); a turn's `rate_limit_event` names one at
 * a time (0–1, epoch seconds). Both map to the same ids, so an event lands on
 * the row the read drew.
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
  /** A hash of the provider's account id, for showing one account once; never the id itself. */
  identity?: { provider: string; key: string };
  unavailable?: { reason: "unsupported" | "failed" | "signed-out"; message?: string };
}

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

const WINDOWS: Record<string, Omit<LimitWindow, "id" | "usedPercent" | "resetsAt">> = {
  five_hour: { kind: "session", label: "5-hour", windowMinutes: SESSION_MINS },
  seven_day: { kind: "weekly", label: "Weekly", windowMinutes: WEEK_MINS },
  seven_day_opus: { kind: "weekly", label: "Weekly · Opus", windowMinutes: WEEK_MINS },
  seven_day_sonnet: { kind: "weekly", label: "Weekly · Sonnet", windowMinutes: WEEK_MINS },
};

function percent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function isoMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

function scopedId(name: string): string {
  return `seven_day_${name.toLowerCase().replace(/[^a-z0-9]+/gu, "_")}`;
}

/** The windows of a usage read; `undefined` when the plan reports none (API key, cloud provider). */
export function usageReadWindows(response: unknown): LimitWindow[] | undefined {
  if (!response || typeof response !== "object") return undefined;
  const read = response as { rate_limits_available?: unknown; rate_limits?: Record<string, unknown> | null };
  if (read.rate_limits_available !== true || !read.rate_limits) return undefined;
  const windows: LimitWindow[] = [];
  for (const [id, shape] of Object.entries(WINDOWS)) {
    const window = read.rate_limits[id] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (!window || typeof window.utilization !== "number") continue;
    const resetsAt = isoMs(window.resets_at);
    windows.push({ id, ...shape, usedPercent: percent(window.utilization), ...(resetsAt ? { resetsAt } : {}) });
  }
  // Newer CLIs add a weekly window per model under `model_scoped`.
  const scoped = read.rate_limits.model_scoped;
  if (Array.isArray(scoped)) {
    for (const entry of scoped as Array<{ display_name?: unknown; utilization?: unknown; resets_at?: unknown }>) {
      if (typeof entry?.display_name !== "string" || typeof entry.utilization !== "number") continue;
      const resetsAt = isoMs(entry.resets_at);
      windows.push({ id: scopedId(entry.display_name), kind: "weekly", label: `Weekly · ${entry.display_name}`, windowMinutes: WEEK_MINS, usedPercent: percent(entry.utilization), ...(resetsAt ? { resetsAt } : {}) });
    }
  }
  return windows;
}

/** The window one `rate_limit_event` reports, when it names one this kit knows. */
export function rateLimitEventWindow(info: Record<string, unknown>): LimitWindow | undefined {
  const type = info.rateLimitType;
  if (typeof type !== "string" || typeof info.utilization !== "number") return undefined;
  const shape = WINDOWS[type];
  if (!shape) return undefined;
  const resetsAt = typeof info.resetsAt === "number" && info.resetsAt > 0 ? info.resetsAt * 1000 : undefined;
  return { id: type, ...shape, usedPercent: percent(info.utilization * 100), ...(resetsAt ? { resetsAt } : {}) };
}

/** `windows` with each of `updates` in place of the window of the same id. */
export function mergeWindows(windows: readonly LimitWindow[], updates: readonly LimitWindow[]): LimitWindow[] {
  const merged = new Map(windows.map((window) => [window.id, window] as const));
  for (const update of updates) merged.set(update.id, update);
  return [...merged.values()];
}
