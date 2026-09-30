import { join } from "node:path";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "tau/host-extension";
import type { ApnsCredentials, ApnsEnvironment } from "./apns.js";
import type { PushPlatform, PushRelayRegistration } from "./protocol.js";

const VERSION = 1;

export interface StoredKeys {
  apns?: ApnsCredentials & { savedAt: string };
  /** The service account file's text as the user gave it, and what Settings shows of it. */
  fcm?: { serviceAccount: string; projectId: string; clientEmail: string; savedAt: string };
}

export interface StoredDevice {
  /** The paired device's id; one registration per device. */
  id: string;
  platform: PushPlatform;
  token: string;
  host: string;
  topic?: string;
  /** The relay's handle and the phone's key for what a push says. */
  relay?: PushRelayRegistration;
  registeredAt: string;
  /** The APNs environment that took this token, once one did. */
  environment?: ApnsEnvironment;
  lastPush?: { at: string; ok: boolean; detail?: string };
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function decodeKeys(value: unknown): StoredKeys | undefined {
  if (!isObject(value)) return undefined;
  const keys: StoredKeys = {};
  const apns = value.apns;
  if (isObject(apns) && typeof apns.keyId === "string" && typeof apns.teamId === "string" && typeof apns.key === "string") {
    keys.apns = { keyId: apns.keyId, teamId: apns.teamId, key: apns.key, savedAt: String(apns.savedAt ?? "") };
  }
  const fcm = value.fcm;
  if (isObject(fcm) && typeof fcm.serviceAccount === "string" && typeof fcm.projectId === "string" && typeof fcm.clientEmail === "string") {
    keys.fcm = { serviceAccount: fcm.serviceAccount, projectId: fcm.projectId, clientEmail: fcm.clientEmail, savedAt: String(fcm.savedAt ?? "") };
  }
  return keys;
}

const isRelay = (value: unknown): value is PushRelayRegistration => isObject(value)
  && typeof value.handle === "string" && typeof value.keyId === "string" && typeof value.key === "string";

function decodeDevices(value: unknown): StoredDevice[] | undefined {
  const list = isObject(value) ? value.devices : undefined;
  if (!Array.isArray(list)) return undefined;
  return list.filter((entry): entry is StoredDevice => isObject(entry)
    && typeof entry.id === "string" && (entry.platform === "ios" || entry.platform === "android")
    && typeof entry.token === "string" && typeof entry.host === "string" && typeof entry.registeredAt === "string")
    .map(({ relay, ...device }) => (isRelay(relay) ? { ...device, relay } : device));
}

/**
 * The user's keys and the devices that asked for pushes, each in a file of the
 * kit's own folder that only this user may read (0600). Not encrypted: the host
 * runs without a window, often as a service, where no keychain is at hand.
 */
export class PushStore {
  private constructor(
    readonly keysPath: string,
    private readonly devicesPath: string,
    private keys: StoredKeys,
    private list: StoredDevice[],
    private readonly logger: PersistedJsonLogger,
  ) {}

  static async open(dir: string, logger: PersistedJsonLogger): Promise<PushStore> {
    const keysPath = join(dir, "keys.json");
    const devicesPath = join(dir, "devices.json");
    const [keys, devices] = await Promise.all([
      readPersistedJson(keysPath, { expectedVersion: VERSION, decode: decodeKeys, logger }),
      readPersistedJson(devicesPath, { expectedVersion: VERSION, decode: decodeDevices, logger }),
    ]);
    return new PushStore(keysPath, devicesPath, keys?.data ?? {}, devices?.data ?? [], logger);
  }

  get stored(): StoredKeys {
    return this.keys;
  }

  devices(): readonly StoredDevice[] {
    return this.list;
  }

  async setKeys(next: StoredKeys): Promise<void> {
    this.keys = next;
    await writePersistedJson(this.keysPath, VERSION, { ...next }, { logger: this.logger });
  }

  async upsert(device: StoredDevice): Promise<void> {
    const prior = this.list.find((entry) => entry.id === device.id);
    // The same token keeps what was learned about it, and its handle when the relay was out of reach this time.
    const same = prior && prior.token === device.token ? prior : undefined;
    const kept = same ? { ...(same.environment ? { environment: same.environment } : {}), ...(same.lastPush ? { lastPush: same.lastPush } : {}), ...(same.relay && !device.relay ? { relay: same.relay } : {}) } : {};
    this.list = [...this.list.filter((entry) => entry.id !== device.id), { ...device, ...kept }];
    await this.saveDevices();
  }

  async update(id: string, change: Partial<Pick<StoredDevice, "environment" | "lastPush">>): Promise<void> {
    if (!this.list.some((entry) => entry.id === id)) return;
    this.list = this.list.map((entry) => entry.id === id ? { ...entry, ...change } : entry);
    await this.saveDevices();
  }

  /** Forgets every device `keep` rejects; answers whether any went. */
  async retain(keep: (device: StoredDevice) => boolean): Promise<boolean> {
    const next = this.list.filter(keep);
    if (next.length === this.list.length) return false;
    this.list = next;
    await this.saveDevices();
    return true;
  }

  private saveDevices(): Promise<void> {
    return writePersistedJson(this.devicesPath, VERSION, { devices: this.list }, { logger: this.logger });
  }
}
