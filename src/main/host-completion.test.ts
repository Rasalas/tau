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
  reports?: ConstructorParameters<typeof HostCompletions>[0]["reports"];
}) {
  const completions = new HostCompletions({
    agentDir: "/agent",
    cwd: () => "/repo",
    createRuntime: async () => { options.onCreate?.(); return options.runtime as never; },
    settings: () => ({
      getDefaultProvider: () => options.defaults?.provider,
      getDefaultModel: () => options.defaults?.model,
    }),
    ...(options.reports ? { reports: options.reports } : {}),
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

  it("offers a subscription's model only where the vendor's own login names it", async () => {
    const runtimeWithLogins = {
      ...runtime(),
      getAvailable: async () => [
        { provider: "openai-codex", id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
        { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
        { provider: "openai", id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
      ],
      isUsingSubscription: (provider: string) => provider === "openai-codex",
    };
    const reports = vi.fn(async () => [{ models: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna", billing: "subscription" as const }] }]);
    const completions = makeCompletions({ runtime: runtimeWithLogins as never, reports });
    await expect(completions.models()).resolves.toEqual([
      { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", login: "subscription" },
      { provider: "openai", id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
    ]);
    // A report that cannot be read leaves Pi's list as it is.
    reports.mockRejectedValueOnce(new Error("no catalogs"));
    await expect(completions.models()).resolves.toHaveLength(3);
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

  it("attaches required session and client headers for OpenCode completions", async () => {
    const completeSimple = answer("opencode completion");
    const opencodeModel = { provider: "opencode-go", id: "kimi-k2.7-code" };
    const completions = makeCompletions({ runtime: runtime(completeSimple, [opencodeModel]) });
    await expect(completions.complete({ system: "s", prompt: "p" }, opencodeModel)).resolves.toBe("opencode completion");
    const [, , options] = completeSimple.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { sessionId: string; headers?: Record<string, string> },
    ];
    expect(options.sessionId).toBeTruthy();
    expect(options.headers).toEqual({
      "x-opencode-session": options.sessionId,
      "x-opencode-client": "pi",
    });
  });
});
