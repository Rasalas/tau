import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LimitAccount } from "./limits.js";

const BASE = "https://api.anthropic.com";
const ID = /^[a-z0-9_-]{1,40}$/u;
export class ResetFailure extends Error {
  constructor(message: string, readonly settled = false) { super(message); }
}
/** Maps the CLI's cedar_ember grants. Only the provider-selected live grant is redeemable. */
export function claudeResetCredits(block: unknown, now = Date.now()): LimitAccount["resetCredits"] {
  if (!block || typeof block !== "object") return undefined;
  const raw = block as { eligible?: unknown; grants?: unknown; next_grant_id?: unknown };
  if (raw.eligible !== true || !Array.isArray(raw.grants)) return undefined;
  const live = raw.grants.filter((item): item is { id: string; resets_left: number; ends_at?: string | null } => {
    if (!item || typeof item !== "object") return false;
    const grant = item as Record<string, unknown>;
    if (typeof grant.id !== "string" || !ID.test(grant.id) || !Number.isSafeInteger(grant.resets_left) || Number(grant.resets_left) <= 0 || grant.paused || grant.usable_now !== true) return false;
    if (grant.ends_at == null) return true;
    if (typeof grant.ends_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(grant.ends_at)) return false;
    const [year, month, day] = grant.ends_at.slice(0, 10).split("-").map(Number);
    return Date.parse(grant.ends_at) > now && month! >= 1 && month! <= 12 && day! >= 1 && day! <= new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  });
  const next = live.find((grant) => grant.id === raw.next_grant_id);
  return { availableCount: next ? live.reduce((sum, grant) => sum + grant.resets_left, 0) : 0, ...(next ? { nextCreditId: next.id, ...(next.ends_at ? { nextExpiresAt: Date.parse(next.ends_at) } : {}) } : {}) };
}

export interface ResetAccess { configDir: string; accountFile: string; version: string; platform?: string; fetch?: typeof fetch }
async function token(input: ResetAccess): Promise<string> {
  if ((input.platform ?? process.platform) === "darwin") throw new ResetFailure("Claude resets are unavailable on macOS because its login is in Keychain.", true);
  try {
    const credentials = JSON.parse(await readFile(join(input.configDir, ".credentials.json"), "utf8"));
    const value = credentials.claudeAiOauth?.accessToken;
    if (typeof value === "string" && value.trim()) return value.trim();
  } catch { throw new ResetFailure("Claude could not read its login. Sign in again.", true); }
  throw new ResetFailure("Sign in to Claude again to redeem resets.", true);
}
function headers(accessToken: string, version: string) { return { authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20", "user-agent": `claude-cli/${version} (external, cli)` }; }
export function resetAccess(configDir: string, env: NodeJS.ProcessEnv, version: string): ResetAccess {
  return { configDir, accountFile: env.CLAUDE_CONFIG_DIR?.trim() ? join(configDir, ".claude.json") : join(env.HOME?.trim() || homedir(), ".claude.json"), version };
}
export async function readClaudeResetCredits(input: ResetAccess): Promise<LimitAccount["resetCredits"]> {
  try {
    const accessToken = await token(input);
    const response = await (input.fetch ?? fetch)(`${BASE}/api/oauth/usage?cedar_ember=1&skip_spend=1`, { headers: headers(accessToken, input.version), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { availableCount: 0, unavailable: response.status === 401 || response.status === 403 ? "Sign in to Claude again to read resets." : "Could not read Claude resets." };
    return claudeResetCredits((await response.json()).cedar_ember);
  } catch (error) { return { availableCount: 0, unavailable: error instanceof ResetFailure ? error.message : "Could not read Claude resets." }; }
}
export async function consumeClaudeResetCredit(input: ResetAccess, grant: string, requestId: string): Promise<string> {
  if (!ID.test(grant) || !/^[A-Za-z0-9_-]{1,64}$/u.test(requestId)) throw new ResetFailure("Claude returned an invalid reset credit.", true);
  const accessToken = await token(input);
  let organization: unknown;
  try { organization = JSON.parse(await readFile(input.accountFile, "utf8")).oauthAccount?.organizationUuid; }
  catch { throw new ResetFailure("Claude could not read its account.", true); }
  if (typeof organization !== "string" || !organization.trim()) throw new ResetFailure("Sign in to Claude again to redeem resets.", true);
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(`${BASE}/api/organizations/${encodeURIComponent(organization)}/reset_rate_limits`, { method: "POST", headers: { ...headers(accessToken, input.version), "content-type": "application/json" }, body: JSON.stringify({ program: "cedar_ember", grant_id: grant, request_id: requestId }), signal: AbortSignal.timeout(25_000) });
  } catch { throw new ResetFailure("Claude could not confirm the reset. Retry to check the same request."); }
  if (response.status === 429) throw new ResetFailure("Claude is rate limiting resets. Try again soon.", true);
  if (response.status === 401 || response.status === 403) throw new ResetFailure("Sign in to Claude again to redeem resets.", true);
  if (!response.ok) throw new ResetFailure("Claude could not confirm the reset. Retry to check the same request.");
  let result: unknown;
  try { result = (await response.json()).result; } catch { throw new ResetFailure("Claude could not confirm the reset. Retry to check the same request."); }
  if (result === "cooldown") throw new ResetFailure("Claude resets are cooling down. Try again later.", true);
  const outcomes: Record<string, string> = { reset: "reset", not_limited: "nothingToReset", already_used: "alreadyRedeemed", ineligible: "noCredit" };
  if (typeof result !== "string" || !outcomes[result]) throw new ResetFailure("Claude could not confirm the reset. Retry to check the same request.");
  return outcomes[result]!;
}
