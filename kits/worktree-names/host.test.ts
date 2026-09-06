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
  const registryWith = (thread: HostThread | undefined, owner: "tau" | "pi" = "tau") =>
    activateHostKit(createWorktreeNamesHostExtension(), { runtimeOwner: () => owner, thread: () => thread });

  const piThread = (answer: string) => ({
    backendKind: "pi",
    complete: vi.fn(async () => answer),
  }) as unknown as HostThread;

  it("asks the chosen model and answers with a usable branch", async () => {
    const thread = piThread("Fix/Steer Queue Messages\n");
    const registry = await registryWith(thread);
    const result = await registry.invoke(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", {
      provider: "openai", modelId: "gpt-5.6", description: "Steer queued messages into the running turn", hint: "fix", taken: ["main"],
    });
    expect(result).toEqual({ branch: "fix/steer-queue-messages" });
    const [provider, modelId, request] = (thread.complete as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, { prompt: string }];
    expect([provider, modelId]).toEqual(["openai", "gpt-5.6"]);
    expect(request.prompt).toContain("Steer queued messages");
  });

  it("refuses without a task, a model, or a Pi thread", async () => {
    const registry = await registryWith(piThread("x"));
    const suggest = (input: unknown) => registry.invoke(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", input);
    await expect(suggest({ provider: "openai", modelId: "gpt-5.6", description: "  " })).rejects.toThrow(/Describe the task/u);
    await expect(suggest({ provider: "", modelId: "", description: "task" })).rejects.toThrow(/needs a model/u);

    const noThread = await registryWith(undefined);
    await expect(noThread.invoke(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", { provider: "p", modelId: "m", description: "task" })).rejects.toThrow(/not ready/u);
  });
});
