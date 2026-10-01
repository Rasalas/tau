import { describe, expect, it, vi } from "vitest";
import type { HostExtensionContext } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { workspaceCommandContext } from "./workspace-host.js";
import { createReviewHostExtension } from "./host.js";
import { LINK_SEAMS } from "./test-seams.js";

describe("Review command workspace inheritance", () => {
  it("passes the named workspace to a real publish handler's indirect Workspace reads", async () => {
    const read = vi.fn((input: unknown) => ({ root: "/other", branch: "feature", base: "main", input }));
    const registry = await activateHostKit({
      id: "tau.workspace", name: "Workspace", permissions: [],
      activate: (context) => { context.registerCommand("review-request-context", read, { access: "read", callers: ["tau.review"] }); },
    }, { ...LINK_SEAMS, findCommand: () => undefined });
    await registry.activate(createReviewHostExtension());
    await registry.invoke("tau.review", "publish-info", { workspace: "ws1_rex" });
    expect(read).toHaveBeenCalledWith({ workspace: "ws1_rex" }, expect.anything());
    await registry.dispose();
  });

  it("keeps overlapping commands isolated and preserves a child's explicit target", async () => {
    const invoke = vi.fn(async (_extension: string, _command: string, input?: unknown) => input);
    const handlers = new Map<string, (input: unknown) => unknown>();
    const original = {
      registerCommand: (name: string, handler: (input: unknown) => unknown) => { handlers.set(name, handler); return () => undefined; },
      invokeHostExtension: invoke,
    } as unknown as HostExtensionContext;
    const context = workspaceCommandContext(original);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    context.registerCommand("slow", async () => { await pending; return context.invokeHostExtension("tau.workspace", "push"); });
    context.registerCommand("fast", async () => {
      await context.invokeHostExtension("tau.workspace", "push");
      return context.invokeHostExtension("tau.workspace", "changes", { workspace: "ws1_child" });
    });
    const slow = handlers.get("slow")!({ workspace: "ws1_slow" });
    await handlers.get("fast")!({ workspace: "ws1_fast" });
    release();
    await slow;
    expect(invoke.mock.calls).toEqual([
      ["tau.workspace", "push", { workspace: "ws1_fast" }],
      ["tau.workspace", "changes", { workspace: "ws1_child" }],
      ["tau.workspace", "push", { workspace: "ws1_slow" }],
    ]);
  });
});
