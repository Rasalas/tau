import { createHash } from "node:crypto";

export interface RateLimitOptions {
  /** Requests a key may make at once. */
  capacity: number;
  /** One request comes back every this many milliseconds. */
  refillMs: number;
  /** Keys kept; the least recently seen go first. */
  maxKeys?: number;
  now?(): number;
}

/**
 * A token bucket per key, in this instance's memory only: nothing is stored,
 * and each instance counts on its own. Keys are hashed before they are kept.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(private readonly options: RateLimitOptions) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  /** Takes one request; answers 0, or the milliseconds until the next one is allowed. */
  take(key: string): number {
    const id = createHash("sha256").update(key).digest("base64url").slice(0, 22);
    const now = this.now();
    const { capacity, refillMs } = this.options;
    const prior = this.buckets.get(id);
    const tokens = prior ? Math.min(capacity, prior.tokens + (now - prior.at) / refillMs) : capacity;
    this.buckets.delete(id);
    if (tokens < 1) {
      this.buckets.set(id, { tokens, at: now });
      return Math.ceil((1 - tokens) * refillMs);
    }
    this.buckets.set(id, { tokens: tokens - 1, at: now });
    if (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
    return 0;
  }
}
