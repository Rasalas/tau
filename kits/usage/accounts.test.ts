import { describe, expect, it } from "vitest";
import { groupAccounts, memberCosts } from "./accounts.js";
import type { UsageEntry, UsageLimitAccount } from "./protocol.js";

const CHATGPT = { provider: "openai", key: "a".repeat(64) };
const OTHER = { provider: "openai", key: "b".repeat(64) };

function account(overrides: Partial<UsageLimitAccount>): UsageLimitAccount {
  return { id: "codex:account", runtime: "codex", label: "Codex", checkedAt: 1_000, windows: [], ...overrides };
}

const codex = account({ plan: "pro", identity: CHATGPT, checkedAt: 1_000, windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 30 }] });
const pi = account({ id: "pi:openai-codex", runtime: "pi", label: "Pi · openai-codex", identity: CHATGPT, checkedAt: 2_000, windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 32 }] });

function entry(overrides: Partial<UsageEntry>): UsageEntry {
  return {
    day: 10, backend: "codex", threadId: "t", cwd: "/w", model: "gpt-5.6-luna", requests: 1,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10, costUsd: 0, apiValueUsd: 1,
    ...overrides,
  };
}

describe("Usage accounts", () => {
  it("draws runtimes signed in to one account as one, with the fresher read's limits and a plan either named", () => {
    const [group, ...rest] = groupAccounts([pi, codex, account({ id: "grok:account", runtime: "grok", label: "Grok" })]);
    expect(group).toMatchObject({ label: "ChatGPT · Codex, Pi", shown: { id: "pi:openai-codex", plan: "pro" } });
    expect(group!.members).toEqual([codex, pi]);
    expect(rest.map((other) => other.label)).toEqual(["Grok"]);
  });

  it("keeps different accounts apart and an account without an identity as it was", () => {
    const groups = groupAccounts([codex, { ...pi, identity: OTHER }, account({ id: "claude-code:account", runtime: "claude-code", label: "Claude Code" })]);
    expect(groups.map((group) => [group.label, group.shown.id])).toEqual([["Codex", "codex:account"], ["Pi · openai-codex", "pi:openai-codex"], ["Claude Code", "claude-code:account"]]);
  });

  it("prefers a read that has windows over a fresher one without", () => {
    const [group] = groupAccounts([codex, { ...pi, windows: [], unavailable: { reason: "failed", message: "No answer." } }]);
    expect(group!.shown.id).toBe("codex:account");
  });

  it("sums a shared account's costs by runtime from a day on, billed and plan value apart", () => {
    const [group] = groupAccounts([codex, pi]);
    const entries = [
      entry({ apiValueUsd: 2 }),
      entry({ day: 2, apiValueUsd: 50 }),
      entry({ backend: "pi", provider: "openai-codex", apiValueUsd: 0.5, costUsd: 0.25 }),
      entry({ backend: "pi", provider: "anthropic", apiValueUsd: 9 }),
    ];
    expect(memberCosts(group!, [codex, pi], entries, 5)).toEqual([
      { name: "Codex", costUsd: 0, apiValueUsd: 2 },
      { name: "Pi", costUsd: 0.25, apiValueUsd: 0.5 },
    ]);
  });

  it("gives no costs when two instances of a runtime record their usage under one name", () => {
    const work = account({ id: "codex@work:account", runtime: "codex@work", label: "Codex · Work" });
    const [group] = groupAccounts([codex, pi, work]);
    expect(memberCosts(group!, [codex, pi, work], [entry({})], 0)).toBeUndefined();
  });

  it("joins one account across machines, keeps same-named accounts of two machines apart, and splits costs by machine", () => {
    const rexCodex = account({ ...codex, machine: "rex-id", label: "Codex on rex", checkedAt: 3_000 });
    const rexGrok = account({ id: "grok:account", runtime: "grok", label: "Grok on rex", machine: "rex-id" });
    const groups = groupAccounts([codex, rexCodex, account({ id: "grok:account", runtime: "grok", label: "Grok" }), rexGrok]);
    expect(groups.map((group) => group.label)).toEqual(["ChatGPT · Codex, Codex on rex", "Grok", "Grok on rex"]);
    expect(groups[0]!.shown.machine).toBe("rex-id");
    const costs = memberCosts(groups[0]!, [codex, rexCodex], [entry({}), entry({ machine: "rex-id", apiValueUsd: 3 })], 0);
    expect(costs).toEqual([{ name: "Codex", costUsd: 0, apiValueUsd: 1 }, { name: "Codex on rex", costUsd: 0, apiValueUsd: 3 }]);
  });
});
