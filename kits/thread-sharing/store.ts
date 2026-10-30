import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readPersistedJson, writePersistedJson } from "tau/host-extension";
import type { GuestImage, SharedThread, Suggestion, GuestView } from "./protocol.js";
import { guestTranscript } from "./projection.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const digestPattern = /^[a-f0-9]{64}$/u;
const credential = /^tau(g|b)\.([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/u;
const equal = (left: string, right: string) => digestPattern.test(left) && digestPattern.test(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
export class GuestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
type Projection = Omit<GuestView, "mode" | "expiresAt" | "suggestions">;
interface Grant {
  id: string; threadId: string; title: string; expiresAt: number; linkHash: string;
  snapshot?: Projection; browserHash?: string; mode: "watch" | "suggest";
  showToolOutput: boolean;
}
interface Stored { enabled: boolean; grants: Grant[] }
function decode(value: unknown): Stored | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<Stored>;
  if (typeof state.enabled !== "boolean" || !Array.isArray(state.grants) || state.grants.length > 20) return undefined;
  const grants: Grant[] = [];
  const ids = new Set<string>();
  const threads = new Set<string>();
  for (const g of state.grants) {
    if (!g || !/^[a-f0-9]{24}$/u.test(g.id) || ids.has(g.id) || typeof g.threadId !== "string" || !g.threadId || g.threadId.length > 256 || threads.has(g.threadId)
      || typeof g.title !== "string" || g.title.length > 200 || !Number.isSafeInteger(g.expiresAt)
      || !digestPattern.test(g.linkHash) || (g.browserHash !== undefined && !digestPattern.test(g.browserHash)) || (g.mode !== "watch" && g.mode !== "suggest") || (g.showToolOutput !== undefined && typeof g.showToolOutput !== "boolean")) return undefined;
    if (g.snapshot && (typeof g.snapshot.title !== "string" || g.snapshot.title.length > 200 || typeof g.snapshot.machine !== "string" || g.snapshot.machine.length > 200 || typeof g.snapshot.truncated !== "boolean" || !Array.isArray(g.snapshot.messages) || g.snapshot.messages.length > 500 || g.snapshot.messages.some((m) => !m || !["user", "assistant"].includes(m.role) || typeof m.text !== "string" || m.text.length > 32_000) || g.snapshot.messages.reduce((sum, m) => sum + m.text.length, 0) > 200_000)) return undefined;
    const tools = g.snapshot?.tools ?? [];
    if (!Array.isArray(tools) || tools.length + (g.snapshot?.messages.length ?? 0) > 500 || tools.some((tool) => !tool || typeof tool.name !== "string" || tool.name.length > 128 || !["running", "done", "error"].includes(tool.status) || (tool.output !== undefined && (typeof tool.output !== "string" || tool.output.length > 32_000)) || (tool.outputTruncated !== undefined && tool.outputTruncated !== true)) || tools.reduce((sum, tool) => sum + tool.name.length + (tool.output?.length ?? 0), 0) + (g.snapshot?.messages.reduce((sum, m) => sum + m.text.length, 0) ?? 0) > 200_000) return undefined;
    ids.add(g.id); threads.add(g.threadId);
    // Ignore unknown fields even in a local persisted file.
    grants.push({ id: g.id, threadId: g.threadId, title: g.title, expiresAt: g.expiresAt, linkHash: g.linkHash, mode: g.mode, showToolOutput: g.showToolOutput === true, ...(g.browserHash ? { browserHash: g.browserHash } : {}), ...(g.snapshot ? { snapshot: { title: g.snapshot.title, machine: g.snapshot.machine, ...guestTranscript(g.snapshot.messages, { tools, truncated: g.snapshot.truncated }, g.showToolOutput === true) } } : {}) });
  }
  return { enabled: state.enabled, grants };
}

/** Separate audience, persisted hashes; never a HostAccess principal. One store per host process. */
export class GuestShares {
  private grants = new Map<string, Grant>();
  private suggestions = new Map<string, Suggestion[]>();
  private lastSeen = new Map<string, number>();
  private enabled = false;
  private closed = false;
  private creation: Promise<unknown> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private constructor(private readonly file: string, private readonly now: () => number, private readonly changed: () => void) {}
  static async open(file: string, options: { now?: () => number; changed?: () => void } = {}): Promise<GuestShares> {
    const store = new GuestShares(file, options.now ?? Date.now, options.changed ?? (() => undefined));
    const kept = await readPersistedJson(file, { expectedVersion: 1, decode });
    if (kept) { store.enabled = kept.data.enabled; store.grants = new Map(kept.data.grants.filter((grant) => grant.expiresAt > store.now()).map((grant) => [grant.id, grant])); }
    return store;
  }
  get allowed(): boolean { return this.enabled && !this.closed; }
  private save(): Promise<void> {
    const state = { enabled: this.enabled, grants: [...this.grants.values()] };
    const write = this.writes.then(() => writePersistedJson(this.file, 1, state));
    this.writes = write.catch(() => { this.enabled = false; this.suggestions.clear(); this.changed(); });
    return write;
  }
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (!enabled) this.suggestions.clear();
    this.changed();
    await this.save();
  }
  create(threadId: string, title: string, hours: number, mode: "watch" | "suggest", showToolOutput = false): Promise<{ id: string; token: string; expiresAt: number }> {
    const result = this.creation.then(() => this.createOne(threadId, title, hours, mode, showToolOutput));
    this.creation = result.catch(() => undefined);
    return result;
  }
  private async createOne(threadId: string, title: string, hours: number, mode: "watch" | "suggest", showToolOutput: boolean): Promise<{ id: string; token: string; expiresAt: number }> {
    if (!this.allowed) throw new GuestError(403, "disabled");
    if (![1, 8, 24].includes(hours) || !["watch", "suggest"].includes(mode) || typeof showToolOutput !== "boolean") throw new GuestError(400, "invalid_options");
    if (!threadId || threadId.length > 256) throw new GuestError(400, "invalid_thread");
    this.list();
    await this.revokeThread(threadId);
    if (!this.allowed) throw new GuestError(403, "disabled");
    if (this.grants.size >= 20) throw new GuestError(429, "too_many_links");
    const id = randomBytes(12).toString("hex");
    const token = `taug.${id}.${secret()}`;
    const grant: Grant = { id, threadId, title: title.slice(0, 200), expiresAt: this.now() + hours * 3_600_000, mode, showToolOutput, linkHash: hash(token) };
    this.grants.set(id, grant);
    try { await this.save(); } catch (error) { this.grants.delete(id); throw error; }
    this.changed();
    return { id, token, expiresAt: grant.expiresAt };
  }
  async revoke(id: string): Promise<void> {
    this.grants.delete(id); this.suggestions.delete(id); this.lastSeen.delete(id);
    this.changed();
    await this.save();
  }
  async revokeThread(threadId: string): Promise<void> {
    for (const grant of this.grants.values()) if (grant.threadId === threadId) await this.revoke(grant.id);
  }
  private get(token: string, audience: "g" | "b"): Grant {
    const match = credential.exec(token);
    const grant = match?.[1] === audience ? this.grants.get(match[2]!) : undefined;
    const digest = audience === "g" ? grant?.linkHash : grant?.browserHash;
    if (!this.allowed || !grant || grant.expiresAt <= this.now() || !digest || !equal(hash(token), digest)) throw new GuestError(403, "ended");
    return grant;
  }
  async claim(token: string, browserToken: string): Promise<void> {
    const grant = this.get(token, "g");
    const match = credential.exec(browserToken);
    if (match?.[1] !== "b" || match[2] !== grant.id) throw new GuestError(400, "invalid_browser");
    const browserHash = hash(browserToken);
    if (grant.browserHash && !equal(grant.browserHash, browserHash)) throw new GuestError(409, "claimed");
    // Set before awaiting persistence, so concurrent claims cannot both win.
    grant.browserHash = browserHash;
    await this.save();
    this.get(browserToken, "b");
    this.changed();
  }
  authorize(token: string): Readonly<Grant> { return this.get(token, "b"); }
  touch(token: string): void { this.lastSeen.set(this.get(token, "b").id, this.now()); }
  list(): SharedThread[] {
    for (const grant of this.grants.values()) if (grant.expiresAt <= this.now()) { this.grants.delete(grant.id); this.suggestions.delete(grant.id); this.lastSeen.delete(grant.id); }
    return [...this.grants.values()].filter((g) => g.expiresAt > this.now()).map((g) => ({
      id: g.id, threadId: g.threadId, title: g.title, expiresAt: g.expiresAt, mode: g.mode,
      claimed: !!g.browserHash, watching: this.allowed && (this.lastSeen.get(g.id) ?? 0) > this.now() - 5_000,
      suggestions: this.suggestions.get(g.id) ?? [],
    }));
  }
  suggest(token: string, text: string, images: GuestImage[]): string {
    const grant = this.get(token, "b");
    if (grant.mode !== "suggest") throw new GuestError(403, "watch_only");
    const entries = this.suggestions.get(grant.id) ?? [];
    const held = [...this.suggestions.values()].flat().reduce((sum, item) => sum + item.images.reduce((bytes, image) => bytes + image.data.length, 0), 0);
    if (held + images.reduce((bytes, image) => bytes + image.data.length, 0) > 14 * 1024 * 1024) throw new GuestError(429, "attachment_budget");
    if (entries.some((s) => s.state === "pending" || s.state === "sending")) throw new GuestError(409, "pending");
    const item: Suggestion = { id: randomBytes(12).toString("hex"), text, images, state: "pending" };
    this.suggestions.set(grant.id, [...entries.slice(-9), item]);
    this.changed();
    return item.id;
  }
  /** Only the Full/owner command path invokes delivery. HTTP never receives this function. */
  async moderate(id: string, suggestionId: string, send: boolean, deliver: (threadId: string, suggestion: Suggestion, authorized: () => boolean) => Promise<void>): Promise<void> {
    const grant = this.grants.get(id);
    const item = this.suggestions.get(id)?.find((s) => s.id === suggestionId);
    if (!this.allowed || !grant || grant.expiresAt <= this.now() || !item || item.state !== "pending") throw new GuestError(409, "ended");
    if (!send) { item.state = "dismissed"; item.text = ""; item.images = []; this.changed(); return; }
    item.state = "sending"; this.changed();
    try {
      await deliver(grant.threadId, item, () => this.allowed && this.grants.get(id) === grant && grant.expiresAt > this.now() && this.suggestions.get(id)?.includes(item) === true && item.state === "sending");
      item.state = "sent"; item.text = ""; item.images = [];
    } catch (error) {
      // Admission may have happened before an error; never offer a blind retry.
      item.state = "dismissed"; item.text = ""; item.images = [];
      throw error;
    } finally { this.changed(); }
  }
  outputAllowed(threadId: string, expectedId: string): boolean {
    const grant = this.grants.get(expectedId);
    if (!this.allowed || !grant || grant.threadId !== threadId || grant.expiresAt <= this.now()) throw new GuestError(403, "ended");
    return grant.showToolOutput;
  }
  cached(threadId: string, expectedId: string): Projection | undefined {
    const grant = this.grants.get(expectedId);
    return this.allowed && grant?.threadId === threadId && grant.expiresAt > this.now() ? grant.snapshot : undefined;
  }
  async cache(threadId: string, snapshot: Projection, expectedId: string): Promise<void> {
    const grant = this.grants.get(expectedId);
    if (!grant || grant.threadId !== threadId || !this.allowed || grant.expiresAt <= this.now()) throw new GuestError(403, "ended");
    snapshot = { title: snapshot.title.slice(0, 200), machine: snapshot.machine.slice(0, 200), ...guestTranscript(snapshot.messages, { tools: snapshot.tools, truncated: snapshot.truncated }, grant.showToolOutput) };
    if (JSON.stringify(grant.snapshot) === JSON.stringify(snapshot)) return;
    grant.snapshot = snapshot;
    await this.save();
  }
  async close(): Promise<void> {
    this.closed = true; this.suggestions.clear(); this.lastSeen.clear();
    await this.creation;
    await this.writes;
  }
}
