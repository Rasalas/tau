import { HostCommandError } from "tau/host-extension";

/** Without a reset time from the host, the first pause lasts this long and doubles up to the cap. */
const FIRST_PAUSE_MS = 30_000;
const LONGEST_PAUSE_MS = 15 * 60_000;

/** The CLIs say it in words; the APIs with 429 or GitHub's 403 with nothing remaining. */
export function isRateLimited(message: string): boolean {
  return /rate limit|HTTP 429|too many requests/iu.test(message);
}

/** A `Retry-After` (seconds or a date) or an `X-RateLimit-Reset` (epoch seconds), as a time. */
export function retryAtFrom(headers: { get(name: string): string | null }, now: number): number | undefined {
  const after = headers.get("retry-after")?.trim();
  if (after && /^\d+$/u.test(after)) return now + Number(after) * 1000;
  if (after) {
    const at = Date.parse(after);
    if (Number.isFinite(at) && at > now) return at;
  }
  const reset = headers.get("x-ratelimit-reset")?.trim();
  if (reset && /^\d+$/u.test(reset)) {
    const at = Number(reset) * 1000;
    if (at > now) return at;
  }
  return undefined;
}

/**
 * Pauses one provider on one host once it said its rate limit is reached,
 * so a polling tab does not keep hitting it: until the reset time the host
 * named, else for a pause that grows with each repeat until a call succeeds.
 */
export class RateLimitGate {
  private readonly paused = new Map<string, { until: number; attempt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Refuses while the pause lasts. */
  check(name: string, kind: string, host: string): void {
    const entry = this.paused.get(this.key(kind, host));
    if (!entry || entry.until <= this.now()) return;
    const seconds = Math.ceil((entry.until - this.now()) / 1000);
    const wait = seconds > 90 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`;
    throw new HostCommandError(`${name}'s rate limit for ${host} is reached; Tau asks again in ${wait}.`);
  }

  record(kind: string, host: string, retryAt?: number): void {
    const key = this.key(kind, host);
    const attempt = (this.paused.get(key)?.attempt ?? 0) + 1;
    const fallback = this.now() + Math.min(FIRST_PAUSE_MS * 2 ** (attempt - 1), LONGEST_PAUSE_MS);
    this.paused.set(key, { until: retryAt && retryAt > this.now() ? retryAt : fallback, attempt });
  }

  /** A call that started before the pause may still succeed; only one after it ends the pause's growth. */
  succeeded(kind: string, host: string): void {
    const key = this.key(kind, host);
    const entry = this.paused.get(key);
    if (entry && entry.until <= this.now()) this.paused.delete(key);
  }

  private key(kind: string, host: string): string {
    return `${kind}\0${host.toLowerCase()}`;
  }
}
