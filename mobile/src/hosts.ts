import type { DeviceAccess, PairingEndpoint } from "../../src/shared/connections";
import { refreshEndpoints, sameEndpoints } from "../../src/shared/environments";
import type { HostIdentity } from "../../src/shared/host-transport";
import type { SocketCandidate } from "./endpoints";

/** The Keychain on iOS, the Keystore-backed store on Android. */
export interface SecureStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** A host this phone paired with. Its token is kept apart, under `token:<id>`. */
export interface SavedHost {
  /** The host's own id (`<userData>/host-id`), the same in a pairing link and a Bonjour record. */
  id: string;
  name: string;
  /** SHA-256 of its network listeners' public key; pinned on every TLS address a CA does not vouch for. */
  publicKey?: string;
  /** SHA-256 of one certificate: the pin of a host paired before key pins, until its next hello. */
  fingerprint?: string;
  endpoints: PairingEndpoint[];
  access: DeviceAccess;
  addedAt: string;
  lastUsedAt?: string;
  /** The address the last connection won with, for the list. */
  lastEndpoint?: PairingEndpoint;
}

const HOSTS_KEY = "hosts.v1";
const tokenKey = (id: string) => `token.v1:${id}`;

function isSavedHost(value: unknown): value is SavedHost {
  if (!value || typeof value !== "object") return false;
  const host = value as Partial<SavedHost>;
  return typeof host.id === "string" && typeof host.name === "string" && Array.isArray(host.endpoints);
}

/**
 * The hosts this phone knows and the token for each, all in the secure store:
 * none of it is a secret but the tokens, and one store keeps a reinstall from
 * leaving a list without its tokens behind.
 */
export class HostBook {
  /** Every change reads the list and writes it back; one at a time, or two would lose one. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: SecureStore) {}

  private serial<T>(change: () => Promise<T>): Promise<T> {
    const next = this.queue.then(change, change);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<SavedHost[]> {
    const text = await this.store.get(HOSTS_KEY);
    if (!text) return [];
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.filter(isSavedHost) : [];
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<SavedHost | undefined> {
    return (await this.list()).find((host) => host.id === id);
  }

  async token(id: string): Promise<string | undefined> {
    return this.store.get(tokenKey(id));
  }

  /** Adds a host or replaces the one with its id, with the token pairing just gave. */
  save(host: SavedHost, token: string): Promise<void> {
    return this.serial(async () => {
      await this.store.set(tokenKey(host.id), token);
      const others = (await this.list()).filter((entry) => entry.id !== host.id);
      await this.write([...others, host]);
    });
  }

  /** Merges what a later look at the host learned (a new address, the one that answered). */
  update(id: string, change: Partial<Omit<SavedHost, "id">>): Promise<void> {
    return this.serial(async () => {
      const hosts = await this.list();
      const index = hosts.findIndex((host) => host.id === id);
      if (index < 0) return;
      hosts[index] = { ...hosts[index]!, ...change };
      await this.write(hosts);
    });
  }

  /** Forgets the host and its token; the host itself keeps the device until its owner revokes it. */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      await this.store.remove(tokenKey(id));
      await this.write((await this.list()).filter((host) => host.id !== id));
    });
  }

  /** The token no longer works (revoked, expired): keep the host, drop the token. */
  async forgetToken(id: string): Promise<void> {
    await this.store.remove(tokenKey(id));
  }

  private async write(hosts: SavedHost[]): Promise<void> {
    await this.store.set(HOSTS_KEY, JSON.stringify(hosts));
  }
}

/** Most recently used first, then by name. */
export function sortHosts(hosts: readonly SavedHost[]): SavedHost[] {
  return [...hosts].sort((a, b) => (b.lastUsedAt ?? b.addedAt).localeCompare(a.lastUsedAt ?? a.addedAt) || a.name.localeCompare(b.name));
}

/** What a connection's winning address and handshake were. */
export interface WonAddress {
  candidate: SocketCandidate;
  seen: { fingerprint?: string; publicKey?: string };
}

/**
 * After a hello: a host still pinned by certificate moves to its key, when
 * that pin just held; a CA letting the socket in proves nothing about the
 * host's own key. Undefined when nothing changes.
 */
export function migratedPin(host: SavedHost, won: WonAddress): Pick<SavedHost, "publicKey" | "fingerprint"> | undefined {
  if (host.publicKey || !host.fingerprint || won.candidate.trust !== "pin" || !won.candidate.fingerprint) return undefined;
  if (won.seen.fingerprint !== won.candidate.fingerprint || !won.seen.publicKey) return undefined;
  return { publicKey: won.seen.publicKey, fingerprint: undefined };
}

/**
 * The addresses to keep after a hello named the host's current ones
 * (`host.endpoints`, with the CA flag): those first, then the saved ones the
 * window keeps too (names, Tailscale, the one this connection won with).
 * Undefined when nothing changes, or when the hello names another host.
 */
export function helloEndpoints(host: SavedHost, identity: HostIdentity | undefined, wonUrl: string | undefined, same: (endpointUrl: string, socketUrl: string) => boolean): PairingEndpoint[] | undefined {
  if (!identity || identity.id !== host.id || !identity.endpoints?.length) return undefined;
  const keep = wonUrl ? host.endpoints.find((endpoint) => same(endpoint.url, wonUrl))?.url : undefined;
  const endpoints = refreshEndpoints(host.endpoints, identity.endpoints, keep);
  return sameEndpoints(endpoints, host.endpoints) ? undefined : endpoints;
}

/** A host id for a link from a host that names none: stable per certificate, else per first address. */
export function fallbackHostId(fingerprint: string | undefined, endpoints: readonly PairingEndpoint[]): string {
  const basis = fingerprint?.replace(/:/gu, "").slice(0, 16) ?? endpoints[0]?.url ?? "host";
  return `unnamed-${basis.replace(/[^A-Za-z0-9]+/gu, "-").toLowerCase()}`;
}
