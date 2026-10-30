import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiKitBridge } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createThreadTitlesHostExtension } from "./host.js";
import threadTitlesPiExtension from "./pi.js";
import { THREAD_TITLES_HOST_EXTENSION_ID, titleSystemPrompt } from "./protocol.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Both real entries, with the bridge transport replaced by direct command dispatch. */
async function attachedKit(projectInstructions = "Use German.") {
  let instructions = projectInstructions;
  let name: string | undefined;
  let idle = true;
  const commands = new Map<string, (ctx: any, input: Record<string, unknown>) => Promise<unknown>>();
  const events = new Map<string, (event: any, ctx: any) => unknown>();
  const complete = vi.fn(async (_model: unknown, _request: unknown) => ({ stopReason: "stop", content: [{ type: "text", text: "Warteschlange reparieren" }] }));
  const ctx = {
    isIdle: () => idle,
    sessionManager: { getSessionId: () => "session" },
    modelRegistry: { find: () => ({ provider: "provider", id: "model" }), complete },
  };
  const bridge: PiKitBridge = {
    extensionId: THREAD_TITLES_HOST_EXTENSION_ID,
    registerCommand: (command, handler) => { commands.set(command, handler); },
    publishEvent: vi.fn(), refreshSnapshot: vi.fn(), pinEntries: vi.fn(), observeUserTurns: vi.fn(),
    transcript: () => [{ role: "user", content: [{ type: "text", text: "Fix the queue" }] }],
    openSession: () => undefined, isCurrentSession: () => true,
  };
  const setSessionName = vi.fn((title: string) => { name = title; });
  threadTitlesPiExtension({ on: (event: string, handler: any) => events.set(event, handler), getSessionName: () => name, setSessionName } as never, bridge);
  const timeouts = vi.fn();
  const invoke = vi.fn(async (_extension: string, command: string, input: unknown) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        commands.get(command)!({ ...ctx }, input as Record<string, unknown>),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { timeouts(); reject(new Error("Pi bridge command timed out")); }, 15_000); }),
      ]);
    } finally { clearTimeout(timer); }
  });
  const host = await activateHostKit(createThreadTitlesHostExtension(), {
    runtimeOwner: () => "pi", attachedRuntime: () => ({ sessionId: "session", invoke }),
    thread: () => undefined, cwd: () => "/thread-project",
    settings: (async (_extensionId: string, cwd?: string) => ({ options: {}, values: { instructions: cwd === "/thread-project" ? instructions : "Use English." } })) as never,
  });
  const start = () => host.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { provider: "provider", modelId: "model" });
  const generate = async () => {
    const result = start();
    await vi.advanceTimersByTimeAsync(1_000);
    return result;
  };
  return { host, complete, setSessionName, invoke, start, generate, timeouts,
    settle: () => { idle = true; return events.get("agent_settled")!({}, { ...ctx }); },
    setIdle: (value: boolean) => { idle = value; },
    setInstructions: (value: string) => { instructions = value; } };
}

describe("title instructions across the host and attached Pi", () => {
  it("lets an explicitly empty project value override machine instructions", async () => {
    const kit = await attachedKit("");
    await kit.generate();
    expect(kit.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ systemPrompt: titleSystemPrompt("") }), expect.anything());
  });
  it("generates with the saved instructions and applies the validated result once", async () => {
    const kit = await attachedKit();
    await expect(kit.generate()).resolves.toEqual({ title: "Warteschlange reparieren" });
    expect(kit.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ systemPrompt: titleSystemPrompt("Use German.") }), expect.anything());
    expect(kit.setSessionName).toHaveBeenCalledExactlyOnceWith("Warteschlange reparieren");
    expect(kit.invoke.mock.calls.map((call) => call[1])).toEqual(["generate", "result", "apply", "cancel"]);
  });

  it("never applies an attached completion made with instructions since edited", async () => {
    const kit = await attachedKit();
    kit.complete.mockImplementationOnce(async () => {
      kit.setInstructions("Use English.");
      return { stopReason: "stop", content: [{ type: "text", text: "Warteschlange reparieren" }] };
    });
    await expect(kit.generate()).resolves.toBeUndefined();
    expect(kit.setSessionName).not.toHaveBeenCalled();
    expect(kit.invoke.mock.calls.map((call) => call[1])).toEqual(["generate", "cancel"]);
    await expect(kit.generate()).resolves.toEqual({ title: "Warteschlange reparieren" });
    expect(kit.complete).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ systemPrompt: titleSystemPrompt("Use English.") }), expect.anything());
  });

  it("keeps Pi attached through a long agent run and slow title inference", async () => {
    const kit = await attachedKit();
    kit.setIdle(false);
    kit.complete.mockImplementationOnce(() => new Promise((resolve) => {
      setTimeout(() => resolve({ stopReason: "stop", content: [{ type: "text", text: "Warteschlange reparieren" }] }), 20_000);
    }));
    const generated = kit.start();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(kit.complete).not.toHaveBeenCalled();
    expect(kit.timeouts).not.toHaveBeenCalled();
    const settled = kit.settle();
    await vi.advanceTimersByTimeAsync(21_000);
    await settled;
    await expect(generated).resolves.toEqual({ title: "Warteschlange reparieren" });
    expect(kit.timeouts).not.toHaveBeenCalled();
    expect(kit.setSessionName).toHaveBeenCalledExactlyOnceWith("Warteschlange reparieren");
  });

  it("cancels a waiting Pi job when its project instructions change", async () => {
    const kit = await attachedKit();
    kit.setIdle(false);
    const generated = kit.start();
    await vi.advanceTimersByTimeAsync(1_000);
    kit.setInstructions("");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(generated).resolves.toBeUndefined();
    await kit.settle();
    expect(kit.complete).not.toHaveBeenCalled();
    expect(kit.setSessionName).not.toHaveBeenCalled();
    expect(kit.timeouts).not.toHaveBeenCalled();
  });
});
