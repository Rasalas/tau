import { describe, expect, it, vi } from "vitest";
import type { HostThread } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { branchNameFromSuggestion, buildNamingPrompt, createWorktreeNamesHostExtension, isSmallModel, smallNamingModel } from "./host.js";
import { WORKTREE_NAMES_HOST_EXTENSION_ID } from "./protocol.js";

describe("branch names from model answers", () => {
  it("keeps a clean answer and normalises a messy one", () => {
    expect(branchNameFromSuggestion("fix/steer-queue-messages")).toBe("fix/steer-queue-messages");
    expect(branchNameFromSuggestion("`Fix/Steer Queue Messages`.\nBecause…")).toBe("fix/steer-queue-messages");
    expect(branchNameFromSuggestion("  feat / worktree__naming!! ")).toBe("feat/worktree-naming");
    expect(branchNameFromSuggestion("feature.lock")).toBe("feature");
    expect(branchNameFromSuggestion("`\"'---")).toBe("");
  });

  it("steps past names the repository already has", () => {
    expect(branchNameFromSuggestion("fix/queue", ["Fix/Queue", "fix/queue-2"])).toBe("fix/queue-3");
  });

  it("puts the task, the user's start and the taken names into the prompt", () => {
    const prompt = buildNamingPrompt("Steer queued messages into the running turn", "fix/st", ["main", "fix/queue"]);
    expect(prompt).toContain("Steer queued messages");
    expect(prompt).toContain("started typing this name: fix/st");
    expect(prompt).toContain("do not reuse: main, fix/queue");
  });
});

describe("the model that names a branch", () => {
  const catalog = [
    { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" },
    // Listed first, but a ChatGPT login cannot reach it; the draft's generation wins.
    { provider: "openai-codex", id: "gpt-5.4-mini", name: "5.4 mini" },
    { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" },
    { provider: "anthropic", id: "claude-opus-4-1", name: "Opus" },
    { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku" },
  ];
  const services = { completionModels: async () => catalog };

  it("keeps a small draft model, swaps a large one for the closest small one, else takes any small one", async () => {
    await expect(smallNamingModel(services, { provider: "anthropic", id: "claude-haiku-4-5" })).resolves.toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
    await expect(smallNamingModel(services, { provider: "openai-codex", id: "gpt-5.6-sol" })).resolves.toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
    // A Codex draft names its model under another provider; the id still finds Pi's twin.
    await expect(smallNamingModel(services, { provider: "openai", id: "gpt-5.6-sol" })).resolves.toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
    await expect(smallNamingModel(services, { provider: "google", id: "gemini-2.5-pro" })).resolves.toEqual({ provider: "openai-codex", id: "gpt-5.4-mini" });
    await expect(smallNamingModel(services, undefined)).resolves.toEqual({ provider: "openai-codex", id: "gpt-5.4-mini" });
  });

  it("leaves the default to the host when nothing small is reachable", async () => {
    await expect(smallNamingModel({ completionModels: async () => [catalog[0]!] }, { provider: "openai-codex", id: "gpt-5.6-sol" })).resolves.toBeUndefined();
    await expect(smallNamingModel({}, undefined)).resolves.toBeUndefined();
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

describe("Worktree Names host extension", () => {
  const registryWith = (thread: HostThread | undefined, complete = vi.fn(async () => "x"), owner: "tau" | "pi" = "tau", models: Array<{ provider: string; id: string; name: string }> = []) =>
    activateHostKit(createWorktreeNamesHostExtension(), { runtimeOwner: () => owner, thread: () => thread, complete, completionModels: async () => models });

  const anyThread = (backendKind = "pi") => ({ backendKind }) as unknown as HostThread;

  it("asks the chosen model and answers with a usable branch", async () => {
    const complete = vi.fn(async () => "Fix/Steer Queue Messages\n");
    const registry = await registryWith(anyThread(), complete);
    const result = await registry.invoke(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", {
      provider: "openai", modelId: "gpt-5.6", description: "Steer queued messages into the running turn", hint: "fix", taken: ["main"],
    });
    expect(result).toEqual({ branch: "fix/steer-queue-messages" });
    const [request, model] = complete.mock.calls[0] as unknown as [{ prompt: string }, { provider: string; id: string }];
    expect(model).toEqual({ provider: "openai", id: "gpt-5.6" });
    expect(request.prompt).toContain("Steer queued messages");
  });

  it("names a worktree from a thread of any runtime, on the user's default model when none was chosen", async () => {
    const complete = vi.fn(async () => "add-gemini-notes");
    const registry = await registryWith(anyThread("antigravity"), complete);
    await expect(registry.invoke(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", { description: "Add Gemini notes" }))
      .resolves.toEqual({ branch: "add-gemini-notes" });
    expect((complete.mock.calls as unknown as Array<[unknown, unknown]>)[0]?.[1]).toBeUndefined();
  });

  it("never names a branch on the draft's large model", async () => {
    const complete = vi.fn(async () => "fix-queue");
    const registry = await registryWith(anyThread(), complete, "tau", [
      { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" },
      { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" },
    ]);
    await registry.invoke(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", { prefer: { provider: "openai-codex", id: "gpt-5.6-sol" }, description: "Fix the queue" });
    expect((complete.mock.calls as unknown as Array<[unknown, unknown]>)[0]?.[1]).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
  });

  it("refuses without a task or a thread", async () => {
    const registry = await registryWith(anyThread());
    const suggest = (input: unknown) => registry.invoke(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", input);
    await expect(suggest({ provider: "openai", modelId: "gpt-5.6", description: "  " })).rejects.toThrow(/Describe the task/u);

    const noThread = await registryWith(undefined);
    await expect(noThread.invoke(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", { provider: "p", modelId: "m", description: "task" })).rejects.toThrow(/not ready/u);
  });
});
