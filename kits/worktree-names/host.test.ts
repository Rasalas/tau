import { describe, expect, it, vi } from "vitest";
import type { HostThread } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { branchNameFromSuggestion, buildNamingPrompt, createWorktreeNamesHostExtension } from "./host.js";
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

  it("names a branch on the draft's own model when nothing small is reachable", async () => {
    const complete = vi.fn(async () => "fix-queue");
    const registry = await registryWith(anyThread("codex"), complete, "tau", [{ provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" }]);
    await registry.invoke(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", { prefer: { provider: "openai", id: "gpt-5.6-sol" }, description: "Fix the queue" });
    expect((complete.mock.calls as unknown as Array<[unknown, unknown]>)[0]?.[1]).toEqual({ provider: "openai-codex", id: "gpt-5.6-sol" });
  });

    it("answers a missing task as a hint that never switches the kit off", async () => {
    const registry = await registryWith(anyThread());
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(registry.invoke(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", { description: "" })).rejects.toThrow(/Describe the task/u);
    }
    expect(registry.isActive(WORKTREE_NAMES_HOST_EXTENSION_ID)).toBe(true);
    expect(registry.summaries().find((entry) => entry.id === WORKTREE_NAMES_HOST_EXTENSION_ID)?.error).toBeUndefined();
  });

  it("refuses without a task or a thread", async () => {
    const registry = await registryWith(anyThread());
    const suggest = (input: unknown) => registry.invoke(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", input);
    await expect(suggest({ provider: "openai", modelId: "gpt-5.6", description: "  " })).rejects.toThrow(/Describe the task/u);

    const noThread = await registryWith(undefined);
    await expect(noThread.invoke(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", { provider: "p", modelId: "m", description: "task" })).rejects.toThrow(/not ready/u);
  });
});
