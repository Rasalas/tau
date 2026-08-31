import type { UiToolOutputReadResult } from "./contracts.js";

/**
 * A deliberate ceiling for an explicit tool-output read. Transcript previews
 * are much smaller; this limit only protects a conscious copy action from
 * turning one unusually large result into an unbounded IPC payload.
 */
export const MAX_TOOL_OUTPUT_READ_BYTES = 8 * 1024 * 1024;

/** Maximum UTF-16 characters returned by one bridge page. */
export const TOOL_OUTPUT_READ_PAGE_CHARACTERS = 8 * 1024;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Return an explicitly bounded result for a deliberate output read. The
 * renderer can distinguish a complete read from a safety-truncated one using
 * `truncated`; preview strings never reach this helper.
 */
export function boundedToolOutputRead(toolCallId: string, output: string): UiToolOutputReadResult {
  const bytes = new TextEncoder().encode(output);
  if (bytes.byteLength <= MAX_TOOL_OUTPUT_READ_BYTES) {
    return { toolCallId, output, totalBytes: bytes.byteLength, truncated: false };
  }
  const bounded = new TextDecoder().decode(bytes.slice(0, MAX_TOOL_OUTPUT_READ_BYTES));
  return {
    toolCallId,
    output: bounded,
    totalBytes: bytes.byteLength,
    truncated: true,
  };
}

export function toolOutputByteLength(value: string): number {
  return byteLength(value);
}
