import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  ACCESS_CLOSE_REASON,
  DEFAULT_IDLE_TIMEOUT_DAYS,
  IDLE_TIMEOUT_CHOICES,
  PAIRING_LINK_LIFETIMES_MS,
  type DeviceAccess,
  type IdleTimeoutDays,
  type UiClientDevice,
  type UiClientUpdate,
  type UiOwnerConnection,
  type UiPairedClient,
  type UiPairingLink,
  type UiPairingRequest,
} from "../shared/connections.js";
import {
  PAIRING_REQUEST_LIFETIME_MS,
  pairingCommitment,
  pairingVerificationCode,
  type HostPairReply,
  type HostPairRequest,
} from "../shared/pairing.js";
import { describeUserAgent, deviceLabel, displayAddress } from "./client-device.js";
import type { HostTokenFile } from "./host-token.js";
import { createAuthRateLimiter } from "./host-rate-limit.js";
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

/** One line of the access log: a paired device changed something, or tried to. */
export interface AccessAuditEntry {
  clientId: string;
  label: string;
  action: string;
  allowed: boolean;
}

/** Where a pairing request's outcome goes: the socket that asked. False when it is gone. */
export interface PairingChannel {
  /** SHA-256 of the certificate this listener presents; absent on plaintext. The digits are bound to it. */
  fingerprint?: string;
  settle(reply: HostPairReply): boolean;
}

interface StoredClient {
  id: string;
  label: string;
  /** SHA-256 of the token's secret part, hex. The token itself is never written. */
  secretHash: string;
  pairedAt: string;
  device: UiClientDevice;
  access: DeviceAccess;
  idleTimeoutDays: IdleTimeoutDays;
  pairedFrom?: string;
  lastSeenAt?: string;
  lastAddress?: string;
  lastAction?: { action: string; at: string };
}

interface PendingLink {
  id: string;
  label?: string;
  access: DeviceAccess;
  codeHash: string;
  createdAt: number;
  expiresAt: number;
}

interface PendingRequest {
  id: string;
  name?: string;
  device: UiClientDevice;
  address?: string;
  /** Set when a pairing link brought it. */
  link?: { label?: string; access: DeviceAccess };
  /** `challenge` waits for the device's nonce and is not shown to the owner yet. */
  state: "challenge" | "waiting";
  commitment?: string;
  hostNonce?: string;
  verification?: string;
  createdAt: number;
  expiresAt: number;
  channel: PairingChannel;
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
  /** Requests, clients or links changed; the host tells its owners' windows to look again. */
  onChange?(): void;
  /** Every change a paired device made, and every one it was refused. */
  audit?(entry: AccessAuditEntry): void;
}

const STORE_VERSION = 2;
const CLIENT_TOKEN_PREFIX = "tauc";
const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_LINK_LIFETIME_MS = PAIRING_LINK_LIFETIMES_MS[0];
const MAX_LINK_LIFETIME_MS = PAIRING_LINK_LIFETIMES_MS[PAIRING_LINK_LIFETIMES_MS.length - 1];
/** Unused links are cheap but not free; nobody needs more at once. */
const MAX_PENDING_LINKS = 20;
/** Requests the owner has not answered yet. Without a link a source gets one at a time, and a few in all. */
const MAX_PENDING_REQUESTS = 5;
const MAX_UNLINKED_REQUESTS = 3;
/** After the owner said no, a request without a link from that address waits this long. */
const DENIED_COOLDOWN_MS = 10 * 60_000;
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

const isDeviceAccess = (value: unknown): value is DeviceAccess => value === "full" || value === "read-only";
const isIdleTimeout = (value: unknown): value is IdleTimeoutDays => (IDLE_TIMEOUT_CHOICES as readonly unknown[]).includes(value);

/** `tauc.<id>.<secret>`: the id finds the record, the secret proves the holder. */
function parseClientToken(token: string): { id: string; secret: string } | undefined {
  const [prefix, id, secret, ...rest] = token.split(".");
  if (prefix !== CLIENT_TOKEN_PREFIX || rest.length > 0 || !id || !secret) return undefined;
  return /^[0-9a-f]{24}$/u.test(id) ? { id, secret } : undefined;
}

/**
 * Who may connect to a listening host, beyond the owner: devices that asked
 * to pair, were allowed on the host, and hold a token of their own. A token
 * ends when it is revoked, or after the device went unused for its idle
 * timeout. Revoking a client or rotating the host token closes the
 * connections it opened at once (ADR 0023, ADR 0024).
 */
export class HostAccess {
  private readonly clients = new Map<string, StoredClient>();
  private readonly links = new Map<string, PendingLink>();
  private readonly requests = new Map<string, PendingRequest>();
  private readonly deniedSources = new Map<string, number>();
  private readonly live = new Map<string, LiveConnection>();
  private readonly now: () => number;
  private readonly admit: (source: string | undefined) => number;

  private constructor(private readonly options: HostAccessOptions) {
    this.now = options.now ?? Date.now;
    this.admit = createAuthRateLimiter(this.now);
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

  /** The credential a hello's token stands for, or undefined for a refusal. An unused token past its timeout is forgotten here. */
  authenticate(token: string | undefined): HostCredential | undefined {
    if (typeof token !== "string" || token.length === 0) return undefined;
    const parsed = parseClientToken(token);
    if (parsed) {
      const client = this.clients.get(parsed.id);
      if (!client || !sameHash(client.secretHash, sha256(parsed.secret))) return undefined;
      if (this.expired(client)) {
        this.forgetExpired(client);
        return undefined;
      }
      return { kind: "client", clientId: client.id };
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

  /** What the connection may do right now; a change of preset applies from the next call. */
  accessOf(connectionId: string): DeviceAccess {
    const credential = this.live.get(connectionId)?.credential;
    if (credential?.kind !== "client") return "full";
    return this.clients.get(credential.clientId)?.access ?? "read-only";
  }

  /** A paired device changed something, or was refused: the row shows the last change, the log every one. */
  audit(connectionId: string, action: string, allowed: boolean): void {
    const credential = this.live.get(connectionId)?.credential;
    if (credential?.kind !== "client") return;
    const client = this.clients.get(credential.clientId);
    if (!client) return;
    if (allowed) client.lastAction = { action, at: new Date(this.now()).toISOString() };
    this.options.audit?.({ clientId: client.id, label: client.label, action, allowed });
  }

  detach(connectionId: string): void {
    const connection = this.live.get(connectionId);
    if (!connection) return;
    this.live.delete(connectionId);
    if (connection.credential.kind === "client") this.seen(connection.credential.clientId, connection.peer.address, true);
  }

  /** A new single-use link. The code is answered once and only its hash is kept. */
  createLink(input: { label?: string; lifetimeMs?: number; access?: DeviceAccess } = {}): { link: UiPairingLink; code: string } {
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
      access: isDeviceAccess(input.access) ? input.access : "full",
      codeHash: sha256(code),
      createdAt,
      expiresAt: createdAt + lifetime,
    };
    this.links.set(link.codeHash, link);
    this.changed();
    return { link: linkInfo(link), code };
  }

  revokeLink(id: string): boolean {
    for (const [hash, link] of this.links) {
      if (link.id !== id) continue;
      this.links.delete(hash);
      this.changed();
      return true;
    }
    return false;
  }

  /**
   * A device asks to pair. Nobody gets a token here: the request waits for
   * the owner, who sees the same six digits as the device. A link's code is
   * spent by the attempt, whatever its outcome; an expired, spent or invented
   * code gets one answer. Without a code the owner is asked all the same,
   * within tight limits, since anyone who reaches the port may ask.
   */
  requestPairing(request: HostPairRequest, peer: AccessPeer, channel: PairingChannel): { id?: string; reply: HostPairReply } {
    this.sweep();
    const retryAfterMs = this.admit(peer.address);
    if (retryAfterMs > 0) return { reply: { state: "refused", reason: "rate-limited", retryAfterMs } };
    if (this.requests.size >= MAX_PENDING_REQUESTS) return { reply: { state: "refused", reason: "busy" } };
    const address = displayAddress(peer.address);

    let link: PendingLink | undefined;
    if (request.code !== undefined) {
      const hash = sha256(request.code);
      link = this.links.get(hash);
      if (!link) return { reply: { state: "refused", reason: "unknown-code" } };
      this.links.delete(hash);
      this.changed();
      if (link.expiresAt <= this.now()) return { reply: { state: "refused", reason: "unknown-code" } };
    } else {
      const unlinked = [...this.requests.values()].filter((entry) => !entry.link);
      const cooling = address ? (this.deniedSources.get(address) ?? 0) > this.now() : false;
      if (cooling || unlinked.length >= MAX_UNLINKED_REQUESTS || unlinked.some((entry) => entry.address === address)) {
        return { reply: { state: "refused", reason: "busy" } };
      }
    }

    const createdAt = this.now();
    const name = cleanLabel(request.name);
    const pending: PendingRequest = {
      id: randomBytes(8).toString("hex"),
      ...(name ? { name } : {}),
      device: describeUserAgent(peer.userAgent),
      ...(address ? { address } : {}),
      ...(link ? { link: { ...(link.label ? { label: link.label } : {}), access: link.access } } : {}),
      state: request.commitment ? "challenge" : "waiting",
      ...(request.commitment ? { commitment: request.commitment, hostNonce: randomBytes(32).toString("base64url") } : {}),
      // Without a commitment the host picks the digits; the device only shows them.
      ...(request.commitment ? {} : { verification: String(randomInt(0, 1_000_000)).padStart(6, "0") }),
      createdAt,
      expiresAt: createdAt + PAIRING_REQUEST_LIFETIME_MS,
      channel,
    };
    this.requests.set(pending.id, pending);
    if (pending.state === "challenge") return { id: pending.id, reply: { state: "challenge", requestId: pending.id, hostNonce: pending.hostNonce! } };
    this.changed();
    return { id: pending.id, reply: this.waitingReply(pending) };
  }

  /** The nonce a request committed to. A wrong one ends the request. */
  async revealPairing(id: string, nonce: string): Promise<HostPairReply> {
    const pending = this.requests.get(id);
    if (!pending || pending.state !== "challenge" || !pending.commitment || !pending.hostNonce) return { state: "refused", reason: "invalid" };
    if (!sameHash(pending.commitment, await pairingCommitment(nonce))) {
      this.requests.delete(id);
      return { state: "refused", reason: "invalid" };
    }
    // Another await ran; the request may have gone meanwhile.
    const verification = await pairingVerificationCode({
      ...(pending.channel.fingerprint ? { fingerprint: pending.channel.fingerprint } : {}),
      deviceNonce: nonce,
      hostNonce: pending.hostNonce,
    });
    if (this.requests.get(id) !== pending) return { state: "expired" };
    pending.state = "waiting";
    pending.verification = verification;
    this.changed();
    return this.waitingReply(pending);
  }

  /** The device went away before the owner answered. */
  withdrawPairing(id: string): void {
    if (this.requests.delete(id)) this.changed();
  }

  /**
   * Lets a waiting device in: its token is written down first, then answered
   * on its socket. A device that left meanwhile gets nothing, and neither
   * does its record survive.
   */
  async approvePairing(id: string, choice: { access?: DeviceAccess; label?: string } = {}): Promise<boolean> {
    this.sweep();
    const pending = this.requests.get(id);
    if (!pending || pending.state !== "waiting") return false;
    this.requests.delete(id);

    const clientId = randomBytes(12).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const access = isDeviceAccess(choice.access) ? choice.access : pending.link?.access ?? "full";
    const client: StoredClient = {
      id: clientId,
      label: cleanLabel(choice.label) ?? pending.link?.label ?? pending.name ?? deviceLabel(pending.device),
      secretHash: sha256(secret),
      pairedAt: new Date(this.now()).toISOString(),
      device: pending.device,
      access,
      idleTimeoutDays: DEFAULT_IDLE_TIMEOUT_DAYS,
      ...(pending.address ? { pairedFrom: pending.address, lastAddress: pending.address } : {}),
    };
    this.clients.set(clientId, client);
    // Written before the token leaves: a token the host would forget on restart is worth nothing.
    try {
      await this.save();
    } catch (error) {
      this.clients.delete(clientId);
      pending.channel.settle({ state: "denied" });
      this.changed();
      throw error;
    }
    const delivered = pending.channel.settle({ state: "approved", token: `${CLIENT_TOKEN_PREFIX}.${clientId}.${secret}`, clientId, access });
    if (!delivered) {
      this.clients.delete(clientId);
      await this.save().catch(() => undefined);
    }
    this.changed();
    return delivered;
  }

  denyPairing(id: string): boolean {
    const pending = this.requests.get(id);
    if (!pending) return false;
    this.requests.delete(id);
    if (!pending.link && pending.address) this.deniedSources.set(pending.address, this.now() + DENIED_COOLDOWN_MS);
    pending.channel.settle({ state: "denied" });
    this.changed();
    return true;
  }

  /** Forgets a client and closes every connection it has open. */
  async revokeClient(id: string): Promise<boolean> {
    const client = this.clients.get(id);
    if (!client) return false;
    this.clients.delete(id);
    this.closeClient(id, ACCESS_CLOSE_REASON.revoked);
    this.changed();
    await this.save();
    return true;
  }

  /** Signs out every paired device but `keep`; answers how many went. */
  async revokeOtherClients(keep?: string): Promise<number> {
    const others = [...this.clients.keys()].filter((id) => id !== keep);
    for (const id of others) {
      this.clients.delete(id);
      this.closeClient(id, ACCESS_CLOSE_REASON.revoked);
    }
    if (others.length > 0) {
      this.changed();
      await this.save();
    }
    return others.length;
  }

  /** Renames a device, changes its preset or its idle timeout. A preset applies from its next call. */
  async updateClient(id: string, update: UiClientUpdate): Promise<boolean> {
    const client = this.clients.get(id);
    if (!client) return false;
    const label = cleanLabel(update.label);
    if (update.label !== undefined && !label) throw new Error("A device needs a name.");
    if (update.access !== undefined && !isDeviceAccess(update.access)) throw new Error("Access is full or read-only.");
    if (update.idleTimeoutDays !== undefined && !isIdleTimeout(update.idleTimeoutDays)) throw new Error("The idle timeout is 30, 90 or 365 days, or never.");
    if (label) client.label = label;
    if (update.access !== undefined) client.access = update.access;
    if (update.idleTimeoutDays !== undefined) {
      client.idleTimeoutDays = update.idleTimeoutDays;
      // The new timeout counts from now, so shortening it never ends a token on the spot.
      client.lastSeenAt = new Date(this.now()).toISOString();
    }
    this.changed();
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

  /**
   * Ends what ran out: requests nobody answered, and tokens unused past their
   * timeout. A device that stays connected counts as in use. The host runs
   * this every minute; tests call it with their own clock.
   */
  sweep(): void {
    const now = this.now();
    for (const connection of this.live.values()) {
      if (connection.credential.kind === "client") this.seen(connection.credential.clientId, connection.peer.address, false);
    }
    for (const pending of [...this.requests.values()]) {
      if (pending.expiresAt > now) continue;
      this.requests.delete(pending.id);
      pending.channel.settle({ state: "expired" });
      this.changed();
    }
    for (const client of [...this.clients.values()]) if (this.expired(client)) this.forgetExpired(client);
    for (const [address, until] of this.deniedSources) if (until <= now) this.deniedSources.delete(address);
  }

  overview(current?: string): { links: UiPairingLink[]; requests: UiPairingRequest[]; clients: UiPairedClient[]; owners: UiOwnerConnection[] } {
    this.sweep();
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
    const clients = [...this.clients.values()].map((client): UiPairedClient => {
      const expiresAt = this.expiresAt(client);
      return {
        id: client.id,
        label: client.label,
        device: client.device,
        pairedAt: client.pairedAt,
        connections: counts.get(client.id) ?? 0,
        current: currentCredential?.kind === "client" && currentCredential.clientId === client.id,
        access: client.access,
        idleTimeoutDays: client.idleTimeoutDays,
        ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        ...(client.lastSeenAt ? { lastSeenAt: client.lastSeenAt } : {}),
        ...(client.lastAddress ? { lastAddress: client.lastAddress } : {}),
        ...(client.lastAction ? { lastAction: client.lastAction } : {}),
      };
    });
    clients.sort((a, b) => Number(b.current) - Number(a.current)
      || Number(b.connections > 0) - Number(a.connections > 0)
      || b.pairedAt.localeCompare(a.pairedAt));
    owners.sort((a, b) => Number(b.current) - Number(a.current) || a.since.localeCompare(b.since));
    const links = [...this.links.values()].sort((a, b) => b.createdAt - a.createdAt).map(linkInfo);
    const requests = [...this.requests.values()]
      .filter((pending) => pending.state === "waiting")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(requestInfo);
    return { links, requests, clients, owners };
  }

  /** Writes what changed since the last write, such as when clients were last seen. */
  flush(): Promise<void> {
    return this.save();
  }

  private waitingReply(pending: PendingRequest): HostPairReply {
    return { state: "waiting", requestId: pending.id, verification: pending.verification!, expiresAt: new Date(pending.expiresAt).toISOString() };
  }

  /** When the token stops working if unused; undefined when it never does. */
  private expiresAt(client: StoredClient): number | undefined {
    if (client.idleTimeoutDays === null) return undefined;
    const last = Date.parse(client.lastSeenAt ?? client.pairedAt);
    return (Number.isFinite(last) ? last : 0) + client.idleTimeoutDays * DAY_MS;
  }

  private expired(client: StoredClient): boolean {
    const expiresAt = this.expiresAt(client);
    if (expiresAt === undefined || expiresAt > this.now()) return false;
    // Connected is in use, however quiet.
    return ![...this.live.values()].some((connection) => connection.credential.kind === "client" && connection.credential.clientId === client.id);
  }

  /** Only a device without a connection expires, so there is nothing to close. */
  private forgetExpired(client: StoredClient): void {
    this.clients.delete(client.id);
    this.options.audit?.({ clientId: client.id, label: client.label, action: "token expired unused", allowed: true });
    this.changed();
    void this.save().catch(() => undefined);
  }

  private closeClient(id: string, reason: string): void {
    for (const connection of [...this.live.values()]) {
      if (connection.credential.kind !== "client" || connection.credential.clientId !== id) continue;
      this.live.delete(connection.id);
      connection.close(reason);
    }
  }

  private changed(): void {
    this.options.onChange?.();
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
    access: link.access,
    createdAt: new Date(link.createdAt).toISOString(),
    expiresAt: new Date(link.expiresAt).toISOString(),
  };
}

function requestInfo(pending: PendingRequest): UiPairingRequest {
  return {
    id: pending.id,
    ...(pending.name ? { name: pending.name } : {}),
    device: pending.device,
    ...(pending.address ? { address: pending.address } : {}),
    ...(pending.link ? { link: pending.link.label ? { label: pending.link.label } : {} } : {}),
    verification: pending.verification!,
    access: pending.link?.access ?? "full",
    createdAt: new Date(pending.createdAt).toISOString(),
    expiresAt: new Date(pending.expiresAt).toISOString(),
  };
}

/** Version 1 records predate presets and timeouts: they are Full, with the default timeout. */
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
    const lastAction = entry.lastAction as { action?: unknown; at?: unknown } | undefined;
    clients.push({
      id,
      secretHash,
      label: cleanLabel(typeof label === "string" ? label : undefined) ?? "Paired client",
      pairedAt: typeof pairedAt === "string" ? pairedAt : new Date(0).toISOString(),
      device: device && typeof device === "object" && typeof device.kind === "string" ? device : { kind: "unknown" },
      // An unreadable preset is the narrower one.
      access: entry.access === undefined ? "full" : isDeviceAccess(entry.access) ? entry.access : "read-only",
      idleTimeoutDays: isIdleTimeout(entry.idleTimeoutDays) ? entry.idleTimeoutDays : DEFAULT_IDLE_TIMEOUT_DAYS,
      ...(typeof entry.pairedFrom === "string" ? { pairedFrom: entry.pairedFrom } : {}),
      ...(typeof entry.lastSeenAt === "string" ? { lastSeenAt: entry.lastSeenAt } : {}),
      ...(typeof entry.lastAddress === "string" ? { lastAddress: entry.lastAddress } : {}),
      ...(lastAction && typeof lastAction.action === "string" && typeof lastAction.at === "string"
        ? { lastAction: { action: lastAction.action, at: lastAction.at } } : {}),
    });
  }
  return clients;
}
