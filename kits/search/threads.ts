import type { ThreadMatch } from "./protocol.js";

/**
 * What a thread said, as the palette searches it: the text of every user and
 * assistant message in its Pi session file, without tool calls or thinking.
 */
export interface ThreadText {
  role: "user" | "assistant";
  text: string;
}

/** A thread holds at most this much text for searching; the start of a long thread is kept. */
export const THREAD_TEXT_LIMIT = 400_000;
const SNIPPET = 90;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const block = record(part);
    return block.type === "text" && typeof block.text === "string" ? block.text : "";
  }).filter(Boolean).join("\n");
}

export function sessionText(content: string): ThreadText[] {
  const texts: ThreadText[] = [];
  let total = 0;
  for (const line of content.split("\n")) {
    if (!line.includes('"type":"message"')) continue;
    let entry: Record<string, unknown>;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    const message = record(entry.message);
    if (entry.type !== "message" || (message.role !== "user" && message.role !== "assistant")) continue;
    const text = messageText(message.content).trim();
    if (!text) continue;
    texts.push({ role: message.role, text });
    total += text.length;
    if (total >= THREAD_TEXT_LIMIT) break;
  }
  return texts;
}

export function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/u).filter(Boolean);
}

/** A line's worth of text around the first place the query was found, whitespace folded. */
export function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 30);
  const end = Math.min(text.length, Math.max(at + length, start + SNIPPET));
  const cut = text.slice(start, end).replace(/\s+/gu, " ").trim();
  return `${start > 0 ? "…" : ""}${cut}${end < text.length ? "…" : ""}`;
}

/**
 * The first message holding every word of the query, as a snippet: the whole
 * query where it appears as written, otherwise the first word.
 */
export function findInThread(texts: readonly ThreadText[], tokens: readonly string[], phrase: string): Pick<ThreadMatch, "role" | "snippet"> | undefined {
  if (tokens.length === 0) return undefined;
  for (const entry of texts) {
    const lower = entry.text.toLowerCase();
    if (!tokens.every((token) => lower.includes(token))) continue;
    const whole = lower.indexOf(phrase);
    const at = whole >= 0 ? whole : lower.indexOf(tokens[0]!);
    return { role: entry.role, snippet: snippetAround(entry.text, at, whole >= 0 ? phrase.length : tokens[0]!.length) };
  }
  return undefined;
}
