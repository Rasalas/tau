import { describe, expect, it, vi } from "vitest";
import type { HostThread, HostTurnObserver } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createThreadTitlesHostExtension } from "./host.js";
import { THREAD_TITLES_HOST_EXTENSION_ID, TITLE_FAILED_EVENT, TITLE_SYSTEM_PROMPT, TITLE_USER_PROMPT } from "./protocol.js";

describe("Thread Title Generator host extension", () => {
  const piThread = (overrides: Partial<Record<string, unknown>> = {}) => ({
    sessionId: "s1",
    backendKind: "pi",
    isStreaming: () => false,
    isCurrent: () => true,
    sessionName: () => undefined,
    transcript: async () => [{ role: "user", text: "Reply with the single word pong." }],
    ...overrides,
  }) as unknown as HostThread;

  it("waits for the first response without holding the command open and titles a screenshot from the conversation", async () => {
    let streaming = true;
    let observer!: HostTurnObserver;
    const complete = vi.fn(async () => "Bildvorschau im Chat");
    const thread = piThread({ isStreaming: () => streaming, nativeTitle: async () => undefined,
      transcript: async () => [{ role: "user", text: "Screenshot.png" }, { role: "assistant", text: "Ich repariere die Bildvorschau im Chat." }] });
    const setThreadTitle = vi.fn(async () => undefined);
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => thread, complete, setThreadTitle,
      registerTurnObserver: (value) => { observer = value; return () => undefined; },
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { sessionId: "s1", prompt: "Screenshot.png" })).resolves.toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
    expect(observer.pending!("s1")).toBe(1);
    streaming = false;
    await observer.ended!("s1", "turn", "completed");
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining("Bildvorschau im Chat") }), undefined);
    expect(setThreadTitle).toHaveBeenCalledWith("s1", "Bildvorschau im Chat", "generated");
    expect(observer.pending!("s1")).toBe(0);
  });

  it("preserves a manual rename that arrived while the fallback model was running", async () => {
    let name: string | undefined;
    const setThreadTitle = vi.fn();
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => piThread({ sessionName: () => name }),
      complete: async () => { name = "Mein Titel"; return "Generated title"; }, setThreadTitle,
    });
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { prompt: "Fix it" });
    expect(setThreadTitle).not.toHaveBeenCalled();
  });

  it("uses a harness title before requesting a completion", async () => {
    const complete = vi.fn();
    const setThreadTitle = vi.fn(async () => undefined);
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau",
      thread: () => piThread({ nativeTitle: async () => "Bildvorschau im Chat" }),
      complete,
      setThreadTitle,
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { prompt: "Screenshot.png" })).resolves.toEqual({ title: "Bildvorschau im Chat" });
    expect(complete).not.toHaveBeenCalled();
    expect(setThreadTitle).toHaveBeenCalledWith("s1", "Bildvorschau im Chat", "generated");
  });

  it("falls back if the harness cannot read its native title", async () => {
    const complete = vi.fn(async () => "Bildvorschau im Chat");
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => piThread({ nativeTitle: async () => { throw new Error("Transcript unavailable"); } }),
      complete, setThreadTitle: async () => undefined,
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", {})).resolves.toEqual({ title: "Bildvorschau im Chat" });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("reports a failed deferred title and releases the pending thread", async () => {
    let streaming = true;
    let observer!: HostTurnObserver;
    const publish = vi.fn();
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => piThread({ isStreaming: () => streaming, nativeTitle: async () => undefined }),
      complete: async () => { throw new Error("Model unavailable"); },
      registerTurnObserver: (value) => { observer = value; return () => undefined; },
    }, publish);
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", {});
    streaming = false;
    await observer.ended!("s1", "turn", "completed");
    expect(observer.pending!("s1")).toBe(0);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ name: TITLE_FAILED_EVENT, payload: { sessionId: "s1", message: "Model unavailable" } }));
  });

  it("uses the harness login and newest small model when Pi has no login", async () => {
    const complete = vi.fn(async () => "Bildvorschau im Chat");
    const piComplete = vi.fn(async () => { throw new Error("No Pi login"); });
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau",
      thread: () => piThread({ model: { provider: "anthropic", id: "opus" }, complete,
        completionModels: async () => [{ provider: "anthropic", id: "haiku", name: "Haiku" }] }),
      complete: piComplete,
      completionModels: async () => [],
      setThreadTitle: async () => undefined,
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { prompt: "Repariere die Bildvorschau" })).resolves.toEqual({ title: "Bildvorschau im Chat" });
    expect(complete).toHaveBeenCalledWith("anthropic", "haiku", expect.anything());
    expect(piComplete).not.toHaveBeenCalled();
  });

  it("titles the thread with the model the desktop side chose, wording the request itself", async () => {
    const thread = piThread();
    const setThreadTitle = vi.fn(async () => undefined);
    const complete = vi.fn(async () => "## **Thread title: `Pong reply`**");
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau",
      thread: () => thread,
      complete,
      setThreadTitle,
    });
    const result = await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", {
      provider: "openai", modelId: "gpt-5.6", prompt: "Reply with the single word pong.",
    });
    expect(result).toEqual({ title: "Pong reply" });
    expect(setThreadTitle).toHaveBeenCalledWith("s1", "Pong reply", "generated");
    // Core has no title prompt of its own; the kit hands the whole request over.
    expect(complete).toHaveBeenCalledWith({
      system: TITLE_SYSTEM_PROMPT,
      prompt: TITLE_USER_PROMPT("user: Reply with the single word pong."),
      maxTokens: 256,
    }, { provider: "openai", id: "gpt-5.6" });
  });

  it("titles a thread of any runtime, on the user's default model when nothing small is reachable", async () => {
    const complete = vi.fn(async () => "Gemini thread");
    const setThreadTitle = vi.fn(async () => undefined);
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau",
      thread: () => piThread({ backendKind: "antigravity" }),
      complete,
      setThreadTitle,
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { prompt: "Reply with the single word pong." }))
      .resolves.toEqual({ title: "Gemini thread" });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 256 }), undefined);
    expect(setThreadTitle).toHaveBeenCalledWith("s1", "Gemini thread", "generated");
  });

  it("titles on a small model close to the thread's, never the thread's large one", async () => {
    const complete = vi.fn(async () => "Queue fix");
    const models = [
      { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" },
      { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" },
    ];
    for (const backendKind of ["pi", "codex"]) {
      const registry = await activateHostKit(createThreadTitlesHostExtension(), {
        runtimeOwner: () => "tau",
        thread: () => piThread({ backendKind }),
        complete,
        completionModels: async () => models,
        setThreadTitle: async () => undefined,
      });
      // A Codex thread names its model under its own provider; the id still finds the small twin.
      const prefer = backendKind === "codex" ? { provider: "openai", id: "gpt-5.6-sol" } : { provider: "openai-codex", id: "gpt-5.6-sol" };
      await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { prefer, prompt: "Fix the queue" });
      expect(complete).toHaveBeenLastCalledWith(expect.anything(), { provider: "openai-codex", id: "gpt-5.6-luna" });
    }
  });

  it("takes the thread's own model as the hint when the draft named none", async () => {
    const complete = vi.fn(async () => "Pong reply");
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau",
      thread: () => piThread({ backendKind: "codex", model: { provider: "openai", id: "gpt-5.6-sol" } }),
      complete,
      completionModels: async () => [
        { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku" },
        { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" },
      ],
      setThreadTitle: async () => undefined,
    });
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { prompt: "Reply with the single word pong." });
    expect(complete).toHaveBeenCalledWith(expect.anything(), { provider: "openai-codex", id: "gpt-5.6-luna" });
  });

  it("titles on the thread's own model, as complete names it, when nothing small is reachable", async () => {
    const complete = vi.fn(async () => "Pong reply");
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau",
      thread: () => piThread({ backendKind: "codex", model: { provider: "openai", id: "gpt-5.6-sol" } }),
      complete,
      completionModels: async () => [{ provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" }],
      setThreadTitle: async () => undefined,
    });
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { prompt: "Reply with the single word pong." });
    expect(complete).toHaveBeenCalledWith(expect.anything(), { provider: "openai-codex", id: "gpt-5.6-sol" });
  });

    it("keeps the model the settings name, even a large one", async () => {
    const complete = vi.fn(async () => "Queue fix");
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau",
      thread: () => piThread(),
      complete,
      completionModels: async () => [{ provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" }],
      setThreadTitle: async () => undefined,
    });
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", {
      provider: "openai-codex", modelId: "gpt-5.6-sol", prefer: { provider: "openai-codex", id: "gpt-5.6-sol" }, prompt: "Fix the queue",
    });
    expect(complete).toHaveBeenCalledWith(expect.anything(), { provider: "openai-codex", id: "gpt-5.6-sol" });
  });

  it("stays silent for a thread that already has a name", async () => {
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau",
      thread: () => piThread({ sessionName: () => "Named already" }),
      complete: async () => "Another title",
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { provider: "openai", modelId: "gpt-5.6" })).resolves.toBeUndefined();
  });

  it("renames a named thread when the user asks again, and tells a paired device's host which title followed a prompt", async () => {
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau",
      thread: () => piThread({ sessionName: () => "Named already" }),
      complete: async () => "Another title",
      setThreadTitle: async () => undefined,
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "regenerate", { provider: "openai", modelId: "gpt-5.6" })).resolves.toEqual({ title: "Another title" });
    const calls: unknown[] = [];
    const phone = { kind: "workbench-client", connection: "c1", pairedClient: "p1", audit: (call: unknown) => calls.push(call) } as const;
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { sessionId: "s1" }, phone);
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "regenerate", { sessionId: "s1" }, phone);
    expect(calls).toEqual([
      { action: "tau.thread-titles/generate", label: "titled a thread", threadId: "s1", automatic: true },
      { action: "tau.thread-titles/regenerate", label: "regenerated a thread title", threadId: "s1" },
    ]);
  });

  it("hands the attached Pi a small model, else the thread's own", async () => {
    const invoke = vi.fn(async () => ({ title: "Attached title" }));
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "pi",
      attachedRuntime: () => ({ sessionId: "session", invoke } as never),
      completionModels: async () => [{ provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku" }],
    });
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { prefer: { provider: "anthropic", id: "claude-opus-4-1" } });
    expect(invoke).toHaveBeenLastCalledWith(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { provider: "anthropic", modelId: "claude-haiku-4-5", force: false });

    const bare = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "pi",
      attachedRuntime: () => ({ sessionId: "session", invoke } as never),
      completionModels: async () => [],
    });
    await bare.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { prefer: { provider: "anthropic", id: "claude-opus-4-1" } });
    expect(invoke).toHaveBeenLastCalledWith(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { provider: "anthropic", modelId: "claude-opus-4-1", force: false });
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
