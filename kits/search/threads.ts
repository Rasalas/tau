import { THREAD_FIND_LIMIT, type ThreadFindResult, type ThreadMatch } from "./protocol.js";

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

/** Incremental JSONL collector shared by file reads and string callers. */
export class SessionTextCollector {
  readonly texts: ThreadText[] = [];
  chars = 0;
  truncated = false;

  line(line: string): void {
    let entry: Record<string, unknown>;
    try { entry = record(JSON.parse(line)); } catch { return; }
    const message = record(entry.message);
    if (entry.type !== "message" || (message.role !== "user" && message.role !== "assistant")) return;
    const text = messageText(message.content).trim();
    if (!text) return;
    const remaining = THREAD_TEXT_LIMIT - this.chars;
    if (text.length > remaining) this.truncated = true;
    if (remaining <= 0) return;
    // Copy out of the JSON line so a small slice cannot retain its tool payloads.
    const kept = Buffer.from(text.slice(0, remaining), "utf16le").toString("utf16le");
    this.texts.push({ role: message.role, text: kept });
    this.chars += kept.length;
  }
}

/** Compatibility helper; file callers feed the collector incrementally instead. */
export function sessionText(content: string): ThreadText[] {
  const collector = new SessionTextCollector();
  let start = 0;
  while (start < content.length && collector.chars < THREAD_TEXT_LIMIT) {
    const end = content.indexOf("\n", start);
    collector.line(content.slice(start, end < 0 ? undefined : end));
    if (end < 0) break;
    start = end + 1;
  }
  return collector.texts;
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

/** What a message holds for the find: its words and its reasoning, as the transcript draws them. */
export interface FindableMessage {
  id: string;
  role: string;
  text?: string;
  thinking?: string;
}

/** The ids of the messages whose text or reasoning holds the query, in order; case does not matter. */
export function findMessages(messages: readonly FindableMessage[], query: string): ThreadFindResult {
  const needle = query.trim().toLowerCase();
  const messageIds: string[] = [];
  if (!needle) return { messageIds, truncated: false };
  // Walk backwards so the retained ids never exceed the result limit plus one.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (!(message.text?.toLowerCase().includes(needle) || message.thinking?.toLowerCase().includes(needle))) continue;
    messageIds.push(message.id);
    if (messageIds.length > THREAD_FIND_LIMIT) return { messageIds: messageIds.slice(0, THREAD_FIND_LIMIT).reverse(), truncated: true };
  }
  return { messageIds: messageIds.reverse(), truncated: false };
}
