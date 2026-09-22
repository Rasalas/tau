import { join } from "node:path";
import type { WorkerHostExtension, WorkerHostExtensionContext } from "tau/host";
import { summarize, type BackendScan, type UsageScan } from "./aggregate.js";
import { PiUsageCache } from "./pi-sessions.js";
import {
  BACKEND_USAGE_COMMAND,
  BACKEND_USAGE_SOURCES,
  USAGE_EXTENSION_ID,
  USAGE_SUMMARY_COMMAND,
  type BackendUsageAnswer,
  type BackendUsageSource,
  type BackendUsageThread,
  type UsageSummary,
} from "./protocol.js";

/** A scan younger than this answers without touching the disk, unless a turn ended since. */
export const SCAN_MAX_AGE_MS = 5 * 60_000;

export interface UsageHostOptions {
  now?(): number;
  sources?: readonly BackendUsageSource[];
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
      return [{
        threadId: thread.threadId,
        cwd: thread.cwd,
        updatedAt,
        ...(typeof thread.model === "string" && thread.model ? { model: thread.model } : {}),
        ...(usage ? { usage } : {}),
      }];
    }),
  };
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

      // A cold cache over a long history may take longer than a command's timeout.
      context.registerCommand(USAGE_SUMMARY_COMMAND, async (input): Promise<UsageSummary> => {
        const request = input && typeof input === "object" ? input as { since?: unknown; refresh?: unknown } : {};
        const since = finite(request.since);
        const result = await current(request.refresh === true);
        return summarize(result, since === undefined ? {} : { since });
      }, { long: true });

      return () => { stopObserving(); };
    },
  };
}

export default createUsageHostExtension;
