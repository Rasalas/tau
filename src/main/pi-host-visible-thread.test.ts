import { describe, expect, it, vi } from "vitest";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { adoptThread, getActiveThreadId, mockInternalMethods, rawInternals, setActiveThread } from "./test-support/host-harness.js";

/**
 * The host's active thread can differ from the one a window shows: a thread
 * started from a draft the user has already left became the active one. A
 * request that names its thread must reach that thread.
 */
function liveThread(threadId: string, running = false) {
  let model = "first";
  let thinkingLevel = "off";
  const compact = vi.fn(async () => {
    if (running) throw new Error("Claude Code is still working on this thread. Compact it once the turn ends.");
  });
  const setModel = vi.fn(async (_provider: string, id: string) => { model = id; });
  const setThinkingLevel = vi.fn(async (level: string) => { thinkingLevel = level; });
  const backend: any = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd: "/repo",
    turnReporting: "streamed" as const,
    capabilities: { compaction: { compact }, catalogWrite: { setModel, setThinkingLevel } },
    state: () => ({ streaming: running, idle: !running, hasMessages: true, activeTools: [], supportsImageInput: false, extensionCount: 0 }),
    catalogView: () => ({ model: { provider: "test", id: model, name: model }, thinkingLevel, thinkingLevels: ["off", "high"], allTools: [] }),
    models: async () => [{ provider: "test", id: "first", name: "first" }, { provider: "test", id: "second", name: "second" }],
    composerCommands: () => [],
    transcript: async () => [],
    dispose: async () => undefined,
  };
  const session = { sessionId: threadId, sessionFile: `/${threadId}.jsonl`, resourceLoader: { getExtensions: () => ({ extensions: [] }) } };
  return { runtime: new ThreadRuntime(backend, { session } as never), compact, setModel, setThinkingLevel };
}

async function hostWith(active: ReturnType<typeof liveThread>, shown: ReturnType<typeof liveThread>) {
  const host = new PiHost("/repo", () => undefined, {} as never, true, false);
  await adoptThread(host, { threadId: active.runtime.threadId, cwd: "/repo", runtime: active.runtime });
  await adoptThread(host, { threadId: shown.runtime.threadId, cwd: "/repo", runtime: shown.runtime });
  setActiveThread(host, active.runtime.threadId);
  return host;
}

describe("requests that name the thread on screen", () => {
  it("compacts the named thread, not the host's active thread", async () => {
    const running = liveThread("running", true);
    const shown = liveThread("shown");
    const host = await hostWith(running, shown);

    await expect(host.compactContext("shown")).resolves.toBeDefined();

    expect(shown.compact).toHaveBeenCalledTimes(1);
    expect(running.compact).not.toHaveBeenCalled();
  });

  it("changes the named thread's model and thinking level and answers with that thread's catalog", async () => {
    const running = liveThread("running", true);
    const shown = liveThread("shown");
    const host = await hostWith(running, shown);

    const model = await host.setModel("test", "second", "shown");
    const thinking = await host.setThinkingLevel("high", "shown");

    expect(shown.setModel).toHaveBeenCalledWith("test", "second");
    expect(shown.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(running.setModel).not.toHaveBeenCalled();
    expect(running.setThinkingLevel).not.toHaveBeenCalled();
    expect(model.updates).toContainEqual(expect.objectContaining({ type: "catalog", catalog: expect.objectContaining({ model: expect.objectContaining({ id: "second" }) }) }));
    expect(thinking.updates).toContainEqual(expect.objectContaining({ type: "catalog", catalog: expect.objectContaining({ thinkingLevel: "high" }) }));
    expect(getActiveThreadId(host)).toBe("running");
  });
});

describe("a new thread sent from a draft the user has left", () => {
  it("starts in the background and leaves the host's active thread alone", async () => {
    const shown = liveThread("shown");
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    await adoptThread(host, { threadId: "shown", cwd: "/repo", runtime: shown.runtime });
    setActiveThread(host, "shown");
    const created = liveThread("created");
    const prompts: string[] = [];
    mockInternalMethods(host, {
      rememberProject: async () => undefined,
      refreshShell: async () => undefined,
      detachBridge: () => undefined,
      takeSpareThread: async () => undefined,
      openRuntime: async () => created.runtime,
      logReplacement: () => undefined,
      prompt: async (text: string) => { prompts.push(text); },
    });
    rawInternals(host).prewarm.scheduleSpare = () => undefined;

    const result = await host.newSession("collapse finished agents", [], "/repo", undefined, undefined, { background: true });

    expect(result).toMatchObject({ submission: { accepted: true }, sessionId: "created" });
    await vi.waitFor(() => expect(prompts).toEqual(["collapse finished agents"]));
    expect(getActiveThreadId(host)).toBe("shown");
  });
});
