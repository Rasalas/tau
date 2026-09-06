import { describe, expect, it, vi } from "vitest";
import type { HostThread } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createThreadTitlesHostExtension } from "./host.js";
import { THREAD_TITLES_HOST_EXTENSION_ID } from "./protocol.js";

describe("Thread Title Generator host extension", () => {
  const piThread = (overrides: Partial<Record<string, unknown>> = {}) => ({
    sessionId: "s1",
    backendKind: "pi",
    isStreaming: () => false,
    isCurrent: () => true,
    sessionName: () => undefined,
    transcript: async () => [{ role: "user", text: "Reply with the single word pong." }],
    completeTitle: vi.fn(async () => "## **Thread title: `Pong reply`**"),
    ...overrides,
  }) as unknown as HostThread;

  it("titles the thread with the model the desktop side chose", async () => {
    const thread = piThread();
    const setThreadTitle = vi.fn(async () => undefined);
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau",
      thread: () => thread,
      setThreadTitle,
    });
    const result = await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", {
      provider: "openai", modelId: "gpt-5.6", prompt: "Reply with the single word pong.",
    });
    expect(result).toEqual({ title: "Pong reply" });
    expect(setThreadTitle).toHaveBeenCalledWith("s1", "Pong reply", "generated");
  });

  it("stays silent for a thread that already has a name, and refuses without a model", async () => {
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau",
      thread: () => piThread({ sessionName: () => "Named already" }),
    });
    const generate = (input: unknown) => registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", input);
    await expect(generate({ provider: "openai", modelId: "gpt-5.6" })).resolves.toBeUndefined();
    await expect(generate({ provider: "", modelId: "" })).rejects.toThrow(/needs a provider and a model/u);
  });

  it("forwards to the attached Pi terminal when it owns the runtime", async () => {
    const invoke = vi.fn(async () => ({ title: "Attached title" }));
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "pi",
      attachedRuntime: () => ({ sessionId: "session", invoke } as never),
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", {
      provider: "provider", modelId: "model", force: false, sessionId: "session",
    })).resolves.toEqual({ title: "Attached title" });
    expect(invoke).toHaveBeenCalledWith(THREAD_TITLES_HOST_EXTENSION_ID, "generate", {
      provider: "provider", modelId: "model", force: false,
    });
  });

  it("refuses the permission it did not declare", async () => {
    const denied = { ...createThreadTitlesHostExtension(), permissions: [] };
    const registry = await activateHostKit(denied, { runtimeOwner: () => "tau", thread: () => piThread() });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { provider: "openai", modelId: "gpt-5.6" }))
      .rejects.toThrow(/lacks permission sessions/u);
  });
});
