import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { interruptedResult, isSuccessfulResult, resultErrorText } from "./result-error.js";

export class ClaudeAuthenticationError extends Error {
  constructor(detail: string) {
    super(`Claude Code could not authenticate. Sign in again in Settings → Runtimes on this thread's home machine, or run \`claude auth login\` there. For an API-key account, check its configured credentials.${detail ? `\n${detail}` : ""}`);
    this.name = "ClaudeAuthenticationError";
  }
}

const FAILED_AUTH = /(?:failed to|could not) authenticate|authentication[_ ]failed|not logged in|OAuth session expired|invalid(?: or expired)? (?:access |refresh )?token|invalid[_ ]grant/iu;
const LOGIN_REQUIRED = /\b401\b|\bunauthorized\b|(?:invalid|expired|missing) (?:api[- ]?key|credentials)|(?:log|sign)[ -]?in|\/login\b/iu;
const PERMISSION_DENIED = /\b403\b|\bforbidden\b|\bpermissions?\b|\bnot (?:allowed|permitted)\b|\b(?:does not|do not|doesn't|don't) have access\b|\baccess denied\b/iu;

export function authenticationException(error: unknown): ClaudeAuthenticationError | undefined {
  return error instanceof Error && !PERMISSION_DENIED.test(error.message) && FAILED_AUTH.test(error.message) ? new ClaudeAuthenticationError(error.message) : undefined;
}

/** Only provider error frames count; ordinary replies and tool output may discuss login errors. */
export function authenticationFailure(message: SDKMessage): ClaudeAuthenticationError | undefined {
  if (message.type === "assistant" && message.error === "authentication_failed") {
    const text = message.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    // The label also covers 403s; ambiguous frames need the result's status and text.
    if (PERMISSION_DENIED.test(text) || (!FAILED_AUTH.test(text) && !LOGIN_REQUIRED.test(text))) return undefined;
    return new ClaudeAuthenticationError(text);
  }
  if (message.type === "result" && !isSuccessfulResult(message) && !interruptedResult(message)) {
    const text = resultErrorText(message);
    const status = message.subtype === "success" ? message.api_error_status : undefined;
    // An explicit provider status outranks words in a final reply about login.
    if (status != null && status >= 400) return status === 401 ? new ClaudeAuthenticationError(text) : undefined;
    if (PERMISSION_DENIED.test(text)) return undefined;
    if (FAILED_AUTH.test(text) || (message.terminal_reason === "api_error" && LOGIN_REQUIRED.test(text))) return new ClaudeAuthenticationError(text);
  }
  return undefined;
}
