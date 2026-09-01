import type { UiToolOutputReadResult } from "./contracts.js";

/** Maximum UTF-16 characters returned by one bridge page. */
export const TOOL_OUTPUT_READ_PAGE_CHARACTERS = 8 * 1024;

/**
 * Return the complete result for a deliberate output read. Preview strings
 * never reach this helper, and the explicit action must not silently lose a
 * suffix at an arbitrary byte ceiling.
 */
export function completeToolOutputRead(toolCallId: string, output: string): UiToolOutputReadResult {
  const bytes = new TextEncoder().encode(output);
  return { toolCallId, output, totalBytes: bytes.byteLength, truncated: false };
}

export function toolOutputByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
