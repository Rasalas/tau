import { describe, expect, it, vi } from "vitest";
import type { HostThread, HostTurnObserver } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createThreadTitlesHostExtension } from "./host.js";
import { THREAD_TITLES_HOST_EXTENSION_ID, TITLE_FAILED_EVENT, TITLE_SYSTEM_PROMPT, TITLE_USER_PROMPT, TITLE_INSTRUCTIONS_LIMIT, titleSystemPrompt } from "./protocol.js";

describe("Thread Title Generator host extension", () => {
  it("generates a title with the thread model on a custom endpoint and preserves an explicit choice", async () => {
    const own = { provider: "openai", id: "custom-text" };
    const small = { provider: "openai", id: "builtin-mini", name: "Small", completionPreference: "configured" as const };
    const setThreadTitle = vi.fn(async () => undefined);
    const complete = vi.fn(async (_request, model) => {
      if (model?.id !== own.id) throw new Error("Unknown model at gateway");
      return "Queue repair";
    });
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => piThread({ model: own }), complete, setThreadTitle,
      completionModels: async () => [small, { ...own, name: "Custom", completionPreference: "default" }],
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { prompt: "Fix the queue" })).resolves.toEqual({ title: "Queue repair" });
    expect(setThreadTitle).toHaveBeenCalledWith("s1", "Queue repair", "generated");
    expect(complete).toHaveBeenCalledOnce();
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { provider: small.provider, modelId: small.id, prompt: "Fix the queue" })).rejects.toThrow("Unknown model at gateway");
    expect(complete).toHaveBeenLastCalledWith(expect.anything(), { provider: small.provider, id: small.id });
  });

  const piThread = (overrides: Partial<Record<string, unknown>> = {}) => ({
    sessionId: "s1",
    backendKind: "pi",
    cwd: "/thread-project",
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

  it("adopts a harness title that appears while the first turn still runs", async () => {
    vi.useFakeTimers();
    try {
      let native: string | undefined;
      let observer!: HostTurnObserver;
      const complete = vi.fn();
      const setThreadTitle = vi.fn(async () => undefined);
      const registry = await activateHostKit(createThreadTitlesHostExtension(), {
        runtimeOwner: () => "tau", thread: () => piThread({ isStreaming: () => true, nativeTitle: async () => native }),
        complete, setThreadTitle,
        registerTurnObserver: (value) => { observer = value; return () => undefined; },
      });
      await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { sessionId: "s1", prompt: "Screenshot.png" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(setThreadTitle).not.toHaveBeenCalled();
      expect(observer.pending!("s1")).toBe(1);
      native = "Eingeklappte Agenten";
      await vi.advanceTimersByTimeAsync(10_000);
      expect(setThreadTitle).toHaveBeenCalledWith("s1", "Eingeklappte Agenten", "generated");
      expect(observer.pending!("s1")).toBe(0);
      expect(complete).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("titles a deferred thread when its run ends although the turn's end found it still streaming", async () => {
    let streaming = true;
    let observer!: HostTurnObserver;
    const setThreadTitle = vi.fn(async () => undefined);
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => piThread({ isStreaming: () => streaming, nativeTitle: async () => undefined }),
      complete: async () => "Bildvorschau im Chat", setThreadTitle,
      registerTurnObserver: (value) => { observer = value; return () => undefined; },
    });
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { sessionId: "s1", prompt: "Fix it" });
    await observer.ended!("s1", "turn", "completed");
    expect(setThreadTitle).not.toHaveBeenCalled();
    streaming = false;
    await observer.runEnded!("s1", "completed");
    await vi.waitFor(() => expect(setThreadTitle).toHaveBeenCalledWith("s1", "Bildvorschau im Chat", "generated"));
    expect(observer.pending!("s1")).toBe(0);
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

  it("reopens a released thread for a title the user asked for, never for an automatic one", async () => {
    const released = piThread({ sessionId: "s2" });
    const reopenThread = vi.fn(async () => released);
    const setThreadTitle = vi.fn(async () => undefined);
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => undefined, reopenThread, complete: async () => "Pong check", setThreadTitle,
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { sessionId: "s2" })).rejects.toThrow(/not open any more/u);
    expect(reopenThread).not.toHaveBeenCalled();
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "regenerate", { sessionId: "s2" })).resolves.toEqual({ title: "Pong check" });
    expect(reopenThread).toHaveBeenCalledWith("s2");
    expect(setThreadTitle).toHaveBeenCalledWith("s2", "Pong check", "generated");
  });

  it("follows Text generation's runtime: Pi never asks the harness, the thread's runtime always does, Pi's effort only on Pi", async () => {
    const own = vi.fn(async () => "Harness title");
    const complete = vi.fn(async () => "Pi title");
    const harness = piThread({ backendKind: "claude-code", model: { provider: "anthropic", id: "sonnet" }, completionModels: async () => [{ provider: "anthropic", id: "haiku", name: "Haiku" }], complete: own });
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => harness, complete, setThreadTitle: async () => undefined,
      settings: async () => ({ options: {}, values: { instructions: "Use German." } }),
    });
    // Automatic: the harness offers the chosen model, so its login writes the title.
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "regenerate", { sessionId: "s1", provider: "anthropic", modelId: "haiku", thinkingLevel: "low" });
    expect(own).toHaveBeenLastCalledWith("anthropic", "haiku", expect.not.objectContaining({ thinkingLevel: expect.anything() }));
    expect(own).toHaveBeenLastCalledWith("anthropic", "haiku", expect.objectContaining({ system: titleSystemPrompt("Use German.") }));
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "regenerate", { sessionId: "s1", provider: "anthropic", modelId: "haiku", thinkingLevel: "low", runtime: "pi" });
    expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({ system: titleSystemPrompt("Use German."), thinkingLevel: "low", maxTokens: 16_384 }), { provider: "anthropic", id: "haiku" });
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "regenerate", { sessionId: "s1", runtime: "thread" });
    expect(own).toHaveBeenLastCalledWith("anthropic", "sonnet", expect.objectContaining({ system: titleSystemPrompt("Use German."), maxTokens: 256 }));
    expect(complete).toHaveBeenCalledOnce();
  });

  it("hands the attached Pi a small model, else the thread's own", async () => {
    const invoke = vi.fn(async () => ({ title: "Attached title" }));
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "pi", thread: () => undefined,
      attachedRuntime: () => ({ sessionId: "session", invoke } as never),
      completionModels: async () => [{ provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku" }],
    });
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { prefer: { provider: "anthropic", id: "claude-opus-4-1" } });
    expect(invoke).toHaveBeenCalledWith(THREAD_TITLES_HOST_EXTENSION_ID, "generate", expect.objectContaining({ provider: "anthropic", modelId: "claude-haiku-4-5", force: false, instructions: "", deferApply: true }));

    const bare = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "pi", thread: () => undefined,
      attachedRuntime: () => ({ sessionId: "session", invoke } as never),
      completionModels: async () => [],
    });
    await bare.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { prefer: { provider: "anthropic", id: "claude-opus-4-1" } });
    expect(invoke).toHaveBeenCalledWith(THREAD_TITLES_HOST_EXTENSION_ID, "generate", expect.objectContaining({ provider: "anthropic", modelId: "claude-opus-4-1", force: false, instructions: "", deferApply: true }));
  });

  it("forwards to the attached Pi terminal when it owns the runtime", async () => {
    const invoke = vi.fn(async () => ({ title: "Attached title" }));
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "pi", thread: () => undefined,
      attachedRuntime: () => ({ sessionId: "session", invoke } as never),
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", {
      provider: "provider", modelId: "model", force: false, sessionId: "session",
    })).resolves.toEqual({ title: "Attached title" });
    expect(invoke).toHaveBeenCalledWith(THREAD_TITLES_HOST_EXTENSION_ID, "generate", expect.objectContaining({
      provider: "provider", modelId: "model", force: false, instructions: "", deferApply: true, requestId: expect.any(String),
    }));
    expect(invoke).toHaveBeenCalledWith(THREAD_TITLES_HOST_EXTENSION_ID, "apply", { requestId: expect.any(String) });
  });

  it("reads instructions for the thread's project and uses the shared prompt on the runtime's own login", async () => {
    const complete = vi.fn(async () => "TAU-42 Warteschlange");
    const settings = vi.fn(async () => ({ options: {}, values: { instructions: "  Begin with TAU-42.\r\nUse German.  " } }));
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => piThread({ complete,
        completionModels: async () => [{ provider: "anthropic", id: "haiku", name: "Haiku" }] }),
      settings, setThreadTitle: async () => undefined,
    });
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { instructions: "Ignore stored settings" });
    expect(settings).toHaveBeenCalledWith(THREAD_TITLES_HOST_EXTENSION_ID, "/thread-project");
    expect(complete).toHaveBeenCalledWith("anthropic", "haiku", expect.objectContaining({
      system: titleSystemPrompt("Begin with TAU-42.\nUse German."),
    }));
  });

  it("keeps native titles ahead of custom instructions and uses the instructions when regenerating", async () => {
    const complete = vi.fn(async () => "TAU-42 Warteschlange");
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => piThread({ nativeTitle: async () => "Native title" }), complete,
      settings: async () => ({ options: {}, values: { instructions: "Begin with TAU-42." } }),
      setThreadTitle: async () => undefined,
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", {})).resolves.toEqual({ title: "Native title" });
    expect(complete).not.toHaveBeenCalled();
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "regenerate", {});
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ system: titleSystemPrompt("Begin with TAU-42.") }), undefined);
  });

  it("reads changed instructions when a deferred job settles and keeps its original thread", async () => {
    let streaming = true;
    let instructions = "Use English.";
    let observer!: HostTurnObserver;
    const complete = vi.fn(async () => "Warteschlange");
    const thread = piThread({ isStreaming: () => streaming, nativeTitle: async () => undefined });
    const threadLookup = vi.fn((sessionId?: string) => sessionId === "s1" || !sessionId && streaming ? thread : undefined);
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: threadLookup, complete,
      settings: async () => ({ options: {}, values: { instructions } }), setThreadTitle: async () => undefined,
      registerTurnObserver: (value) => { observer = value; return () => undefined; },
    });
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", {});
    instructions = "Use German.";
    streaming = false;
    await observer.ended!("s1", "turn", "completed");
    expect(threadLookup).toHaveBeenLastCalledWith("s1");
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ system: titleSystemPrompt("Use German.") }), undefined);
  });

  it("discards an in-flight title when instructions change", async () => {
    let instructions = "Use English.";
    const setThreadTitle = vi.fn();
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => piThread(), setThreadTitle,
      settings: async () => ({ options: {}, values: { instructions } }),
      complete: async () => { instructions = "Use German."; return "Old title"; },
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", {})).resolves.toBeUndefined();
    expect(setThreadTitle).not.toHaveBeenCalled();
  });

  it("rejects oversized stored instructions before inference", async () => {
    const complete = vi.fn();
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => piThread(), complete,
      settings: async () => ({ options: {}, values: { instructions: "x".repeat(TITLE_INSTRUCTIONS_LIMIT + 1) } }),
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", {})).rejects.toThrow("at most 2,000");
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps a manual rename even during explicit regeneration", async () => {
    let name = "Original title";
    const setThreadTitle = vi.fn();
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => piThread({ sessionName: () => name }), setThreadTitle,
      complete: async () => { name = "Manual rename"; return "Generated title"; },
    });
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "regenerate", {});
    expect(setThreadTitle).not.toHaveBeenCalled();
  });

  it("lets the newest regeneration win when completions return out of order", async () => {
    let finishFirst!: (title: string) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const complete = vi.fn(async () => "Newest title").mockImplementationOnce(() => {
      started();
      return new Promise<string>((resolve) => { finishFirst = resolve; });
    });
    const setThreadTitle = vi.fn(async () => undefined);
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => piThread(), complete, setThreadTitle,
    });
    const first = registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "regenerate", {});
    await firstStarted;
    await registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "regenerate", {});
    finishFirst("Obsolete title");
    await expect(first).resolves.toBeUndefined();
    expect(setThreadTitle).toHaveBeenCalledExactlyOnceWith("s1", "Newest title", "generated");
  });

  it.each(["close", "deactivate"])("discards an in-flight job on %s", async (action) => {
    let observer!: HostTurnObserver;
    const setThreadTitle = vi.fn();
    let registry!: Awaited<ReturnType<typeof activateHostKit>>;
    registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "tau", thread: () => piThread(), setThreadTitle,
      registerTurnObserver: (value) => { observer = value; return () => undefined; },
      complete: async () => {
        if (action === "close") await observer.closed!("s1");
        else await registry.deactivate(THREAD_TITLES_HOST_EXTENSION_ID);
        return "Obsolete title";
      },
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", {})).resolves.toBeUndefined();
    expect(setThreadTitle).not.toHaveBeenCalled();
  });

  it("passes saved instructions to attached Pi and discards the result if they changed before application", async () => {
    let instructions = "Use English.";
    const invoke = vi.fn(async (_id: string, command: string) => {
      if (command === "generate") { instructions = "Use German."; return { title: "Obsolete title" }; }
      return undefined;
    });
    const registry = await activateHostKit(createThreadTitlesHostExtension(), {
      runtimeOwner: () => "pi", attachedRuntime: () => ({ sessionId: "session", invoke }),
      thread: () => piThread(), settings: async () => ({ options: {}, values: { instructions } }),
    });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { provider: "p", modelId: "m" })).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(THREAD_TITLES_HOST_EXTENSION_ID, "generate", expect.objectContaining({ instructions: "Use English.", deferApply: true }));
    expect(invoke.mock.calls.some((call) => call[1] === "apply")).toBe(false);
    expect(invoke).toHaveBeenCalledWith(THREAD_TITLES_HOST_EXTENSION_ID, "cancel", { requestId: expect.any(String) });
  });

  it("refuses the permission it did not declare", async () => {
    const denied = { ...createThreadTitlesHostExtension(), permissions: [] };
    const registry = await activateHostKit(denied, { runtimeOwner: () => "tau", thread: () => piThread() });
    await expect(registry.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { provider: "openai", modelId: "gpt-5.6" }))
      .rejects.toThrow(/lacks permission sessions/u);
  });
});
