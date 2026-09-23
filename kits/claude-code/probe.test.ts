import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { describeAccount, parseClaudeModelId, probeClaude, probeNewThreadCatalog, readClaudeVersion, versionedModelName } from "./probe.js";
import type { ClaudeQuery } from "./runtime-adapter.js";

const frame = <T extends object>(value: T): SDKMessage => ({ uuid: "u", session_id: "s", ...value }) as unknown as SDKMessage;

function probeQuery(options: { hang?: boolean } = {}) {
  let received: { prompt: unknown; options?: Options } | undefined;
  let pulled = 0;
  const initializationResult = vi.fn(async () => {
    if (options.hang) await new Promise(() => undefined);
    return {
      commands: [], agents: [], output_style: "default", available_output_styles: [],
      models: [{ value: "opus", displayName: "Opus", description: "best", supportedEffortLevels: ["low", "high", "max"] }, { value: "sonnet", displayName: "Sonnet", description: "fast" }],
      account: { email: "me@example.com", subscriptionType: "max", tokenSource: "claude.ai", apiProvider: "firstParty" },
    };
  });
  const query = ((params: { prompt: AsyncIterable<unknown>; options?: Options }) => {
    received = params;
    async function* run(): AsyncGenerator<SDKMessage, void> {
      yield frame({ type: "system", subtype: "init", model: "claude-opus-5[1m]", claude_code_version: "2.1.263", effort: "high", apiKeySource: "none" });
      // The prompt never yields; the CLI would wait for input here.
      for await (const message of params.prompt) { pulled += 1; void message; }
    }
    return Object.assign(run(), { initializationResult, interrupt: vi.fn(), setPermissionMode: vi.fn(), setModel: vi.fn(), supportedModels: vi.fn() }) as unknown as ReturnType<ClaudeQuery>;
  }) as unknown as ClaudeQuery;
  return { query, received: () => received, pulled: () => pulled, initializationResult };
}

describe("probeClaude", () => {
  it("reads account, models and the init frame from a session that never sends a prompt, then aborts it", async () => {
    const { query, received, pulled } = probeQuery();
    const probe = await probeClaude({ query, executable: "/opt/claude", cwd: "/home", env: { PATH: "/bin" }, now: () => 7 });
    expect(probe).toEqual({
      models: [{ provider: "anthropic", id: "opus", name: "Opus" }, { provider: "anthropic", id: "sonnet", name: "Sonnet" }],
      modelInfos: expect.any(Array),
      account: { email: "me@example.com", subscriptionType: "max", tokenSource: "claude.ai", apiProvider: "firstParty" },
      claudeCodeVersion: "2.1.263",
      defaultModel: "claude-opus-5[1m]",
      effort: "high",
      probedAt: 7,
    });
    // Locked down: no hooks, nothing persisted, no tools, no MCP; aborted once answered.
    expect(received()?.options).toMatchObject({ pathToClaudeCodeExecutable: "/opt/claude", cwd: "/home", persistSession: false, settings: { disableAllHooks: true }, allowedTools: [], mcpServers: {}, strictMcpConfig: true, permissionMode: "plan" });
    expect(received()?.options?.abortController?.signal.aborted).toBe(true);
    expect(pulled()).toBe(0);
  });

  it("gives up after the timeout and still aborts the session", async () => {
    const { query, received } = probeQuery({ hang: true });
    await expect(probeClaude({ query, executable: "claude", cwd: "/home", env: {}, timeoutMs: 20 })).rejects.toThrow("did not report its account and models within 20 ms");
    expect(received()?.options?.abortController?.signal.aborted).toBe(true);
  });

  it("describes the login for the status page", () => {
    expect(describeAccount({ subscriptionType: "max", apiProvider: "firstParty" })).toBe("Claude max");
    expect(describeAccount({ apiProvider: "bedrock" })).toBe("via bedrock");
    expect(describeAccount({ tokenSource: "apiKey" })).toBe("API key");
    expect(describeAccount(undefined, "ANTHROPIC_API_KEY")).toBe("API key (ANTHROPIC_API_KEY)");
    expect(describeAccount(undefined, "none")).toBe("signed in");
  });
});

describe("versionedModelName", () => {
  it("puts the generation back into a display name that dropped it", () => {
    expect(versionedModelName({ value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5" })).toBe("Sonnet 5");
    expect(versionedModelName({ value: "opus[1m]", displayName: "Opus (1M context)", resolvedModel: "claude-opus-5[1m]" })).toBe("Opus 5 (1M context)");
    expect(versionedModelName({ value: "claude-fable-5-1[1m]", displayName: "Fable" })).toBe("Fable 5.1");
    expect(versionedModelName({ value: "default", displayName: "Default (recommended)", resolvedModel: "claude-sonnet-5" })).toBe("Default (recommended) · Sonnet 5");
    expect(versionedModelName({ value: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-4-5-20251001" })).toBe("Haiku 4.5");
  });

  it("leaves names that carry a version, or ids it cannot read, alone", () => {
    expect(versionedModelName({ value: "claude-sonnet-5", displayName: "Claude Sonnet 5" })).toBe("Claude Sonnet 5");
    expect(versionedModelName({ value: "default", displayName: "Default (recommended)" })).toBe("Default (recommended)");
    expect(parseClaudeModelId("gpt-5")).toBeUndefined();
  });
});

describe("readClaudeVersion", () => {
  const run = (stdout: string): never => ((_command: string, _args: string[], _options: unknown, done: (error: Error | null, result: { stdout: string; stderr: string }) => void) => done(null, { stdout, stderr: "" })) as never;

  it("reads the version out of what the binary prints", async () => {
    expect(await readClaudeVersion("claude", run("2.1.263 (Claude Code)\n"))).toBe("2.1.263");
    expect(await readClaudeVersion("claude", run("no version here"))).toBeUndefined();
  });

  it("stays quiet when the binary cannot be run", async () => {
    const failing = ((_command: string, _args: string[], _options: unknown, done: (error: Error) => void) => done(new Error("ENOENT"))) as never;
    expect(await readClaudeVersion("claude", failing)).toBeUndefined();
  });
});

describe("describeAccount plans", () => {
  it("never doubles the vendor's name when the plan already carries it", () => {
    expect(describeAccount({ subscriptionType: "Claude Max" })).toBe("Claude Max");
    expect(describeAccount({ subscriptionType: "Max" })).toBe("Claude Max");
  });

  it("offers a draft the plan's models, starting on the one the CLI picks, with each model's efforts", () => {
    const modelInfos = [
      { value: "default", displayName: "Default (recommended)", description: "", resolvedModel: "claude-sonnet-5" },
      { value: "haiku", displayName: "Haiku", description: "", resolvedModel: "claude-haiku-4-5", supportedEffortLevels: ["low"] },
    ] as never;
    const catalog = probeNewThreadCatalog({ modelInfos, defaultModel: "claude-haiku-4-5", effort: "medium" });
    expect(catalog.model?.id).toBe("haiku");
    expect(catalog.models.map((model) => model.id)).toEqual(["default", "haiku"]);
    expect(catalog.thinkingLevels).toEqual({ default: ["default (medium)", "low", "medium", "high", "xhigh", "max"], haiku: ["default (medium)", "low"] });
    expect(probeNewThreadCatalog({ modelInfos, defaultModel: "unknown" }).model?.id).toBe("default");
  });

  it("prices an alias by the id it resolves to and says how the plan is paid", () => {
    const modelInfos = [{ value: "haiku", displayName: "Haiku", description: "", resolvedModel: "claude-haiku-4-5", supportedEffortLevels: ["low"] }] as never;
    const plan = probeNewThreadCatalog({ modelInfos, account: { subscriptionType: "max", apiProvider: "firstParty" } });
    expect(plan.models[0]).toMatchObject({ id: "haiku", apiModelId: "claude-haiku-4-5", billing: "subscription", reasoning: true });
    expect(probeNewThreadCatalog({ modelInfos, account: { apiKeySource: "ANTHROPIC_API_KEY" } }).models[0]?.billing).toBe("api-key");
    expect(probeNewThreadCatalog({ modelInfos, account: { apiProvider: "bedrock" } }).models[0]?.billing).toBe("api-key");
    expect(probeNewThreadCatalog({ modelInfos }).models[0]?.billing).toBeUndefined();
  });
});

