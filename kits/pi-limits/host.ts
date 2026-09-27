import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostExtension } from "tau/host-extension";
import { anthropicIdentity, readPiChatgptIdentity, type AccountIdentity } from "./account-identity.js";
import { windowsFromHeaders, type LimitAccount, type LimitWindow } from "./limits.js";

export const PI_LIMITS_EXTENSION_ID = "tau.pi-limits";
const USAGE_KIT_ID = "tau.usage";
const SAVE_DELAY_MS = 2_000;

/** `identity` is a hash only; the file keeps nothing else of the account. */
interface Held { at: number; windows: LimitWindow[]; identity?: AccountIdentity }

function identityOf(value: unknown): AccountIdentity | undefined {
  const raw = value && typeof value === "object" ? value as { provider?: unknown; key?: unknown } : undefined;
  return typeof raw?.provider === "string" && typeof raw.key === "string" && /^[0-9a-f]{64}$/u.test(raw.key) ? { provider: raw.provider, key: raw.key } : undefined;
}

export interface PiLimitsOptions {
  now?(): number;
}

/**
 * Pi Limits: remembers the quota windows Pi's subscription providers send in
 * their response headers, per provider, and answers them to the Usage kit.
 * A window a later response leaves out keeps what was seen before.
 */
export function createPiLimitsHostExtension(options: PiLimitsOptions = {}): HostExtension {
  const now = options.now ?? Date.now;
  return {
    id: PI_LIMITS_EXTENSION_ID,
    name: "Pi Limits",
    permissions: ["runtime:extend"],
    async activate(context) {
      const { services } = context;
      const file = join(services.stateDir, "limits.json");
      const held = new Map<string, Held>();
      try {
        const stored = JSON.parse(await readFile(file, "utf8")) as { providers?: Record<string, Held> };
        for (const [provider, entry] of Object.entries(stored.providers ?? {})) {
          if (typeof entry?.at !== "number" || !Array.isArray(entry.windows)) continue;
          const identity = identityOf(entry.identity);
          held.set(provider, { at: entry.at, windows: entry.windows, ...(identity ? { identity } : {}) });
        }
      } catch {
        // Nothing seen yet.
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const save = async () => {
        timer = undefined;
        const temporary = `${file}.${process.pid}.tmp`;
        try {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(temporary, JSON.stringify({ providers: Object.fromEntries(held) }));
          await rename(temporary, file);
        } catch (error) {
          services.log("pi-limits.save-failed", error instanceof Error ? error.message : String(error));
        }
      };
      const note = (provider: string, windows: LimitWindow[], identity: AccountIdentity | undefined) => {
        const previous = held.get(provider);
        const merged = new Map((previous?.windows ?? []).map((window) => [window.id, window] as const));
        for (const window of windows) merged.set(window.id, window);
        const known = identity ?? previous?.identity;
        held.set(provider, { at: now(), windows: [...merged.values()], ...(known ? { identity: known } : {}) });
        timer ??= setTimeout(() => void save(), SAVE_DELAY_MS);
        timer.unref?.();
      };

      const unregister = services.registerRuntimeExtension("tau-pi-limits", (pi) => {
        pi.on("after_provider_response", (event, ctx) => {
          const provider = ctx.model?.provider;
          if (!provider) return;
          const windows = windowsFromHeaders(event.headers, now());
          if (windows.length > 0) note(provider, windows, anthropicIdentity(event.headers));
        });
      });

      // A ChatGPT login's identity is read from Pi's auth.json as asked, so a new login counts at once.
      context.registerCommand("usage-limits", async (): Promise<{ accounts: LimitAccount[] }> => ({
        accounts: await Promise.all([...held].map(async ([provider, entry]) => {
          const identity = entry.identity ?? await readPiChatgptIdentity(services.agentDir, provider);
          return { id: `pi:${provider}`, runtime: "pi", label: `Pi · ${provider}`, checkedAt: entry.at, windows: entry.windows, ...(identity ? { identity } : {}) };
        })),
      }), { access: "read", callers: [USAGE_KIT_ID] });

      return async () => {
        unregister();
        if (timer) { clearTimeout(timer); await save(); }
      };
    },
  };
}

export default createPiLimitsHostExtension;
