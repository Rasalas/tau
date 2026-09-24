import { isLoopbackHost } from "./host-listen.js";

const AUTH_MAX_SOURCES = 1024;
const AUTH_IDLE_MS = 10 * 60 * 1000;
const AUTH_MAX_BACKOFF_MS = 60 * 1000;

/**
 * Admits pairing attempts per source address: a short burst, then a backoff
 * that doubles up to a minute. Answers 0 to admit, or how long to wait. A
 * loopback source gets a larger burst; a refused attempt does not extend it.
 */
export function createAuthRateLimiter(now: () => number = Date.now, options: { strict?: boolean } = {}): (source: string | undefined) => number {
  const sources = new Map<string, { attempts: number; retryAt: number; expiresAt: number }>();
  return (source) => {
    const key = (source ?? "unknown").toLowerCase().replace(/^::ffff:/u, "");
    const time = now();
    let entry = sources.get(key);
    if (entry && entry.expiresAt <= time) {
      sources.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (sources.size >= AUTH_MAX_SOURCES) {
        for (const [address, state] of sources) {
          if (state.expiresAt <= time) sources.delete(address);
        }
        if (sources.size >= AUTH_MAX_SOURCES) return AUTH_MAX_BACKOFF_MS;
      }
      entry = { attempts: 0, retryAt: time, expiresAt: time + AUTH_IDLE_MS };
      sources.set(key, entry);
    }
    if (entry.retryAt > time) return entry.retryAt - time;
    // `strict`: a listener where 127.0.0.1 is anyone (a proxy) gets no larger burst for it.
    const burst = !options.strict && isLoopbackHost(key) ? 20 : 5;
    entry.attempts = Math.min(entry.attempts + 1, burst + 6);
    entry.retryAt = time + (entry.attempts < burst ? 0 : Math.min(1000 * 2 ** (entry.attempts - burst), AUTH_MAX_BACKOFF_MS));
    entry.expiresAt = time + AUTH_IDLE_MS;
    return 0;
  };
}
