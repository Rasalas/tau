import type { ChipPayloads } from "./protocol.js";

/** Browser drag data is untrusted, even when it advertises our MIME type. */
export function readPullRequestDrop(text: string): ChipPayloads["pull-request"] | undefined {
  if (text.length > 16_384) return undefined;
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const { number, title, url, branch } = raw as Record<string, unknown>;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return undefined;
    if (typeof title !== "string" || !title.trim() || title.length > 4_096) return undefined;
    if (typeof url !== "string" || url.length > 4_096) return undefined;
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    if (branch !== undefined && (typeof branch !== "string" || branch.length > 1_024)) return undefined;
    return { number, title, url, ...(typeof branch === "string" ? { branch } : {}) };
  } catch { return undefined; }
}
