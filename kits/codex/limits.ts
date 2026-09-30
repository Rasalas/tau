/**
 * Codex's subscription windows for the Usage kit. `account/rateLimits/read`
 * and the `account/rateLimits/updated` notification carry the same snapshot,
 * so one mapper serves both; windows keep the ids `primary` and `secondary`
 * so a turn's update lands on the row a read drew.
 */
export interface CodexRateWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  /** Epoch seconds. */
  resetsAt?: number | null;
}

export interface CodexRateSnapshot {
  limitId?: string | null;
  planType?: string | null;
  primary?: CodexRateWindow | null;
  secondary?: CodexRateWindow | null;
}

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
  /** Provider controls for usage that is managed outside Tau. */
  managementUrl?: string;
  resetCredits?: { availableCount: number; pending?: boolean; nextExpiresAt?: number; nextCreditId?: string; unavailable?: string };
  windows: LimitWindow[];
  /** A hash of the provider's account id, for showing one account once; never the id itself. */
  identity?: { provider: string; key: string };
  /** Why there are no windows: an API key has none, a read failed, nobody is signed in. */
  unavailable?: { reason: "unsupported" | "failed" | "signed-out"; message?: string };
}

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

function kindFor(minutes: number): LimitWindow["kind"] {
  if (minutes >= MONTH_MINS - 24 * 60) return "monthly";
  if (minutes >= WEEK_MINS - 24 * 60) return "weekly";
  return "session";
}

const LABELS: Record<LimitWindow["kind"], string> = { session: "5-hour", weekly: "Weekly", monthly: "Monthly", other: "Limit" };

function snapshotOf(value: unknown): CodexRateSnapshot | undefined {
  return value && typeof value === "object" ? value as CodexRateSnapshot : undefined;
}

/**
 * The main allowance's windows. `primary` and `secondary` are positions, not
 * lengths: most plans send the length, and a Free or Go plan without one has a
 * single monthly allowance. A model's own bucket (`limitId` other than
 * `codex`) is left out.
 */
export function codexLimitWindows(value: unknown): LimitWindow[] {
  const snapshot = snapshotOf(value);
  if (!snapshot || (snapshot.limitId && snapshot.limitId !== "codex")) return [];
  const monthlyPlan = snapshot.planType === "free" || snapshot.planType === "go";
  const windows: LimitWindow[] = [];
  for (const [id, window, fallback] of [["primary", snapshot.primary, monthlyPlan ? MONTH_MINS : SESSION_MINS], ["secondary", snapshot.secondary, WEEK_MINS]] as const) {
    if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
    const minutes = typeof window.windowDurationMins === "number" && window.windowDurationMins > 0 ? window.windowDurationMins : fallback;
    const kind = kindFor(minutes);
    const label = kind === "session" && minutes !== SESSION_MINS ? `${Math.round(minutes / 60)}-hour` : LABELS[kind];
    windows.push({
      id,
      kind,
      label,
      usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
      windowMinutes: minutes,
      ...(typeof window.resetsAt === "number" && window.resetsAt > 0 ? { resetsAt: window.resetsAt * 1000 } : {}),
    });
  }
  return windows;
}

/** The read's main bucket: `rateLimitsByLimitId.codex` when present, else the single-bucket view. */
export function codexReadSnapshot(response: unknown): CodexRateSnapshot | undefined {
  if (!response || typeof response !== "object") return undefined;
  const read = response as { rateLimits?: unknown; rateLimitsByLimitId?: Record<string, unknown> | null };
  return snapshotOf(read.rateLimitsByLimitId?.codex) ?? snapshotOf(read.rateLimits);
}

/**
 * A notification is a partial view: a field it leaves out keeps what was seen
 * before. Another model's bucket never replaces the main one.
 */
export function mergeCodexSnapshot(previous: CodexRateSnapshot | undefined, update: unknown): CodexRateSnapshot | undefined {
  const next = snapshotOf(update);
  if (!next || (next.limitId && next.limitId !== "codex")) return previous;
  if (!previous) return next;
  return {
    ...previous,
    ...(next.limitId != null ? { limitId: next.limitId } : {}),
    ...(next.planType != null ? { planType: next.planType } : {}),
    ...(next.primary !== undefined ? { primary: next.primary } : {}),
    ...(next.secondary !== undefined ? { secondary: next.secondary } : {}),
  };
}

/** The official read response reports reset credits separately from quota windows. */
export function codexResetCredits(response: unknown, now = Date.now()): LimitAccount["resetCredits"] {
  const summary = (response as { rateLimitResetCredits?: { availableCount?: unknown; credits?: Array<{ status?: string; expiresAt?: number | null }> } } | undefined)?.rateLimitResetCredits;
  if (!summary || typeof summary.availableCount !== "number" || !Number.isSafeInteger(summary.availableCount) || summary.availableCount < 0) return undefined;
  const expiries = (summary.credits ?? []).filter((credit) => credit.status === "available" && typeof credit.expiresAt === "number" && Number.isFinite(credit.expiresAt) && credit.expiresAt * 1000 > now).map((credit) => credit.expiresAt! * 1000);
  return { availableCount: summary.availableCount, ...(expiries.length ? { nextExpiresAt: Math.min(...expiries) } : {}) };
}
