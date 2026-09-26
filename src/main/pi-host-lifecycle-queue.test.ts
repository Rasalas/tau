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

  it("rejects a prompt when the activation epoch changes during binding", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, false, false);
    const internals = host as unknown as Record<string, any>;
    const thread = idleThread("session");
    await internals.threads.adopt({ threadId: "session", cwd: "/repo", runtime: thread, isolation: "in-process" });
    internals.threads.setActive("session");

    // Make binding.settle wait until we bump the epoch.
    let releaseSettle!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSettle = resolve; });
    internals.binding = { settle: async () => gate, installHooks: () => undefined };

    const promptResult = host.prompt("hello").then(
      () => "resolved",
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
    // Give prompt() time to reach binding.settle before we bump.
    await Promise.resolve();
    // Simulate a concurrent switch: advance the shared lifecycle owner.
    internals.lifecycle.beginActivation();
    releaseSettle();
    // The gate-resolved microtask must settle promptResult.
    await Promise.resolve();
    expect(await promptResult).toMatch(/active thread changed/iu);
  });

  /** A host whose `session` thread is open and on screen, with binding held until `release`. */
  async function hostWithHeldBinding() {
    const host = new PiHost("/repo", () => undefined, {} as never, false, false);
    const internals = host as unknown as Record<string, any>;
    const thread = idleThread("session");
    await internals.threads.adopt({ threadId: "session", cwd: "/repo", runtime: thread, isolation: "in-process" });
    internals.threads.setActive("session");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let settling!: () => void;
    const reached = new Promise<void>((resolve) => { settling = resolve; });
    internals.binding = { settle: async () => { settling(); await gate; }, installHooks: () => undefined };
    const delivered: string[] = [];
    internals.turns = { toRuntime: async (_thread: unknown, text: string) => { delivered.push(text); } };
    return { host, internals, release, reached, delivered };
  }

  // A superseded new-thread request delivers its first prompt by thread id while the newer one activates.
  it("delivers a prompt addressed to its thread when another thread becomes active during binding", async () => {
    const { host, internals, release, reached, delivered } = await hostWithHeldBinding();
    const promptResult = host.prompt("wait 60000", [], "session");
    await reached;
    internals.lifecycle.beginActivation();
    release();
    await expect(promptResult).resolves.toBeUndefined();
    expect(delivered).toEqual(["wait 60000"]);
  });

  it("refuses a prompt addressed to a thread that closes during binding", async () => {
    const { host, internals, release, reached, delivered } = await hostWithHeldBinding();
    const promptResult = host.prompt("hello", [], "session");
    await reached;
    internals.lifecycle.beginActivation();
    // The idle fake's shutdown fails; the slot is gone before that.
    await internals.threads.release("session").catch(() => undefined);
    release();
    await expect(promptResult).rejects.toThrow(/not open any more/iu);
    expect(delivered).toEqual([]);
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
