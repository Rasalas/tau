import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadRuntime } from "./thread-runtime.js";

async function ignoredTool() {
  let started!: () => void;
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const tool = new Promise<void>((resolve) => { finish = resolve; });
  const agent = new Agent({
    initialState: {
      model: { id: "fixture", api: "openai-completions", provider: "fixture" } as never,
      tools: [{ name: "hang", label: "Hang", description: "Ignores cancellation", parameters: Type.Object({}),
        execute: async (_id, _params, abortSignal) => {
          signal = abortSignal;
          started();
          await tool;
          return { content: [{ type: "text", text: "done" }], details: undefined };
        } }],
    },
    finishTurn: () => ({ action: "end" }),
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", content: [{ type: "toolCall", id: "call", name: "hang", arguments: {} }],
        api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "done", reason: "toolUse", message });
      return stream;
    },
  });
  const run = agent.prompt("hang");
  await ready;
  return {
    abort: async () => { agent.abort(); await agent.waitForIdle(); },
    signal: () => signal,
    finish: async () => { finish(); await run; },
  };
}

function thread(running: boolean) {
  const prompt = vi.fn(async (input: { onAdmitted?: (accepted: boolean) => void }) => { input.onAdmitted?.(true); return {}; });
  const backend = {
    kind: "pi", runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER, threadId: "stuck", providerSessionId: "stuck", cwd: "/repo",
    turnReporting: "streamed", capabilities: { journal: { entries: () => [], appendCustomEntry: () => undefined } },
    state: () => ({ streaming: running, idle: !running, hasMessages: true, sessionFile: "/sessions/stuck.jsonl", activeTools: [], supportsImageInput: false, extensionCount: 0 }),
    preparePrompt: async (text: string) => ({ tauThreadId: "stuck", providerSessionId: "stuck", backendKind: "pi", runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities, visibleText: text, runtimeText: text, sourceFingerprint: clientMessageFingerprint(text, []) }),
    composerCommands: () => [], catalogView: () => ({ thinkingLevel: "off", thinkingLevels: [], allTools: [] }),
    models: async () => [], transcript: async () => [], prompt,
    abort: vi.fn(() => running ? new Promise<void>(() => undefined) : Promise.resolve()),
  };
  const session = { abort: backend.abort, dispose: vi.fn() };
  const runtime = { session, dispose: vi.fn(() => running ? new Promise<void>(() => undefined) : Promise.resolve()) };
  return { thread: new ThreadRuntime(backend as never, runtime as never), session, runtime, prompt };
}

async function bench() {
  const events: any[] = [];
  const host = new PiHost("/repo", (event) => events.push(event), { list: () => [], isHidden: () => false, iconFor: async () => undefined } as never, false, false);
  const internals = host as unknown as Record<string, any>;
  internals.index.refreshShell = async () => undefined;
  internals.rememberProject = async () => undefined;
  const tool = await ignoredTool();
  const stuck = thread(true);
  stuck.thread.backend.abort = tool.abort;
  stuck.session.abort = tool.abort as typeof stuck.session.abort;
  const replacement = thread(false);
  await internals.threads.adopt({ threadId: "stuck", cwd: "/repo", runtime: stuck.thread, isolation: "in-process" });
  internals.threads.setActive("stuck");
  internals.runtimes.openForPath = vi.fn(async () => {
    await internals.threads.adopt({ threadId: "stuck", cwd: "/repo", runtime: replacement.thread, isolation: "in-process" });
    return replacement.thread;
  });
  return { host, internals, stuck, replacement, events, tool };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("a thread whose tool ignores abort", () => {
  it.each(["stop", "reload"])("bounds %s, discards a stuck runtime and accepts the next prompt", async (action) => {
    const b = await bench();
    vi.useFakeTimers();
    let stopped = false;
    const stop = (action === "stop" ? b.host.abort("stuck") : b.host.prepareWorkbenchReload("abort"))
      .then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    if (action === "reload") {
      let available = false;
      void b.internals.lifecycle.run("unrelated-operation", async () => { available = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(available).toBe(true);
    }
    await vi.advanceTimersByTimeAsync(4_999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(stopped).toBe(true);
    await stop;
    expect(b.tool.signal()?.aborted).toBe(true);
    expect(b.stuck.session.dispose).toHaveBeenCalledOnce();
    expect(b.internals.threads.get("stuck").runtime).toBe(b.replacement.thread);
    expect(b.events).toContainEqual(expect.objectContaining({ type: "agent-status", sessionId: "stuck", running: false }));
    await b.host.releaseWorkbenchReload();
    await b.host.prompt("continue", [], "stuck");
    expect(b.replacement.prompt).toHaveBeenCalledOnce();
    await b.tool.finish();
  });
});
