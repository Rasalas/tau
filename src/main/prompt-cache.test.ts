import { describe, expect, it } from "vitest";
import { lastReplyAt, piPromptCacheTtlMs } from "./prompt-cache.js";

describe("Pi's prompt cache", () => {
  it("names the cache of a Claude model only, five minutes unless Pi keeps it for an hour", () => {
    const claude = { api: "anthropic-messages", id: "claude-haiku-4-5-20251001" };
    expect(piPromptCacheTtlMs(claude, {})).toBe(5 * 60_000);
    expect(piPromptCacheTtlMs(claude, { PI_CACHE_RETENTION: "long" })).toBe(60 * 60_000);
    expect(piPromptCacheTtlMs({ api: "bedrock-converse-stream", id: "us.anthropic.claude-sonnet-4-5" }, {})).toBe(5 * 60_000);
    expect(piPromptCacheTtlMs({ api: "openai-responses", id: "gpt-5.6-luna" }, {})).toBeUndefined();
    expect(piPromptCacheTtlMs({ api: "anthropic-messages", id: "kimi-k2" }, {})).toBeUndefined();
    expect(piPromptCacheTtlMs(undefined, {})).toBeUndefined();
  });

  it("dates the context by the last reply", () => {
    expect(lastReplyAt([{ role: "user", timestamp: 1 }, { role: "assistant", timestamp: 2 }, { role: "toolResult", timestamp: 3 }])).toBe(2);
    expect(lastReplyAt([{ role: "user", timestamp: 1 }])).toBeUndefined();
  });
});
