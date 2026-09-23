import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { usesApiKey } from "./cli.js";

/**
 * The plan window of a Grok account, read the way the CLI reads it: the
 * login's token from `<GROK_HOME>/auth.json` sent to xAI's billing endpoint.
 * The shape matches Usage Kit's `UsageLimitWindow` (`kits/usage/protocol.ts`).
 * It only reads; anything that points the CLI at another account or endpoint
 * is left alone.
 */
export const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const CREDENTIAL_KEYS = ["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828", "https://accounts.x.ai/sign-in"];
/** Variables that pick another account, issuer or endpoint than the default login. */
const CUSTOM_DEPLOYMENT = [
  "GROK_OIDC_ISSUER", "GROK_OIDC_CLIENT_ID", "GROK_OAUTH2_ISSUER", "GROK_OAUTH2_CLIENT_ID", "GROK_OAUTH2_PRINCIPAL_TYPE",
  "GROK_OAUTH2_PRINCIPAL_ID", "GROK_AUTH_PROVIDER_COMMAND", "GROK_LOCAL_AUTH", "GROK_CLI_CHAT_PROXY_BASE_URL",
  "GROK_MODELS_BASE_URL", "GROK_CONFIG", "GROK_CONFIG_PATH",
];
const CUSTOM_SECTION = /^\s*(?:\[\[?\s*)?["']?(?:auth|grok_com_config|endpoints)["']?\s*[.\]=]/mu;

export interface GrokLimitWindow {
  id: string;
  kind: "weekly" | "monthly" | "other";
  label: string;
  usedPercent: number;
  resetsAt?: number;
}

export type GrokLimits =
  | { windows: GrokLimitWindow[] }
  | { unavailable: { reason: "unsupported" | "failed" | "signed-out"; message: string } };

/** The billing answer's credit window; none when it names no percentage. */
export function limitWindows(body: unknown): GrokLimitWindow[] {
  const config = (body as { config?: { creditUsagePercent?: unknown; currentPeriod?: { type?: unknown; end?: unknown } } } | undefined)?.config;
  const used = config?.creditUsagePercent;
  if (typeof used !== "number" || !Number.isFinite(used)) return [];
  const type = typeof config?.currentPeriod?.type === "string" ? config.currentPeriod.type.replace(/^USAGE_PERIOD_TYPE_/u, "") : "";
  const kind = type === "WEEKLY" ? "weekly" : type === "MONTHLY" ? "monthly" : "other";
  const end = typeof config?.currentPeriod?.end === "string" ? Date.parse(config.currentPeriod.end) : Number.NaN;
  return [{
    id: "subscription",
    kind,
    label: kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Subscription",
    usedPercent: Math.min(100, Math.max(0, used)),
    ...(Number.isFinite(end) ? { resetsAt: end } : {}),
  }];
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function readGrokLimits(options: { env: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch; home?: string }): Promise<GrokLimits> {
  const { env } = options;
  if (usesApiKey(env)) return { unavailable: { reason: "unsupported", message: "An xAI API key has no plan limits." } };
  if (CUSTOM_DEPLOYMENT.some((name) => env[name]?.trim())) return { unavailable: { reason: "unsupported", message: "Grok signs in with a custom setup; Tau reads the default login only." } };
  const home = env.GROK_HOME?.trim() || join(options.home ?? env.HOME ?? homedir(), ".grok");
  try {
    for (const file of [join(home, "config.toml"), join(home, "managed_config.toml"), join(home, "requirements.toml")]) {
      if (CUSTOM_SECTION.test(await readText(file))) return { unavailable: { reason: "unsupported", message: "Grok's config names its own login or endpoint; Tau reads the default login only." } };
    }
    const raw = env.GROK_AUTH?.trim() || await readText(join(home, "auth.json")) || "{}";
    const credentials = JSON.parse(raw) as Record<string, { key?: unknown; auth_mode?: unknown } | undefined>;
    const credential = CREDENTIAL_KEYS.map((key) => credentials[key]).find(Boolean);
    const token = credential?.auth_mode === "api_key" || typeof credential?.key !== "string" ? undefined : credential.key.trim();
    if (!token) return { unavailable: { reason: "signed-out", message: "Grok is not signed in." } };
    const response = await (options.fetch ?? globalThis.fetch)(BILLING_URL, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { unavailable: { reason: "failed", message: `xAI answered ${response.status}.` } };
    const windows = limitWindows(await response.json());
    return windows.length ? { windows } : { unavailable: { reason: "unsupported", message: "This Grok plan reports no limits." } };
  } catch {
    return { unavailable: { reason: "failed", message: "Grok's limits could not be read." } };
  }
}
