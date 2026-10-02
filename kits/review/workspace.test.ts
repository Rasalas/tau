import { describe, expect, it, vi } from "vitest";
import type { HostExtensionClient } from "tau";
import { workspaceChangesReader } from "./workspace.js";

describe("Review workspace reads", () => {
  it("names the displayed workspace on both reads and follows a later workspace", async () => {
    const invoke = vi.fn(async () => undefined);
    let workspace = "ws1_rex";
    const reader = workspaceChangesReader({ invoke } as unknown as HostExtensionClient, () => workspace);
    await reader.changes();
    await reader.fileDiff("a.ts", { contextLines: 3 });
    workspace = "ws1_other";
    await reader.changes({ scope: "branch" });
    expect(invoke.mock.calls).toEqual([
      ["changes", { workspace: "ws1_rex" }],
      ["file-diff", { relPath: "a.ts", options: { contextLines: 3 }, workspace: "ws1_rex" }],
      ["changes", { query: { scope: "branch" }, workspace: "ws1_other" }],
    ]);
  });
});
