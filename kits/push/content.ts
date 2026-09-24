import type { PushContent, PushKind } from "./protocol.js";

export const EXCERPT_LENGTH = 100;
/** A reason or a question is the point of the push; it may run a little longer than an excerpt. */
const ASK_LENGTH = 180;

const LABELS: Record<PushKind, string> = {
  completed: "Finished",
  failed: "Failed",
  turn: "Your turn",
  question: "Asks you something",
  approval: "Needs your permission",
};

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** Markdown's line marks and inline code ticks, which read as noise on a lock screen. */
function plain(line: string): string {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(/[*_`~]+/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The first line with words in it, plain and at most `max` characters; fences are skipped. */
export function excerpt(text: string, max = EXCERPT_LENGTH): string | undefined {
  let fenced = false;
  for (const raw of text.split(/\r?\n/u)) {
    if (/^\s*(?:```|~~~)/u.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const line = plain(raw);
    if (line) return clip(line, max);
  }
  return undefined;
}

export interface PushEvent {
  kind: PushKind;
  /** The thread's title; "A thread" without one. */
  title?: string;
  /** The agent's last message for a turn's end, its reason for "your turn", the question for a question. */
  text?: string;
}

/** Title and body of the notification (plan, decision 4). */
export function composePush(event: PushEvent, content: PushContent): { title: string; body: string } {
  const title = clip(event.title?.trim() || "A thread", 80);
  const label = LABELS[event.kind];
  if (content === "title" || !event.text) return { title, body: label };
  if (event.kind === "completed") return { title, body: excerpt(event.text) ?? label };
  if (event.kind === "failed") {
    const said = excerpt(event.text);
    return { title, body: said ? `${label}: ${said}` : label };
  }
  const asked = excerpt(event.text, ASK_LENGTH);
  return { title, body: event.kind === "turn" && asked ? `${label}: ${asked}` : asked ?? label };
}

/** The agent's words of the turn that just ended: its last message after the last user message. */
export function lastAgentText(messages: readonly { role: string; text: string }[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return undefined;
    if (message.role === "assistant" && message.text.trim()) return message.text;
  }
  return undefined;
}
