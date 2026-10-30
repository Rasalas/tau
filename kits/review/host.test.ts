import { describe, expect, it, vi } from "vitest";
import type { HostExtensionContext, HostThread } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { buildCommitPrompt, cleanCommitMessage, createReviewHostExtension } from "./host.js";
import { REVIEW_HOST_EXTENSION_ID } from "./protocol.js";
import { LINK_SEAMS } from "./test-seams.js";

describe("Review Kit host extension", () => {
  const thread = (backendKind = "pi") => ({ backendKind }) as unknown as HostThread;
  const registryWith = (active: HostThread, complete = vi.fn(async () => "")) => activateHostKit(createReviewHostExtension(), {
    ...LINK_SEAMS,
    runtimeOwner: () => "tau",
    thread: () => active,
    complete,
    runtimeChoices: async () => [{ backend: { kind: "pi", label: "Pi" }, enabled: true, readiness: { kind: "pi", label: "Pi", state: "ready" }, catalog: { kind: "pi", models: [{ provider: "test", id: "writer", name: "Writer" }], thinkingLevels: { "test/writer": ["off", "low", "high"] } } }],
  });

  it("asks the selected model for the selected message format", async () => {
    const complete = vi.fn(async () => "```text\nfeat(review): show every changed file\n```");
    const registry = await registryWith(thread(), complete);
    await expect(registry.invoke(REVIEW_HOST_EXTENSION_ID, "suggest-commit-message", {
      provider: "test",
      modelId: "writer",
      thinkingLevel: "high",
      style: "conventional",
      branch: "feat/review",
      files: [{ path: "src/review.tsx", added: 20, removed: 4 }],
      diffs: [{ path: "src/review.tsx", patch: "-old\n+new" }],
    })).resolves.toEqual({ message: "feat(review): show every changed file" });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "high", maxTokens: 16_384, timeoutMs: 120_000 }), { provider: "test", id: "writer" });
    expect((complete.mock.calls as unknown as Array<[unknown, unknown]>)[0]?.[1]).toEqual({ provider: "test", id: "writer" });
  });

  it.each([undefined, "invalid"])("keeps the default writer request for effort %s", async (thinkingLevel) => {
    const complete = vi.fn(async () => "fix: save");
    const registry = await registryWith(thread(), complete);
    await registry.invoke(REVIEW_HOST_EXTENSION_ID, "suggest-commit-message", { provider: "test", modelId: "writer", thinkingLevel, files: [{ path: "a.ts", added: 1, removed: 0 }] });
    expect((complete.mock.calls as unknown as Array<[unknown]>)[0]![0]).toMatchObject({ maxTokens: 220 });
    expect((complete.mock.calls as unknown as Array<[unknown]>)[0]![0]).not.toHaveProperty("thinkingLevel");
  });

  it("writes on the thread's runtime when Text generation says so: its model where it offers the chosen one, never Pi's effort", async () => {
    const complete = vi.fn(async () => "never Pi");
    const own = vi.fn(async () => "fix: write on the harness");
    const harness = { backendKind: "codex", model: { provider: "openai", id: "gpt-thread" }, completionModels: async () => [{ provider: "openai", id: "gpt-mini", name: "Mini" }], complete: own } as unknown as HostThread;
    const registry = await registryWith(harness, complete);
    const files = [{ path: "a.ts", added: 1, removed: 0 }];
    await expect(registry.invoke(REVIEW_HOST_EXTENSION_ID, "suggest-commit-message", { runtime: "thread", provider: "openai", modelId: "gpt-mini", thinkingLevel: "high", files })).resolves.toEqual({ message: "fix: write on the harness" });
    expect(own).toHaveBeenLastCalledWith("openai", "gpt-mini", expect.not.objectContaining({ thinkingLevel: expect.anything() }));
    // A model the runtime does not offer gives way to the thread's own.
    await registry.invoke(REVIEW_HOST_EXTENSION_ID, "suggest-commit-message", { runtime: "thread", provider: "test", modelId: "writer", files });
    expect(own).toHaveBeenLastCalledWith("openai", "gpt-thread", expect.objectContaining({ maxTokens: 220 }));
    expect(complete).not.toHaveBeenCalled();
  });

  it("adds the user's own instructions after the format's", async () => {
    const complete = vi.fn(async () => "fix: it");
    const registry = await registryWith(thread(), complete);
    await registry.invoke(REVIEW_HOST_EXTENSION_ID, "suggest-commit-message", {
      style: "plain",
      instructions: "  Mention the ticket number.  ",
      files: [{ path: "a.ts", added: 1, removed: 0 }],
      diffs: [],
    });
    const system = (complete.mock.calls as unknown as Array<[{ system: string }]>)[0]![0].system;
    expect(system.startsWith("Write one concise Git commit message")).toBe(true);
    expect(system.endsWith("they win:\nMention the ticket number.")).toBe(true);
  });

  it("stays active when commit-message generation repeatedly fails", async () => {
    const complete = vi.fn(async () => { throw new Error("Model credentials are unavailable."); });
    const registry = await registryWith(thread(), complete);
    const input = {
      branch: "feat/review",
      files: [{ path: "src/review.tsx", added: 20, removed: 4 }],
      diffs: [{ path: "src/review.tsx", patch: "-old\n+new" }],
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(registry.invoke(REVIEW_HOST_EXTENSION_ID, "suggest-commit-message", input))
        .rejects.toThrow("Model credentials are unavailable.");
    }

    expect(registry.isActive(REVIEW_HOST_EXTENSION_ID)).toBe(true);
  });

  it("routes Review's workspace reads through its host-owned caller context", async () => {
    const workspace = {
      id: "tau.workspace",
      name: "Workspace Kit",
      permissions: [] as string[],
      activate(context: HostExtensionContext) {
        context.registerCommand("changes", () => ({ files: ["README.md"] }), { callers: [REVIEW_HOST_EXTENSION_ID] });
        context.registerCommand("file-diff", (input) => ({ path: (input as { relPath: string }).relPath }), { callers: [REVIEW_HOST_EXTENSION_ID] });
      },
    };
    const registry = await activateHostKit(workspace, LINK_SEAMS);
    await expect(registry.activate(createReviewHostExtension())).resolves.toBe(true);

    await expect(registry.invoke(REVIEW_HOST_EXTENSION_ID, "changes")).resolves.toEqual({ files: ["README.md"] });
    await expect(registry.invoke(REVIEW_HOST_EXTENSION_ID, "file-diff", { relPath: "README.md" })).resolves.toEqual({ path: "README.md" });
  });

  it("builds a bounded diff prompt and cleans fenced answers", () => {
    expect(buildCommitPrompt({ branch: "main", files: [{ path: "a.ts", added: 1, removed: 1 }], diffs: [{ path: "a.ts", patch: "-a\n+b" }] })).toContain("--- a.ts\n-a\n+b");
    expect(cleanCommitMessage("  ```\nfix: use semicolon\n```  ")).toBe("fix: use semicolon");
  });
});
