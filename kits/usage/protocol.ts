/**
 * What the Usage kit's two halves agree on, and what it asks of the backend
 * kits. Usage is what a runtime wrote down while Tau ran it; limits are what
 * a runtime's login reports about its plan. Money billed per token and the
 * API value of what a subscription covered are never summed into one figure.
 */
export const USAGE_EXTENSION_ID = "tau.usage";

/** Settings page the kit contributes; `app.openSettings(USAGE_SETTINGS_PAGE)` opens it. */
export const USAGE_SETTINGS_PAGE = "usage";

/** Host command: `{ since?: number; refresh?: boolean }` → `UsageSummary`. */
export const USAGE_SUMMARY_COMMAND = "summary";

/** Host command: `{ refresh?: boolean }` → `UsageLimitsSummary`. */
export const USAGE_LIMITS_COMMAND = "limits";

/**
 * The command a backend kit registers for this kit (`callers: ["tau.usage"]`).
 * It answers `BackendUsageAnswer` from its own store and must never reach the
 * network.
 */
export const BACKEND_USAGE_COMMAND = "usage";

/** Tokens and money one thread or one row accounts for. */
export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

/**
 * The command a kit registers for this kit when its runtime's login reports
 * quota windows (`callers: ["tau.usage"]`): `{ refresh?: boolean }` →
 * `BackendLimitsAnswer`. It may read the account; it must change nothing on it.
 */
export const BACKEND_LIMITS_COMMAND = "usage-limits";

/** How a turn was paid for, where the runtime knew. */
export type UsageBilling = "subscription" | "api-key" | "free" | "local";

/** One turn of a backend thread, dated on its own. */
export interface BackendUsageTurn extends UsageTokens {
  at: number;
  provider?: string;
  model?: string;
  billing?: UsageBilling;
  /** Turns it sums; more than one where old turns were folded together. */
  turns: number;
}

/** A backend kit's answer to `BACKEND_USAGE_COMMAND`. */
export interface BackendUsageAnswer {
  threads: BackendUsageThread[];
}

export interface BackendUsageThread {
  threadId: string;
  cwd: string;
  /** What the thread last ran on, as the backend names it. */
  model?: string;
  /** Last activity; the whole running total is dated here. */
  updatedAt: number;
  /** Running total over every turn; absent when the backend kept none. */
  usage?: UsageTokens & { turns: number };
  /** Each turn on its own; a thread from before its kit kept turns has only `usage`. */
  turns?: BackendUsageTurn[];
}

/** One quota window of a plan. */
export interface UsageLimitWindow {
  id: string;
  kind: "session" | "weekly" | "monthly" | "other";
  label: string;
  /** 0–100. */
  usedPercent: number;
  /** Epoch ms. */
  resetsAt?: number;
  windowMinutes?: number;
}

/** One account's windows, as a kit reports them. */
export interface UsageLimitAccount {
  id: string;
  /** The runtime backend it belongs to (`codex`, `claude-code@work`, `pi`). */
  runtime: string;
  label: string;
  plan?: string;
  checkedAt: number;
  windows: UsageLimitWindow[];
  /** Why there are no windows: an API key has none, a read failed, nobody is signed in. */
  unavailable?: { reason: "unsupported" | "failed" | "signed-out"; message?: string };
}

/** A kit's answer to `BACKEND_LIMITS_COMMAND`. */
export interface BackendLimitsAnswer {
  accounts: UsageLimitAccount[];
}

/** A kit whose runtime's login reports quota windows. */
export interface LimitSource {
  extensionId: string;
  label: string;
}

/** Asked for limits. Antigravity's agent reports none. */
export const LIMIT_SOURCES: readonly LimitSource[] = [
  { extensionId: "tau.pi-limits", label: "Pi" },
  { extensionId: "tau.claude-code", label: "Claude Code" },
  { extensionId: "tau.codex", label: "Codex" },
];

export interface UsageLimitSourceReport {
  extensionId: string;
  label: string;
  status: "ok" | "empty" | "unavailable";
  detail: string;
}

export interface UsageLimitsSummary {
  checkedAt: number;
  accounts: UsageLimitAccount[];
  sources: UsageLimitSourceReport[];
}

/** A runtime backend whose kit keeps usage per thread. */
export interface BackendUsageSource {
  extensionId: string;
  backend: string;
  label: string;
}

/** Backends asked besides Pi. A new backend kit adds its row here and answers the command. */
export const BACKEND_USAGE_SOURCES: readonly BackendUsageSource[] = [
  { extensionId: "tau.claude-code", backend: "claude-code", label: "Claude Code" },
  { extensionId: "tau.antigravity", backend: "antigravity", label: "Antigravity" },
  { extensionId: "tau.codex", backend: "codex", label: "Codex" },
];

export const PI_BACKEND = "pi";

/** What a subscription covered: its tokens, and what the provider's API would have charged for them. */
export interface UsageShare {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  requests: number;
  apiValueUsd: number;
}

/**
 * Every token counts in the token fields; `costUsd` is only money billed per
 * token, and `subscription` holds what a plan covered, with its API value.
 */
export interface UsageTotals extends UsageTokens {
  /** Billed model responses: assistant messages and compactions for Pi, turns for a backend. */
  requests: number;
  threads: number;
  subscription: UsageShare;
}

export interface UsageRow extends UsageTokens {
  backend: string;
  backendLabel: string;
  cwd: string;
  projectName: string;
  /** As shown: `provider/id` for Pi, the backend's own name otherwise. */
  model: string;
  provider?: string;
  modelId?: string;
  /** How it was paid for; a row never mixes two. */
  billing?: UsageBilling;
  requests: number;
  threads: number;
  /** Billed per token; 0 for a subscription. */
  costUsd: number;
  /** For a subscription: what the API would have charged. */
  apiValueUsd: number;
  /** Where the figure came from: the user's price, the runtime's, the API list, none. */
  priceSource?: "custom" | "runtime" | "api" | "none";
}

/**
 * How one source did. `message` dates every response on its own, `turn` every
 * turn; `thread` dates a thread's whole total by its last activity, so a
 * period filter is only as fine as that.
 */
export interface UsageSourceReport {
  backend: string;
  label: string;
  status: "ok" | "empty" | "unavailable";
  detail: string;
  dating: "message" | "turn" | "thread";
}

export interface UsageSummary {
  /** Start of the period in epoch ms; absent means all time. */
  since?: number;
  /** When the sources were last read. */
  scannedAt: number;
  totals: UsageTotals;
  rows: UsageRow[];
  sources: UsageSourceReport[];
}

export interface UsageSummaryInput {
  since?: number;
  /** Reads the sources again instead of answering from the cache. */
  refresh?: boolean;
}
