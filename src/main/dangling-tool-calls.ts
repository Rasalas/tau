/** A tool call an assistant message issued that never received a result. */
export interface DanglingToolCall {
  toolCallId: string;
  toolName: string;
}

/**
 * Finds tool calls left open by a turn that never finished. A provider rejects
 * the next request while one is outstanding, which wedges the thread; closing
 * them with a synthetic result makes it usable again.
 *
 * Deliberately conservative: only calls with no matching result are reported, so
 * repairing can never discard a real answer.
 */
export function findDanglingToolCalls(messages: readonly unknown[]): DanglingToolCall[] {
  const answered = new Set<string>();
  const issued = new Map<string, string>();

  for (const entry of messages) {
    const message = entry as { role?: unknown; toolCallId?: unknown; content?: unknown };
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      answered.add(message.toolCallId);
      continue;
    }
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      const call = part as { type?: unknown; id?: unknown; name?: unknown };
      if (call?.type !== "toolCall" || typeof call.id !== "string") continue;
      issued.set(call.id, typeof call.name === "string" ? call.name : "tool");
    }
  }

  return [...issued]
    .filter(([id]) => !answered.has(id))
    .map(([toolCallId, toolName]) => ({ toolCallId, toolName }));
}
