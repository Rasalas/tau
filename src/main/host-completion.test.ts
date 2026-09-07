import { describe, expect, it, vi } from "vitest";
import { HostCompletions } from "./host-completion.js";

function makeCompletions(options: {
  runtime: {
    getModel: (provider: string, id: string) => unknown;
    getModels: () => Array<{ provider: string; id: string }>;
    completeSimple: ReturnType<typeof vi.fn>;
  };
  defaults?: { provider?: string; model?: string };
  onCreate?: () => void;
}) {
  const completions = new HostCompletions({
    agentDir: "/agent",
    cwd: () => "/repo",
    createRuntime: async () => { options.onCreate?.(); return options.runtime as never; },
    settings: () => ({
      getDefaultProvider: () => options.defaults?.provider,
      getDefaultModel: () => options.defaults?.model,
    }),
  });
  return completions;
}

const answer = (text: string) => vi.fn(async () => ({ stopReason: "stop", content: [{ type: "text", text }] }));

function runtime(completeSimple = answer("  A title  "), models: Array<{ provider: string; id: string }> = [{ provider: "openai-codex", id: "gpt-5.6-luna" }]) {
  return {
    getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    getModels: () => models,
    completeSimple,
  };
}

describe("HostCompletions", () => {
  it("lists the user's own catalog, marking what a subscription login reaches", async () => {
    const runtimeWithLogins = {
      ...runtime(),
      getAvailable: async () => [{ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" }, { provider: "opencode-go", id: "kimi", name: undefined }],
      isUsingSubscription: (provider: string) => provider === "anthropic",
    };
    const completions = makeCompletions({ runtime: runtimeWithLogins as never });
    await expect(completions.models()).resolves.toEqual([
      { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5", login: "subscription" },
      { provider: "opencode-go", id: "kimi", name: "kimi" },
    ]);
  });

  it("completes with the named model and returns the trimmed text", async () => {
    const completeSimple = answer("  A title  ");
    const completions = makeCompletions({ runtime: runtime(completeSimple) });
    await expect(completions.complete({ system: "s", prompt: "p", maxTokens: 12 }, { provider: "openai-codex", id: "gpt-5.6-luna" })).resolves.toBe("A title");
    const [model, context, options] = completeSimple.mock.calls[0] as unknown as [unknown, { systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }> }, { maxTokens: number }];
    expect(model).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
    expect(context.systemPrompt).toBe("s");
    expect(context.messages[0]?.content[0]?.text).toBe("p");
    expect(options.maxTokens).toBe(12);
  });

  it("falls back to the default model of the user's Pi configuration", async () => {
    const completeSimple = answer("named");
    const completions = makeCompletions({ runtime: runtime(completeSimple), defaults: { provider: "openai-codex", model: "gpt-5.6-luna" } });
    await expect(completions.complete({ system: "s", prompt: "p" })).resolves.toBe("named");
    expect((completeSimple.mock.calls as unknown as Array<[unknown]>)[0]?.[0]).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
  });

  it("matches a default named without a provider by its id alone", async () => {
    const completeSimple = answer("named");
    const completions = makeCompletions({ runtime: runtime(completeSimple), defaults: { model: "gpt-5.6-luna" } });
    await expect(completions.complete({ system: "s", prompt: "p" })).resolves.toBe("named");
    expect((completeSimple.mock.calls as unknown as Array<[{ id: string }]>)[0]?.[0]).toMatchObject({ id: "gpt-5.6-luna" });
  });

  it("says what is missing when there is no model to complete with", async () => {
    await expect(makeCompletions({ runtime: runtime() }).complete({ system: "s", prompt: "p" }))
      .rejects.toThrow(/No model is configured/u);
    await expect(makeCompletions({ runtime: runtime() }).complete({ system: "s", prompt: "p" }, { provider: "google", id: "gemini-3.8-flash-low" }))
      .rejects.toThrow(/Unknown model: google\/gemini-3\.8-flash-low/u);
  });

  it("reports a model that failed, and builds its runtime only once", async () => {
    const onCreate = vi.fn();
    const failing = vi.fn(async () => ({ stopReason: "error", errorMessage: "out of credit", content: [] }));
    const completions = makeCompletions({ runtime: runtime(failing), onCreate });
    const model = { provider: "openai-codex", id: "gpt-5.6-luna" };
    await expect(completions.complete({ system: "s", prompt: "p" }, model)).rejects.toThrow("out of credit");
    await expect(completions.complete({ system: "s", prompt: "p" }, model)).rejects.toThrow("out of credit");
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
