import type { ActivityPort, ActivityToken } from "./activities";

interface ActivityRelayOptions {
  url: string;
  keys: { forHost(hostId: string): Promise<{ keyId: string; key: string }> };
  installKey(value: { hostId: string; keyId: string; key: string }): Promise<void>;
  fetch?: typeof fetch;
}

/** Each ActivityKit update token has a purpose-bound opaque handle of its own.
 * The host gets that handle and the phone's content key, never the APNs token. */
export function relayActivities(port: ActivityPort, options: ActivityRelayOptions): ActivityPort {
  const fetcher = options.fetch ?? fetch;
  let generation = 0;
  const registrations = new Map<string, Promise<ActivityToken>>();
  async function registration(token: ActivityToken): Promise<ActivityToken> {
    const key = await options.keys.forHost(token.hostId);
    await options.installKey({ hostId: token.hostId, ...key });
    const response = await fetcher(`${options.url.replace(/\/$/u, "")}/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "ios", token: token.token, purpose: "activity" }),
      signal: AbortSignal.timeout(20_000),
    });
    const answer = await response.json() as { handle?: unknown; purpose?: unknown };
    // A pre-activity relay ignores the purpose. Never send an ActivityKit token as an alert.
    if (!response.ok || answer.purpose !== "activity" || typeof answer.handle !== "string" || !/^[A-Za-z0-9_-]{40,6000}$/u.test(answer.handle)) throw new Error("Tau's relay does not support Live Activity updates yet.");
    return { ...token, relay: { handle: answer.handle, ...key } };
  }
  return {
    ...port,
    tokens: port.tokens ? async (listener) => {
      let active = true;
      const off = await port.tokens!(async (token) => {
        const current = generation;
        const cacheKey = `${token.hostId}:${token.threadId}:${token.token}`;
        let pending = registrations.get(cacheKey);
        if (!pending) { pending = registration(token); registrations.set(cacheKey, pending); }
        try { const value = await pending; if (active && current === generation) listener(value); }
        catch { registrations.delete(cacheKey); if (active && current === generation) listener(token); }
      });
      return () => { active = false; off(); };
    } : undefined,
    clear: async (hostId) => {
      generation++;
      for (const key of registrations.keys()) if (key.startsWith(`${hostId}:`)) registrations.delete(key);
      await port.clear(hostId);
    },
  };
}
