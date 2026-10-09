import { describe, expect, it } from "vitest";
import { isSmallModel, reachableCompletionModels, sameVendor, smallCompletionModel } from "./small-completion-model.js";

describe("the small model for a kit's small job", () => {
  it("uses the newest reachable small model of the same vendor, regardless of the thread's generation or catalog order", async () => {
    const models = { completionModels: async () => [
      { provider: "anthropic", id: "claude-haiku-4-5-20251001", name: "Old Haiku" },
      { provider: "anthropic", id: "claude-haiku-5-5", name: "Haiku" },
      { provider: "openai-codex", id: "gpt-5.6-luna", name: "Old Luna" },
      { provider: "openai-codex", id: "gpt-6-luna", name: "Luna" },
    ] };
    await expect(smallCompletionModel(models, { provider: "anthropic", id: "claude-opus-4-5" })).resolves.toEqual({ provider: "anthropic", id: "claude-haiku-5-5" });
    await expect(smallCompletionModel(models, { provider: "openai", id: "gpt-5.6-sol" })).resolves.toEqual({ provider: "openai-codex", id: "gpt-6-luna" });
  });
  const catalog = [
    { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" },
    // Listed first; the preferred model's generation wins. What a login reaches is the host's filter (below).
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

  it("takes the same vendor's offer over a namesake another login sells", async () => {
    const both = { completionModels: async () => [
      { provider: "opencode-go", id: "gpt-5.6-luna", name: "Luna", billing: "api-key" as const },
      { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna", login: "subscription" as const },
    ] };
    await expect(smallCompletionModel(both, { provider: "openai", id: "gpt-5.6-luna" })).resolves.toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
  });

  it("falls back to the thread's own model where complete runs it when asked to, else to the default", async () => {
    const large = { completionModels: async () => [catalog[0]!, catalog[3]!] };
    const own = { elsePrefer: true };
    await expect(smallCompletionModel(large, { provider: "openai-codex", id: "gpt-5.6-sol" }, own)).resolves.toEqual({ provider: "openai-codex", id: "gpt-5.6-sol" });
    // A Codex thread names the model under `openai`; Pi runs it as `openai-codex`.
    await expect(smallCompletionModel(large, { provider: "openai", id: "gpt-5.6-sol" }, own)).resolves.toEqual({ provider: "openai-codex", id: "gpt-5.6-sol" });
    // Another vendor's model of the same id is not the thread's.
    await expect(smallCompletionModel(large, { provider: "cursor", id: "gpt-5.6-sol" }, own)).resolves.toBeUndefined();
    await expect(smallCompletionModel(large, { provider: "openai-codex", id: "gpt-5.6-sol" })).resolves.toBeUndefined();
  });

  it("leaves the default to the host when nothing small is reachable", async () => {
    await expect(smallCompletionModel({ completionModels: async () => [catalog[0]!] }, { provider: "anthropic", id: "claude-opus-4-1" })).resolves.toBeUndefined();
    await expect(smallCompletionModel({ completionModels: async () => { throw new Error("no catalog"); } }, undefined)).resolves.toBeUndefined();
    // A host before API 1.11.0 has no catalog to read.
    await expect(smallCompletionModel({}, undefined)).resolves.toBeUndefined();
  });

  it("knows one vendor under the name of its subscription route", () => {
    expect(sameVendor("openai-codex", "openai")).toBe(true);
    expect(sameVendor("openai", "openai-codex")).toBe(true);
    expect(sameVendor("anthropic", "anthropic")).toBe(true);
    expect(sameVendor("openai-codex", "cursor")).toBe(false);
    expect(sameVendor("openai", "openaiplus")).toBe(false);
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

describe("the offers complete can reach", () => {
  // Pi's catalog: a ChatGPT login lists what Pi knows of `openai-codex`, an API key everything OpenAI sells.
  const pi = [
    { provider: "openai-codex", id: "gpt-5.4-mini", name: "5.4 mini", login: "subscription" as const },
    { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna", login: "subscription" as const },
    { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol", login: "subscription" as const },
    { provider: "openai", id: "gpt-5.4-mini", name: "5.4 mini", billing: "api-key" as const },
    { provider: "anthropic", id: "claude-haiku-4-5-20251001", name: "Haiku", login: "subscription" as const },
    { provider: "github-copilot", id: "gpt-5.4-mini", name: "5.4 mini", login: "subscription" as const },
  ];
  // What the runtimes' own logins name: Codex's `model/list` over ChatGPT, the Agent SDK's aliases.
  const codex = { models: [
    { provider: "openai", id: "gpt-5.6-sol", name: "Sol", billing: "subscription" as const },
    { provider: "openai", id: "gpt-5.6-luna", name: "Luna", billing: "subscription" as const },
  ] };
  const agentSdk = { models: [{ provider: "anthropic", id: "haiku", name: "Haiku 4.5", billing: "subscription" as const, apiModelId: "claude-haiku-4-5" }] };
  const ids = (models: readonly { provider: string; id: string }[]) => models.map((model) => `${model.provider}/${model.id}`);

  it("drops a subscription offer its vendor's own login does not name, and keeps API keys and unreported vendors", () => {
    expect(ids(reachableCompletionModels(pi, [codex, agentSdk]))).toEqual([
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-sol",
      "openai/gpt-5.4-mini",
      "anthropic/claude-haiku-4-5-20251001",
      "github-copilot/gpt-5.4-mini",
    ]);
  });

  it("keeps Pi's list where no runtime reports the vendor's subscription", () => {
    expect(reachableCompletionModels(pi, [])).toEqual(pi);
    // An API-key catalog says nothing about what a subscription serves.
    expect(reachableCompletionModels(pi, [{ models: [{ provider: "openai", id: "gpt-5.6-sol", name: "Sol", billing: "api-key" }] }])).toEqual(pi);
  });

  it("gives a thread whose runtime has no small model a small one its login reaches", async () => {
    const services = { completionModels: async () => reachableCompletionModels(pi.slice(0, 3), [codex]) };
    // A Cursor thread on GPT-5.4 shared the longest id with the mini its ChatGPT login cannot reach.
    await expect(smallCompletionModel(services, { provider: "cursor", id: "gpt-5.4" })).resolves.toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
    await expect(smallCompletionModel(services, { provider: "xai", id: "grok-4.6" })).resolves.toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
    await expect(smallCompletionModel(services, { provider: "openai", id: "gpt-5.5" })).resolves.toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
  });
});
