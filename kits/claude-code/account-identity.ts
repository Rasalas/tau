import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_HOME_VARIABLE } from "./protocol.js";

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

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Plans whose organization many people share; there the user decides, not the organization. */
const SHARED_PLAN = /team|enterprise/iu;

/**
 * The plan login the CLI keeps in its global config (`oauthAccount`): in its
 * config directory, else in `HOME` — both from `env`, so a test without them
 * reads nothing. A personal plan is its organization, which is what Pi's
 * answers name too; a shared one adds the user.
 */
export async function readAgentSdkIdentity(env: NodeJS.ProcessEnv, plan: string | undefined, configVariable = CLAUDE_HOME_VARIABLE): Promise<AccountIdentity | undefined> {
  const directory = text(env[configVariable]) ?? text(env.HOME);
  if (!directory) return undefined;
  let config: { oauthAccount?: { organizationUuid?: unknown; accountUuid?: unknown } | null } | null;
  try {
    config = JSON.parse(await readFile(join(directory, ".claude.json"), "utf8")) as typeof config;
  } catch {
    return undefined;
  }
  const organization = text(config?.oauthAccount?.organizationUuid);
  if (!organization) return undefined;
  if (plan && !SHARED_PLAN.test(plan)) return accountIdentity("anthropic", `org:${organization}`);
  const user = text(config?.oauthAccount?.accountUuid);
  return user ? accountIdentity("anthropic", `org:${organization}:user:${user}`) : undefined;
}
