import { describe, expect, it, vi } from "vitest";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { adoptThread, setActiveThread } from "./test-support/host-harness.js";

function compactableThread(threadId: string, running = false) {
  const compact = vi.fn(async () => {
    if (running) throw new Error("Claude Code is still working on this thread. Compact it once the turn ends.");
  });
  const backend: any = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd: "/repo",
    turnReporting: "streamed" as const,
    capabilities: { compaction: { compact } },
    state: () => ({ streaming: false, idle: true, hasMessages: true, activeTools: [], supportsImageInput: false, extensionCount: 0 }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
    dispose: async () => undefined,
  };
  const session = { sessionId: threadId, sessionFile: `/${threadId}.jsonl`, resourceLoader: { getExtensions: () => ({ extensions: [] }) } };
  return { runtime: new ThreadRuntime(backend, { session } as never), compact };
}

describe("PiHost.compactContext", () => {
  // A new thread whose activation lands after the user opened another one is the host's active thread,
  // while the window shows the other one.
  it("compacts the thread the client names, not the host's active thread", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const running = compactableThread("running", true);
    const shown = compactableThread("shown");
    await adoptThread(host, { threadId: "running", cwd: "/repo", runtime: running.runtime });
    await adoptThread(host, { threadId: "shown", cwd: "/repo", runtime: shown.runtime });
    setActiveThread(host, "running");

    await expect(host.compactContext("shown")).resolves.toBeDefined();

    expect(shown.compact).toHaveBeenCalledTimes(1);
    expect(running.compact).not.toHaveBeenCalled();
  });
});
