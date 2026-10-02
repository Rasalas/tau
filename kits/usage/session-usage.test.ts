import { describe, expect, it } from "vitest";
import { sessionUsageTurns } from "./session-usage.js";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 10, minute)).toISOString();
const ms = (minute: number) => Date.parse(at(minute));

function claudeLines(): string[] {
  const base = { sessionId: "s-1", cwd: "/work", isSidechain: false };
  const reply = (minute: number, id: string, model: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
    ({ ...base, ...extra, type: "assistant", requestId: `req-${id}`, timestamp: at(minute), message: { id, role: "assistant", model, content: [{ type: "text", text: "…" }], usage } });
  return [
    { ...base, type: "user", timestamp: at(0), message: { role: "user", content: "Do X" } },
    // One response in two content blocks: counted once, with the last line's figures.
    reply(1, "m1", "claude-haiku-4-5", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }),
    reply(1, "m1", "claude-haiku-4-5", { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }),
    { ...base, type: "user", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } },
    reply(2, "m2", "claude-haiku-4-5", { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 }),
    reply(2, "m3", "claude-sub-1", { input_tokens: 1, output_tokens: 1 }, { isSidechain: true }),
    reply(2, "m4", "<synthetic>", { input_tokens: 9, output_tokens: 9 }),
    { ...base, type: "user", timestamp: at(3), message: { role: "user", content: "Then Y" } },
    reply(4, "m5", "claude-sonnet-4-6", { input_tokens: 3, output_tokens: 4 }),
  ].map((line) => JSON.stringify(line));
}

function codexLines(): string[] {
  const line = (minute: number, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: at(minute), type, payload });
  const count = (minute: number, total: Record<string, number>, last: Record<string, number>) => line(minute, "event_msg", { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: 200_000 } });
  return [
    line(0, "session_meta", { id: "c-1", cwd: "/work" }),
    line(0, "event_msg", { type: "user_message", message: "Do X" }),
    line(0, "turn_context", { cwd: "/work", model: "gpt-test" }),
    count(2, { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 100, total_tokens: 1_100 }, { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 100, total_tokens: 1_100 }),
    // The CLI repeats a counter; the repeat counts nothing.
    count(2, { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 100, total_tokens: 1_100 }, { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 100, total_tokens: 1_100 }),
    line(3, "event_msg", { type: "user_message", message: "Then Y" }),
    line(3, "turn_context", { cwd: "/work", model: "gpt-other" }),
    count(4, { input_tokens: 3_000, cached_input_tokens: 1_400, output_tokens: 300, total_tokens: 3_300 }, { input_tokens: 2_000, cached_input_tokens: 1_000, output_tokens: 200, total_tokens: 2_200 }),
  ];
}

describe("a CLI session's usage for its imported thread", () => {
  it("sums an Agent SDK session per prompt and model, a prompt counted once, and names the login's billing", () => {
    expect(sessionUsageTurns("agent-sdk", claudeLines(), { sessionId: "s-1", prompts: [ms(0), ms(3)], billing: "subscription" })).toEqual([
      { provider: "anthropic", model: "claude-haiku-4-5", billing: "subscription", inputTokens: 15, outputTokens: 27, cacheReadTokens: 300, cacheWriteTokens: 50, totalTokens: 392, costUsd: 0, turns: 1, at: ms(2) },
      { provider: "anthropic", model: "claude-sub-1", billing: "subscription", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 0, turns: 0, at: ms(2) },
      { provider: "anthropic", model: "claude-sonnet-4-6", billing: "subscription", inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7, costUsd: 0, turns: 1, at: ms(4) },
    ]);
  });

  it("steps a Codex rollout's running counters, the cached part of input apart", () => {
    expect(sessionUsageTurns("codex", codexLines(), { sessionId: "c-1", prompts: [ms(0), ms(3)] })).toEqual([
      { provider: "openai", model: "gpt-test", inputTokens: 600, outputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 0, totalTokens: 1_100, costUsd: 0, turns: 1, at: ms(2) },
      { provider: "openai", model: "gpt-other", inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 1_000, cacheWriteTokens: 0, totalTokens: 2_200, costUsd: 0, turns: 1, at: ms(4) },
    ]);
  });

  it("gives responses before the first prompt to it, and a log without usage nothing", () => {
    expect(sessionUsageTurns("agent-sdk", claudeLines(), { sessionId: "s-1", prompts: [ms(3)] }).map((turn) => [turn.model, turn.turns])).toEqual([
      ["claude-haiku-4-5", 1], ["claude-sub-1", 0], ["claude-sonnet-4-6", 0],
    ]);
    expect(sessionUsageTurns("codex", codexLines().slice(0, 3), { sessionId: "c-1", prompts: [ms(0)] })).toEqual([]);
  });

  it("folds the oldest turns past the ones a thread keeps", () => {
    const prompts = Array.from({ length: 2_001 }, (_, index) => Date.UTC(2026, 8, 20) + index * 60_000);
    const lines = prompts.map((prompt, index) => JSON.stringify({ type: "assistant", sessionId: "s-1", cwd: "/work", requestId: `r${index}`, timestamp: new Date(prompt + 1_000).toISOString(), message: { id: `m${index}`, model: "claude-haiku-4-5", usage: { input_tokens: 1, output_tokens: 1 } } }));
    const turns = sessionUsageTurns("agent-sdk", lines, { sessionId: "s-1", prompts });
    expect(turns).toHaveLength(2_000);
    expect(turns[0]).toMatchObject({ inputTokens: 2, turns: 2 });
    expect(turns.reduce((sum, turn) => sum + turn.totalTokens, 0)).toBe(4_002);
  });
});
