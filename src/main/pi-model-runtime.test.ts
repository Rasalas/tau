import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { createPiModelRuntime } from "./pi-model-runtime.js";

beforeEach(() => {
  vi.stubEnv("PI_OFFLINE", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const CATALOG_UNION_ALPHA = {
  id: "union-alpha",
  name: "Union Alpha Free",
  attachment: true,
  reasoning: true,
  tool_call: true,
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 262144, output: 131072 },
  provider: { npm: "@ai-sdk/anthropic" },
} as const;

const CATALOG_GPT = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  attachment: true,
  reasoning: true,
  tool_call: true,
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 1050000, output: 128000 },
  provider: { npm: "@ai-sdk/openai" },
} as const;

describe("createPiModelRuntime", () => {
  it("refreshes remote model catalogs while retaining Pi's persistent cache", async () => {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const create = vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
    const refresh = vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });

    await expect(createPiModelRuntime("/agent")).resolves.toBe(runtime);
    expect(create).toHaveBeenCalledWith({
      authPath: "/agent/auth.json",
      modelsPath: "/agent/models.json",
      refreshOnCreate: false,
    });
    expect(refresh).toHaveBeenLastCalledWith({ allowNetwork: true, signal: expect.any(AbortSignal) });
  });

  it("supplements opencode models from models.dev so new models stream through the native provider", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "tau-model-runtime-"));
    try {
      await writeFile(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            "opencode-go": {
              apiKey: "test-key",
              modelOverrides: { "union-alpha": { name: "My Union Alpha" } },
            },
          },
        }),
      );
      const catalog = {
        "opencode-go": {
          api: "https://opencode.ai/zen/go/v1",
          models: {
            "union-alpha": {
              id: "union-alpha",
              name: "Union Alpha Free",
              attachment: true,
              reasoning: true,
              tool_call: true,
              limit: { context: 262144, output: 131072 },
              provider: { npm: "@ai-sdk/anthropic" },
            },
          },
        },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(catalog), { headers: { "content-type": "application/json" } })),
      );

      const runtime = await createPiModelRuntime(agentDir);

      const model = runtime.getModel("opencode-go", "union-alpha");
      expect(model).toBeDefined();
      expect(model?.api).toBe("anthropic-messages");
      expect(model?.baseUrl).toBe("https://opencode.ai/zen/go");
      expect(model?.name).toBe("My Union Alpha");
      expect(runtime.getProvider("opencode-go")?.getModels().some((entry) => entry.id === "union-alpha")).toBe(true);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("supplements opencode models when models.json keeps the builtin composed", async () => {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const create = vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
    await runtime.setRuntimeApiKey("opencode-go", "test-key");
    await runtime.setRuntimeApiKey("opencode", "test-key");
    const registerNativeProvider = vi.spyOn(runtime, "registerNativeProvider");
    const modelsDev = {
      "opencode-go": { models: { "union-alpha": CATALOG_UNION_ALPHA } },
      opencode: { models: { "gpt-5.4": CATALOG_GPT } },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(modelsDev), { headers: { "content-type": "application/json" } })),
    );

    const result = await createPiModelRuntime("/agent");

    expect(result).toBe(runtime);
    expect(create).toHaveBeenCalledWith({
      authPath: "/agent/auth.json",
      modelsPath: "/agent/models.json",
      refreshOnCreate: false,
    });
    expect(registerNativeProvider).toHaveBeenCalledTimes(2);
    const registered = registerNativeProvider.mock.calls.map(([provider]) => provider);
    const go = registered.find((provider) => provider.id === "opencode-go");
    const zen = registered.find((provider) => provider.id === "opencode");
    expect(go?.getModels().map((model) => model.id)).toEqual([
      ...opencodeGoProvider().getModels().map((model) => model.id), "union-alpha",
    ]);
    expect(go?.getModels().find((model) => model.id === "union-alpha")).toMatchObject({
      id: "union-alpha",
      name: "Union Alpha Free",
      api: "anthropic-messages",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262_144,
      maxTokens: 131_072,
    });
    expect(zen?.getModels().map((model) => model.id)).toEqual([
      ...new Set([...opencodeProvider().getModels().map((model) => model.id), "gpt-5.4"]),
    ]);
    expect(zen?.getModels().find((model) => model.id === "gpt-5.4")).toMatchObject({
      id: "gpt-5.4",
      api: "openai-responses",
      provider: "opencode",
    });
    expect(result.getModel("opencode-go", "union-alpha")).toEqual(
      go?.getModels().find((model) => model.id === "union-alpha"),
    );
  });
});
