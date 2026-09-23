import { describe, expect, it } from "vitest";
import { isSmallModel, smallCompletionModel } from "./small-completion-model.js";

describe("the small model for a kit's small job", () => {
  const catalog = [
    { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" },
    // Listed first, but a ChatGPT login cannot reach it; the preferred model's generation wins.
    { provider: "openai-codex", id: "gpt-5.4-mini", name: "5.4 mini" },
    { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" },
    { provider: "anthropic", id: "claude-opus-4-1", name: "Opus" },
    { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku" },
  ];
  const services = { completionModels: async () => catalog };

  it("keeps a small preferred model, swaps a large one for the closest small one, else takes any small one", async () => {
    await expect(smallCompletionModel(services, { provider: "anthropic", id: "claude-haiku-4-5" })).resolves.toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
    await expect(smallCompletionModel(services, { provider: "anthropic", id: "claude-opus-4-1" })).resolves.toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
    await expect(smallCompletionModel(services, { provider: "openai-codex", id: "gpt-5.6-sol" })).resolves.toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
    // Another runtime names its model under another provider; the id still finds Pi's twin.
    await expect(smallCompletionModel(services, { provider: "openai", id: "gpt-5.6-sol" })).resolves.toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
    await expect(smallCompletionModel(services, { provider: "google", id: "gemini-2.5-pro" })).resolves.toEqual({ provider: "openai-codex", id: "gpt-5.4-mini" });
    await expect(smallCompletionModel(services, undefined)).resolves.toEqual({ provider: "openai-codex", id: "gpt-5.4-mini" });
  });

  it("leaves the default to the host when nothing small is reachable", async () => {
    await expect(smallCompletionModel({ completionModels: async () => [catalog[0]!] }, { provider: "openai-codex", id: "gpt-5.6-sol" })).resolves.toBeUndefined();
    await expect(smallCompletionModel({ completionModels: async () => { throw new Error("no catalog"); } }, undefined)).resolves.toBeUndefined();
    // A host before API 1.11.0 has no catalog to read.
    await expect(smallCompletionModel({}, undefined)).resolves.toBeUndefined();
  });

  it("knows the small tiers by their ids", () => {
    for (const id of ["claude-haiku-4-5-20251001", "gpt-5-mini", "gpt-4.1-nano", "gemini-2.5-flash", "gemini-2.0-flash-lite", "gpt-5.6-luna", "deepseek-flash", "mistral-small-latest"]) {
      expect(isSmallModel(id), id).toBe(true);
    }
    for (const id of ["claude-opus-4-1", "claude-sonnet-4-5", "gpt-5.6-sol", "gpt-5.6-terra", "gemini-2.5-pro", "minimax-m2", "o3"]) {
      expect(isSmallModel(id), id).toBe(false);
    }
  });
});
