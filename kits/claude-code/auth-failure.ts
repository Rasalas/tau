import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export class ClaudeAuthenticationError extends Error {
  constructor(detail: string) {
    super(`Claude Code could not authenticate. Sign in again in Settings → Providers on this thread's home machine, or run \`claude auth login\` there. For an API-key account, check its configured credentials.${detail ? `\n${detail}` : ""}`);
    this.name = "ClaudeAuthenticationError";
  }
}

const FAILED_AUTH = /(?:failed to|could not) authenticate|authentication[_ ]failed|not logged in|OAuth session expired|invalid(?: or expired)? (?:access |refresh )?token|invalid[_ ]grant/iu;

export function authenticationException(error: unknown): ClaudeAuthenticationError | undefined {
  return error instanceof Error && FAILED_AUTH.test(error.message) ? new ClaudeAuthenticationError(error.message) : undefined;
}

/** Only provider error frames count; ordinary replies and tool output may discuss login errors. */
export function authenticationFailure(message: SDKMessage): ClaudeAuthenticationError | undefined {
  if (message.type === "assistant" && message.error === "authentication_failed") {
    const text = message.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    return new ClaudeAuthenticationError(text);
  }
  if (message.type === "result" && (message.is_error || message.subtype !== "success")) {
    const candidate = message as { errors?: string[]; result?: string };
    const text = [...candidate.errors ?? [], candidate.result ?? ""].filter(Boolean).join("\n");
    if (FAILED_AUTH.test(text)) return new ClaudeAuthenticationError(text);
  }
  return undefined;
}
