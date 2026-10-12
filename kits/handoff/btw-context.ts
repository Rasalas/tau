import type { UiMessage } from "tau/host-extension";

/** What the conversation may cost a side question, in characters (about 20k tokens). */
export const MAX_CONTEXT_CHARS = 80_000;
const TOOL_ARGS_CHARS = 240;
const TOOL_RESULT_CHARS = 600;

export const BTW_SYSTEM = [
  "You answer a quick side question about a conversation between a user and a coding agent. The conversation follows between <conversation> tags; the agent's tool calls and results are shortened.",
  "Answer directly and briefly in Markdown, from what the conversation shows and what you know. You cannot run tools or read files, and nothing you write changes the conversation.",
  "When the conversation does not tell, say so instead of guessing. Do not carry on the agent's task.",
].join("\n");

function short(text: string, limit: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)} …` : flat;
}

function parts(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content) ? content.filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object") : [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return parts(content).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("");
}

function argsOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  // The one argument that names what the call did, before the rest.
  const lead = ["command", "path", "file_path", "pattern", "query", "url"].find((key) => typeof record[key] === "string");
  return short(lead ? String(record[lead]) : JSON.stringify(value), TOOL_ARGS_CHARS);
}

/**
 * The lines of a Pi session's branch: what was said, the tools the agent called with a short form of their
 * arguments, and what they returned. Entries that are not part of the conversation are left out.
 */
export function linesFromEntries(entries: readonly unknown[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    const value = entry as { type?: unknown; summary?: unknown; message?: { role?: unknown; content?: unknown; toolName?: unknown; isError?: unknown } };
    if ((value?.type === "compaction" || value?.type === "branch_summary") && typeof value.summary === "string" && value.summary.trim()) {
      lines.push(`Summary of earlier turns: ${value.summary.trim()}`);
      continue;
    }
    const message = value?.type === "message" ? value.message : undefined;
    const role = message?.role;
    if (role === "user") {
      const text = textOf(message?.content).trim();
      if (text) lines.push(`User: ${text}`);
    } else if (role === "assistant") {
      const said = textOf(message?.content).trim();
      const calls = parts(message?.content).filter((part) => part.type === "toolCall").map((part) => `[called ${String(part.name ?? "a tool")}: ${argsOf(part.arguments)}]`);
      const body = [said, ...calls].filter(Boolean).join("\n");
      if (body) lines.push(`Assistant: ${body}`);
    } else if (role === "toolResult") {
      const text = short(textOf(message?.content), TOOL_RESULT_CHARS);
      lines.push(`[${String(message?.toolName ?? "tool")} ${message?.isError === true ? "failed" : "returned"}: ${text || "nothing"}]`);
    }
  }
  return lines;
}

/** The visible messages of a thread whose runtime keeps no journal; tool calls are not part of them. */
export function linesFromMessages(messages: readonly Pick<UiMessage, "role" | "text">[]): string[] {
  return messages.flatMap((message) => {
    const text = message.text.trim();
    return text && (message.role === "user" || message.role === "assistant") ? [`${message.role === "user" ? "User" : "Assistant"}: ${text}`] : [];
  });
}

/** The end of the conversation that fits, with the first request kept: the latest turns say where the work stands. */
export function fitLines(lines: readonly string[], maxChars = MAX_CONTEXT_CHARS): string {
  const first = lines.find((line) => line.startsWith("User: "));
  const head = first && first.length <= 2_000 ? first : first?.slice(0, 2_000);
  let budget = maxChars - (head?.length ?? 0);
  const tail: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (line.length + 2 > budget) break;
    tail.unshift(line);
    budget -= line.length + 2;
  }
  if (tail.length === lines.length) return tail.join("\n\n");
  if (tail.length === 0) return [head, `… ${lines.at(-1)!.slice(-Math.max(0, budget - 2))}`].filter(Boolean).join("\n\n");
  return [head && tail[0] !== head ? head : undefined, "[… earlier turns left out …]", ...tail].filter(Boolean).join("\n\n");
}

export interface BtwPromptInput {
  context: string;
  question: string;
  cwd: string;
  /** The agent is mid-turn: the conversation ends where it stands. */
  working: boolean;
}

export function btwPrompt({ context, question, cwd, working }: BtwPromptInput): string {
  return [
    `Project folder: ${cwd}`,
    working ? "The agent is still working on the latest request, so the conversation ends where it stands now." : undefined,
    `<conversation>\n${context.trim() || "(nothing has been said yet)"}\n</conversation>`,
    `Question: ${question.trim()}`,
  ].filter(Boolean).join("\n\n");
}
