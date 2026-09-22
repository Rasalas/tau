/**
 * What the Usage kit's two halves agree on, and what it asks of the backend
 * kits. Nothing here reaches a provider: every number is one a runtime wrote
 * down while Tau ran it.
 */
export const USAGE_EXTENSION_ID = "tau.usage";

/** Settings page the kit contributes; `app.openSettings(USAGE_SETTINGS_PAGE)` opens it. */
export const USAGE_SETTINGS_PAGE = "usage";

/** Host command: `{ since?: number; refresh?: boolean }` → `UsageSummary`. */
export const USAGE_SUMMARY_COMMAND = "summary";

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

export interface UsageTotals extends UsageTokens {
  /** Billed model responses: assistant messages and compactions for Pi, turns for a backend. */
  requests: number;
  threads: number;
}

export interface UsageRow extends UsageTotals {
  backend: string;
  backendLabel: string;
  cwd: string;
  projectName: string;
  model: string;
}

/**
 * How one source did. `message` dates every response on its own; `thread`
 * dates a thread's whole total by its last activity, so a period filter is
 * only as fine as that.
 */
export interface UsageSourceReport {
  backend: string;
  label: string;
  status: "ok" | "empty" | "unavailable";
  detail: string;
  dating: "message" | "thread";
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
