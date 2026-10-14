import { describe, expect, it } from "vitest";
import type { UiSession, UiThreadUsage } from "tau";
import { apiValue, threadCostSummary } from "./thread-cost.js";

const usage = (costUsd: number): UiThreadUsage => ({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 5, totalTokens: 117, costUsd, turns: 1 });
const thread = (id: string, parentThreadId?: string, modelProvider = "openai", spent = usage(2)): UiSession => ({ id, parentThreadId, modelProvider, usage: spent, path: id, title: id, modifiedAt: 1, projectPath: "/repo", projectName: "repo", messageCount: 1 });

describe("thread costs with delegated work", () => {
  it("adds children and grandchildren once, using live parent usage and both lineage sources", () => {
    const threads = [thread("parent", undefined, "anthropic", usage(999)), thread("child", "parent"), thread("grandchild"), thread("unrelated")];
    const plan = { ...usage(0), subscription: { ...usage(0), apiValueUsd: 15 } };
    const result = threadCostSummary("parent", plan, "anthropic", threads, { grandchild: "child" });
    expect(result.subagents).toBe(2);
    expect(result.usage).toMatchObject({ costUsd: 4, totalTokens: 351, turns: 3, subscription: { apiValueUsd: 15, totalTokens: 117, turns: 1 } });
    expect(apiValue(result.usage)).toBe(19);
    expect(result.providers.map((item) => [item.provider, apiValue(item.usage)])).toEqual([["anthropic", 15], ["openai", 4]]);
    expect(plan.totalTokens).toBe(117);
  });

  it("does not double count duplicated shells or follow cycles back into the parent", () => {
    const child = thread("child", "parent");
    const result = threadCostSummary("parent", usage(1), "openai", [thread("parent", "child"), child, child], {});
    expect(result.subagents).toBe(1);
    expect(result.usage.costUsd).toBe(3);
  });

  it("can show a child's costs before the parent has any usage", () => {
    expect(threadCostSummary("parent", undefined, undefined, [thread("child", "parent")], {}).usage.costUsd).toBe(2);
  });
});
