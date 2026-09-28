import { describe, expect, it } from "vitest";
import { modelProvider } from "./model-provider.js";

describe("modelProvider", () => {
  it.each([
    // Cursor's ids and names
    [{ id: "sonnet-4.5", name: "Sonnet 4.5" }, "anthropic"],
    [{ id: "opus-4.1", name: "Opus 4.1" }, "anthropic"],
    [{ id: "claude-4.5-sonnet-thinking" }, "anthropic"],
    [{ id: "gpt-5.4", name: "GPT-5.4" }, "openai"],
    [{ id: "gpt-5-codex" }, "openai"],
    [{ id: "o3", name: "o3" }, "openai"],
    [{ id: "gemini-3-pro" }, "google"],
    [{ id: "grok-code-fast-1" }, "xai"],
    [{ id: "deepseek-v3.1" }, "deepseek"],
    [{ id: "kimi-k2" }, "moonshotai"],
    [{ id: "glm-4.6" }, "zai"],
    [{ id: "default", name: "Auto" }, "cursor"],
    [{ id: "composer-2", name: "Composer 2" }, "cursor"],
    // Antigravity's
    [{ id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" }, "google"],
    [{ id: "claude-sonnet-4-5-thinking", name: "Claude Sonnet 4.5 (Thinking)" }, "anthropic"],
    [{ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" }, "openai"],
  ])("%o is %s's", (model, provider) => {
    expect(modelProvider(model, "cursor")).toBe(provider);
  });

  it("reads the name where the id says nothing", () => {
    expect(modelProvider({ id: "m-7", name: "Claude Haiku 4.5" }, "google")).toBe("anthropic");
    expect(modelProvider({ id: "m-7", name: "Medium" }, "google")).toBe("google");
  });

  it("takes the id before the name", () => {
    expect(modelProvider({ id: "gpt-5", name: "Better than Claude" }, "cursor")).toBe("openai");
  });

  it("matches whole words only", () => {
    expect(modelProvider({ id: "octopus-2", name: "Dragonopus" }, "cursor")).toBe("cursor");
    expect(modelProvider({ id: "o10k", name: "Pro" }, "cursor")).toBe("cursor");
  });
});
