import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUiAnswer, HostEvent } from "../shared/contracts.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { PiHost } from "./pi-host.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import type { RuntimeExtensionBindings } from "./runtime-types.js";

interface HostInternals {
  binding: { bind(thread: ThreadRuntime, deferred: boolean): Promise<void> };
  threads: { adopt(record: unknown): Promise<void> };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

/** A Pi-shaped thread whose extension binding the test drives by hand. */
function bindableThread(bind: (bindings: RuntimeExtensionBindings) => Promise<void>, prompts: string[], threadId = "session") {
  const backend = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd: "/repo",
    turnReporting: "streamed" as const,
    capabilities: {
      journal: { entries: () => [], appendCustomEntry: () => undefined, appendMessage: () => undefined },
      events: { subscribe: () => () => undefined },
      extensions: {
        bind,
        unbind: () => undefined,
        setLifecycleHooks: () => undefined,
        shortcuts: () => [],
        runShortcut: async () => false,
      },
    },
    preparePrompt: async (text: string) => ({
      tauThreadId: threadId,
      providerSessionId: threadId,
      sessionId: threadId,
      backendKind: "pi" as const,
      runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
      visibleText: text,
      runtimeText: text,
      sourceFingerprint: clientMessageFingerprint(text, []),
    }),
    composerCommands: () => [],
    prompt: async (input: { text: string; onAdmitted?: (accepted: boolean) => void }) => {
      prompts.push(input.text);
      input.onAdmitted?.(true);
      return {};
    },
    state: () => ({ streaming: false, idle: true, hasMessages: false, activeTools: [], supportsImageInput: false, extensionCount: 0 }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
    models: async () => [],
    transcript: async () => [],
    persist: async () => undefined,
    setTitle: async () => undefined,
    abort: async () => undefined,
    dispose: async () => undefined,
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
  return new ThreadRuntime(backend as never);
}

async function hostWithBindingThread(bind: (bindings: RuntimeExtensionBindings) => Promise<void>) {
  const events: HostEvent[] = [];
  const prompts: string[] = [];
  const history = { list: () => [], isHidden: () => false, iconFor: async () => undefined };
  const host = new PiHost("/repo", (event) => { events.push(event); }, history as never, false, false);
  const internals = host as unknown as HostInternals;
  const thread = bindableThread(bind, prompts);
  await internals.threads.adopt({ threadId: "session", cwd: "/repo", runtime: thread, isolation: "in-process" });
  const bound = internals.binding.bind(thread, true);
  return { host, internals, thread, events, prompts, bound };
}

/** Lets every already-scheduled microtask and timer run. */
function settleQueue(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe("deferred extension binding", () => {
  afterEach(() => vi.useRealTimers());

  it("reports a hung start binding after the deadline while another thread can prompt", async () => {
    vi.useFakeTimers();
    const { host, internals, events, prompts, bound } = await hostWithBindingThread(() => new Promise(() => undefined));
    const otherPrompts: string[] = [];
    const other = bindableThread(async () => undefined, otherPrompts, "other");
    await internals.threads.adopt({ threadId: "other", cwd: "/repo", runtime: other, isolation: "in-process" });
    const prompt = host.prompt("hello", [], "session").catch((error: unknown) => error);
    await host.prompt("still works", [], "other");
    expect(otherPrompts).toEqual(["still works"]);
    await vi.advanceTimersByTimeAsync(30_000);
    await bound;
    expect(await prompt).toEqual(expect.objectContaining({ message: expect.stringContaining("30 s") }));
    expect(prompts).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", sessionId: "session", message: expect.stringContaining("30 s") }));
    await host.prompt("works afterwards", [], "other");
    expect(otherPrompts).toEqual(["still works", "works afterwards"]);
  });
  it("holds a prompt until the pending binding finishes", async () => {
    const gate = deferred<void>();
    const { host, prompts } = await hostWithBindingThread(() => gate.promise);

    let promptSettled = false;
    const prompt = host.prompt("hello", [], "session").then(() => { promptSettled = true; });
    await settleQueue();
    expect(prompts).toEqual([]);
    expect(promptSettled).toBe(false);

    gate.resolve();
    await prompt;
    expect(prompts).toEqual(["hello"]);
  });

  it("answers an extension question raised while the binding is still running", async () => {
    let asked: Promise<ExtensionUiAnswer> | undefined;
    const { host, events, prompts, bound } = await hostWithBindingThread(async (bindings) => {
      asked = bindings.ui.ask({ id: "q1", sessionId: "session", kind: "confirm", title: "Continue?" });
      await asked;
    });
    await settleQueue();
    expect(events).toContainEqual(expect.objectContaining({ type: "extension-ui-prompt", sessionId: "session" }));

    const prompt = host.prompt("hello", [], "session");
    await settleQueue();
    expect(prompts).toEqual([]);

    host.answerExtensionUi("q1", { confirmed: true });
    await expect(asked).resolves.toEqual({ confirmed: true });
    await bound;
    await prompt;
    expect(prompts).toEqual(["hello"]);
  });
});
