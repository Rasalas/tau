import { sealPush, type RelaySend } from "./relay.js";
import type { PushRelayRegistration } from "./protocol.js";
import { join } from "node:path";
import { HostCommandError, readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "tau/host-extension";
import type { ApnsEnvironment, ApnsRequest, SendOutcome } from "./apns.js";

export interface ActivityRegistration {
  device: string;
  hostId: string;
  threadId: string;
  token?: string;
  relay?: PushRelayRegistration;
  topic: string;
  expiresAt: number;
}
export interface ActivityUpdate { version: 1; hostId: string; threadId: string; title: string; state: "running" | "completed" | "needs-input"; updatedAt: number; expiresAt: number }

export function readActivityRegistration(input: unknown, device: string, now: number): ActivityRegistration {
  const value = input as Partial<ActivityRegistration> | null;
  if (!value || typeof value.hostId !== "string" || !/^[\w.:-]{1,200}$/u.test(value.hostId)
      || typeof value.threadId !== "string" || !/^[\w.:-]{1,200}$/u.test(value.threadId)
      || typeof value.topic !== "string" || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(value.topic)) throw new HostCommandError("An activity needs a host, thread, APNs activity token and app topic.");
  const relay = value.relay;
  if (relay && (typeof relay.handle !== "string" || !/^[A-Za-z0-9_-]{40,6000}$/u.test(relay.handle) || typeof relay.keyId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/u.test(relay.keyId) || typeof relay.key !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(relay.key) || Buffer.from(relay.key, "base64url").length !== 32)) throw new HostCommandError("The activity relay registration does not read.");
  if (!relay && (typeof value.token !== "string" || !/^[0-9a-f]{32,200}$/iu.test(value.token))) throw new HostCommandError("A direct activity needs its APNs update token.");
  return { device, hostId: value.hostId, threadId: value.threadId, ...(relay ? { relay: { handle: relay.handle, keyId: relay.keyId, key: relay.key } } : { token: value.token }), topic: value.topic, expiresAt: now + 8 * 60 * 60_000 };
}

export function activityRequest(registration: ActivityRegistration, update: ActivityUpdate): ApnsRequest {
  const ended = update.state === "completed";
  return {
    token: registration.token ?? "", topic: `${registration.topic}.push-type.liveactivity`, pushType: "liveactivity",
    expiration: Math.floor(update.expiresAt / 1000),
    payload: { aps: { timestamp: Math.floor(update.updatedAt / 1000), event: ended ? "end" : "update",
      "content-state": { title: update.title.slice(0, 100), state: update.state, expiresAt: update.expiresAt },
      "stale-date": Math.floor(update.expiresAt / 1000), ...(ended ? { "dismissal-date": Math.floor(update.expiresAt / 1000) } : {}) } },
  };
}

/** Activity tokens are scoped to a paired device and a thread. Stale registrations never send. */
export class ActivityTokens {
  private registrations: ActivityRegistration[] = [];
  private writes = Promise.resolve();
  private constructor(private readonly path: string, private readonly logger: PersistedJsonLogger) {}
  static async open(dir: string, logger: PersistedJsonLogger): Promise<ActivityTokens> {
    const store = new ActivityTokens(join(dir, "activities.json"), logger);
    const saved = await readPersistedJson(store.path, { expectedVersion: 1, logger, decode: (value: unknown) => {
      const rows = (value as { registrations?: unknown } | null)?.registrations;
      if (!Array.isArray(rows)) return undefined;
      return rows.flatMap((row) => {
        try { const registration = row as ActivityRegistration; const checked = readActivityRegistration(row, registration.device, 0); return typeof registration.device === "string" && Number.isFinite(registration.expiresAt) ? [{ ...checked, expiresAt: registration.expiresAt }] : []; } catch { return []; }
      });
    } });
    store.registrations = saved?.data ?? [];
    return store;
  }
  async register(registration: ActivityRegistration): Promise<void> {
    this.registrations = [...this.registrations.filter((row) => row.device !== registration.device || row.threadId !== registration.threadId), registration].slice(-500);
    await this.save();
  }
  async retain(devices: ReadonlySet<string>, now: number): Promise<void> {
    const next = this.registrations.filter((row) => devices.has(row.device) && row.expiresAt > now);
    if (next.length !== this.registrations.length) { this.registrations = next; await this.save(); }
  }
  async update(threadId: string, state: ActivityUpdate["state"], title: string, now: number, devices: ReadonlySet<string>, environment: (device: string) => ApnsEnvironment | undefined, send: (request: ApnsRequest, environment: ApnsEnvironment) => Promise<SendOutcome>, relaySend?: (request: RelaySend) => Promise<SendOutcome>): Promise<void> {
    await this.retain(devices, now);
    const rows = this.registrations.filter((row) => row.threadId === threadId);
    const gone = new Set<string>();
    await Promise.all(rows.map(async (row) => {
      const at = now; const expiresAt = state === "running" ? row.expiresAt : at + 15 * 60_000;
      const update: ActivityUpdate = { version: 1, hostId: row.hostId, threadId, title: title.slice(0, 100), state, updatedAt: at, expiresAt };
      let outcome: SendOutcome;
      if (row.relay && relaySend) {
        outcome = await relaySend({ handle: row.relay.handle, payload: sealPush(row.relay, update), activity: { event: state === "completed" ? "end" : "update", timestamp: Math.floor(at / 1000), expiresAt: Math.floor(expiresAt / 1000) } });
      } else if (!row.relay) {
        const request = activityRequest(row, update);
        const selected = environment(row.device);
        outcome = await send(request, selected ?? "production");
        if (!selected && !outcome.ok && outcome.reason === "BadDeviceToken") outcome = await send(request, "sandbox");
      } else { outcome = { ok: false, gone: false, status: 0, reason: "Activity relay is unavailable." }; }
      if (state === "completed" || (!outcome.ok && outcome.gone)) gone.add(row.relay?.handle ?? row.token ?? "");
    }));
    if (gone.size) { this.registrations = this.registrations.filter((row) => !gone.has(row.relay?.handle ?? row.token ?? "")); await this.save(); }
  }
  private save(): Promise<void> {
    const rows = [...this.registrations];
    this.writes = this.writes.catch(() => undefined).then(() => writePersistedJson(this.path, 1, { registrations: rows }, { logger: this.logger }));
    return this.writes;
  }
}
