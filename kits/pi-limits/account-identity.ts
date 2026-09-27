import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Who a login is, so the Usage kit can show one account once when two
 * runtimes use it. Only a hash of the provider's account id leaves this file;
 * the id and the tokens it was read from stay here.
 */
export interface AccountIdentity {
  provider: string;
  key: string;
}

/** The recipe every kit shares (`kits/usage/protocol.ts`); a different one never matches. */
export function accountIdentity(provider: string, accountId: string): AccountIdentity {
  return { provider, key: createHash("sha256").update(`tau.account\n${provider}\n${accountId}`).digest("hex") };
}

const AUTH_CLAIM = "https://api.openai.com/auth";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function authClaims(token: unknown): Record<string, unknown> | undefined {
  const payload = typeof token === "string" ? token.split(".")[1] : undefined;
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown> | null;
    const auth = claims?.[AUTH_CLAIM];
    return auth && typeof auth === "object" ? auth as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A ChatGPT login: the account (a workspace on a team plan) and, where the
 * token names one, the user in it, so two seats of one workspace stay apart.
 */
export function chatgptIdentity(tokens: { accessToken?: unknown; idToken?: unknown; accountId?: unknown }): AccountIdentity | undefined {
  const auth = authClaims(tokens.accessToken) ?? authClaims(tokens.idToken);
  const account = text(auth?.chatgpt_account_id) ?? text(tokens.accountId);
  if (!account) return undefined;
  const user = text(auth?.chatgpt_user_id) ?? text(auth?.user_id);
  return accountIdentity("openai", user ? `${account}:${user}` : account);
}

/** Anthropic's plan login: its organization, as each answer's `anthropic-organization-id` header names it. */
export function anthropicIdentity(headers: Record<string, string>): AccountIdentity | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "anthropic-organization-id");
  const organization = text(entry?.[1]);
  return organization && organization.length <= 200 ? accountIdentity("anthropic", `org:${organization}`) : undefined;
}

/** The ChatGPT login Pi keeps for `provider` in `<agentDir>/auth.json`; none for a key or no login. */
export async function readPiChatgptIdentity(agentDir: string, provider: string): Promise<AccountIdentity | undefined> {
  let stored: Record<string, { type?: unknown; access?: unknown; accountId?: unknown } | null> | null;
  try {
    stored = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as typeof stored;
  } catch {
    return undefined;
  }
  const credential = stored?.[provider];
  if (!credential || credential.type !== "oauth") return undefined;
  return chatgptIdentity({ accessToken: credential.access, accountId: credential.accountId });
}
