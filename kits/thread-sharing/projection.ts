import type { HostPublicTools, UiMessage } from "tau/host-extension";
import { sanitizePublicToolOutput } from "tau/host-extension";
import type { GuestMessage, GuestTool } from "./protocol.js";

/** Build an allowlist, never serialize a message or its runtime entry wholesale. */
export function guestTranscript(messages: readonly Pick<UiMessage, "role" | "text" | "kind" | "excludedFromContext">[], activity: HostPublicTools = { tools: [], truncated: false }, showToolOutput = false): { messages: GuestMessage[]; tools: GuestTool[]; truncated: boolean } {
  const projected: GuestMessage[] = [];
  let remaining = 200_000;
  let truncated = false;
  // Bound both the number of rows and UTF-16 text. The newest conversation survives.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if ((message.role !== "user" && message.role !== "assistant") || message.kind || message.excludedFromContext || typeof message.text !== "string") continue;
    if (!message.text) continue;
    if (projected.length >= 500 || remaining <= 0) { truncated = true; break; }
    const text = message.text.slice(-Math.min(32_000, remaining));
    if (text.length !== message.text.length) truncated = true;
    projected.push({ role: message.role, text });
    remaining -= text.length;
  }
  const tools = boundGuestTools(activity.tools, showToolOutput, remaining, 500 - projected.length);
  return { messages: projected.reverse(), tools: tools.tools, truncated: truncated || tools.truncated || activity.truncated };
}

/** A second allowlist at the grant/cache/HTTP boundary. Input is already public host activity. */
export function boundGuestTools(activity: readonly GuestTool[], showToolOutput: boolean, budget: number, rows = 500): { tools: GuestTool[]; truncated: boolean } {
  const tools: GuestTool[] = [];
  let truncated = false;
  let remaining = Math.max(0, budget);
  for (let index = activity.length - 1; index >= 0; index--) {
    const tool = activity[index]!;
    if (!tool || typeof tool.name !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(tool.name) || /secret|credential|password|token|auth/iu.test(tool.name) || !["running", "done", "error"].includes(tool.status)) continue;
    if (tools.length >= Math.min(rows, 500) || remaining < tool.name.length) { truncated = true; break; }
    remaining -= tool.name.length;
    const row: GuestTool = { name: tool.name, status: tool.status };
    if (showToolOutput === true && typeof tool.output === "string") {
      const clean = sanitizePublicToolOutput(tool.name, tool.output);
      if (clean !== undefined) {
        const limit = Math.min(32_000, remaining);
        if (limit > 0 && clean) row.output = clean.slice(-limit);
        if (tool.output.length > 32_000 || clean.length > limit || tool.outputTruncated === true) { row.outputTruncated = true; truncated = true; }
        remaining -= row.output?.length ?? 0;
      }
    }
    tools.push(row);
  }
  return { tools: tools.reverse(), truncated };
}
