import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ACCESS_CLOSE_REASON,
  PAIRING_LINK_LIFETIMES_MS,
  type UiClientDevice,
  type UiOwnerConnection,
  type UiPairedClient,
  type UiPairingLink,
} from "../shared/connections.js";
import { describeUserAgent, deviceLabel, displayAddress } from "./client-device.js";
import type { HostTokenFile } from "./host-token.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";

/** Who a hello authenticated as. Only the owner manages access. */
export type HostCredential = { kind: "owner" } | { kind: "client"; clientId: string };

/** What a transport knows about the peer behind a connection. */
export interface AccessPeer {
  address?: string;
  userAgent?: string;
  profile?: string;
  /** The window process beside a renderer, or a probe: served, closed on rotation, never listed. */
  auxiliary?: boolean;
}

interface StoredClient {
  id: string;
  label: string;
  /** SHA-256 of the token's secret part, hex. The token itself is never written. */
  secretHash: string;
  pairedAt: string;
  device: UiClientDevice;
  pairedFrom?: string;
  lastSeenAt?: string;
  lastAddress?: string;
}

interface PendingLink {
  id: string;
  label?: string;
  codeHash: string;
  createdAt: number;
  expiresAt: number;
}

interface LiveConnection {
  id: string;
  credential: HostCredential;
  peer: AccessPeer;
  since: number;
  close(reason: string): void;
}

export interface HostAccessOptions {
  tokenFile: HostTokenFile;
  /** `<userData>/paired-clients.json`, 0o600. */
  storePath: string;
  now?(): number;
  logger?: PersistedJsonLogger;
}

const STORE_VERSION = 1;
const CLIENT_TOKEN_PREFIX = "tauc";
const DEFAULT_LINK_LIFETIME_MS = PAIRING_LINK_LIFETIMES_MS[0];
const MAX_LINK_LIFETIME_MS = PAIRING_LINK_LIFETIMES_MS[PAIRING_LINK_LIFETIMES_MS.length - 1];
/** Unused links are cheap but not free; nobody needs more at once. */
const MAX_PENDING_LINKS = 20;
const MAX_LABEL = 60;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function cleanLabel(value: string | undefined): string | undefined {
  // Control characters out: a label ends up in a log line and a list row.
  const label = value?.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_LABEL);
  return label || undefined;
}

/** `tauc.<id>.<secret>`: the id finds the record, the secret proves the holder. */
function parseClientToken(token: string): { id: string; secret: string } | undefined {
  const [prefix, id, secret, ...rest] = token.split(".");
  if (prefix !== CLIENT_TOKEN_PREFIX || rest.length > 0 || !id || !secret) return undefined;
  return /^[0-9a-f]{24}$/u.test(id) ? { id, secret } : undefined;
}

/**
 * Who may connect to a listening host, beyond the owner: clients that paired
 * with a single-use link and hold a token of their own. The host token stays
 * with the owner; revoking a client or rotating the host token closes the
 * connections it opened at once (ADR 0023).
 */
export class HostAccess {
  private readonly clients = new Map<string, StoredClient>();
  private readonly links = new Map<string, PendingLink>();
  private readonly live = new Map<string, LiveConnection>();
  private readonly now: () => number;

  private constructor(private readonly options: HostAccessOptions) {
    this.now = options.now ?? Date.now;
  }

  static async open(options: HostAccessOptions): Promise<HostAccess> {
    const access = new HostAccess(options);
    const stored = await readPersistedJson(options.storePath, {
      expectedVersion: STORE_VERSION,
      decode: decodeClients,
      ...(options.logger ? { logger: options.logger } : {}),
    });
    for (const client of stored?.data ?? []) access.clients.set(client.id, client);
    return access;
  }

  get tokenPath(): string {
    return this.options.tokenFile.path;
  }

  /** The credential a hello's token stands for, or undefined for a refusal. */
  authenticate(token: string | undefined): HostCredential | undefined {
    if (typeof token !== "string" || token.length === 0) return undefined;
    const parsed = parseClientToken(token);
    if (parsed) {
      const client = this.clients.get(parsed.id);
      return client && sameHash(client.secretHash, sha256(parsed.secret)) ? { kind: "client", clientId: client.id } : undefined;
    }
    return this.options.tokenFile.matches(token) ? { kind: "owner" } : undefined;
  }

  /** Records an authenticated connection; `close` ends it when its access goes. Answers its id. */
  attach(credential: HostCredential, peer: AccessPeer, close: (reason: string) => void): string {
    const id = randomBytes(8).toString("hex");
    this.live.set(id, { id, credential, peer, since: this.now(), close });
    if (credential.kind === "client") this.seen(credential.clientId, peer.address, true);
    return id;
  }

  /** A request on a client's connection: it was active just now. */
  touch(connectionId: string): void {
    const connection = this.live.get(connectionId);
    if (connection?.credential.kind === "client") this.seen(connection.credential.clientId, connection.peer.address, false);
  }

  detach(connectionId: string): void {
    const connection = this.live.get(connectionId);
    if (!connection) return;
    this.live.delete(connectionId);
    if (connection.credential.kind === "client") this.seen(connection.credential.clientId, connection.peer.address, true);
  }

  /** A new single-use link. The code is answered once and only its hash is kept. */
  createLink(input: { label?: string; lifetimeMs?: number } = {}): { link: UiPairingLink; code: string } {
    this.pruneLinks();
    if (this.links.size >= MAX_PENDING_LINKS) {
      throw new Error(`There are already ${MAX_PENDING_LINKS} unused pairing links; revoke one or let it expire.`);
    }
    const lifetime = Math.min(Math.max(input.lifetimeMs ?? DEFAULT_LINK_LIFETIME_MS, 60_000), MAX_LINK_LIFETIME_MS);
    const code = randomBytes(24).toString("base64url");
    const createdAt = this.now();
    const label = cleanLabel(input.label);
    const link: PendingLink = {
      id: randomBytes(6).toString("hex"),
      ...(label ? { label } : {}),
      codeHash: sha256(code),
      createdAt,
      expiresAt: createdAt + lifetime,
    };
    this.links.set(link.codeHash, link);
    return { link: linkInfo(link), code };
  }

  revokeLink(id: string): boolean {
    for (const [hash, link] of this.links) {
      if (link.id !== id) continue;
      this.links.delete(hash);
      return true;
    }
    return false;
  }

  /**
   * Trades a pairing code for a client token of its own. The link is spent by
   * the attempt, whatever its outcome; an expired, spent or invented code gets
   * the same answer.
   */
  async redeem(code: string, peer: AccessPeer): Promise<string | undefined> {
    if (typeof code !== "string" || code.length === 0 || code.length > 256) return undefined;
    const hash = sha256(code);
    const link = this.links.get(hash);
    if (!link) return undefined;
    this.links.delete(hash);
    if (link.expiresAt <= this.now()) return undefined;

    const id = randomBytes(12).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const device = describeUserAgent(peer.userAgent);
    const address = displayAddress(peer.address);
    const client: StoredClient = {
      id,
      label: link.label ?? deviceLabel(device),
      secretHash: sha256(secret),
      pairedAt: new Date(this.now()).toISOString(),
      device,
      ...(address ? { pairedFrom: address, lastAddress: address } : {}),
    };
    this.clients.set(id, client);
    // Written before the token leaves: a token the host would forget on restart is worth nothing.
    try {
      await this.save();
    } catch (error) {
      this.clients.delete(id);
      throw error;
    }
    return `${CLIENT_TOKEN_PREFIX}.${id}.${secret}`;
  }

  /** Forgets a client and closes every connection it has open. */
  async revokeClient(id: string): Promise<boolean> {
    if (!this.clients.delete(id)) return false;
    for (const connection of [...this.live.values()]) {
      if (connection.credential.kind !== "client" || connection.credential.clientId !== id) continue;
      this.live.delete(connection.id);
      connection.close(ACCESS_CLOSE_REASON.revoked);
    }
    await this.save();
    return true;
  }

  /**
   * A new host token. Every connection that said hello with the old one is
   * closed, except `keep` — the owner who asked, who is answered the new
   * token. Paired clients keep theirs.
   */
  rotateHostToken(keep?: string): string {
    const token = this.options.tokenFile.rotate();
    for (const connection of [...this.live.values()]) {
      if (connection.credential.kind !== "owner" || connection.id === keep) continue;
      this.live.delete(connection.id);
      connection.close(ACCESS_CLOSE_REASON.rotated);
    }
    return token;
  }

  credentialOf(connectionId: string | undefined): HostCredential | undefined {
    return connectionId ? this.live.get(connectionId)?.credential : undefined;
  }

  overview(current?: string): { links: UiPairingLink[]; clients: UiPairedClient[]; owners: UiOwnerConnection[] } {
    this.pruneLinks();
    const currentCredential = this.credentialOf(current);
    const counts = new Map<string, number>();
    const owners: UiOwnerConnection[] = [];
    for (const connection of this.live.values()) {
      if (connection.credential.kind === "client") {
        counts.set(connection.credential.clientId, (counts.get(connection.credential.clientId) ?? 0) + 1);
        continue;
      }
      if (connection.peer.auxiliary) continue;
      const address = displayAddress(connection.peer.address);
      owners.push({
        id: connection.id,
        device: describeUserAgent(connection.peer.userAgent),
        since: new Date(connection.since).toISOString(),
        current: connection.id === current,
        ...(connection.peer.profile ? { profile: connection.peer.profile } : {}),
        ...(address ? { address } : {}),
      });
    }
    const clients = [...this.clients.values()].map((client): UiPairedClient => ({
      id: client.id,
      label: client.label,
      device: client.device,
      pairedAt: client.pairedAt,
      connections: counts.get(client.id) ?? 0,
      current: currentCredential?.kind === "client" && currentCredential.clientId === client.id,
      ...(client.lastSeenAt ? { lastSeenAt: client.lastSeenAt } : {}),
      ...(client.lastAddress ? { lastAddress: client.lastAddress } : {}),
    }));
    clients.sort((a, b) => Number(b.current) - Number(a.current)
      || Number(b.connections > 0) - Number(a.connections > 0)
      || b.pairedAt.localeCompare(a.pairedAt));
    owners.sort((a, b) => Number(b.current) - Number(a.current) || a.since.localeCompare(b.since));
    const links = [...this.links.values()].sort((a, b) => b.createdAt - a.createdAt).map(linkInfo);
    return { links, clients, owners };
  }

  /** Writes what changed since the last write, such as when clients were last seen. */
  flush(): Promise<void> {
    return this.save();
  }

  private seen(clientId: string, address: string | undefined, persist: boolean): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.lastSeenAt = new Date(this.now()).toISOString();
    const shown = displayAddress(address);
    if (shown) client.lastAddress = shown;
    // Requests only move the clock in memory; a hello and a goodbye write it down.
    if (persist) void this.save().catch(() => undefined);
  }

  private pruneLinks(): void {
    const now = this.now();
    for (const [hash, link] of this.links) if (link.expiresAt <= now) this.links.delete(hash);
  }

  private save(): Promise<void> {
    return writePersistedJson(this.options.storePath, STORE_VERSION, { clients: [...this.clients.values()] },
      this.options.logger ? { logger: this.options.logger } : {});
  }
}

function linkInfo(link: PendingLink): UiPairingLink {
  return {
    id: link.id,
    ...(link.label ? { label: link.label } : {}),
    createdAt: new Date(link.createdAt).toISOString(),
    expiresAt: new Date(link.expiresAt).toISOString(),
  };
}

function decodeClients(value: unknown): StoredClient[] | undefined {
  const list = (value as { clients?: unknown } | undefined)?.clients;
  if (!Array.isArray(list)) return undefined;
  const clients: StoredClient[] = [];
  for (const entry of list as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object") continue;
    const { id, label, secretHash, pairedAt } = entry;
    if (typeof id !== "string" || !/^[0-9a-f]{24}$/u.test(id)) continue;
    if (typeof secretHash !== "string" || !/^[0-9a-f]{64}$/u.test(secretHash)) continue;
    const device = entry.device as UiClientDevice | undefined;
    clients.push({
      id,
      secretHash,
      label: cleanLabel(typeof label === "string" ? label : undefined) ?? "Paired client",
      pairedAt: typeof pairedAt === "string" ? pairedAt : new Date(0).toISOString(),
      device: device && typeof device === "object" && typeof device.kind === "string" ? device : { kind: "unknown" },
      ...(typeof entry.pairedFrom === "string" ? { pairedFrom: entry.pairedFrom } : {}),
      ...(typeof entry.lastSeenAt === "string" ? { lastSeenAt: entry.lastSeenAt } : {}),
      ...(typeof entry.lastAddress === "string" ? { lastAddress: entry.lastAddress } : {}),
    });
  }
  return clients;
}
