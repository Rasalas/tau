import { open } from "node:fs/promises";
import { HostCommandError } from "tau/host-extension";
import type { Job, SchedulingState } from "./protocol.js";
import { decodeConfig, object, text, timestamp } from "./validation.js";

export function assertStateBudget(state: SchedulingState): void {
  const bytes = Buffer.byteLength(JSON.stringify(state.jobs.map(({ id, config, workspaceId }) => ({ id, config, workspaceId }))));
  if (bytes + state.jobs.length * 8192 > 2_097_152) throw new HostCommandError("Configuration exceeds the 2 MiB scheduling store budget, including reserved run records.");
}

export async function readState(file: string): Promise<SchedulingState> {
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
  const jobs = value.jobs.map((input): Job => {
    const v = object(input, ["id", "config", "workspaceId", "detail", "enabled", "status", "nextAt", "lastRun"]);
    const id = text(v.id, "Job ID", 36);
    if (!/^[a-f0-9-]{36}$/u.test(id) || ids.has(id) || typeof v.enabled !== "boolean" || !["ready", "held", "starting", "running", "completed", "failed", "uncertain"].includes(v.status as string)) throw new HostCommandError("Invalid persisted scheduling job.");
    ids.add(id);
    const job: Job = { id, config: decodeConfig(v.config), workspaceId: text(v.workspaceId, "Workspace ID", 8192), enabled: v.enabled, status: v.status as Job["status"] };
    if (v.nextAt !== undefined) job.nextAt = timestamp(v.nextAt);
    if (v.detail !== undefined) job.detail = text(v.detail, "Job detail", 500);
    if (v.lastRun !== undefined) {
      const r = object(v.lastRun, ["intentId", "at", "threadId", "outcome", "detail"]);
      const outcome = text(r.outcome, "Run outcome", 16);
      if (!["starting", "running", "completed", "failed", "uncertain"].includes(outcome)) throw new HostCommandError("Invalid persisted run outcome.");
      job.lastRun = { intentId: text(r.intentId, "Intent ID", 36), at: timestamp(r.at), outcome };
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
