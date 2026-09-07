import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { describeAccount, probeClaude } from "./probe.js";
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
