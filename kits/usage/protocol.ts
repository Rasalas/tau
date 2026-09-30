/**
 * What the Usage kit's two halves agree on, and what it asks of the backend
 * kits. Usage is what a runtime wrote down while Tau ran it, and what the
 * agent CLIs logged on their own outside Tau; limits are what a runtime's
 * login reports about its plan. Money billed per token and the
 * API value of what a subscription covered are never summed into one figure.
 */
export const USAGE_EXTENSION_ID = "tau.usage";

/** The app page the kit contributes; `actions.openPage(USAGE_PAGE)` opens it. */
export const USAGE_PAGE = "usage";

/** Host command: `{ since?: number; refresh?: boolean }` → `UsageSummary`. */
export const USAGE_SUMMARY_COMMAND = "summary";

/** Host command: `{ refresh?: boolean }` → `UsageLimitsSummary`. */
export const USAGE_LIMITS_COMMAND = "limits";
/** Explicit account write; `{ runtime, accountId }` → `ResetOutcome`. */
export const USAGE_REDEEM_RESET_COMMAND = "redeem-reset";
export const BACKEND_REDEEM_RESET_COMMAND = "usage-redeem-reset";
export type ResetOutcome = "reset" | "nothingToReset" | "alreadyRedeemed" | "alreadySettled" | "noCredit";


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
  /** The runtime's own session id, as its CLI logs it; work logged under it is this thread's. */
  sessionId?: string;
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

/**
 * The command a runtime kit registers for this kit (`callers: ["tau.usage"]`)
 * when its CLI logs usage on its own: `{}` → `BackendLogsAnswer`. It names
 * each instance's folders from that instance's configuration and reads
 * nothing itself; this kit reads them in its worker, counts only, and skips
 * the sessions the kit's `usage` answer names as Tau's.
 */
export const BACKEND_LOGS_COMMAND = "usage-logs";

/** How a log folder is laid out: Codex rollouts, the Agent SDK CLI's projects, OpenCode's data folder. */
export type OutsideFormat = "codex" | "agent-sdk" | "opencode";

export interface BackendLogFolder {
  format: OutsideFormat;
  /** Absolute. */
  path: string;
  /** The instance it belongs to (`codex`, `codex@work`). */
  instance: string;
  /** How the instance's login bills now, when the kit knows; an older log may have run on another. */
  billing?: UsageBilling;
}

export interface BackendLogsAnswer {
  folders: BackendLogFolder[];
}

/** A runtime kit whose CLI logs its own sessions. */
export interface OutsideLogSource {
  extensionId: string;
  backend: string;
  label: string;
}

/** Asked for log folders. */
export const OUTSIDE_LOG_SOURCES: readonly OutsideLogSource[] = [
  { extensionId: "tau.codex", backend: "codex", label: "Codex" },
  { extensionId: "tau.claude-code", backend: "claude-code", label: "Claude Code" },
  { extensionId: "tau.opencode", backend: "opencode", label: "OpenCode" },
];

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
  /** Provider controls for usage that is managed outside Tau. */
  managementUrl?: string;
  resetCredits?: { availableCount: number; pending?: boolean; nextExpiresAt?: number; nextCreditId?: string; unavailable?: string };
  windows: UsageLimitWindow[];
  /** Why there are no windows: an API key has none, a read failed, nobody is signed in. */
  unavailable?: { reason: "unsupported" | "failed" | "signed-out"; message?: string };
  /** Who is signed in, so two runtimes on one account show once. */
  identity?: UsageAccountIdentity;
  /** Set by the page on another machine's accounts (its host id); a host never sends it. */
  machine?: string;
}

/**
 * A login's account, read locally by its kit. `key` is the SHA-256 hex of
 * `tau.account\n<provider>\n<account id>`, never the id: the same account
 * through two runtimes gives the same key. `openai` hashes the ChatGPT
 * account id (with `:<user id>` where the token names one), `anthropic`
 * `org:<organization id>` for a personal plan.
 */
export interface UsageAccountIdentity {
  provider: string;
  key: string;
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
  { extensionId: "tau.grok", label: "Grok" },
];

export interface UsageLimitSourceReport {
  extensionId: string;
  label: string;
  status: "ok" | "empty" | "unavailable";
  detail: string;
}

/** One account as a limits source reported it, at its own `checkedAt`. */
export interface UsageLimitSample {
  /** The kit that reported it. */
  source: string;
  account: UsageLimitAccount;
}

export interface UsageLimitsSummary {
  checkedAt: number;
  accounts: UsageLimitAccount[];
  sources: UsageLimitSourceReport[];
  /** Readings of the last 24 hours, each one a new observation (a cached answer is not). */
  history?: UsageLimitSample[];
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
  { extensionId: "tau.opencode", backend: "opencode", label: "OpenCode" },
  { extensionId: "tau.grok", backend: "grok", label: "Grok" },
  { extensionId: "tau.cursor", backend: "cursor", label: "Cursor" },
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
  /** Work the CLI logged outside Tau. */
  outside?: boolean;
}

/**
 * How one source did. `message` dates every response on its own, `turn` every
 * turn; `thread` dates a thread's whole total by its last activity, so a
 * period filter is only as fine as that.
 */
export interface UsageSourceReport {
  backend: string;
  label: string;
  /** `reading`: a first read of a large log history is still under way. */
  status: "ok" | "empty" | "unavailable" | "reading";
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
  /** With `days` asked for: the period split by day and thread. */
  entries?: UsageEntry[];
  /** The CLIs' logs are still being read; asking again soon gives more. */
  reading?: boolean;
}

export interface UsageSummaryInput {
  since?: number;
  /** Reads the sources again instead of answering from the cache. */
  refresh?: boolean;
  /**
   * Where each day starts (epoch ms, ascending): the client's own midnights,
   * so a remote host counts the user's days. The summary adds `entries`.
   */
  days?: number[];
}

/** What one thread used of one model on one day, priced like a row. */
export interface UsageEntry extends UsageTokens {
  /** Index into the `days` asked for. */
  day: number;
  backend: string;
  threadId: string;
  cwd: string;
  model: string;
  provider?: string;
  modelId?: string;
  billing?: UsageBilling;
  requests: number;
  apiValueUsd: number;
  /** Work the CLI logged outside Tau; `threadId` is then its own session id. */
  outside?: boolean;
  /** Set by the page on another machine's entries (its host id); a host never sends it. */
  machine?: string;
}
