import { parseSkillEnvelope } from "../shared/skill-envelope.js";

/**
 * Text projections core, Tau's Pi bridge and the title kit all read the same
 * way: content blocks to plain text, a model's answer to a thread title, and
 * the first exchanges of a thread as the prompt a title model reads. A leaf
 * module on purpose — `tau/host-extension` re-exports it, so a kit that imports
 * one of these bundles nothing else.
 *
 * The title shapes live here rather than in `kits/thread-titles` because the
 * bridge (`.pi/extensions/tau-session-bridge.ts`) runs inside Pi, where jiti
 * resolves no `tau/` specifier. Ticket 09 splits that bridge; this is the
 * moment to move them.
 */

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as { type?: string; text?: string; thinking?: string };
      if (item.type === "text") return item.text ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function firstSentence(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return "Untitled thread";
  const sentenceEnd = normalized.search(/[.!?](?:\s|$)/u);
  const sentence = sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd + 1) : normalized;
  return sentence.length > 96 ? `${sentence.slice(0, 93).trimEnd()}…` : sentence;
}

export function visibleTitleText(value: string): string {
  // A raw skill wrapper has no trustworthy title text. Keep runtime internals
  // out of sidebar/title fallback rather than echoing its tag or local path.
  return /<skill\b/iu.test(value)
    ? "Skill invocation"
    : value;
}

export function safeSessionTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return cleanThreadTitle(visibleTitleText(value)); }
  catch { return undefined; }
}

export function cleanThreadTitle(value: string): string {
  const firstLine = value.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  const title = firstLine
    .replace(/^\s*(?:#{1,6}|>|[-+*])\s+/u, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/(?:\*\*|__|~~|`)+/gu, "")
    .replace(/^(?:(?:the\s+)?(?:thread\s+)?title|titel)\s*(?:is|lautet)?\s*[:-]\s*/iu, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "")
    .replace(/[.!?:;]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!title) throw new Error("The title model returned an empty title.");
  return title.length > 80 ? `${title.slice(0, 77).trimEnd()}…` : title;
}

export interface TitleMessage {
  role?: string;
  content?: unknown;
  skill?: { name?: unknown; command?: unknown };
}

function titleVisibleUserText(text: string, metadata: TitleMessage["skill"]): string {
  const envelope = parseSkillEnvelope(text);
  if (envelope && metadata
    && metadata.name === envelope.name
    && typeof metadata.command === "string"
    && metadata.command.replace(/^\/skill:/u, "").replace(/^\//u, "") === envelope.name) {
    return envelope.userMessage;
  }
  return visibleTitleText(text);
}

/** The first exchanges, rendered as the prompt a title model reads. */
export function buildTitleConversation(
  runtimeMessages: readonly TitleMessage[],
  persistedMessages: readonly TitleMessage[] = [],
): string {
  function render(messages: readonly TitleMessage[]): string {
    return messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => {
        const text = textFromContent(message.content);
        return `${message.role}: ${message.role === "user" ? titleVisibleUserText(text, message.skill) : text}`;
      })
      .filter((line) => line.trim().length > line.indexOf(":") + 1)
      .slice(0, 4)
      .join("\n\n")
      .slice(0, 6000);
  }
  return render(runtimeMessages) || render(persistedMessages);
}
