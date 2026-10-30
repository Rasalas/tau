import { describeCron } from "./cron.js";
import type { Job, Schedule } from "./protocol.js";

export const busyJob = (job: Job) => job.status === "running" || job.status === "starting";
export const utc = (at?: string) => at ? new Date(at).toLocaleString([], { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " UTC" : "";
/** A cron job's times read in its own zone, without a suffix when that is this device's zone. */
export function jobTime(job: Job, at?: string): string {
  const schedule = job.config.schedule;
  if (schedule.kind !== "cron" || !at) return utc(at);
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone === schedule.timezone;
  return new Date(at).toLocaleString([], { timeZone: schedule.timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + (local ? "" : ` ${schedule.timezone}`);
}
/** "Every weekday at 09:00", or the expression when no sentence fits. */
export function scheduleText(schedule: Schedule): string {
  if (schedule.kind === "daily") return `Every day ${schedule.time} UTC`;
  if (schedule.kind === "webhook") return `Signed webhook${schedule.filters?.length ? ` · ${schedule.filters.length} payload ${schedule.filters.length === 1 ? "filter" : "filters"}` : ""}${schedule.coalescing ? ` · combines bursts (${schedule.coalescing.waitSeconds % 60 === 0 ? `${schedule.coalescing.waitSeconds / 60} min` : `${schedule.coalescing.waitSeconds} sec`})` : ""}`;
  if (schedule.kind === "once") return `Once ${utc(schedule.at)}`;
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone === schedule.timezone;
  return `${describeCron(schedule.expression) ?? `Cron ${schedule.expression}`}${local ? "" : ` (${schedule.timezone})`}`;
}
export function statusText(job: Job, now = Date.now()): string {
  if (job.status === "held") return job.detail ?? `Missed ${jobTime(job, job.nextAt)}. This machine did not run it.`;
  if (job.status === "failed") return `Couldn't start or finish: ${job.lastRun?.detail ?? job.detail ?? "inspect the thread"}`;
  if (job.status === "uncertain") return `Tau restarted while starting the ${utc(job.lastRun?.at)} run. ${job.config.target ? "Unclear whether the message reached the thread." : "Unclear whether a thread started."}`;
  if (busyJob(job)) return `${job.status === "starting" ? "Starting" : "Running"} since ${utc(job.lastRun?.at)}`;
  if (!job.enabled) return "Off";
  if (job.webhookBursts?.length) {
    const next = [...job.webhookBursts].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0]!;
    const seconds = Math.max(0, Math.ceil((Date.parse(next.dueAt) - now) / 1000));
    return `Combining ${next.count} ${next.count === 1 ? "delivery" : "deliveries"} · starts in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  const next = job.config.schedule.kind === "webhook" ? "Waiting for signed delivery" : `Next: ${jobTime(job, job.nextAt) || "no future run"}`;
  return `${next}${job.lastRun ? ` · Last run ${utc(job.lastRun.at)} · ${job.lastRun.outcome === "completed" ? "finished" : job.lastRun.outcome}${job.lastRun.deliveryCount ? ` · combined ${job.lastRun.deliveryCount} ${job.lastRun.deliveryCount === 1 ? "delivery" : "deliveries"}` : ""}` : ""}`;
}
