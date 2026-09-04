import { describe, expect, it } from "vitest";
import { PiHost } from "./pi-host.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import type { HostExtension } from "./host-extensions.js";

function idleThread(threadId: string) {
  const backend = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd: "/repo",
    turnReporting: "streamed" as const,
    capabilities: {},
    state: () => ({
      streaming: false,
      idle: true,
      hasMessages: true,
      sessionFile: `/${threadId}.jsonl`,
      activeTools: [],
      supportsImageInput: false,
      extensionCount: 0,
    }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
    models: async () => [],
    composerCommands: () => [],
    transcript: async () => [],
    persist: async () => undefined,
    setTitle: async () => undefined,
    preparePrompt: async () => undefined,
    prompt: async () => ({}),
    abort: async () => undefined,
    dispose: async () => undefined,
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
  return new ThreadRuntime(backend as never, { session: { sessionId: threadId } } as never);
}

describe("PiHost lifecycle queue", () => {
  it("lets a thread lifecycle hook take the exclusive lane it already runs in", async () => {
    const order: string[] = [];
    const extension: HostExtension = {
      id: "test.exclusive",
      name: "Exclusive",
      activate: (context) => {
        context.services.registerThreadLifecycle({
          beforeWorkspace: async () => {
            order.push("hook");
            // The deadlock ADR 0004 describes: a hook of a queued operation
            // asking the host for that same queue.
            await context.services.sessions.exclusive(async () => { order.push("exclusive"); });
          },
        });
      },
    };
    const host = new PiHost("/repo", () => undefined, {} as never, false, false, { hostExtensions: [extension] });
    const internals = host as unknown as Record<string, any>;
    await internals.activateHostExtensions();
    const thread = idleThread("session");
    await internals.threads.adopt({ threadId: "session", cwd: "/repo", runtime: thread, isolation: "in-process" });
    internals.threads.setActive("session");
    internals.rememberProject = async () => {};
    internals.activeUpdates = async () => ({ version: 1, updates: [] });

    await expect(host.setWorkspace("/repo")).resolves.toEqual({ version: 1, updates: [] });
    expect(order).toEqual(["hook", "exclusive"]);
  });

  it("still serialises two independent lifecycle operations", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, false, false);
    const internals = host as unknown as Record<string, any>;
    const order: string[] = [];
    let release!: () => void;
    const first = internals.lifecycle.run("first", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => { release = resolve; });
      order.push("first:end");
    });
    const second = internals.lifecycle.run("second", async () => { order.push("second"); });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});
