import type { SDKResultMessage, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";

/** Terminal failures can arrive in a success envelope, even with is_error=false. */
function terminalError(reason: SDKResultMessage["terminal_reason"]): string | undefined {
  switch (reason) {
    case "api_error": return "Claude gave up after repeated API errors.";
    case "blocking_limit": return "Claude stopped because a limit was reached.";
    case "rapid_refill_breaker": return "Claude stopped: the context refilled too quickly after compaction.";
    case "prompt_too_long": return "The prompt is too long.";
    case "image_error": return "Claude could not process an image in the conversation.";
    case "model_error": return "Claude stopped because the model returned an error.";
    case "malformed_tool_use_exhausted": return "Claude gave up after repeated malformed tool calls.";
    case "max_turns": return "Claude reached the turn limit.";
    case "budget_exhausted": return "Claude exhausted the turn's token budget.";
    case "structured_output_retry_exhausted": return "Claude could not produce the requested structured output.";
    case "tool_deferred_unavailable": return "Claude could not resume a deferred tool call: the tool is no longer available.";
    case "turn_setup_failed": return "Claude could not start the turn.";
    case "aborted_streaming":
    case "aborted_tools": return "Claude Code turn was interrupted.";
    default: return undefined;
  }
}

export function isSuccessfulResult(message: SDKResultMessage): message is SDKResultSuccess & { is_error: false } {
  return message.subtype === "success" && !message.is_error
    && !(message.api_error_status != null && message.api_error_status >= 400)
    && terminalError(message.terminal_reason) === undefined;
}

/** Old CLIs report stops only through diagnostics; explicit failures take precedence. */
export function interruptedResult(message: SDKResultMessage): boolean {
  if (message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools") return true;
  if (message.terminal_reason !== undefined || message.subtype === "success") return false;
  return message.errors.length > 0 && message.errors.every((error) => /^\[ede_diagnostic\]/u.test(error) || /interrupted|aborted/iu.test(error));
}

/** Keep provider details, but never present internal diagnostics or a prior reply as an API failure. */
export function resultErrorText(message: SDKResultMessage): string {
  const listed = message.subtype === "success" ? [] : message.errors.map((error) => error.trim()).filter((error) => error && !/^\[ede_diagnostic\]/u.test(error));
  if (listed.length) return listed.join("\n");
  const result = message.subtype === "success" ? message.result.trim() : "";
  if (message.terminal_reason === "api_error") {
    return result.startsWith("API Error:") ? result : terminalError(message.terminal_reason)!;
  }
  return result || terminalError(message.terminal_reason) || message.subtype;
}
