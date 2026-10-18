import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";
import {
  McpOAuthError, matchesMcpRedirect, mcpChallenge, mcpIssuer, mcpRedirects, mcpScopes, validMcpVerifier,
  type ExternalMcpExecution, type ExternalMcpScope,
} from "./external-mcp-policy.js";

const MINUTE = 60_000;
const ACCESS_LIFETIME = 15 * MINUTE;
const CONSENT_LIFETIME = 5 * MINUTE;
const GRANT_LIFETIME = 30 * 24 * 60 * MINUTE;
const MAX_CLIENTS = 64;
const MAX_GRANTS = 128;
const MAX_PENDING = 64;
const MAX_ACCESS_TOKENS = 2048;
const MAX_REFRESH_TOKENS = 8192;
const MAX_LEASES = 128;

const Id = Type.String({ minLength: 1, maxLength: 128 });
const Timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Scopes = Type.Array(Type.Union([Type.Literal("tau:read"), Type.Literal("tau:threads")]), { minItems: 1, maxItems: 2, uniqueItems: true });
const Client = Type.Object({ id: Id, name: Type.String({ minLength: 1, maxLength: 80 }), redirectUris: Type.Array(Type.String(), { minItems: 1, maxItems: 8, uniqueItems: true }) }, { additionalProperties: false });
const Grant = Type.Object({
  id: Id, clientId: Id, scopes: Scopes,
  projectIds: Type.Array(Id, { minItems: 1, maxItems: 64, uniqueItems: true }),
  execution: Type.Union([Type.Literal("read-only"), Type.Literal("ask"), Type.Literal("auto"), Type.Literal("full")]),
  createdAt: Timestamp, expiresAt: Timestamp,
}, { additionalProperties: false });
const Token = Type.Object({ hash: Hash, grantId: Id, issuedAt: Timestamp, expiresAt: Timestamp, scopes: Scopes }, { additionalProperties: false });
const Refresh = Type.Object({ ...Token.properties, used: Type.Boolean() }, { additionalProperties: false });
const Store = Type.Object({
  version: Type.Literal(1), issuer: Type.String(),
  clients: Type.Array(Client, { maxItems: MAX_CLIENTS }),
  grants: Type.Array(Grant, { maxItems: MAX_GRANTS }),
  access: Type.Array(Token, { maxItems: MAX_ACCESS_TOKENS }),
  refresh: Type.Array(Refresh, { maxItems: MAX_REFRESH_TOKENS }),
}, { additionalProperties: false });
type Stored = Static<typeof Store>;
type StoredGrant = Static<typeof Grant>;

export interface ExternalMcpGrant {
  readonly id: string;
  readonly clientId: string;
  readonly scopes: readonly ExternalMcpScope[];
  readonly projectIds: readonly string[];
  /** A ceiling for the dispatcher to enforce before starting or steering a runtime. */
  readonly execution: ExternalMcpExecution;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface McpAuthorizationRequest {
  clientId: string;
  redirectUri: string;
  resource: string;
  scope?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state?: string;
}

interface PendingAuthorization {
  id: string;
  clientId: string;
  redirectUri: string;
  scopes: ExternalMcpScope[];
  challenge: string;
  state?: string;
  expiresAt: number;
}

interface AuthorizationCode {
  grantId: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
  used: boolean;
}

export interface McpOAuthTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface ExternalMcpAuthorizationOptions {
  storePath: string;
  /** Explicit canonical HTTPS origin; never inferred from Host/Forwarded headers. */
  issuer: string;
  now?: () => number;
  logger?: PersistedJsonLogger;
}

function secret(kind: string): string { return `tau_mcp_${kind}_${randomBytes(32).toString("base64url")}`; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function equalChallenge(a: string, b: string): boolean {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
function unique(values: string[]): boolean { return new Set(values).size === values.length; }
function printable(value: string, max: number): boolean { return value.trim().length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value); }
function snapshot(grant: StoredGrant): ExternalMcpGrant {
  return Object.freeze({ ...grant, scopes: Object.freeze([...grant.scopes]), projectIds: Object.freeze([...grant.projectIds]) });
}

function decodeStore(value: unknown, issuer: string): Stored {
  if (!Check(Store, value) || value.issuer !== issuer) throw new Error("External MCP authorization store is invalid or belongs to another issuer.");
  const clients = new Set(value.clients.map((client) => client.id));
  const grants = new Map(value.grants.map((grant) => [grant.id, grant]));
  if (clients.size !== value.clients.length || grants.size !== value.grants.length
    || !unique([...value.access, ...value.refresh].map((token) => token.hash))) throw new Error("External MCP authorization store contains duplicate identities.");
  for (const client of value.clients) {
    if (!printable(client.name, 80)) throw new Error("External MCP client name is invalid.");
    mcpRedirects(client.redirectUris);
  }
  for (const grant of value.grants) {
    if (!clients.has(grant.clientId) || !grant.scopes.includes("tau:read") || grant.expiresAt <= grant.createdAt
      || grant.expiresAt - grant.createdAt > GRANT_LIFETIME
      || (!grant.scopes.includes("tau:threads") && grant.execution !== "read-only")
      || grant.projectIds.some((id) => !printable(id, 128))) throw new Error("External MCP grant is invalid.");
  }
  for (const token of [...value.access, ...value.refresh]) {
    const grant = grants.get(token.grantId);
    if (!grant || token.expiresAt > grant.expiresAt || token.issuedAt < grant.createdAt || token.expiresAt <= token.issuedAt
      || !token.scopes.includes("tau:read") || token.scopes.some((scope) => !grant.scopes.includes(scope))) throw new Error("External MCP token has no valid grant.");
  }
  if (value.access.some((token) => token.expiresAt - token.issuedAt > ACCESS_LIFETIME)
    || value.refresh.some((token) => token.expiresAt !== grants.get(token.grantId)?.expiresAt)) throw new Error("External MCP token lifetime is invalid.");
  return value;
}

/**
 * Separate external-client credentials. Management methods require an owner-
 * authenticated caller at the integration seam; this module has no transport.
 * A tool dispatcher must acquire a lease on every call and enforce its ceiling.
 */
export class ExternalMcpAuthorization {
  readonly issuer: string;
  readonly resource: string;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly blocked = new Set<string>();
  private readonly leases = new Map<string, Set<{ controller: AbortController; timer: ReturnType<typeof setTimeout> }>>();
  private tail: Promise<unknown> = Promise.resolve();
  private unavailable = false;

  private constructor(private readonly options: ExternalMcpAuthorizationOptions, private stored: Stored) {
    this.issuer = stored.issuer;
    this.resource = `${this.issuer}/mcp`;
    this.now = options.now ?? Date.now;
  }

  static async open(options: ExternalMcpAuthorizationOptions): Promise<ExternalMcpAuthorization> {
    const issuer = mcpIssuer(options.issuer);
    const existing = await stat(options.storePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.size > 4 * 1024 * 1024)) throw new Error("External MCP authorization store is not a bounded file.");
    const result = await readPersistedJson(options.storePath, {
      expectedVersion: 1, logger: options.logger,
      decode: (value, version) => {
        if (version !== 1) throw new Error("Unsupported external MCP authorization store version.");
        return decodeStore(value, issuer);
      },
    });
    // readPersistedJson quarantines invalid JSON. This credential store refuses
    // to silently start over; the owner must explicitly repair or remove it.
    if (existing && !result) throw new Error("External MCP authorization store could not be decoded.");
    const stored: Stored = result?.data ?? { version: 1, issuer, clients: [], grants: [], access: [], refresh: [] };
    return new ExternalMcpAuthorization(options, stored);
  }

  private available(): void {
    if (this.unavailable) throw new McpOAuthError("temporarily_unavailable");
  }

  private prune(stored: Stored): void {
    const now = this.now();
    stored.grants = stored.grants.filter((grant) => grant.expiresAt > now);
    const grants = new Set(stored.grants.map((grant) => grant.id));
    stored.access = stored.access.filter((token) => token.expiresAt > now && grants.has(token.grantId));
    // Used refresh hashes remain until their grant expires to detect replay.
    stored.refresh = stored.refresh.filter((token) => token.expiresAt > now && grants.has(token.grantId));
    this.pruneMemory();
  }

  private mutate<T>(change: (draft: Stored) => { result: T; committed?: () => void }): Promise<T> {
    const next = this.tail.catch(() => undefined).then(async () => {
      this.available();
      const draft = structuredClone(this.stored);
      this.prune(draft);
      const { result, committed } = change(draft);
      try {
        await writePersistedJson(this.options.storePath, 1, draft, { logger: this.options.logger });
      } catch (error) {
        this.close();
        throw error;
      }
      // close() may have run while the durable write was in flight.
      this.available();
      this.stored = draft;
      for (const id of this.blocked) if (!draft.grants.some((grant) => grant.id === id)) this.blocked.delete(id);
      committed?.();
      return result;
    });
    this.tail = next;
    return next;
  }

  /** Owner only. Public clients use PKCE, never a distributed client secret. */
  async registerClient(input: { name: string; redirectUris: readonly string[] }): Promise<Static<typeof Client>> {
    if (!printable(input.name, 80)) throw new McpOAuthError("invalid_request");
    const client = { id: secret("client"), name: input.name, redirectUris: mcpRedirects(input.redirectUris) };
    return this.mutate((draft) => {
      if (draft.clients.length >= MAX_CLIENTS) throw new McpOAuthError("temporarily_unavailable");
      draft.clients.push(client);
      return { result: structuredClone(client) };
    });
  }

  /** Sanitized owner view. Never includes codes, challenges, state or tokens. */
  ownerState(): {
    clients: Static<typeof Client>[];
    grants: ExternalMcpGrant[];
    pending: Array<{ id: string; clientId: string; redirectUri: string; scopes: ExternalMcpScope[]; expiresAt: number }>;
  } {
    this.available();
    const now = this.now();
    return {
      clients: structuredClone(this.stored.clients),
      grants: this.stored.grants.filter((grant) => grant.expiresAt > now && !this.blocked.has(grant.id)).map(snapshot),
      pending: [...this.pending.values()].filter((request) => request.expiresAt > now).map(({ id, clientId, redirectUri, scopes, expiresAt }) => ({ id, clientId, redirectUri, scopes: [...scopes], expiresAt })),
    };
  }

  /** Public authorize request; produces no code or token until the owner approves. */
  requestAuthorization(input: McpAuthorizationRequest): string {
    this.available();
    this.pruneMemory();
    const client = this.stored.clients.find((entry) => entry.id === input.clientId);
    if (!client) throw new McpOAuthError("invalid_client");
    if (input.clientId.length > 128 || input.resource !== this.resource || input.codeChallengeMethod !== "S256"
      || !/^[A-Za-z0-9_-]{43}$/u.test(input.codeChallenge)
      || (input.state !== undefined && input.state.length > 2048)
      || !client.redirectUris.some((uri) => matchesMcpRedirect(uri, input.redirectUri))) throw new McpOAuthError("invalid_request");
    const scopes = mcpScopes(input.scope);
    if (this.pending.size + this.codes.size >= MAX_PENDING) throw new McpOAuthError("temporarily_unavailable");
    const id = secret("request");
    this.pending.set(id, { id, clientId: client.id, redirectUri: input.redirectUri, scopes, challenge: input.codeChallenge, state: input.state, expiresAt: this.now() + CONSENT_LIFETIME });
    return id;
  }

  private pruneMemory(): void {
    const now = this.now();
    for (const [id, request] of this.pending) if (request.expiresAt <= now) this.pending.delete(id);
    for (const [id, code] of this.codes) if (code.expiresAt <= now) this.codes.delete(id);
  }

  /** Owner only. The caller resolves project identities, not client-supplied paths. */
  async approve(id: string, consent: { projectIds: readonly string[]; scope?: string; execution?: ExternalMcpExecution }): Promise<{ redirectUri: string }> {
    const projectIds = [...new Set(consent.projectIds)];
    if (!projectIds.length || projectIds.length > 64 || projectIds.some((projectId) => !printable(projectId, 128))) throw new McpOAuthError("invalid_request");
    const selectedScopes = consent.scope === undefined ? undefined : mcpScopes(consent.scope);
    if (consent.execution !== undefined && !["read-only", "ask", "auto", "full"].includes(consent.execution)) throw new McpOAuthError("invalid_request");
    return this.mutate((draft) => {
      const request = this.pending.get(id);
      if (!request || !draft.clients.some((client) => client.id === request.clientId)) throw new McpOAuthError("invalid_request");
      const scopes = selectedScopes ?? request.scopes;
      if (scopes.some((scope) => !request.scopes.includes(scope))) throw new McpOAuthError("invalid_scope");
      const execution = consent.execution ?? (scopes.includes("tau:threads") ? "ask" : "read-only");
      if (!scopes.includes("tau:threads") && execution !== "read-only") throw new McpOAuthError("invalid_scope");
      if (draft.grants.length >= MAX_GRANTS) throw new McpOAuthError("temporarily_unavailable");
      const createdAt = this.now();
      const grant: StoredGrant = { id: secret("grant"), clientId: request.clientId, scopes: [...scopes], projectIds, execution, createdAt, expiresAt: createdAt + GRANT_LIFETIME };
      const code = secret("code");
      const codeHash = hash(code);
      const redirect = new URL(request.redirectUri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("iss", this.issuer);
      if (request.state !== undefined) redirect.searchParams.set("state", request.state);
      draft.grants.push(grant);
      return {
        result: { redirectUri: redirect.href },
        committed: () => {
          this.pending.delete(id);
          this.codes.set(codeHash, { grantId: grant.id, clientId: request.clientId, redirectUri: request.redirectUri, challenge: request.challenge, expiresAt: this.now() + CONSENT_LIFETIME, used: false });
        },
      };
    });
  }

  /** Owner only. The HTTP adapter may report denial without accepting a public approval. */
  deny(id: string): Promise<void> {
    return this.mutate(() => ({ result: undefined, committed: () => { this.pending.delete(id); } }));
  }

  private issue(draft: Stored, grant: StoredGrant, scopes = grant.scopes): McpOAuthTokens {
    if (draft.access.length >= MAX_ACCESS_TOKENS || draft.refresh.length >= MAX_REFRESH_TOKENS) throw new McpOAuthError("temporarily_unavailable");
    const access = secret("access");
    const refresh = secret("refresh");
    const issuedAt = this.now();
    const expiresAt = Math.min(issuedAt + ACCESS_LIFETIME, grant.expiresAt);
    draft.access.push({ hash: hash(access), grantId: grant.id, issuedAt, expiresAt, scopes: [...scopes] });
    draft.refresh.push({ hash: hash(refresh), grantId: grant.id, issuedAt, expiresAt: grant.expiresAt, scopes: [...scopes], used: false });
    return { access_token: access, token_type: "Bearer", expires_in: Math.floor((expiresAt - issuedAt) / 1000), refresh_token: refresh, scope: scopes.join(" ") };
  }

  exchangeCode(input: { clientId: string; code: string; codeVerifier: string; redirectUri: string; resource: string }): Promise<McpOAuthTokens> {
    return this.mutate((draft) => {
      const code = this.codes.get(hash(input.code));
      if (!code || input.code.length > 128 || code.clientId !== input.clientId || input.resource !== this.resource || code.redirectUri !== input.redirectUri
        || !validMcpVerifier(input.codeVerifier) || !equalChallenge(code.challenge, mcpChallenge(input.codeVerifier))) throw new McpOAuthError("invalid_grant");
      if (code.used) return this.replay(draft, code.grantId);
      const grant = draft.grants.find((entry) => entry.id === code.grantId && !this.blocked.has(entry.id));
      if (!grant) throw new McpOAuthError("invalid_grant");
      const tokens = this.issue(draft, grant);
      return { result: tokens, committed: () => { code.used = true; } };
    });
  }

  async refresh(input: { clientId: string; refreshToken: string; resource: string; scope?: string }): Promise<McpOAuthTokens> {
    const requested = input.scope === undefined ? undefined : mcpScopes(input.scope);
    return this.mutate((draft) => {
      const token = draft.refresh.find((entry) => entry.hash === hash(input.refreshToken));
      const grant = token && draft.grants.find((entry) => entry.id === token.grantId && entry.clientId === input.clientId && !this.blocked.has(entry.id));
      if (!token || !grant || input.refreshToken.length > 128 || input.resource !== this.resource) throw new McpOAuthError("invalid_grant");
      if (token.used) return this.replay(draft, grant.id);
      if (requested?.some((scope) => !token.scopes.includes(scope))) throw new McpOAuthError("invalid_scope");
      const result = this.issue(draft, grant, requested ?? token.scopes);
      token.used = true;
      return { result };
    });
  }

  private replay(draft: Stored, grantId: string): { result: McpOAuthTokens; committed: () => never } {
    this.blockGrant(grantId);
    this.removeGrant(draft, grantId);
    // Commit revocation before reporting an invalid grant. Throwing inside the
    // draft mutation would discard the revocation along with the failed request.
    return { result: undefined as never, committed: () => { throw new McpOAuthError("invalid_grant"); } };
  }

  private live(token: string, resource: string): { grant: StoredGrant; expiresAt: number } | undefined {
    this.available();
    if (resource !== this.resource || token.length > 128 || !token.startsWith("tau_mcp_access_")) return undefined;
    const found = this.stored.access.find((entry) => entry.hash === hash(token));
    if (!found || found.expiresAt <= this.now()) return undefined;
    const grant = this.stored.grants.find((entry) => entry.id === found.grantId && entry.expiresAt > this.now() && !this.blocked.has(entry.id));
    return grant ? { grant: { ...grant, scopes: [...found.scopes], execution: found.scopes.includes("tau:threads") ? grant.execution : "read-only" }, expiresAt: Math.min(found.expiresAt, grant.expiresAt) } : undefined;
  }

  authenticate(token: string, resource: string): ExternalMcpGrant | undefined {
    const live = this.live(token, resource);
    return live ? snapshot(live.grant) : undefined;
  }

  /** One bounded tool call. Revocation, expiry and close abort its signal. */
  lease(token: string, resource: string, required: { scope: ExternalMcpScope; projectId: string }): { grant: ExternalMcpGrant; signal: AbortSignal; release(): void } {
    const live = this.live(token, resource);
    if (!live) throw new McpOAuthError("invalid_grant");
    if (!live.grant.scopes.includes(required.scope) || !live.grant.projectIds.includes(required.projectId)) throw new McpOAuthError("access_denied");
    if ([...this.leases.values()].reduce((sum, entries) => sum + entries.size, 0) >= MAX_LEASES) throw new McpOAuthError("temporarily_unavailable");
    const controller = new AbortController();
    const entries = this.leases.get(live.grant.id) ?? new Set();
    const entry = { controller, timer: setTimeout(() => { release(); controller.abort(); }, live.expiresAt - this.now()) };
    entry.timer.unref();
    const release = () => {
      clearTimeout(entry.timer);
      entries.delete(entry);
      if (!entries.size) this.leases.delete(live.grant.id);
    };
    entries.add(entry);
    this.leases.set(live.grant.id, entries);
    return { grant: snapshot(live.grant), signal: controller.signal, release };
  }

  private blockGrant(id: string): void {
    if (!this.stored.grants.some((grant) => grant.id === id) && !this.leases.has(id)) return;
    this.blocked.add(id);
    for (const entry of this.leases.get(id) ?? []) { clearTimeout(entry.timer); entry.controller.abort(); }
    this.leases.delete(id);
  }

  private removeGrant(draft: Stored, id: string): void {
    draft.grants = draft.grants.filter((grant) => grant.id !== id);
    draft.access = draft.access.filter((token) => token.grantId !== id);
    draft.refresh = draft.refresh.filter((token) => token.grantId !== id);
  }

  /** Owner only; blocks new work and cancels calls before awaiting persistence. */
  revokeGrant(id: string): Promise<void> {
    this.available();
    this.blockGrant(id);
    return this.mutate((draft) => { this.removeGrant(draft, id); return { result: undefined }; });
  }

  /** RFC 7009: unknown tokens are successful no-ops; another client cannot revoke. */
  revokeToken(clientId: string, token: string): Promise<void> {
    return this.mutate((draft) => {
      const found = [...draft.access, ...draft.refresh].find((entry) => entry.hash === hash(token));
      const grant = found && draft.grants.find((entry) => entry.id === found.grantId && entry.clientId === clientId);
      if (grant) { this.blockGrant(grant.id); this.removeGrant(draft, grant.id); }
      return { result: undefined };
    });
  }

  /** Owner only; also removes pending requests and every grant of this client. */
  removeClient(id: string): Promise<void> {
    this.available();
    for (const grant of this.stored.grants) if (grant.clientId === id) this.blockGrant(grant.id);
    return this.mutate((draft) => {
      draft.clients = draft.clients.filter((client) => client.id !== id);
      for (const grant of [...draft.grants]) if (grant.clientId === id) { this.blockGrant(grant.id); this.removeGrant(draft, grant.id); }
      return { result: undefined, committed: () => { for (const [requestId, request] of this.pending) if (request.clientId === id) this.pending.delete(requestId); } };
    });
  }

  close(): void {
    this.unavailable = true;
    for (const entries of this.leases.values()) for (const entry of entries) { clearTimeout(entry.timer); entry.controller.abort(); }
    this.leases.clear();
    this.pending.clear();
    this.codes.clear();
  }
}
