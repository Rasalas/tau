import type { ActivityPort, ActivityToken } from "./activities";

interface ActivityRelayOptions {
  url: string;
  authorized(hostId: string): Promise<boolean>;
  /** True only after this host explicitly selects its own APNs credentials. */
  direct?(hostId: string): boolean;
  keys: { forHost(hostId: string): Promise<{ keyId: string; key: string }> };
  installKey(value: { hostId: string; keyId: string; key: string }): Promise<void>;
  fetch?: typeof fetch;
}

/** Each ActivityKit token has a purpose-bound handle. Relay failures never
 * disclose the token to a host. Key installation and revocation serialize. */
export function relayActivities(port: ActivityPort, options: ActivityRelayOptions): ActivityPort {
  const fetcher = options.fetch ?? fetch;
  const generations = new Map<string, number>();
  const registrations = new Map<string, Promise<ActivityToken>>();
  const keyWrites = new Map<string, Promise<unknown>>();
  const generation = (hostId: string) => generations.get(hostId) ?? 0;
  function serial<T>(hostId: string, work: () => Promise<T>): Promise<T> {
    const next = (keyWrites.get(hostId) ?? Promise.resolve()).catch(() => undefined).then(work);
    keyWrites.set(hostId, next);
    return next;
  }
  async function registration(token: ActivityToken, current: number): Promise<ActivityToken> {
    const key = await serial(token.hostId, async () => {
      if (!(await options.authorized(token.hostId)) || generation(token.hostId) !== current) throw new Error("Host access changed.");
      const value = await options.keys.forHost(token.hostId);
      if (generation(token.hostId) !== current) throw new Error("Host access changed.");
      await options.installKey({ hostId: token.hostId, ...value });
      // A clear queued during installation runs immediately after this operation.
      if (generation(token.hostId) !== current) throw new Error("Host access changed.");
      return value;
    });
    const response = await fetcher(`${options.url.replace(/\/$/u, "")}/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "ios", token: token.token, purpose: "activity" }),
      signal: AbortSignal.timeout(20_000),
    });
    const answer = await response.json() as { handle?: unknown; purpose?: unknown };
    if (!response.ok || answer.purpose !== "activity" || typeof answer.handle !== "string" || !/^[A-Za-z0-9_-]{40,6000}$/u.test(answer.handle)) throw new Error("Tau's relay does not support Live Activity updates yet.");
    if (!(await options.authorized(token.hostId)) || generation(token.hostId) !== current) throw new Error("Host access changed.");
    return { ...token, relay: { handle: answer.handle, ...key } };
  }
  return {
    ...port,
    tokens: port.tokens ? async (listener) => {
      let active = true;
      const off = await port.tokens!(async (token) => {
        const current = generation(token.hostId);
        if (!(await options.authorized(token.hostId)) || !active || current !== generation(token.hostId)) return;
        if (options.direct?.(token.hostId)) { listener(token); return; }
        const cacheKey = `${token.hostId}:${token.threadId}:${token.token}`;
        let pending = registrations.get(cacheKey);
        if (!pending) { pending = registration(token, current); registrations.set(cacheKey, pending); }
        try {
          const value = await pending;
          if (await options.authorized(token.hostId) && active && current === generation(token.hostId)) listener(value);
        } catch { registrations.delete(cacheKey); }
      });
      return () => { active = false; off(); };
    } : undefined,
    clear: async (hostId) => {
      generations.set(hostId, generation(hostId) + 1);
      for (const key of registrations.keys()) if (key.startsWith(`${hostId}:`)) registrations.delete(key);
      await serial(hostId, () => port.clear(hostId));
    },
  };
}
