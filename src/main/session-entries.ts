/** Helpers over Pi's raw session entries that core needs for its own events. */

/**
 * Resolves an assistant's durable session-entry id without depending on the
 * runtime that owns the branch. The host uses this after `message_end` has
 * persisted the entry, while the bridge passes its ExtensionContext through
 * the convenience wrapper below.
 */
export function assistantAnchorForBranch(entries: readonly unknown[], message: unknown): string | undefined {
  const branch = [...entries].reverse();
  const exact = branch.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const item = entry as { type?: unknown; id?: unknown; message?: unknown };
    return item.type === "message"
      && typeof item.id === "string"
      && item.message !== null
      && typeof item.message === "object"
      && (item.message as { role?: unknown }).role === "assistant"
      && item.message === message;
  });
  if (exact && typeof (exact as { id?: unknown }).id === "string") return (exact as { id: string }).id;
  if (!message || typeof message !== "object") return undefined;
  const value = message as { timestamp?: unknown; stopReason?: unknown };
  const fallback = branch.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const item = entry as { type?: unknown; id?: unknown; message?: unknown };
    if (item.type !== "message" || typeof item.id !== "string" || !item.message || typeof item.message !== "object") return false;
    const candidate = item.message as { role?: unknown; timestamp?: unknown; stopReason?: unknown };
    return candidate.role === "assistant"
      && (typeof value.timestamp !== "number" || candidate.timestamp === value.timestamp)
      && (typeof value.stopReason !== "string" || candidate.stopReason === value.stopReason);
  });
  return fallback && typeof (fallback as { id?: unknown }).id === "string"
    ? (fallback as { id: string }).id
    : undefined;
}

