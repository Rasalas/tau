import { createHash } from "node:crypto";

export interface RuntimeResourceFingerprintInput {
  cwd: string;
  settings: unknown;
  extensions: unknown;
  providerState: unknown;
}

export function runtimeResourceFingerprint(input: RuntimeResourceFingerprintInput): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

export interface ResourceCacheOptions { maxEntries?: number; ttlMs?: number; now?: () => number; }
interface Entry<T> { value: T; createdAt: number; lastUsedAt: number; }

/** Bounded, expiring cache for immutable discovery artifacts (not sessions). */
export class RuntimeResourceCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(options: ResourceCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 4;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    if (this.maxEntries < 1 || this.ttlMs < 1) throw new Error("Invalid resource cache limits");
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.createdAt >= this.ttlMs) { this.entries.delete(key); return undefined; }
    entry.lastUsedAt = this.now();
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  async getOrCreate(key: string, create: () => Promise<T> | T): Promise<{ value: T; hit: boolean }> {
    const cached = this.get(key);
    if (cached !== undefined) return { value: cached, hit: true };
    // Do not cache rejected/partial resource creation. The next request gets a
    // complete rebuild rather than inheriting a failed discovery result.
    const value = await create();
    this.set(key, value);
    return { value, hit: false };
  }

  set(key: string, value: T): void {
    const now = this.now();
    this.entries.delete(key);
    this.entries.set(key, { value, createdAt: now, lastUsedAt: now });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
  invalidate(key?: string): void { if (key) this.entries.delete(key); else this.entries.clear(); }
  get size(): number { return this.entries.size; }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
