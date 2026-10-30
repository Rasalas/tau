import { open } from "node:fs/promises";
import { HostCommandError } from "tau/host-extension";
import { MAX_BURST_DELIVERIES, decodePendingWebhooks, type StoredJob, type StoredSchedulingState } from "./webhook-pending.js";
import { decodeConfig, object, text, timestamp } from "./validation.js";
import { REMEMBERED_DELIVERIES } from "./webhooks.js";

export function assertStateBudget(state: StoredSchedulingState): void {
  const bytes = Buffer.byteLength(JSON.stringify(state.jobs.map(({ id, config, workspaceId, deliveries, webhookPending }) => ({ id, config, workspaceId, deliveries, webhookPending }))));
  if (bytes + state.jobs.length * 12_288 > 2_097_152 || Buffer.byteLength(JSON.stringify({ version: 1, ...state })) > 2_097_152) throw new HostCommandError("Configuration exceeds the 2 MiB scheduling store budget, including reserved run records.");
}

export async function readState(file: string): Promise<StoredSchedulingState> {
  const handle = await open(file, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return { enabled: false, jobs: [] };
  let raw: string;
  try {
    if ((await handle.stat()).size > 2_097_152) throw new HostCommandError("Scheduling state exceeds 2 MiB. It was not changed.");
    raw = await handle.readFile("utf8");
  } finally { await handle.close(); }
  const value = object(JSON.parse(raw), ["version", "enabled", "jobs"]);
  if (value.version !== 1 || typeof value.enabled !== "boolean" || !Array.isArray(value.jobs) || value.jobs.length > 100) throw new HostCommandError("Unsupported scheduling state. It was not changed.");
  const ids = new Set<string>();
  const jobs = value.jobs.map((input): StoredJob => {
    const v = object(input, ["id", "config", "workspaceId", "detail", "enabled", "status", "nextAt", "lastRun", "secretRef", "deliveries", "webhookPending", "origin"]);
    const id = text(v.id, "Job ID", 36);
    if (!/^[a-f0-9-]{36}$/u.test(id) || ids.has(id) || typeof v.enabled !== "boolean" || !["ready", "held", "starting", "running", "completed", "failed", "uncertain"].includes(v.status as string)) throw new HostCommandError("Invalid persisted scheduling job.");
    ids.add(id);
    const job: StoredJob = { id, config: decodeConfig(v.config), workspaceId: text(v.workspaceId, "Workspace ID", 8192), enabled: v.enabled, status: v.status as StoredJob["status"] };
    if (v.webhookPending !== undefined) {
      if (job.config.schedule.kind !== "webhook") throw new HostCommandError("Only webhook jobs may have persisted webhook windows.");
      job.webhookPending = decodePendingWebhooks(v.webhookPending);
    }
    if (v.nextAt !== undefined) job.nextAt = timestamp(v.nextAt);
    if (v.detail !== undefined) job.detail = text(v.detail, "Job detail", 500);
    if (v.secretRef !== undefined) {
      job.secretRef = text(v.secretRef, "Secret reference", 36);
      if (!/^[a-f0-9-]{36}$/u.test(job.secretRef)) throw new HostCommandError("Invalid private secret reference.");
    }
    if (v.deliveries !== undefined) {
      if (!Array.isArray(v.deliveries) || v.deliveries.length > REMEMBERED_DELIVERIES || v.deliveries.some((deliveryId) => typeof deliveryId !== "string" || !/^\d{13}:[A-Za-z0-9._-]{1,64}$/u.test(deliveryId))) throw new HostCommandError("Invalid webhook delivery history.");
      job.deliveries = [...v.deliveries] as string[];
    }
    if (v.origin !== undefined) {
      const origin = object(v.origin, ["threadId"]);
      job.origin = { threadId: text(origin.threadId, "Origin thread ID", 256) };
    }
    if (v.lastRun !== undefined) {
      const r = object(v.lastRun, ["intentId", "at", "threadId", "outcome", "detail", "webhookBurstId", "deliveryCount"]);
      const outcome = text(r.outcome, "Run outcome", 16);
      if (!["starting", "running", "completed", "failed", "uncertain"].includes(outcome)) throw new HostCommandError("Invalid persisted run outcome.");
      job.lastRun = { intentId: text(r.intentId, "Intent ID", 36), at: timestamp(r.at), outcome };
      if (r.webhookBurstId !== undefined || r.deliveryCount !== undefined) {
        const burstId = text(r.webhookBurstId, "Run webhook window ID", 36);
        if (!/^[a-f0-9-]{36}$/u.test(burstId) || !Number.isInteger(r.deliveryCount) || (r.deliveryCount as number) < 1 || (r.deliveryCount as number) > MAX_BURST_DELIVERIES || job.webhookPending?.some((entry) => entry.id === burstId)) throw new HostCommandError("Invalid persisted combined run.");
        job.lastRun.webhookBurstId = burstId; job.lastRun.deliveryCount = r.deliveryCount as number;
      }
      if (r.threadId !== undefined) job.lastRun.threadId = text(r.threadId, "Thread ID", 256);
      if (r.detail !== undefined) job.lastRun.detail = text(r.detail, "Run detail", 500);
    }
    if (["starting", "running", "uncertain"].includes(job.status) && !job.lastRun) throw new HostCommandError("Scheduling intent is missing. State was not changed.");
    return job;
  });
  const state = { enabled: value.enabled, jobs };
  assertStateBudget(state);
  return state;
}
