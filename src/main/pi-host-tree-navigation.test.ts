import { describe, expect, it, vi } from "vitest";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadRuntime } from "./thread-runtime.js";

/** An active thread whose tree move stays open until the test lets it finish. */
function bench() {
  let finish!: (result: { cancelled: boolean }) => void;
  const navigateTree = vi.fn(() => new Promise<{ cancelled: boolean }>((resolve) => { finish = resolve; }));
  const backend = {
    kind: "pi" as const, runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER, threadId: "t1", providerSessionId: "t1", cwd: "/repo",
    capabilities: { tree: { tree: async () => ({}), navigateTree, leafEntryId: () => "leaf" } },
    state: () => ({ streaming: false, idle: true, hasMessages: true, activeTools: [], supportsImageInput: false, extensionCount: 0 }),
    dispose: async () => undefined,
  };
  const thread = new ThreadRuntime(backend as never, { session: { sessionId: "t1" }, dispose: async () => undefined } as never);
  const host = new PiHost("/repo", () => undefined, { list: () => [], isHidden: () => false, iconFor: async () => undefined } as never, false, false);
  const internals = host as unknown as Record<string, any>;
  Object.defineProperty(host, "active", { get: () => thread });
  internals.publication.publishDetail = async () => ({ version: 1, updates: [] });
  return { host, internals, thread, navigateTree, finish: (result = { cancelled: false }) => finish(result) };
}

describe("moving a thread through its tree", () => {
  it("refuses a message while the move runs and takes messages again once it ends", async () => {
    const { host, internals, navigateTree, finish } = bench();
    const moving = host.navigateThreadTree("entry-1", { summarize: true });
    await vi.waitFor(() => expect(navigateTree).toHaveBeenCalled());
    await expect(host.prompt("hello")).rejects.toThrow(/moving to another point/u);
    await expect(host.prompt("hello", [], "t1")).rejects.toThrow(/moving to another point/u);
    finish();
    await moving;
    expect(() => internals.sessionControl.assertAvailable("t1")).not.toThrow();
  });

  it("takes messages again after a move that failed", async () => {
    const { host, internals, navigateTree } = bench();
    navigateTree.mockRejectedValueOnce(new Error("summary failed"));
    await expect(host.navigateThreadTree("entry-1", { summarize: true })).rejects.toThrow("summary failed");
    expect(() => internals.sessionControl.assertAvailable("t1")).not.toThrow();
  });

  it("will not start a move while a message is on its way to the thread", async () => {
    const { host, thread, navigateTree } = bench();
    thread.pendingClientMessageIds.push("m1");
    await expect(host.navigateThreadTree("entry-1")).rejects.toThrow(/Wait for the active run/u);
    expect(navigateTree).not.toHaveBeenCalled();
  });
});
