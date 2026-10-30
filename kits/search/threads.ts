import { THREAD_FIND_LIMIT, type ThreadFindInput, type ThreadFindResult, type ThreadMatch } from "./protocol.js";
import { foldSearchText, textMatch } from "./relevance.js";

/**
 * What a thread said, as the palette searches it: the text of every user and
 * assistant message in its Pi session file, without tool calls or thinking.
 */
export interface ThreadText {
  role: "user" | "assistant";
  text: string;
}

/** Cached Pi text keeps this many characters, split between the start and end when it is too long. */
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

/** Prefix collector for bounded cold reads; it reports every omitted character. */
export class SessionTextCollector {
  readonly texts: ThreadText[] = [];
  chars = 0;
  truncated = false;

  line(line: string): void {
    const entry = sessionLineText(line);
    if (!entry) return;
    const remaining = THREAD_TEXT_LIMIT - this.chars;
    if (entry.text.length > remaining) this.truncated = true;
    if (remaining <= 0) return;
    // Copy the slice so cached text cannot retain a large parsed record.
    const kept = Buffer.from(entry.text.slice(0, remaining), "utf16le").toString("utf16le");
    this.texts.push({ role: entry.role, text: kept });
    this.chars += kept.length;
  }
}

/** One append-only file can be much larger than its cached search text. */
export class ThreadTextWindow {
  private head: ThreadText[] = [];
  private tail: ThreadText[] = [];
  private tailAt = 0;
  private chars = 0;
  private clipped = false;

  add(entry: ThreadText): void {
    if (!entry.text) return;
    this.tail.push(entry);
    this.chars += entry.text.length;
    if (!this.clipped && this.chars > THREAD_TEXT_LIMIT) {
      // Freeze the opening half only once. Until the cap is crossed, messages
      // stay whole, including one that straddles the halfway point.
      let left = THREAD_TEXT_LIMIT / 2;
      while (left > 0) {
        const first = this.tail[this.tailAt]!;
        const kept = Math.min(left, first.text.length);
        this.head.push({ role: first.role, text: first.text.slice(0, kept) });
        this.chars -= kept;
        left -= kept;
        this.tail[this.tailAt] = { role: first.role, text: first.text.slice(kept) };
        if (kept === first.text.length) this.tailAt += 1;
      }
      this.clipped = true;
    }
    while (this.clipped && this.chars > THREAD_TEXT_LIMIT / 2) {
      const first = this.tail[this.tailAt]!;
      const removed = Math.min(this.chars - THREAD_TEXT_LIMIT / 2, first.text.length);
      this.chars -= removed;
      this.tail[this.tailAt] = { role: first.role, text: first.text.slice(removed) };
      if (removed === first.text.length) this.tailAt += 1;
    }
    if (this.tailAt >= 1_000) {
      this.tail = this.tail.slice(this.tailAt);
      this.tailAt = 0;
    }
  }

  texts(): ThreadText[] {
    // The two ends remain separate messages across an omitted section, so
    // words on opposite sides of that gap never invent a phrase match.
    return [...this.head, ...this.tail.slice(this.tailAt)];
  }
}

export function sessionLineText(line: string): ThreadText | undefined {
  let entry: Record<string, unknown>;
  try { entry = record(JSON.parse(line)); } catch { return undefined; }
  const message = record(entry.message);
  if (entry.type !== "message" || (message.role !== "user" && message.role !== "assistant")) return undefined;
  const text = messageText(message.content).trim();
  return text ? { role: message.role, text } : undefined;
}

export function sessionText(content: string): ThreadText[] {
  const window = new ThreadTextWindow();
  for (const [line] of content.matchAll(/[^\n]+/gu)) {
    const entry = sessionLineText(line);
    if (entry) window.add(entry);
  }
  return window.texts();
}

export function queryTokens(query: string): string[] {
  return foldSearchText(query).split(/\s+/u).filter(Boolean);
}

/** A line's worth of text around the first place the query was found, whitespace folded. */
export function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 30);
  const end = Math.min(text.length, Math.max(at + length, start + SNIPPET));
  const cut = text.slice(start, end).replace(/\s+/gu, " ").trim();
  return `${start > 0 ? "…" : ""}${cut}${end < text.length ? "…" : ""}`;
}

/**
 * The best message holding every word of the query. Whole words beat word
 * prefixes and substrings; an equally good earlier message keeps its snippet.
 */
export function findInThread(texts: readonly ThreadText[], tokens: readonly string[], phrase: string): Pick<ThreadMatch, "role" | "snippet" | "quality"> | undefined {
  if (tokens.length === 0) return undefined;
  let best: Pick<ThreadMatch, "role" | "snippet" | "quality"> | undefined;
  for (const entry of texts) {
    const match = textMatch(entry.text, tokens, phrase);
    if (!match || match.quality <= (best?.quality ?? 0)) continue;
    best = { role: entry.role, quality: match.quality, snippet: snippetAround(entry.text, match.at, match.length) };
    if (match.quality === 31) break;
  }
  return best;
}

/** What a message holds for the find: its words and its reasoning, as the transcript draws them. */
export interface FindableMessage {
  id: string;
  role: string;
  text?: string;
  thinking?: string;
}

/** The ids of the messages whose text or reasoning holds the query, in order; case does not matter. */
export function findMessages(messages: readonly FindableMessage[], query: string, mode?: ThreadFindInput["mode"]): ThreadFindResult {
  if (mode === "all-words") {
    const tokens = queryTokens(query);
    const phrase = tokens.join(" ");
    let best: { id: string; quality: number } | undefined;
    // Global search offers one snippet per thread. Resolve that same best message
    // under the runtime's current ids, with the same ranking and earliest tie.
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const match = textMatch(message.text ?? "", tokens, phrase);
      if (match && match.quality > (best?.quality ?? 0)) best = { id: message.id, quality: match.quality };
      if (best?.quality === 31) break;
    }
    return { messageIds: best ? [best.id] : [], truncated: false };
  }
  const needle = foldSearchText(query.trim());
  const messageIds: string[] = [];
  if (!needle) return { messageIds, truncated: false };
  // Walk backwards so retained ids never exceed the result limit plus one.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (!((message.text && foldSearchText(message.text).includes(needle)) || (message.thinking && foldSearchText(message.thinking).includes(needle)))) continue;
    messageIds.push(message.id);
    if (messageIds.length > THREAD_FIND_LIMIT) return { messageIds: messageIds.slice(0, THREAD_FIND_LIMIT).reverse(), truncated: true };
  }
  return { messageIds: messageIds.reverse(), truncated: false };
}
