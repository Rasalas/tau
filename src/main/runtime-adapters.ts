import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { PI_RUNTIME_ADAPTER, type SkillRuntimeAdapter } from "./skill-invocation.js";

const execFileAsync = promisify(execFile);

export interface RuntimePromptInput {
  cwd: string;
  sessionId: string;
  text: string;
  delivery?: "prompt" | "steer" | "followUp";
  clientMessageId?: string;
}

export interface RuntimePromptResult {
  assistantText?: string;
}

export interface RuntimeTransport {
  sendPrompt(input: RuntimePromptInput): Promise<RuntimePromptResult>;
}

export interface PiAgentRuntimeAdapter extends SkillRuntimeAdapter {
  readonly id: "pi";
  readonly capabilities: { readonly skillInvocationDialect: "pi" };
  readonly transport?: never;
}

export interface ClaudeCodeAgentRuntimeAdapter extends SkillRuntimeAdapter {
  readonly id: "claude-code";
  readonly capabilities: { readonly skillInvocationDialect: "claude-code" };
  readonly transport: RuntimeTransport;
}

export type AgentRuntimeAdapter = PiAgentRuntimeAdapter | ClaudeCodeAgentRuntimeAdapter;

/** Rejects an adapter whose declared dialect does not belong to its transport. */
export function assertRuntimeAdapter(adapter: unknown): AgentRuntimeAdapter {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("A runtime adapter configuration is required.");
  }
  const candidate = adapter as {
    id?: unknown;
    capabilities?: { skillInvocationDialect?: unknown };
    transport?: RuntimeTransport;
  };
  if (candidate.id !== "pi" && candidate.id !== "claude-code") {
    throw new Error(`Unsupported runtime adapter '${String(candidate.id)}'.`);
  }
  const expectedDialect = candidate.id === "claude-code" ? "claude-code" : "pi";
  if (candidate.capabilities?.skillInvocationDialect !== expectedDialect) {
    throw new Error(`Runtime adapter '${candidate.id}' must declare the '${expectedDialect}' invocation dialect.`);
  }
  if (candidate.id === "pi" && candidate.transport !== undefined) {
    throw new Error("The Pi runtime adapter must not define a second transport.");
  }
  if (candidate.id === "claude-code" && (!candidate.transport || typeof candidate.transport.sendPrompt !== "function")) {
    throw new Error("The Claude Code runtime adapter requires a configured transport.");
  }
  return adapter as AgentRuntimeAdapter;
}

export const PI_AGENT_RUNTIME_ADAPTER: PiAgentRuntimeAdapter = {
  id: "pi",
  capabilities: PI_RUNTIME_ADAPTER.capabilities,
};

export interface ClaudeCodeRuntimeOptions {
  command?: string;
  maxBuffer?: number;
}

/**
 * Production Claude Code transport. It owns the Claude process and therefore
 * never hands Claude's slash dialect to the embedded Pi session.
 */
export function createClaudeCodeRuntimeAdapter(options: ClaudeCodeRuntimeOptions = {}): ClaudeCodeAgentRuntimeAdapter {
  const command = options.command ?? process.env.TAU_CLAUDE_CODE_COMMAND ?? "claude";
  const maxBuffer = options.maxBuffer ?? 8 * 1024 * 1024;
  const sessions = new Map<string, string>();
  const startedSessions = new Set<string>();
  const capabilities = { skillInvocationDialect: "claude-code" } as const;
  return {
    id: "claude-code",
    capabilities,
    transport: {
      async sendPrompt(input) {
        let claudeSessionId = sessions.get(input.sessionId);
        if (!claudeSessionId) {
          claudeSessionId = randomUUID();
          sessions.set(input.sessionId, claudeSessionId);
        }
        const args = [
          "--print",
          "--output-format",
          "text",
          ...(startedSessions.has(input.sessionId) ? ["--resume", claudeSessionId] : ["--session-id", claudeSessionId]),
          input.text,
        ];
        try {
          const result = await execFileAsync(command, args, {
            cwd: input.cwd,
            maxBuffer,
            windowsHide: true,
          });
          startedSessions.add(input.sessionId);
          return { assistantText: result.stdout };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Claude Code runtime failed: ${detail}`);
        }
      },
    },
  };
}

/** Selects the actual agent transport once during host startup. */
export function selectRuntimeAdapter(value: string | undefined = process.env.TAU_RUNTIME_ADAPTER): AgentRuntimeAdapter {
  switch (value?.trim().toLowerCase() || "pi") {
    case "pi":
      return PI_AGENT_RUNTIME_ADAPTER;
    case "claude-code":
      return createClaudeCodeRuntimeAdapter();
    default:
      throw new Error(`Unsupported TAU_RUNTIME_ADAPTER '${value}'. Use 'pi' or 'claude-code'.`);
  }
}
