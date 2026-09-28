import { describe, expect, it } from "vitest";
import { modelOnPlan, providerMarks, threadOnPlan } from "./runtime-marks";

describe("providerMarks", () => {
  it.each([
    // A runtime with its home provider: its own mark, the provider named in the tooltip.
    ["codex", "openai", false, { runtime: "codex", home: "openai" }],
    ["claude-code", "anthropic", false, { runtime: "claude-code", home: "anthropic" }],
    ["grok", "xai", false, { runtime: "grok", home: "xai" }],
    ["antigravity", "google", false, { runtime: "antigravity", home: "google" }],
    ["opencode", "opencode-go", false, { runtime: "opencode", home: "opencode-go" }],
    ["OpenCode", "opencode", false, { runtime: "OpenCode", home: "opencode" }],
    ["cursor", "cursor", false, { runtime: "cursor", home: "cursor" }],
    ["codex", "openai", true, { runtime: "codex", home: "openai" }],
    // A runtime with a foreign provider: both.
    ["antigravity", "anthropic", false, { model: "anthropic", runtime: "antigravity" }],
    ["opencode", "anthropic", false, { model: "anthropic", runtime: "opencode" }],
    ["cursor", "openai", false, { model: "openai", runtime: "cursor" }],
    // Pi shows its mark beside every provider, a plan's included.
    ["pi", "openai", false, { model: "openai", runtime: "pi" }],
    ["pi", "anthropic", false, { model: "anthropic", runtime: "pi" }],
    ["pi", "openrouter", false, { model: "openrouter", runtime: "pi" }],
    ["pi", "openai-codex", false, { model: "openai-codex", runtime: "pi", plan: true }],
    ["pi", "anthropic", true, { model: "anthropic", runtime: "pi", plan: true }],
  ] as const)("%s with %s (plan: %s)", (runtime, provider, plan, expected) => {
    expect(providerMarks(provider, runtime, { plan })).toEqual(expected);
  });

  it("shows the model alone where no runtime is named", () => {
    expect(providerMarks("anthropic", undefined)).toEqual({ model: "anthropic" });
    expect(providerMarks("openai-codex", undefined)).toEqual({ model: "openai-codex", plan: true });
  });

  it("lets a runtime stand alone when there is no model, Pi included", () => {
    expect(providerMarks(undefined, "claude-code")).toEqual({ runtime: "claude-code" });
    expect(providerMarks(undefined, "pi")).toEqual({ runtime: "pi" });
    expect(providerMarks(undefined, undefined)).toEqual({});
  });

  it("treats an instance like its program", () => {
    expect(providerMarks("openai", "codex@work")).toEqual({ runtime: "codex@work", home: "openai" });
    expect(providerMarks("anthropic", "opencode@second")).toEqual({ model: "anthropic", runtime: "opencode@second" });
  });
});

describe("plans", () => {
  it("reads a model's login or billing", () => {
    expect(modelOnPlan({ login: "subscription" })).toBe(true);
    expect(modelOnPlan({ billing: "subscription" })).toBe(true);
    expect(modelOnPlan({ billing: "api-key" })).toBe(false);
  });

  it("calls a thread on a plan when the plan paid for most of its tokens", () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 100, costUsd: 0, turns: 2 };
    const plan = (totalTokens: number) => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens, turns: 1, apiValueUsd: 0 });
    expect(threadOnPlan(undefined)).toBe(false);
    expect(threadOnPlan(usage)).toBe(false);
    expect(threadOnPlan({ ...usage, subscription: plan(100) })).toBe(true);
    expect(threadOnPlan({ ...usage, subscription: plan(20) })).toBe(false);
  });
});
