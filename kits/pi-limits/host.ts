import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostExtension } from "tau/host-extension";
import { windowsFromHeaders, type LimitAccount, type LimitWindow } from "./limits.js";

export const PI_LIMITS_EXTENSION_ID = "tau.pi-limits";
const USAGE_KIT_ID = "tau.usage";
const SAVE_DELAY_MS = 2_000;

interface Held { at: number; windows: LimitWindow[] }

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
          if (typeof entry?.at === "number" && Array.isArray(entry.windows)) held.set(provider, entry);
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
      const note = (provider: string, windows: LimitWindow[]) => {
        const merged = new Map((held.get(provider)?.windows ?? []).map((window) => [window.id, window] as const));
        for (const window of windows) merged.set(window.id, window);
        held.set(provider, { at: now(), windows: [...merged.values()] });
        timer ??= setTimeout(() => void save(), SAVE_DELAY_MS);
        timer.unref?.();
      };

      const unregister = services.registerRuntimeExtension("tau-pi-limits", (pi) => {
        pi.on("after_provider_response", (event, ctx) => {
          const provider = ctx.model?.provider;
          if (!provider) return;
          const windows = windowsFromHeaders(event.headers, now());
          if (windows.length > 0) note(provider, windows);
        });
      });

      context.registerCommand("usage-limits", (): { accounts: LimitAccount[] } => ({
        accounts: [...held].map(([provider, entry]) => ({ id: `pi:${provider}`, runtime: "pi", label: `Pi · ${provider}`, checkedAt: entry.at, windows: entry.windows })),
      }), { callers: [USAGE_KIT_ID] });

      return async () => {
        unregister();
        if (timer) { clearTimeout(timer); await save(); }
      };
    },
  };
}

export default createPiLimitsHostExtension;
