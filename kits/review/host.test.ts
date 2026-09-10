import { describe, expect, it, vi } from "vitest";
import type { HostThread } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { buildCommitPrompt, cleanCommitMessage, createReviewHostExtension } from "./host.js";
import { REVIEW_HOST_EXTENSION_ID } from "./protocol.js";

describe("Review Kit host extension", () => {
  const thread = (backendKind = "pi") => ({ backendKind }) as unknown as HostThread;
  const registryWith = (active: HostThread, complete = vi.fn(async () => "")) => activateHostKit(createReviewHostExtension(), {
    runtimeOwner: () => "tau",
    thread: () => active,
    complete,
  });

  it("asks the selected model for the selected message format", async () => {
    const complete = vi.fn(async () => "```text\nfeat(review): show every changed file\n```");
    const registry = await registryWith(thread(), complete);
    await expect(registry.invoke(REVIEW_HOST_EXTENSION_ID, "suggest-commit-message", {
      provider: "openai",
      modelId: "gpt-luna",
      style: "conventional",
      branch: "feat/review",
      files: [{ path: "src/review.tsx", added: 20, removed: 4 }],
      diffs: [{ path: "src/review.tsx", patch: "-old\n+new" }],
    })).resolves.toEqual({ message: "feat(review): show every changed file" });
    expect((complete.mock.calls as unknown as Array<[unknown, unknown]>)[0]?.[1]).toEqual({ provider: "openai", id: "gpt-luna" });
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

  it("builds a bounded diff prompt and cleans fenced answers", () => {
    expect(buildCommitPrompt({ branch: "main", files: [{ path: "a.ts", added: 1, removed: 1 }], diffs: [{ path: "a.ts", patch: "-a\n+b" }] })).toContain("--- a.ts\n-a\n+b");
    expect(cleanCommitMessage("  ```\nfix: use semicolon\n```  ")).toBe("fix: use semicolon");
  });
});
