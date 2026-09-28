import { PI_BACKEND, type UsageEntry, type UsageLimitAccount } from "./protocol.js";

/** What the page calls a shared account's provider. */
const PROVIDER_NAMES: Record<string, string> = { openai: "ChatGPT", anthropic: "Anthropic" };

/** One account as the page draws it: every runtime signed in to it, its limits once. */
export interface LimitGroup {
  key: string;
  label: string;
  /** Whose windows are drawn: the freshest read that has any. */
  shown: UsageLimitAccount;
  members: UsageLimitAccount[];
}

/** A runtime's name within a shared account: Pi's accounts are named per provider; another machine's say where. */
export function memberName(account: UsageLimitAccount): string {
  if (account.runtime !== PI_BACKEND) return account.label;
  const where = account.machine ? / on (.+)$/u.exec(account.label)?.[1] : undefined;
  return where ? `Pi on ${where}` : "Pi";
}

/** Accounts with the same identity become one; one without an identity stays on its own. */
export function groupAccounts(accounts: readonly UsageLimitAccount[]): LimitGroup[] {
  const groups = new Map<string, UsageLimitAccount[]>();
  for (const account of accounts) {
    const key = account.identity ? `${account.identity.provider}:${account.identity.key}` : `${account.machine ?? ""}\u0000${account.runtime}\u0000${account.id}`;
    groups.set(key, [...(groups.get(key) ?? []), account]);
  }
  return [...groups].map(([key, members]): LimitGroup => {
    // The runtime of its own first, Pi (one provider among many) after it.
    members.sort((left, right) => Number(left.runtime === PI_BACKEND) - Number(right.runtime === PI_BACKEND));
    const only = members[0]!;
    if (members.length === 1) return { key, label: only.label, shown: only, members };
    const reporting = members.filter((member) => member.windows.length > 0);
    const shown = [...(reporting.length > 0 ? reporting : members)].sort((left, right) => right.checkedAt - left.checkedAt)[0]!;
    const plan = shown.plan ?? members.find((member) => member.plan)?.plan;
    const provider = only.identity?.provider ?? "";
    return {
      key,
      label: `${PROVIDER_NAMES[provider] ?? provider} · ${members.map(memberName).join(", ")}`,
      shown: { ...shown, ...(plan ? { plan } : {}) },
      members,
    };
  });
}

/** The runtime an account's usage is recorded under: every Codex instance counts as `codex`. */
function family(runtime: string): string {
  return runtime.split("@")[0]!;
}

function matches(account: UsageLimitAccount, entry: UsageEntry): boolean {
  if ((account.machine ?? "") !== (entry.machine ?? "")) return false;
  if (account.runtime === PI_BACKEND) return entry.backend === PI_BACKEND && account.id === `pi:${entry.provider ?? ""}`;
  return entry.backend === family(account.runtime);
}

export interface MemberCost {
  name: string;
  costUsd: number;
  apiValueUsd: number;
}

/**
 * What each runtime of a shared account used from `fromDay` on. Undefined
 * when usage cannot be told apart by account: two instances of one runtime
 * record theirs under one name.
 */
export function memberCosts(group: LimitGroup, accounts: readonly UsageLimitAccount[], entries: readonly UsageEntry[], fromDay: number): MemberCost[] | undefined {
  const ambiguous = group.members.some((member) => member.runtime !== PI_BACKEND
    && accounts.some((other) => other !== member && other.runtime !== PI_BACKEND && (other.machine ?? "") === (member.machine ?? "") && family(other.runtime) === family(member.runtime)));
  if (ambiguous) return undefined;
  return group.members.map((member) => {
    const cost: MemberCost = { name: memberName(member), costUsd: 0, apiValueUsd: 0 };
    for (const entry of entries) {
      if (entry.day < fromDay || !matches(member, entry)) continue;
      cost.costUsd += entry.costUsd;
      cost.apiValueUsd += entry.apiValueUsd;
    }
    return cost;
  });
}
