import { createHash, randomUUID } from "node:crypto";
import { HostCommandError } from "tau/host-extension";
import { WEBHOOK_FORMATS, type Job, type SchedulingState, type WebhookBurst, type WebhookCoalescing, type WebhookFormat } from "./protocol.js";
import { decodeWebhookCoalescing } from "./webhook-coalescing.js";
import { webhookKeyValue } from "./webhook-path.js";
import { object, text, timestamp } from "./validation.js";
import type { WebhookDelivery } from "./webhooks.js";

export const MAX_PENDING_WEBHOOKS = 16;
export const MAX_PENDING_WEBHOOK_BODY = 65_536;
export const MAX_BURST_DELIVERIES = 10_000;
export interface PendingWebhook extends WebhookBurst {
  /** Host-only data, removed from every command response and event. */
  body: string;
  /** Latest verified sender facts, retained with its raw body through a restart. */
  delivery?: Pick<WebhookDelivery, "id" | "timestamp" | "format" | "event">;
  keyDigest?: string;
  coalescing: WebhookCoalescing;
}
export interface StoredJob extends Job { webhookPending?: PendingWebhook[] }
export interface StoredSchedulingState extends SchedulingState { jobs: StoredJob[] }

export function publicJob(job: StoredJob): Job {
  const { webhookPending, ...rest } = structuredClone(job);
  if (webhookPending?.length) rest.webhookBursts = webhookPending.map(({ id, at, dueAt, count }) => ({ id, at, dueAt, count }));
  return rest;
}

function keyDigest(body: Buffer, path: string): string | undefined {
  let payload: unknown;
  try { payload = JSON.parse(body.toString("utf8")); } catch { return undefined; }
  const value = webhookKeyValue(payload, path);
  // Containers are not stable keys. Null, false, zero and empty text are real keys.
  if (value !== null && typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Mutates only a cloned job, before the atomic acceptance write. */
export function combineWebhook(job: StoredJob, body: Buffer, now: number, delivery?: WebhookDelivery): void {
  const schedule = job.config.schedule;
  if (schedule.kind !== "webhook" || !schedule.coalescing) throw new HostCommandError("Combining is not configured.");
  if (body.length > MAX_PENDING_WEBHOOK_BODY) throw new HostCommandError("Combined webhook bodies must be at most 64 KiB.");
  const coalescing = schedule.coalescing;
  const facts = delivery ? { id: delivery.id, timestamp: delivery.timestamp, ...(delivery.format ? { format: delivery.format } : {}), ...(delivery.event ? { event: delivery.event } : {}) } : undefined;
  const digest = keyDigest(body, coalescing.keyPath);
  const pending = job.webhookPending ??= [];
  // Due windows are immutable even when a previous run or a full queue delays dispatch.
  const window = digest && pending.find((entry) => entry.keyDigest === digest && entry.coalescing.keyPath === coalescing.keyPath && entry.coalescing.waitSeconds === coalescing.waitSeconds && Date.parse(entry.dueAt) > now);
  if (window) {
    if (window.count >= MAX_BURST_DELIVERIES) throw new HostCommandError("This webhook window has reached its delivery limit.");
    window.body = body.toString("base64"); window.delivery = facts; window.count++;
  } else {
    if (pending.length >= MAX_PENDING_WEBHOOKS) throw new HostCommandError("This webhook already has 16 waiting runs. Try again later.");
    pending.push({ id: randomUUID(), at: new Date(now).toISOString(), dueAt: new Date(now + (digest ? coalescing.waitSeconds * 1000 : 0)).toISOString(), count: 1, body: body.toString("base64"), ...(facts ? { delivery: facts } : {}), keyDigest: digest, coalescing: { ...coalescing } });
  }
}

export function decodePendingWebhooks(input: unknown): PendingWebhook[] {
  if (!Array.isArray(input) || input.length > MAX_PENDING_WEBHOOKS) throw new HostCommandError("Invalid persisted webhook windows.");
  const ids = new Set<string>();
  return input.map((entry) => {
    const v = object(entry, ["id", "at", "dueAt", "count", "body", "delivery", "keyDigest", "coalescing"]);
    const id = text(v.id, "Webhook window ID", 36);
    const at = timestamp(v.at), dueAt = timestamp(v.dueAt);
    const coalescing = decodeWebhookCoalescing(v.coalescing);
    if (!coalescing || !/^[a-f0-9-]{36}$/u.test(id) || ids.has(id) || !Number.isInteger(v.count) || (v.count as number) < 1 || (v.count as number) > MAX_BURST_DELIVERIES) throw new HostCommandError("Invalid persisted webhook window.");
    ids.add(id);
    if (typeof v.body !== "string" || v.body.length > Math.ceil(MAX_PENDING_WEBHOOK_BODY / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(v.body) || Buffer.from(v.body, "base64").length > MAX_PENDING_WEBHOOK_BODY) throw new HostCommandError("Invalid persisted webhook body.");
    let delivery: PendingWebhook["delivery"];
    if (v.delivery !== undefined) {
      const d = object(v.delivery, ["id", "timestamp", "format", "event"]);
      if (typeof d.id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(d.id) || !Number.isInteger(d.timestamp) || !/^\d{13}$/u.test(String(d.timestamp)) || (d.format !== undefined && !WEBHOOK_FORMATS.includes(d.format as WebhookFormat)) || (d.event !== undefined && (typeof d.event !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/u.test(d.event)))) throw new HostCommandError("Invalid persisted webhook delivery.");
      delivery = { id: d.id, timestamp: d.timestamp as number, ...(d.format ? { format: d.format as WebhookFormat } : {}), ...(d.event ? { event: d.event as string } : {}) };
    }
    const digest = v.keyDigest;
    if (digest !== undefined && (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest))) throw new HostCommandError("Invalid persisted webhook key.");
    if (Date.parse(dueAt) - Date.parse(at) !== (digest ? coalescing.waitSeconds * 1000 : 0) || (!digest && v.count !== 1) || keyDigest(Buffer.from(v.body, "base64"), coalescing.keyPath) !== digest) throw new HostCommandError("Inconsistent persisted webhook window.");
    return { id, at, dueAt, count: v.count as number, body: v.body, ...(delivery ? { delivery } : {}), keyDigest: digest as string | undefined, coalescing };
  });
}
