import type { Job } from "./protocol.js";

export const busyJob = (job: Job) => job.status === "running" || job.status === "starting";
export const utc = (at?: string) => at ? new Date(at).toLocaleString([], { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " UTC" : "";
export function statusText(job: Job): string {
  if (job.status === "held") return job.detail ?? `Missed ${utc(job.nextAt)}. This host did not run it.`;
  if (job.status === "failed") return `Couldn't start or finish: ${job.lastRun?.detail ?? job.detail ?? "inspect the thread"}`;
  if (job.status === "uncertain") return `Tau restarted while starting the ${utc(job.lastRun?.at)} run. Unclear whether a thread started.`;
  if (busyJob(job)) return `${job.status === "starting" ? "Starting" : "Running"} since ${utc(job.lastRun?.at)}`;
  if (!job.enabled) return "Off";
  const next = job.config.schedule.kind === "webhook" ? "Waiting for signed delivery" : `Next: ${utc(job.nextAt) || "no future run"}`;
  return `${next}${job.lastRun ? ` · Last run ${utc(job.lastRun.at)} · ${job.lastRun.outcome === "completed" ? "finished" : job.lastRun.outcome}` : ""}`;
}
