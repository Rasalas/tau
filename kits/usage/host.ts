import { join } from "node:path";
import type { WorkerHostExtension, WorkerHostExtensionContext } from "tau/host";
import { applyPrices, priceEntries, summarize, type BackendScan, type RowPrice, type UsageScan } from "./aggregate.js";
import { PiUsageCache } from "./pi-sessions.js";
import {
  BACKEND_LIMITS_COMMAND,
  BACKEND_USAGE_COMMAND,
  BACKEND_USAGE_SOURCES,
  LIMIT_SOURCES,
  USAGE_EXTENSION_ID,
  USAGE_LIMITS_COMMAND,
  USAGE_SUMMARY_COMMAND,
  type BackendUsageAnswer,
  type BackendUsageSource,
  type BackendUsageThread,
  type BackendUsageTurn,
  type LimitSource,
  type UsageBilling,
  type UsageLimitAccount,
  type UsageLimitSourceReport,
  type UsageLimitWindow,
  type UsageLimitsSummary,
  type UsageSummary,
} from "./protocol.js";

/** A scan younger than this answers without touching the disk, unless a turn ended since. */
export const SCAN_MAX_AGE_MS = 5 * 60_000;

/** Limits read younger than this answer without asking the kits again. */
export const LIMITS_MAX_AGE_MS = 5 * 60_000;

export interface UsageHostOptions {
  now?(): number;
  sources?: readonly BackendUsageSource[];
  limitSources?: readonly LimitSource[];
}

const BILLING = new Set<string>(["subscription", "api-key", "free", "local"]);

function billingOf(value: unknown): UsageBilling | undefined {
  return typeof value === "string" && BILLING.has(value) ? value as UsageBilling : undefined;
}

function turnsOf(value: unknown): BackendUsageTurn[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item): BackendUsageTurn[] => {
    const usage = usageOf(item);
    const at = item && typeof item === "object" ? finite((item as { at?: unknown }).at) : undefined;
    if (!usage || at === undefined) return [];
    const raw = item as Record<string, unknown>;
    const billing = billingOf(raw.billing);
    return [{
      ...usage,
      at,
      ...(typeof raw.provider === "string" && raw.provider ? { provider: raw.provider } : {}),
      ...(typeof raw.model === "string" && raw.model ? { model: raw.model } : {}),
      ...(billing ? { billing } : {}),
    }];
  });
}

function windowOf(value: unknown): UsageLimitWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const used = typeof raw.usedPercent === "number" && Number.isFinite(raw.usedPercent) ? Math.max(0, Math.min(100, raw.usedPercent)) : undefined;
  const kind = raw.kind === "session" || raw.kind === "weekly" || raw.kind === "monthly" ? raw.kind : "other";
  if (typeof raw.id !== "string" || typeof raw.label !== "string" || used === undefined) return undefined;
  const resetsAt = finite(raw.resetsAt);
  const windowMinutes = finite(raw.windowMinutes);
  return { id: raw.id, kind, label: raw.label, usedPercent: used, ...(resetsAt ? { resetsAt } : {}), ...(windowMinutes ? { windowMinutes } : {}) };
}

/** Another kit's limits, kept to the agreed shape. */
export function readLimitsAnswer(value: unknown): UsageLimitAccount[] | undefined {
  const accounts = value && typeof value === "object" ? (value as { accounts?: unknown }).accounts : undefined;
  if (!Array.isArray(accounts)) return undefined;
  return accounts.flatMap((item): UsageLimitAccount[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const checkedAt = finite(raw.checkedAt);
    if (typeof raw.id !== "string" || typeof raw.runtime !== "string" || typeof raw.label !== "string" || checkedAt === undefined) return [];
    const unavailable = raw.unavailable && typeof raw.unavailable === "object" ? raw.unavailable as { reason?: unknown; message?: unknown } : undefined;
    const why = unavailable?.reason === "unsupported" || unavailable?.reason === "failed" || unavailable?.reason === "signed-out" ? unavailable.reason : undefined;
    return [{
      id: raw.id,
      runtime: raw.runtime,
      label: raw.label,
      ...(typeof raw.plan === "string" && raw.plan ? { plan: raw.plan } : {}),
      checkedAt,
      windows: Array.isArray(raw.windows) ? raw.windows.flatMap((window) => windowOf(window) ?? []) : [],
      ...(why ? { unavailable: { reason: why, ...(typeof unavailable?.message === "string" ? { message: unavailable.message } : {}) } } : {}),
    }];
  });
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageOf(value: unknown): BackendUsageThread["usage"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costUsd", "turns"] as const;
  const usage: Partial<Record<(typeof fields)[number], number>> = {};
  for (const field of fields) {
    const number = finite(item[field]);
    if (number === undefined) return undefined;
    usage[field] = number;
  }
  return usage as NonNullable<BackendUsageThread["usage"]>;
}

/** Another kit's answer is data from outside this kit: keep only what has the agreed shape. */
export function readBackendAnswer(value: unknown): BackendUsageAnswer | undefined {
  const threads = value && typeof value === "object" ? (value as { threads?: unknown }).threads : undefined;
  if (!Array.isArray(threads)) return undefined;
  return {
    threads: threads.flatMap((item): BackendUsageThread[] => {
      if (!item || typeof item !== "object") return [];
      const thread = item as Record<string, unknown>;
      const updatedAt = finite(thread.updatedAt);
      if (typeof thread.threadId !== "string" || typeof thread.cwd !== "string" || updatedAt === undefined) return [];
      const usage = usageOf(thread.usage);
      const turns = turnsOf(thread.turns);
      return [{
        threadId: thread.threadId,
        cwd: thread.cwd,
        updatedAt,
        ...(typeof thread.model === "string" && thread.model ? { model: thread.model } : {}),
        ...(usage ? { usage } : {}),
        ...(turns ? { turns } : {}),
      }];
    }),
  };
}

/** Day starts from a client: finite, ascending, at most a year of them. */
export function readDays(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 366) return undefined;
  const days = value.map(finite);
  if (days.some((day, index) => day === undefined || (index > 0 && day <= days[index - 1]!))) return undefined;
  return days as number[];
}

function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\.$/u, "");
}

/**
 * The host half of `tau.usage`. It runs in a worker: it reads Pi's session
 * files and asks the backend kits for the totals they keep, and holds nothing
 * of the host's. Everything it reads is local; no provider is called.
 */
export function createUsageHostExtension(options: UsageHostOptions = {}): WorkerHostExtension & { permissions: string[] } {
  const now = options.now ?? Date.now;
  const sources = options.sources ?? BACKEND_USAGE_SOURCES;
  return {
    id: USAGE_EXTENSION_ID,
    name: "Usage",
    permissions: ["sessions"],
    async activate(context: WorkerHostExtensionContext) {
      const services = context.services;
      const cache = new PiUsageCache(join(services.stateDir, "pi-usage.json"));
      let scan: UsageScan | undefined;
      let stale = true;
      let reading: Promise<UsageScan> | undefined;

      const askBackend = async (source: BackendUsageSource): Promise<BackendScan> => {
        try {
          const answer = readBackendAnswer(await context.invokeHostExtension(source.extensionId, BACKEND_USAGE_COMMAND));
          return answer ? { source, answer } : { source, error: `${source.label} answered in a shape this kit does not read` };
        } catch (error) {
          return { source, error: reason(error) };
        }
      };

      const read = async (): Promise<UsageScan> => {
        stale = false;
        const [pi, backends] = await Promise.all([cache.scan(services.sessionsDir), Promise.all(sources.map(askBackend))]);
        return { scannedAt: now(), sessionsDir: services.sessionsDir, pi, backends };
      };

      const current = (refresh: boolean): Promise<UsageScan> => {
        if (reading) return reading;
        if (!refresh && scan && !stale && now() - scan.scannedAt < SCAN_MAX_AGE_MS) return Promise.resolve(scan);
        reading = read().then((next) => { scan = next; return next; }).finally(() => { reading = undefined; });
        return reading;
      };

      const stopObserving = await services.registerTurnObserver({ ended: () => { stale = true; } });

      /** Core's prices for the rows and entries; the runtimes' own when this core has none to give. */
      const price = async (summary: UsageSummary): Promise<UsageSummary> => {
        if (summary.rows.length === 0 || !services.priceUsage) return summary;
        const entries = summary.entries ?? [];
        try {
          const priced = await services.priceUsage([...summary.rows, ...entries].map((row) => ({
            ...(row.provider ? { provider: row.provider } : {}),
            model: row.modelId ?? row.model,
            ...(row.billing ? { billing: row.billing } : {}),
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cacheReadTokens: row.cacheReadTokens,
            cacheWriteTokens: row.cacheWriteTokens,
            totalTokens: row.totalTokens,
            // The row was summed unpriced; a subscription's runtime figure sits in its value.
            costUsd: row.costUsd + row.apiValueUsd,
            turns: row.requests,
          })));
          const prices = priced.map((entry): RowPrice => ({ ...(entry.billing ? { billing: entry.billing } : {}), costUsd: entry.costUsd, apiValueUsd: entry.apiValueUsd, source: entry.source }));
          const rows = applyPrices(summary, prices.slice(0, summary.rows.length));
          return summary.entries ? { ...rows, entries: priceEntries(entries.map((entry) => ({ ...entry, costUsd: entry.costUsd + entry.apiValueUsd })), prices.slice(summary.rows.length)) } : rows;
        } catch (error) {
          services.log("usage.price-failed", reason(error));
          return summary;
        }
      };

      // A cold cache over a long history may take longer than a command's timeout.
      context.registerCommand(USAGE_SUMMARY_COMMAND, async (input): Promise<UsageSummary> => {
        const request = input && typeof input === "object" ? input as { since?: unknown; refresh?: unknown; days?: unknown } : {};
        const since = finite(request.since);
        const days = readDays(request.days);
        const result = await current(request.refresh === true);
        return price(summarize(result, { ...(since === undefined ? {} : { since }), ...(days ? { days } : {}) }));
      }, { access: "read", long: true });

      const limitSources = options.limitSources ?? LIMIT_SOURCES;
      let limits: UsageLimitsSummary | undefined;
      let readingLimits: Promise<UsageLimitsSummary> | undefined;
      const readLimits = async (refresh: boolean): Promise<UsageLimitsSummary> => {
        const answers = await Promise.all(limitSources.map(async (source): Promise<{ source: LimitSource; accounts?: UsageLimitAccount[]; error?: string }> => {
          try {
            const accounts = readLimitsAnswer(await context.invokeHostExtension(source.extensionId, BACKEND_LIMITS_COMMAND, refresh ? { refresh } : {}));
            return accounts ? { source, accounts } : { source, error: `${source.label} answered in a shape this kit does not read` };
          } catch (error) {
            return { source, error: reason(error) };
          }
        }));
        const reports = answers.map(({ source, accounts, error }): UsageLimitSourceReport => {
          const base = { extensionId: source.extensionId, label: source.label };
          if (!accounts) return { ...base, status: "unavailable", detail: `Not available: ${error ?? "no answer"}.` };
          if (accounts.length === 0) return { ...base, status: "empty", detail: source.extensionId === "tau.pi-limits" ? "No subscription provider has reported limits yet; they come with its next answer." : "No account reports limits." };
          const windows = accounts.reduce((sum, account) => sum + account.windows.length, 0);
          return { ...base, status: "ok", detail: `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}, ${windows} ${windows === 1 ? "window" : "windows"}.` };
        });
        return { checkedAt: now(), accounts: answers.flatMap((answer) => answer.accounts ?? []), sources: reports };
      };
      context.registerCommand(USAGE_LIMITS_COMMAND, async (input): Promise<UsageLimitsSummary> => {
        const refresh = Boolean(input && typeof input === "object" && (input as { refresh?: unknown }).refresh);
        if (!refresh && limits && now() - limits.checkedAt < LIMITS_MAX_AGE_MS) return limits;
        readingLimits ??= readLimits(refresh).then((next) => { limits = next; return next; }).finally(() => { readingLimits = undefined; });
        return readingLimits;
      }, { access: "read", long: true });

      return () => { stopObserving(); };
    },
  };
}

export default createUsageHostExtension;
