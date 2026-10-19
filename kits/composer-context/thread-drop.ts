import type { ChipPayloads } from "./protocol.js";

/** Browser drag data is untrusted, even when it advertises our MIME type. */
export function readThreadDrop(text: string): ChipPayloads["thread"] | undefined {
  if (text.length > 8_192) return undefined;
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const { threadId, title } = raw as Record<string, unknown>;
    if (typeof threadId !== "string" || !threadId.trim() || threadId.length > 512) return undefined;
    if (typeof title !== "string" || title.length > 4_096) return undefined;
    return { threadId, title: title.trim() };
  } catch { return undefined; }
}
