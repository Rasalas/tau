import type { PairingEndpoint, UiHostEndpointKind } from "../shared/connections.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";

/**
 * Encrypts what the catalog must not keep in the clear. Electron's
 * `safeStorage` in the app; a fake in tests. `available` false means nothing
 * can be saved (ADR 0025).
 */
export interface SecretBox {
  available(): boolean;
  /** Base64 of the ciphertext. */
  encrypt(text: string): string;
  decrypt(data: string): string;
}

/** A machine the user paired this window with; `token` is decrypted in memory only. */
export interface SavedEnvironment {
  id: string;
  name: string;
  endpoints: PairingEndpoint[];
  /** SHA-256 of the certificate its TLS listeners present; absent for a plaintext loopback or tunnel address. */
  fingerprint?: string;
  token: string;
  addedAt: string;
  /** The address that worked last; tried first. */
  lastUrl?: string;
  readOnly?: boolean;
}

interface StoredEnvironment extends Omit<SavedEnvironment, "token"> {
  token: string;
}

const VERSION = 1;
const KINDS = new Set<string>(["loopback", "lan", "mdns", "tailscale", "magicdns"]);

export class SecretStorageUnavailableError extends Error {
  constructor() {
    super("This machine offers Tau no encrypted storage (no keychain or secret service), so it cannot keep another machine's key.");
    this.name = "SecretStorageUnavailableError";
  }
}

/** `<userData>/environments.json`, mode 0600, one encrypted token per machine. */
export class EnvironmentCatalog {
  private entries: SavedEnvironment[] = [];

  private constructor(
    private readonly path: string,
    private readonly box: SecretBox,
    private readonly logger?: PersistedJsonLogger,
  ) {}

  static async open(path: string, box: SecretBox, logger?: PersistedJsonLogger): Promise<EnvironmentCatalog> {
    const catalog = new EnvironmentCatalog(path, box, logger);
    await catalog.load();
    return catalog;
  }

  get secure(): boolean { return this.box.available(); }

  list(): readonly SavedEnvironment[] { return this.entries; }

  get(id: string): SavedEnvironment | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  /** Adds a machine, or replaces the one with its id (paired again). */
  async save(entry: SavedEnvironment): Promise<void> {
    if (!this.box.available()) throw new SecretStorageUnavailableError();
    this.entries = [...this.entries.filter((existing) => existing.id !== entry.id), entry];
    await this.persist();
  }

  async remove(id: string): Promise<boolean> {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length === before) return false;
    await this.persist();
    return true;
  }

  async update(id: string, patch: Partial<Pick<SavedEnvironment, "name" | "lastUrl" | "readOnly">>): Promise<boolean> {
    const entry = this.get(id);
    if (!entry) return false;
    const next = { ...entry, ...patch };
    if (patch.name !== undefined) next.name = patch.name.trim().slice(0, 80) || entry.name;
    if (JSON.stringify(next) === JSON.stringify(entry)) return true;
    this.entries = this.entries.map((existing) => existing.id === id ? next : existing);
    await this.persist();
    return true;
  }

  private async load(): Promise<void> {
    const stored = await readPersistedJson(this.path, {
      expectedVersion: VERSION,
      decode: decodeStored,
      ...(this.logger ? { logger: this.logger } : {}),
    });
    const entries: SavedEnvironment[] = [];
    for (const entry of stored?.data ?? []) {
      try {
        entries.push({ ...entry, token: this.box.decrypt(entry.token) });
      } catch (error: unknown) {
        // Another user's keychain, or a copied file: the token is gone, the machine has to pair again.
        this.logger?.warn(`environments: the key for ${entry.name} could not be decrypted`, error);
      }
    }
    this.entries = entries;
  }

  private async persist(): Promise<void> {
    const environments: StoredEnvironment[] = this.entries.map((entry) => ({ ...entry, token: this.box.encrypt(entry.token) }));
    await writePersistedJson(this.path, VERSION, { environments }, this.logger ? { logger: this.logger } : {});
  }
}

function decodeStored(value: unknown): StoredEnvironment[] | undefined {
  const list = (value as { environments?: unknown } | undefined)?.environments;
  if (!Array.isArray(list)) return undefined;
  const entries: StoredEnvironment[] = [];
  for (const raw of list) {
    const item = raw as Record<string, unknown> | undefined;
    if (!item || typeof item.id !== "string" || !item.id || typeof item.token !== "string" || !item.token) continue;
    const endpoints = Array.isArray(item.endpoints)
      ? item.endpoints.flatMap((endpoint: unknown) => {
        const url = (endpoint as { url?: unknown })?.url;
        const kind = (endpoint as { kind?: unknown })?.kind;
        if (typeof url !== "string" || !/^https?:\/\//u.test(url)) return [];
        return [{ url, ...(typeof kind === "string" && KINDS.has(kind) ? { kind: kind as UiHostEndpointKind } : {}) }];
      })
      : [];
    if (endpoints.length === 0) continue;
    entries.push({
      id: item.id,
      name: typeof item.name === "string" && item.name ? item.name : item.id.slice(0, 8),
      endpoints,
      ...(typeof item.fingerprint === "string" && item.fingerprint ? { fingerprint: item.fingerprint } : {}),
      token: item.token,
      addedAt: typeof item.addedAt === "string" ? item.addedAt : "",
      ...(typeof item.lastUrl === "string" ? { lastUrl: item.lastUrl } : {}),
      ...(item.readOnly === true ? { readOnly: true } : {}),
    });
  }
  return entries;
}
