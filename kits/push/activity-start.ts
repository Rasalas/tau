import { createCipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { HostCommandError, readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "tau/host-extension";
import { readActivityRegistration, type ActivityRegistration, type ActivityRow, type ActivityUpdate } from "./mobile-activity.js";
import type { SendOutcome } from "./apns.js";
import type { RelaySend } from "./relay.js";
import type { PushRelayRegistration } from "./protocol.js";

const DAY = 24 * 60 * 60_000;
export interface ActivityStartRegistration extends Omit<ActivityRegistration, "threadId"> { enabled: true; inputPushToken?: boolean }
interface Started { device: string; threadId: string; activityId: string; at: number; state: ActivityUpdate["state"] }

/** Version 2 activity ciphertext has separate start/update purposes. Update AAD
 * binds the activity id and SHA-256 of its current APNs token, never alert tokens. */
export function sealActivity(key: Pick<PushRelayRegistration, "keyId" | "key">, content: ActivityUpdate, purpose: "start" | "update", activityId: string, tokenHash = ""): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key.key, "base64url"), nonce);
  cipher.setAAD(Buffer.from(`tau-activity:2:${key.keyId}:${purpose}:${activityId}:${tokenHash}`));
  const bytes = Buffer.concat([nonce, cipher.update(JSON.stringify(content)), cipher.final(), cipher.getAuthTag()]);
  return `2.${key.keyId}.${bytes.toString("base64url")}`;
}
export function readActivityStart(input: unknown, device: string, now: number): ActivityStartRegistration {
  const value = input as Partial<ActivityStartRegistration> | undefined;
  if (value?.enabled !== true || !value.relay) throw new HostCommandError("Remote Live Activities require phone opt-in and an encrypted activity key.");
  if (value.inputPushToken !== undefined && typeof value.inputPushToken !== "boolean") throw new HostCommandError("The activity OS capability does not read.");
  const checked = readActivityRegistration({ ...value, threadId: "start" }, device, now);
  return { ...checked, ...(value.inputPushToken ? { inputPushToken: true } : {}), enabled: true, expiresAt: now + 30 * DAY };
}

/** Consent and start deduplication survive a host restart. APNs acceptance is
 * not delivery confirmation; no repeated starts while the update token is pending. */
export class ActivityStarts {
  private registrations: ActivityStartRegistration[] = [];
  private started: Started[] = [];
  private writes = Promise.resolve();
  private constructor(private readonly path: string, private readonly logger: PersistedJsonLogger) {}
  static async open(dir: string, logger: PersistedJsonLogger): Promise<ActivityStarts> {
    const store = new ActivityStarts(join(dir, "activity-starts.json"), logger);
    const saved = await readPersistedJson(store.path, { expectedVersion: 1, logger, decode: (value: unknown) => {
      const data = value as { registrations?: unknown; started?: unknown } | null;
      if (!Array.isArray(data?.registrations) || !Array.isArray(data.started)) return undefined;
      const registrations = data.registrations.flatMap((row) => { try { const registration = row as ActivityStartRegistration; const checked = readActivityStart(row, registration.device, 0); return typeof registration.device === "string" && Number.isSafeInteger(registration.expiresAt) ? [{ ...checked, expiresAt: registration.expiresAt }] : []; } catch { return []; } });
      const started = data.started.filter((row): row is Started => Boolean(row && typeof row.device === "string" && typeof row.threadId === "string" && /^[A-Za-z0-9_-]{22}$/u.test(row.activityId) && Number.isSafeInteger(row.at) && ["running", "needs-input", "completed"].includes(row.state)));
      return { registrations, started };
    } });
    if (saved) { store.registrations = saved.data.registrations; store.started = saved.data.started; }
    return store;
  }
  async register(row: ActivityStartRegistration): Promise<void> {
    this.registrations = [...this.registrations.filter((prior) => prior.device !== row.device), row].slice(-500);
    await this.save();
  }
  async remove(device: string): Promise<void> {
    this.registrations = this.registrations.filter((row) => row.device !== device);
    this.started = this.started.filter((row) => row.device !== device);
    await this.save();
  }
  async retain(devices: ReadonlySet<string>, now: number): Promise<void> {
    this.registrations = this.registrations.filter((row) => devices.has(row.device) && row.expiresAt > now);
    this.started = this.started.filter((row) => devices.has(row.device) && row.at > now - 8 * 60 * 60_000);
    await this.save();
  }
  state(row: ActivityRegistration): ActivityUpdate["state"] | undefined { return this.started.find((start) => start.device === row.device && start.activityId === row.activityId)?.state; }
  async note(threadId: string, state: ActivityUpdate["state"]): Promise<void> {
    const active = this.started.filter((row) => row.threadId === threadId && row.state !== "completed");
    if (active.some((row) => row.state !== state)) { for (const row of active) row.state = state; await this.save(); }
  }
  expiry(row: ActivityRegistration): number { return (this.started.find((start) => start.device === row.device && start.activityId === row.activityId)?.at ?? 0) + 8 * 60 * 60_000; }
  owns(row: ActivityRegistration, now = 0): boolean {
    const consent = this.registrations.find((prior) => prior.device === row.device);
    return Boolean(consent && consent.expiresAt > now && this.expiry(row) > now && consent.hostId === row.hostId && consent.relay?.keyId === row.relay?.keyId && consent.relay?.key === row.relay?.key
      && this.started.some((start) => start.device === row.device && start.threadId === row.threadId && start.activityId === row.activityId));
  }
  async start(threadId: string, title: string, now: number, devices: ReadonlySet<string>, active: (device: string) => boolean, relay: (request: RelaySend) => Promise<SendOutcome>, threads?: ActivityRow[]): Promise<void> {
    await this.retain(devices, now);
    for (const row of this.registrations) {
      if (active(row.device) || this.started.some((prior) => prior.device === row.device && prior.threadId === threadId && prior.state !== "completed")
          || this.started.filter((prior) => prior.device === row.device && prior.at > now - 60 * 60_000).length >= 3) continue;
      const activityId = randomBytes(16).toString("base64url");
      const content: ActivityUpdate = { version: 1, hostId: row.hostId, threadId, title: title.slice(0, 100), state: "running", updatedAt: now, expiresAt: now + 8 * 60 * 60_000, ...(threads ? { threads } : {}) };
      const sealed = sealActivity(row.relay!, content, "start", activityId);
      this.started.push({ device: row.device, threadId, activityId, at: now, state: "running" });
      await this.save();
      if (!this.registrations.includes(row)) continue;
      const outcome = await relay({ handle: row.relay!.handle, payload: sealed, activity: { event: "start", activityId, bootstrap: sealed, ...(row.inputPushToken ? { inputPushToken: true } : {}), timestamp: Math.floor(now / 1000), expiresAt: Math.floor(content.expiresAt / 1000) } });
      if (!outcome.ok && outcome.gone) await this.remove(row.device);
    }
  }
  private save(): Promise<void> {
    const data = { registrations: [...this.registrations], started: [...this.started] };
    this.writes = this.writes.catch(() => undefined).then(() => writePersistedJson(this.path, 1, data, { logger: this.logger }));
    return this.writes;
  }
}
